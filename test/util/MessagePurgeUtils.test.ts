///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for MessagePurgeUtils (`collectMessagePurge()`/`finishMessagePurge()`) - the repositories are hand-built. The
// routes' behaviour over a real datastore is `test/routes/messagePurgeSuite.ts`.
import { MAX_PURGE_ATTACHMENT_ROWS, collectMessagePurge, finishMessagePurge } from "../../src/util/MessagePurgeUtils.js";

/** An attachment repo over `rows`, answering `find()` the way keyset paging asks (`sort uid`, `uid: gt(<last>)`, `limit`). */
function makeAttachmentRepo(rows: any[]): any {
    const sorted = [...rows].sort((a, b) => (a.uid < b.uid ? -1 : 1));
    return {
        find: vi.fn(async (query: any) => {
            const after: string | undefined = /^gt\((.*)\)$/.exec(query.uid ?? "")?.[1];
            return sorted.filter((row) => after === undefined || row.uid > after).slice(0, query.limit);
        }),
        delete: vi.fn(async () => undefined),
        count: vi.fn(async () => 0),
    };
}

const counter = () => ({ count: vi.fn(async () => 0) }) as any;
const reposOf = (attachmentRepo: any) => ({ messageRepo: counter(), attachmentRepo, quarantineEntryRepo: counter(), ingestQueueEntryRepo: counter() });
const message = (uid: string, extra: Record<string, any> = {}): any => ({ uid, bodyBlobKey: `body-${uid}`, sanitizedHtmlBlobKey: `html-${uid}`, ...extra });

describe("collectMessagePurge() Tests", () => {
    it("Collects each message's blob keys and each attachment's row and blob keys, de-duplicated.", async () => {
        const attachmentRepo = makeAttachmentRepo([
            { uid: "a1", messageUid: "m1", blobKey: "att-1", extractedTextBlobKey: "text-1" },
            { uid: "a2", messageUid: "m2", blobKey: "att-1", extractedTextBlobKey: undefined },
            { uid: "a3", messageUid: "m2", blobKey: "", extractedTextBlobKey: "text-3" },
        ]);

        const prepared = await collectMessagePurge({ repos: reposOf(attachmentRepo) }, [
            message("m1", { bodyBlobKey: "shared" }),
            message("m2", { bodyBlobKey: "shared", sanitizedHtmlBlobKey: undefined }),
        ]);

        expect(prepared.attachmentUids).toEqual(["a1", "a2", "a3"]);
        expect(prepared.truncated).toBe(false);
        expect(new Set(prepared.blobKeys)).toEqual(new Set(["shared", "html-m1", "att-1", "text-1", "text-3"]));
    });

    it("Includes a message's superseded draft bodies kept for a legal hold.", async () => {
        const prepared = await collectMessagePurge({ repos: { ...reposOf(undefined), attachmentRepo: undefined } }, [
            message("m1", { retainedBodyBlobKeys: ["bodies/retained-one", "not-retained", 5] }),
        ]);

        expect(new Set(prepared.blobKeys)).toEqual(new Set(["body-m1", "html-m1", "bodies/retained-one"]));
    });

    it("Collects no message-level blob without both the quarantine and ingest repositories, but still the attachments'.", async () => {
        const attachmentRepo = makeAttachmentRepo([{ uid: "a1", messageUid: "m1", blobKey: "att-1" }]);
        const repos = reposOf(attachmentRepo);

        const noIngest = await collectMessagePurge({ repos: { ...repos, ingestQueueEntryRepo: undefined } }, [message("m1")]);
        const noQuarantine = await collectMessagePurge({ repos: { ...repos, quarantineEntryRepo: undefined } }, [message("m1")]);

        expect(noIngest.blobKeys).toEqual(["att-1"]);
        expect(noQuarantine.blobKeys).toEqual(["att-1"]);
    });

    it("Reads no attachments when there are no messages or no attachment repository.", async () => {
        const attachmentRepo = makeAttachmentRepo([]);

        expect(await collectMessagePurge({ repos: reposOf(attachmentRepo) }, [])).toEqual({ attachmentUids: [], blobKeys: [], truncated: false });
        expect(await collectMessagePurge({ repos: { ...reposOf(attachmentRepo), attachmentRepo: undefined } }, [message("m1")])).toMatchObject({
            attachmentUids: [],
        });
        expect(attachmentRepo.find).not.toHaveBeenCalled();
    });

    it("Stops at the attachment cap and says so.", async () => {
        const rows = Array.from({ length: MAX_PURGE_ATTACHMENT_ROWS + 5 }, (_, i) => ({ uid: `a${String(i).padStart(6, "0")}`, messageUid: "m1", blobKey: `att-${i}` }));

        const prepared = await collectMessagePurge({ repos: reposOf(makeAttachmentRepo(rows)) }, [message("m1")]);

        expect(prepared.attachmentUids).toHaveLength(MAX_PURGE_ATTACHMENT_ROWS);
        expect(prepared.truncated).toBe(true);
    });
});

describe("finishMessagePurge() Tests", () => {
    const store = () => ({ delete: vi.fn(async () => undefined) });

    it("Deletes each attachment row, then every blob nothing references.", async () => {
        const repo = makeAttachmentRepo([]);
        const blobStore = store();

        await finishMessagePurge({ repos: reposOf(repo), blobStore: blobStore as any }, { attachmentUids: ["a1", "a2"], blobKeys: ["k1", "k2"], truncated: false });

        expect(repo.delete.mock.calls.map((call: any[]) => call[0])).toEqual(["a1", "a2"]);
        expect(repo.delete.mock.calls[0][1]).toEqual({ ignoreACL: true, purge: true });
        expect(blobStore.delete.mock.calls.map((call: any[]) => call[0])).toEqual(["k1", "k2"]);
    });

    it("Keeps a blob some row still references.", async () => {
        const repos = reposOf(makeAttachmentRepo([]));
        repos.messageRepo.count = vi.fn(async (query: any) => (query.bodyBlobKey === "eq(kept)" ? 1 : 0));
        const blobStore = store();

        await finishMessagePurge({ repos, blobStore: blobStore as any }, { attachmentUids: [], blobKeys: ["kept", "gone"], truncated: false });

        expect(blobStore.delete.mock.calls.map((call: any[]) => call[0])).toEqual(["gone"]);
    });

    it("Logs and carries on when an attachment row or a blob cannot be deleted, and when the list was cut.", async () => {
        const repo = makeAttachmentRepo([]);
        repo.delete.mockRejectedValueOnce(new Error("row failure"));
        const blobStore = { delete: vi.fn().mockRejectedValueOnce(new Error("blob failure")).mockResolvedValue(undefined) };
        const logger = { warn: vi.fn() };

        await finishMessagePurge({ repos: reposOf(repo), blobStore: blobStore as any, logger }, { attachmentUids: ["a1", "a2"], blobKeys: ["k1", "k2"], truncated: true });

        expect(repo.delete).toHaveBeenCalledTimes(2);
        expect(blobStore.delete).toHaveBeenCalledTimes(2);
        expect(logger.warn.mock.calls.map((call: any[]) => String(call[0]))).toEqual([
            expect.stringContaining("attachments, the rest were left behind"),
            expect.stringContaining("failed to delete attachment a1: row failure"),
            expect.stringContaining("failed to delete blob k1: blob failure"),
        ]);
    });

    it("Tolerates a missing logger and a failure without a message.", async () => {
        const repo = makeAttachmentRepo([]);
        repo.delete.mockRejectedValueOnce(undefined);
        const blobStore = { delete: vi.fn().mockRejectedValueOnce(undefined) };

        await expect(
            finishMessagePurge({ repos: reposOf(repo), blobStore: blobStore as any }, { attachmentUids: ["a1"], blobKeys: ["k1"], truncated: true }),
        ).resolves.toBeUndefined();
    });

    it("Deletes only the rows when there is no blob store, and does nothing for an empty purge.", async () => {
        const repo = makeAttachmentRepo([]);

        await finishMessagePurge({ repos: reposOf(repo) }, { attachmentUids: ["a1"], blobKeys: ["k1"], truncated: false });
        await finishMessagePurge({ repos: { ...reposOf(repo), attachmentRepo: undefined }, blobStore: store() as any }, { attachmentUids: [], blobKeys: [], truncated: false });

        expect(repo.delete).toHaveBeenCalledTimes(1);
    });

    it("Leaves the attachment rows alone when there is no attachment repository (nothing to name them by).", async () => {
        const blobStore = store();

        await finishMessagePurge({ repos: { messageRepo: counter() }, blobStore: blobStore as any }, { attachmentUids: ["a1"], blobKeys: ["k1"], truncated: false });

        expect(blobStore.delete).toHaveBeenCalledWith("k1");
    });
});
