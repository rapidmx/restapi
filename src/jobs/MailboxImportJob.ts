///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { ScanPipeline, ScanPipelineResult } from "../scan/ScanPipeline.js";
import { deriveConversationId } from "../util/ConversationUtils.js";
import { extractHeader } from "../util/MimeHeaderUtils.js";
import { parseMbox } from "../util/MboxUtils.js";
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
 * item to be skipped and counted in `failedCount`, never persisted. Spam scoring runs too (`ScanPipeline.
 * run()` always computes both together) but its result is deliberately ignored - imported mail is filed to
 * the caller's chosen folder, never junk-routed, matching this plan's own "not inbound mail in the ordinary
 * sense" scope note.
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

    @Config("mail:jobs:mailbox_import:schedule", "*/30 * * * * *")
    private scheduleExpr: string = "*/30 * * * * *";

    // One uploaded file per run - see this class's own doc comment for why (unlike `DataExportJob`'s 10).
    @Config("mail:jobs:mailbox_import:batch_size", 1)
    private batchSize: number = 1;

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

        // Every failure path below must mark against `processing`'s own version, never `request`'s - this
        // very update has already bumped the persisted row's version, so `request`'s own is now stale. The
        // same "re-fetch before the next optimistic-locked update" discipline `ScanQueueJob.processEntry()`
        // already documents for its identical shape (there, the `scanning` variable plays this same role).
        const processing: MIR = await this.requestRepo!.update(
            { uid: request.uid, version: (request as any).version, status: "processing" } as any,
            request,
            { ignoreACL: true },
        );

        try {
            const source: Buffer = await this.blobStore!.get(processing.sourceBlobKey);
            const rawMessages: Buffer[] = processing.format === "mbox" ? parseMbox(source) : await extractPstMessages(source);

            let importedCount = 0;
            let failedCount = 0;
            for (const raw of rawMessages) {
                try {
                    const persisted: boolean = await this.persistImportedMessage(raw, mailbox, folder);
                    if (persisted) {
                        importedCount++;
                    } else {
                        failedCount++;
                    }
                } catch (err: any) {
                    this.logger?.warn(`MailboxImportJob: failed to import one message for request ${processing.uid}: ${err.message}`);
                    failedCount++;
                }
            }

            // Isolated in its own try/catch, deliberately NOT sharing the outer one below: every message has
            // already been durably persisted by this point, so a failure bumping the folder's own
            // (denormalized, best-effort) counters - e.g. a version conflict against a real piece of mail
            // concurrently delivered into the same folder by ScanQueueJob, a realistic race during a live
            // mailbox migration - must not turn a fully-successful import into a reported "failed" one. A
            // caller trusting that status would otherwise be invited to re-run the same import against the
            // same source file, duplicating every message (no dedup on messageId/source exists for imports).
            if (importedCount > 0) {
                try {
                    const currentFolder: F | undefined = await this.folderRepo!.findOne(folder.uid, { ignoreACL: true });
                    if (currentFolder) {
                        await this.folderRepo!.update(
                            {
                                uid: currentFolder.uid,
                                version: (currentFolder as any).version,
                                totalCount: currentFolder.totalCount + importedCount,
                                syncKeyVersion: currentFolder.syncKeyVersion + 1,
                            } as any,
                            currentFolder,
                            { ignoreACL: true },
                        );
                    }
                } catch (err: any) {
                    this.logger?.warn(
                        `MailboxImportJob: failed to update folder counters for ${folder.uid} after importing request ${processing.uid}: ${err.message}`,
                    );
                }
            }

            const refetched: MIR = (await this.requestRepo!.findOne(processing.uid, { ignoreACL: true }))!;
            const updated: MIR = await this.requestRepo!.update(
                { uid: refetched.uid, version: (refetched as any).version, status: "completed", importedCount, failedCount } as any,
                refetched,
                { ignoreACL: true },
            );
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, logger: this.logger },
                { action: AuditAction.MAILBOX_IMPORT_COMPLETED, targetType: "MailboxImportRequest", targetUid: updated.uid, mailboxUid: updated.mailboxUid },
            );
        } catch (err: any) {
            await this.markFailed(processing, err.message);
        }
    }

    private async markFailed(request: MIR, errorMessage: string): Promise<void> {
        try {
            const updated: MIR = await this.requestRepo!.update(
                { uid: request.uid, version: (request as any).version, status: "failed", errorMessage } as any,
                request,
                { ignoreACL: true },
            );
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, logger: this.logger },
                { action: AuditAction.MAILBOX_IMPORT_FAILED, targetType: "MailboxImportRequest", targetUid: updated.uid, mailboxUid: updated.mailboxUid },
            );
        } catch (err: any) {
            this.logger?.error(`MailboxImportJob: failed to mark import request ${request.uid} as failed: ${err.message}`);
        }
    }

    /** Persists one already-extracted raw RFC 5322 message as a `Message` (plus any `Attachment` rows) in
     * `folder` - see this class's own doc comment for why this is a new, purpose-built step rather than a
     * reuse of `ScanQueueJob.deliverMessage()`. Returns `false` (skipped, not thrown) for a raw AV-`INFECTED`
     * verdict - imported historical malware is a real risk, not a hypothetical this repo need only assert
     * against. */
    private async persistImportedMessage(raw: Buffer, mailbox: MB, folder: F): Promise<boolean> {
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

        const bodyBlobKey = `imported/${crypto.randomUUID()}`;
        await this.blobStore!.put(bodyBlobKey, raw, { contentType: "message/rfc822" });

        let sanitizedHtmlBlobKey: string | undefined;
        if (result.sanitizedHtml !== undefined) {
            sanitizedHtmlBlobKey = `sanitized/${crypto.randomUUID()}`;
            await this.blobStore!.put(sanitizedHtmlBlobKey, Buffer.from(result.sanitizedHtml, "utf-8"), { contentType: "text/html" });
        }

        const messageId: string = result.messageIdHeader ?? crypto.randomUUID();
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
                from: { address: result.fromAddress ?? "", displayName: result.parsedFrom, type: RecipientType.TO },
                recipients: [],
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
}
