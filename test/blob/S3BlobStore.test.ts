///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for S3BlobStore - `@aws-sdk/client-s3` is mocked so no real S3/MinIO call occurs.
// `mockImplementation` here must be a real `function`, not an arrow function - both the client and every
// command are invoked with `new` by the code under test, and arrow functions can never be constructors.
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-s3", () => ({
    S3Client: vi.fn().mockImplementation(function () {
        return { send: mockSend };
    }),
    PutObjectCommand: vi.fn().mockImplementation(function (input: any) {
        return { input };
    }),
    GetObjectCommand: vi.fn().mockImplementation(function (input: any) {
        return { input };
    }),
    HeadObjectCommand: vi.fn().mockImplementation(function (input: any) {
        return { input };
    }),
    DeleteObjectCommand: vi.fn().mockImplementation(function (input: any) {
        return { input };
    }),
}));

import { Readable } from "stream";
import { S3Client } from "@aws-sdk/client-s3";
import { toBuffer } from "../../src/blob/LocalFsBlobStore.js";
import { S3BlobStore } from "../../src/blob/S3BlobStore.js";

const mockClientCtor = S3Client as unknown as ReturnType<typeof vi.fn>;

/** Builds an AWS SDK-shaped rejection: a modeled exception carries `name`, an unmodeled one only
 * `$metadata.httpStatusCode` (the defensive fallback path for non-AWS S3-compatible backends). */
function sdkError(name: string | undefined, httpStatusCode?: number): Error {
    return Object.assign(new Error("s3 error"), { name, $metadata: httpStatusCode ? { httpStatusCode } : undefined });
}

describe("S3BlobStore Tests", () => {
    let store: S3BlobStore;

    beforeEach(() => {
        store = new S3BlobStore();
        (store as any).bucket = "test-bucket";
        mockSend.mockReset();
        mockClientCtor.mockClear();
    });

    it("Stores and retrieves a Buffer.", async () => {
        const data = Buffer.from("hello world");
        mockSend.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ Body: Readable.from(data) });

        await store.put("key-1", data);
        const result = await store.get("key-1");

        expect(result.equals(data)).toBe(true);
        expect(mockSend).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ input: expect.objectContaining({ Bucket: "test-bucket", Key: "key-1", Body: data }) }),
        );
    });

    it("Passes a Readable stream through unbuffered as Body.", async () => {
        const stream = Readable.from(Buffer.from("streamed"));
        mockSend.mockResolvedValueOnce(undefined);

        await store.put("key-2", stream);

        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ Body: stream }) }));
    });

    it("Passes contentType as ContentType when given, and undefined when omitted.", async () => {
        mockSend.mockResolvedValueOnce(undefined);
        await store.put("key-3", Buffer.from("x"), { contentType: "text/plain" });
        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ ContentType: "text/plain" }) }));

        mockSend.mockResolvedValueOnce(undefined);
        await store.put("key-4", Buffer.from("x"));
        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ ContentType: undefined }) }));
    });

    it("getStream() sends no Range header when none is given.", async () => {
        mockSend.mockResolvedValueOnce({ Body: Readable.from(Buffer.from("data")) });
        await store.getStream("key");
        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ Range: undefined }) }));
    });

    it("getStream() sends an inclusive bytes Range when {start,end} is given.", async () => {
        mockSend.mockResolvedValueOnce({ Body: Readable.from(Buffer.from("data")) });
        await store.getStream("key", { start: 2, end: 5 });
        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ Range: "bytes=2-5" }) }));
    });

    it("getStream() sends an open-ended Range when only start is given.", async () => {
        mockSend.mockResolvedValueOnce({ Body: Readable.from(Buffer.from("data")) });
        await store.getStream("key", { start: 7 });
        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ Range: "bytes=7-" }) }));
    });

    it("getStream()'s returned value round-trips real content end-to-end.", async () => {
        const data = Buffer.from("round trip me");
        mockSend.mockResolvedValueOnce({ Body: Readable.from(data) });

        const stream = await store.getStream("key");
        const result = await toBuffer(stream);

        expect(result.equals(data)).toBe(true);
    });

    it("get()/getStream() throw a NOT_FOUND ApiError on NoSuchKey.", async () => {
        mockSend.mockRejectedValueOnce(sdkError("NoSuchKey"));
        await expect(store.getStream("missing")).rejects.toThrow(/no blob exists/i);

        mockSend.mockRejectedValueOnce(sdkError("NoSuchKey"));
        await expect(store.get("missing")).rejects.toThrow(/no blob exists/i);
    });

    it("get()/getStream() rethrow a non-NoSuchKey error unchanged.", async () => {
        mockSend.mockRejectedValueOnce(sdkError("AccessDenied"));
        await expect(store.getStream("key")).rejects.toThrow("s3 error");
    });

    it("delete() succeeds with no throw for both an existing and a nonexistent key (S3 delete is idempotent).", async () => {
        mockSend.mockResolvedValueOnce(undefined);
        await expect(store.delete("existing")).resolves.toBeUndefined();

        mockSend.mockResolvedValueOnce(undefined);
        await expect(store.delete("never-existed")).resolves.toBeUndefined();
    });

    it("delete() rethrows a genuine SDK error.", async () => {
        mockSend.mockRejectedValueOnce(sdkError("AccessDenied"));
        await expect(store.delete("key")).rejects.toThrow("s3 error");
    });

    it("exists() returns true when HeadObjectCommand succeeds.", async () => {
        mockSend.mockResolvedValueOnce({});
        expect(await store.exists("key")).toBe(true);
    });

    it("exists() returns false on a NotFound error.", async () => {
        mockSend.mockRejectedValueOnce(sdkError("NotFound"));
        expect(await store.exists("key")).toBe(false);
    });

    it("exists() returns false on an unmodeled 404 (S3-compatible backend fallback).", async () => {
        mockSend.mockRejectedValueOnce(sdkError("UnknownFault", 404));
        expect(await store.exists("key")).toBe(false);
    });

    it("exists() rethrows a non-404 error rather than reporting false.", async () => {
        mockSend.mockRejectedValueOnce(sdkError("AccessDenied"));
        await expect(store.exists("key")).rejects.toThrow("s3 error");
    });

    it("size() returns ContentLength from HeadObjectCommand.", async () => {
        mockSend.mockResolvedValueOnce({ ContentLength: 42 });
        expect(await store.size("key")).toBe(42);
    });

    it("size() throws a NOT_FOUND ApiError on NotFound.", async () => {
        mockSend.mockRejectedValueOnce(sdkError("NotFound"));
        await expect(store.size("key")).rejects.toThrow(/no blob exists/i);
    });

    it("size() throws a NOT_FOUND ApiError on an unmodeled 404 (S3-compatible backend fallback).", async () => {
        mockSend.mockRejectedValueOnce(sdkError("UnknownFault", 404));
        await expect(store.size("key")).rejects.toThrow(/no blob exists/i);
    });

    it("size() rethrows a non-404 error rather than reporting missing.", async () => {
        mockSend.mockRejectedValueOnce(sdkError("AccessDenied"));
        await expect(store.size("key")).rejects.toThrow("s3 error");
    });

    it("Throws a clear ApiError naming the config key when bucket is not configured.", async () => {
        (store as any).bucket = "";
        await expect(store.exists("key")).rejects.toThrow(/mail:blob:s3:bucket/);
    });

    describe("client construction", () => {
        it("Constructs with region only when no endpoint/credentials/forcePathStyle are configured.", async () => {
            (store as any).region = "us-east-1";
            mockSend.mockResolvedValueOnce({});
            await store.exists("key");
            expect(mockClientCtor).toHaveBeenCalledWith({ region: "us-east-1" });
        });

        it("Constructs with no options at all when nothing is configured.", async () => {
            mockSend.mockResolvedValueOnce({});
            await store.exists("key");
            expect(mockClientCtor).toHaveBeenCalledWith({});
        });

        it("Constructs with endpoint and forcePathStyle when configured (S3-compatible target).", async () => {
            (store as any).endpoint = "http://localhost:9000";
            (store as any).forcePathStyle = true;
            mockSend.mockResolvedValueOnce({});
            await store.exists("key");
            expect(mockClientCtor).toHaveBeenCalledWith({ endpoint: "http://localhost:9000", forcePathStyle: true });
        });

        it("Constructs with explicit credentials when both access key fields are set.", async () => {
            (store as any).accessKeyId = "AKIA...";
            (store as any).secretAccessKey = "secret";
            mockSend.mockResolvedValueOnce({});
            await store.exists("key");
            expect(mockClientCtor).toHaveBeenCalledWith({
                credentials: { accessKeyId: "AKIA...", secretAccessKey: "secret" },
            });
        });

        it("Omits credentials entirely (falls back to the provider chain) when neither key is set.", async () => {
            mockSend.mockResolvedValueOnce({});
            await store.exists("key");
            const ctorArgs = mockClientCtor.mock.calls[0][0];
            expect("credentials" in ctorArgs).toBe(false);
        });

        it("Throws a clear ApiError when only one of the access key pair is configured.", async () => {
            (store as any).accessKeyId = "AKIA...";
            await expect(store.exists("key")).rejects.toThrow(/access_key_id.*secret_access_key/);
        });

        it("Constructs the client exactly once and reuses it across multiple calls.", async () => {
            mockSend.mockResolvedValue({});
            await store.exists("key-a");
            await store.exists("key-b");
            expect(mockClientCtor).toHaveBeenCalledTimes(1);
        });
    });

    describe("key prefix", () => {
        it("Uses the raw key when no prefix is configured.", async () => {
            mockSend.mockResolvedValueOnce({});
            await store.exists("my-key");
            expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ Key: "my-key" }) }));
        });

        it("Prepends the configured prefix to every command's Key.", async () => {
            (store as any).prefix = "prod";
            mockSend.mockResolvedValueOnce({});
            await store.exists("my-key");
            expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ Key: "prod/my-key" }) }));
        });

        it("Normalizes a trailing slash on the configured prefix (no double slash).", async () => {
            (store as any).prefix = "prod/";
            mockSend.mockResolvedValueOnce({});
            await store.exists("my-key");
            expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ Key: "prod/my-key" }) }));
        });
    });
});
