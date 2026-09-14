///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { ObjectDecorators } from "@rapidrest/core";
import { DocxTextExtractor } from "./DocxTextExtractor.js";
import { HtmlTextExtractor } from "./HtmlTextExtractor.js";
import { PdfTextExtractor } from "./PdfTextExtractor.js";
import { PlainTextExtractor } from "./PlainTextExtractor.js";
import { TextExtractor } from "./TextExtractor.js";
import { inspectZipArchive } from "./ZipBombGuard.js";
const { Config, Logger } = ObjectDecorators;

const noop = (): void => undefined;

/** MIME types whose content is a ZIP container that a decompressing extractor inflates in memory. */
const ZIP_CONTAINER_MIME_TYPES: Set<string> = new Set(["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);

/** Built-in extractor classes the worker entry point (`ExtractionWorker`) knows how to run itself. */
const WORKER_CAPABLE_EXTRACTORS: Function[] = [HtmlTextExtractor, PdfTextExtractor, DocxTextExtractor];

/**
 * Resolves the compiled worker entry that sits next to this module (`dist/lib/search/extraction/ExtractionWorker.js`).
 * Under vitest this module is loaded from its `.ts` source, where no sibling `.js` exists - `undefined` then, and
 * extraction falls back to running in-process (see `ExtractorRegistry`).
 */
export function resolveExtractionWorkerUrl(moduleUrl: string): URL | undefined {
    try {
        const url = new URL("./ExtractionWorker.js", moduleUrl);
        return url.protocol === "file:" && existsSync(fileURLToPath(url)) ? url : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Dispatches attachment content to the `TextExtractor` registered for its MIME type, applying a size cap, timeout and
 * output cap so a single huge or pathological attachment cannot stall or exhaust `AttachmentExtractionJob`.
 *
 * Isolation: the built-in HTML/PDF/DOCX extractors run in a `worker_threads` worker with V8 `resourceLimits`
 * (`mail:search:extraction:worker:*`); on timeout, a crash or a heap-limit breach the worker is terminated, which
 * actually stops runaway CPU work (a `Promise.race()` timeout alone only stops waiting for it). One worker is reused
 * for up to `worker:max_tasks` tasks (tasks are serialized onto it) and terminated after `worker:idle_ms` idle, since
 * starting one costs ~1s (it loads the extractor modules and their `@rapidrest/*` imports). Call `dispose()` to stop it
 * early; the idle worker is `unref()`ed, so it never keeps the process alive. ZIP-container formats (DOCX) are pre-checked by
 * `inspectZipArchive()` against `max_decompressed_bytes` before any inflation. Extracted text beyond
 * `max_output_chars` is truncated.
 *
 * Fallback: the worker needs the compiled `ExtractionWorker.js` next to this module, which exists in the built package
 * but not when running from TypeScript source (vitest). When it's missing, when `mail:search:extraction:isolation` is
 * `"in_process"`, or for a custom (non-built-in) extractor, extraction runs in-process with the same size/zip/output
 * caps and a best-effort timeout (which cannot interrupt synchronous CPU work).
 *
 * Residual limits: V8 `resourceLimits` bound the JS heap, not `ArrayBuffer`/native memory, so an inflation that lies
 * about its declared size is bounded only by the timeout (and the zip pre-check).
 *
 * @author Jean-Philippe Steinmetz
 */
export class ExtractorRegistry {
    @Config("mail:search:extraction:max_bytes", 25 * 1024 * 1024)
    private maxBytes: number = 25 * 1024 * 1024;

    @Config("mail:search:extraction:timeout_ms", 30_000)
    private timeoutMs: number = 30_000;

    /** Extracted text longer than this is truncated before indexing. */
    @Config("mail:search:extraction:max_output_chars", 2_000_000)
    private maxOutputChars: number = 2_000_000;

    /** Cap on the total uncompressed size a ZIP-container attachment (DOCX) may declare. */
    @Config("mail:search:extraction:max_decompressed_bytes", 100 * 1024 * 1024)
    private maxDecompressedBytes: number = 100 * 1024 * 1024;

    /** `"worker"` (default) or `"in_process"`. */
    @Config("mail:search:extraction:isolation", "worker")
    private isolation: string = "worker";

    @Config("mail:search:extraction:worker:max_old_generation_mb", 512)
    private workerMaxOldGenerationMb: number = 512;

    @Config("mail:search:extraction:worker:max_young_generation_mb", 64)
    private workerMaxYoungGenerationMb: number = 64;

    @Config("mail:search:extraction:worker:stack_size_mb", 4)
    private workerStackSizeMb: number = 4;

    /** Tasks one worker runs before it is recycled. */
    @Config("mail:search:extraction:worker:max_tasks", 100)
    private workerMaxTasks: number = 100;

    /** An idle worker is terminated after this long. */
    @Config("mail:search:extraction:worker:idle_ms", 60_000)
    private workerIdleMs: number = 60_000;

    @Logger
    private logger: any;

    private workerHandle?: { worker: Worker; tasks: number; idleTimer?: NodeJS.Timeout };
    private workerQueue: Promise<unknown> = Promise.resolve();
    private taskSeq = 0;

    /** The worker entry point; `undefined` means in-process only. Overridable for tests. */
    private workerUrl: URL | undefined = resolveExtractionWorkerUrl(import.meta.url);

    private extractors: TextExtractor[] = [
        new PlainTextExtractor(),
        new HtmlTextExtractor(),
        new PdfTextExtractor(),
        new DocxTextExtractor(),
    ];

    private byMimeType: Map<string, TextExtractor> = new Map(
        this.extractors.flatMap((extractor) => extractor.mimeTypes.map((mimeType) => [mimeType, extractor])),
    );

    /**
     * Extracts text from `content` if a `TextExtractor` is registered for `mimeType` and `content` is within
     * the configured size cap, otherwise returns `undefined` without error (an unsupported/oversized
     * attachment simply isn't indexed by content — its filename is still searchable via the entity itself).
     */
    public async extract(mimeType: string, content: Buffer): Promise<string | undefined> {
        const extractor: TextExtractor | undefined = this.byMimeType.get(mimeType);
        if (!extractor) {
            return undefined;
        }

        if (content.length > this.maxBytes) {
            this.logger?.debug(`Skipping text extraction for ${mimeType}: content exceeds ${this.maxBytes} bytes.`);
            return undefined;
        }

        if (ZIP_CONTAINER_MIME_TYPES.has(mimeType)) {
            const inspection = inspectZipArchive(content, this.maxDecompressedBytes);
            if (!inspection.ok) {
                this.logger?.warn(`Skipping text extraction for ${mimeType}: ${inspection.reason}.`);
                return undefined;
            }
        }

        try {
            const text: string = this.useWorker(extractor)
                ? await this.extractInWorker(mimeType, content)
                : await this.extractInProcess(extractor, mimeType, content);
            if (text.length > this.maxOutputChars) {
                this.logger?.debug(`Truncating extracted text for ${mimeType} to ${this.maxOutputChars} characters.`);
                return text.slice(0, this.maxOutputChars);
            }
            return text;
        } catch (err: any) {
            this.logger?.warn(`Text extraction failed for ${mimeType}: ${err.message}`);
            return undefined;
        }
    }

    private useWorker(extractor: TextExtractor): boolean {
        return (
            this.isolation !== "in_process" &&
            this.workerUrl !== undefined &&
            WORKER_CAPABLE_EXTRACTORS.some((cls) => extractor.constructor === cls)
        );
    }

    private async extractInProcess(extractor: TextExtractor, mimeType: string, content: Buffer): Promise<string> {
        let timeoutHandle: NodeJS.Timeout | undefined;
        try {
            return (
                (await Promise.race([
                    extractor.extract(content),
                    new Promise<string>((_resolve, reject) => {
                        timeoutHandle = setTimeout(
                            () => reject(new Error(`Text extraction for ${mimeType} timed out after ${this.timeoutMs}ms.`)),
                            this.timeoutMs,
                        );
                    }),
                ])) ?? ""
            );
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    /** Terminates the extraction worker, if one is running. Safe to call at any time; a later `extract()` starts a new one. */
    public async dispose(): Promise<void> {
        const handle = this.workerHandle;
        if (handle) {
            this.discardWorker(handle);
        }
    }

    private extractInWorker(mimeType: string, content: Buffer): Promise<string> {
        // Serialized: the worker handles one task at a time, and each task's timeout starts when it actually runs.
        const run: Promise<string> = this.workerQueue.then(() => this.runInWorker(mimeType, content));
        this.workerQueue = run.catch(noop);
        return run;
    }

    private acquireWorker(): { worker: Worker; tasks: number; idleTimer?: NodeJS.Timeout } {
        let handle = this.workerHandle;
        if (!handle) {
            const worker = new Worker(this.workerUrl!, {
                resourceLimits: {
                    maxOldGenerationSizeMb: this.workerMaxOldGenerationMb,
                    maxYoungGenerationSizeMb: this.workerMaxYoungGenerationMb,
                    stackSizeMb: this.workerStackSizeMb,
                },
            });
            worker.unref();
            // A late error on an idle/discarded worker must never become an unhandled 'error' event.
            worker.on("error", noop);
            handle = { worker, tasks: 0 };
            this.workerHandle = handle;
        }
        clearTimeout(handle.idleTimer);
        handle.idleTimer = undefined;
        return handle;
    }

    private releaseWorker(handle: { worker: Worker; tasks: number; idleTimer?: NodeJS.Timeout }): void {
        if (handle.tasks >= this.workerMaxTasks) {
            this.discardWorker(handle);
            return;
        }
        handle.idleTimer = setTimeout(() => this.discardWorker(handle), this.workerIdleMs);
        handle.idleTimer.unref();
    }

    private discardWorker(handle: { worker: Worker; tasks: number; idleTimer?: NodeJS.Timeout }): void {
        clearTimeout(handle.idleTimer);
        if (this.workerHandle === handle) {
            this.workerHandle = undefined;
        }
        void handle.worker.terminate().catch(noop);
    }

    private runInWorker(mimeType: string, content: Buffer): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const id: number = ++this.taskSeq;
            let handle: { worker: Worker; tasks: number; idleTimer?: NodeJS.Timeout } | undefined;
            let timeoutHandle: NodeJS.Timeout | undefined;
            // Every listener and the timer are removed synchronously on the first outcome, so each path settles once.
            const cleanup = (): void => {
                clearTimeout(timeoutHandle);
                handle?.worker.off("message", onMessage);
                handle?.worker.off("error", onError);
                handle?.worker.off("exit", onExit);
            };
            const fail = (err: Error): void => {
                cleanup();
                if (handle) {
                    this.discardWorker(handle);
                }
                reject(err);
            };
            const onMessage = (result: any): void => {
                if (result?.id !== id) {
                    return;
                }
                cleanup();
                this.releaseWorker(handle!);
                if (result.ok) {
                    resolve(typeof result.text === "string" ? result.text : "");
                } else {
                    reject(new Error(String(result.error ?? "unknown extraction error")));
                }
            };
            const onError = (err: Error): void => fail(err);
            const onExit = (code: number): void => fail(new Error(`Extraction worker exited with code ${code} before responding.`));

            try {
                handle = this.acquireWorker();
                handle.tasks++;
                handle.worker.on("message", onMessage);
                handle.worker.on("error", onError);
                handle.worker.on("exit", onExit);
                timeoutHandle = setTimeout(
                    () => fail(new Error(`Text extraction for ${mimeType} timed out after ${this.timeoutMs}ms.`)),
                    this.timeoutMs,
                );
                // Copy into a standalone buffer (`content` may view a larger pooled ArrayBuffer) and transfer it.
                const bytes: Uint8Array = new Uint8Array(content.byteLength);
                bytes.set(content);
                handle.worker.postMessage({ id, mimeType, content: bytes, maxOutputChars: this.maxOutputChars }, [bytes.buffer as ArrayBuffer]);
            } catch (err: any) {
                fail(err);
            }
        });
    }
}
