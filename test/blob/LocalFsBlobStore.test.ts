///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Pure unit tests for LocalFsBlobStore - real filesystem I/O against an isolated temp directory (no mocking
// needed since this adapter *is* the filesystem boundary). Also covers the exported `toBuffer()` helper.
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import { LocalFsBlobStore, toBuffer } from "../../src/blob/LocalFsBlobStore.js";

describe("LocalFsBlobStore Tests", () => {
    let tmpDir: string;
    let store: LocalFsBlobStore;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "localfsblobstore-test-"));
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        store = new LocalFsBlobStore();
        (store as any).root = tmpDir;
    });

    it("Stores and retrieves a Buffer.", async () => {
        const key = "buffer-key";
        const data = Buffer.from("hello world");

        await store.put(key, data);
        const result = await store.get(key);

        expect(result.equals(data)).toBe(true);
    });

    it("Stores and retrieves a Readable stream.", async () => {
        const key = "stream-key";
        const data = Buffer.from("streamed content");

        await store.put(key, Readable.from(data));
        const result = await store.get(key);

        expect(result.equals(data)).toBe(true);
    });

    it("getStream() returns the full content when no range is given.", async () => {
        const key = "getstream-full";
        const data = Buffer.from("0123456789");
        await store.put(key, data);

        const stream = await store.getStream(key);
        const result = await toBuffer(stream);

        expect(result.equals(data)).toBe(true);
    });

    it("getStream() returns only the requested byte range.", async () => {
        const key = "getstream-range";
        const data = Buffer.from("0123456789");
        await store.put(key, data);

        const stream = await store.getStream(key, { start: 2, end: 5 });
        const result = await toBuffer(stream);

        // createReadStream's `end` is inclusive, so [2,5] is "2345".
        expect(result.toString()).toBe("2345");
    });

    it("getStream() with only a start honors 'to end of blob'.", async () => {
        const key = "getstream-open-ended";
        const data = Buffer.from("0123456789");
        await store.put(key, data);

        const stream = await store.getStream(key, { start: 7 });
        const result = await toBuffer(stream);

        expect(result.toString()).toBe("789");
    });

    it("delete() removes a stored blob.", async () => {
        const key = "delete-key";
        await store.put(key, Buffer.from("to be deleted"));

        await store.delete(key);

        expect(await store.exists(key)).toBe(false);
    });

    it("delete() of a nonexistent key does not throw.", async () => {
        await expect(store.delete("never-existed")).resolves.toBeUndefined();
    });

    it("delete() rethrows errors other than ENOENT (e.g. attempting to unlink a directory).", async () => {
        const key = "delete-dir-key";
        const filePath: string = (store as any).resolvePath(key);
        await fs.mkdir(filePath, { recursive: true });

        await expect(store.delete(key)).rejects.toThrow();

        await fs.rm(filePath, { recursive: true, force: true });
    });

    it("exists() returns true for a stored key and false otherwise.", async () => {
        const key = "exists-key";
        await store.put(key, Buffer.from("x"));

        expect(await store.exists(key)).toBe(true);
        expect(await store.exists("nope")).toBe(false);
    });

    it("size() returns the byte length of the stored blob.", async () => {
        const key = "size-key";
        const data = Buffer.from("twelve bytes");
        await store.put(key, data);

        expect(await store.size(key)).toBe(data.length);
    });

    it("get() throws for a nonexistent key.", async () => {
        await expect(store.get("does-not-exist")).rejects.toThrow();
    });

    it("getStream() throws for a nonexistent key.", async () => {
        await expect(store.getStream("does-not-exist")).rejects.toThrow();
    });

    it("size() throws for a nonexistent key.", async () => {
        await expect(store.size("does-not-exist")).rejects.toThrow();
    });

    it("Sanitizes a key containing path separators to a single path-safe segment.", async () => {
        const key = "a/b\\c";
        const data = Buffer.from("traversal-safe");

        await store.put(key, data);

        expect(await store.get(key)).toEqual(data);
    });

    it("put() replaces an existing blob atomically, leaving no temp file behind.", async () => {
        const key = "atomic-replace";
        await store.put(key, Buffer.from("old content"));
        await store.put(key, Buffer.from("new"));

        expect((await store.get(key)).toString()).toBe("new");
        const dir = path.dirname((store as any).resolvePath(key));
        expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("put() keeps the previous content and removes the temp file when the input stream fails mid-write.", async () => {
        const key = "atomic-stream-failure";
        await store.put(key, Buffer.from("previous"));

        const failing = new Readable({
            read() {
                this.push(Buffer.from("partial data"));
                this.destroy(new Error("source stream failed"));
            },
        });
        await expect(store.put(key, failing)).rejects.toThrow(/source stream failed/);

        expect((await store.get(key)).toString()).toBe("previous");
        const dir = path.dirname((store as any).resolvePath(key));
        expect((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    describe("toBuffer()", () => {
        it("Passes a Buffer through unchanged.", async () => {
            const data = Buffer.from("already a buffer");
            const result = await toBuffer(data);
            expect(result).toBe(data);
        });

        it("Drains a Readable stream into a Buffer.", async () => {
            const data = Buffer.from("drain me");
            const result = await toBuffer(Readable.from(data));
            expect(result.equals(data)).toBe(true);
        });

        it("Drains a stream emitting non-Buffer chunks (e.g. strings) into a Buffer.", async () => {
            const result = await toBuffer(Readable.from(["chunk-a", "chunk-b"]));
            expect(result.toString()).toBe("chunk-achunk-b");
        });
    });
});
