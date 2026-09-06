///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { ExtractorRegistry } from "../search/extraction/ExtractorRegistry.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { Attachment, Message } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/**
 * Runs `ExtractorRegistry` (PDF/DOCX/plain-text/HTML text extraction) over `Attachment` records that haven't
 * been processed yet (`extractedTextBlobKey` unset), as a background job — never inline on ingestion, since
 * extraction can be slow and must not block SMTP-ACK or webmail send/save-draft latency (see the architecture
 * plan's rationale for this).
 *
 * Every eligible attachment gets `extractedTextBlobKey` set exactly once, even when nothing extractable was
 * found (an empty-content blob) — this is what marks an attachment as "already attempted" so an unsupported
 * MIME type (e.g. an image) isn't re-selected by this job forever. When extraction *does* produce non-empty
 * text for an attachment whose parent `Message` was already search-indexed, this job clears that message's
 * `searchIndexedAt` back to `undefined` so `SearchIndexJob` re-indexes it with the newly available text.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class AttachmentExtractionJob<A extends Attachment, M extends Message> extends BackgroundService {
    protected abstract attachmentClass: any;
    protected abstract messageClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private attachmentRepo?: RepoUtils<A>;
    private messageRepo?: RecoverableRepoUtils<M>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    private extractorRegistry: ExtractorRegistry = new ExtractorRegistry();

    @Config("mail:jobs:attachment_extraction:schedule", "*/20 * * * * *")
    private scheduleExpr: string = "*/20 * * * * *";

    @Config("mail:jobs:attachment_extraction:batch_size", 25)
    private batchSize: number = 25;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.attachmentRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.attachmentClass.name,
            args: [this.attachmentClass],
        });
        this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.attachmentRepo || !this.blobStore) {
            return;
        }

        // `limit` must be passed both via `options` (used by the Mongo backend) *and* baked into the query
        // object itself (all `ModelUtils.buildSearchQuerySQL` reads - it ignores `options.limit` entirely and
        // falls back to its own default of 100 otherwise). Confirmed by real-database testing: on the SQL
        // backend, `options.limit` alone silently caps at 100 regardless of the configured batch size.
        const pending: A[] = await this.attachmentRepo.find(
            { extractedTextBlobKey: null, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const attachment of pending) {
            try {
                await this.processAttachment(attachment);
            } catch (err: any) {
                this.logger?.warn(`AttachmentExtractionJob: failed to process attachment ${attachment.uid}: ${err.message}`);
            }
        }
    }

    private async processAttachment(attachment: A): Promise<void> {
        const content: Buffer = await this.blobStore!.get(attachment.blobKey);
        const text: string | undefined = await this.extractorRegistry.extract(attachment.mimeType, content);

        const extractedTextBlobKey = `attachment-text/${crypto.randomUUID()}`;
        await this.blobStore!.put(extractedTextBlobKey, Buffer.from(text ?? "", "utf-8"), {
            contentType: "text/plain",
        });

        await this.attachmentRepo!.update(
            { uid: attachment.uid, version: (attachment as any).version, extractedTextBlobKey } as any,
            attachment,
            { ignoreACL: true },
        );

        if (text && text.length > 0) {
            const message: M | undefined = await this.messageRepo!.findOne(attachment.messageUid, {
                ignoreACL: true,
            });
            if (message?.searchIndexedAt) {
                // Explicit `null`, not `undefined`: TypeORM's `Repository.update()` silently drops any
                // property whose value is `undefined` from its generated `SET` clause, so on the SQL backend
                // an `undefined` here would leave the persisted `searchIndexedAt` completely untouched (still
                // reporting "already indexed") - a real, confirmed cross-backend bug caught by real-database
                // testing. MongoDB's own `updateOne($set: ...)` happens to coerce either value to `null`
                // equivalently, so `null` is correct there too.
                await this.messageRepo!.update(
                    { uid: message.uid, version: (message as any).version, searchIndexedAt: null } as any,
                    message,
                    { ignoreACL: true, skipPush: true },
                );
            }
        }
    }
}
