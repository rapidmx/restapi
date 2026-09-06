///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for DocxTextExtractor - the optional peer dependency `mammoth` is mocked so no real
// DOCX parsing occurs.
vi.mock("mammoth", () => ({
    extractRawText: vi.fn(),
}));

import * as mammoth from "mammoth";
import { DocxTextExtractor } from "../../../src/search/extraction/DocxTextExtractor.js";

const mockExtractRawText = mammoth.extractRawText as any;

describe("DocxTextExtractor Tests", () => {
    const extractor = new DocxTextExtractor();

    it("Advertises the expected MIME type.", () => {
        expect(extractor.mimeTypes).toEqual([
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ]);
    });

    it("Passes the content buffer to mammoth.extractRawText and returns its extracted value.", async () => {
        const content = Buffer.from("fake-docx-bytes");
        mockExtractRawText.mockResolvedValue({ value: "Extracted DOCX text" });

        const result = await extractor.extract(content);

        expect(mockExtractRawText).toHaveBeenCalledWith({ buffer: content });
        expect(result).toBe("Extracted DOCX text");
    });

    it("Returns an empty string when mammoth reports no value.", async () => {
        mockExtractRawText.mockResolvedValue({});

        const result = await extractor.extract(Buffer.from("x"));

        expect(result).toBe("");
    });

    it("Propagates a rejection from mammoth (corrupt file).", async () => {
        mockExtractRawText.mockRejectedValue(new Error("corrupt DOCX"));

        await expect(extractor.extract(Buffer.from("x"))).rejects.toThrow(/corrupt DOCX/);
    });
});
