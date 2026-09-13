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
 * `relayDueMessage()` claims a message (a version-checked clear of `scheduledSendTime`) before doing any
 * relay/side-effecting work, the same "claim first, work second" discipline `DataExportJob.
 * processRequest()` uses - see that method's own doc comment for why: without it, a concurrent cancel/edit
 * of the same message could race the actual SMTP send, resulting in a delivered email the DB ends up
 * reflecting as cancelled. On a relay failure after a successful claim, `scheduledSendTime` is restored
 * (best-effort) so the message isn't silently lost - no retry-count or backoff field beyond that, matching
 * this codebase's existing "simplest correct-enough" precedent (see `CalendarReminderJob`'s own doc comment
 * for the same style of documented simplification).
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

    /** `null`, not `undefined`: TypeORM's `Repository.update()` silently skips an `undefined` property
     * (leaving the SQL column unchanged) but does set an explicit `null` to NULL - the Mongo backend's
     * `$set` handles both the same way, so `null` is the one value that reliably clears this field on
     * both backends. */
    private async relayDueMessage(message: M): Promise<void> {
        // Claimed via a version-checked clear of `scheduledSendTime` BEFORE any relay/side-effecting work
        // happens - the same "claim first, work second" discipline `DataExportJob.processRequest()` uses.
        // Without this, `scanAndRelay()` below (an irreversible external SMTP send) could run against a
        // message a concurrent cancel/edit has already superseded: the relay would still happen, but the
        // final `update()` at the end of this method would then lose the optimistic-lock race against the
        // already-bumped version and simply fail (caught by `run()`'s own catch, just a warning log) -
        // leaving the DB reflecting the user's cancel/edit while the email was actually sent regardless.
        // Claiming first means whichever side's version is stale loses cleanly: if a cancel/edit already
        // bumped the version by the time this runs, this claim itself throws immediately and nothing
        // below - `scanAndRelay()` included - ever runs; if this claim wins first, a concurrent
        // cancel/edit attempt now targets a stale version and fails on the user's own side instead of
        // racing silently against an in-flight send.
        const dueAt: any = (message as any).scheduledSendTime;
        const claimed: M = await this.messageRepo!.update(
            { uid: message.uid, version: (message as any).version, scheduledSendTime: null } as any,
            message,
            { ignoreACL: true },
        );

        try {
            const raw: Buffer = await this.blobStore!.get(claimed.bodyBlobKey);
            const envelopeTo: string[] = claimed.recipients.map((r) => r.address);

            const {
                raw: relayedRaw,
                messageId,
                conversationId,
                sanitizedHtmlBlobKey: scannedHtmlBlobKey,
            } = await scanAndRelay(raw, claimed.from.address, envelopeTo, this.scanPipeline!, this.mailTransport, this.blobStore!);
            if (relayedRaw !== raw) {
                // See the identical comment in `BaseMessageRoute.send()` - keeps the stored blob consistent
                // with what was actually relayed whenever `scanAndRelay()` had to inject a missing Message-ID.
                await this.blobStore!.put(claimed.bodyBlobKey, relayedRaw, { contentType: "message/rfc822" });
            }

            const sentFolder: any = await findOrCreateWellKnownFolder(
                this.folderRepo!,
                this.folderClass,
                claimed.mailboxUid,
                FolderType.SENT_ITEMS,
            );
            const flags = { ...claimed.flags, read: true };
            const sanitizedHtmlBlobKey: string | undefined = scannedHtmlBlobKey ?? (claimed as any).sanitizedHtmlBlobKey;

            // Re-fetched rather than reusing `claimed`'s own version - the relay above can take long
            // enough that trusting a version fetched before it risks a spurious conflict against a
            // completely unrelated concurrent write to this same row (e.g. the user separately marking it
            // read), mirroring `DataExportJob.processRequest()`'s identical final-transition re-fetch.
            const refetched: M = (await this.messageRepo!.findOne(claimed.uid, { ignoreACL: true }))!;
            const updated: M = await this.messageRepo!.update(
                {
                    uid: refetched.uid,
                    version: (refetched as any).version,
                    folderUid: sentFolder.uid,
                    flags,
                    sanitizedHtmlBlobKey,
                    messageId,
                    conversationId,
                } as any,
                refetched,
                { ignoreACL: true },
            );
            this.notificationUtils?.sendMessage(sentFolder.uid, this.messageClass.name, "update", updated);
        } catch (err: any) {
            // The relay itself never happened (or nothing external occurred) - restore `scheduledSendTime`
            // so the next poll retries, matching this job's own documented "leave it for retry, no backoff"
            // behavior on failure. Best-effort: if this restore itself loses an unrelated race (e.g. the
            // message was deleted in the meantime), the message simply stops being auto-retried - the same
            // outcome a total failure here already had before this fix, not worth a second layer of retry
            // logic for what should be a rare edge case.
            const current: M | undefined = await this.messageRepo!.findOne(claimed.uid, { ignoreACL: true });
            if (current) {
                await this.messageRepo!
                    .update({ uid: current.uid, version: (current as any).version, scheduledSendTime: dueAt } as any, current, {
                        ignoreACL: true,
                    })
                    .catch((restoreErr: any) => {
                        this.logger?.warn(
                            `ScheduledSendJob: failed to restore scheduledSendTime for ${claimed.uid} after a relay failure: ${restoreErr.message}`,
                        );
                    });
            }
            throw err;
        }
    }
}
