///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Parser } from "htmlparser2";
import { createCssContext, CssContext, prefixId, sanitizeInlineStyle, sanitizeMediaCondition, sanitizeStyleSheet } from "./CssSanitizer.js";
import { CID_TOKEN_PATTERN, sanitizeImageUrl, sanitizeLinkUrl, stripControls, stripTextControls } from "./MailUrlRules.js";

/**
 * The sanitizer for the HTML of a stored message: faithful to the sender's design, safe to show.
 *
 * **What it produces.** A complete, re-serialized document - `<!DOCTYPE html><html><head>[<meta color-scheme>][<style>...]</head>
 * <body ...>...</body></html>` - holding the message's own structure, text, tables, colours (`bgcolor`, `color`, inline styles and
 * `<style>` blocks), fonts, backgrounds and images, and nothing that can run, navigate, submit, overlay or load anything the reader did
 * not ask for. What is kept and what is not is documented in the README's "HTML mail" section and `.claude/NOTES.md` (2026-09-21).
 *
 * **How.** The input is tokenized by `htmlparser2` and never trusted to be well-formed: what comes out is written by this module alone,
 * from an allow-list of elements and of attributes, each attribute value checked and rewritten to a canonical form (`MailUrlRules` for
 * URLs, `CssSanitizer` for styles), text and attribute values escaped, every tag closed. The browser that finally parses the output
 * therefore sees only what was checked - the classic bypasses (a tag the sanitizer's parser and the browser's read differently) have
 * nothing to work with, because the only elements written are ones with no special parsing rules, and svg/math are never written at all.
 * Elements outside the allow-list lose their tags and keep their text; elements that are dangerous or that carry no text worth
 * keeping (`script`, `iframe`, `object`, `svg`, `form` controls, `noscript` ...) are dropped whole. Output is idempotent: sanitizing
 * sanitized output changes nothing.
 *
 * **Layers.** This is the first of four (see the reading pane's `bodyHtml.ts`): the client still strips scripts with DOMPurify, applies a
 * strict CSP and a sandbox without `allow-scripts`. None of them is relied on here.
 *
 * @author Jean-Philippe Steinmetz
 */

/** Bumped whenever the sanitizer's output changes in a way an already-stored message should be re-sanitized for. */
export const SANITIZER_VERSION = 2;

/** What starts a stored sanitized blob: the version of the sanitizer that wrote it. A blob without it is version 0 (the old one). */
const STAMP_PATTERN: RegExp = /^<!--rapidmx-sanitized:(\d{1,6})-->/;

/** The elements kept (attributes are filtered separately). Configurable downward via `mail:scan:sanitize:allowed_tags`. */
export const DEFAULT_ALLOWED_TAGS: string[] = [
    "div",
    "span",
    "p",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "pre",
    "code",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "colgroup",
    "col",
    "a",
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "strike",
    "del",
    "ins",
    "sub",
    "sup",
    "small",
    "big",
    "font",
    "center",
    "abbr",
    "cite",
    "q",
    "mark",
    "tt",
    "kbd",
    "samp",
    "var",
    "dfn",
    "time",
    "bdi",
    "bdo",
    "nobr",
    "wbr",
    "address",
    "figure",
    "figcaption",
    "section",
    "article",
    "header",
    "footer",
    "nav",
    "main",
    "aside",
    "menu",
    "img",
    "style",
];

/** Elements removed together with everything inside them: they run code, embed or navigate, or their content is not text to show. */
const DROPPED_TAGS: Set<string> = new Set([
    "script",
    "noscript",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "param",
    "input",
    "select",
    "option",
    "optgroup",
    "datalist",
    "textarea",
    "link",
    "meta",
    "base",
    "title",
    "svg",
    "math",
    "video",
    "audio",
    "source",
    "track",
    "canvas",
    "template",
    "slot",
    "dialog",
    "xml",
    "xmp",
    "plaintext",
    "listing",
    "noembed",
    "noframes",
    "portal",
    "area",
]);

/** Elements written without a closing tag. */
const VOID_TAGS: Set<string> = new Set(["br", "hr", "img", "col", "wbr"]);

/** The limits of one sanitizing run; every one has a default (`SANITIZE_DEFAULTS`) and a `mail:scan:sanitize:*` setting. */
export interface HtmlSanitizeOptions {
    /** Restricts the elements kept to these (those of `DEFAULT_ALLOWED_TAGS` among them); empty or absent keeps them all. */
    allowedTags?: string[];
    /** HTML longer than this many characters is cut off (a mail body has no use for more, and the client shows none). */
    maxInputLength?: number;
    /** The largest decoded `data:` image kept, in bytes. */
    maxDataImageBytes?: number;
    /** The most sanitized CSS, in bytes, all `<style>` blocks together may add up to. */
    maxCssBytes?: number;
    /** The most CSS rules kept in all. */
    maxCssRules?: number;
    /** Elements nested deeper than this lose their tags (their text stays). */
    maxDepth?: number;
    /** Elements beyond this many lose their tags. */
    maxElements?: number;
}

export const SANITIZE_DEFAULTS: Required<Omit<HtmlSanitizeOptions, "allowedTags">> = {
    maxInputLength: 2 * 1024 * 1024,
    maxDataImageBytes: 256 * 1024,
    maxCssBytes: 512 * 1024,
    maxCssRules: 10_000,
    maxDepth: 128,
    maxElements: 50_000,
};

/** How one element of the input is treated. */
type Kind = "emit" | "unwrap" | "drop" | "style" | "root";

interface Frame {
    kind: Kind;
    name: string;
    /** A `<style>`'s `media` attribute, canonical, if it had a usable one. */
    media?: string;
    /** Whether a `<style>` should be kept at all. */
    keep?: boolean;
}

const MAX_ATTRIBUTE_LENGTH = 10_000;
const MAX_TEXT_ATTRIBUTE_LENGTH = 1000;
const MAX_PASSES = 3;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeText = (content: string): string => stripTextControls(content).replace(/[&<>"']/g, (c: string) => ESCAPES[c]);
const escapeAttribute = (text: string): string => text.replace(/[&<>"]/g, (c: string) => ESCAPES[c]);

type Validator = (value: string, run: MailHtmlSanitizer) => string | undefined;

const DIMENSION: RegExp = /^\d{1,5}(?:\.\d{1,3})?(?:%|px)?$/;
const COLOUR: RegExp = /^(?:#?[0-9a-f]{3,8}|[a-z]{3,32}|(?:rgb|hsl)a?\([\d\s.,%/+-]{1,64}\))$/i;
const WORD: RegExp = /^[a-z]{1,16}$/i;

const dimension: Validator = (value) => (DIMENSION.test(value.trim()) ? value.trim() : undefined);
const count: Validator = (value) => (/^\d{1,4}$/.test(value.trim()) ? value.trim() : undefined);
const colour: Validator = (value) => (COLOUR.test(value.trim()) ? value.trim() : undefined);
const word: Validator = (value) => (WORD.test(value.trim()) ? value.trim().toLowerCase() : undefined);
const flag: Validator = () => "";
const text = (value: string): string => stripControls(value).trim().slice(0, MAX_TEXT_ATTRIBUTE_LENGTH);
const oneOf =
    (...allowed: string[]): Validator =>
    (value) =>
        allowed.includes(value.trim().toLowerCase()) ? value.trim().toLowerCase() : undefined;

/** The attributes that may be kept, and the one rule each value must satisfy. Every other attribute is dropped. */
interface AttributeRule {
    /** The elements it may be on; absent for any. */
    tags?: Set<string>;
    validate: Validator;
}

const ATTRIBUTES: Map<string, AttributeRule> = new Map<string, AttributeRule>([
    ["style", { validate: (value: string, run: MailHtmlSanitizer) => run.inlineStyle(value) }],
    ["class", { validate: (value: string) => stripControls(value.replace(/\s+/g, " ")).trim().slice(0, MAX_TEXT_ATTRIBUTE_LENGTH) || undefined }],
    ["id", { validate: (value: string) => (/^[A-Za-z0-9_-]{1,128}$/.test(value) ? prefixId(value) : undefined) }],
    ["dir", { validate: oneOf("ltr", "rtl", "auto") }],
    ["lang", { validate: (value: string) => (/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/.test(value.trim()) ? value.trim() : undefined) }],
    ["title", { validate: (value: string) => text(value) || undefined }],
    ["alt", { validate: text }],
    ["abbr", { tags: new Set(["th", "td"]), validate: (value: string) => text(value) || undefined }],
    ["role", { validate: word }],
    ["aria-hidden", { validate: oneOf("true", "false") }],
    ["aria-label", { validate: (value: string) => text(value) || undefined }],
    ["hidden", { validate: flag }],
    ["nowrap", { validate: flag }],
    ["align", { validate: word }],
    ["valign", { validate: word }],
    ["bgcolor", { validate: colour }],
    ["color", { validate: colour }],
    ["bordercolor", { validate: colour }],
    ["text", { tags: new Set(["body"]), validate: colour }],
    ["link", { tags: new Set(["body"]), validate: colour }],
    ["alink", { tags: new Set(["body"]), validate: colour }],
    ["vlink", { tags: new Set(["body"]), validate: colour }],
    ["face", { validate: (value: string) => (/^[\w\s,.'"-]{1,200}$/.test(value) ? value.trim() : undefined) }],
    ["size", { validate: (value: string) => (/^[+-]?\d{1,2}$/.test(value.trim()) ? value.trim() : undefined) }],
    ["width", { validate: dimension }],
    ["height", { validate: dimension }],
    ["border", { validate: dimension }],
    ["cellpadding", { tags: new Set(["table"]), validate: dimension }],
    ["cellspacing", { tags: new Set(["table"]), validate: dimension }],
    ["hspace", { validate: dimension }],
    ["vspace", { validate: dimension }],
    ["leftmargin", { tags: new Set(["body"]), validate: dimension }],
    ["topmargin", { tags: new Set(["body"]), validate: dimension }],
    ["marginwidth", { tags: new Set(["body"]), validate: dimension }],
    ["marginheight", { tags: new Set(["body"]), validate: dimension }],
    ["colspan", { tags: new Set(["td", "th"]), validate: count }],
    ["rowspan", { tags: new Set(["td", "th"]), validate: count }],
    ["span", { tags: new Set(["col", "colgroup"]), validate: count }],
    ["start", { tags: new Set(["ol"]), validate: count }],
    ["scope", { tags: new Set(["th", "td"]), validate: oneOf("row", "col", "rowgroup", "colgroup") }],
    ["type", { tags: new Set(["ol", "ul", "li"]), validate: (value: string) => (/^(?:[1aAiI]|disc|circle|square)$/.test(value.trim()) ? value.trim() : undefined) }],
    ["background", { validate: (value: string, run: MailHtmlSanitizer) => sanitizeImageUrl(value, run.options.maxDataImageBytes) }],
    ["href", { tags: new Set(["a"]), validate: (value: string) => sanitizeLinkUrl(value) }],
    ["src", { tags: new Set(["img"]), validate: (value: string, run: MailHtmlSanitizer) => sanitizeImageUrl(value, run.options.maxDataImageBytes) }],
]);

/** One sanitizing run over one document (see `sanitizeMailHtml()`, which is how it is used). */
class MailHtmlSanitizer {
    public readonly css: CssContext;
    public readonly options: Required<Omit<HtmlSanitizeOptions, "allowedTags">>;
    /** Whether an element was unwrapped, which can change how the browser (and this parser) nest what is left. */
    public restructured: boolean = false;

    private readonly allowed: Set<string>;
    /** Mail repeats the same `style` value on hundreds of cells; each distinct one is sanitized once. */
    private readonly inlineStyles: Map<string, string | undefined> = new Map();
    private readonly body: string[] = [];
    private readonly styles: string[] = [];
    private readonly stack: Frame[] = [];
    private htmlAttributes: string = "";
    private bodyAttributes: string = "";
    private colourScheme: string | undefined;
    private seenHtml: boolean = false;
    private seenBody: boolean = false;
    private dropped: number = 0;
    private elements: number = 0;
    /** How many emitted elements are open: what `maxDepth` limits (the page's own `html`/`body` and unwrapped elements are not counted). */
    private depth: number = 0;
    private styleText: string = "";

    public constructor(options: HtmlSanitizeOptions) {
        this.options = { ...SANITIZE_DEFAULTS, ...options };
        this.css = createCssContext(this.options.maxCssBytes, this.options.maxCssRules, this.options.maxDataImageBytes);
        const configured: Set<string> | undefined = options.allowedTags?.length ? new Set(options.allowedTags.map((tag) => tag.toLowerCase())) : undefined;
        this.allowed = new Set(DEFAULT_ALLOWED_TAGS.filter((tag) => configured === undefined || configured.has(tag)));
    }

    /** The sanitized form of a `style` attribute value, or `undefined` when nothing of it is kept. */
    public inlineStyle(value: string): string | undefined {
        if (!this.inlineStyles.has(value)) {
            this.inlineStyles.set(value, sanitizeInlineStyle(value, this.css) || undefined);
        }
        return this.inlineStyles.get(value);
    }

    /** The sanitized document for `html`. */
    public run(html: string): string {
        const parser: Parser = new Parser(
            {
                onopentag: (name: string, attribs: Record<string, string>) => this.onOpen(name, attribs),
                onclosetag: () => this.onClose(),
                ontext: (data: string) => this.onText(data),
            },
            { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeCDATA: false, recognizeSelfClosing: false },
        );
        parser.write(html);
        parser.end();
        const head: string = (this.colourScheme ? `<meta name="color-scheme" content="${this.colourScheme}">` : "") + this.styles.join("");
        return `<!DOCTYPE html><html${this.htmlAttributes}><head>${head}</head><body${this.bodyAttributes}>${this.body.join("")}</body></html>`;
    }

    private classify(name: string): Kind {
        if (name === "style") {
            return this.allowed.has("style") ? "style" : "drop";
        }
        if (name === "html" || name === "head") {
            return "root";
        }
        if (name === "body") {
            return "unwrap";
        }
        if (DROPPED_TAGS.has(name) || name.startsWith("svg:") || name.startsWith("math:")) {
            return "drop";
        }
        return this.allowed.has(name) ? "emit" : "unwrap";
    }

    private onOpen(name: string, attribs: Record<string, string>): void {
        const frame: Frame = { kind: this.dropped > 0 ? "drop" : this.classify(name), name };
        if (frame.kind === "drop") {
            if (name === "meta" && this.dropped === 0) {
                this.captureMeta(attribs);
            }
            this.dropped++;
        } else if (frame.kind === "style") {
            const type: string = (attribs.type ?? "").trim().toLowerCase();
            const media: string | undefined = attribs.media?.trim() ? sanitizeMediaCondition(attribs.media) : undefined;
            frame.keep = (type === "" || type === "text/css") && (!attribs.media?.trim() || media !== undefined);
            frame.media = media === "all" ? undefined : media;
            this.styleText = "";
        } else if (frame.kind === "root" || name === "body") {
            // Their attributes describe the page, and the first of each says it; neither is written as an element of the body.
            if (name === "html" && !this.seenHtml) {
                this.seenHtml = true;
                this.htmlAttributes = this.attributes("html", attribs).text;
            } else if (name === "body" && !this.seenBody) {
                this.seenBody = true;
                this.bodyAttributes = this.attributes("body", attribs).text;
            }
        } else {
            this.elements++;
            if (frame.kind === "emit" && (this.depth >= this.options.maxDepth || this.elements > this.options.maxElements)) {
                frame.kind = "unwrap";
            }
            const rendered: string | undefined = frame.kind === "emit" ? this.render(name, attribs) : undefined;
            if (rendered === undefined) {
                frame.kind = "unwrap";
                // A void element has nothing inside it to change how anything else nests.
                this.restructured = this.restructured || !VOID_TAGS.has(name);
            } else {
                this.depth++;
                this.body.push(rendered);
            }
        }
        this.stack.push(frame);
    }

    private onClose(): void {
        const frame: Frame | undefined = this.stack.pop();
        if (frame === undefined) {
            // At the end of the input the parser closes a tag it never finished opening (`<a href="x`): nothing of ours to close.
            return;
        }
        if (frame.kind === "drop") {
            this.dropped--;
        } else if (frame.kind === "emit") {
            this.depth--;
            if (!VOID_TAGS.has(frame.name)) {
                this.body.push(`</${frame.name}>`);
            }
        } else if (frame.kind === "style" && frame.keep) {
            const sheet: string = sanitizeStyleSheet(frame.media ? `@media ${frame.media}{${this.styleText}}` : this.styleText, this.css);
            if (sheet) {
                this.styles.push(`<style>${sheet}</style>`);
            }
            this.styleText = "";
        }
    }

    private onText(data: string): void {
        if (this.dropped > 0) {
            return;
        }
        const top: Frame | undefined = this.stack[this.stack.length - 1];
        if (top?.kind === "style") {
            if (this.styleText.length < this.options.maxCssBytes * 4) {
                this.styleText += data;
            }
        } else if (data.trim() !== "" || !(top?.kind === "root" || (top === undefined && this.body.length === 0))) {
            // Whitespace between the tags of the page itself (around <html> and <head>) is not content.
            this.body.push(escapeText(data));
        }
    }

    /** Records a `<meta name="color-scheme">`: the one `meta` a message's design can depend on (it makes a mail with dark styles dark). */
    private captureMeta(attribs: Record<string, string>): void {
        const content: string = (attribs.content ?? "").trim().toLowerCase();
        if ((attribs.name ?? "").trim().toLowerCase() === "color-scheme" && /^(?:(?:normal|light|dark|only)\s*){1,4}$/.test(content)) {
            this.colourScheme = content.replace(/\s+/g, " ");
        }
    }

    /** The kept attributes of an element as ` name="value"...`, and whether it is a link/image with what it needs. */
    private attributes(tag: string, attribs: Record<string, string>): { text: string; src: boolean; href: boolean; alt: boolean } {
        const out = { text: "", src: false, href: false, alt: false };
        for (const [name, raw] of Object.entries(attribs)) {
            const rule = ATTRIBUTES.get(name);
            const limit: number = name === "src" || name === "background" || name === "style" ? MAX_ATTRIBUTE_LENGTH * 4 + this.options.maxDataImageBytes * 2 : MAX_ATTRIBUTE_LENGTH;
            if (!rule || (rule.tags && !rule.tags.has(tag)) || raw.length > limit) {
                continue;
            }
            const value: string | undefined = rule.validate(raw, this);
            if (value !== undefined) {
                out.text += ` ${name}="${escapeAttribute(value)}"`;
                out.src = out.src || name === "src";
                out.href = out.href || name === "href";
                out.alt = out.alt || (name === "alt" && value !== "");
            }
        }
        return out;
    }

    /** The opening tag of an emitted element, or `undefined` when it has nothing left to show (an image with no source and no text). */
    private render(name: string, attribs: Record<string, string>): string | undefined {
        const kept = this.attributes(name, attribs);
        if (name === "img" && !kept.src && !kept.alt) {
            return undefined;
        }
        const link: string = kept.href ? ' target="_blank" rel="noopener noreferrer nofollow"' : "";
        return `<${name}${kept.text}${link}>`;
    }
}

/**
 * The sanitized document for a message's `html` (see the file's header). Never throws for any input; what it cannot keep it drops.
 */
export function sanitizeMailHtml(html: string, options: HtmlSanitizeOptions = {}): string {
    const maxInput: number = options.maxInputLength ?? SANITIZE_DEFAULTS.maxInputLength;
    let current: string = html.length > maxInput ? html.slice(0, maxInput) : html;
    current = current.replace(/\0/g, "");
    // Removing an element can change how what is left nests (a `<p>` inside a `<p>` that a `<form>` used to separate): sanitize again,
    // on what came out, until a run removes nothing, so that sanitizing the result is always a no-op.
    for (let pass = 1; ; pass++) {
        const run: MailHtmlSanitizer = new MailHtmlSanitizer(options);
        const output: string = run.run(current);
        if (!run.restructured || pass >= MAX_PASSES) {
            return output;
        }
        current = output;
    }
}

/** `html` with the sanitizer's version in front, which is how a stored blob says what wrote it (see `readSanitizerVersion()`). */
export function stampSanitizedHtml(html: string): string {
    return `<!--rapidmx-sanitized:${SANITIZER_VERSION}-->${html}`;
}

/** The version of the sanitizer that wrote a stored blob - 0 for one that carries no stamp (written before there was one). */
export function readSanitizerVersion(stored: Buffer | string): number {
    const head: string = typeof stored === "string" ? stored.slice(0, 40) : stored.subarray(0, 40).toString("latin1");
    const match: RegExpExecArray | null = STAMP_PATTERN.exec(head);
    return match ? Number(match[1]) : 0;
}

/** `html` without the version stamp `stampSanitizedHtml()` put in front of it. */
export function stripSanitizerStamp(html: string): string {
    return html.replace(STAMP_PATTERN, "");
}

const CID_REFERENCE: RegExp = new RegExp(` (src|background)="cid:(${CID_TOKEN_PATTERN})"|url\\('cid:(${CID_TOKEN_PATTERN})'\\)`, "g");

/**
 * Points the sanitized `html`'s inline (`cid:`) images at wherever `resolve` says they are - or drops them. `resolve` gets the token of
 * each reference (`image001@x` for `cid:image001@x`) and returns the URL to use, or `undefined` when there is no such part: the `src`
 * or `background` attribute is then removed (leaving an `<img>`'s `alt`), and a CSS `url()` becomes `none`.
 *
 * Works on what `sanitizeMailHtml()` writes, which always spells these references the same way, and only there.
 */
export function resolveInlineImages(html: string, resolve: (token: string) => string | undefined): string {
    if (!html.includes("cid:")) {
        return html;
    }
    return html.replace(CID_REFERENCE, (_match: string, attribute: string | undefined, attributeToken: string | undefined, styleToken: string | undefined) => {
        const url: string | undefined = resolve((attributeToken ?? styleToken) as string);
        if (attribute) {
            return url === undefined ? "" : ` ${attribute}="${escapeAttribute(url)}"`;
        }
        return url === undefined ? "none" : `url('${url.replace(/['\\<]/g, (c: string) => `%${c.charCodeAt(0).toString(16)}`)}')`;
    });
}
