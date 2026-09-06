///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// No mocking needed - HtmlTextExtractor delegates to the real `html-to-text` library.
import { HtmlTextExtractor } from "../../../src/search/extraction/HtmlTextExtractor.js";

describe("HtmlTextExtractor Tests", () => {
    const extractor = new HtmlTextExtractor();

    it("Advertises the expected MIME types.", () => {
        expect(extractor.mimeTypes).toEqual(["text/html"]);
    });

    it("Strips markup, keeping only rendered text.", async () => {
        const html = "<html><body><h1>Title</h1><p>Some <b>bold</b> text.</p></body></html>";
        const result = await extractor.extract(Buffer.from(html));
        expect(result).toContain("TITLE");
        expect(result).toContain("Some bold text.");
        expect(result).not.toContain("<");
    });

    it("Returns an empty string for empty content.", async () => {
        const result = await extractor.extract(Buffer.alloc(0));
        expect(result).toBe("");
    });
});
