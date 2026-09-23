///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ModelUtils, NotificationUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import { refreshFolderCounts } from "../util/FolderCountUtils.js";
import {
    chargeMailboxQuota,
    MailboxQuotaExceededError as SharedMailboxQuotaExceededError,
    refundMailboxQuota,
} from "../util/MailboxQuotaUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import { ScanPipeline, ScanPipelineResult } from "../scan/ScanPipeline.js";
import { boundIndexedValue, deriveConversationId } from "../util/ConversationUtils.js";
import { extractHeader } from "../util/MimeHeaderUtils.js";
import { parseMbox } from "../util/MboxUtils.js";
import { buildDeliveredRecipients } from "../util/RecipientUtils.js";
import { extractPstMessages } from "../util/PstImportUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import {
    Attachment,
    AuditAction,
    AvVerdict,
    Folder,
    Mailbox,
    MailboxImportRequest,
    Message,
    MessageImportance,
    RecipientType,
} from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** Thrown by `persistImportedMessage()` when importing one more message would exceed the target mailbox's
 * quota - stops the whole import (see `MailboxImportJob.processRequest()`). */
class MailboxQuotaExceededError extends Error {}

/** The target mailbox's quota as of this run's last read/charge - used only for the cheap pre-scan check; the
 * authoritative check is `MailboxImportJob.chargeQuota()` against the freshly read row. `quotaBytes <= 0` means
 * unlimited (the model default of `0` is an unprovisioned quota, not a zero-byte mailbox). */
interface ImportQuota {
    mailboxUid: string;
    quotaBytes: number;
    usedBytes: number;
}

/** The lease a running attempt holds on its request row - see `DataExportJob`'s identical scheme. */
interface ImportLease<MIR> {
    held: MIR;
    renewedAt: number;
}

/**
 * Processes pending `MailboxImportRequest` rows (see that entity's own doc comment) - the portability
 * counterpart to `DataExportJob`, mirroring its single-page-per-run shape. A PST/Mbox file can hold
 * thousands of items and (for PST) requires a synchronous, potentially slow parse - `batchSize` defaults
 * to processing one uploaded file per run rather than `DataExportJob`'s 10, deliberately.
 *
 * Both formats are first reduced to the same shape - an array of raw RFC 5322 message buffers
 * (`util/MboxUtils.ts`'s `parseMbox()` for `"mbox"`, `util/PstImportUtils.ts`'s `extractPstMessages()` for
 * `"pst"`, which reconstructs one via `nodemailer`'s `MimeNode` from a PST item's structured properties,
 * since PST doesn't store an already-assembled MIME byte stream the way Mbox does) - so a single
 * `persistImportedMessage()` step handles both. That step deliberately does NOT reuse `ScanQueueJob.
 * deliverMessage()`: that method is entangled with live-mail-only concerns (quarantine-folder routing,
 * inbound `RapidMX-Key` processing, delivery receipts, iTIP calendar processing, auto-replies) that make no
 * sense for historical mail already delivered somewhere else years ago. It DOES reuse the shared
 * `ScanPipeline` (parsing + AV/spam scanning) both `ScanQueueJob` and `BaseMessageRoute` already depend on -
 * every imported message is still AV-scanned (a historical PST/Mbox is as plausible a malware vector as
 * live mail) and an AV-`INFECTED` verdict on the raw message OR any individual attachment causes that one
 * item to be skipped and counted in `failedCount`, never persisted. An AV-`ERROR` verdict (the scanner itself
 * failed, e.g. an engine outage) is treated exactly the same way - the item was never actually scanned, so it
 * must not be imported as if clean (the same fail-closed reading `ScanPipeline.resolveDeliveryVerdict()`
 * gives live mail, which quarantines on `ERROR`). Spam scoring runs too (`ScanPipeline.
 * run()` always computes both together) but its result is deliberately ignored - imported mail is filed to
 * the caller's chosen folder, never junk-routed, matching this plan's own "not inbound mail in the ordinary
 * sense" scope note.
 *
 * **Quota.** The target mailbox's `quotaBytes` is enforced before each message is stored (counting the raw
 * message plus its attachments, the same formula `MailboxQuotaRecalcJob` uses); a `quotaBytes` of `0` means
 * unlimited. Each message's size is charged to the persisted `Mailbox.usedBytes` BEFORE it is stored, by a
 * version-checked update against a fresh read (retried on conflict - see `chargeQuota()`), so concurrent imports
 * and other `usedBytes` writers see each other's usage instead of clobbering it, and a crash mid-import doesn't
 * lose the accounting of what was already imported. A message that then fails to store is refunded. Once the
 * next message would exceed the quota, the import stops and the request is marked `"failed"` with a quota error,
 * keeping the `importedCount`/`failedCount` of what was already imported (those messages stay). Residual: a crash
 * between a charge and the message being stored over-counts that one message until `MailboxQuotaRecalcJob`
 * recomputes the mailbox.
 *
 * **Lease/reclaim.** Same scheme as `DataExportJob` (see its doc comment): the claim bumps
 * `processingAttempts` and starts a lease on the row's `dateModified`, renewed while importing; a
 * `"processing"` row whose lease is older than `lease_minutes` is reclaimed to `"pending"` (or `"failed"`
 * after `max_attempts`) by a version-checked update. A retried attempt skips any message whose `Message-ID`
 * already exists in the target folder, so messages a dead attempt had already persisted aren't duplicated
 * (a message with no `Message-ID` header can't be matched and may be imported again).
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`MailboxImportJobMongo`/
 * `MailboxImportJobSQL`), following the same multi-entity-type generic pattern `ScanQueueJob`/
 * `DataExportJob` use.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class MailboxImportJob<MIR extends MailboxImportRequest, MB extends Mailbox, F extends Folder, M extends Message> extends BackgroundService {
    protected abstract mailboxImportRequestClass: any;
    protected abstract mailboxClass: any;
    protected abstract folderClass: any;
    protected abstract messageClass: any;
    protected abstract attachmentClass: any;
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private requestRepo?: RepoUtils<MIR>;
    private mailboxRepo?: RepoUtils<MB>;
    private folderRepo?: RepoUtils<F>;
    private messageRepo?: RepoUtils<M>;
    private attachmentRepo?: RepoUtils<Attachment>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    /** Publishes the target folder's new counts (see `util/FolderCountUtils.ts`) once an import has filed its messages. */
    @Inject(NotificationUtils)
    private notificationUtils?: NotificationUtils;

    @Config("mail:jobs:mailbox_import:schedule", "*/30 * * * * *")
    private scheduleExpr: string = "*/30 * * * * *";

    // One uploaded file per run - see this class's own doc comment for why (unlike `DataExportJob`'s 10).
    @Config("mail:jobs:mailbox_import:batch_size", 1)
    private batchSize: number = 1;

    /** How long a request may sit in `"processing"` without its lease being renewed before it is presumed
     * abandoned and reclaimed - longer than `DataExportJob`'s, since one PST parse is a single synchronous
     * step that can't renew the lease while it runs. */
    @Config("mail:jobs:mailbox_import:lease_minutes", 120)
    private leaseMinutes: number = 120;

    /** How many claims a request gets before an abandoned `"processing"` row is marked `"failed"`. */
    @Config("mail:jobs:mailbox_import:max_attempts", 3)
    private maxAttempts: number = 3;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.requestRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxImportRequestClass.name,
            args: [this.mailboxImportRequestClass],
        });
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
        this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.folderClass.name,
            args: [this.folderClass],
        });
        this.messageRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.attachmentRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.attachmentClass.name,
            args: [this.attachmentClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.requestRepo || !this.mailboxRepo || !this.folderRepo || !this.messageRepo || !this.attachmentRepo || !this.blobStore || !this.scanPipeline) {
            return;
        }

        await this.reclaimAbandonedRequests();

        const pending: MIR[] = await this.requestRepo.find(
            { status: "pending", limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const request of pending) {
            try {
                await this.processRequest(request);
            } catch (err: any) {
                this.logger?.error(`MailboxImportJob: failed to process import request ${request.uid}: ${err.message}`);
                await this.markFailed(request, err.message);
            }
        }
    }

    private get leaseMs(): number {
        return this.leaseMinutes * 60_000;
    }

    /** Reclaims `"processing"` rows whose lease (`dateModified`) expired - see `DataExportJob.
     * reclaimAbandonedRequests()`'s identical logic. Version-checked, so two replicas can't both reclaim. */
    private async reclaimAbandonedRequests(): Promise<void> {
        const cutoff: Date = new Date(Date.now() - this.leaseMs);
        let abandoned: MIR[];
        try {
            abandoned = await this.requestRepo!.find(
                { status: "processing", dateModified: `lt(${cutoff.toISOString()})`, limit: this.batchSize } as any,
                { ignoreACL: true, limit: this.batchSize },
            );
        } catch (err: any) {
            this.logger?.warn(`MailboxImportJob: failed to look up abandoned import requests: ${err.message}`);
            return;
        }
        for (const request of abandoned) {
            // A row claimed before `processingAttempts` existed has had (at least) one attempt.
            const attempts: number = request.processingAttempts ?? 1;
            try {
                if (attempts >= this.maxAttempts) {
                    this.logger?.warn(`MailboxImportJob: import request ${request.uid} abandoned after ${attempts} attempt(s); marking failed.`);
                    await this.transitionToFailed(request, `The import did not complete after ${attempts} attempt(s) - processing was interrupted each time.`);
                } else {
                    this.logger?.warn(`MailboxImportJob: reclaiming abandoned import request ${request.uid} (attempt ${attempts} of ${this.maxAttempts}).`);
                    await this.requestRepo!.update(
                        { uid: request.uid, version: (request as any).version, status: "pending" } as any,
                        asEntity(this.requestRepo!, request),
                        { ignoreACL: true },
                    );
                }
            } catch (err: any) {
                this.logger?.warn(`MailboxImportJob: failed to reclaim abandoned import request ${request.uid}: ${err.message}`);
            }
        }
    }

    /** Renews this attempt's lease once a quarter of the lease period has elapsed - see `DataExportJob.
     * renewLease()`. Throws (aborting the import) if the lease was lost to a reclaim. */
    private async renewLease(lease: ImportLease<MIR>): Promise<void> {
        if (Date.now() - lease.renewedAt < this.leaseMs / 4) {
            return;
        }
        lease.held = await this.requestRepo!.update(
            { uid: lease.held.uid, version: (lease.held as any).version, status: "processing" } as any,
            asEntity(this.requestRepo!, lease.held),
            { ignoreACL: true },
        );
        lease.renewedAt = Date.now();
    }

    private async processRequest(request: MIR): Promise<void> {
        const mailbox: MB | undefined = await this.mailboxRepo!.findOne(request.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            await this.markFailed(request, "The target mailbox no longer exists.");
            return;
        }
        const folder: F | undefined = await this.folderRepo!.findOne(request.targetFolderUid, { ignoreACL: true });
        if (!folder) {
            await this.markFailed(request, "The target folder no longer exists.");
            return;
        }

        // Every failure path below must mark against the lease's own held version, never `request`'s - this
        // very update has already bumped the persisted row's version, so `request`'s own is now stale. The
        // same "re-fetch before the next optimistic-locked update" discipline `ScanQueueJob.processEntry()`
        // already documents for its identical shape (there, the `scanning` variable plays this same role).
        const attempt: number = (request.processingAttempts ?? 0) + 1;
        const lease: ImportLease<MIR> = {
            held: await this.requestRepo!.update(
                { uid: request.uid, version: (request as any).version, status: "processing", processingAttempts: attempt } as any,
                asEntity(this.requestRepo!, request),
                { ignoreACL: true },
            ),
            renewedAt: Date.now(),
        };
        const processing: MIR = lease.held;

        try {
            const source: Buffer = await this.blobStore!.get(processing.sourceBlobKey);
            const rawMessages: Buffer[] = processing.format === "mbox" ? parseMbox(source) : await extractPstMessages(source);

            const quota: ImportQuota = { mailboxUid: mailbox.uid, quotaBytes: mailbox.quotaBytes ?? 0, usedBytes: mailbox.usedBytes ?? 0 };
            let importedCount = 0;
            let failedCount = 0;
            let quotaError: string | undefined;
            for (const raw of rawMessages) {
                // Deliberately outside the per-message try/catch below: a lost lease must abort the whole run.
                await this.renewLease(lease);
                try {
                    if (attempt > 1 && (await this.alreadyImported(raw, folder))) {
                        // Persisted by an earlier attempt that died before completing - see this class's doc comment.
                        importedCount++;
                        continue;
                    }
                    const persisted: boolean = await this.persistImportedMessage(raw, mailbox, folder, quota);
                    if (persisted) {
                        importedCount++;
                    } else {
                        failedCount++;
                    }
                } catch (err: any) {
                    if (err instanceof MailboxQuotaExceededError) {
                        quotaError = err.message;
                        break;
                    }
                    this.logger?.warn(`MailboxImportJob: failed to import one message for request ${processing.uid}: ${err.message}`);
                    failedCount++;
                }
            }

            // The folder's counts are derived from its messages, so they are recomputed (and published) once, here, rather
            // than incremented per message. Best-effort and never throws: every message has already been durably
            // persisted by this point, so a failure here must not turn a fully-successful import into a reported
            // "failed" one - a caller trusting that status would be invited to re-run the same import against the same
            // source file, duplicating every message (a fresh request gets no Message-ID dedup - only a reclaimed retry
            // of the SAME request does).
            if (importedCount > 0) {
                await refreshFolderCounts(
                    {
                        messageRepo: this.messageRepo!,
                        folderRepo: this.folderRepo!,
                        folderClass: this.folderClass,
                        notificationUtils: this.notificationUtils,
                        logger: this.logger,
                    },
                    [folder.uid],
                    { bumpSyncKey: true },
                );
            }

            // Version-checked against the lease this run still holds (renewed while importing), deliberately
            // NOT a re-fetch: if this attempt's lease expired and another replica reclaimed the request, this
            // update must lose rather than overwrite the newer attempt's status.
            const updated: MIR = await this.requestRepo!.update(
                {
                    uid: lease.held.uid,
                    version: (lease.held as any).version,
                    status: quotaError ? "failed" : "completed",
                    importedCount,
                    failedCount,
                    ...(quotaError ? { errorMessage: quotaError } : {}),
                } as any,
                asEntity(this.requestRepo!, lease.held),
                { ignoreACL: true },
            );
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, logger: this.logger },
                {
                    action: quotaError ? AuditAction.MAILBOX_IMPORT_FAILED : AuditAction.MAILBOX_IMPORT_COMPLETED,
                    targetType: "MailboxImportRequest",
                    targetUid: updated.uid,
                    mailboxUid: updated.mailboxUid,
                },
            );
        } catch (err: any) {
            await this.markFailed(lease.held, err.message);
        }
    }

    /** Whether a message with `raw`'s own `Message-ID` already exists in `folder` - used only on a retried
     * attempt, to skip what the earlier (abandoned) attempt already persisted. */
    private async alreadyImported(raw: Buffer, folder: F): Promise<boolean> {
        const header: string | undefined = extractHeader(raw, "Message-ID");
        // Bounded the same way `Message` bounds the stored value (an over-long Message-ID is stored as its SHA-256),
        // or an over-long Message-ID would never match and a retry would duplicate the message.
        const messageId: string = boundIndexedValue((header ?? "").trim().replace(/^<|>$/g, ""));
        if (!messageId) {
            return false;
        }
        const existing: M[] = await this.messageRepo!.find({ folderUid: folder.uid, messageId: ModelUtils.literal(messageId), limit: 1 } as any, { ignoreACL: true, limit: 1 });
        return existing.length > 0;
    }

    private async markFailed(request: MIR, errorMessage: string): Promise<void> {
        try {
            await this.transitionToFailed(request, errorMessage);
        } catch (err: any) {
            this.logger?.error(`MailboxImportJob: failed to mark import request ${request.uid} as failed: ${err.message}`);
        }
    }

    private async transitionToFailed(request: MIR, errorMessage: string): Promise<void> {
        const updated: MIR = await this.requestRepo!.update(
            { uid: request.uid, version: (request as any).version, status: "failed", errorMessage } as any,
            asEntity(this.requestRepo!, request),
            { ignoreACL: true },
        );
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, logger: this.logger },
            { action: AuditAction.MAILBOX_IMPORT_FAILED, targetType: "MailboxImportRequest", targetUid: updated.uid, mailboxUid: updated.mailboxUid },
        );
    }

    /** Persists one already-extracted raw RFC 5322 message as a `Message` (plus any `Attachment` rows) in
     * `folder` - see this class's own doc comment for why this is a new, purpose-built step rather than a
     * reuse of `ScanQueueJob.deliverMessage()`. Returns `false` (skipped, not thrown) for an AV-`INFECTED` or
     * AV-`ERROR` verdict - imported historical malware is a real risk, not a hypothetical this repo need only
     * assert against. Throws `MailboxQuotaExceededError` (before storing anything) when this message would
     * push the mailbox past its quota; otherwise charges its size to the persisted `Mailbox.usedBytes`
     * (`chargeQuota()`), refunding it if storing the message then fails. */
    private async persistImportedMessage(raw: Buffer, mailbox: MB, folder: F, quota: ImportQuota): Promise<boolean> {
        // Cheap pre-check on the raw size alone, before paying for a scan.
        this.assertWithinQuota(quota, raw.length);

        const result: ScanPipelineResult = await this.scanPipeline!.run(raw, { from: "", to: [] });
        // `result.av` is already the WORST of the raw message's own scan and every attachment's own scan
        // (see `ScanPipelineResult.av`'s own doc comment) - so this one check alone also catches an
        // infected attachment, not just an infected raw message body. The whole message is skipped rather
        // than importing it with just the infected attachment dropped: a message that shipped malware is
        // itself a real historical event a compliance-driven import should flag for review (`failedCount`),
        // not silently launder into a clean-looking archived copy.
        if (result.av.verdict === AvVerdict.INFECTED) {
            this.logger?.warn("MailboxImportJob: skipping an imported message - AV scan flagged it (or an attachment) infected.");
            return false;
        }
        // The scanner failed, so the message was never actually scanned - fail closed, exactly like INFECTED
        // (see this class's own doc comment), rather than importing an unscanned item as if it were clean.
        if (result.av.verdict === AvVerdict.ERROR) {
            this.logger?.warn("MailboxImportJob: skipping an imported message - AV scan could not complete (scanner error).");
            return false;
        }

        // Same size formula `MailboxQuotaRecalcJob` uses: the stored raw body plus every attachment row's size.
        const messageBytes: number = raw.length + result.attachments.reduce((sum, a) => sum + a.content.length, 0);
        // Charged (persisted) before anything is stored; refunded if storing then fails.
        await this.chargeQuota(quota, messageBytes);
        try {
            return await this.storeImportedMessage(raw, result, mailbox, folder);
        } catch (err) {
            await this.refundQuota(quota, messageBytes);
            throw err;
        }
    }

    private async storeImportedMessage(raw: Buffer, result: ScanPipelineResult, mailbox: MB, folder: F): Promise<boolean> {
        const bodyBlobKey = `imported/${crypto.randomUUID()}`;
        await this.blobStore!.put(bodyBlobKey, raw, { contentType: "message/rfc822" });

        let sanitizedHtmlBlobKey: string | undefined;
        if (result.sanitizedHtml !== undefined) {
            sanitizedHtmlBlobKey = `sanitized/${crypto.randomUUID()}`;
            await this.blobStore!.put(sanitizedHtmlBlobKey, Buffer.from(result.sanitizedHtml, "utf-8"), { contentType: "text/html" });
        }

        // Bounded explicitly (the model constructors bound it too - idempotent) so the stored value always matches
        // `alreadyImported()`'s bounded lookup.
        const messageId: string = boundIndexedValue(result.messageIdHeader ?? crypto.randomUUID());
        const conversationId: string = deriveConversationId(result.references, result.inReplyTo, messageId);
        // `ScanPipelineResult` doesn't parse/expose the message's own `Date:` header (nothing about live
        // inbound delivery ever needed it - `ScanQueueJob.deliverMessage()` also just stamps `new Date()`,
        // fine there since delivery time and send time are seconds apart). For an IMPORTED historical
        // message that gap can be years, and `sentDate` is exactly the field `LegalHoldUtils.
        // assertNotOnLegalHold()`/`MatterExportJob`'s date-range narrowing check - silently stamping
        // "today" on a 2019 message would let it slip past a 2019-dated legal hold or eDiscovery date
        // range entirely. Extracted directly via the lightweight header-only scan (`util/
        // MimeHeaderUtils.ts`) rather than a second full MIME parse; falls back to "now" only when the
        // header is genuinely absent or unparseable, same tolerance `BaseSearchRoute.parseDateParam()`
        // already applies to a caller-supplied date string.
        const dateHeader: string | undefined = extractHeader(raw, "Date");
        const parsedDate: Date | undefined = dateHeader ? new Date(dateHeader) : undefined;
        const sentDate: Date = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date();

        const message: M = await this.messageRepo!.create(
            new this.messageClass({
                folderUid: folder.uid,
                mailboxUid: mailbox.uid,
                messageId,
                subject: result.subject ?? "",
                from: { address: result.fromAddress ?? "", displayName: result.fromDisplayName, type: RecipientType.TO },
                // The imported message's own `To`/`Cc` (and, on an archived Sent Items copy, `Bcc`) headers -
                // an import has no SMTP envelope of its own to fall back on. Left empty until now, which made
                // every imported message look like it had been sent to nobody.
                recipients: buildDeliveredRecipients(result.headerRecipients, []),
                sentDate,
                receivedDate: sentDate,
                bodyBlobKey,
                sanitizedHtmlBlobKey,
                bodyPreview: result.bodyPreview ?? "",
                // Historical mail already read/handled wherever it originally lived - imported as read,
                // matching this plan's "not inbound mail in the ordinary sense" scope note (no unread-count
                // bump, no notification).
                flags: { read: true, flagged: false, answered: false, forwarded: false },
                importance: MessageImportance.NORMAL,
                inReplyTo: result.inReplyTo,
                references: result.references,
                conversationId,
                hasAttachments: result.attachments.length > 0,
                encrypted: result.encrypted,
            }),
            { ignoreACL: true },
        );

        for (const attachment of result.attachments) {
            const blobKey = `attachments/${crypto.randomUUID()}`;
            await this.blobStore!.put(blobKey, attachment.content, { contentType: attachment.contentType });
            await this.attachmentRepo!.create(
                new this.attachmentClass({
                    messageUid: message.uid,
                    folderUid: folder.uid,
                    mailboxUid: mailbox.uid,
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

        return true;
    }

    /**
     * Atomically checks and charges `bytes` against the mailbox's persisted quota - delegates the actual
     * re-read/version-checked-write/retry loop to the shared `chargeMailboxQuota()` (see its own doc comment),
     * so this job's quota accounting stays byte-for-byte identical to `BaseAttachmentRoute.upload()`'s and
     * `ScanQueueJob`'s inbound delivery's. Refreshes `quota` from what the shared function read, for the next
     * message's cheap local pre-check (`assertWithinQuota()`), and translates the shared function's own
     * `MailboxQuotaExceededError` into this job's - same exception type `processRequest()`'s catch already
     * matches on, same "Import stopped: ..." message shape `assertWithinQuota()`'s pre-check throws.
     */
    private async chargeQuota(quota: ImportQuota, bytes: number): Promise<void> {
        try {
            const result = await chargeMailboxQuota(this.mailboxRepo!, quota.mailboxUid, bytes);
            quota.quotaBytes = result.quotaBytes;
            quota.usedBytes = result.usedBytes;
        } catch (err) {
            if (err instanceof SharedMailboxQuotaExceededError) {
                quota.quotaBytes = err.quotaBytes;
                quota.usedBytes = err.usedBytes;
                throw new MailboxQuotaExceededError(
                    `Import stopped: the mailbox quota of ${quota.quotaBytes} bytes would be exceeded by the next message.`,
                );
            }
            throw err;
        }
    }

    /** Best-effort reversal of `chargeQuota()` for a message that failed to store - delegates to the shared
     * `refundMailboxQuota()`, logging on total failure the same way this job's own retry loop used to. */
    private async refundQuota(quota: ImportQuota, bytes: number): Promise<void> {
        await refundMailboxQuota(this.mailboxRepo!, quota.mailboxUid, bytes, (lastError: any) => {
            this.logger?.warn(`MailboxImportJob: failed to refund ${bytes} quota bytes to mailbox ${quota.mailboxUid}: ${lastError?.message}`);
        });
        quota.usedBytes = Math.max(0, quota.usedBytes - bytes);
    }

    private assertWithinQuota(quota: ImportQuota, additionalBytes: number): void {
        if (quota.quotaBytes > 0 && quota.usedBytes + additionalBytes > quota.quotaBytes) {
            throw new MailboxQuotaExceededError(
                `Import stopped: the mailbox quota of ${quota.quotaBytes} bytes would be exceeded by the next message.`,
            );
        }
    }
}
