///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Focused unit-style coverage for BaseMailboxImportRoute.create()'s streaming upload path
// (@StreamingBody()/req.bodyStream, @rapidrest/service-core 2.2.0+) against both LocalFsBlobStore and a
// mocked S3BlobStore, proving the route pipes the raw upload straight into BlobStore.put() as a stream -
// never buffering it into a Buffer first, the way the old req.rawBody path did.
//
// Deliberately NOT a real-HTTP test: test/routes/{mongo,sql}/MailboxImportRequestRoute.test.ts already
// cover the full request/response contract (400/413/403/404/etc) end to end against a real server and the
// InMemoryBlobStore test double, and still pass (Content-Length is present for every Buffer body they `.send()`, so the
// pre-stream size/empty checks fire exactly where they always did, and a rejected small body is drained first -
// see discardSmallBody()). What's new here -
// that the internal bodyStream -> blobStore.put(stream) data flow genuinely streams, never buffers, against
// each REAL blob store backend - doesn't need a real HTTP round-trip to prove, only a real BlobStore on one
// side and a synthetic `req.bodyStream` on the other (mirroring BaseFolderRoute.test.ts's own established
// "isolated unit test, DI wiring done by hand" pattern for exactly this kind of internals-focused case).
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
    S3Client: vi.fn().mockImplementation(function () {
        return { send: mockSend };
    }),
    PutObjectCommand: vi.fn().mockImplementation(function (input: any) {
        return { name: "PutObjectCommand", input };
    }),
    CreateMultipartUploadCommand: vi.fn().mockImplementation(function (input: any) {
        return { name: "CreateMultipartUploadCommand", input };
    }),
    UploadPartCommand: vi.fn().mockImplementation(function (input: any) {
        return { name: "UploadPartCommand", input };
    }),
    CompleteMultipartUploadCommand: vi.fn().mockImplementation(function (input: any) {
        return { name: "CompleteMultipartUploadCommand", input };
    }),
    AbortMultipartUploadCommand: vi.fn().mockImplementation(function (input: any) {
        return { name: "AbortMultipartUploadCommand", input };
    }),
}));
// Audit logging needs a real repo/DB connection this file deliberately has none of - it's not what's under
// test here, and every real-server test (mongo/sql) already covers "an audit entry is recorded".
vi.mock("../../src/util/AuditLogUtils.js", () => ({
    recordAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../config.js";
import { BaseMailboxImportRoute } from "../../src/routes/BaseMailboxImportRoute.js";
import { LocalFsBlobStore } from "../../src/blob/LocalFsBlobStore.js";
import { S3BlobStore } from "../../src/blob/S3BlobStore.js";

class FakeMailboxImportRequest {
    public uid: string = uuid.v4();
    public constructor(data: any) {
        Object.assign(this, data);
    }
}
class FakeMailbox {}
class FakeFolder {}
class FakeAuditLogEntry {}

class TestMailboxImportRoute extends BaseMailboxImportRoute<any, any, any> {
    protected mailboxImportRequestClass: any = FakeMailboxImportRequest;
    protected mailboxClass: any = FakeMailbox;
    protected folderClass: any = FakeFolder;
    protected auditLogClass: any = FakeAuditLogEntry;
}

/** A `Readable` yielding `chunks` one at a time on separate ticks (never all synchronously) so a
 * consumer genuinely has to `for await`/pull it over multiple event-loop turns - the same shape a real
 * chunked network upload has, as opposed to one big synchronous `Readable.from([wholeBuffer])`. */
function chunkedStream(chunks: Buffer[]): Readable {
    let i = 0;
    return new Readable({
        async read() {
            if (i >= chunks.length) {
                this.push(null);
                return;
            }
            await new Promise((resolve) => setImmediate(resolve));
            this.push(chunks[i++]);
        },
    });
}

/** Recursively lists real FILES under `dir` (never directories themselves) - `LocalFsBlobStore.put()`
 * shards a key into two levels of hash-prefix subdirectories (`resolvePath()`'s own doc comment) via
 * `fs.mkdir(..., { recursive: true })` before it ever writes anything, so a plain top-level `readdir()`
 * would see those now-empty shard directories and wrongly report "not empty" even when `delete()` has
 * correctly removed the one file that ever existed under them. */
async function listFiles(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFiles(full)));
        } else {
            files.push(full);
        }
    }
    return files;
}

describe("BaseMailboxImportRoute.create() streaming upload (req.bodyStream, @StreamingBody())", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());
    const user: any = { uid: uuid.v4(), roles: [] };
    const mailbox: any = { uid: uuid.v4(), ownerUserUid: user.uid };
    const folder: any = { uid: uuid.v4(), mailboxUid: mailbox.uid };

    function makeRoute(blobStore: any, maxImportBytes: number = 50 * 1024 * 1024 * 1024): TestMailboxImportRoute {
        const route = objectFactory.newInstance<TestMailboxImportRoute>(TestMailboxImportRoute, { initialize: false });
        (route as any).requestRepo = { create: vi.fn(async (entity: any) => entity) };
        (route as any).mailboxRepo = {
            find: vi.fn(async () => [mailbox]),
            findOne: vi.fn(async (uid: string) => (uid === mailbox.uid ? mailbox : undefined)),
        };
        (route as any).folderRepo = { findOne: vi.fn(async (uid: string) => (uid === folder.uid ? folder : undefined)) };
        (route as any).blobStore = blobStore;
        (route as any).maxImportBytes = maxImportBytes;
        (route as any).config = config;
        (route as any).logger = Logger();
        return route;
    }

    function makeReq(bodyStream: Readable | undefined, contentLength?: number): any {
        return {
            headers: contentLength !== undefined ? { "content-length": String(contentLength) } : {},
            bodyStream,
        };
    }

    beforeEach(() => {
        mockSend.mockReset();
    });

    describe("LocalFsBlobStore", () => {
        let tempRoot: string;
        let store: LocalFsBlobStore;

        beforeEach(async () => {
            tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "restapi-mailbox-import-route-streaming-"));
            store = new LocalFsBlobStore();
            (store as any).root = tempRoot;
        });
        afterEach(async () => {
            await fs.rm(tempRoot, { recursive: true, force: true });
        });

        it("streams a multi-chunk body straight to the blob's own file, never buffering it into a Buffer first.", async () => {
            const chunks = [Buffer.from("From alice@example.com Thu Jan 01 00:00:00 2026\r\n"), Buffer.from("Subject: Hi\r\n\r\n"), Buffer.from("Body\r\n\r\n")];
            const expected = Buffer.concat(chunks);
            const route = makeRoute(store);
            const putSpy = vi.spyOn(store, "put");

            const created = await route.create(makeReq(chunkedStream(chunks), expected.length), folder.uid, "mbox", undefined, user);

            expect(created.sourceBlobKey).toMatch(/^mailbox-imports\//);
            // The route itself never materializes the whole body into a Buffer before calling put() - the
            // second argument is a stream, matching the old (pre-streaming) call site's Buffer argument
            // being gone entirely, not merely unobserved.
            expect(putSpy).toHaveBeenCalledTimes(1);
            expect(Buffer.isBuffer(putSpy.mock.calls[0][1])).toBe(false);
            const onDisk = await fs.readFile((store as any).resolvePath(created.sourceBlobKey));
            expect(onDisk.equals(expected)).toBe(true);
        });

        it("aborts mid-stream (413) and leaves no blob file behind when the running byte count exceeds maxImportBytes, even with no Content-Length declared.", async () => {
            const chunks = [Buffer.alloc(40, 1), Buffer.alloc(40, 2), Buffer.alloc(40, 3)];
            const route = makeRoute(store, 50); // well under the 120 total bytes above

            await expect(route.create(makeReq(chunkedStream(chunks)), folder.uid, "mbox", undefined, user)).rejects.toMatchObject({ status: 413 });

            expect(await listFiles(tempRoot)).toEqual([]);
        });

        it("rejects an empty upload (400) discovered only once the stream ends, with no Content-Length declared, and leaves no blob file behind.", async () => {
            const route = makeRoute(store);

            await expect(route.create(makeReq(chunkedStream([])), folder.uid, "mbox", undefined, user)).rejects.toMatchObject({ status: 400 });

            expect(await listFiles(tempRoot)).toEqual([]);
        });
    });

    describe("S3BlobStore (mocked @aws-sdk/client-s3 - see this file's own top comment)", () => {
        function makeS3Store(): S3BlobStore {
            const store = new S3BlobStore();
            (store as any).bucket = "test-bucket";
            return store;
        }

        it("streams a multi-chunk body straight into a single PutObject (short upload), never buffering it into a Buffer inside this route first.", async () => {
            const chunks = [Buffer.from("fake pst "), Buffer.from("bytes go "), Buffer.from("here")];
            const expected = Buffer.concat(chunks);
            const store = makeS3Store();
            const putSpy = vi.spyOn(store, "put");
            mockSend.mockResolvedValueOnce(undefined); // PutObjectCommand
            const route = makeRoute(store);

            const created = await route.create(makeReq(chunkedStream(chunks), expected.length), folder.uid, "pst", undefined, user);

            expect(created.sourceBlobKey).toMatch(/^mailbox-imports\//);
            // Proven the same way as the LocalFsBlobStore case above - the route hands `put()` a stream, not
            // a pre-buffered Buffer. (S3BlobStore.put() itself still joins a short upload into one Buffer for
            // the single PutObject call S3's API requires - that's S3BlobStore's own already-tested behavior,
            // not a buffering regression reintroduced by this route.)
            expect(Buffer.isBuffer(putSpy.mock.calls[0][1])).toBe(false);
            expect(mockSend).toHaveBeenCalledTimes(1);
            const sent: any = mockSend.mock.calls[0][0];
            expect(sent.name).toBe("PutObjectCommand");
            expect(sent.input.Key).toBe(created.sourceBlobKey);
            expect(Buffer.isBuffer(sent.input.Body)).toBe(true);
            expect((sent.input.Body as Buffer).equals(expected)).toBe(true);
        });

        it("aborts mid-stream (413), aborting the request before any S3 call ever completes successfully, when the running byte count exceeds maxImportBytes.", async () => {
            const chunks = [Buffer.alloc(40, 1), Buffer.alloc(40, 2), Buffer.alloc(40, 3)];
            const store = makeS3Store();
            const route = makeRoute(store, 50);

            await expect(route.create(makeReq(chunkedStream(chunks)), folder.uid, "mbox", undefined, user)).rejects.toMatchObject({ status: 413 });
        });
    });

    it("rejects an oversized upload (413) from Content-Length alone, without ever reading a huge declared body - and never writes a blob.", async () => {
        const store = new LocalFsBlobStore();
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "restapi-mailbox-import-route-streaming-cl-"));
        (store as any).root = tempRoot;
        try {
            const route = makeRoute(store, 100);
            const stream = chunkedStream([Buffer.alloc(10)]);
            const readSpy = vi.spyOn(stream, "read");

            // 2 MiB declared: past what discardSmallBody() is willing to read-and-discard, so the stream is left
            // entirely alone (the framework force-closes that connection instead - see discardSmallBody()'s doc).
            await expect(route.create(makeReq(stream, 2 * 1024 * 1024), folder.uid, "mbox", undefined, user)).rejects.toMatchObject({ status: 413 });

            expect(readSpy).not.toHaveBeenCalled();
            expect(await listFiles(tempRoot)).toEqual([]);
        } finally {
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });

    describe("discarding the unread body of a rejected upload (@rapidrest/service-core 2.3.0 force-closes a streaming route's connection if it responds first)", () => {
        it("reads a small rejected body to its end before throwing, so the error can reach the client instead of a reset connection.", async () => {
            const route = makeRoute(new LocalFsBlobStore(), 100);
            const stream = chunkedStream([Buffer.alloc(60, 1), Buffer.alloc(60, 2)]);

            await expect(route.create(makeReq(stream, 120), folder.uid, "mbox", undefined, user)).rejects.toMatchObject({ status: 413 });

            expect(stream.readableEnded).toBe(true);
        });

        it("does the same for a validation failure (400) and for a chunked body with no Content-Length at all.", async () => {
            const route = makeRoute(new LocalFsBlobStore());
            const stream = chunkedStream([Buffer.from("hello "), Buffer.from("world")]);

            await expect(route.create(makeReq(stream), folder.uid, "nope" as any, undefined, user)).rejects.toMatchObject({ status: 400 });

            expect(stream.readableEnded).toBe(true);
        });

        it("stops reading a chunked body that keeps going past the discard limit, rather than draining an arbitrarily large upload just to answer 400.", async () => {
            const route = makeRoute(new LocalFsBlobStore());
            // 4 x 600 KiB with no Content-Length: the 1 MiB discard cap is crossed on the 2nd chunk.
            const chunks = [1, 2, 3, 4].map((n) => Buffer.alloc(600 * 1024, n));
            const stream = chunkedStream(chunks);

            await expect(route.create(makeReq(stream), folder.uid, "nope" as any, undefined, user)).rejects.toMatchObject({ status: 400 });

            expect(stream.readableEnded).toBe(false);
            stream.destroy();
        });

        it("gives up on a client that stalls mid-body after the discard timeout and still answers.", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            try {
                const route = makeRoute(new LocalFsBlobStore());
                const stalled = new Readable({ read() { /* never pushes anything, never ends */ } });
                const pending = route.create(makeReq(stalled, 10), folder.uid, "nope" as any, undefined, user);
                const assertion = expect(pending).rejects.toMatchObject({ status: 400 });

                await vi.advanceTimersByTimeAsync(5_000);

                await assertion;
                stalled.destroy();
            } finally {
                vi.useRealTimers();
            }
        });

        it("answers even when the body stream errors while being discarded.", async () => {
            const route = makeRoute(new LocalFsBlobStore());
            const broken = new Readable({
                read() {
                    this.destroy(new Error("client disconnected"));
                },
            });

            await expect(route.create(makeReq(broken, 10), folder.uid, "nope" as any, undefined, user)).rejects.toMatchObject({ status: 400 });
        });

        it("does not touch a body stream that has already ended or been destroyed.", async () => {
            const route = makeRoute(new LocalFsBlobStore());
            const ended = Readable.from([]);
            await new Promise((resolve) => ended.resume().on("end", resolve));
            const destroyed = new Readable({ read() { /* never reached - destroyed below */ } });
            destroyed.destroy();

            await expect(route.create(makeReq(ended, 10), folder.uid, "nope" as any, undefined, user)).rejects.toMatchObject({ status: 400 });
            await expect(route.create(makeReq(destroyed, 10), folder.uid, "nope" as any, undefined, user)).rejects.toMatchObject({ status: 400 });
        });
    });

    it("aborts mid-stream (413, quota message) when the running byte count exceeds the mailbox's remaining quota - tighter than maxImportBytes - even with no Content-Length declared, leaving no blob behind.", async () => {
        const store = new LocalFsBlobStore();
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "restapi-mailbox-import-route-streaming-quota-"));
        (store as any).root = tempRoot;
        try {
            const route = makeRoute(store);
            const quotaMailbox: any = { uid: mailbox.uid, ownerUserUid: user.uid, quotaBytes: 100, usedBytes: 40 }; // 60 bytes left
            (route as any).mailboxRepo.findOne = vi.fn(async () => quotaMailbox);
            const chunks = [Buffer.alloc(40, 1), Buffer.alloc(40, 2)]; // 80 > 60 remaining, far under maxImportBytes

            const err: any = await route.create(makeReq(chunkedStream(chunks)), folder.uid, "mbox", undefined, user).catch((e) => e);

            expect(err.status).toBe(413);
            expect(err.message).toMatch(/remaining storage quota/);
            expect(await listFiles(tempRoot)).toEqual([]);
        } finally {
            await fs.rm(tempRoot, { recursive: true, force: true });
        }
    });

    it("answers 500 when req.bodyStream is somehow missing (defensive - @StreamingBody() always populates it for a POST in production, but the framework declares it optional).", async () => {
        const store = new LocalFsBlobStore();
        const route = makeRoute(store);

        await expect(route.create(makeReq(undefined), folder.uid, "mbox", undefined, user)).rejects.toMatchObject({ status: 500 });
    });

    it("rethrows a genuine downstream failure (e.g. the client disconnecting mid-upload, or the blob store itself erroring) unchanged - not reinterpreted as a 413 - and still attempts blob cleanup, swallowing a failure of that cleanup too.", async () => {
        const putError = new Error("simulated client disconnect mid-upload");
        const deleteError = new Error("cleanup also failed - must not surface or replace putError");
        const store: any = {
            put: vi.fn().mockRejectedValue(putError),
            delete: vi.fn().mockRejectedValue(deleteError),
        };
        const route = makeRoute(store);

        await expect(route.create(makeReq(chunkedStream([Buffer.from("hello")])), folder.uid, "mbox", undefined, user)).rejects.toBe(putError);

        expect(store.delete).toHaveBeenCalledTimes(1);
    });

    it("still rejects an empty upload (400) when cleaning up the empty blob afterward itself fails - that cleanup failure is swallowed, not surfaced in place of the 400.", async () => {
        const deleteError = new Error("cleanup also failed - must not replace the 400");
        const store: any = {
            put: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockRejectedValue(deleteError),
        };
        const route = makeRoute(store);

        await expect(route.create(makeReq(chunkedStream([])), folder.uid, "mbox", undefined, user)).rejects.toMatchObject({ status: 400 });

        expect(store.delete).toHaveBeenCalledTimes(1);
    });
});
