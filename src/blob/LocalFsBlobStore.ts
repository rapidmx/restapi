///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import * as fs from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import * as path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { ObjectDecorators } from "@rapidrest/core";
import { BlobPutOptions, BlobRange, BlobStore } from "./BlobStore.js";
const { Config } = ObjectDecorators;

/**
 * A `BlobStore` implementation backed by the local filesystem. Suitable for single-instance deployments or
 * where `key`'s underlying directory is itself a shared/replicated mount (e.g. NFS). Larger deployments should
 * prefer `S3BlobStore` instead.
 *
 * Keys are sharded two levels deep by the first four characters of their MD5 hash (e.g. key `abc123` is stored
 * at `<root>/ab/c1/abc123`) to avoid placing an unbounded number of files in a single directory.
 *
 * @author Jean-Philippe Steinmetz
 */
export class LocalFsBlobStore implements BlobStore {
    @Config("mail:blob:local:root", "./data/blobs")
    private root: string = "./data/blobs";

    private resolvePath(key: string): string {
        const hash: string = crypto.createHash("md5").update(key).digest("hex");
        // `key` may itself contain path separators (e.g. a UUID-derived prefix) — normalize it to a single
        // path-safe segment so it can never be interpreted as a directory traversal.
        const safeKey: string = key.replace(/[\\/]/g, "_");
        return path.join(this.root, hash.slice(0, 2), hash.slice(2, 4), safeKey);
    }

    public async put(key: string, data: Buffer | NodeJS.ReadableStream, _options?: BlobPutOptions): Promise<void> {
        const filePath: string = this.resolvePath(key);
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        if (Buffer.isBuffer(data)) {
            await fs.writeFile(filePath, data);
        } else {
            await pipeline(data, createWriteStream(filePath));
        }
    }

    public async get(key: string): Promise<Buffer> {
        return await fs.readFile(this.resolvePath(key));
    }

    public async getStream(key: string, range?: BlobRange): Promise<NodeJS.ReadableStream> {
        const filePath: string = this.resolvePath(key);
        // Fail fast with a consistent "does not exist" error rather than deferring to the first read of the
        // lazily-opened stream, which would otherwise surface as an unhandled `error` event to the caller.
        await fs.access(filePath);
        return range ? createReadStream(filePath, { start: range.start, end: range.end }) : createReadStream(filePath);
    }

    public async delete(key: string): Promise<void> {
        try {
            await fs.unlink(this.resolvePath(key));
        } catch (err: any) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }
    }

    public async exists(key: string): Promise<boolean> {
        try {
            await fs.access(this.resolvePath(key));
            return true;
        } catch {
            return false;
        }
    }

    public async size(key: string): Promise<number> {
        const stat = await fs.stat(this.resolvePath(key));
        return stat.size;
    }
}

/** Coerces a `Buffer | NodeJS.ReadableStream` into a `Buffer`, for adapters that only accept whole buffers. */
export async function toBuffer(data: Buffer | NodeJS.ReadableStream): Promise<Buffer> {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of data as Readable) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
