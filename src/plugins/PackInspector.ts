///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as zlib from "zlib";

/** The most a pack may unpack to (the gunzip output cap), in bytes - what stops a gzip bomb. */
export const PACK_MAX_UNPACKED_BYTES: number = 256 * 1024 * 1024;

/** The most entries (files and directories) a pack may hold. */
export const PACK_MAX_ENTRIES: number = 20000;

/** The largest `package/package.json` a pack may hold, in bytes. */
export const PACK_MAX_PACKAGE_JSON_BYTES: number = 1024 * 1024;

/** The longest entry name the inspector accepts, in bytes. */
const MAX_ENTRY_NAME_BYTES: number = 4096;

/** The most bytes of a pax or GNU long-name record the inspector reads. */
const MAX_META_BYTES: number = 64 * 1024;

const BLOCK = 512;

/** What `inspectPack()` found in a pack. */
export interface PackInspection {
    /** The parsed `package/package.json`. */
    packageJson: Record<string, unknown>;
    /** How many files and directories the pack holds. */
    entryCount: number;
    /** The total size of the pack's files once unpacked, in bytes. */
    unpackedBytes: number;
}

/** What is wrong with a pack: the message says why, in words an administrator can act on. */
export class PackInspectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PackInspectionError";
    }
}

export interface PackInspectionLimits {
    maxUnpackedBytes?: number;
    maxEntries?: number;
}

/** The text of a NUL-terminated header field. */
function field(header: Buffer, start: number, length: number): string {
    const end: number = header.indexOf(0, start);
    return header.toString("utf8", start, end >= start && end < start + length ? end : start + length);
}

/** The number in an octal header field, or `undefined` when it isn't one. */
function octal(header: Buffer, start: number, length: number): number | undefined {
    const text: string = field(header, start, length).trim();
    return /^[0-7]+$/.test(text) ? parseInt(text, 8) : undefined;
}

/** Whether the header's checksum field matches its bytes (the checksum counts its own field as spaces). */
function validChecksum(header: Buffer): boolean {
    const expected: number | undefined = octal(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
        sum += i >= 148 && i < 156 ? 32 : header[i];
    }
    return expected === sum;
}

/** The `path` record of a pax extended header, if it has one. Each record is `<length> <key>=<value>\n`. */
function paxPath(data: Buffer): string | undefined {
    let offset = 0;
    let found: string | undefined;
    while (offset < data.length) {
        const space: number = data.indexOf(0x20, offset);
        const length: number = space > offset ? parseInt(data.toString("latin1", offset, space), 10) : NaN;
        if (!Number.isInteger(length) || length <= space - offset + 1 || offset + length > data.length) {
            throw new PackInspectionError("The pack is not a valid tar archive (a malformed extended header).");
        }
        const record: string = data.toString("utf8", space + 1, offset + length - 1);
        if (record.startsWith("path=")) {
            found = record.slice(5);
        }
        offset += length;
    }
    return found;
}

/** Refuses an entry name that isn't a plain relative path under `package/`. */
function checkName(name: string): void {
    if (
        name.length === 0 ||
        Buffer.byteLength(name) > MAX_ENTRY_NAME_BYTES ||
        name.includes("\0") ||
        name.includes("\\") ||
        name.startsWith("/") ||
        /^[a-zA-Z]:/.test(name) ||
        name.split("/").includes("..")
    ) {
        throw new PackInspectionError(`The pack holds an entry with an unsafe name (${JSON.stringify(name.slice(0, 100))}).`);
    }
    if (name !== "package" && !name.startsWith("package/")) {
        throw new PackInspectionError(`The pack holds an entry outside the package/ directory (${JSON.stringify(name.slice(0, 100))}). Use the file \`npm pack\` produced.`);
    }
}

/** The pack's tar archive: `bytes` gunzipped, never past `maxUnpackedBytes`. */
async function gunzip(bytes: Buffer, maxUnpackedBytes: number): Promise<Buffer> {
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        throw new PackInspectionError("The file is not a gzip archive. Upload the .tgz file `npm pack` produced.");
    }
    return new Promise<Buffer>((resolve, reject) => {
        zlib.gunzip(bytes, { maxOutputLength: maxUnpackedBytes }, (err, result) => {
            if (!err) {
                resolve(result);
            } else if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
                reject(new PackInspectionError(`The pack unpacks to more than ${maxUnpackedBytes} bytes.`));
            } else {
                reject(new PackInspectionError("The file is not a valid gzip archive."));
            }
        });
    });
}

/**
 * Reads an `npm pack` file (a gzipped tar) in memory, never writing it to disk, and reports what it holds. Refuses (with a
 * `PackInspectionError`) anything that isn't a plain package: not gzip, unpacking past `maxUnpackedBytes`, not tar, more than
 * `maxEntries` entries, an entry that isn't a regular file or directory (a link, device or FIFO) or whose name isn't a plain
 * relative path under `package/` (absolute, `..`, backslashes), more than one `package/package.json`, or one that is missing,
 * larger than `PACK_MAX_PACKAGE_JSON_BYTES` or not a JSON object. Ustar prefixes, pax `path` records and GNU long names are read.
 */
export async function inspectPack(bytes: Buffer, limits: PackInspectionLimits = {}): Promise<PackInspection> {
    const maxEntries: number = limits.maxEntries ?? PACK_MAX_ENTRIES;
    const tar: Buffer = await gunzip(bytes, limits.maxUnpackedBytes ?? PACK_MAX_UNPACKED_BYTES);
    const malformed = (why: string): PackInspectionError => new PackInspectionError(`The pack is not a valid tar archive (${why}).`);

    let packageJsonText: Buffer | undefined;
    let entryCount = 0;
    let unpackedBytes = 0;
    let pendingName: string | undefined;
    let offset = 0;
    for (;;) {
        if (offset + BLOCK > tar.length) {
            // A tar ends with zero blocks, but a pack cut off before them still holds everything it listed.
            if (offset < tar.length || entryCount === 0) {
                throw malformed("it is truncated");
            }
            break;
        }
        const header: Buffer = tar.subarray(offset, offset + BLOCK);
        if (header.every((byte) => byte === 0)) {
            break;
        }
        if (!validChecksum(header)) {
            throw malformed("a header's checksum is wrong");
        }
        const size: number | undefined = octal(header, 124, 12);
        if (size === undefined) {
            throw malformed("an entry has an invalid size");
        }
        const type: string = String.fromCharCode(header[156] || 0x30);
        const dataStart: number = offset + BLOCK;
        if (dataStart + size > tar.length) {
            throw malformed("it is truncated");
        }
        const data: Buffer = tar.subarray(dataStart, dataStart + size);
        offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

        if (type === "g") {
            continue;
        }
        if (type === "x" || type === "L") {
            if (size > MAX_META_BYTES) {
                throw malformed("an extended header is too large");
            }
            pendingName = type === "L" ? field(data, 0, data.length) : (paxPath(data) ?? pendingName);
            continue;
        }
        if (type !== "0" && type !== "5") {
            const kind: string = type === "1" ? "a hard link" : type === "2" ? "a symbolic link" : type === "3" || type === "4" ? "a device" : type === "6" ? "a FIFO" : `an unsupported entry (type '${type}')`;
            throw new PackInspectionError(`The pack holds ${kind}, which a plugin pack may not.`);
        }
        const prefix: string = field(header, 345, 155);
        const own: string = field(header, 0, 100);
        const name: string = (pendingName ?? (prefix && header.toString("latin1", 257, 262) === "ustar" ? `${prefix}/${own}` : own)).replace(/\/+$/, "");
        pendingName = undefined;
        checkName(name);

        entryCount++;
        if (entryCount > maxEntries) {
            throw new PackInspectionError(`The pack holds more than ${maxEntries} files.`);
        }
        if (type === "0") {
            unpackedBytes += size;
        }
        if (type === "0" && name === "package/package.json") {
            if (packageJsonText) {
                throw new PackInspectionError("The pack holds more than one package/package.json.");
            }
            if (size > PACK_MAX_PACKAGE_JSON_BYTES) {
                throw new PackInspectionError(`The pack's package.json is larger than ${PACK_MAX_PACKAGE_JSON_BYTES} bytes.`);
            }
            packageJsonText = data;
        }
    }

    if (!packageJsonText) {
        throw new PackInspectionError("The pack has no package/package.json.");
    }
    let packageJson: unknown;
    try {
        packageJson = JSON.parse(packageJsonText.toString("utf8"));
    } catch {
        throw new PackInspectionError("The pack's package.json is not valid JSON.");
    }
    if (typeof packageJson !== "object" || packageJson === null || Array.isArray(packageJson)) {
        throw new PackInspectionError("The pack's package.json must be a JSON object.");
    }
    return { packageJson: packageJson as Record<string, unknown>, entryCount, unpackedBytes };
}
