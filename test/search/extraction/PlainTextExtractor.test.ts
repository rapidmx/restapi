///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// No mocking needed - PlainTextExtractor just decodes a Buffer as UTF-8.
import { PlainTextExtractor } from "../../../src/search/extraction/PlainTextExtractor.js";

describe("PlainTextExtractor Tests", () => {
    const extractor = new PlainTextExtractor();

    it("Advertises the expected MIME types.", () => {
        expect(extractor.mimeTypes).toEqual(["text/plain", "text/csv", "text/markdown"]);
    });

    it("Decodes plain UTF-8 content unchanged.", async () => {
        const result = await extractor.extract(Buffer.from("Hello, world!"));
        expect(result).toBe("Hello, world!");
    });

    it("Decodes multi-byte UTF-8 characters correctly.", async () => {
        const result = await extractor.extract(Buffer.from("café — naïve", "utf-8"));
        expect(result).toBe("café — naïve");
    });

    it("Returns an empty string for empty content.", async () => {
        const result = await extractor.extract(Buffer.alloc(0));
        expect(result).toBe("");
    });
});
