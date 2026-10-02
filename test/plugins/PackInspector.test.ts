///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as zlib from "zlib";
import { inspectPack, PACK_MAX_PACKAGE_JSON_BYTES, PackInspectionError } from "../../src/plugins/PackInspector.js";
import { gzipTar, packOf, paxRecord, TarEntry, tarOf } from "./tarFixtures.js";

const PKG = { name: "@acme/crm-plugin", version: "1.0.0" };
const PACKAGE_JSON: TarEntry = { name: "package/package.json", content: JSON.stringify(PKG) };

/** The message `inspectPack()` refuses `bytes` with. */
async function refusal(bytes: Buffer, limits?: Parameters<typeof inspectPack>[1]): Promise<string> {
    const err: unknown = await inspectPack(bytes, limits).then(
        () => undefined,
        (e) => e,
    );
    expect(err).toBeInstanceOf(PackInspectionError);
    return (err as Error).message;
}

describe("inspectPack", () => {
    it("reads package.json, the entry count and the unpacked size of an npm pack", async () => {
        const pack = packOf(PKG, [{ name: "package/lib", type: "5" }]);
        const result = await inspectPack(pack);
        expect(result.packageJson).toEqual(PKG);
        expect(result.entryCount).toBe(3);
        expect(result.unpackedBytes).toBe(JSON.stringify(PKG).length + "module.exports = {};\n".length);
    });

    it("reads a tar that ends without its zero blocks, a ustar prefix, a pax path and a GNU long name", async () => {
        const long = `package/${"d".repeat(120)}/file.js`;
        const entries: TarEntry[] = [
            { name: "pax", type: "g", content: paxRecord("comment", "abc") },
            PACKAGE_JSON,
            { name: "package/some/dir/a.js", usePrefix: true, content: "a" },
            { name: "PaxHeader", type: "x", content: paxRecord("mtime", "1") + paxRecord("path", long) },
            { name: "ignored", content: "b" },
            { name: "GNUname", type: "L", content: `${long}2\0` },
            { name: "ignored", content: "c" },
            // A pax header without a path names nothing: the entry that follows keeps its own name.
            { name: "package/x", type: "x", content: paxRecord("mtime", "1") },
            { name: "package/y", content: "d" },
        ];
        const result = await inspectPack(zlib.gzipSync(tarOf(entries, true)));
        expect(result.entryCount).toBe(5);
    });

    it("refuses what isn't a gzip file", async () => {
        expect(await refusal(Buffer.from("hello"))).toMatch(/not a gzip archive/);
        expect(await refusal(Buffer.alloc(0))).toMatch(/not a gzip archive/);
        expect(await refusal(Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("garbage garbage garbage")]))).toMatch(/not a valid gzip/);
    });

    it("refuses a gzip bomb, stopping at the output cap", async () => {
        const bomb = zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024));
        expect(bomb.length).toBeLessThan(10 * 1024);
        expect(await refusal(bomb, { maxUnpackedBytes: 1024 * 1024 })).toMatch(/unpacks to more than 1048576 bytes/);
    });

    it("refuses what isn't a tar archive", async () => {
        expect(await refusal(zlib.gzipSync("just some text"))).toMatch(/not a valid tar.*truncated/);
        expect(await refusal(zlib.gzipSync(Buffer.alloc(0)))).toMatch(/truncated/);
        expect(await refusal(zlib.gzipSync(Buffer.alloc(2048, "x")))).toMatch(/checksum/);
        expect(await refusal(gzipTar([{ name: "package/a", content: "a", checksumText: "0000001\0" }]))).toMatch(/checksum/);
        expect(await refusal(gzipTar([{ name: "package/a", content: "a", sizeText: "notanumber\0" }]))).toMatch(/invalid size/);
        const truncated = tarOf([PACKAGE_JSON], true);
        expect(await refusal(zlib.gzipSync(truncated.subarray(0, 520)))).toMatch(/truncated/);
        expect(await refusal(zlib.gzipSync(tarOf([PACKAGE_JSON, { name: "package/a", content: "a" }], true).subarray(0, 1100)))).toMatch(/truncated/);
        expect(await refusal(gzipTar([{ name: "PaxHeader", type: "x", content: "garbage without a length" }]))).toMatch(/malformed extended header/);
        expect(await refusal(gzipTar([{ name: "PaxHeader", type: "x", content: "999 path=x\n" }]))).toMatch(/malformed extended header/);
        expect(await refusal(gzipTar([{ name: "PaxHeader", type: "x", content: "x".repeat(70 * 1024) }]))).toMatch(/extended header is too large/);
    });

    it("refuses links, devices and anything that isn't a file or directory", async () => {
        expect(await refusal(gzipTar([PACKAGE_JSON, { name: "package/a", type: "1", linkname: "package/b" }]))).toMatch(/hard link/);
        expect(await refusal(gzipTar([PACKAGE_JSON, { name: "package/a", type: "2", linkname: "/etc/passwd" }]))).toMatch(/symbolic link/);
        expect(await refusal(gzipTar([PACKAGE_JSON, { name: "package/a", type: "3" }]))).toMatch(/device/);
        expect(await refusal(gzipTar([PACKAGE_JSON, { name: "package/a", type: "4" }]))).toMatch(/device/);
        expect(await refusal(gzipTar([PACKAGE_JSON, { name: "package/a", type: "6" }]))).toMatch(/FIFO/);
        expect(await refusal(gzipTar([PACKAGE_JSON, { name: "package/a", type: "7" }]))).toMatch(/unsupported entry \(type '7'\)/);
    });

    it("refuses entry names that aren't plain paths under package/", async () => {
        for (const name of ["package/../evil.js", "../package/evil.js", "package/a/../../b", "/etc/passwd", "C:/windows/x", "package/a\\b", "evil/index.js", "packages/index.js", "package-x"]) {
            expect(await refusal(gzipTar([PACKAGE_JSON, { name, content: "x" }])), name).toMatch(/entry (outside the package\/ directory|with an unsafe name)/);
        }
        expect(await refusal(gzipTar([PACKAGE_JSON, { name: "package/a\0b".replace("\0", "\u0001"), content: "x" }])).catch(() => "")).toBeDefined();
        // A path set by a pax record is checked just like the header's own.
        expect(await refusal(gzipTar([PACKAGE_JSON, { name: "PaxHeader", type: "x", content: paxRecord("path", "../x") }, { name: "harmless", content: "x" }]))).toMatch(/unsafe name/);
        expect(await refusal(gzipTar([PACKAGE_JSON, { name: "PaxHeader", type: "x", content: paxRecord("path", `package/${"a".repeat(5000)}`) }, { name: "harmless", content: "x" }]))).toMatch(/unsafe name/);
        expect(await refusal(gzipTar([PACKAGE_JSON, { name: "GNUname", type: "L", content: "\0" }, { name: "harmless", content: "x" }]))).toMatch(/unsafe name/);
    });

    it("refuses more entries than allowed", async () => {
        const entries: TarEntry[] = [PACKAGE_JSON, { name: "package/a", content: "a" }, { name: "package/b", content: "b" }];
        expect(await refusal(gzipTar(entries), { maxEntries: 2 })).toMatch(/more than 2 files/);
        expect((await inspectPack(gzipTar(entries), { maxEntries: 3 })).entryCount).toBe(3);
    });

    it("refuses a missing, duplicated, oversized or malformed package.json", async () => {
        expect(await refusal(gzipTar([{ name: "package/index.js", content: "x" }]))).toMatch(/no package\/package\.json/);
        expect(await refusal(gzipTar([PACKAGE_JSON, PACKAGE_JSON]))).toMatch(/more than one package\/package\.json/);
        const big = JSON.stringify({ ...PKG, padding: "x".repeat(PACK_MAX_PACKAGE_JSON_BYTES) });
        expect(await refusal(gzipTar([{ name: "package/package.json", content: big }]))).toMatch(/package\.json is larger than/);
        expect(await refusal(gzipTar([{ name: "package/package.json", content: "{not json" }]))).toMatch(/not valid JSON/);
        expect(await refusal(gzipTar([{ name: "package/package.json", content: "[1, 2]" }]))).toMatch(/must be a JSON object/);
        expect(await refusal(gzipTar([{ name: "package/package.json", content: "null" }]))).toMatch(/must be a JSON object/);
        expect(await refusal(gzipTar([{ name: "package/package.json", type: "5" }]))).toMatch(/no package\/package\.json/);
    });
});
