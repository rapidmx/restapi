///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, NotificationUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { resolveDeliveryVerdict, ScanPipeline, ScanPipelineResult } from "../scan/ScanPipeline.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import {
    Attachment,
    AvVerdict,
    Folder,
    FolderType,
    IngestQueueEntry,
    IngestStatus,
    Message,
    MessageImportance,
    QuarantineEntry,
    QuarantineReason,
    RecipientType,
    ScanResult,
    ScanTargetType,
} from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/**
 * Drains `IngestQueueEntry` rows staged by `BaseMailIngestRoute`: runs the `ScanPipeline` against each one's
 * raw message, then either delivers it to the mailbox's Inbox, files it in Junk, or holds it in
 * `QuarantineEntry` — depending on `resolveDeliveryVerdict()`. No client protocol (webmail/EAS/MAPI) ever sees
 * a message before this job has processed it.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`ScanQueueJobMongo`/`ScanQueueJobSQL`),
 * following the same multi-entity-type generic pattern `DefaultAccounts` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ScanQueueJob<
    Q extends IngestQueueEntry,
    F extends Folder,
    M extends Message,
    A extends Attachment,
    QE extends QuarantineEntry,
    SR extends ScanResult,
> extends BackgroundService {
    protected abstract ingestQueueClass: any;
    protected abstract folderClass: any;
    protected abstract messageClass: any;
    protected abstract attachmentClass: any;
    protected abstract quarantineEntryClass: any;
    protected abstract scanResultClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private ingestQueueRepo?: RepoUtils<Q>;
    private folderRepo?: RecoverableRepoUtils<F>;
    private messageRepo?: RecoverableRepoUtils<M>;
    private attachmentRepo?: RepoUtils<A>;
    private quarantineEntryRepo?: RepoUtils<QE>;
    private scanResultRepo?: RepoUtils<SR>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    /** Publishes a live-update notification (see `push/MailPushRoute.ts`) once a message is delivered. */
    @Inject(NotificationUtils)
    private notificationUtils?: NotificationUtils;

    @Config("mail:jobs:scan_queue:schedule", "*/10 * * * * *")
    private scheduleExpr: string = "*/10 * * * * *";

    @Config("mail:jobs:scan_queue:batch_size", 25)
    private batchSize: number = 25;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.ingestQueueRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.ingestQueueClass.name,
            args: [this.ingestQueueClass],
        });
        this.folderRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
        this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.attachmentRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.attachmentClass.name,
            args: [this.attachmentClass],
        });
        this.quarantineEntryRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.quarantineEntryClass.name,
            args: [this.quarantineEntryClass],
        });
        this.scanResultRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.scanResultClass.name,
            args: [this.scanResultClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        // `limit` must be passed both via `options` (used by the Mongo backend) *and* baked into the query
        // object itself (all `ModelUtils.buildSearchQuerySQL` reads - it ignores `options.limit` entirely and
        // falls back to its own default of 100 otherwise). Confirmed by real-database testing: on the SQL
        // backend, `options.limit` alone silently caps at 100 regardless of the configured batch size.
        const pending: Q[] = await this.ingestQueueRepo!.find(
            { status: IngestStatus.PENDING, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const entry of pending) {
            try {
                await this.processEntry(entry);
            } catch (err: any) {
                this.logger?.error(`ScanQueueJob: failed to process ingest entry ${entry.uid}: ${err.message}`);
                // `entry` may be stale: `processEntry()` may have already bumped this row to SCANNING (and thus
                // its persisted version) before failing partway through. Updating against that stale version
                // would optimistically-lock-mismatch and silently affect zero rows on some backends, leaving
                // the entry stuck at SCANNING forever instead of FAILED - re-fetch the current row first.
                const current: Q = (await this.ingestQueueRepo!.findOne(entry.uid, { ignoreACL: true })) ?? entry;
                await this.ingestQueueRepo!.update(
                    { uid: entry.uid, version: (current as any).version, status: IngestStatus.FAILED, errorMessage: err.message } as any,
                    current,
                    { ignoreACL: true },
                );
            }
        }
    }

    private async processEntry(entry: Q): Promise<void> {
        await this.ingestQueueRepo!.update(
            { uid: entry.uid, version: (entry as any).version, status: IngestStatus.SCANNING } as any,
            entry,
            { ignoreACL: true },
        );
        // `entry` is now stale (its `version` no longer matches the persisted row) — re-fetch before the next
        // optimistic-locked update rather than reusing the pre-update snapshot.
        const scanning: Q = (await this.ingestQueueRepo!.findOne(entry.uid, { ignoreACL: true }))!;

        const raw: Buffer = await this.blobStore!.get(entry.rawBlobKey);
        const result: ScanPipelineResult = await this.scanPipeline!.run(raw, {
            from: entry.envelopeFrom,
            to: entry.envelopeTo,
        });
        const verdict = resolveDeliveryVerdict(result);

        // The `Message`/`QuarantineEntry` this scan is *for* doesn't exist yet, and `ScanResult.targetUid`
        // needs to reference it - pre-generating the target's uid here (rather than letting `create()` mint
        // one) breaks that chicken-and-egg ordering: the target entity is then created *with* this exact uid
        // (BaseEntity's constructor honors an explicitly supplied `uid`), so both records can reference each
        // other correctly regardless of which is actually persisted first.
        const targetUid: string = crypto.randomUUID();
        const scanResult: SR = await this.scanResultRepo!.create(
            new this.scanResultClass({
                targetType: ScanTargetType.MESSAGE,
                targetUid,
                spamScore: result.spam.score,
                spamVerdict: result.spam.verdict,
                spamSymbols: result.spam.symbols,
                avVerdict: result.av.verdict,
                avSignatureName: result.av.signatureName,
                scannedAt: new Date(),
                providerVersions: {},
            }),
            { ignoreACL: true },
        );

        if (verdict === "quarantine") {
            await this.quarantineEntryRepo!.create(
                new this.quarantineEntryClass({
                    uid: targetUid,
                    mailboxUid: entry.mailboxUid,
                    reason: result.av.verdict === AvVerdict.INFECTED ? QuarantineReason.INFECTED : QuarantineReason.OTHER,
                    scanResultUid: scanResult.uid,
                    rawBlobKey: entry.rawBlobKey,
                }),
                { ignoreACL: true },
            );
        } else {
            const folder: F = await findOrCreateWellKnownFolder(
                this.folderRepo!,
                this.folderClass,
                entry.mailboxUid,
                verdict === "junk" ? FolderType.JUNK : FolderType.INBOX,
            );

            // `ScanPipeline.run()`'s sanitized HTML (script/active-content stripped) is stored under its own
            // blob key, separate from `bodyBlobKey`'s raw MIME - `bodyBlobKey` must stay exactly what was
            // ingested/sent (the send path and any future "view original" feature need the untouched bytes),
            // so the sanitization pass would otherwise be computed and then silently discarded with no
            // consumer ever able to read it, leaving the only body representation this library persists
            // completely unsanitized.
            let sanitizedHtmlBlobKey: string | undefined;
            if (result.sanitizedHtml !== undefined) {
                sanitizedHtmlBlobKey = `sanitized/${crypto.randomUUID()}`;
                await this.blobStore!.put(sanitizedHtmlBlobKey, Buffer.from(result.sanitizedHtml, "utf-8"), {
                    contentType: "text/html",
                });
            }

            const message: M = await this.messageRepo!.create(
                new this.messageClass({
                    uid: targetUid,
                    folderUid: folder.uid,
                    mailboxUid: entry.mailboxUid,
                    messageId: crypto.randomUUID(),
                    subject: "",
                    from: { address: entry.envelopeFrom, type: RecipientType.TO },
                    recipients: entry.envelopeTo.map((address) => ({ address, type: RecipientType.TO })),
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey: entry.rawBlobKey,
                    sanitizedHtmlBlobKey,
                    bodyPreview: "",
                    flags: { read: false, flagged: false, answered: false, forwarded: false },
                    importance: MessageImportance.NORMAL,
                    references: [],
                    hasAttachments: result.attachments.length > 0,
                    scanResultUid: scanResult.uid,
                }),
                { ignoreACL: true },
            );
            this.notificationUtils?.sendMessage(folder.uid, this.messageClass.name, "create", message);

            for (const attachment of result.attachments) {
                const blobKey = `attachments/${crypto.randomUUID()}`;
                await this.blobStore!.put(blobKey, attachment.content, { contentType: attachment.contentType });
                await this.attachmentRepo!.create(
                    new this.attachmentClass({
                        messageUid: message.uid,
                        folderUid: folder.uid,
                        mailboxUid: entry.mailboxUid,
                        filename: attachment.filename ?? "attachment",
                        mimeType: attachment.contentType,
                        sizeBytes: attachment.content.length,
                        blobKey,
                        contentId: attachment.contentId,
                        isInline: attachment.isInline,
                    }),
                    { ignoreACL: true },
                );
            }

            await this.folderRepo!.update(
                {
                    uid: folder.uid,
                    version: (folder as any).version,
                    unreadCount: folder.unreadCount + 1,
                    totalCount: folder.totalCount + 1,
                    syncKeyVersion: folder.syncKeyVersion + 1,
                } as any,
                folder,
                { ignoreACL: true },
            );
        }

        await this.ingestQueueRepo!.update(
            { uid: scanning.uid, version: (scanning as any).version, status: IngestStatus.DELIVERED } as any,
            scanning,
            { ignoreACL: true },
        );
    }
}
