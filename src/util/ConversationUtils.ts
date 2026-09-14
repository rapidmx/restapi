///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createHash } from "crypto";

/**
 * The longest value `boundIndexedValue()` stores verbatim. Matches the SQL backend's plain string column
 * (`varchar(255)` on MySQL/MariaDB, where strict mode rejects a longer value outright), and keeps an indexed key
 * far below Postgres's ~2.7 KB B-tree entry limit and MySQL's 3072-byte index key limit (255 utf8mb4 characters is
 * at most 1020 bytes).
 */
export const MAX_INDEXED_VALUE_LENGTH: number = 255;

/**
 * Returns `value` unchanged when it's at most `MAX_INDEXED_VALUE_LENGTH` characters, otherwise
 * `sha256:<64 hex digits>` of its UTF-8 bytes.
 *
 * Used for indexed, equality-matched identifiers that come from untrusted mail/calendar data - `Message.messageId`,
 * `Message.conversationId` and `CalendarEvent.icalUid` - which a sender can make arbitrarily long. Storing them
 * verbatim would fail the insert on MySQL/MariaDB (and past ~2.7 KB on Postgres, in the index), losing the message.
 * The result is deterministic and idempotent (`boundIndexedValue(boundIndexedValue(x)) === boundIndexedValue(x)`),
 * so an equality lookup still finds the row as long as the lookup value goes through this function too. Real-world
 * identifiers are far shorter than the limit and are never changed.
 *
 * @param value The identifier to bound. `null`/`undefined` are returned as-is.
 */
export function boundIndexedValue<T extends string | null | undefined>(value: T): T {
    if (typeof value !== "string" || value.length <= MAX_INDEXED_VALUE_LENGTH) {
        return value;
    }
    return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as T;
}

/**
 * Derives the stable identifier (`Message.conversationId`) that groups a message with the rest of its
 * RFC 5322/2822 thread: the thread's root `Message-ID` is the oldest ancestor named in `references`
 * (RFC 5322 lists them oldest-first), falling back to `inReplyTo` (a client that sets only `In-Reply-To`,
 * not the full `References` chain), falling back to the message's own `messageId` when it has neither -
 * it starts a new conversation. Pure and side-effect-free so both the ingest path
 * (`ScanQueueJob.deliverMessage()`) and the send path (`MailSendUtils.scanAndRelay()`) can share it.
 *
 * The result goes through `boundIndexedValue()` - the same bounding `Message` applies to `messageId` and
 * `conversationId` when constructed - so a reply to a message with an over-long `Message-ID` still lands in that
 * message's conversation, and a `conversationId` lookup with this function's result matches the stored value.
 */
export function deriveConversationId(references: string[], inReplyTo: string | undefined, messageId: string): string {
    return boundIndexedValue(references[0] ?? inReplyTo ?? messageId);
}
