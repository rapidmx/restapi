///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, NotificationUtils, ObjectFactory } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { ScanPipeline } from "../scan/ScanPipeline.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { scanAndRelay } from "../util/MailSendUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { FolderType, Message } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/**
 * Polls `Message` rows whose `scheduledSendTime` (set by `BaseMessageRoute.send()`'s deferred-send branch - see
 * its own doc comment) is now due, relays each one via the same `scanAndRelay()` gate an immediate send uses,
 * then moves it into the mailbox's Sent Items folder and clears `scheduledSendTime` - mirroring exactly what
 * `send()` itself does for a message with no deferred send time.
 *
 * KNOWN LIMITATION: on a `scanAndRelay()` failure, the message is left as-is (still in Outbox, still carrying
 * its due `scheduledSendTime`) so the next poll retries indefinitely - no retry-count or backoff field, matching
 * this codebase's existing "simplest correct-enough" precedent (see `CalendarReminderJob`'s own doc comment for
 * the same style of documented simplification).
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`ScheduledSendJobMongo`/
 * `ScheduledSendJobSQL`), following the same generic pattern `CalendarReminderJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ScheduledSendJob<M extends Message> extends BackgroundService {
    protected abstract messageClass: any;
    protected abstract folderClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private messageRepo?: RecoverableRepoUtils<M>;
    private folderRepo?: RecoverableRepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject("MailTransport")
    private mailTransport?: any;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    @Inject(NotificationUtils)
    private notificationUtils?: NotificationUtils;

    @Config("mail:jobs:scheduled_send:schedule", "*/30 * * * * *")
    private scheduleExpr: string = "*/30 * * * * *";

    @Config("mail:jobs:scheduled_send:batch_size", 50)
    private batchSize: number = 50;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.folderRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.messageRepo) {
            return;
        }

        const now: Date = new Date();
        // `limit` must be passed both via `options` (used by the Mongo backend) *and* baked into the query
        // object itself, matching every other job's own documented note on `ModelUtils.buildSearchQuerySQL`
        // ignoring `options.limit` on the SQL backend.
        const due: M[] = await this.messageRepo.find(
            { scheduledSendTime: `lte(${now.toISOString()})`, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const message of due) {
            try {
                await this.relayDueMessage(message);
            } catch (err: any) {
                this.logger?.warn(`ScheduledSendJob: failed to relay scheduled message ${message.uid}: ${err.message}`);
            }
        }
    }

    private async relayDueMessage(message: M): Promise<void> {
        const raw: Buffer = await this.blobStore!.get(message.bodyBlobKey);
        const envelopeTo: string[] = message.recipients.map((r) => r.address);

        const { sanitizedHtmlBlobKey: scannedHtmlBlobKey } = await scanAndRelay(
            raw,
            message.from.address,
            envelopeTo,
            this.scanPipeline!,
            this.mailTransport,
            this.blobStore!,
        );

        const sentFolder: any = await findOrCreateWellKnownFolder(
            this.folderRepo!,
            this.folderClass,
            message.mailboxUid,
            FolderType.SENT_ITEMS,
        );
        const flags = { ...message.flags, read: true };
        const sanitizedHtmlBlobKey: string | undefined = scannedHtmlBlobKey ?? (message as any).sanitizedHtmlBlobKey;

        const updated: M = await this.messageRepo!.update(
            {
                uid: message.uid,
                version: (message as any).version,
                folderUid: sentFolder.uid,
                flags,
                sanitizedHtmlBlobKey,
                // `null`, not `undefined`: TypeORM's `Repository.update()` silently skips an `undefined`
                // property (leaving the SQL column unchanged) but does set an explicit `null` to NULL - the
                // Mongo backend's `$set` handles both the same way, so `null` is the one value that reliably
                // clears this field on both backends.
                scheduledSendTime: null,
            } as any,
            message,
            { ignoreACL: true },
        );
        this.notificationUtils?.sendMessage(sentFolder.uid, this.messageClass.name, "update", updated);
    }
}
