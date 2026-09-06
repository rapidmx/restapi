///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for PdfTextExtractor - the optional peer dependency `pdf-parse` is mocked so no real PDF
// parsing occurs.
vi.mock("pdf-parse", () => ({
    default: vi.fn(),
}));

import pdfParse from "pdf-parse";
import { PdfTextExtractor } from "../../../src/search/extraction/PdfTextExtractor.js";

const mockPdfParse = pdfParse as any;

describe("PdfTextExtractor Tests", () => {
    const extractor = new PdfTextExtractor();

    it("Advertises the expected MIME types.", () => {
        expect(extractor.mimeTypes).toEqual(["application/pdf"]);
    });

    it("Passes the content buffer to pdf-parse and returns its extracted text.", async () => {
        const content = Buffer.from("%PDF-fake-content");
        mockPdfParse.mockResolvedValue({ text: "Extracted PDF text" });

        const result = await extractor.extract(content);

        expect(mockPdfParse).toHaveBeenCalledWith(content);
        expect(result).toBe("Extracted PDF text");
    });

    it("Returns an empty string when pdf-parse reports no text.", async () => {
        mockPdfParse.mockResolvedValue({});

        const result = await extractor.extract(Buffer.from("x"));

        expect(result).toBe("");
    });

    it("Propagates a rejection from pdf-parse (corrupt file).", async () => {
        mockPdfParse.mockRejectedValue(new Error("corrupt PDF"));

        await expect(extractor.extract(Buffer.from("x"))).rejects.toThrow(/corrupt PDF/);
    });

    // The `pdfParse.default ?? pdfParse` fallback on the module's non-"default" branch is not exercised here:
    // it is genuinely unreachable via any real module import. A dynamic `import()` always resolves to an ES
    // module namespace object, which is never itself callable, and Node's CJS interop always synthesizes a
    // `.default` pointing at `module.exports` for a CommonJS package like `pdf-parse` - so there is no real
    // shape of the imported value that both lacks `.default` and is directly callable as `parse(content)`.
    // Vitest's own module mocker enforces the same invariant (`vi.mock`/`vi.doMock` factories must return a
    // plain object, never a bare function - see `@vitest/mocker`'s `assertValidExports`), so this fallback
    // can't even be simulated through mocking without fabricating an impossible module shape.
});
