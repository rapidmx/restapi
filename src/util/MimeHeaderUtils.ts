///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

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
