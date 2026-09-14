///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for ExtractorRegistry - its own MIME dispatch/size-cap/timeout orchestration, not the
// concrete extractors' own parsing (covered by their own dedicated test files). Timeout/failure branches
// substitute a fake `TextExtractor` directly into the registry's private `byMimeType` map.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ExtractorRegistry, resolveExtractionWorkerUrl } from "../../../src/search/extraction/ExtractorRegistry.js";
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

describe("ExtractorRegistry output/zip caps (in-process) Tests", () => {
    const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

    it("Truncates extracted text beyond max_output_chars.", async () => {
        const registry = new ExtractorRegistry();
        (registry as any).maxOutputChars = 3;
        (registry as any).logger = { debug: vi.fn(), warn: vi.fn() };
        await expect(registry.extract("text/plain", Buffer.from("abcdef"))).resolves.toBe("abc");
        (registry as any).logger = undefined;
        await expect(registry.extract("text/plain", Buffer.from("ghijkl"))).resolves.toBe("ghi");
    });

    it("Normalizes an extractor resolving undefined to an empty string.", async () => {
        const registry = new ExtractorRegistry();
        (registry as any).byMimeType.set("text/plain", { mimeTypes: ["text/plain"], extract: async () => undefined });
        await expect(registry.extract("text/plain", Buffer.from("x"))).resolves.toBe("");
    });

    it("Skips a DOCX that fails the zip pre-check without calling the extractor.", async () => {
        const registry = new ExtractorRegistry();
        const warn = vi.fn();
        (registry as any).logger = { debug: vi.fn(), warn };
        const extract = vi.fn().mockResolvedValue("never");
        (registry as any).byMimeType.set(DOCX, { mimeTypes: [DOCX], extract });

        await expect(registry.extract(DOCX, Buffer.from("definitely not a zip archive"))).resolves.toBeUndefined();
        expect(extract).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("not a ZIP archive"));

        (registry as any).logger = undefined;
        await expect(registry.extract(DOCX, Buffer.from("still not a zip archive"))).resolves.toBeUndefined();
    });

    it("Passes a DOCX within the declared decompressed cap to the extractor.", async () => {
        const registry = new ExtractorRegistry();
        const extract = vi.fn().mockResolvedValue("docx text");
        (registry as any).byMimeType.set(DOCX, { mimeTypes: [DOCX], extract });
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);

        await expect(registry.extract(DOCX, eocd)).resolves.toBe("docx text");
    });

    it("Runs in-process under vitest (no compiled ExtractionWorker.js next to the TypeScript source).", () => {
        const registry = new ExtractorRegistry();
        expect((registry as any).workerUrl).toBeUndefined();
    });
});

describe("resolveExtractionWorkerUrl() Tests", () => {
    it("Returns the sibling ExtractionWorker.js URL only when that file exists.", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-url-"));
        try {
            const moduleUrl = pathToFileURL(path.join(dir, "ExtractorRegistry.js")).href;
            expect(resolveExtractionWorkerUrl(moduleUrl)).toBeUndefined();
            fs.writeFileSync(path.join(dir, "ExtractionWorker.js"), "");
            expect(resolveExtractionWorkerUrl(moduleUrl)?.href).toBe(pathToFileURL(path.join(dir, "ExtractionWorker.js")).href);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
        expect(resolveExtractionWorkerUrl("https://example.com/lib/ExtractorRegistry.js")).toBeUndefined();
        expect(resolveExtractionWorkerUrl("not a url")).toBeUndefined();
    });
});

// A stand-in worker speaking ExtractionWorker's message protocol, whose behavior is chosen by the content - lets the
// tests below drive the registry's real worker_threads orchestration (termination, heap limits, reuse) without
// needing the compiled ExtractionWorker.js.
const FAKE_WORKER = [
    'import { parentPort } from "node:worker_threads";',
    "parentPort.on(\"message\", (task) => {",
    "    const text = Buffer.from(task.content).toString(\"utf-8\");",
    "    const reply = (msg) => parentPort.postMessage(msg);",
    "    if (text === \"hang\") { for (;;) { Math.random(); } }",
    "    if (text === \"exit\") { process.exit(3); }",
    "    if (text === \"throw\") { throw new Error(\"worker threw\"); }",
    "    if (text === \"oom\") { const keep = []; for (;;) { keep.push(new Array(1e5).fill({ x: Math.random() })); } }",
    "    if (text === \"fail\") { return reply({ id: task.id, ok: false, error: \"boom\" }); }",
    "    if (text === \"fail-noerror\") { return reply({ id: task.id, ok: false }); }",
    "    if (text === \"nontext\") { return reply({ id: task.id, ok: true, text: 42 }); }",
    "    if (text === \"stale\") { reply(null); reply({ id: -1, ok: true, text: \"stale\" }); return reply({ id: task.id, ok: true, text: \"fresh\" }); }",
    "    return reply({ id: task.id, ok: true, text: \"W:\" + text + \":\" + task.maxOutputChars });",
    "});",
].join("\n");

describe("ExtractorRegistry worker isolation Tests", () => {
    let dir: string;
    let workerUrl: URL;
    let registry: ExtractorRegistry;
    let warn: ReturnType<typeof vi.fn>;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "extract-worker-"));
        const file = path.join(dir, "fakeWorker.mjs");
        fs.writeFileSync(file, FAKE_WORKER);
        workerUrl = pathToFileURL(file);
    });

    afterAll(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    beforeEach(() => {
        registry = new ExtractorRegistry();
        warn = vi.fn();
        (registry as any).workerUrl = workerUrl;
        (registry as any).logger = { debug: vi.fn(), warn };
        (registry as any).timeoutMs = 10_000;
    });

    afterEach(async () => {
        await registry.dispose();
    });

    it("Runs built-in extractors in the worker, reusing one worker across serialized concurrent calls.", async () => {
        const results = await Promise.all(["a", "b", "c"].map((t) => registry.extract("text/html", Buffer.from(t))));
        expect(results).toEqual(["W:a:2000000", "W:b:2000000", "W:c:2000000"]);
        expect((registry as any).workerHandle.tasks).toBe(3);
    });

    it("Keeps plain text and custom extractors in-process, and honors isolation=in_process.", async () => {
        await expect(registry.extract("text/plain", Buffer.from("plain"))).resolves.toBe("plain");
        (registry as any).byMimeType.set("text/html", { mimeTypes: ["text/html"], extract: async () => "custom" });
        await expect(registry.extract("text/html", Buffer.from("x"))).resolves.toBe("custom");
        expect((registry as any).workerHandle).toBeUndefined();

        const inProcess = new ExtractorRegistry();
        (inProcess as any).workerUrl = workerUrl;
        (inProcess as any).isolation = "in_process";
        await expect(inProcess.extract("text/html", Buffer.from("<p>hi</p>"))).resolves.toBe("hi");
        expect((inProcess as any).workerHandle).toBeUndefined();
    });

    it("Terminates a CPU-spinning worker on timeout, and the next call gets a fresh worker.", async () => {
        (registry as any).timeoutMs = 1_500;
        await expect(registry.extract("text/html", Buffer.from("hang"))).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
        expect((registry as any).workerHandle).toBeUndefined();

        (registry as any).timeoutMs = 10_000;
        await expect(registry.extract("text/html", Buffer.from("again"))).resolves.toBe("W:again:2000000");
    });

    it("Contains a heap-limit breach (worker resourceLimits) as a failed extraction.", async () => {
        (registry as any).workerMaxOldGenerationMb = 16;
        (registry as any).workerMaxYoungGenerationMb = 4;
        await expect(registry.extract("text/html", Buffer.from("oom"))).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/memory limit|out of memory/i));
    });

    it("Handles a worker that exits, throws, or reports an error.", async () => {
        await expect(registry.extract("text/html", Buffer.from("exit"))).resolves.toBeUndefined();
        expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("exited with code 3"));
        await expect(registry.extract("text/html", Buffer.from("throw"))).resolves.toBeUndefined();
        expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("worker threw"));
        await expect(registry.extract("text/html", Buffer.from("fail"))).resolves.toBeUndefined();
        expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("boom"));
        // An extractor-level error leaves the worker healthy and reusable.
        expect((registry as any).workerHandle).toBeDefined();
        await expect(registry.extract("text/html", Buffer.from("fail-noerror"))).resolves.toBeUndefined();
        expect(warn).toHaveBeenLastCalledWith(expect.stringContaining("unknown extraction error"));
    });

    it("Ignores stale/unrelated messages and normalizes a non-string text.", async () => {
        await expect(registry.extract("text/html", Buffer.from("stale"))).resolves.toBe("fresh");
        await expect(registry.extract("text/html", Buffer.from("nontext"))).resolves.toBe("");
    });

    it("Recycles the worker after max_tasks and after idle_ms.", async () => {
        (registry as any).workerMaxTasks = 1;
        await registry.extract("text/html", Buffer.from("one"));
        expect((registry as any).workerHandle).toBeUndefined();

        (registry as any).workerMaxTasks = 100;
        (registry as any).workerIdleMs = 20;
        await registry.extract("text/html", Buffer.from("two"));
        expect((registry as any).workerHandle).toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect((registry as any).workerHandle).toBeUndefined();
    });

    it("Fails cleanly when the worker cannot be started, and dispose() is safe without a worker.", async () => {
        (registry as any).workerUrl = new URL("https://example.com/worker.js");
        await expect(registry.extract("text/html", Buffer.from("x"))).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalled();
        await expect(registry.dispose()).resolves.toBeUndefined();
    });
});
