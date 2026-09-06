///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * The options available when storing a new blob via `BlobStore.put()`.
 */
export interface BlobPutOptions {
    /** The MIME content type of the data being stored, if known. */
    contentType?: string;
}

/** A byte range to retrieve via `BlobStore.getStream()`. `end` is inclusive; omit for "to end of blob". */
export interface BlobRange {
    start: number;
    end?: number;
}

/**
 * Provides storage for binary content too large or unstructured to live inline on an entity record — raw MIME
 * message sources, rendered message bodies, attachment content, extracted attachment text, and contact photos
 * are all stored here, referenced from the owning entity by a `blobKey`. No entity in this library ever stores
 * binary content directly in a Mongo/SQL column.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface BlobStore {
    /**
     * Stores `data` under `key`, replacing any existing blob at that key.
     */
    put(key: string, data: Buffer | NodeJS.ReadableStream, options?: BlobPutOptions): Promise<void>;

    /**
     * Retrieves the full content stored under `key`.
     *
     * @throws if no blob exists at `key`.
     */
    get(key: string): Promise<Buffer>;

    /**
     * Retrieves a readable stream of the content stored under `key`, optionally limited to `range`. Used to
     * serve large attachments (e.g. MAPI/EAS `ItemOperations` fetch, webmail download) without buffering the
     * entire blob into memory.
     *
     * @throws if no blob exists at `key`.
     */
    getStream(key: string, range?: BlobRange): Promise<NodeJS.ReadableStream>;

    /**
     * Removes the blob stored under `key`. A no-op if no blob exists at `key`.
     */
    delete(key: string): Promise<void>;

    /**
     * Determines whether a blob exists at `key`.
     */
    exists(key: string): Promise<boolean>;

    /**
     * Returns the size, in bytes, of the blob stored under `key`.
     *
     * @throws if no blob exists at `key`.
     */
    size(key: string): Promise<number>;
}
