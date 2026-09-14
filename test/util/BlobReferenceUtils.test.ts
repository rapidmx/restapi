///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for BlobReferenceUtils' query order and `exclude` handling, against fake repos that record every
// `count()` call. The real-DB reference semantics (both backends) are covered by the erasure/retention job tests.
import { deleteBlobsIfUnreferenced, isBlobKeyReferenced, messageBlobReferenceSources } from "../../src/util/BlobReferenceUtils.js";
import { IngestStatus } from "../../src/models/types.js";

class MessageClass {}
class AttachmentClass {}
class QuarantineEntryClass {}
class IngestQueueEntryClass {}

const classes = {
    messageClass: MessageClass,
    attachmentClass: AttachmentClass,
    quarantineEntryClass: QuarantineEntryClass,
    ingestQueueEntryClass: IngestQueueEntryClass,
};

/** `counts` maps `"<ClassName>.<field>"` to the count its query returns (0 when absent). */
function makeObjectFactory(counts: Record<string, number> = {}) {
    const calls: { entity: string; criteria: any; options: any }[] = [];
    const objectFactory: any = {
        newInstance: async (_type: any, opts: { name: string }) => ({
            count: async (criteria: any, options: any) => {
                calls.push({ entity: opts.name, criteria, options });
                const field: string = Object.keys(criteria).find((k) => typeof criteria[k] === "string" && criteria[k].startsWith("eq("))!;
                return counts[`${opts.name}.${field}`] ?? 0;
            },
        }),
    };
    return { calls, objectFactory };
}

describe("BlobReferenceUtils Tests", () => {
    it("Checks IngestQueueEntry, then QuarantineEntry, then Message, then Attachment.", () => {
        const sources = messageBlobReferenceSources(classes);
        expect(sources.map((s) => s.entityClass)).toEqual([IngestQueueEntryClass, QuarantineEntryClass, MessageClass, AttachmentClass]);
        expect(sources[0].extraCriteria).toEqual({ status: `ne(${IngestStatus.DELIVERED})` });
    });

    it("Queries in that order, soft-deleted rows included, and stops at the first reference.", async () => {
        const { calls, objectFactory } = makeObjectFactory({ "QuarantineEntryClass.rawBlobKey": 1 });

        await expect(isBlobKeyReferenced(objectFactory, messageBlobReferenceSources(classes), "k")).resolves.toBe(true);

        expect(calls.map((c) => c.entity)).toEqual(["IngestQueueEntryClass", "QuarantineEntryClass"]);
        expect(calls[0].criteria).toEqual({ status: `ne(${IngestStatus.DELIVERED})`, rawBlobKey: "eq(k)" });
        for (const call of calls) {
            expect(call.options).toEqual({ ignoreACL: true, includeDeleted: true });
        }
    });

    it("Excludes only the named row of the named entity class from the reference check.", async () => {
        const { calls, objectFactory } = makeObjectFactory();

        await expect(
            isBlobKeyReferenced(objectFactory, messageBlobReferenceSources(classes), "k", { entityClass: AttachmentClass, uid: "a1" }),
        ).resolves.toBe(false);

        for (const call of calls) {
            if (call.entity === "AttachmentClass") {
                expect(call.criteria.uid).toBe("ne(a1)");
            } else {
                expect(call.criteria.uid).toBeUndefined();
            }
        }
    });

    it("deleteBlobsIfUnreferenced() deletes only unreferenced, distinct, non-empty keys, passing the exclusion through.", async () => {
        const { calls, objectFactory } = makeObjectFactory({ "MessageClass.bodyBlobKey": 1 });
        const blobStore: any = { delete: vi.fn().mockResolvedValue(undefined) };
        // The fake counts per field, so any key's `bodyBlobKey` query reports a reference: use the attachment-only
        // source list for the key that must be deleted.
        const deleted = await deleteBlobsIfUnreferenced(
            objectFactory,
            blobStore,
            messageBlobReferenceSources({ attachmentClass: AttachmentClass }),
            ["x", "x", undefined, "", null],
            { entityClass: AttachmentClass, uid: "a1" },
        );
        expect(deleted).toEqual(["x"]);
        expect(blobStore.delete).toHaveBeenCalledTimes(1);
        expect(calls.every((c) => c.criteria.uid === "ne(a1)")).toBe(true);

        const kept = await deleteBlobsIfUnreferenced(objectFactory, blobStore, messageBlobReferenceSources(classes), ["y"]);
        expect(kept).toEqual([]);
        expect(blobStore.delete).toHaveBeenCalledTimes(1);
    });
});
