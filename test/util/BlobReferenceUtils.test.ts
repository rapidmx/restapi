///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for BlobReferenceUtils' query order and `exclude` handling, against fake repos that record every `count()` call.
// The real-DB reference semantics (both backends) are covered by the erasure/retention job tests.
import { deleteBlobsIfUnreferenced, isBlobKeyReferenced, messageBlobReferenceSources } from "../../src/util/BlobReferenceUtils.js";
import { IngestStatus } from "../../src/models/types.js";

/** `counts` maps `"<name>.<field>"` to the count the query returns (0 when absent). */
function makeRepos(counts: Record<string, number> = {}) {
    const calls: { entity: string; criteria: any; options: any }[] = [];
    const make = (name: string): any => ({
        count: async (criteria: any, options: any) => {
            calls.push({ entity: name, criteria, options });
            const field: string = Object.keys(criteria).find((k) => typeof criteria[k] === "string" && criteria[k].startsWith("eq("))!;
            return counts[`${name}.${field}`] ?? 0;
        },
    });
    const repos = {
        messageRepo: make("message"),
        attachmentRepo: make("attachment"),
        quarantineEntryRepo: make("quarantineEntry"),
        ingestQueueEntryRepo: make("ingestQueueEntry"),
    };
    return { calls, repos };
}

describe("BlobReferenceUtils Tests", () => {
    it("Checks IngestQueueEntry, then QuarantineEntry, then Message, then Attachment, tagging each source.", () => {
        const { repos } = makeRepos();

        const sources = messageBlobReferenceSources(repos);

        expect(sources.map((s) => s.repo)).toEqual([repos.ingestQueueEntryRepo, repos.quarantineEntryRepo, repos.messageRepo, repos.attachmentRepo]);
        expect(sources.map((s) => s.entityType)).toEqual(["ingestQueueEntry", "quarantineEntry", "message", "attachment"]);
        expect(sources[0].extraCriteria).toEqual({ status: `ne(${IngestStatus.DELIVERED})` });
        expect(sources[2].fields).toEqual(["bodyBlobKey", "sanitizedHtmlBlobKey"]);
    });

    it("Leaves out the repositories it is not given.", () => {
        expect(messageBlobReferenceSources({})).toEqual([]);
        const { repos } = makeRepos();
        expect(messageBlobReferenceSources({ attachmentRepo: repos.attachmentRepo }).map((s) => s.entityType)).toEqual(["attachment"]);
    });

    it("Queries in that order, soft-deleted rows included, and stops at the first reference.", async () => {
        const { calls, repos } = makeRepos({ "quarantineEntry.rawBlobKey": 1 });

        await expect(isBlobKeyReferenced(messageBlobReferenceSources(repos), "k")).resolves.toBe(true);

        expect(calls.map((c) => c.entity)).toEqual(["ingestQueueEntry", "quarantineEntry"]);
        expect(calls[0].criteria).toEqual({ status: `ne(${IngestStatus.DELIVERED})`, rawBlobKey: "eq(k)" });
        for (const call of calls) {
            expect(call.options).toEqual({ ignoreACL: true, includeDeleted: true });
        }
    });

    it("Reports an unreferenced key, and handles an empty source list.", async () => {
        const { repos } = makeRepos();

        await expect(isBlobKeyReferenced(messageBlobReferenceSources(repos), "k")).resolves.toBe(false);
        await expect(isBlobKeyReferenced([], "k")).resolves.toBe(false);
    });

    it("Excludes only the named row, identified by the repository instance.", async () => {
        const { calls, repos } = makeRepos();

        await expect(
            isBlobKeyReferenced(messageBlobReferenceSources(repos), "k", { repo: repos.attachmentRepo, uid: "a1" }),
        ).resolves.toBe(false);

        for (const call of calls) {
            if (call.entity === "attachment") {
                expect(call.criteria.uid).toBe("ne(a1)");
            } else {
                expect(call.criteria.uid).toBeUndefined();
            }
        }
    });

    it("Excludes only the named row, identified by the entity type name.", async () => {
        const { calls, repos } = makeRepos();

        await isBlobKeyReferenced(messageBlobReferenceSources(repos), "k", { entityType: "message", uid: "m1" });

        for (const call of calls) {
            expect(call.criteria.uid).toBe(call.entity === "message" ? "ne(m1)" : undefined);
        }
    });

    it("Excludes nothing when the exclusion names neither a source's repository nor its type.", async () => {
        const { calls, repos } = makeRepos();

        await isBlobKeyReferenced(messageBlobReferenceSources(repos), "k", { repo: {} as any, entityType: "unknown", uid: "x" });
        await isBlobKeyReferenced(messageBlobReferenceSources(repos), "k", { uid: "x" });

        expect(calls.every((c) => c.criteria.uid === undefined)).toBe(true);
    });

    it("deleteBlobsIfUnreferenced() deletes only unreferenced, distinct, non-empty keys, passing the exclusion through.", async () => {
        const { calls, repos } = makeRepos({ "message.bodyBlobKey": 1 });
        const blobStore: any = { delete: vi.fn().mockResolvedValue(undefined) };

        const deleted = await deleteBlobsIfUnreferenced(
            blobStore,
            messageBlobReferenceSources({ attachmentRepo: repos.attachmentRepo }),
            ["x", "x", undefined, "", null],
            { repo: repos.attachmentRepo, uid: "a1" },
        );
        expect(deleted).toEqual(["x"]);
        expect(blobStore.delete).toHaveBeenCalledTimes(1);
        expect(calls.every((c) => c.criteria.uid === "ne(a1)")).toBe(true);

        const kept = await deleteBlobsIfUnreferenced(blobStore, messageBlobReferenceSources(repos), ["y"]);
        expect(kept).toEqual([]);
        expect(blobStore.delete).toHaveBeenCalledTimes(1);
    });
});
