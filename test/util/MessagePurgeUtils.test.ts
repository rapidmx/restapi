///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for MessagePurgeUtils - the object factory and repositories are hand-built. The routes' behaviour over a real
// datastore is `test/routes/messagePurgeSuite.ts`.
import { MAX_PURGE_ATTACHMENT_ROWS, collectMessagePurge, finishMessagePurge } from "../../src/util/MessagePurgeUtils.js";

class AttachmentClass {}
class MessageClass {}
class QuarantineClass {}
class IngestClass {}

/** A fake `RepoUtils` factory: `newInstance()` hands out `repos[className]`. */
function makeFactory(repos: Record<string, any>): any {
    return { newInstance: vi.fn(async (_type: any, options: { name: string }) => repos[options.name]) };
}

/** An attachment repo over `rows`, answering `find()` the way keyset paging asks (`sort uid`, `uid: gt(<last>)`, `limit`). */
function makeAttachmentRepo(rows: any[]): any {
    const sorted = [...rows].sort((a, b) => (a.uid < b.uid ? -1 : 1));
    return {
        find: vi.fn(async (query: any) => {
            const after: string | undefined = /^gt\((.*)\)$/.exec(query.uid ?? "")?.[1];
            return sorted.filter((row) => after === undefined || row.uid > after).slice(0, query.limit);
        }),
        delete: vi.fn(async () => undefined),
    };
}

const classes = { messageClass: MessageClass, attachmentClass: AttachmentClass, quarantineEntryClass: QuarantineClass, ingestQueueEntryClass: IngestClass };
const message = (uid: string, extra: Record<string, any> = {}): any => ({ uid, bodyBlobKey: `body-${uid}`, sanitizedHtmlBlobKey: `html-${uid}`, ...extra });

describe("collectMessagePurge() Tests", () => {
    it("Collects each message's blob keys and each attachment's row and blob keys, de-duplicated.", async () => {
        const repo = makeAttachmentRepo([
            { uid: "a1", messageUid: "m1", blobKey: "att-1", extractedTextBlobKey: "text-1" },
            { uid: "a2", messageUid: "m2", blobKey: "att-1", extractedTextBlobKey: undefined },
            { uid: "a3", messageUid: "m2", blobKey: "", extractedTextBlobKey: "text-3" },
        ]);
        const ctx: any = { objectFactory: makeFactory({ AttachmentClass: repo }), classes };

        const prepared = await collectMessagePurge(ctx, [message("m1", { bodyBlobKey: "shared" }), message("m2", { bodyBlobKey: "shared", sanitizedHtmlBlobKey: undefined })]);

        expect(prepared.attachmentUids).toEqual(["a1", "a2", "a3"]);
        expect(prepared.truncated).toBe(false);
        expect(new Set(prepared.blobKeys)).toEqual(new Set(["shared", "html-m1", "att-1", "text-1", "text-3"]));
    });

    it("Includes a message's superseded draft bodies kept for a legal hold.", async () => {
        const ctx: any = { objectFactory: makeFactory({}), classes: { ...classes, attachmentClass: undefined } };

        const prepared = await collectMessagePurge(ctx, [message("m1", { retainedBodyBlobKeys: ["bodies/retained-one", "not-retained", 5] })]);

        expect(new Set(prepared.blobKeys)).toEqual(new Set(["body-m1", "html-m1", "bodies/retained-one"]));
    });

    it("Collects no message-level blob without both the quarantine and ingest classes - whether a raw message may go can't be told - but still the attachments'.", async () => {
        const repo = makeAttachmentRepo([{ uid: "a1", messageUid: "m1", blobKey: "att-1" }]);
        const factory = makeFactory({ AttachmentClass: repo });

        const noIngest = await collectMessagePurge({ objectFactory: factory, classes: { ...classes, ingestQueueEntryClass: undefined } }, [message("m1")]);
        const noQuarantine = await collectMessagePurge({ objectFactory: factory, classes: { ...classes, quarantineEntryClass: undefined } }, [message("m1")]);

        expect(noIngest.blobKeys).toEqual(["att-1"]);
        expect(noQuarantine.blobKeys).toEqual(["att-1"]);
    });

    it("Reads no attachments when there are no messages or no attachment class.", async () => {
        const factory = makeFactory({});

        expect(await collectMessagePurge({ objectFactory: factory, classes }, [])).toEqual({ attachmentUids: [], blobKeys: [], truncated: false });
        expect(await collectMessagePurge({ objectFactory: factory, classes: { ...classes, attachmentClass: undefined } }, [message("m1")])).toMatchObject({
            attachmentUids: [],
        });
        expect(factory.newInstance).not.toHaveBeenCalled();
    });

    it("Stops at the attachment cap and says so.", async () => {
        const rows = Array.from({ length: MAX_PURGE_ATTACHMENT_ROWS + 5 }, (_, i) => ({ uid: `a${String(i).padStart(6, "0")}`, messageUid: "m1", blobKey: `att-${i}` }));
        const ctx: any = { objectFactory: makeFactory({ AttachmentClass: makeAttachmentRepo(rows) }), classes };

        const prepared = await collectMessagePurge(ctx, [message("m1")]);

        expect(prepared.attachmentUids).toHaveLength(MAX_PURGE_ATTACHMENT_ROWS);
        expect(prepared.truncated).toBe(true);
    });
});

describe("finishMessagePurge() Tests", () => {
    const store = () => ({ delete: vi.fn(async () => undefined) });
    /** A factory whose repos count nothing, so no blob is referenced, plus the attachment repo. */
    const factoryOf = (attachmentRepo: any) => {
        const counter = { count: vi.fn(async () => 0) };
        return makeFactory({ AttachmentClass: { ...attachmentRepo, ...counter }, MessageClass: counter, QuarantineClass: counter, IngestClass: counter });
    };

    it("Deletes each attachment row, then every blob nothing references.", async () => {
        const repo = makeAttachmentRepo([]);
        const blobStore = store();

        await finishMessagePurge({ objectFactory: factoryOf(repo), blobStore: blobStore as any, classes }, { attachmentUids: ["a1", "a2"], blobKeys: ["k1", "k2"], truncated: false });

        expect(repo.delete.mock.calls.map((call: any[]) => call[0])).toEqual(["a1", "a2"]);
        expect(repo.delete.mock.calls[0][1]).toEqual({ ignoreACL: true, purge: true });
        expect(blobStore.delete.mock.calls.map((call: any[]) => call[0])).toEqual(["k1", "k2"]);
    });

    it("Keeps a blob some row still references.", async () => {
        const counter = { count: vi.fn(async (query: any) => (query.bodyBlobKey === "eq(kept)" ? 1 : 0)) };
        const factory = makeFactory({ AttachmentClass: counter, MessageClass: counter, QuarantineClass: counter, IngestClass: counter });
        const blobStore = store();

        await finishMessagePurge({ objectFactory: factory, blobStore: blobStore as any, classes }, { attachmentUids: [], blobKeys: ["kept", "gone"], truncated: false });

        expect(blobStore.delete.mock.calls.map((call: any[]) => call[0])).toEqual(["gone"]);
    });

    it("Logs and carries on when an attachment row or a blob cannot be deleted, and when the list was cut.", async () => {
        const repo = makeAttachmentRepo([]);
        repo.delete.mockRejectedValueOnce(new Error("row failure"));
        const blobStore = { delete: vi.fn().mockRejectedValueOnce(new Error("blob failure")).mockResolvedValue(undefined) };
        const logger = { warn: vi.fn() };

        await finishMessagePurge({ objectFactory: factoryOf(repo), blobStore: blobStore as any, classes, logger }, { attachmentUids: ["a1", "a2"], blobKeys: ["k1", "k2"], truncated: true });

        expect(repo.delete).toHaveBeenCalledTimes(2);
        expect(blobStore.delete).toHaveBeenCalledTimes(2);
        expect(logger.warn.mock.calls.map((call: any[]) => String(call[0]))).toEqual([
            expect.stringContaining("attachments, the rest were left behind"),
            expect.stringContaining("failed to delete attachment a1: row failure"),
            expect.stringContaining("failed to delete blob k1: blob failure"),
        ]);
    });

    it("Deletes only the rows when there is no blob store, and does nothing for an empty purge.", async () => {
        const repo = makeAttachmentRepo([]);

        await finishMessagePurge({ objectFactory: factoryOf(repo), classes }, { attachmentUids: ["a1"], blobKeys: ["k1"], truncated: false });
        await finishMessagePurge({ objectFactory: makeFactory({}), blobStore: store() as any, classes: { ...classes, attachmentClass: undefined } }, { attachmentUids: [], blobKeys: [], truncated: false });

        expect(repo.delete).toHaveBeenCalledTimes(1);
    });

    it("Leaves the attachment rows alone when there is no attachment class (nothing to name them by).", async () => {
        const blobStore = store();

        await finishMessagePurge({ objectFactory: makeFactory({ MessageClass: { count: async () => 0 } }), blobStore: blobStore as any, classes: { messageClass: MessageClass } }, {
            attachmentUids: ["a1"],
            blobKeys: ["k1"],
            truncated: false,
        });

        expect(blobStore.delete).toHaveBeenCalledWith("k1");
    });
});
