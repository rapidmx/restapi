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
// InMemoryBlobStore test double, and still pass unmodified (Content-Length is present for every Buffer body
// they `.send()`, so the pre-stream size/empty checks fire exactly where they always did). What's new here -
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

    it("rejects an oversized upload (413) from Content-Length alone, before req.bodyStream is ever read at all.", async () => {
        const store = new LocalFsBlobStore();
        const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "restapi-mailbox-import-route-streaming-cl-"));
        (store as any).root = tempRoot;
        try {
            const route = makeRoute(store, 100);
            const stream = chunkedStream([Buffer.alloc(10)]);
            const readSpy = vi.spyOn(stream, "read");

            await expect(route.create(makeReq(stream, 1_000), folder.uid, "mbox", undefined, user)).rejects.toMatchObject({ status: 413 });

            expect(readSpy).not.toHaveBeenCalled();
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
