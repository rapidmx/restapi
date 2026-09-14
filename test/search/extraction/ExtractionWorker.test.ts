///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// runExtractionTask() is the body the extraction worker thread runs; exercised in-process here (the thread bootstrap
// itself only runs inside a worker).
import { runExtractionTask } from "../../../src/search/extraction/ExtractionWorker.js";
import { PlainTextExtractor } from "../../../src/search/extraction/PlainTextExtractor.js";

function task(mimeType: string, text: string, maxOutputChars = 1000): any {
    return { id: 7, mimeType, content: new Uint8Array(Buffer.from(text)), maxOutputChars };
}

describe("runExtractionTask() Tests", () => {
    it("Extracts with the built-in extractor for the MIME type.", async () => {
        await expect(runExtractionTask(task("text/html", "<p>hello</p>"))).resolves.toEqual({ id: 7, ok: true, text: "hello", truncated: false });
    });

    it("Truncates text beyond maxOutputChars.", async () => {
        await expect(runExtractionTask(task("text/plain", "abcdef", 2))).resolves.toEqual({ id: 7, ok: true, text: "ab", truncated: true });
    });

    it("Handles a content view into a larger buffer.", async () => {
        const backing = Buffer.from("XXhelloXX");
        const content = new Uint8Array(backing.buffer, backing.byteOffset + 2, 5);
        await expect(runExtractionTask({ id: 1, mimeType: "text/plain", content, maxOutputChars: 100 })).resolves.toMatchObject({ text: "hello" });
    });

    it("Reports an unknown MIME type as an error result.", async () => {
        await expect(runExtractionTask(task("application/zip", "x"))).resolves.toEqual({ id: 7, ok: false, error: "No extractor for application/zip." });
    });

    it("Reports an extractor failure as an error result, never throwing, and normalizes an undefined result.", async () => {
        const spy = vi.spyOn(PlainTextExtractor.prototype, "extract").mockRejectedValueOnce(new Error("bad")).mockRejectedValueOnce("raw");
        await expect(runExtractionTask(task("text/plain", "x"))).resolves.toEqual({ id: 7, ok: false, error: "bad" });
        await expect(runExtractionTask(task("text/plain", "x"))).resolves.toEqual({ id: 7, ok: false, error: "raw" });
        spy.mockResolvedValueOnce(undefined as any);
        await expect(runExtractionTask(task("text/plain", "x"))).resolves.toEqual({ id: 7, ok: true, text: "", truncated: false });
        spy.mockRestore();
    });
});
