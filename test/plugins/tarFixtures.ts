///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A tiny tar writer for building `npm pack` style fixtures in tests (no tar dependency): `tarOf()` for the archive,
// `gzipTar()` for the .tgz, `packOf()` for a whole plugin pack.
import * as zlib from "zlib";

export interface TarEntry {
    name: string;
    content?: Buffer | string;
    /** The tar type flag: `0` file (default), `5` directory, `1` hard link, `2` symlink, `3`/`4` devices, `6` FIFO, `x` pax, `g` global pax, `L` GNU long name. */
    type?: string;
    linkname?: string;
    /** Writes `name` as a ustar `prefix` + `name` pair (it must split at a `/`). */
    usePrefix?: boolean;
    /** Overrides the size field's text (to build a malformed header). */
    sizeText?: string;
    /** Overrides the checksum field's text (to build a malformed header). */
    checksumText?: string;
}

function put(buffer: Buffer, offset: number, text: string, length: number): void {
    buffer.write(text.slice(0, length), offset, "utf8");
}

/** A pax record: `<length> <key>=<value>\n`, where length counts the whole record. */
export function paxRecord(key: string, value: string): string {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    while (`${length}${body}`.length !== length) {
        length = `${length}${body}`.length;
    }
    return `${length}${body}`;
}

function header(entry: TarEntry, size: number): Buffer {
    const block = Buffer.alloc(512);
    let name = entry.name;
    let prefix = "";
    if (entry.usePrefix) {
        const at = name.lastIndexOf("/");
        prefix = name.slice(0, at);
        name = name.slice(at + 1);
    }
    put(block, 0, name, 100);
    put(block, 100, "0000644\0", 8);
    put(block, 108, "0000000\0", 8);
    put(block, 116, "0000000\0", 8);
    put(block, 124, entry.sizeText ?? `${size.toString(8).padStart(11, "0")}\0`, 12);
    put(block, 136, "00000000000\0", 12);
    block.write("        ", 148, "latin1");
    block.write(entry.type ?? "0", 156, "latin1");
    put(block, 157, entry.linkname ?? "", 100);
    block.write("ustar\0", 257, "latin1");
    block.write("00", 263, "latin1");
    put(block, 345, prefix, 155);
    let sum = 0;
    for (const byte of block) {
        sum += byte;
    }
    put(block, 148, entry.checksumText ?? `${sum.toString(8).padStart(6, "0")}\0 `, 8);
    return block;
}

/** A tar archive of `entries`, ended with the two zero blocks unless `unterminated`. */
export function tarOf(entries: TarEntry[], unterminated = false): Buffer {
    const parts: Buffer[] = [];
    for (const entry of entries) {
        const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? "");
        parts.push(header(entry, content.length), content, Buffer.alloc((512 - (content.length % 512)) % 512));
    }
    if (!unterminated) {
        parts.push(Buffer.alloc(1024));
    }
    return Buffer.concat(parts);
}

export function gzipTar(entries: TarEntry[]): Buffer {
    return zlib.gzipSync(tarOf(entries));
}

/** What `npm pack` produces for a package with this `package.json`, plus `extra` entries. */
export function packOf(packageJson: Record<string, unknown>, extra: TarEntry[] = []): Buffer {
    return gzipTar([
        { name: "package/package.json", content: JSON.stringify(packageJson) },
        { name: "package/dist/index.js", content: "module.exports = {};\n" },
        ...extra,
    ]);
}
