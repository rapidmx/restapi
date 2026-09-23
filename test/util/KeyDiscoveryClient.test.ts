///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests - the global `fetch` is stubbed so no real HTTP call is made (same convention as
// test/scan/RspamdSpamScanProvider.test.ts). The module-level keyCache is shared across every test in this
// file, so each test uses its own unique host/address pair to avoid cross-test interference, same rationale
// as test/util/FederationUtils.test.ts.
import {
    computeKeyDiscoveryHash,
    fetchRemoteKeys,
    isValidKeyDiscoveryHash,
    parseKeyDiscoveryAddress,
    parseKeyDiscoveryResponse,
    zBase32Encode,
} from "../../src/util/KeyDiscoveryClient.js";
import type { KeyDiscoveryResponse } from "../../src/models/types.js";

function makeDiscoveryResponse(overrides: Partial<KeyDiscoveryResponse> = {}): KeyDiscoveryResponse {
    return { encryptPreference: { preferEncrypt: "nopreference" }, keys: [], escrow: false, ...overrides };
}

function makeFetchResponse(overrides: any = {}) {
    const headerValues: Record<string, string> = overrides.headerValues ?? {};
    return {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(makeDiscoveryResponse()),
        headers: { get: (name: string) => headerValues[name.toLowerCase()] ?? null },
        ...overrides,
    };
}

describe("zBase32Encode() Tests", () => {
    it("Encodes a single zero byte to two 'y' characters (5 zero bits, then 3 zero bits padded to 5).", () => {
        expect(zBase32Encode(Buffer.from([0x00]))).toBe("yy");
    });

    it("Encodes a single 0xFF byte to '9h' (11111 -> '9', then 111 padded with two zero bits -> '5' index 28 -> 'h').", () => {
        expect(zBase32Encode(Buffer.from([0xff]))).toBe("9h");
    });

    it("Encodes five 0xFF bytes (40 bits, evenly divisible by 5) to eight '9' characters with no padding.", () => {
        expect(zBase32Encode(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))).toBe("99999999");
    });

    it("Produces no output for an empty buffer.", () => {
        expect(zBase32Encode(Buffer.alloc(0))).toBe("");
    });
});

describe("computeKeyDiscoveryHash() Tests", () => {
    it("Is deterministic for the same local part.", () => {
        expect(computeKeyDiscoveryHash("john.smith")).toBe(computeKeyDiscoveryHash("john.smith"));
    });

    it("Is case-insensitive on the local part (lowercases before hashing).", () => {
        expect(computeKeyDiscoveryHash("John.Smith")).toBe(computeKeyDiscoveryHash("john.smith"));
    });

    it("Produces a different hash for a different local part.", () => {
        expect(computeKeyDiscoveryHash("john.smith")).not.toBe(computeKeyDiscoveryHash("jane.doe"));
    });

    it("Produces a 52-character z-base32 string, matching a 256-bit SHA-256 digest (52 = ceil(256/5)).", () => {
        expect(computeKeyDiscoveryHash("john.smith")).toHaveLength(52);
    });
});

describe("fetchRemoteKeys() Tests", () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("Fetches the correctly-shaped HTTPS URL with no If-None-Match on a first call.", async () => {
        mockFetch.mockResolvedValue(makeFetchResponse());

        await fetchRemoteKeys("mail.example1.com", "alice@example1.com");

        const hash = computeKeyDiscoveryHash("alice");
        expect(mockFetch).toHaveBeenCalledWith(
            `https://mail.example1.com/.well-known/rapidmx/keys/${hash}?domain=example1.com`,
            expect.objectContaining({ headers: {} }),
        );
    });

    it("Returns the parsed JSON body on a 200 response.", async () => {
        const body = makeDiscoveryResponse({ escrow: true });
        mockFetch.mockResolvedValue(makeFetchResponse({ json: vi.fn().mockResolvedValue(body) }));

        const result = await fetchRemoteKeys("mail.example2.com", "alice@example2.com");

        expect(result).toEqual(body);
    });

    it("Sends If-None-Match with the previously cached ETag on a second call.", async () => {
        mockFetch.mockResolvedValue(makeFetchResponse({ headerValues: { etag: '"abc123"' } }));

        await fetchRemoteKeys("mail.example3.com", "alice@example3.com");
        await fetchRemoteKeys("mail.example3.com", "alice@example3.com");

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch.mock.calls[1][1]).toEqual(expect.objectContaining({ headers: { "If-None-Match": '"abc123"' } }));
    });

    it("Returns the cached response on a 304, without re-parsing a body.", async () => {
        const body = makeDiscoveryResponse({ escrow: true });
        const jsonSpy = vi.fn().mockResolvedValue(body);
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: jsonSpy, headerValues: { etag: '"v1"' } }));
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ status: 304, ok: false, json: vi.fn() }));

        await fetchRemoteKeys("mail.example4.com", "alice@example4.com");
        const second = await fetchRemoteKeys("mail.example4.com", "alice@example4.com");

        expect(second).toEqual(body);
        expect(jsonSpy).toHaveBeenCalledTimes(1);
    });

    it("Refreshes the cache entry (including its ETag) from a 304's own Cache-Control header, so a third call still sends the original ETag.", async () => {
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ headerValues: { etag: '"v1"' } }));
        mockFetch.mockResolvedValueOnce(
            makeFetchResponse({ status: 304, ok: false, json: vi.fn(), headerValues: { "cache-control": "max-age=3600" } }),
        );
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ status: 304, ok: false, json: vi.fn() }));

        await fetchRemoteKeys("mail.example5.com", "alice@example5.com");
        await fetchRemoteKeys("mail.example5.com", "alice@example5.com");
        await fetchRemoteKeys("mail.example5.com", "alice@example5.com");

        expect(mockFetch.mock.calls[2][1]).toEqual(expect.objectContaining({ headers: { "If-None-Match": '"v1"' } }));
    });

    it("Falls back to the cached response when a later request returns a non-ok, non-304 status.", async () => {
        const body = makeDiscoveryResponse({ escrow: true });
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue(body) }));
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ ok: false, status: 500 }));

        await fetchRemoteKeys("mail.example6.com", "alice@example6.com");
        const second = await fetchRemoteKeys("mail.example6.com", "alice@example6.com");

        expect(second).toEqual(body);
    });

    it("Falls back to the default TTL when Cache-Control is present but carries no max-age directive.", async () => {
        mockFetch.mockResolvedValue(makeFetchResponse({ headerValues: { "cache-control": "no-transform" } }));

        const result = await fetchRemoteKeys("mail.example11.com", "alice@example11.com");

        expect(result).toEqual(makeDiscoveryResponse());
    });

    it("Returns undefined for a non-ok response with nothing cached yet.", async () => {
        mockFetch.mockResolvedValue(makeFetchResponse({ ok: false, status: 404 }));

        const result = await fetchRemoteKeys("mail.example7.com", "alice@example7.com");

        expect(result).toBeUndefined();
    });

    it("Falls back to the cached response (rather than throwing) when fetch itself rejects.", async () => {
        const body = makeDiscoveryResponse({ escrow: true });
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue(body) }));
        mockFetch.mockRejectedValueOnce(new Error("ECONNRESET"));

        await fetchRemoteKeys("mail.example8.com", "alice@example8.com");
        const second = await fetchRemoteKeys("mail.example8.com", "alice@example8.com");

        expect(second).toEqual(body);
    });

    it("Returns undefined (never throws) when fetch rejects and nothing is cached.", async () => {
        mockFetch.mockRejectedValue(new Error("ECONNRESET"));

        const result = await fetchRemoteKeys("mail.example9.com", "alice@example9.com");

        expect(result).toBeUndefined();
    });

    it("Passes an AbortSignal derived from the configurable timeout.", async () => {
        mockFetch.mockResolvedValue(makeFetchResponse());

        await fetchRemoteKeys("mail.example10.com", "alice@example10.com", { timeoutMs: 5000 });

        expect(mockFetch.mock.calls[0][1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    });

    it("Aborts the request and returns undefined once the configured timeout elapses.", async () => {
        vi.useFakeTimers();
        try {
            mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
                return new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
                });
            });

            const resultPromise = fetchRemoteKeys("mail.example12.com", "alice@example12.com", { timeoutMs: 5000 });
            await vi.advanceTimersByTimeAsync(5000);
            const result = await resultPromise;

            expect(result).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("Rejects an IP-literal host outright, never calling fetch, and falls back to any cached response.", async () => {
        const body = makeDiscoveryResponse({ escrow: true });
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue(body) }));
        await fetchRemoteKeys("mail.example13.com", "alice@example13.com");
        mockFetch.mockClear();

        const result = await fetchRemoteKeys("127.0.0.1", "alice@example13.com");

        expect(mockFetch).not.toHaveBeenCalled();
        // Cache key is derived from `host`, so a different (unsafe) host doesn't collide with the cached entry
        // above - nothing was ever cached for "127.0.0.1" itself.
        expect(result).toBeUndefined();
    });

    it("Rejects a host carrying a path/query/fragment injection attempt, never calling fetch.", async () => {
        const result = await fetchRemoteKeys("evil.example14.com/admin/purge?x=", "alice@example14.com");

        expect(mockFetch).not.toHaveBeenCalled();
        expect(result).toBeUndefined();
    });

    it("Rejects decimal/octal/hex-encoded IP-literal hosts that `net.isIP()` alone doesn't recognize but the WHATWG URL parser (and so `fetch()`) would normalize to a real IP with no DNS lookup.", async () => {
        // `2852039166` (decimal), `0xA9FEA9FE` (hex) and `0251.0376.0251.0376` (octal) all normalize to
        // `169.254.169.254` - the cloud metadata address - via `new URL()`, and `017700000001` (octal)
        // normalizes to the loopback `127.0.0.1`. None of these are recognized as an IP literal by
        // `net.isIP()` on the raw string, so without re-checking the URL-normalized hostname they would
        // sail past the syntax check as "just a hostname".
        for (const host of ["2852039166", "0xA9FEA9FE", "0251.0376.0251.0376", "017700000001"]) {
            const result = await fetchRemoteKeys(host, "alice@numeric-ip-host.example");
            expect(result).toBeUndefined();
        }
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("Reads a real streamed response body and parses it once complete (the non-test-double path).", async () => {
        const body = makeDiscoveryResponse({ escrow: true });
        const encoded = new TextEncoder().encode(JSON.stringify(body));
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (!sent) {
                    controller.enqueue(encoded);
                    sent = true;
                } else {
                    controller.close();
                }
            },
        });
        mockFetch.mockResolvedValueOnce({
            ok: true,
            status: 200,
            body: stream,
            headers: { get: () => null },
        });

        const result = await fetchRemoteKeys("mail.example15.com", "alice@example15.com");

        expect(result).toEqual(body);
    });

    it("Falls back to the cached response when a real streamed body exceeds the maximum allowed size.", async () => {
        const body = makeDiscoveryResponse({ escrow: true });
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue(body) }));
        await fetchRemoteKeys("mail.example16.com", "alice@example16.com");

        const oversized = new Uint8Array(1_000_001);
        let sent = false;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (!sent) {
                    controller.enqueue(oversized);
                    sent = true;
                } else {
                    controller.close();
                }
            },
        });
        mockFetch.mockResolvedValueOnce({ ok: true, status: 200, body: stream, headers: { get: () => null } });

        const second = await fetchRemoteKeys("mail.example16.com", "alice@example16.com");

        expect(second).toEqual(body);
    });
});

describe("isValidKeyDiscoveryHash() Tests", () => {
    it("Accepts a real computeKeyDiscoveryHash() output.", () => {
        expect(isValidKeyDiscoveryHash(computeKeyDiscoveryHash("alice"))).toBe(true);
    });

    it("Rejects the wrong length, characters outside the z-base32 alphabet, operator syntax, and non-strings.", () => {
        const hash = computeKeyDiscoveryHash("alice");
        expect(isValidKeyDiscoveryHash(hash.slice(0, 51))).toBe(false);
        expect(isValidKeyDiscoveryHash(`${hash}y`)).toBe(false);
        // 'l', 'v', '0', '2' are not in the z-base32 alphabet.
        expect(isValidKeyDiscoveryHash(`l${hash.slice(1)}`)).toBe(false);
        expect(isValidKeyDiscoveryHash(`in(${hash.slice(0, 48)})`)).toBe(false);
        expect(isValidKeyDiscoveryHash(undefined)).toBe(false);
        expect(isValidKeyDiscoveryHash(["a"])).toBe(false);
    });
});

describe("parseKeyDiscoveryResponse() Tests", () => {
    const validKey = { publicKey: "QUJD", type: "x509", useType: "encrypt", fingerprint: "fp", notBefore: 0, notAfter: 1 };

    it("Returns a fresh copy containing only known fields for a well-formed response.", () => {
        const result = parseKeyDiscoveryResponse({
            encryptPreference: { preferEncrypt: "mutual", lastSeen: 5, extra: "x" },
            keys: [{ ...validKey, revokedAt: 3, junk: true }],
            escrow: true,
            other: 1,
        });

        expect(result).toEqual({
            encryptPreference: { preferEncrypt: "mutual", lastSeen: 5 },
            keys: [{ ...validKey, revokedAt: 3 }],
            escrow: true,
        });
    });

    it("Keeps a well-formed issuerCertificate and revocationReason, and treats null ones as absent.", () => {
        const issuerCertificate = "A".repeat(16384);
        expect(
            parseKeyDiscoveryResponse({
                encryptPreference: { preferEncrypt: "mutual" },
                keys: [
                    { ...validKey, issuerCertificate, revokedAt: 3, revocationReason: "superseded" },
                    { ...validKey, revokedAt: 4, revocationReason: "compromised" },
                    { ...validKey, issuerCertificate: null, revocationReason: null },
                    // A reason without revokedAt means nothing and isn't kept.
                    { ...validKey, revocationReason: "superseded" },
                ],
                escrow: false,
            })?.keys,
        ).toEqual([
            { ...validKey, issuerCertificate, revokedAt: 3, revocationReason: "superseded" },
            { ...validKey, revokedAt: 4, revocationReason: "compromised" },
            validKey,
            validKey,
        ]);
    });

    it.each([
        ["a non-base64 issuerCertificate", { issuerCertificate: "not base64!" }],
        ["an empty issuerCertificate", { issuerCertificate: "" }],
        ["an issuerCertificate over 16 KB", { issuerCertificate: "A".repeat(16388) }],
        ["a non-string issuerCertificate", { issuerCertificate: 5 }],
        ["an unknown revocationReason", { revokedAt: 3, revocationReason: "lost" }],
    ])("Rejects the whole response for a key with %s.", (_label, fields) => {
        expect(parseKeyDiscoveryResponse({ encryptPreference: { preferEncrypt: "mutual" }, keys: [{ ...validKey, ...fields }], escrow: false })).toBeUndefined();
    });

    it("Treats a null lastSeen/revokedAt as absent.", () => {
        const result = parseKeyDiscoveryResponse({
            encryptPreference: { preferEncrypt: "nopreference", lastSeen: null },
            keys: [{ ...validKey, revokedAt: null }],
            escrow: false,
        });

        expect(result).toEqual({ encryptPreference: { preferEncrypt: "nopreference" }, keys: [validKey], escrow: false });
    });

    it.each([
        ["a non-object body", "nope"],
        ["null", null],
        ["an array body", []],
        ["a missing encryptPreference", { keys: [], escrow: false }],
        ["an unknown preferEncrypt", { encryptPreference: { preferEncrypt: "always" }, keys: [], escrow: false }],
        ["a non-numeric lastSeen", { encryptPreference: { preferEncrypt: "mutual", lastSeen: "5" }, keys: [], escrow: false }],
        ["a non-array keys", { encryptPreference: { preferEncrypt: "mutual" }, keys: {}, escrow: false }],
        ["a non-boolean escrow", { encryptPreference: { preferEncrypt: "mutual" }, keys: [], escrow: "false" }],
        ["a non-object key entry", { encryptPreference: { preferEncrypt: "mutual" }, keys: ["x"], escrow: false }],
        ["an unknown useType", { encryptPreference: { preferEncrypt: "mutual" }, keys: [{ ...validKey, useType: "decode" }], escrow: false }],
        ["an empty publicKey", { encryptPreference: { preferEncrypt: "mutual" }, keys: [{ ...validKey, publicKey: "" }], escrow: false }],
        ["a non-base64 publicKey", { encryptPreference: { preferEncrypt: "mutual" }, keys: [{ ...validKey, publicKey: "QUJD!!" }], escrow: false }],
        ["an oversized publicKey", { encryptPreference: { preferEncrypt: "mutual" }, keys: [{ ...validKey, publicKey: "A".repeat(9000) }], escrow: false }],
        ["a missing type", { encryptPreference: { preferEncrypt: "mutual" }, keys: [{ ...validKey, type: undefined }], escrow: false }],
        ["a non-string fingerprint", { encryptPreference: { preferEncrypt: "mutual" }, keys: [{ ...validKey, fingerprint: 1 }], escrow: false }],
        ["a non-numeric notAfter", { encryptPreference: { preferEncrypt: "mutual" }, keys: [{ ...validKey, notAfter: "1" }], escrow: false }],
        ["a non-numeric revokedAt", { encryptPreference: { preferEncrypt: "mutual" }, keys: [{ ...validKey, revokedAt: "1" }], escrow: false }],
    ])("Rejects %s.", (_label, raw) => {
        expect(parseKeyDiscoveryResponse(raw)).toBeUndefined();
    });
});

describe("fetchRemoteKeys() domain scoping and validation Tests", () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("Sends the lowercased address domain as ?domain= and keeps a separate cache entry per domain for the same host/local part.", async () => {
        const acme = makeDiscoveryResponse({ escrow: true });
        const contoso = makeDiscoveryResponse({ escrow: false });
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue(acme), headerValues: { etag: '"acme"' } }));
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue(contoso), headerValues: { etag: '"contoso"' } }));

        const first = await fetchRemoteKeys("mail.shared-host-1.com", "ceo@Acme-1.com");
        const second = await fetchRemoteKeys("mail.shared-host-1.com", "ceo@contoso-1.com");

        expect(first).toEqual(acme);
        expect(second).toEqual(contoso);
        expect(mockFetch.mock.calls[0][0]).toMatch(/\?domain=acme-1\.com$/);
        expect(mockFetch.mock.calls[1][0]).toMatch(/\?domain=contoso-1\.com$/);
        // The second domain's request must not have been served from (or conditioned on) the first's cache entry.
        expect(mockFetch.mock.calls[1][1]).toEqual(expect.objectContaining({ headers: {} }));
    });

    it("Never fetches for an address with no (or an invalid) domain.", async () => {
        expect(await fetchRemoteKeys("mail.shared-host-2.com", "no-domain")).toBeUndefined();
        expect(await fetchRemoteKeys("mail.shared-host-2.com", "a@bad/domain?x=")).toBeUndefined();
        expect(await fetchRemoteKeys("mail.shared-host-2.com", "a@evil.example@victim.example")).toBeUndefined();
        expect(await fetchRemoteKeys("mail.shared-host-2.com", "@victim.example")).toBeUndefined();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("Accepts a host with a valid port, validating the hostname without the port, and rejects bad ports/IPv6 literals.", async () => {
        mockFetch.mockResolvedValueOnce(makeFetchResponse());
        expect(await fetchRemoteKeys("mail.port-host-1.com:8443", "alice@port-1.com")).toEqual(makeDiscoveryResponse());
        expect(mockFetch.mock.calls[0][0]).toMatch(/^https:\/\/mail\.port-host-1\.com:8443\/\.well-known\/rapidmx\/keys\//);
        mockFetch.mockClear();

        for (const host of ["mail.port-host-2.com:0", "mail.port-host-2.com:65536", "mail.port-host-2.com:84a", "mail.port-host-2.com:", "::1", "127.0.0.1:443", "bad_host.com:443"]) {
            expect(await fetchRemoteKeys(host, "alice@port-2.com")).toBeUndefined();
        }
        expect(mockFetch).not.toHaveBeenCalled();
    });
    it("Never caches or returns a malformed response - falls back to the last good cached response.", async () => {
        const good = makeDiscoveryResponse({ escrow: true });
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue(good), headerValues: { etag: '"good"' } }));
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue({ keys: "nope" }), headerValues: { etag: '"bad"' } }));
        mockFetch.mockResolvedValueOnce(makeFetchResponse({ status: 304, ok: false, json: vi.fn() }));

        await fetchRemoteKeys("mail.example-malformed-1.com", "alice@example-malformed-1.com");
        const second = await fetchRemoteKeys("mail.example-malformed-1.com", "alice@example-malformed-1.com");
        await fetchRemoteKeys("mail.example-malformed-1.com", "alice@example-malformed-1.com");

        expect(second).toEqual(good);
        // Still conditioned on the good response's ETag - the malformed one was never cached.
        expect(mockFetch.mock.calls[2][1]).toEqual(expect.objectContaining({ headers: { "If-None-Match": '"good"' } }));
    });

    it("Returns undefined for a malformed response with nothing cached.", async () => {
        mockFetch.mockResolvedValue(makeFetchResponse({ json: vi.fn().mockResolvedValue({ escrow: "yes" }) }));

        expect(await fetchRemoteKeys("mail.example-malformed-2.com", "alice@example-malformed-2.com")).toBeUndefined();
    });
});

describe("parseKeyDiscoveryAddress() Tests", () => {
    it("Splits a single-@ address, lowercasing the domain only.", () => {
        expect(parseKeyDiscoveryAddress("Alice@Example.COM")).toEqual({ localPart: "Alice", domain: "example.com" });
    });

    it("Rejects no @, multiple @, empty local part/domain, invalid domains, and non-strings.", () => {
        for (const address of ["alice", "a@b@example.com", "@example.com", "alice@", "alice@exa mple.com", "alice@example.com:25"]) {
            expect(parseKeyDiscoveryAddress(address)).toBeUndefined();
        }
        expect(parseKeyDiscoveryAddress(undefined as any)).toBeUndefined();
    });
});
