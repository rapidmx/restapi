///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

import addressparser from "nodemailer/lib/addressparser/index.js";
import { hasAlignedPassingDkim } from "./AuthenticationResultsUtils.js";
import { topmostTrustedAuthenticationResults } from "./DkimOversignUtils.js";

/**
 * Shared low-level RFC 5322 header-block primitives - a small line-scan, deliberately not a full MIME
 * parse (see `BaseMailIngestRoute`'s "minimum synchronous work" design). Used by both
 * `DistributionListUtils.ts` (list-header rewriting) and `TransportRuleUtils.ts`/`BaseMailIngestRoute`
 * (transport-rule header tagging), which each need to read or rewrite a raw message's top-level headers
 * without paying for a real MIME parse.
 */

/**
 * Splits a raw RFC 5322 message into its header block and body, at the first blank line. Decodes/encodes via
 * the `binary` (latin1) encoding so every byte round-trips exactly - headers are ASCII by spec, and this never
 * touches (or needs to understand) the body's own encoding.
 */
function splitRawIntoHeaderAndBody(raw: Buffer): { headerText: string; bodyText: string } {
    const text: string = raw.toString("binary");
    const match: RegExpMatchArray | null = text.match(/\r\n\r\n|\n\n/);
    if (!match || match.index === undefined) {
        return { headerText: text, bodyText: "" };
    }
    return { headerText: text.slice(0, match.index), bodyText: text.slice(match.index + match[0].length) };
}

/** Unfolds a header block's physical lines into logical ones - a continuation line (starting with a space or
 * tab) is joined onto the previous logical header rather than treated as its own. */
function splitLogicalHeaderLines(headerText: string): string[] {
    const physicalLines: string[] = headerText.split(/\r\n|\n/);
    const logical: string[] = [];
    for (const line of physicalLines) {
        if (/^[ \t]/.test(line) && logical.length > 0) {
            logical[logical.length - 1] += "\r\n" + line;
        } else if (line.length > 0) {
            logical.push(line);
        }
    }
    return logical;
}

/**
 * Reads a single top-level header's value out of a raw RFC 5322 message via a small line-scan over the header
 * block only - not a full MIME parse, deliberately (see `BaseMailIngestRoute`'s "minimum synchronous work"
 * design). Case-insensitive on the header name; unfolds a continuation value onto one line joined by a single
 * space. Returns `undefined` if the header isn't present.
 */
export function extractHeader(raw: Buffer, name: string): string | undefined {
    const { headerText } = splitRawIntoHeaderAndBody(raw);
    const prefix: string = `${name.toLowerCase()}:`;
    for (const line of splitLogicalHeaderLines(headerText)) {
        if (line.toLowerCase().startsWith(prefix)) {
            return line
                .slice(prefix.length)
                .split(/\r\n[ \t]*/)
                .join(" ")
                .trim();
        }
    }
    return undefined;
}

/**
 * Like `extractHeader()`, but returns every occurrence of `name` rather than just the first - needed for a
 * header that can legitimately repeat (e.g. `Authentication-Results`, once per authenticating hop) or where
 * the mere presence of more than one occurrence is itself meaningful (e.g. `RapidMX-Key`'s own processing
 * rule: a message carrying more than one MUST have all of them ignored - a caller can't tell that happened
 * from `extractHeader()`'s single, first-match result alone).
 */
export function extractHeaders(raw: Buffer, name: string): string[] {
    const { headerText } = splitRawIntoHeaderAndBody(raw);
    const prefix: string = `${name.toLowerCase()}:`;
    const values: string[] = [];
    for (const line of splitLogicalHeaderLines(headerText)) {
        if (line.toLowerCase().startsWith(prefix)) {
            values.push(
                line
                    .slice(prefix.length)
                    .split(/\r\n[ \t]*/)
                    .join(" ")
                    .trim(),
            );
        }
    }
    return values;
}

/**
 * Strips quoted strings and (nested) comments out of a structured header value, so what is left is only the part a
 * mail client would interpret as address syntax. An unterminated quote/comment swallows the rest of the value.
 */
function stripQuotedStringsAndComments(value: string): string {
    let result: string = "";
    let inQuote: boolean = false;
    let commentDepth: number = 0;
    for (let i = 0; i < value.length; i++) {
        const ch: string = value[i];
        if (ch === "\\" && (inQuote || commentDepth > 0)) {
            i++;
            continue;
        }
        if (inQuote) {
            if (ch === '"') {
                inQuote = false;
                result += " ";
            }
            continue;
        }
        if (ch === "(") {
            commentDepth++;
            continue;
        }
        if (commentDepth > 0) {
            if (ch === ")") {
                commentDepth--;
                if (commentDepth === 0) {
                    result += " ";
                }
            }
            continue;
        }
        if (ch === '"') {
            inQuote = true;
            continue;
        }
        result += ch;
    }
    return result;
}

/**
 * Collects the text of every quoted string and comment in a structured header value (the counterpart of
 * `stripQuotedStringsAndComments()`) - where a display name or comment shows the reader text of the sender's choice.
 */
function quotedStringsAndComments(value: string): string[] {
    const parts: string[] = [];
    let current: string = "";
    let inQuote: boolean = false;
    let commentDepth: number = 0;
    for (let i = 0; i < value.length; i++) {
        const ch: string = value[i];
        if (ch === "\\" && (inQuote || commentDepth > 0)) {
            current += value[i + 1] ?? "";
            i++;
            continue;
        }
        if (inQuote) {
            if (ch === '"') {
                inQuote = false;
                parts.push(current);
                current = "";
            } else {
                current += ch;
            }
            continue;
        }
        if (ch === "(") {
            commentDepth++;
            current += commentDepth > 1 ? ch : "";
            continue;
        }
        if (commentDepth > 0) {
            if (ch === ")") {
                commentDepth--;
                if (commentDepth === 0) {
                    parts.push(current);
                    current = "";
                    continue;
                }
            }
            current += ch;
            continue;
        }
        if (ch === '"') {
            inQuote = true;
        }
    }
    if (inQuote || commentDepth > 0) {
        parts.push(current);
    }
    return parts;
}

/** The top-level header block unfolded into logical lines, with CRLF, LF *and* a bare CR all treated as line breaks -
 * the tolerant lexing every originator-header check here shares, so a header can't hide behind a line ending some
 * other parser would honor. Continuation lines are joined with a single space. */
function lexLogicalHeaderLines(raw: Buffer): string[] {
    const { headerText } = splitRawIntoHeaderAndBody(raw);
    const logical: string[] = [];
    for (const line of headerText.split(/\r\n|\n|\r/)) {
        if (/^[ \t]/.test(line) && logical.length > 0) {
            logical[logical.length - 1] += " " + line.trim();
        } else if (line.length > 0) {
            logical.push(line);
        }
    }
    return logical;
}

/** The raw (unfolded, trimmed) values of a message's top-level `From` and `Sender` headers. */
export interface OriginatorHeaders {
    from: string[];
    sender: string[];
}

/**
 * Every top-level `From` and `Sender` header value of `raw`, found exactly the way `checkOriginatorHeaders()` finds
 * them: header names case-insensitive, whitespace before the colon allowed (the obsolete `From :` form), folded
 * values unfolded, and a bare CR treated as a line break.
 */
export function extractOriginatorHeaders(raw: Buffer): OriginatorHeaders {
    const values: OriginatorHeaders = { from: [], sender: [] };
    for (const line of lexLogicalHeaderLines(raw)) {
        const match: RegExpMatchArray | null = line.match(/^(from|sender)[ \t]*:(.*)$/i);
        if (match) {
            values[match[1].toLowerCase() as "from" | "sender"].push(match[2].trim());
        }
    }
    return values;
}

/** Decodes RFC 2047 encoded words (B and Q) to UTF-8 text - enough to see what a display name shows the reader. */
function decodeEncodedWords(text: string): string {
    return text.replace(/=\?[^?]+\?([bBqQ])\?([^?]*)\?=/g, (_match, encoding: string, data: string) => {
        if (encoding.toUpperCase() === "B") {
            return Buffer.from(data, "base64").toString("utf8");
        }
        const bytes: Buffer = Buffer.from(
            data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
            "binary",
        );
        return bytes.toString("utf8");
    });
}

/** An `@`, or a look-alike a reader would take for one (fullwidth, small and other compatibility forms). */
const AT_SIGN_LIKE = /[@＠﹫]/;

/** Whether `text` (a raw header fragment, read as latin1 bytes) shows an address-like `@` once decoded. */
function showsAtSign(text: string): boolean {
    const asUtf8: string = Buffer.from(text, "binary").toString("utf8");
    return AT_SIGN_LIKE.test(decodeEncodedWords(asUtf8)) || AT_SIGN_LIKE.test(decodeEncodedWords(text));
}

/**
 * Whether any display name, group name or comment in one `From`/`Sender` header value contains an address-like `@`
 * (RFC 2047 encoded words decoded, look-alike `@` characters included): `"ceo@example.com" <me@example.com>` shows
 * the reader an address the sender doesn't own, though its real address is fine.
 */
export function hasAddressLikeDisplayName(value: string): boolean {
    if (quotedStringsAndComments(value).some(showsAtSign)) {
        return true;
    }
    const visit = (entries: { name?: string; group?: any[] }[]): boolean =>
        entries.some((entry) => (typeof entry.name === "string" && showsAtSign(entry.name)) || (Array.isArray(entry.group) && visit(entry.group)));
    return visit(addressparser(value));
}

/** One plain address: no display name, angle brackets, group, comment, list, quoting, control characters or whitespace. */
const PLAIN_ADDRESS_PATTERN = /^[^\s()<>@,;:\\"[\]]+@[^\s()<>@,;:\\"[\]]+$/;

/** RFC 5321's address length limit. */
const MAX_PLAIN_ADDRESS_LENGTH = 320;

/** Whether `value` holds a control character (C0 or DEL); a tab only counts when `tabCounts`. */
function hasControlCharacter(value: string, tabCounts: boolean): boolean {
    for (let i = 0; i < value.length; i++) {
        const code: number = value.charCodeAt(i);
        if ((code < 0x20 && (tabCounts || code !== 0x09)) || code === 0x7f) {
            return true;
        }
    }
    return false;
}

/** Whether `address` is exactly one plain address (`local@domain`, nothing around it), at most 320 characters - safe to
 * hand to a composer as one recipient, e.g. a meeting attendee or organizer. */
export function isPlainAddress(address: unknown): address is string {
    return (
        typeof address === "string" &&
        address.length <= MAX_PLAIN_ADDRESS_LENGTH &&
        !hasControlCharacter(address, true) &&
        PLAIN_ADDRESS_PATTERN.test(address)
    );
}

/**
 * `name` as a display name that's safe to put in front of one of our own addresses in a `From` (or an iCalendar `CN`)
 * this server composes: trimmed, or `undefined` - so the caller omits the name - when it isn't a string, is blank,
 * contains a line break or other control character, or shows an address-like `@` (look-alikes and RFC 2047 encoded
 * words included, the same rule as `hasAddressLikeDisplayName()`). A display name like `ceo@example.com` in front of a
 * real address shows the reader an address the sender doesn't own.
 */
export function safeDisplayName(name: unknown): string | undefined {
    if (typeof name !== "string" || hasControlCharacter(name, false)) {
        return undefined;
    }
    const clean: string = name.trim();
    if (clean.length === 0 || AT_SIGN_LIKE.test(clean) || AT_SIGN_LIKE.test(decodeEncodedWords(clean))) {
        return undefined;
    }
    return clean;
}

/** Options for `checkOriginatorHeaders()`. */
export interface OriginatorHeaderCheckOptions {
    /**
     * Also refuse a `From`/`Sender` whose display name, group name or comment contains an address
     * (`hasAddressLikeDisplayName()`). Every path that sends a user-composed message as one of a mailbox's addresses
     * should set it - the REST send path and `ScheduledSendJob` do, and so should protocol plugins (ActiveSync, MAPI).
     */
    rejectAddressLikeDisplayNames?: boolean;
}

/**
 * Refuses a raw RFC 5322 message whose originator headers name anyone other than an allowed sender. Every `From`
 * and `Sender` header in the top-level header block is checked - header names case-insensitively (including the
 * obsolete `From :` form with whitespace before the colon), folded values unfolded, and a bare CR treated as a line
 * break too, so a header can't be hidden from this scan behind a line ending another parser would honor. Returns a
 * refusal reason, or `undefined` if the message passes. Fails closed on:
 * - no `From` header, more than one `From` header, or more than one `Sender` header;
 * - a `From`/`Sender` value that yields no address at all (e.g. only an empty group);
 * - any parsed entry without an address (a malformed list, e.g. an unquoted display name containing a comma);
 * - any parsed address - group members included - that `isAllowed` rejects;
 * - any addr-spec-looking token outside quoted strings/comments that `isAllowed` rejects - covers the tolerant
 * parser recovering `<me@example.com> <other@example.com>` as one mailbox with the second as its "display name";
 * - with `options.rejectAddressLikeDisplayNames`, any display name, group name or comment containing an address.
 *
 * Quoted display names and RFC 2047 encoded words are never treated as addresses. `isAllowed` receives each address
 * exactly as parsed; normalize (e.g. lowercase) inside it.
 */
export function checkOriginatorHeaders(
    raw: Buffer,
    isAllowed: (address: string) => boolean,
    options: OriginatorHeaderCheckOptions = {},
): string | undefined {
    const values: OriginatorHeaders = extractOriginatorHeaders(raw);
    if (values.from.length === 0) {
        return "The message has no From header.";
    }
    if (values.from.length > 1) {
        return "The message has more than one From header.";
    }
    if (values.sender.length > 1) {
        return "The message has more than one Sender header.";
    }

    const refusal = (name: string): string => `The ${name} header names an address that is not one of the sending mailbox's own addresses.`;
    for (const [name, headerValues] of [
        ["From", values.from],
        ["Sender", values.sender],
    ] as [string, string[]][]) {
        for (const value of headerValues) {
            const parsed: { address?: string }[] = addressparser(value, { flatten: true });
            if (parsed.length === 0) {
                return `The ${name} header contains no address.`;
            }
            if (parsed.some((entry) => !entry.address || !isAllowed(entry.address))) {
                return refusal(name);
            }
            const tokens: string[] = stripQuotedStringsAndComments(value)
                .split(/[\s<>,;:]+/)
                .filter((token) => token.includes("@"));
            if (tokens.some((token) => !isAllowed(token))) {
                return refusal(name);
            }
            if (options.rejectAddressLikeDisplayNames && hasAddressLikeDisplayName(value)) {
                return `The ${name} header's display name or comment contains an address.`;
            }
        }
    }
    return undefined;
}

/**
 * The one address in `raw`'s `From` header, normalized (trimmed, lowercased) - or `undefined` unless there is exactly
 * one `From` header naming exactly one address (lexed like `checkOriginatorHeaders()`).
 */
export function singleFromAddress(raw: Buffer): string | undefined {
    const { from } = extractOriginatorHeaders(raw);
    if (from.length !== 1) {
        return undefined;
    }
    const parsed: { address?: string }[] = addressparser(from[0], { flatten: true });
    if (parsed.length !== 1 || typeof parsed[0].address !== "string" || !parsed[0].address.includes("@")) {
        return undefined;
    }
    return parsed[0].address.trim().toLowerCase();
}

/**
 * `raw`'s single `From` address (`singleFromAddress()`) when it's authenticated: the topmost `Authentication-Results`
 * stamped by `trustedAuthservId` (`topmostTrustedAuthenticationResults()`) reports a passing DKIM signature strictly
 * aligned with its domain (`hasAlignedPassingDkim()`). Otherwise `undefined`; always `undefined` when
 * `trustedAuthservId` is unset.
 */
export function verifiedFromAddress(raw: Buffer, trustedAuthservId: string): string | undefined {
    const from: string | undefined = singleFromAddress(raw);
    const domain: string | undefined = from?.slice(from.lastIndexOf("@") + 1);
    if (!from || !domain || !trustedAuthservId) {
        return undefined;
    }
    const results: string[] = topmostTrustedAuthenticationResults(extractHeaders(raw, "Authentication-Results"), trustedAuthservId);
    return hasAlignedPassingDkim(results, domain, trustedAuthservId) ? from : undefined;
}

/**
 * Headers never passed on in a copy of inbound mail relayed out again (distribution-list expansion, forward rules):
 * each makes a receiving system - this one included, when the copy comes back in - act on trust this server's
 * signature on the copy doesn't actually confer. Matched case-insensitively.
 */
export const RELAY_STRIPPED_HEADERS: readonly string[] = ["authentication-results", "rapidmx-key", "x-rapidmx-recall-of", "disposition-notification-to"];

/**
 * Conservative check for calendar content anywhere in `raw` - a `text/calendar`/`application/ics` content type, an
 * `.ics` file name (plain, quoted, RFC 2231 or RFC 2047 encoded) or a `BEGIN:VCALENDAR` line - so an iTIP
 * REQUEST/REPLY/CANCEL isn't relayed under a sender it can't be attributed to. Errs towards `true`.
 */
export function containsCalendarContent(raw: Buffer): boolean {
    const text: string = raw.toString("binary");
    if (/content-type[ \t]*:[ \t]*(?:\r\n|\n|\r)?[ \t]*(?:"?)(?:text\/calendar|application\/ics)/i.test(text) || /BEGIN[ \t]*:[ \t]*VCALENDAR/i.test(text)) {
        return true;
    }
    for (const line of text.split(/\r\n|\n|\r/)) {
        if (!/name/i.test(line)) {
            continue;
        }
        let decoded: string = decodeEncodedWords(line);
        try {
            decoded = decodeURIComponent(decoded.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
        } catch {
            // Not percent-decodable - checked as-is.
        }
        if (/\.ics\b/i.test(decoded)) {
            return true;
        }
    }
    return false;
}

/** Options for `prepareRelayCopy()`. */
export interface RelayCopyOptions {
    /** `mail:security:trusted_authserv_id` - see `verifiedFromAddress()`. */
    trustedAuthservId: string;
    /** Who the copy is sent as when its `From` isn't authenticated: the list, or the forwarding mailbox. */
    rewriteFrom: { address: string; name?: string };
    /** When rewriting `From`, also add `Reply-To: <original From>` if the message has no `Reply-To` of its own (a
     * forward - replies should still reach the original sender). A list sets its own `Reply-To` instead. */
    replyToOriginalFrom?: boolean;
}

/** A header value safe to emit on one line: CR/LF (and other control characters) removed. */
function singleLineHeaderValue(value: string): string {
    return Array.from(value)
        .filter((ch) => {
            const code: number = ch.charCodeAt(0);
            return code === 0x09 || (code >= 0x20 && code !== 0x7f);
        })
        .join("");
}

/** `name` as an RFC 5322 display name: a quoted string for ASCII, a UTF-8 B encoded word otherwise. */
function formatDisplayName(name: string): string {
    const clean: string = singleLineHeaderValue(name).trim();
    if (/^[\x20-\x7E]*$/.test(clean)) {
        return `"${clean.replace(/["\\]/g, "\\$&")}"`;
    }
    return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

/**
 * Builds the copy of an inbound message this server relays out again - to a distribution list's external members, or
 * to a mail filter rule's forward addresses - so the relay (which the MTA DKIM-signs as this server's domain) can't
 * launder a spoofed message into trusted mail. Shared by `BaseMailIngestRoute` and `ScanQueueJob.forwardByRule()`.
 *
 * - `RELAY_STRIPPED_HEADERS` are always removed.
 * - The original `From` is kept only when it's authenticated (`verifiedFromAddress()`). Otherwise - DMARC-style - it
 * becomes `options.rewriteFrom`, any `Sender` is dropped, the original value is kept in `X-Original-From`, and with
 * `options.replyToOriginalFrom` a `Reply-To` pointing at it is added when there's none.
 * - A message whose `From` isn't authenticated and that carries calendar content (`containsCalendarContent()`) isn't
 * relayed at all (`undefined`): an iTIP request, reply or cancel must never go out under an identity (the list's or
 * the mailbox's) that didn't write it.
 *
 * Header lines are otherwise kept byte-for-byte (folding included), so an authenticated sender's own signature can
 * still verify downstream unless it covered a stripped header.
 */
export function prepareRelayCopy(raw: Buffer, options: RelayCopyOptions): Buffer | undefined {
    const fromVerified: boolean = verifiedFromAddress(raw, options.trustedAuthservId) !== undefined;
    if (!fromVerified && containsCalendarContent(raw)) {
        return undefined;
    }
    const { headerText, bodyText } = splitRawIntoHeaderAndBody(raw);
    const lines: string[] = [];
    for (const line of headerText.split(/\r\n|\n|\r/)) {
        if (/^[ \t]/.test(line) && lines.length > 0) {
            lines[lines.length - 1] += "\r\n" + line;
        } else if (line.length > 0) {
            lines.push(line);
        }
    }
    const nameOf = (line: string): string => (line.match(/^([^:\s]*)[ \t]*:/)?.[1] ?? "").toLowerCase();
    const originalFrom: string[] = extractOriginatorHeaders(raw).from;
    const hasReplyTo: boolean = lines.some((line) => nameOf(line) === "reply-to");

    const kept: string[] = lines.filter((line) => {
        const name: string = nameOf(line);
        if (RELAY_STRIPPED_HEADERS.includes(name)) {
            return false;
        }
        return fromVerified || (name !== "from" && name !== "sender" && name !== "x-original-from");
    });
    const added: string[] = [];
    if (!fromVerified) {
        const address: string = singleLineHeaderValue(options.rewriteFrom.address).replace(/[<>\s]/g, "");
        const name: string | undefined = safeDisplayName(options.rewriteFrom.name);
        added.push(`From: ${name ? `${formatDisplayName(name)} ` : ""}<${address}>`);
        if (originalFrom.length > 0) {
            const original: string = singleLineHeaderValue(originalFrom.join(", "));
            added.push(`X-Original-From: ${original}`);
            if (options.replyToOriginalFrom && !hasReplyTo) {
                added.push(`Reply-To: ${original}`);
            }
        }
    }
    return Buffer.from([...added, ...kept].join("\r\n") + "\r\n\r\n" + bodyText, "binary");
}

/**
 * Splits `raw` into its header block/body, filters the header block's logical lines through
 * `filterLine` (return `false` to drop a header), then rebuilds the message with `newHeaders` prepended
 * ahead of the surviving ones - headers are order-independent, so prepending is always safe. Shared by
 * `rewriteHeadersForList()` (drops `Reply-To`, adds list headers) and `prependHeaders()` (drops nothing,
 * only adds).
 */
function rebuildWithHeaders(
    raw: Buffer,
    newHeaders: string[],
    filterLine: (line: string) => boolean = () => true,
): Buffer {
    const { headerText, bodyText } = splitRawIntoHeaderAndBody(raw);
    const keptLines: string[] = splitLogicalHeaderLines(headerText).filter(filterLine);
    const rebuilt: string = [...newHeaders, ...keptLines].join("\r\n") + "\r\n\r\n" + bodyText;
    return Buffer.from(rebuilt, "binary");
}

/**
 * Produces a copy of `raw` with each of `headers` prepended as a new top-level header line - no existing
 * header is removed or modified (only addition is supported; see `TransportRuleUtils`'s `add_header`
 * action). `name`/`value` are defensively stripped of embedded CR/LF (an admin-controlled rule
 * configuration value ending up as a raw header value must not be able to inject an extra header line).
 */
export function prependHeaders(raw: Buffer, headers: { name: string; value: string }[]): Buffer {
    const newHeaders: string[] = headers.map(
        ({ name, value }) => `${name.replace(/[\r\n]/g, "")}: ${value.replace(/[\r\n]/g, "")}`,
    );
    return rebuildWithHeaders(raw, newHeaders);
}

/**
 * Produces a copy of `raw` with any existing `Reply-To` header (and its folded continuation lines)
 * dropped, then `newHeaders` prepended. Shared low-level rebuild step for `rewriteHeadersForList()`.
 */
export function rebuildDroppingReplyTo(raw: Buffer, newHeaders: string[]): Buffer {
    return rebuildWithHeaders(raw, newHeaders, (line) => !line.toLowerCase().startsWith("reply-to:"));
}
