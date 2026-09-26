///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for RspamdSpamScanProvider.learn() - the global `fetch` is stubbed so no real HTTP call is made.
import { RspamdSpamScanProvider } from "../../src/scan/RspamdSpamScanProvider.js";

describe("RspamdSpamScanProvider.learn() Tests", () => {
    let provider: RspamdSpamScanProvider;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        provider = new RspamdSpamScanProvider();
        mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("Posts the raw message to the controller's /learnspam on port 11334 (the scan worker's host), with no password header by default.", async () => {
        const raw = Buffer.from("raw message content");

        await provider.learn(raw, "spam");

        expect(mockFetch).toHaveBeenCalledWith(
            "http://127.0.0.1:11334/learnspam",
            expect.objectContaining({
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: new Uint8Array(raw),
            }),
        );
    });

    it("Posts ham to /learnham.", async () => {
        await provider.learn(Buffer.from("x"), "ham");

        expect(mockFetch.mock.calls[0][0]).toBe("http://127.0.0.1:11334/learnham");
    });

    it("Derives the controller URL from the scan URL's host, whatever its scheme, path or port.", async () => {
        (provider as any).url = "https://rspamd.mail.svc:11333/some/path/";

        await provider.learn(Buffer.from("x"), "spam");

        expect(mockFetch.mock.calls[0][0]).toBe("https://rspamd.mail.svc:11334/learnspam");
    });

    it("Uses the configured controller URL as given (a trailing slash removed) instead.", async () => {
        (provider as any).controllerUrl = "  http://controller.internal:8080/  ";

        await provider.learn(Buffer.from("x"), "spam");

        expect(mockFetch.mock.calls[0][0]).toBe("http://controller.internal:8080/learnspam");
        expect(provider.controllerBaseUrl()).toBe("http://controller.internal:8080");
    });

    it("Sends the controller password as the Password header, and the reporting mailbox as Deliver-To.", async () => {
        (provider as any).controllerPassword = "s3cret";

        await provider.learn(Buffer.from("x"), "ham", { recipient: "me@example.com" });

        expect(mockFetch.mock.calls[0][1].headers).toEqual({
            "Content-Type": "application/octet-stream",
            Password: "s3cret",
            "Deliver-To": "me@example.com",
        });
    });

    it("Counts any 2xx as success - rspamd answers a message it already learned with 208.", async () => {
        mockFetch.mockResolvedValue({ ok: true, status: 208 });

        await expect(provider.learn(Buffer.from("x"), "spam")).resolves.toBeUndefined();
    });

    it("Rejects on a non-2xx answer (a wrong password is 403), naming the status but never the password.", async () => {
        (provider as any).controllerPassword = "s3cret";
        mockFetch.mockResolvedValue({ ok: false, status: 403 });

        const failure: Error = await provider.learn(Buffer.from("x"), "spam").catch((err) => err);

        expect(failure.message).toBe("rspamd controller returned HTTP 403");
        expect(failure.message).not.toContain("s3cret");
    });

    it("Rejects when the controller is unreachable.", async () => {
        mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

        await expect(provider.learn(Buffer.from("x"), "spam")).rejects.toThrow("ECONNREFUSED");
    });

    it("Rejects for a scan URL that is not a URL, when no controller URL is configured.", async () => {
        (provider as any).url = "not a url";

        await expect(provider.learn(Buffer.from("x"), "spam")).rejects.toThrow();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("Aborts the request once the controller timeout elapses.", async () => {
        vi.useFakeTimers();
        try {
            mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
                return new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
                });
            });

            const outcome: Promise<Error> = provider.learn(Buffer.from("x"), "spam").catch((err) => err);
            await vi.advanceTimersByTimeAsync(10_000);

            expect((await outcome).message).toBe("The operation was aborted");
        } finally {
            vi.useRealTimers();
        }
    });
});
