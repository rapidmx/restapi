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

/** Reverses `buildMboxEntry()`'s mboxo escaping and (for the LAST message only - see `parseMbox()`'s own doc
 * comment) strips the one trailing separator-blank-line byte that isn't actually part of the original raw
 * content. */
function finalizeMboxMessage(raw: string, isLast: boolean): Buffer {
    const unescaped = raw.replace(/^> From /gm, "From ");
    const trimmed = isLast && unescaped.endsWith("\n") ? unescaped.slice(0, -1) : unescaped;
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
 * Incremental-parsing note: the original (whole-buffer) implementation matched a separator via
 * `/(?:^|\n)From [^\n]*\n/` - true file start OR a preceding newline. Streaming a growing, periodically-
 * trimmed buffer means "true file start" can no longer be told apart from "start of whatever's left after
 * trimming" by position alone, so a single synthetic leading `"\n"` is prepended once, up front, unifying
 * both cases into one plain `/\nFrom [^\n]*\n/` match - the real file start behaves exactly like any other
 * `\n`-preceded separator from then on, with nothing further to special-case.
 */
export async function* parseMbox(mboxFilePath: string): AsyncGenerator<Buffer> {
    let text = "\n";
    // Offset into `text` where the in-progress (not yet fully seen) message's own content begins - `undefined`
    // until the first separator is found (a leading fragment before it, i.e. a malformed file, is discarded,
    // matching the original implementation's `parts.slice(1)`).
    let messageStart: number | undefined;
    const separatorPattern = /\nFrom [^\n]*\n/g;

    function* drainCompleteMessages(): Generator<Buffer> {
        for (;;) {
            separatorPattern.lastIndex = messageStart ?? 0;
            const match = separatorPattern.exec(text);
            if (!match) {
                return;
            }
            if (messageStart === undefined) {
                // The very first separator - nothing to emit yet, just record where its message begins.
                messageStart = match.index + match[0].length;
                continue;
            }
            yield finalizeMboxMessage(text.slice(messageStart, match.index), false);
            messageStart = match.index + match[0].length;
            // Compact away everything already consumed, so `text` never grows past roughly one message's
            // worth (plus whatever's been read ahead so far) rather than the whole file.
            text = text.slice(messageStart);
            messageStart = 0;
        }
    }

    for await (const chunk of createReadStream(mboxFilePath)) {
        text += (chunk as Buffer).toString("latin1");
        yield* drainCompleteMessages();
    }
    // EOF: whatever remains from the last found separator onward is the final message - the only one whose
    // own trailing separator-blank-line byte was never consumed by a following separator match, so it alone
    // needs it stripped back off (see `finalizeMboxMessage()`). A file with no separator at all (malformed,
    // or genuinely empty) leaves `messageStart` `undefined` here, yielding nothing - matching the original
    // implementation's empty-array result for the same inputs.
    if (messageStart !== undefined) {
        yield finalizeMboxMessage(text.slice(messageStart), true);
    }
}
