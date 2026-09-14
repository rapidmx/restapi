///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

import addressparser from "nodemailer/lib/addressparser/index.js";

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
 * parser recovering `<me@example.com> <other@example.com>` as one mailbox with the second as its "display name".
 *
 * Quoted display names and RFC 2047 encoded words are never treated as addresses. `isAllowed` receives each address
 * exactly as parsed; normalize (e.g. lowercase) inside it.
 */
export function checkOriginatorHeaders(raw: Buffer, isAllowed: (address: string) => boolean): string | undefined {
    const { headerText } = splitRawIntoHeaderAndBody(raw);
    const logical: string[] = [];
    for (const line of headerText.split(/\r\n|\n|\r/)) {
        if (/^[ \t]/.test(line) && logical.length > 0) {
            logical[logical.length - 1] += " " + line.trim();
        } else if (line.length > 0) {
            logical.push(line);
        }
    }

    const values: { from: string[]; sender: string[] } = { from: [], sender: [] };
    for (const line of logical) {
        const match: RegExpMatchArray | null = line.match(/^(from|sender)[ \t]*:(.*)$/i);
        if (match) {
            values[match[1].toLowerCase() as "from" | "sender"].push(match[2].trim());
        }
    }
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
        }
    }
    return undefined;
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
