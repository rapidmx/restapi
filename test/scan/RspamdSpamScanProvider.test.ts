///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for RspamdSpamScanProvider - the global `fetch` is stubbed so no real HTTP call is made.
import { RspamdSpamScanProvider } from "../../src/scan/RspamdSpamScanProvider.js";
import { SpamVerdict } from "../../src/models/types.js";

function makeEnvelope(overrides: any = {}) {
    return {
        from: "sender@example.com",
        to: ["recipient@example.com"],
        ...overrides,
    };
}

function makeResponse(overrides: any = {}) {
    return {
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({ action: "no action", score: 0, symbols: {} }),
        ...overrides,
    };
}

describe("RspamdSpamScanProvider Tests", () => {
    let provider: RspamdSpamScanProvider;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        provider = new RspamdSpamScanProvider();
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("Posts the raw buffer with From/Rcpt/IP/Helo headers to the checkv2 endpoint.", async () => {
        mockFetch.mockResolvedValue(makeResponse());
        const raw = Buffer.from("raw message content");

        await provider.scoreMessage(raw, makeEnvelope({ remoteIp: "1.2.3.4", helo: "mail.example.com" }));

        expect(mockFetch).toHaveBeenCalledWith(
            "http://127.0.0.1:11333/checkv2",
            expect.objectContaining({
                method: "POST",
                headers: {
                    "Content-Type": "application/octet-stream",
                    From: "sender@example.com",
                    Rcpt: "recipient@example.com",
                    IP: "1.2.3.4",
                    Helo: "mail.example.com",
                },
                body: new Uint8Array(raw),
            }),
        );
    });

    it("Omits Rcpt/IP/Helo headers when not provided.", async () => {
        mockFetch.mockResolvedValue(makeResponse());

        await provider.scoreMessage(Buffer.from("x"), { from: "sender@example.com", to: [] });

        const call = mockFetch.mock.calls[0][1];
        expect(call.headers).toEqual({
            "Content-Type": "application/octet-stream",
            From: "sender@example.com",
        });
    });

    it.each([
        ["reject", SpamVerdict.SPAM],
        ["soft reject", SpamVerdict.SPAM],
        ["add header", SpamVerdict.SUSPECT],
        ["rewrite subject", SpamVerdict.SUSPECT],
        ["greylist", SpamVerdict.SUSPECT],
        ["no action", SpamVerdict.CLEAN],
    ] as const)("Maps rspamd action '%s' to verdict %s.", async (action, expectedVerdict) => {
        mockFetch.mockResolvedValue(
            makeResponse({ json: vi.fn().mockResolvedValue({ action, score: 5, symbols: { FOO: {} } }) }),
        );

        const result = await provider.scoreMessage(Buffer.from("x"), makeEnvelope());

        expect(result.verdict).toBe(expectedVerdict);
        expect(result.score).toBe(5);
        expect(result.symbols).toEqual(["FOO"]);
    });

    it("Defaults symbols to an empty array when the response omits them.", async () => {
        mockFetch.mockResolvedValue(makeResponse({ json: vi.fn().mockResolvedValue({ action: "no action", score: 0 }) }));

        const result = await provider.scoreMessage(Buffer.from("x"), makeEnvelope());

        expect(result.symbols).toEqual([]);
    });

    it("Throws internally (caught) and fails closed to SUSPECT when the HTTP response is not ok.", async () => {
        mockFetch.mockResolvedValue(makeResponse({ ok: false, status: 503 }));

        const result = await provider.scoreMessage(Buffer.from("x"), makeEnvelope());

        expect(result).toEqual({ score: 0, verdict: SpamVerdict.SUSPECT, symbols: ["SCAN_ENGINE_UNAVAILABLE"] });
    });

    it("Fails closed to SUSPECT when fetch itself rejects (engine unreachable).", async () => {
        mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

        const result = await provider.scoreMessage(Buffer.from("x"), makeEnvelope());

        expect(result).toEqual({ score: 0, verdict: SpamVerdict.SUSPECT, symbols: ["SCAN_ENGINE_UNAVAILABLE"] });
    });

    it("Logs the error via the injected logger on failure.", async () => {
        const error = vi.fn();
        (provider as any).logger = { error };
        mockFetch.mockRejectedValue(new Error("boom"));

        await provider.scoreMessage(Buffer.from("x"), makeEnvelope());

        expect(error).toHaveBeenCalledWith(expect.stringContaining("boom"));
    });

    it("Does not throw when no logger is set and the scan fails.", async () => {
        mockFetch.mockRejectedValue(new Error("boom"));

        await expect(provider.scoreMessage(Buffer.from("x"), makeEnvelope())).resolves.toEqual(
            expect.objectContaining({ verdict: SpamVerdict.SUSPECT }),
        );
    });

    it("Aborts the request and fails closed to SUSPECT once the configured timeout elapses.", async () => {
        vi.useFakeTimers();
        try {
            mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
                return new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
                });
            });

            const resultPromise = provider.scoreMessage(Buffer.from("x"), makeEnvelope());
            await vi.advanceTimersByTimeAsync(15_000);
            const result = await resultPromise;

            expect(result).toEqual({ score: 0, verdict: SpamVerdict.SUSPECT, symbols: ["SCAN_ENGINE_UNAVAILABLE"] });
        } finally {
            vi.useRealTimers();
        }
    });
});
