///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ObjectFactory } from "@rapidrest/core";
import { RepoUtils } from "@rapidrest/service-core";
import type { BlobStore } from "../blob/BlobStore.js";
import { IngestStatus } from "../models/types.js";

/**
 * One entity type whose rows can point at a shared `BlobStore` key, and the fields that hold those keys.
 * `extraCriteria` narrows which rows count as a live reference (e.g. an `IngestQueueEntry` that has already been
 * delivered no longer needs its raw blob - the delivered `Message` row is what references it from then on).
 */
export interface BlobReferenceSource {
    entityClass: any;
    fields: string[];
    extraCriteria?: Record<string, any>;
}

/** The entity classes a message's content blobs can be shared between. Any may be omitted (a job that doesn't
 * know a class simply can't count its references - pass every one it has). */
export interface MessageBlobClasses {
    messageClass?: any;
    attachmentClass?: any;
    quarantineEntryClass?: any;
    ingestQueueEntryClass?: any;
}

/**
 * The reference sources for message content. Inbound mail is stored once and shared: `BaseMailIngestRoute.deliver()`
 * writes one raw blob per SMTP transaction that every recipient mailbox's `IngestQueueEntry` points at, and
 * `ScanQueueJob` then files that same key as `Message.bodyBlobKey` (plus a mail filter rule's copies), as a
 * `QuarantineEntry.rawBlobKey`, and shares attachment/sanitized-HTML blobs between a message and its rule copies.
 * The same key can therefore appear in any of these fields, across mailboxes.
 */
export function messageBlobReferenceSources(classes: MessageBlobClasses): BlobReferenceSource[] {
    const sources: BlobReferenceSource[] = [];
    if (classes.messageClass) {
        sources.push({ entityClass: classes.messageClass, fields: ["bodyBlobKey", "sanitizedHtmlBlobKey"] });
    }
    if (classes.attachmentClass) {
        sources.push({ entityClass: classes.attachmentClass, fields: ["blobKey", "extractedTextBlobKey"] });
    }
    if (classes.quarantineEntryClass) {
        sources.push({ entityClass: classes.quarantineEntryClass, fields: ["rawBlobKey"] });
    }
    if (classes.ingestQueueEntryClass) {
        sources.push({
            entityClass: classes.ingestQueueEntryClass,
            fields: ["rawBlobKey"],
            extraCriteria: { status: `ne(${IngestStatus.DELIVERED})` },
        });
    }
    return sources;
}

/**
 * `true` if any row of `sources` still references `key` - soft-deleted rows included, since a soft-deleted
 * `Message` is still recoverable and needs its content. Queries are exact (`eq(...)`), uncached and ACL-free.
 */
export async function isBlobKeyReferenced(objectFactory: ObjectFactory, sources: BlobReferenceSource[], key: string): Promise<boolean> {
    for (const source of sources) {
        const repo: RepoUtils<any> = await objectFactory.newInstance(RepoUtils, {
            name: source.entityClass.name,
            args: [source.entityClass],
        });
        for (const field of source.fields) {
            const count: number = await repo.count({ ...(source.extraCriteria ?? {}), [field]: `eq(${key})` } as any, {
                ignoreACL: true,
                includeDeleted: true,
            });
            if (count > 0) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Deletes each distinct, non-empty key in `keys` from `blobStore` unless some row of `sources` still references
 * it - see `isBlobKeyReferenced()`. Call it AFTER the owning row(s) have been removed, so the row being deleted
 * no longer counts as a reference. Returns the keys that were deleted.
 *
 * A row that was never deleted (a failure before its own `delete()`) keeps its blob, since it still references
 * it; a crash between the row delete and this call leaves an orphaned blob, never a dangling reference.
 */
export async function deleteBlobsIfUnreferenced(
    objectFactory: ObjectFactory,
    blobStore: BlobStore,
    sources: BlobReferenceSource[],
    keys: (string | undefined | null)[],
): Promise<string[]> {
    const deleted: string[] = [];
    for (const key of new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0))) {
        if (await isBlobKeyReferenced(objectFactory, sources, key)) {
            continue;
        }
        await blobStore.delete(key);
        deleted.push(key);
    }
    return deleted;
}
