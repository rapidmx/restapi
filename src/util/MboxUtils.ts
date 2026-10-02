///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createReadStream } from "fs";

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
    // CR/LF-stripped before it's ever interpolated into the separator line - matches
    // `BaseAttachmentRoute.ts`'s identical `sanitizeFilename()` convention for any other value that ends up
    // built into a structural line. Without this, an embedded newline in `fromAddress` (a message's own
    // `From:` header, not necessarily sanitized upstream) would inject a fake `From ` separator line,
    // corrupting `parseMbox()`'s re-parsing of this bundle - and potentially every later reader's - into
    // the wrong message boundaries.
    const safeFromAddress = fromAddress.replace(/[\r\n]/g, "");
    const separator = `From ${safeFromAddress || "MAILER-DAEMON"} ${formatAsctime(date)}\n`;
    const escapedBody = rawMime.toString("latin1").replace(/^From /gm, "> From ");
    return Buffer.from(separator + escapedBody + "\n", "latin1");
}

/** The largest message `parseMbox()` buffers by default: a file with a message beyond it (or one endless line) is refused instead of
 * being read into memory whole. */
export const MAX_MBOX_MESSAGE_BYTES = 100 * 1024 * 1024;

/** The longest `From ` line `parseMbox()` takes as a separator; a longer one is message text. */
const MAX_MBOX_SEPARATOR_LINE = 4096;

/** Reverses `buildMboxEntry()`'s mboxo escaping and (for the LAST message only - see `parseMbox()`'s own doc
 * comment) strips the one trailing separator-blank-line byte that isn't actually part of the original raw
 * content. */
function finalizeMboxMessage(raw: string): Buffer {
    const unescaped = raw.replace(/^> From /gm, "From ");
    const trimmed = unescaped.endsWith("\n") ? unescaped.slice(0, -1) : unescaped;
    return Buffer.from(trimmed, "latin1");
}

/**
 * Splits a complete mbox file back into each message's raw RFC 5322 source, reversing `buildMboxEntry()`'s
 * own escaping - reading and yielding one message at a time (an `AsyncGenerator`, consumed via `for await`)
 * rather than loading the whole file into one `Buffer` and materializing every message simultaneously, so a
 * multi-GB mbox export never needs more memory resident at once than roughly its single largest message (see
 * `MailboxImportJob.resolveLocalSourcePath()` for how a `mboxFilePath` is obtained from whatever `BlobStore`
 * actually holds it). Every `From ` separator line - and only a genuine separator line, never an escaped
 * `> From ` one - starts a new message.
 *
 * Incremental-parsing note: the file is read line by line as it streams in, so the time is linear in its size whatever the shape of
 * its lines. A message larger than `maxMessageBytes` (default `MAX_MBOX_MESSAGE_BYTES`) makes the generator throw instead of
 * buffering it. A `From ` line is a separator unless it directly follows another separator (nothing to end a message with) or is
 * longer than `MAX_MBOX_SEPARATOR_LINE` - the same lines the original whole-buffer `/(?:^|\n)From [^\n]*\n/` match took.
 */
export async function* parseMbox(mboxFilePath: string, maxMessageBytes: number = MAX_MBOX_MESSAGE_BYTES): AsyncGenerator<Buffer> {
    // The text of the message being read, in pieces joined only once it ends, and its size so far. A line is looked at once, as it
    // arrives: only the start of a line that could be a separator is held back (`pending`, at most `MAX_MBOX_SEPARATOR_LINE`
    // characters), and the rest of a line - however long - goes straight into `pieces`. The time is linear in the size of the file,
    // whatever the shape of its lines.
    let pieces: string[] = [];
    let size = 0;
    // Whether a separator has been found - `false` until then (a leading fragment before it, i.e. a malformed file, is
    // discarded, matching the original implementation's `parts.slice(1)`).
    let started = false;
    // The start of the line being read, while it could still turn out to be a separator.
    let pending = "";
    // Whether the line being read is part-way through, and known not to be a separator: the rest of it is message text.
    let inLine = false;

    function addText(text: string): void {
        if (!started || text.length === 0) {
            return;
        }
        size += text.length;
        if (size > maxMessageBytes) {
            throw new Error(`The mbox file holds a message larger than ${maxMessageBytes} bytes.`);
        }
        pieces.push(text);
    }

    /** A separator line: ends the message in progress (if any text has followed the previous separator) and starts the next. */
    function* separator(): Generator<Buffer> {
        if (started && size === 0) {
            // Directly after another separator line there is no line break left to start one with: it is text, as it always was.
            addText(pending + "\n");
            return;
        }
        if (started) {
            // Everything before it, its own leading line break excluded.
            yield finalizeMboxMessage(pieces.join(""));
        }
        pieces = [];
        size = 0;
        started = true;
    }

    for await (const chunk of createReadStream(mboxFilePath)) {
        const data: string = (chunk as Buffer).toString("latin1");
        let pos = 0;
        while (pos < data.length) {
            if (inLine) {
                const lineEnd: number = data.indexOf("\n", pos);
                const next: number = lineEnd < 0 ? data.length : lineEnd + 1;
                addText(data.slice(pos, next));
                inLine = lineEnd < 0;
                pos = next;
                continue;
            }
            const lineEnd: number = data.indexOf("\n", pos);
            pending += data.slice(pos, lineEnd < 0 ? data.length : lineEnd);
            if (lineEnd < 0) {
                pos = data.length;
                const couldBeSeparator: boolean = pending.startsWith("From ")
                    ? pending.length <= MAX_MBOX_SEPARATOR_LINE
                    : pending.length < 5 && "From ".startsWith(pending);
                if (!couldBeSeparator) {
                    addText(pending);
                    pending = "";
                    inLine = true;
                }
                continue;
            }
            pos = lineEnd + 1;
            if (pending.startsWith("From ") && pending.length <= MAX_MBOX_SEPARATOR_LINE) {
                yield* separator();
            } else {
                addText(pending + "\n");
            }
            pending = "";
        }
    }
    // EOF: a line that never ended is text, whatever it started with.
    addText(pending);
    // Whatever remains from the last found separator onward is the final message - the only one whose
    // own trailing separator-blank-line byte was never consumed by a following separator match, so it alone
    // needs it stripped back off (see `finalizeMboxMessage()`). A file with no separator at all (malformed,
    // or genuinely empty) leaves `started` false here, yielding nothing - matching the original
    // implementation's empty-array result for the same inputs.
    if (started) {
        yield finalizeMboxMessage(pieces.join(""));
    }
}
