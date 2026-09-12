///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Builds and parses the Mbox mailbox format - a simple, fully-documented, universally-supported plain-text
 * concatenation of RFC 5322 messages (Thunderbird, Apple Mail, and Gmail Takeout all read/write it), used by
 * `DataExportJob`/`MailboxImportJob` for GDPR-portability export/import. Deliberately NOT PST: no free/open
 * Node library can write valid PST bytes (confirmed via research before choosing this format, not assumed) -
 * only paid SDKs like Aspose.Email can, and this repo avoids vendor-encumbered dependencies where a free
 * alternative meets the actual need. Mbox meets it; only import (reading) supports PST, via the separate
 * `pst-extractor` dependency in `MailboxImportJob` - that side has a real free option.
 *
 * Implements the classic "mboxo" escaping convention (any body line beginning with literal "From " is
 * prefixed with "> ", unconditionally on export; the reverse strip runs on import) rather than the stricter
 * "mboxrd" variant (which tracks existing leading `>`s to escape only what's genuinely ambiguous). mboxo is
 * simpler and universally read correctly by every mainstream client's importer; its known, well-documented
 * ambiguity - a body that already contained a literal "> From " line before export is indistinguishable
 * from an escaped "From " line on import, so the two can't both round-trip byte-for-byte - is the same
 * accepted limitation every "good enough" mbox exporter in the world carries, not a bug specific to this
 * implementation.
 */

/** The separator line mbox uses ahead of each message's own raw content - `asctime()`-style, matching the
 * format every mbox reader expects (`Www Mmm dd hh:mm:ss yyyy`, always UTC/GMT here since this is a stored
 * server-side timestamp, not a locale-sensitive display value). */
function formatAsctime(date: Date): string {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const day = days[date.getUTCDay()];
    const month = months[date.getUTCMonth()];
    const dayOfMonth = date.getUTCDate().toString().padStart(2, " ");
    const time = [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()].map((n) => n.toString().padStart(2, "0")).join(":");
    return `${day} ${month} ${dayOfMonth} ${time} ${date.getUTCFullYear()}`;
}

/**
 * Formats one message's already-raw RFC 5322 source (`Message.bodyBlobKey`'s content, unmodified since
 * ingestion/send) into an mbox entry: the `From <addr> <asctime>` separator line, the message itself with
 * every body line starting with "From " escaped to "> From ", and a trailing blank line. Operates on the raw
 * bytes as `latin1` (a lossless single-byte round-trip through `Buffer`/`string`) rather than `utf-8`, since
 * a MIME message's body may carry non-UTF-8 bytes (base64/quoted-printable-encoded attachments, arbitrary
 * charsets) that `utf-8` decoding would corrupt.
 */
export function buildMboxEntry(rawMime: Buffer, fromAddress: string, date: Date): Buffer {
    const separator = `From ${fromAddress || "MAILER-DAEMON"} ${formatAsctime(date)}\n`;
    const escapedBody = rawMime.toString("latin1").replace(/^From /gm, "> From ");
    return Buffer.from(separator + escapedBody + "\n", "latin1");
}

/**
 * Splits a complete mbox file's content back into each message's raw RFC 5322 source, reversing
 * `buildMboxEntry()`'s own escaping. Every `From ` separator line - and only a genuine separator line, never
 * an escaped `> From ` one - starts a new message.
 */
export function parseMbox(mbox: Buffer): Buffer[] {
    const text = mbox.toString("latin1");
    if (text.length === 0) {
        return [];
    }
    // Split on a `From ` line that begins the string or immediately follows a newline - the same boundary
    // `buildMboxEntry()`'s separator always occupies, never matching an escaped `> From ` body line since
    // that one has a `>` immediately before `From` with no intervening newline.
    const parts = text.split(/(?:^|\n)From [^\n]*\n/);
    // `split()`'s first element is whatever precedes the first separator - empty for a well-formed mbox file
    // (which always starts with one), so drop it; a real leading fragment (a malformed file) is intentionally
    // discarded rather than mistaken for a message with no separator of its own.
    const messages = parts.slice(1);
    return messages.map((entry) => {
        // Drop exactly the one trailing blank-line separator `buildMboxEntry()` adds between messages -
        // every entry but the very last one already ends in `\n\n` from the newline the split regex itself
        // consumed plus this one; the last entry may or may not, depending on whether the source file ended
        // with a trailing blank line, so this only strips a trailing `\n` when one is actually present.
        const unescaped = entry.replace(/^> From /gm, "From ");
        const trimmed = unescaped.endsWith("\n") ? unescaped.slice(0, -1) : unescaped;
        return Buffer.from(trimmed, "latin1");
    });
}
