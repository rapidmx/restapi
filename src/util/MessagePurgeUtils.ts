///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ModelUtils } from "@rapidrest/service-core";
import type { BlobStore } from "../blob/BlobStore.js";
import { Message } from "../models/types.js";
import { deleteBlobsIfUnreferenced, messageBlobReferenceSources, MessageBlobRepos } from "./BlobReferenceUtils.js";
import { retainedBodyBlobKeysOf } from "./DraftBodyRetentionUtils.js";
import { findPagesByUid } from "./MailboxContentUtils.js";

/** The most `Attachment` rows one purge batch (at most 500 messages) collects. A batch with more leaves the rest for the caller to
 * find (they stay, orphaned from a deleted message, and are logged) rather than holding an unbounded list in memory. */
export const MAX_PURGE_ATTACHMENT_ROWS = 20_000;

/** What `collectMessagePurge()`/`finishMessagePurge()` work with: `repos.attachmentRepo` is the one the purge reads and deletes, and
 * every repository present is also a blob reference source (see `messageBlobReferenceSources()`; the sources are derived from it
 * per call). */
export interface MessagePurgeContext {
    /** Absent: nothing can be deleted from the store, so only the rows are purged. */
    blobStore?: BlobStore;
    /** Every repository a message's blobs can be shared with. The message and attachment ones are always needed;
     * `quarantineEntryRepo` and `ingestQueueEntryRepo` are what keep a raw message that another recipient's queued or
     * quarantined copy still points at, so a purge without BOTH deletes no message-level blob at all. */
    repos: MessageBlobRepos;
    logger?: any;
}

/** What `collectMessagePurge()` found for `finishMessagePurge()` to remove, once the messages are gone. */
export interface PreparedMessagePurge {
    /** The uids of the messages' `Attachment` rows. */
    attachmentUids: string[];
    /** Every blob key the messages and their attachments name, de-duplicated - not yet checked for other references. */
    blobKeys: string[];
    /** `true` when the attachment list was cut at `MAX_PURGE_ATTACHMENT_ROWS`. */
    truncated: boolean;
}

/**
 * Finds what a permanent delete of `messages` (at most a few hundred - a batch) must also remove: their `Attachment` rows (paged by
 * `messageUid`, at most `MAX_PURGE_ATTACHMENT_ROWS`) and the blob keys the messages and attachments name - the raw message, the
 * sanitized HTML, superseded draft bodies kept for a hold, an attachment's content and its extracted text. Nothing is deleted yet: call
 * it BEFORE deleting the messages, and `finishMessagePurge()` after. The keys are only candidates, a blob other rows still reference
 * (inbound mail is stored once for every recipient, and a mail filter rule's copies share theirs) is kept by `finishMessagePurge()`.
 */
export async function collectMessagePurge(ctx: MessagePurgeContext, messages: Message[]): Promise<PreparedMessagePurge> {
    const keys: Set<string> = new Set();
    const sharesRaw: boolean = !!ctx.repos.quarantineEntryRepo && !!ctx.repos.ingestQueueEntryRepo;
    for (const message of messages) {
        // Without the two repositories that hold the other holders of a raw message, whether it may go can't be told: it stays.
        if (sharesRaw) {
            for (const key of [message.bodyBlobKey, message.sanitizedHtmlBlobKey, ...retainedBodyBlobKeysOf(message)]) {
                if (typeof key === "string" && key.length > 0) {
                    keys.add(key);
                }
            }
        }
    }
    const attachmentUids: string[] = [];
    let truncated: boolean = false;
    if (ctx.repos.attachmentRepo && messages.length > 0) {
        const criteria: Record<string, any> = { messageUid: ModelUtils.literal(messages.map((message) => message.uid), "in") };
        collecting: for await (const page of findPagesByUid<any>(ctx.repos.attachmentRepo, criteria)) {
            for (const attachment of page) {
                if (attachmentUids.length >= MAX_PURGE_ATTACHMENT_ROWS) {
                    truncated = true;
                    break collecting;
                }
                attachmentUids.push(attachment.uid);
                for (const key of [attachment.blobKey, attachment.extractedTextBlobKey]) {
                    if (typeof key === "string" && key.length > 0) {
                        keys.add(key);
                    }
                }
            }
        }
    }
    return { attachmentUids, blobKeys: [...keys], truncated };
}

/**
 * Removes what `collectMessagePurge()` found, AFTER the messages themselves are gone: each `Attachment` row, then each blob key no
 * remaining row references (`deleteBlobsIfUnreferenced()`, the same rule `RetentionEnforcementJob` applies - a blob another message,
 * an attachment, a quarantine entry or a still-undelivered ingest entry names, soft-deleted rows included, is never deleted).
 *
 * Best-effort by design: the messages are already deleted, so a row or blob that can't be removed is logged and left, never thrown -
 * a blob-store outage must not turn a delete that happened into an error. A blob left that way is an orphan nothing references.
 */
export async function finishMessagePurge(ctx: MessagePurgeContext, prepared: PreparedMessagePurge): Promise<void> {
    if (prepared.truncated) {
        ctx.logger?.warn(`Permanent message delete: more than ${MAX_PURGE_ATTACHMENT_ROWS} attachments, the rest were left behind.`);
    }
    if (prepared.attachmentUids.length > 0 && ctx.repos.attachmentRepo) {
        for (const uid of prepared.attachmentUids) {
            try {
                await ctx.repos.attachmentRepo.delete(uid, { ignoreACL: true, purge: true });
            } catch (err: any) {
                ctx.logger?.warn(`Permanent message delete: failed to delete attachment ${uid}: ${err?.message}`);
            }
        }
    }
    if (!ctx.blobStore) {
        return;
    }
    const sources = messageBlobReferenceSources(ctx.repos);
    for (const key of prepared.blobKeys) {
        try {
            await deleteBlobsIfUnreferenced(ctx.blobStore, sources, [key]);
        } catch (err: any) {
            ctx.logger?.warn(`Permanent message delete: failed to delete blob ${key}: ${err?.message}`);
        }
    }
}
