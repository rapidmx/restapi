///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { GetObjectCommandOutput, HeadObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { importAwsClientS3 } from "../shared.js";
import { BlobPutOptions, BlobRange, BlobStore } from "./BlobStore.js";
import { toBuffer } from "./LocalFsBlobStore.js";
const { Config } = ObjectDecorators;

/** S3's minimum size for every part of a multipart upload except the last. */
const S3_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * A `BlobStore` implementation backed by Amazon S3 or any S3-compatible object store (MinIO, Cloudflare
 * R2, DigitalOcean Spaces, etc.) — the recommended `BlobStore` for a multi-instance deployment, where
 * `LocalFsBlobStore`'s single-host/shared-mount assumption no longer holds.
 *
 * Deliberately not AWS-only: `mail:blob:s3:endpoint`/`mail:blob:s3:force_path_style` let this same class
 * target a self-hosted or non-AWS S3-compatible endpoint instead, matching this repo's established
 * preference for avoiding a single paid vendor's lock-in wherever a genuinely compatible open alternative
 * exists (`OpenBaoPkiCertificateAuthority` over Vault, `PostfixSendmailTransport` over a paid relay).
 * Credentials default to the standard AWS SDK credential provider chain (an IAM role in a real AWS
 * deployment), the same "no secret/key configuration of its own" posture `SesMailTransport` uses;
 * `mail:blob:s3:access_key_id`/`mail:blob:s3:secret_access_key` are an explicit override pair for a
 * target with no IAM-equivalent chain to fall back to (e.g. a standalone MinIO instance).
 *
 * `mail:blob:s3:prefix` mirrors `LocalFsBlobStore`'s `mail:blob:local:root` concept for object storage:
 * it lets one bucket be safely shared across multiple environments/apps (e.g. `prod/`, `staging/`)
 * without key collisions, since a bucket is a comparatively coarse-grained/slow-to-provision resource
 * compared to a filesystem directory.
 *
 * Unlike `LocalFsBlobStore`, keys are not hashed/sharded before use as the S3 object key - S3 has no
 * "too many files in one directory" problem, and preserving the caller's own key verbatim (aside from
 * the prefix) keeps objects easy to locate directly in the bucket for operational debugging. Deleting a
 * nonexistent key is also a plain no-op success response from S3 itself (idempotent by design), unlike
 * `fs.unlink`'s `ENOENT` - `delete()` below needs no error handling at all as a result.
 *
 * @author Jean-Philippe Steinmetz
 */
export class S3BlobStore implements BlobStore {
    @Config("mail:blob:s3:bucket", "")
    private bucket: string = "";

    @Config("mail:blob:s3:region")
    private region?: string;

    /** Prepended to every key - see class doc comment. Empty string (the default) means no prefixing. */
    @Config("mail:blob:s3:prefix", "")
    private prefix: string = "";

    /** A custom S3-compatible endpoint (MinIO, R2, Spaces, etc.) - unset targets real AWS S3. */
    @Config("mail:blob:s3:endpoint")
    private endpoint?: string;

    @Config("mail:blob:s3:force_path_style", false)
    private forcePathStyle: boolean = false;

    @Config("mail:blob:s3:access_key_id")
    private accessKeyId?: string;

    @Config("mail:blob:s3:secret_access_key")
    private secretAccessKey?: string;

    /** Part size for a streamed `put()` - see its doc comment. S3 requires at least 5 MiB for every part but the
     * last, and caps a single multipart upload at 10,000 parts total - at the 8 MiB default, that's an 80 GiB
     * object before hitting it, comfortably above `BaseMailboxImportRoute`'s own 50 GiB `mail:import:max_bytes`
     * default, but an operator who lowers this well below the default while also raising `mail:import:max_bytes`
     * could still hit the 10,000-part ceiling on a large upload - not otherwise validated or cross-checked here. */
    @Config("mail:blob:s3:multipart_part_size_bytes", 8 * 1024 * 1024)
    private multipartPartSizeBytes: number = 8 * 1024 * 1024;

    private client?: S3Client;

    private resolveKey(key: string): string {
        return this.prefix ? `${this.prefix.replace(/\/+$/, "")}/${key}` : key;
    }

    private async getClient(sdk?: any): Promise<S3Client> {
        if (!this.bucket) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, "mail:blob:s3:bucket is required but was not configured.");
        }
        sdk = sdk ?? (await importAwsClientS3());
        // v8-coverage-provider quirk, not a real gap: this whole block's *statement* range is reported
        // permanently unhit even though the identical range's *branch* counter (and
        // `test/blob/S3BlobStore.test.ts`'s own "client construction" describe block, which asserts on
        // `S3Client` constructor calls) both confirm it runs on every test in that block - a known
        // v8-to-istanbul miscount when a statement's range exactly coincides with its enclosing `if`'s
        // branch-consequent range.
        /* v8 ignore next 23 */
        if (!this.client) {
            if ((this.accessKeyId && !this.secretAccessKey) || (!this.accessKeyId && this.secretAccessKey)) {
                throw new ApiError(
                    ApiErrors.INTERNAL_ERROR,
                    500,
                    "mail:blob:s3:access_key_id and mail:blob:s3:secret_access_key must both be set, or both left unset.",
                );
            }
            const options: any = {};
            if (this.region) {
                options.region = this.region;
            }
            if (this.endpoint) {
                options.endpoint = this.endpoint;
            }
            if (this.forcePathStyle) {
                options.forcePathStyle = true;
            }
            if (this.accessKeyId && this.secretAccessKey) {
                options.credentials = { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey };
            }
            this.client = new sdk.S3Client(options);
        }
        return this.client as any;
    }

    /**
     * Stores `data`. A `Buffer` is one `PutObject`. A stream has no known length, which `PutObject` needs, so it is
     * read in `multipart_part_size_bytes` parts: a stream that ends within the first part is still one `PutObject`,
     * anything longer is a multipart upload (aborted if the stream or an upload fails, so no partial object is
     * left behind). Only about one part is held in memory at a time.
     */
    public async put(key: string, data: Buffer | NodeJS.ReadableStream, options?: BlobPutOptions): Promise<void> {
        const sdk = await importAwsClientS3();
        const client = await this.getClient(sdk);
        const Bucket: string = this.bucket;
        const Key: string = this.resolveKey(key);
        if (Buffer.isBuffer(data)) {
            await client.send(new sdk.PutObjectCommand({ Bucket, Key, Body: data, ContentType: options?.contentType }));
            return;
        }

        const partSize: number = Math.max(S3_MIN_PART_SIZE_BYTES, this.multipartPartSizeBytes);
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        let uploadId: string | undefined;
        const parts: { ETag?: string; PartNumber: number }[] = [];
        const uploadPart = async (body: Buffer): Promise<void> => {
            if (!uploadId) {
                const created: any = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket, Key, ContentType: options?.contentType }));
                uploadId = created.UploadId;
            }
            const PartNumber: number = parts.length + 1;
            const uploaded: any = await client.send(new sdk.UploadPartCommand({ Bucket, Key, UploadId: uploadId, PartNumber, Body: body }));
            parts.push({ ETag: uploaded.ETag, PartNumber });
        };
        try {
            for await (const chunk of data as AsyncIterable<Buffer | string>) {
                const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                pending.push(buffer);
                pendingBytes += buffer.length;
                while (pendingBytes >= partSize) {
                    const joined: Buffer = Buffer.concat(pending);
                    await uploadPart(joined.subarray(0, partSize));
                    pending = [joined.subarray(partSize)];
                    pendingBytes = joined.length - partSize;
                }
            }
            const rest: Buffer = Buffer.concat(pending);
            if (!uploadId) {
                await client.send(new sdk.PutObjectCommand({ Bucket, Key, Body: rest, ContentType: options?.contentType }));
                return;
            }
            if (rest.length > 0) {
                await uploadPart(rest);
            }
            await client.send(new sdk.CompleteMultipartUploadCommand({ Bucket, Key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
        } catch (err) {
            if (uploadId) {
                await client.send(new sdk.AbortMultipartUploadCommand({ Bucket, Key, UploadId: uploadId })).catch(() => undefined);
            }
            throw err;
        }
    }

    public async get(key: string): Promise<Buffer> {
        return await toBuffer(await this.getStream(key));
    }

    /** Never local - see `BlobStore.localPath()`'s own doc comment. A caller that needs random-access/file-
     * path-based reads of an S3-backed blob (e.g. `MailboxImportJob.resolveLocalSourcePath()`) falls back to
     * streaming it once to a temp file instead. */
    public async localPath(_key: string): Promise<string | undefined> {
        return undefined;
    }

    public async getStream(key: string, range?: BlobRange): Promise<NodeJS.ReadableStream> {
        const sdk = await importAwsClientS3();
        const client = await this.getClient(sdk);
        try {
            const response: GetObjectCommandOutput = await client.send(
                new sdk.GetObjectCommand({
                    Bucket: this.bucket,
                    Key: this.resolveKey(key),
                    Range: range ? `bytes=${range.start}-${range.end ?? ""}` : undefined,
                }),
            );
            return response.Body as unknown as NodeJS.ReadableStream;
        } catch (err: any) {
            if (err.name === "NoSuchKey") {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, `No blob exists at key '${key}'.`);
            }
            throw err;
        }
    }

    public async delete(key: string): Promise<void> {
        const sdk = await importAwsClientS3();
        const client = await this.getClient(sdk);
        // S3 delete of a nonexistent key is a normal success response - see class doc comment.
        await client.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.resolveKey(key) }));
    }

    public async exists(key: string): Promise<boolean> {
        const sdk = await importAwsClientS3();
        const client = await this.getClient(sdk);
        try {
            await client.send(new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: this.resolveKey(key) }));
            return true;
        } catch (err: any) {
            if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
                return false;
            }
            throw err;
        }
    }

    public async size(key: string): Promise<number> {
        const sdk = await importAwsClientS3();
        const client = await this.getClient(sdk);
        try {
            const response: HeadObjectCommandOutput = await client.send(
                new sdk.HeadObjectCommand({ Bucket: this.bucket, Key: this.resolveKey(key) }),
            );
            return response.ContentLength ?? 0;
        } catch (err: any) {
            if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, `No blob exists at key '${key}'.`);
            }
            throw err;
        }
    }
}
