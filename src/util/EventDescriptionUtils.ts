///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { Parser } from "htmlparser2";
import { sanitizeLinkUrl, stripTextControls } from "../scan/MailUrlRules.js";

/**
 * The description of a calendar event: the rich text a person writes in an event dialog, and what is done to it before it is stored,
 * mailed in an invitation or shown to anyone else.
 *
 * `CalendarEvent.descriptionHtml` holds **sanitized HTML** and `CalendarEvent.description` its **plain-text** form. The sanitizer here
 * is deliberately far stricter than `scan/HtmlSanitizer` (which keeps a mail's whole design): an event description is a few lines of
 * formatted text, so the only elements kept are `b`/`strong`, `i`/`em`, `u`, `br`, `p`, `ul`/`ol`/`li` and `a`; the only attribute
 * kept anywhere is an `a`'s `href`, and only when it is an `http`, `https` or `mailto` URL (`scan/MailUrlRules.sanitizeLinkUrl()`,
 * minus its `tel:`), written back as the canonical form of the URL with `rel="noopener noreferrer"`. Everything else - every
 * attribute, `style`, `class`, `id`, images, tables, forms, `data:`/`javascript:` links - is gone. Elements that run or embed something
 * (`script`, `style`, `iframe`, `svg`, `object`, `textarea` ...) are removed with their content; any other element outside the
 * allow-list loses its tags and keeps its text. Like `HtmlSanitizer`, it tokenizes with `htmlparser2` and *writes* the output itself
 * (every text and attribute value escaped, every tag closed), so what a browser finally parses is only what was checked.
 *
 * The sanitizer runs on **every** write: a create/update body (`normalizeEventDescription()`, 400 for nonsense), and an inbound
 * iCalendar `X-ALT-DESC` (`IcsUtils.parseIcsEvent()`, lenient - see `sanitizeInboundDescription()`), which is never trusted either.
 *
 * @author Jean-Philippe Steinmetz
 */

/** The longest `CalendarEvent.description` (plain text), in characters. */
export const MAX_EVENT_DESCRIPTION_LENGTH = 32 * 1024;

/** The longest `CalendarEvent.descriptionHtml`, in characters - both what a client may send and what the sanitizer writes. */
export const MAX_EVENT_DESCRIPTION_HTML_LENGTH = 64 * 1024;

/** The elements kept. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set(["b", "strong", "i", "em", "u", "br", "p", "ul", "ol", "li", "a"]);

/** Elements removed together with everything in them. */
const DROPPED_TAGS: ReadonlySet<string> = new Set([
    "script",
    "style",
    "iframe",
    "frame",
    "frameset",
    "object",
    "embed",
    "applet",
    "svg",
    "math",
    "template",
    "noscript",
    "noembed",
    "noframes",
    "textarea",
    "select",
    "option",
    "title",
    "head",
    "xmp",
    "plaintext",
    "canvas",
    "audio",
    "video",
    "source",
    "track",
    "link",
    "meta",
    "base",
]);

/** How deep elements may nest before the deeper ones lose their tags. */
const MAX_DEPTH = 32;

/** How many elements are kept in all; the rest lose their tags. */
const MAX_ELEMENTS = 2000;

/** The most sanitizing passes: removing an element can change how what is left nests, and the output is sanitized again until it stops changing. */
const MAX_PASSES = 4;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c: string) => ESCAPES[c]);

interface Frame {
    kind: "emit" | "unwrap" | "drop";
    name: string;
}

/** One sanitizing pass. */
function sanitizeOnce(html: string): string {
    const out: string[] = [];
    const stack: Frame[] = [];
    let dropped = 0;
    let depth = 0;
    let elements = 0;
    const parser: Parser = new Parser(
        {
            onopentag: (name: string, attribs: Record<string, string>) => {
                const frame: Frame = { kind: dropped > 0 || DROPPED_TAGS.has(name) ? "drop" : ALLOWED_TAGS.has(name) ? "emit" : "unwrap", name };
                if (frame.kind === "drop") {
                    dropped++;
                } else if (frame.kind === "emit") {
                    elements++;
                    let tag: string | undefined = name;
                    if (depth >= MAX_DEPTH || elements > MAX_ELEMENTS) {
                        tag = undefined;
                    } else if (name === "a") {
                        const href: string | undefined = sanitizeLinkUrl(attribs.href ?? "");
                        tag = href !== undefined && /^(?:https?:\/\/|mailto:)/i.test(href) ? `a href="${escapeHtml(href)}" rel="noopener noreferrer"` : undefined;
                    }
                    if (tag === undefined) {
                        frame.kind = "unwrap";
                    } else {
                        depth++;
                        out.push(`<${tag}>`);
                    }
                }
                stack.push(frame);
            },
            onclosetag: () => {
                const frame: Frame | undefined = stack.pop();
                if (frame === undefined) {
                    // The parser closes a tag it never finished opening at the end of the input (`<a href="x`): nothing of ours to close.
                    return;
                }
                if (frame.kind === "drop") {
                    dropped--;
                } else if (frame.kind === "emit") {
                    depth--;
                    if (frame.name !== "br") {
                        out.push(`</${frame.name}>`);
                    }
                }
            },
            ontext: (data: string) => {
                if (dropped === 0) {
                    out.push(escapeHtml(stripTextControls(data)));
                }
            },
        },
        { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeCDATA: false, recognizeSelfClosing: false },
    );
    parser.write(html);
    parser.end();
    return out.join("");
}

/**
 * The sanitized form of `html` (see this file's header): only the allow-listed elements, no attributes but a safe `href`, everything
 * escaped and balanced. Never throws; what it cannot keep it drops. Sanitizing the result again changes nothing. Not length-checked
 * (`normalizeEventDescription()` does that); the input is cut at four times `MAX_EVENT_DESCRIPTION_HTML_LENGTH` to bound the work.
 */
export function sanitizeEventDescriptionHtml(html: string): string {
    let current: string = String(html).slice(0, MAX_EVENT_DESCRIPTION_HTML_LENGTH * 4).replace(/\0/g, "");
    for (let pass = 1; ; pass++) {
        const output: string = sanitizeOnce(current);
        if (output === current || pass >= MAX_PASSES) {
            return output;
        }
        current = output;
    }
}

/**
 * The plain-text form of `html`: text with a line break for each `<br>`, paragraph and list item (`- ` before a bulleted item, `1. ` before
 * a numbered one), and a link's URL in parentheses after its text when the text isn't the URL already. Every other tag is dropped,
 * entities are decoded, whitespace is collapsed and runs of blank lines shortened. Safe for any input (it produces text, not markup), but
 * meant for what `sanitizeEventDescriptionHtml()` wrote. Cut at `MAX_EVENT_DESCRIPTION_LENGTH` characters.
 */
export function htmlToPlainText(html: string): string {
    let text = "";
    const lists: { ordered: boolean; count: number }[] = [];
    const anchors: { href: string; start: number }[] = [];
    let dropped = 0;
    const startLine = (): void => {
        if (text !== "" && !text.endsWith("\n")) {
            text += "\n";
        }
    };
    const parser: Parser = new Parser(
        {
            onopentag: (name: string, attribs: Record<string, string>) => {
                if (dropped > 0 || DROPPED_TAGS.has(name)) {
                    dropped++;
                    return;
                }
                if (name === "br") {
                    text += "\n";
                } else if (name === "p") {
                    startLine();
                } else if (name === "ul" || name === "ol") {
                    startLine();
                    lists.push({ ordered: name === "ol", count: 0 });
                } else if (name === "li") {
                    startLine();
                    const list: { ordered: boolean; count: number } | undefined = lists[lists.length - 1];
                    if (list?.ordered) {
                        list.count++;
                        text += `${list.count}. `;
                    } else {
                        text += "- ";
                    }
                } else if (name === "a") {
                    anchors.push({ href: attribs.href ?? "", start: text.length });
                }
            },
            onclosetag: (name: string) => {
                if (dropped > 0) {
                    dropped--;
                    return;
                }
                if (name === "p" || name === "li") {
                    startLine();
                } else if (name === "ul" || name === "ol") {
                    lists.pop();
                    startLine();
                } else if (name === "a") {
                    const anchor: { href: string; start: number } | undefined = anchors.pop();
                    if (anchor?.href) {
                        const shown: string = text.slice(anchor.start).trim();
                        if (shown !== anchor.href && shown !== anchor.href.replace(/^mailto:/i, "")) {
                            text += ` (${anchor.href})`;
                        }
                    }
                }
            },
            ontext: (data: string) => {
                if (dropped === 0) {
                    const collapsed: string = stripTextControls(data).replace(/[ \t\r\n]+/g, " ");
                    text += text === "" || text.endsWith("\n") ? collapsed.replace(/^ /, "") : collapsed;
                }
            },
        },
        { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeCDATA: false, recognizeSelfClosing: false },
    );
    parser.write(String(html).slice(0, MAX_EVENT_DESCRIPTION_HTML_LENGTH * 4));
    parser.end();
    return text
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, MAX_EVENT_DESCRIPTION_LENGTH);
}

/** A plain-text description as stored: line breaks as `\n`, control characters (bar tab and newline) removed. */
export function cleanPlainDescription(text: string): string {
    return stripTextControls(String(text).replace(/\r\n|\r/g, "\n"));
}

/** What `normalizeEventDescription()` decided: a field is `undefined` when the request leaves it as it is, `null` when it is cleared. */
export interface EventDescriptionUpdate {
    description?: string | null;
    descriptionHtml?: string | null;
}

const invalid = (message: string): ApiError => new ApiError(ApiErrors.INVALID_REQUEST, 400, message);

/**
 * Decides what a create/update body's `description`/`descriptionHtml` (whichever it carries - a key absent from the body is
 * `undefined` in `input`) mean for the stored pair, and sanitizes the HTML. `400` for a value that is neither a string nor `null`, a
 * plain text over `MAX_EVENT_DESCRIPTION_LENGTH`, or HTML over `MAX_EVENT_DESCRIPTION_HTML_LENGTH` (as sent, and again as sanitized).
 *
 * - Neither given: nothing changes (`{}`).
 * - HTML given (non-empty after sanitizing): it is stored sanitized, and the plain text is the one given with it or - when none was -
 * derived from it (`htmlToPlainText()`).
 * - Only plain text given: it is kept as it is and the HTML is cleared, since the plain text is now the description.
 * - HTML given but empty or sanitized to nothing, and no plain text: the HTML is cleared and the plain text left alone.
 * - An empty or `null` value clears its field.
 */
export function normalizeEventDescription(input: { description?: unknown; descriptionHtml?: unknown }): EventDescriptionUpdate {
    const { description, descriptionHtml } = input;
    for (const [name, value] of [["description", description], ["descriptionHtml", descriptionHtml]] as const) {
        if (value !== undefined && value !== null && typeof value !== "string") {
            throw invalid(`'${name}' must be a string.`);
        }
    }
    if (typeof description === "string" && description.length > MAX_EVENT_DESCRIPTION_LENGTH) {
        throw invalid(`'description' must be at most ${MAX_EVENT_DESCRIPTION_LENGTH} characters.`);
    }
    if (typeof descriptionHtml === "string" && descriptionHtml.length > MAX_EVENT_DESCRIPTION_HTML_LENGTH) {
        throw invalid(`'descriptionHtml' must be at most ${MAX_EVENT_DESCRIPTION_HTML_LENGTH} characters.`);
    }
    const plain: string = typeof description === "string" ? cleanPlainDescription(description) : "";
    const clean: string = typeof descriptionHtml === "string" ? sanitizeEventDescriptionHtml(descriptionHtml) : "";
    if (clean.length > MAX_EVENT_DESCRIPTION_HTML_LENGTH) {
        throw invalid(`'descriptionHtml' must be at most ${MAX_EVENT_DESCRIPTION_HTML_LENGTH} characters once sanitized.`);
    }
    if (clean !== "") {
        return { description: plain !== "" ? plain : htmlToPlainText(clean) || null, descriptionHtml: clean };
    }
    if (description !== undefined) {
        return { description: plain !== "" ? plain : null, descriptionHtml: null };
    }
    return descriptionHtml !== undefined ? { descriptionHtml: null } : {};
}

/**
 * The description of an inbound iCalendar event (`DESCRIPTION` and `X-ALT-DESC;FMTTYPE=text/html`) as it may be stored: the HTML is
 * sanitized, both are bounded (a value over the bound is cut - plain text - or dropped - HTML, which can't be cut safely - rather
 * than failing the message), and a description with only HTML gets its plain text derived. Never throws.
 */
export function sanitizeInboundDescription(description: string | undefined, html: string | undefined): { description?: string; descriptionHtml?: string } {
    let clean: string | undefined = html !== undefined ? sanitizeEventDescriptionHtml(html) : undefined;
    if (clean !== undefined && (clean === "" || clean.length > MAX_EVENT_DESCRIPTION_HTML_LENGTH)) {
        clean = undefined;
    }
    const plain: string = description !== undefined ? cleanPlainDescription(description).slice(0, MAX_EVENT_DESCRIPTION_LENGTH) : "";
    const text: string = plain !== "" ? plain : clean !== undefined ? htmlToPlainText(clean) : "";
    return { ...(text !== "" ? { description: text } : {}), ...(clean !== undefined ? { descriptionHtml: clean } : {}) };
}
