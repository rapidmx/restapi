///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Builds minimal ZIP byte layouts by hand (stored entries, no data needed - only the central directory is read), so
// sizes can be declared freely, including lying/ZIP64 values a real zip library wouldn't produce.
import { inspectZipArchive } from "../../../src/search/extraction/ZipBombGuard.js";

interface FakeEntry {
    name: string;
    compressed?: number;
    uncompressed: number;
}

function buildZip(entries: FakeEntry[], opts: { totalEntries?: number; cdOffset?: number; comment?: string; corruptSignature?: boolean } = {}): Buffer {
    const localPart: Buffer = Buffer.alloc(8, 0); // placeholder "file data" preceding the central directory
    const headers: Buffer[] = entries.map((entry, i) => {
        const name: Buffer = Buffer.from(entry.name);
        const header: Buffer = Buffer.alloc(46 + name.length);
        header.writeUInt32LE(opts.corruptSignature && i === entries.length - 1 ? 0xdeadbeef : 0x02014b50, 0);
        header.writeUInt32LE(entry.compressed ?? 1, 20);
        header.writeUInt32LE(entry.uncompressed, 24);
        header.writeUInt16LE(name.length, 28);
        name.copy(header, 46);
        return header;
    });
    const cd: Buffer = Buffer.concat(headers);
    const comment: Buffer = Buffer.from(opts.comment ?? "");
    const eocd: Buffer = Buffer.alloc(22 + comment.length);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(opts.totalEntries ?? entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(opts.cdOffset ?? localPart.length, 16);
    eocd.writeUInt16LE(comment.length, 20);
    comment.copy(eocd, 22);
    return Buffer.concat([localPart, cd, eocd]);
}

describe("inspectZipArchive() Tests", () => {
    it("Accepts an archive within the declared-size cap and reports totals.", () => {
        const result = inspectZipArchive(buildZip([{ name: "a.xml", uncompressed: 100 }, { name: "b.xml", uncompressed: 50 }], { comment: "hi" }), 1000);
        expect(result).toEqual({ ok: true, entries: 2, declaredUncompressedBytes: 150 });
    });

    it("Rejects an archive whose declared uncompressed total exceeds the cap.", () => {
        const result = inspectZipArchive(buildZip([{ name: "a", uncompressed: 600 }, { name: "b", uncompressed: 600 }]), 1000);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/declared uncompressed size/);
    });

    it("Rejects too-small and non-ZIP content.", () => {
        expect(inspectZipArchive(Buffer.from("tiny"), 1000).reason).toMatch(/too small/);
        expect(inspectZipArchive(Buffer.alloc(100, 1), 1000).reason).toMatch(/no end of central directory/);
    });

    it("Rejects ZIP64 markers in the EOCD and in entries.", () => {
        expect(inspectZipArchive(buildZip([{ name: "a", uncompressed: 1 }], { totalEntries: 0xffff }), 1000).reason).toMatch(/ZIP64/);
        expect(inspectZipArchive(buildZip([{ name: "a", uncompressed: 0xffffffff }]), 0xffffffff * 2).reason).toMatch(/ZIP64/);
        expect(inspectZipArchive(buildZip([{ name: "a", uncompressed: 1, compressed: 0xffffffff }]), 1000).reason).toMatch(/ZIP64/);
        expect(inspectZipArchive(buildZip([{ name: "a", uncompressed: 1 }], { cdOffset: 0xffffffff }), 1000).reason).toMatch(/ZIP64/);
    });

    it("Rejects too many entries.", () => {
        const result = inspectZipArchive(buildZip([{ name: "a", uncompressed: 1 }, { name: "b", uncompressed: 1 }, { name: "c", uncompressed: 1 }]), 1000, 2);
        expect(result.reason).toMatch(/too many entries/);
    });

    it("Rejects a malformed central directory (bad offset, bad signature, entry count beyond the directory).", () => {
        expect(inspectZipArchive(buildZip([{ name: "a", uncompressed: 1 }], { cdOffset: 5000 }), 1000).reason).toMatch(/malformed/);
        expect(inspectZipArchive(buildZip([{ name: "a", uncompressed: 1 }, { name: "b", uncompressed: 1 }], { corruptSignature: true }), 1000).reason).toMatch(
            /malformed/,
        );
        expect(inspectZipArchive(buildZip([{ name: "a", uncompressed: 1 }], { totalEntries: 3 }), 1000).reason).toMatch(/malformed/);
    });
});
