///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests - the global `fetch` is stubbed so no real HTTP call is made (same convention as
// test/scan/RspamdSpamScanProvider.test.ts). The module-level keyCache is shared across every test in this
// file, so each test uses its own unique host/address pair to avoid cross-test interference, same rationale
// as test/util/FederationUtils.test.ts.
import { computeKeyDiscoveryHash, fetchRemoteKeys, zBase32Encode } from "../../src/util/KeyDiscoveryClient.js";
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
            `https://mail.example1.com/.well-known/rapidmx/keys/${hash}`,
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
