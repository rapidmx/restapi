///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// OpenPGP key discovery outside RapidMX: Web Key Directory lookups and `Autocrypt` headers. `fetch` is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOCRYPT_HEADER, buildAutocryptHeader, parseAutocryptHeader } from "../../src/util/AutocryptHeaderUtils.js";
import { readBoundedBytes, setDiscoveryAddressLookup } from "../../src/util/KeyDiscoveryClient.js";
import { discoverAndMergeKeys } from "../../src/util/KeyringUtils.js";
import { selectOpenPgpKeyFor } from "../../src/util/OpenPgpKeyUtils.js";
import { clearWkdCache, fetchWkdKey } from "../../src/util/WkdClient.js";
import { computeWkdHash, isValidWkdHash } from "../../src/util/WkdUtils.js";
import { StaticDnsResolver } from "../testDoubles.js";
import { openPgpKey } from "../openPgpTestKeys.js";

const ADDRESS = "Joe.Doe@proton.example";

describe("WKD hash", () => {
    it("matches the draft's example and lowercases only ASCII letters", () => {
        // draft-koch-openpgp-webkey-service: "Joe.Doe@Example.ORG" -> "iy9q119eutrkn8s1mk4r39qejnbu3n5q".
        expect(computeWkdHash("Joe.Doe")).toBe("iy9q119eutrkn8s1mk4r39qejnbu3n5q");
        expect(isValidWkdHash(computeWkdHash("x"))).toBe(true);
        expect(isValidWkdHash("short")).toBe(false);
        expect(isValidWkdHash(5)).toBe(false);
    });
});

describe("readBoundedBytes()", () => {
    it("reads a body up to its cap, streamed or not, and refuses more", async () => {
        expect((await readBoundedBytes(new Response(new Uint8Array([1, 2, 3])), 3)).length).toBe(3);
        await expect(readBoundedBytes(new Response(new Uint8Array([1, 2, 3])), 2)).rejects.toThrow();
        const unstreamed = (bytes: number[]) => ({ body: null, arrayBuffer: async () => new Uint8Array(bytes).buffer }) as any;
        expect((await readBoundedBytes(unstreamed([1]), 1)).length).toBe(1);
        await expect(readBoundedBytes(unstreamed([1, 2]), 1)).rejects.toThrow();
    });
});

describe("selectOpenPgpKeyFor()", () => {
    it("picks the newest certificate naming the address out of concatenated keys", async () => {
        const older = await openPgpKey(ADDRESS, { created: new Date(Date.now() - 60_000) });
        const newer = await openPgpKey(ADDRESS);
        const stranger = await openPgpKey("someone@proton.example");
        const bundle = new Uint8Array([...older.publicKey.write(), ...stranger.publicKey.write(), ...newer.publicKey.write()]);
        expect(await selectOpenPgpKeyFor(bundle, ADDRESS)).toEqual(newer.key);
        expect(await selectOpenPgpKeyFor(stranger.publicKey.write(), ADDRESS)).toBeUndefined();
        expect(await selectOpenPgpKeyFor(new Uint8Array(), ADDRESS)).toBeUndefined();
        expect(await selectOpenPgpKeyFor(new Uint8Array([1, 2, 3]), ADDRESS)).toBeUndefined();
    });
});

describe("fetchWkdKey()", () => {
    let mockFetch: ReturnType<typeof vi.fn>;
    beforeEach(() => {
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
        setDiscoveryAddressLookup(async () => ["93.184.216.34"]);
        clearWkdCache();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        setDiscoveryAddressLookup();
    });

    it("tries the advanced method, then the direct one, and caches what it found", async () => {
        const key = await openPgpKey(ADDRESS);
        mockFetch.mockResolvedValueOnce(new Response(null, { status: 404 })).mockResolvedValueOnce(new Response(key.publicKey.write()));

        expect(await fetchWkdKey(ADDRESS)).toEqual(key.key);
        const hash = computeWkdHash("Joe.Doe");
        expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
            `https://openpgpkey.proton.example/.well-known/openpgpkey/proton.example/hu/${hash}?l=Joe.Doe`,
            `https://proton.example/.well-known/openpgpkey/hu/${hash}?l=Joe.Doe`,
        ]);
        expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: "error" });
        expect(await fetchWkdKey(ADDRESS)).toEqual(key.key);
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("finds nothing for a failed fetch, an unusable answer, a private host or a bad address, and caches the miss", async () => {
        mockFetch.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response(new Uint8Array([9, 9])));
        expect(await fetchWkdKey("nobody@proton.example")).toBeUndefined();
        expect(await fetchWkdKey("nobody@proton.example")).toBeUndefined();
        expect(mockFetch).toHaveBeenCalledTimes(2);

        setDiscoveryAddressLookup(async () => ["10.0.0.1"]);
        expect(await fetchWkdKey("x@internal.example")).toBeUndefined();
        expect(await fetchWkdKey("not an address")).toBeUndefined();
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("gives up on a directory that doesn't answer in time", async () => {
        mockFetch.mockImplementation(
            (_url: string, init: any) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
        );
        expect(await fetchWkdKey("slow@proton.example", { timeoutMs: 5 })).toBeUndefined();
    });

    it("is how discovery finds the key of an address whose domain isn't a RapidMX peer", async () => {
        const key = await openPgpKey(ADDRESS);
        mockFetch.mockResolvedValue(new Response(key.publicKey.write()));
        const update = await discoverAndMergeKeys(new StaticDnsResolver(), ADDRESS, undefined, Date.now() + 1000);
        expect(update?.keys).toEqual([key.key]);
        expect(update?.encryptPreference).toEqual({ preferEncrypt: "nopreference" });

        clearWkdCache();
        mockFetch.mockResolvedValue(new Response(null, { status: 404 }));
        expect(await discoverAndMergeKeys(new StaticDnsResolver(), ADDRESS, undefined)).toBeUndefined();
    });
});

describe("Autocrypt headers", () => {
    const keydata = "QUJDREVG";

    it("parses one header for the From address, its preference and its unfolded key", () => {
        const parsed = parseAutocryptHeader([`addr=joe@example.com; prefer-encrypt=Mutual; _future=x;; keydata=QUJD REVG;`], "Joe@Example.com");
        expect(parsed).toEqual({
            addr: "joe@example.com",
            preferEncrypt: "mutual",
            publicKey: { publicKey: keydata, type: "openpgp", useType: "encrypt", fingerprint: "", notBefore: 0, notAfter: 0 },
        });
        expect(parseAutocryptHeader([`addr=joe@example.com; keydata=${keydata}`], "joe@example.com")!.preferEncrypt).toBe("nopreference");
    });

    it("ignores anything that breaks the rules", () => {
        const from = "joe@example.com";
        for (const headers of [
            [],
            [`addr=${from}; keydata=${keydata}`, `addr=${from}; keydata=${keydata}`],
            [`addr=other@example.com; keydata=${keydata}`],
            [`addr=${from}`],
            [`keydata=${keydata}`],
            [`addr=${from}; critical=1; keydata=${keydata}`],
            [`addr=${from}; keydata=not*base64`],
            [`addr=${from}; keydata=${"A".repeat(9000)}`],
            [`addr=${from}; =x; keydata=${keydata}`],
            [`garbage`],
        ]) {
            expect(parseAutocryptHeader(headers, from)).toBeUndefined();
        }
    });

    it("builds what it parses", () => {
        const key = { publicKey: "A".repeat(80), type: "openpgp", useType: "encrypt" as const, fingerprint: "f", notBefore: 0, notAfter: 1 };
        const value = buildAutocryptHeader("joe@example.com", "mutual", key);
        expect(AUTOCRYPT_HEADER).toBe("Autocrypt");
        expect(parseAutocryptHeader([value], "joe@example.com")!.publicKey.publicKey).toBe(key.publicKey);
        expect(buildAutocryptHeader("joe@example.com", "nopreference", key)).not.toContain("prefer-encrypt");
    });
});
