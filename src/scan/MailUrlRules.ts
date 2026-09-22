///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * The URL rules of the mail HTML sanitizer, shared by the markup (`HtmlSanitizer`) and the stylesheet (`CssSanitizer`) halves so that
 * an `<img src>`, a `background` attribute and a CSS `url()` are held to exactly the same standard.
 *
 * Every function returns the *canonical* form of an accepted URL, never the input, or `undefined` for anything not accepted. Browsers
 * ignore tabs and newlines inside a URL and control characters around it (`java\tscript:`), so those are removed before the scheme is
 * looked at, and the canonical form is what the sanitizer writes - what was checked is what is emitted.
 *
 * @author Jean-Philippe Steinmetz
 */

/** The longest link or remote image URL kept. Tracking URLs run to a couple of kilobytes; nothing legitimate is longer. */
export const MAX_URL_LENGTH = 8192;

/** The characters a `cid:` token may consist of - what real `Content-ID`s use, and nothing that needs escaping in HTML or CSS. */
export const CID_TOKEN_PATTERN = "[A-Za-z0-9._~@+=!$*/-]{1,256}";
const CID_TOKEN: RegExp = new RegExp(`^${CID_TOKEN_PATTERN}$`);

const ASCII_CONTROL: string = String.fromCharCode(0) + "-" + String.fromCharCode(0x1f) + String.fromCharCode(0x7f) + "-" + String.fromCharCode(0x9f);
const CONTROLS: RegExp = new RegExp(`[${ASCII_CONTROL}]`, "g");
const HAS_CONTROL: RegExp = new RegExp(`[${ASCII_CONTROL}]`);
const TEXT_CONTROLS: RegExp = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(0xb)}${String.fromCharCode(0xc)}${String.fromCharCode(0xe)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}-${String.fromCharCode(0x9f)}]`, "g");
const TAB_NEWLINE: RegExp = /[\t\n\r]/g;
const BASE64: RegExp = /^[A-Za-z0-9+/]*={0,2}$/;
const DATA_IMAGE: RegExp = /^data:image\/(png|jpe?g|gif|webp|avif);base64,(.*)$/is;

/** Whether `text` holds a control character. */
export function hasControl(text: string): boolean {
    return HAS_CONTROL.test(text);
}

/** Removes every control character (used for text that ends up in attribute values). */
export function stripControls(text: string): string {
    return text.replace(CONTROLS, "");
}

/** Removes every control character except tab, newline and carriage return (used for text nodes). */
export function stripTextControls(text: string): string {
    return text.replace(TEXT_CONTROLS, "");
}

/**
 * What a browser would make of `raw` before parsing it as a URL: leading/trailing C0 controls and spaces removed, tabs and newlines
 * removed everywhere. `undefined` when what is left still holds a control character or is longer than `maxLength`.
 */
function normalise(raw: string, maxLength: number = MAX_URL_LENGTH): string | undefined {
    const trimmed: string = raw.replace(TAB_NEWLINE, "").trim();
    return trimmed.length > maxLength || HAS_CONTROL.test(trimmed) ? undefined : trimmed;
}

/** Percent-encodes the few characters that could end an attribute or a CSS string early, so the URL can be written in either. */
function encodeUnsafe(url: string): string {
    return url.replace(/[\s"'<>\\`{}|^]/g, (c: string) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * A `cid:` reference's token - `cid:<image001@x>`, `cid:image%40x` and `cid:image@x` all give `image@x` - or `undefined` when it holds
 * anything a `Content-ID` does not.
 */
export function cidToken(rest: string): string | undefined {
    let decoded: string;
    try {
        decoded = decodeURIComponent(rest.trim());
    } catch {
        return undefined;
    }
    const token: string = decoded.replace(/^<|>$/g, "");
    return CID_TOKEN.test(token) ? token : undefined;
}

/**
 * The canonical form of an image URL - `cid:<token>`, a `data:image/(png|jpeg|gif|webp|avif);base64,...` no larger than
 * `maxDataImageBytes` once decoded, or an `http(s)` URL - or `undefined` for anything else (any other scheme, a relative URL, SVG
 * data, oversized data). Used for `<img src>`, a `background` attribute and CSS `url()`.
 */
export function sanitizeImageUrl(raw: string, maxDataImageBytes: number): string | undefined {
    const url: string | undefined = normalise(raw, Math.max(MAX_URL_LENGTH, Math.ceil((maxDataImageBytes * 4) / 3) + 128));
    if (url === undefined) {
        return undefined;
    }
    if (/^cid:/i.test(url)) {
        const token: string | undefined = cidToken(url.slice(4));
        return token === undefined ? undefined : `cid:${token}`;
    }
    if (/^data:/i.test(url)) {
        const match: RegExpExecArray | null = DATA_IMAGE.exec(url);
        const payload: string = match ? match[2].replace(/\s+/g, "") : "";
        if (!match || payload.length === 0 || !BASE64.test(payload) || Math.floor((payload.length * 3) / 4) > maxDataImageBytes) {
            return undefined;
        }
        const type: string = match[1].toLowerCase().replace("jpg", "jpeg");
        return `data:image/${type};base64,${payload}`;
    }
    return url.length <= MAX_URL_LENGTH && /^https?:\/\/[^/?#\s]+/i.test(url) && !url.includes("\\") ? encodeUnsafe(url) : undefined;
}

/**
 * The canonical form of a link target - `http`, `https`, `mailto` or `tel` only - or `undefined`. A relative URL, a fragment and every
 * other scheme (`javascript:`, `data:`, `vbscript:`, `file:`, `cid:` ...) is refused: a link in a message that goes nowhere a reader
 * could safely follow is text.
 */
export function sanitizeLinkUrl(raw: string): string | undefined {
    const url: string | undefined = normalise(raw);
    if (url === undefined || !/^(?:https?:\/\/[^/?#\s]+|mailto:|tel:)/i.test(url) || url.includes("\\")) {
        return undefined;
    }
    return encodeUnsafe(url);
}
