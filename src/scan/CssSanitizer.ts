///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { hasControl, sanitizeImageUrl } from "./MailUrlRules.js";

/**
 * The stylesheet half of the mail HTML sanitizer: a `<style>` block or a `style` attribute in, the same design out with everything
 * that could execute, load, overlay or track removed.
 *
 * **Why a tokenizer of its own rather than a stylesheet library.** A sanitizer is only as sound as the agreement between what it
 * checked and what the browser will read. Here the input is tokenized exactly as CSS Syntax Level 3 says (escapes decoded, comments
 * removed, strings and `url()` recognised), every rule, selector and declaration is checked *as tokens*, and the output is written
 * back out *from those tokens* in a canonical form - so `u\72l(javascript:x)`, `expr/**\/ession(...)` and `\75rl(` are, by the time
 * they are checked, plain `url(` and `expression(`, and nothing that was not checked can be in the output. `postcss` (which
 * `sanitize-html` brings in) was evaluated and would still have needed exactly this token pass for every value, so it is not used.
 * There is no dependency: this module and `MailUrlRules` are all of it.
 *
 * What is kept: an allow-list of properties (colour, background, font, text, box model, table, list, flex layout, `display` values
 * that lay out and never overlay, `overflow` without scrolling), `@media` blocks (including `prefers-color-scheme`), and selectors
 * (with ID selectors renamed the way the markup's `id` attributes are, `prefixId()`). What is dropped: every other at-rule
 * (`@import`, `@font-face`, `@keyframes`, `@charset`, `@namespace`, `@page`, `@supports`, `@container` ...), every other property
 * (`position: absolute|fixed|sticky`, `z-index`, `content`, `cursor`, `filter`, `behavior`, `-moz-binding`, `mso-*`, animation,
 * transform, custom properties), every function that could take a URL or run code (`expression()`, `image-set()`, `var()` ...), and
 * every `url()` that is not a `cid:`, a small raster `data:` image or an `http(s)` URL.
 *
 * @author Jean-Philippe Steinmetz
 */

/** What an `id` attribute, and an `#id` selector, is renamed to so a message's element can never be reached by the app's own ids. */
export const ID_PREFIX = "m-";

/** `id` with `ID_PREFIX` in front, unless it has it already (which keeps the sanitizer idempotent). */
export function prefixId(id: string): string {
    return id.startsWith(ID_PREFIX) ? id : ID_PREFIX + id;
}

/** What one document's stylesheets and style attributes may add up to; counted down as they are sanitized. */
export interface CssContext {
    /** Rules (a rule, or a `@media` block, is one) still allowed. */
    rulesLeft: number;
    /** Bytes of sanitized CSS still allowed. */
    bytesLeft: number;
    /** The largest decoded `data:` image a `url()` may hold. */
    maxDataImageBytes: number;
}

///////////////////////////////////////////////////////////////////////////////
// Tokenizer
///////////////////////////////////////////////////////////////////////////////

export type CssTokenType =
    | "ws"
    | "ident"
    | "function"
    | "atkeyword"
    | "hash"
    | "string"
    | "url"
    | "number"
    | "percentage"
    | "dimension"
    | "delim"
    | "comma"
    | "colon"
    | "semicolon"
    | "("
    | ")"
    | "["
    | "]"
    | "{"
    | "}"
    | "bad";

export interface CssToken {
    type: CssTokenType;
    /** Decoded text for names, strings and URLs; the number as written for numeric tokens; the character for a delimiter. */
    value: string;
    /** A dimension's unit. */
    unit?: string;
    /** A hash token that is a valid identifier, i.e. an ID selector. */
    isId?: boolean;
}

const isDigit = (c: number): boolean => c >= 48 && c <= 57;
const isHex = (c: number): boolean => isDigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isNameStart = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c >= 0x80;
const isNameChar = (c: number): boolean => isNameStart(c) || isDigit(c) || c === 45;
const isWhitespace = (c: number): boolean => c === 32 || c === 9 || c === 10;
const NUMBER: RegExp = /[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Tokenizes `input` per CSS Syntax Level 3 (comments become whitespace; an unterminated string or `url(` becomes a `bad` token). */
export function tokenizeCss(input: string): CssToken[] {
    const src: string = input.replace(/\r\n?|\f/g, "\n").replace(/\0/g, "�");
    const length: number = src.length;
    const out: CssToken[] = [];
    let pos: number = 0;

    const at = (k: number): number => (k < length ? src.charCodeAt(k) : -1);
    const validEscape = (k: number): boolean => at(k) === 92 && at(k + 1) !== -1 && at(k + 1) !== 10;
    const startsIdent = (k: number): boolean => {
        const c: number = at(k);
        if (c === 45) {
            const d: number = at(k + 1);
            return isNameStart(d) || d === 45 || validEscape(k + 1);
        }
        return isNameStart(c) || validEscape(k);
    };
    const startsNumber = (k: number): boolean => {
        const c: number = at(k);
        if (c === 43 || c === 45) {
            return isDigit(at(k + 1)) || (at(k + 1) === 46 && isDigit(at(k + 2)));
        }
        // Only a sign or a dot ever gets here (a digit starts a number without asking).
        return isDigit(at(k + 1));
    };
    /** `pos` is just past the backslash. */
    const consumeEscape = (): string => {
        if (isHex(at(pos))) {
            let hex: string = "";
            while (hex.length < 6 && isHex(at(pos))) {
                hex += src[pos++];
            }
            if (isWhitespace(at(pos))) {
                pos++;
            }
            const point: number = parseInt(hex, 16);
            return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? "�" : String.fromCodePoint(point);
        }
        const character: string = String.fromCodePoint(src.codePointAt(pos) as number);
        pos += character.length;
        return character;
    };
    const consumeName = (): string => {
        let name: string = "";
        for (;;) {
            if (isNameChar(at(pos))) {
                name += src[pos++];
            } else if (validEscape(pos)) {
                pos++;
                name += consumeEscape();
            } else {
                return name;
            }
        }
    };
    /** `pos` is at the opening quote. `undefined` for a string a newline or the end of the input cuts short. */
    const consumeString = (): string | undefined => {
        const quote: number = at(pos++);
        let text: string = "";
        for (;;) {
            const c: number = at(pos);
            if (c === quote) {
                pos++;
                return text;
            }
            if (c === -1 || c === 10) {
                return undefined;
            }
            if (c === 92) {
                pos++;
                if (at(pos) === 10) {
                    pos++;
                } else if (at(pos) !== -1) {
                    text += consumeEscape();
                }
            } else {
                text += src[pos++];
            }
        }
    };
    /** Skips what is left of a malformed `url(`, up to and including its `)`. */
    const skipBadUrl = (): void => {
        while (pos < length && at(pos) !== 41) {
            pos += validEscape(pos) ? 2 : 1;
        }
        pos++;
    };
    const consumeUnquotedUrl = (): CssToken => {
        while (isWhitespace(at(pos))) {
            pos++;
        }
        let url: string = "";
        for (;;) {
            const c: number = at(pos);
            if (c === 41) {
                pos++;
                return { type: "url", value: url };
            }
            if (isWhitespace(c)) {
                while (isWhitespace(at(pos))) {
                    pos++;
                }
                if (at(pos) === 41) {
                    continue;
                }
                skipBadUrl();
                return { type: "bad", value: "url" };
            }
            if (c === -1 || c === 34 || c === 39 || c === 40 || c <= 8 || c === 11 || (c >= 14 && c <= 31) || c === 127) {
                skipBadUrl();
                return { type: "bad", value: "url" };
            }
            if (c === 92) {
                if (!validEscape(pos)) {
                    skipBadUrl();
                    return { type: "bad", value: "url" };
                }
                pos++;
                url += consumeEscape();
            } else {
                url += src[pos++];
            }
        }
    };
    const consumeIdentLike = (): void => {
        const name: string = consumeName();
        if (at(pos) !== 40) {
            out.push({ type: "ident", value: name });
            return;
        }
        pos++;
        if (name.toLowerCase() !== "url") {
            out.push({ type: "function", value: name });
            return;
        }
        let quoteAt: number = pos;
        while (isWhitespace(at(quoteAt))) {
            quoteAt++;
        }
        if (at(quoteAt) !== 34 && at(quoteAt) !== 39) {
            out.push(consumeUnquotedUrl());
            return;
        }
        pos = quoteAt;
        const text: string | undefined = consumeString();
        while (isWhitespace(at(pos))) {
            pos++;
        }
        if (text !== undefined && at(pos) === 41) {
            pos++;
            out.push({ type: "url", value: text });
        } else {
            skipBadUrl();
            out.push({ type: "bad", value: "url" });
        }
    };
    const consumeNumeric = (): void => {
        NUMBER.lastIndex = pos;
        const value: string = (NUMBER.exec(src) as RegExpExecArray)[0];
        pos += value.length;
        if (startsIdent(pos)) {
            out.push({ type: "dimension", value, unit: consumeName() });
        } else if (at(pos) === 37) {
            pos++;
            out.push({ type: "percentage", value });
        } else {
            out.push({ type: "number", value });
        }
    };

    while (pos < length) {
        const c: number = at(pos);
        if (isWhitespace(c) || (c === 47 && at(pos + 1) === 42)) {
            if (c === 47) {
                const end: number = src.indexOf("*/", pos + 2);
                pos = end < 0 ? length : end + 2;
            } else {
                while (isWhitespace(at(pos))) {
                    pos++;
                }
            }
            if (out.length > 0 && out[out.length - 1].type !== "ws") {
                out.push({ type: "ws", value: " " });
            }
        } else if (c === 34 || c === 39) {
            const text: string | undefined = consumeString();
            out.push(text === undefined ? { type: "bad", value: "string" } : { type: "string", value: text });
        } else if (c === 35) {
            pos++;
            if (isNameChar(at(pos)) || validEscape(pos)) {
                const isId: boolean = startsIdent(pos);
                out.push({ type: "hash", value: consumeName(), isId });
            } else {
                out.push({ type: "delim", value: "#" });
            }
        } else if (c === 64) {
            pos++;
            if (startsIdent(pos)) {
                out.push({ type: "atkeyword", value: consumeName() });
            } else {
                out.push({ type: "delim", value: "@" });
            }
        } else if (isDigit(c) || ((c === 43 || c === 45 || c === 46) && startsNumber(pos))) {
            consumeNumeric();
        } else if (startsIdent(pos)) {
            consumeIdentLike();
        } else if (c === 44) {
            pos++;
            out.push({ type: "comma", value: "," });
        } else if (c === 58) {
            pos++;
            out.push({ type: "colon", value: ":" });
        } else if (c === 59) {
            pos++;
            out.push({ type: "semicolon", value: ";" });
        } else if (c === 40 || c === 41 || c === 91 || c === 93 || c === 123 || c === 125) {
            pos++;
            out.push({ type: String.fromCharCode(c) as CssTokenType, value: String.fromCharCode(c) });
        } else {
            const character: string = String.fromCodePoint(src.codePointAt(pos) as number);
            pos += character.length;
            out.push({ type: "delim", value: character });
        }
    }
    return out;
}

///////////////////////////////////////////////////////////////////////////////
// Serializer
///////////////////////////////////////////////////////////////////////////////

/** `value` as an identifier that tokenizes back to exactly `value` (`isHash`: as the name of a hash, which may begin with a digit). */
export function escapeCssIdent(value: string, isHash: boolean = false): string {
    let out: string = "";
    for (let k = 0; k < value.length; k++) {
        const c: number = value.charCodeAt(k);
        if (c === 0x3c) {
            out += "\\3c ";
        } else if ((c >= 1 && c <= 0x1f) || c === 0x7f) {
            out += `\\${c.toString(16)} `;
        } else if (!isHash && isDigit(c) && (k === 0 || (k === 1 && value.charCodeAt(0) === 45))) {
            out += `\\${c.toString(16)} `;
        } else if (c === 45 && k === 0 && value.length === 1) {
            out += "\\-";
        } else if (isNameChar(c)) {
            out += value[k];
        } else {
            out += `\\${value[k]}`;
        }
    }
    return out;
}

/** `value` as a single-quoted string that tokenizes back to exactly `value`; `<` is escaped so `</style` cannot be written. */
export function escapeCssString(value: string): string {
    let out: string = "'";
    for (let k = 0; k < value.length; k++) {
        const c: number = value.charCodeAt(k);
        if (c === 0x3c || c === 0 || c < 0x20 || c === 0x7f) {
            out += `\\${c.toString(16)} `;
        } else if (c === 39 || c === 92) {
            out += `\\${value[k]}`;
        } else {
            out += value[k];
        }
    }
    return `${out}'`;
}

function serializeToken(token: CssToken): string {
    switch (token.type) {
        case "ident":
            return escapeCssIdent(token.value);
        case "function":
            return `${escapeCssIdent(token.value)}(`;
        case "atkeyword":
            return `@${escapeCssIdent(token.value)}`;
        case "hash":
            return `#${escapeCssIdent(token.value, true)}`;
        case "string":
            return escapeCssString(token.value);
        case "url":
            return `url(${escapeCssString(token.value)})`;
        case "percentage":
            return `${token.value}%`;
        case "dimension":
            return token.value + escapeCssIdent(token.unit as string);
        default:
            return token.value;
    }
}

/** Writes tokens back out, one space where the input had whitespace, none next to a comma or just inside a parenthesis. */
export function serializeCssTokens(tokens: CssToken[]): string {
    let out: string = "";
    let previous: CssToken | undefined;
    let space: boolean = false;
    for (const token of tokens) {
        if (token.type === "ws") {
            space = previous !== undefined;
            continue;
        }
        if (space && previous!.type !== "(" && previous!.type !== "function" && previous!.type !== "comma" && token.type !== ")" && token.type !== "comma") {
            out += " ";
        }
        space = false;
        out += serializeToken(token);
        previous = token;
    }
    return out;
}

///////////////////////////////////////////////////////////////////////////////
// Allow-lists
///////////////////////////////////////////////////////////////////////////////

const PROPERTY_EXACT: Set<string> = new Set([
    "color",
    "color-scheme",
    "opacity",
    "visibility",
    "direction",
    "unicode-bidi",
    "white-space",
    "word-break",
    "word-wrap",
    "overflow-wrap",
    "word-spacing",
    "letter-spacing",
    "line-height",
    "vertical-align",
    "table-layout",
    "empty-cells",
    "caption-side",
    "display",
    "float",
    "clear",
    "overflow",
    "overflow-x",
    "overflow-y",
    "width",
    "height",
    "min-width",
    "min-height",
    "max-width",
    "max-height",
    "box-sizing",
    "box-shadow",
    "aspect-ratio",
    "object-fit",
    "object-position",
    "position",
    "gap",
    "row-gap",
    "column-gap",
    "order",
    "hyphens",
    "tab-size",
    "font-smoothing",
    "align-items",
    "align-content",
    "align-self",
    "justify-items",
    "justify-content",
    "justify-self",
]);

/** Families of properties, each one segment at a time: `border-top-left-radius`, `background-position-x`, `font-variant-caps`. */
const PROPERTY_FAMILY: RegExp = /^(?:border|margin|padding|font|text|list-style|outline|background|flex)(?:-[a-z]+)*$/;
/** Family members that fetch (`border-image`), attach to the viewport (`background-attachment`) or cannot be judged. */
const PROPERTY_EXCLUDED: RegExp = /image|attachment|mask/;
const URL_PROPERTIES: Set<string> = new Set(["background", "background-image", "list-style", "list-style-image"]);

const VENDOR_PREFIX: RegExp = /^-(?:webkit|moz|ms|o)-/;

function isAllowedProperty(name: string): boolean {
    const base: string = name.replace(VENDOR_PREFIX, "");
    if (URL_PROPERTIES.has(base)) {
        return true;
    }
    return PROPERTY_EXACT.has(base) || (PROPERTY_FAMILY.test(base) && !PROPERTY_EXCLUDED.test(base));
}

/** The only functions a value may contain: colours, arithmetic and gradients. Anything else that can take a URL or run code is out. */
const FUNCTIONS: Set<string> = new Set([
    "rgb",
    "rgba",
    "hsl",
    "hsla",
    "hwb",
    "lab",
    "lch",
    "oklab",
    "oklch",
    "color",
    "color-mix",
    "calc",
    "min",
    "max",
    "clamp",
    "linear-gradient",
    "radial-gradient",
    "conic-gradient",
    "repeating-linear-gradient",
    "repeating-radial-gradient",
    "gradient",
    "from",
    "to",
    "color-stop",
]);

const DISPLAY_VALUES: Set<string> = new Set([
    "block",
    "inline",
    "inline-block",
    "table",
    "table-row",
    "table-cell",
    "table-header-group",
    "table-row-group",
    "table-footer-group",
    "table-column",
    "table-column-group",
    "table-caption",
    "flex",
    "inline-flex",
    "none",
    "list-item",
]);

const PSEUDO_FUNCTIONS: Set<string> = new Set(["not", "is", "where", "has", "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type", "lang", "dir", "matches", "any"]);

const MAX_VALUE_TOKENS = 400;
const MAX_NESTING = 8;
const MAX_MEDIA_LENGTH = 512;
const MAX_SELECTOR_LENGTH = 1024;
const MAX_SELECTORS = 100;
const MAX_MEDIA_DEPTH = 3;

/** The identifiers among `tokens` (whitespace ignored), lowercased, or `undefined` when there is anything else. */
function identifiersOf(tokens: CssToken[]): string[] | undefined {
    const names: string[] = [];
    for (const token of tokens) {
        if (token.type === "ident") {
            names.push(token.value.toLowerCase().replace(VENDOR_PREFIX, ""));
        } else if (token.type !== "ws") {
            return undefined;
        }
    }
    return names;
}

/** Whether `value` (already checked to hold nothing dangerous) is a value `property` may have; restricts the few that lay out or overlay. */
function isAcceptableValue(property: string, value: CssToken[]): boolean {
    const names: string[] | undefined = identifiersOf(value);
    if (property === "display") {
        return names !== undefined && names.length === 1 && DISPLAY_VALUES.has(names[0]);
    }
    if (property === "position") {
        return names !== undefined && names.length === 1 && (names[0] === "relative" || names[0] === "static");
    }
    if (property.startsWith("overflow") && property !== "overflow-wrap") {
        return names !== undefined && names.length >= 1 && names.length <= 2 && names.every((name) => name === "visible" || name === "hidden" || name === "auto");
    }
    return true;
}

/** The tokens of a value with every `url()` replaced by its canonical form, or `undefined` if any token is not allowed in a value. */
function checkValue(property: string, tokens: CssToken[], ctx: CssContext): CssToken[] | undefined {
    if (tokens.length > MAX_VALUE_TOKENS) {
        return undefined;
    }
    let depth: number = 0;
    const checked: CssToken[] = [];
    for (const token of tokens) {
        switch (token.type) {
            case "ws":
            case "number":
            case "percentage":
            case "comma":
                checked.push(token);
                break;
            case "ident":
            case "string":
            case "dimension":
            case "hash":
                // A control character in a name is what `auto\9` style hacks are made of; no browser applies such a declaration.
                if (hasControl(token.value) || hasControl(token.unit ?? "")) {
                    return undefined;
                }
                checked.push(token);
                break;
            case "function":
                if (!FUNCTIONS.has(token.value.toLowerCase().replace(VENDOR_PREFIX, "")) || ++depth > MAX_NESTING) {
                    return undefined;
                }
                checked.push(token);
                break;
            case "(":
                if (++depth > MAX_NESTING) {
                    return undefined;
                }
                checked.push(token);
                break;
            case ")":
                if (--depth < 0) {
                    return undefined;
                }
                checked.push(token);
                break;
            case "url": {
                const url: string | undefined = URL_PROPERTIES.has(property) ? sanitizeImageUrl(token.value, ctx.maxDataImageBytes) : undefined;
                if (url === undefined) {
                    return undefined;
                }
                checked.push({ type: "url", value: url });
                break;
            }
            case "delim":
                if (!"/+-*".includes(token.value)) {
                    return undefined;
                }
                checked.push(token);
                break;
            default:
                return undefined;
        }
    }
    return depth === 0 ? checked : undefined;
}

/** Splits `tokens` at the semicolons that are not inside brackets, parentheses, braces or a function. */
function splitTopLevel(tokens: CssToken[], separator: CssTokenType): CssToken[][] {
    const parts: CssToken[][] = [[]];
    let depth: number = 0;
    for (const token of tokens) {
        if (token.type === "(" || token.type === "[" || token.type === "{" || token.type === "function") {
            depth++;
        } else if ((token.type === ")" || token.type === "]" || token.type === "}") && depth > 0) {
            depth--;
        }
        if (depth === 0 && token.type === separator) {
            parts.push([]);
        } else {
            parts[parts.length - 1].push(token);
        }
    }
    return parts;
}

function trimWhitespace(tokens: CssToken[]): CssToken[] {
    let start: number = 0;
    let end: number = tokens.length;
    while (start < end && tokens[start].type === "ws") {
        start++;
    }
    while (end > start && tokens[end - 1].type === "ws") {
        end--;
    }
    return tokens.slice(start, end);
}

/** One declaration's tokens as `property:value[!important]`, or `undefined` when it is malformed or not allowed. */
function sanitizeDeclaration(tokens: CssToken[], ctx: CssContext): string | undefined {
    const parts: CssToken[] = trimWhitespace(tokens);
    if (parts.length < 3 || parts[0].type !== "ident") {
        return undefined;
    }
    const property: string = parts[0].value.toLowerCase();
    let colon: number = 1;
    if (parts[colon].type === "ws") {
        colon++;
    }
    if (parts[colon]?.type !== "colon" || !isAllowedProperty(property)) {
        return undefined;
    }
    let value: CssToken[] = trimWhitespace(parts.slice(colon + 1));
    let important: boolean = false;
    const bang: number = value.findIndex((token) => token.type === "delim" && token.value === "!");
    if (bang >= 0) {
        const tail: CssToken[] = value.slice(bang + 1).filter((token) => token.type !== "ws");
        if (tail.length !== 1 || tail[0].type !== "ident" || tail[0].value.toLowerCase() !== "important") {
            return undefined;
        }
        important = true;
        value = trimWhitespace(value.slice(0, bang));
    }
    const base: string = property.replace(VENDOR_PREFIX, "");
    const checked: CssToken[] | undefined = value.length > 0 && isAcceptableValue(base, value) ? checkValue(base, value, ctx) : undefined;
    if (checked === undefined) {
        return undefined;
    }
    const text: string = serializeCssTokens(checked);
    return text.length > 4096 + Math.ceil((ctx.maxDataImageBytes * 4) / 3) ? undefined : `${escapeCssIdent(property)}:${text}${important ? "!important" : ""}`;
}

function sanitizeDeclarations(tokens: CssToken[], ctx: CssContext): string[] {
    const declarations: string[] = [];
    for (const part of splitTopLevel(tokens, "semicolon")) {
        const declaration: string | undefined = sanitizeDeclaration(part, ctx);
        if (declaration !== undefined) {
            declarations.push(declaration);
        }
    }
    return declarations;
}

/** One complex selector's tokens in canonical form, ID selectors renamed by `prefixId()`, or `undefined` if it holds anything else. */
function sanitizeSelector(tokens: CssToken[]): string | undefined {
    const selector: CssToken[] = trimWhitespace(tokens);
    if (selector.length === 0) {
        return undefined;
    }
    const closers: CssTokenType[] = [];
    const checked: CssToken[] = [];
    let previous: CssToken | undefined;
    for (const token of selector) {
        switch (token.type) {
            case "ws":
            case "ident":
            case "string":
            case "colon":
                break;
            case "hash":
                if (!token.isId) {
                    return undefined;
                }
                break;
            case "number":
            case "dimension":
            case "percentage":
                if (closers.length === 0) {
                    return undefined;
                }
                break;
            case "comma":
                // Only the arguments of a pseudo-class have commas (`:not(a, b)`); the list of selectors was split at its own.
                if (closers[closers.length - 1] !== ")") {
                    return undefined;
                }
                break;
            case "delim":
                if (!".*>+~|=^$".includes(token.value)) {
                    return undefined;
                }
                break;
            case "function": {
                const name: string = token.value.toLowerCase().replace(VENDOR_PREFIX, "");
                if (previous?.type !== "colon" || !PSEUDO_FUNCTIONS.has(name) || closers.length >= MAX_NESTING) {
                    return undefined;
                }
                closers.push(")");
                break;
            }
            case "[":
                if (closers.includes("]")) {
                    return undefined;
                }
                closers.push("]");
                break;
            case ")":
            case "]":
                if (closers.pop() !== token.type) {
                    return undefined;
                }
                break;
            default:
                return undefined;
        }
        checked.push(token.type === "hash" ? { ...token, value: prefixId(token.value) } : token);
        previous = token.type === "ws" ? previous : token;
    }
    return closers.length === 0 ? serializeCssTokens(checked) : undefined;
}

function sanitizeSelectorList(tokens: CssToken[]): string | undefined {
    const selectors: string[] = [];
    for (const part of splitTopLevel(tokens, "comma").slice(0, MAX_SELECTORS)) {
        const selector: string | undefined = sanitizeSelector(part);
        if (selector !== undefined && selector.length <= MAX_SELECTOR_LENGTH) {
            selectors.push(selector);
        }
    }
    return selectors.length > 0 ? selectors.join(",") : undefined;
}

/** A `@media` prelude in canonical form, or `undefined` if it is anything but media types, features and `and`/`not`/`only`/`,`. */
function sanitizeMediaQuery(tokens: CssToken[]): string | undefined {
    const query: CssToken[] = trimWhitespace(tokens);
    let depth: number = 0;
    for (const token of query) {
        if (token.type === "(") {
            depth++;
        } else if (token.type === ")") {
            depth--;
        } else if (token.type === "delim" ? token.value !== "/" : !["ws", "ident", "colon", "number", "dimension", "percentage", "comma"].includes(token.type)) {
            return undefined;
        }
        if (depth < 0 || depth > MAX_NESTING) {
            return undefined;
        }
    }
    const text: string = serializeCssTokens(query);
    return depth === 0 && text.length <= MAX_MEDIA_LENGTH ? text || "all" : undefined;
}

/** A `<style media>` attribute in canonical form, or `undefined` when it is not a plain media query list. */
export function sanitizeMediaCondition(value: string): string | undefined {
    return value.length > MAX_MEDIA_LENGTH ? undefined : sanitizeMediaQuery(tokenizeCss(value));
}

/** The index just past the end of the prelude that starts at `start`: at its `{` or `;`, or the end of `tokens`. */
function findPreludeEnd(tokens: CssToken[], start: number): number {
    const closers: CssTokenType[] = [];
    for (let k = start; k < tokens.length; k++) {
        const type: CssTokenType = tokens[k].type;
        if (closers.length === 0 && (type === "{" || type === "semicolon")) {
            return k;
        }
        if (type === "(" || type === "function") {
            closers.push(")");
        } else if (type === "[") {
            closers.push("]");
        } else if (type === "{") {
            closers.push("}");
        } else if (closers.length > 0 && closers[closers.length - 1] === type) {
            closers.pop();
        }
    }
    return tokens.length;
}

/** The index of the `}` that closes the block opened at `open`, or the end of `tokens`. */
function findBlockEnd(tokens: CssToken[], open: number): number {
    const closers: CssTokenType[] = ["}"];
    for (let k = open + 1; k < tokens.length; k++) {
        const type: CssTokenType = tokens[k].type;
        if (type === "(" || type === "function") {
            closers.push(")");
        } else if (type === "[") {
            closers.push("]");
        } else if (type === "{") {
            closers.push("}");
        } else if (closers[closers.length - 1] === type) {
            closers.pop();
            if (closers.length === 0) {
                return k;
            }
        }
    }
    return tokens.length;
}

function sanitizeRules(tokens: CssToken[], ctx: CssContext, depth: number): string {
    let out: string = "";
    let index: number = 0;
    while (index < tokens.length && ctx.rulesLeft > 0 && ctx.bytesLeft > 0) {
        const first: CssToken = tokens[index];
        if (first.type === "ws" || first.type === "semicolon" || first.type === "}") {
            index++;
            continue;
        }
        const isAtRule: boolean = first.type === "atkeyword";
        const end: number = findPreludeEnd(tokens, index);
        if (end >= tokens.length || tokens[end].type === "semicolon") {
            // `@import ...;`, `@charset ...;`, `@namespace ...;`, or a rule that never gets a block: nothing to keep.
            index = end + 1;
            continue;
        }
        const prelude: CssToken[] = tokens.slice(isAtRule ? index + 1 : index, end);
        const close: number = findBlockEnd(tokens, end);
        const block: CssToken[] = tokens.slice(end + 1, close);
        index = close + 1;
        if (isAtRule) {
            // The rules inside have drawn down the limits already; the block around them costs only its own bytes.
            const query: string | undefined = first.value.toLowerCase() === "media" && depth < MAX_MEDIA_DEPTH ? sanitizeMediaQuery(prelude) : undefined;
            const inner: string = query === undefined ? "" : sanitizeRules(block, ctx, depth + 1);
            if (inner) {
                out += `@media ${query}{${inner}}`;
                ctx.bytesLeft -= query!.length + 9;
            }
            continue;
        }
        const selector: string | undefined = sanitizeSelectorList(prelude);
        const declarations: string[] = selector === undefined ? [] : sanitizeDeclarations(block, ctx);
        const text: string = `${selector}{${declarations.join(";")}}`;
        if (declarations.length > 0 && text.length <= ctx.bytesLeft) {
            out += text;
            ctx.bytesLeft -= text.length;
            ctx.rulesLeft--;
        }
    }
    return out;
}

/** Creates the counters for one document, from its limits (see `CssContext`). */
export function createCssContext(maxBytes: number, maxRules: number, maxDataImageBytes: number): CssContext {
    return { rulesLeft: maxRules, bytesLeft: maxBytes, maxDataImageBytes };
}

/**
 * The sanitized form of a `<style>` block's text - rules only, compact, and never containing a `<` - drawing down `ctx`. Empty when
 * nothing survives or the limits are used up. Text beyond `ctx.bytesLeft` is not even tokenized.
 */
export function sanitizeStyleSheet(css: string, ctx: CssContext): string {
    if (ctx.rulesLeft <= 0 || ctx.bytesLeft <= 0) {
        return "";
    }
    // The input a stylesheet may be is bounded by what its output may be, with room for the comments and whitespace of real mail CSS.
    const bounded: string = css.length > ctx.bytesLeft * 4 ? css.slice(0, ctx.bytesLeft * 4) : css;
    return sanitizeRules(tokenizeCss(bounded.replace(/<!--|-->/g, " ")), ctx, 0);
}

/** The sanitized form of a `style` attribute's value: `property:value;property:value`, or `""` when nothing survives. */
export function sanitizeInlineStyle(value: string, ctx: CssContext): string {
    const limit: number = 16_384 + Math.ceil((ctx.maxDataImageBytes * 4) / 3);
    const bounded: string = value.length > limit ? value.slice(0, limit) : value;
    return sanitizeDeclarations(tokenizeCss(bounded), ctx).join(";");
}
