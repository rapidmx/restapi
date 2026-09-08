///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DistributionList } from "../models/types.js";

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
 * Produces a copy of `raw` rewritten for distribution-list delivery: any existing `Reply-To` header (and its
 * folded continuation lines) is dropped, then `Reply-To`, `List-Id` (RFC 2919), and a mailto-based
 * `List-Unsubscribe` (RFC 2369) are prepended - headers are order-independent, so prepending is safe. Applied
 * once per list match and shared by both the internal blob copy and every external relay copy - see
 * `BaseMailIngestRoute.deliver()`.
 */
export function rewriteHeadersForList(raw: Buffer, list: DistributionList): Buffer {
    const { headerText, bodyText } = splitRawIntoHeaderAndBody(raw);
    const keptLines: string[] = splitLogicalHeaderLines(headerText).filter(
        (line) => !line.toLowerCase().startsWith("reply-to:"),
    );

    // Defensive against header injection via an admin-controlled field ending up in a header value.
    const safeName: string = list.name.replace(/[\r\n]/g, "");
    const address: string = list.primarySmtpAddress.replace(/[\r\n]/g, "");
    const listIdHost: string = address.includes("@") ? address.replace("@", ".") : address;

    const newHeaders: string[] = [
        `Reply-To: ${address}`,
        `List-Id: ${safeName} <${listIdHost}>`,
        `List-Unsubscribe: <mailto:${address}?subject=unsubscribe>`,
    ];

    const rebuilt: string = [...newHeaders, ...keptLines].join("\r\n") + "\r\n\r\n" + bodyText;
    return Buffer.from(rebuilt, "binary");
}
