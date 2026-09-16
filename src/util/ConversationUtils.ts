///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { createHash } from "crypto";
import { ModelUtils } from "@rapidrest/service-core";

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

/**
 * The most ancestors `conversationAncestorIds()` reports, and so the widest `messageId IN (...)` a threading
 * lookup ever issues. A `References` chain is unbounded in principle (a sender controls it), and every entry
 * costs one more term in that query.
 */
export const MAX_CONVERSATION_ANCESTORS: number = 20;

/**
 * The `Message-ID`s of the messages this one is a reply to, nearest ancestor first: `inReplyTo` (the direct
 * parent), then `references` reversed (RFC 5322 lists them oldest-first, so the last entry is the closest
 * ancestor). Deduplicated, bounded to `MAX_CONVERSATION_ANCESTORS`, and each value bounded exactly as it is
 * stored on `Message.messageId` (`boundIndexedValue()`), so an equality lookup with one of them matches.
 */
export function conversationAncestorIds(references: string[], inReplyTo?: string): string[] {
    const ancestors: string[] = [];
    const seen: Set<string> = new Set();
    for (const candidate of [inReplyTo, ...[...references].reverse()]) {
        const trimmed: string = typeof candidate === "string" ? candidate.trim() : "";
        if (!trimmed) {
            continue;
        }
        const bounded: string = boundIndexedValue(trimmed);
        if (seen.has(bounded)) {
            continue;
        }
        seen.add(bounded);
        ancestors.push(bounded);
        if (ancestors.length >= MAX_CONVERSATION_ANCESTORS) {
            break;
        }
    }
    return ancestors;
}

/** The part of a message repository `findThreadConversationId()` needs - `RecoverableRepoUtils`/`RepoUtils` both
 * satisfy it, so neither this module nor its callers depend on a concrete backend. */
export interface ConversationMessageFinder {
    find(query: any, options?: any): Promise<{ messageId?: string; conversationId?: string }[]>;
}

/**
 * The `conversationId` a mailbox already holds for any of `ancestorMessageIds`, nearest ancestor first, or
 * `undefined` when it holds none of them. One indexed `messageId IN (...)` query per delivered/sent message.
 *
 * This is what makes a chain deeper than one reply thread on a client that sets only `In-Reply-To` and no
 * `References`: without it, the third message of a chain would derive its parent's `Message-ID` as its own
 * conversation instead of the thread's root. It is also what keeps a conversation stable when the root of the
 * thread is no longer reachable from a later reply's own headers.
 */
export async function findThreadConversationId(
    repo: ConversationMessageFinder,
    mailboxUid: string,
    ancestorMessageIds: string[],
): Promise<string | undefined> {
    if (ancestorMessageIds.length === 0) {
        return undefined;
    }
    const rows = await repo.find(
        {
            mailboxUid: ModelUtils.literal(mailboxUid),
            messageId: ModelUtils.literal(ancestorMessageIds, "in"),
            limit: MAX_CONVERSATION_ANCESTORS,
        } as any,
        { ignoreACL: true, limit: MAX_CONVERSATION_ANCESTORS },
    );
    for (const ancestor of ancestorMessageIds) {
        const match = rows.find((row) => row.messageId === ancestor && !!row.conversationId);
        if (match) {
            return match.conversationId;
        }
    }
    return undefined;
}

/**
 * `deriveConversationId()`, but first asking `lookup` whether this mailbox already holds one of this message's
 * ancestors (`conversationAncestorIds()`) and, if so, joining that message's conversation. Only when it holds
 * none of them - the thread's other messages were never delivered here, or this message is a reply to nothing -
 * does the header-only derivation decide, so a message with neither header still starts its own conversation.
 *
 * Every copy of a thread in one mailbox therefore ends up with the same `conversationId`: the sender's own Sent
 * Items copy joins the conversation the message it replies to is already in, and each recipient's delivered copy
 * joins the one their own copy of the parent is in.
 */
export async function resolveConversationId(
    references: string[],
    inReplyTo: string | undefined,
    messageId: string,
    lookup: (ancestorMessageIds: string[]) => Promise<string | undefined>,
): Promise<string> {
    const ancestors: string[] = conversationAncestorIds(references, inReplyTo);
    if (ancestors.length > 0) {
        const existing: string | undefined = await lookup(ancestors);
        if (existing) {
            return boundIndexedValue(existing);
        }
    }
    return deriveConversationId(references, inReplyTo, messageId);
}
