///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for ExtractorRegistry - its own MIME dispatch/size-cap/timeout orchestration, not the
// concrete extractors' own parsing (covered by their own dedicated test files). Timeout/failure branches
// substitute a fake `TextExtractor` directly into the registry's private `byMimeType` map.
import { ExtractorRegistry } from "../../../src/search/extraction/ExtractorRegistry.js";
import type { TextExtractor } from "../../../src/search/extraction/TextExtractor.js";

describe("ExtractorRegistry Tests", () => {
    let registry: ExtractorRegistry;

    beforeEach(() => {
        registry = new ExtractorRegistry();
    });

    it("Dispatches to the registered extractor for a known MIME type.", async () => {
        const result = await registry.extract("text/plain", Buffer.from("hello"));
        expect(result).toBe("hello");
    });

    it("Dispatches text/html to HtmlTextExtractor.", async () => {
        const result = await registry.extract("text/html", Buffer.from("<p>hi</p>"));
        expect(result).toBe("hi");
    });

    it("Returns undefined for an unsupported MIME type, without error.", async () => {
        const result = await registry.extract("application/zip", Buffer.from("x"));
        expect(result).toBeUndefined();
    });

    it("Skips extraction when content exceeds the configured size cap, without error.", async () => {
        (registry as any).maxBytes = 4;
        const result = await registry.extract("text/plain", Buffer.from("this is too long"));
        expect(result).toBeUndefined();
    });

    it("Allows content exactly at the size cap.", async () => {
        (registry as any).maxBytes = 5;
        const result = await registry.extract("text/plain", Buffer.from("12345"));
        expect(result).toBe("12345");
    });

    it("Returns undefined (not a throw) when the timeout elapses before extract() resolves.", async () => {
        (registry as any).timeoutMs = 10;
        const hangingExtractor: TextExtractor = {
            mimeTypes: ["text/plain"],
            extract: () => new Promise<string>(() => undefined), // never resolves
        };
        (registry as any).byMimeType.set("text/plain", hangingExtractor);

        const result = await registry.extract("text/plain", Buffer.from("hello"));

        expect(result).toBeUndefined();
    });

    it("Returns undefined (not a throw) when the extractor's promise rejects.", async () => {
        const throwingExtractor: TextExtractor = {
            mimeTypes: ["text/plain"],
            extract: () => Promise.reject(new Error("corrupt content")),
        };
        (registry as any).byMimeType.set("text/plain", throwingExtractor);

        const result = await registry.extract("text/plain", Buffer.from("hello"));

        expect(result).toBeUndefined();
    });

    it("Logs a warning (via the injected logger) when extraction fails.", async () => {
        const warn = vi.fn();
        (registry as any).logger = { debug: vi.fn(), warn };
        const throwingExtractor: TextExtractor = {
            mimeTypes: ["text/plain"],
            extract: () => Promise.reject(new Error("corrupt content")),
        };
        (registry as any).byMimeType.set("text/plain", throwingExtractor);

        await registry.extract("text/plain", Buffer.from("hello"));

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupt content"));
    });

    it("Does not throw when no logger is set and the size cap is exceeded.", async () => {
        (registry as any).maxBytes = 1;
        await expect(registry.extract("text/plain", Buffer.from("too big"))).resolves.toBeUndefined();
    });
});
