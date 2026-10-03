///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for how AttachmentExtractionJob obtains its ExtractorRegistry. The registry's
// `@Config("mail:search:extraction:...")` limits and `@Logger` are only populated when the ObjectFactory
// instantiates it, so a registry built with `new` inside the job silently ran on its defaults. Every other
// behavior of the job is exercised against a real database in test/jobs/{mongo,sql}/AttachmentExtractionJob*.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { AttachmentExtractionJob } from "../../src/jobs/AttachmentExtractionJob.js";
import { ExtractorRegistry } from "../../src/search/extraction/ExtractorRegistry.js";
import { InMemoryBlobStore, registerTestDoubles } from "../testDoubles.js";

class TestAttachmentExtractionJob extends AttachmentExtractionJob<any, any> {
    protected attachmentClass: any = class {};
    protected messageClass: any = class {};

    /** Shadows the real `@Init` hook (a subclass member of the same name without the decorator is not run), so the
     * bare test-double classes above never reach a real `RepoUtils`. */
    public async init(): Promise<void> {
        // Intentionally empty
    }
}

describe("AttachmentExtractionJob ExtractorRegistry Tests", () => {
    const outputKey = "mail:search:extraction:max_output_chars";
    let objectFactory: ObjectFactory;
    let previousOutputChars: any;

    beforeEach(() => {
        previousOutputChars = config.get(outputKey);
        config.set(outputKey, 5);
        objectFactory = new ObjectFactory(config, Logger());
        registerTestDoubles(objectFactory);
    });

    afterEach(async () => {
        await objectFactory.destroy();
        config.set(outputKey, previousOutputChars);
    });

    const buildJob = async (): Promise<{ job: TestAttachmentExtractionJob; blobStore: InMemoryBlobStore; update: any }> => {
        const job = await objectFactory.newInstance(TestAttachmentExtractionJob, { name: "default" });
        const blobStore: InMemoryBlobStore = (job as any).blobStore;
        await blobStore.put("attachments/a", Buffer.from("0123456789"));
        const attachment: any = { uid: "att-1", messageUid: "msg-1", mimeType: "text/plain", blobKey: "attachments/a", sizeBytes: 10 };
        const update: any = vi.fn().mockImplementation(async (obj: any) => obj);
        (job as any).attachmentRepo = { find: vi.fn().mockResolvedValue([attachment]), update };
        (job as any).messageRepo = { findOne: vi.fn().mockResolvedValue({ uid: "msg-1", encrypted: false }) };
        return { job, blobStore, update };
    };

    it("Applies the configured extraction limits to the registry it extracts with.", async () => {
        const { job, blobStore, update } = await buildJob();

        await job.run();

        const key: string = update.mock.calls[0][0].extractedTextBlobKey;
        expect((await blobStore.get(key)).toString("utf-8")).toBe("01234");
    });

    it("Uses the registry instance the ObjectFactory manages, with its logger injected.", async () => {
        const { job } = await buildJob();

        const registry: ExtractorRegistry = (job as any).extractorRegistry;
        expect(registry).toBe(objectFactory.getInstance(ExtractorRegistry));
        expect((registry as any).logger).toBeDefined();
    });

    it("Disposes the registry's worker when the ObjectFactory is destroyed.", async () => {
        const { job } = await buildJob();
        const dispose = vi.spyOn((job as any).extractorRegistry, "dispose");

        await objectFactory.destroy();

        expect(dispose).toHaveBeenCalledTimes(1);
    });
});
