///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * `worker_threads` entry point used by `ExtractorRegistry` to run the built-in extractors (HTML/PDF/DOCX) in an
 * isolated, heap-limited thread that can be terminated on timeout. Deliberately not re-exported from
 * `search/index.ts` - an internal module.
 *
 * Protocol: the parent posts `ExtractionTask` messages one at a time; the worker answers each with an
 * `ExtractionResult` carrying the same `id`. The worker is long-lived (reused across tasks) until the parent
 * terminates it.
 */
import { isMainThread, parentPort } from "node:worker_threads";
import { DocxTextExtractor } from "./DocxTextExtractor.js";
import { HtmlTextExtractor } from "./HtmlTextExtractor.js";
import { PdfTextExtractor } from "./PdfTextExtractor.js";
import { PlainTextExtractor } from "./PlainTextExtractor.js";
import type { TextExtractor } from "./TextExtractor.js";

export interface ExtractionTask {
    id: number;
    mimeType: string;
    content: Uint8Array;
    maxOutputChars: number;
}

export type ExtractionResult = { id: number; ok: true; text: string; truncated: boolean } | { id: number; ok: false; error: string };

const extractors: TextExtractor[] = [new PlainTextExtractor(), new HtmlTextExtractor(), new PdfTextExtractor(), new DocxTextExtractor()];

/** Runs one extraction task with the built-in extractors, never throwing. */
export async function runExtractionTask(task: ExtractionTask): Promise<ExtractionResult> {
    const extractor: TextExtractor | undefined = extractors.find((candidate) => candidate.mimeTypes.includes(task.mimeType));
    try {
        if (!extractor) {
            throw new Error(`No extractor for ${task.mimeType}.`);
        }
        const buffer: Buffer = Buffer.from(task.content.buffer, task.content.byteOffset, task.content.byteLength);
        const text: string = (await extractor.extract(buffer)) ?? "";
        const truncated: boolean = text.length > task.maxOutputChars;
        return { id: task.id, ok: true, text: truncated ? text.slice(0, task.maxOutputChars) : text, truncated };
    } catch (err: any) {
        return { id: task.id, ok: false, error: String(err?.message ?? err) };
    }
}

/* v8 ignore start -- only runs inside a worker thread, which vitest's coverage doesn't instrument (under vitest the
   registry falls back to in-process extraction); verified against the built JS, see ExtractorRegistry's doc comment. */
if (!isMainThread && parentPort) {
    const port = parentPort;
    port.on("message", (task: ExtractionTask) => {
        void runExtractionTask(task).then((result) => port.postMessage(result));
    });
}
/* v8 ignore stop */
