///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** Result of `inspectZipArchive()`. */
export interface ZipInspection {
    /** `true` when the archive may be handed to a decompressing extractor. */
    ok: boolean;
    /** Why `ok` is `false`. */
    reason?: string;
    entries: number;
    /** Sum of the uncompressed sizes the central directory declares. */
    declaredUncompressedBytes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;

/**
 * Pre-flight check for ZIP-container formats (DOCX) before a decompressing extractor (`mammoth`/JSZip) inflates them
 * in memory: walks the central directory and rejects archives that declare more than `maxUncompressedBytes` in total,
 * more than `maxEntries` entries, use ZIP64 (never needed for attachments within the extraction size cap), or can't be
 * parsed. Declared sizes can lie, so this is one layer only - the worker heap limit and extraction timeout in
 * `ExtractorRegistry` bound what gets past it.
 */
export function inspectZipArchive(content: Buffer, maxUncompressedBytes: number, maxEntries: number = 10_000): ZipInspection {
    const fail = (reason: string, entries = 0, declared = 0): ZipInspection => ({ ok: false, reason, entries, declaredUncompressedBytes: declared });
    if (content.length < EOCD_MIN_SIZE) {
        return fail("not a ZIP archive (too small)");
    }

    // The end-of-central-directory record sits at the very end, followed by an up-to-65535-byte comment.
    let eocd = -1;
    const searchStart: number = Math.max(0, content.length - (EOCD_MIN_SIZE + 0xffff));
    for (let i = content.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
        if (content.readUInt32LE(i) === EOCD_SIGNATURE) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        return fail("not a ZIP archive (no end of central directory)");
    }

    const totalEntries: number = content.readUInt16LE(eocd + 10);
    const cdSize: number = content.readUInt32LE(eocd + 12);
    const cdOffset: number = content.readUInt32LE(eocd + 16);
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        return fail("ZIP64 archives are not extracted");
    }
    if (totalEntries > maxEntries) {
        return fail(`too many entries (${totalEntries} > ${maxEntries})`, totalEntries);
    }
    if (cdOffset + cdSize > eocd) {
        return fail("malformed central directory");
    }

    let offset: number = cdOffset;
    let declared = 0;
    for (let n = 0; n < totalEntries; n++) {
        if (offset + CENTRAL_HEADER_SIZE > eocd || content.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
            return fail("malformed central directory", n, declared);
        }
        const compressed: number = content.readUInt32LE(offset + 20);
        const uncompressed: number = content.readUInt32LE(offset + 24);
        if (compressed === 0xffffffff || uncompressed === 0xffffffff) {
            return fail("ZIP64 archives are not extracted", n, declared);
        }
        declared += uncompressed;
        if (declared > maxUncompressedBytes) {
            return fail(`declared uncompressed size exceeds ${maxUncompressedBytes} bytes`, n + 1, declared);
        }
        const nameLength: number = content.readUInt16LE(offset + 28);
        const extraLength: number = content.readUInt16LE(offset + 30);
        const commentLength: number = content.readUInt16LE(offset + 32);
        offset += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    }
    return { ok: true, entries: totalEntries, declaredUncompressedBytes: declared };
}
