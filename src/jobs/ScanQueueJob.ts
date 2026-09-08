///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, NotificationUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { resolveDeliveryVerdict, ScanPipeline, ScanPipelineAttachmentResult, ScanPipelineResult } from "../scan/ScanPipeline.js";
import { isAutoReplyEligible } from "../util/AutoReplyUtils.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { buildEventIcs, expandOccurrences, OccurrenceWindow, parseIcsEvent, ParsedIcsEvent } from "../util/IcsUtils.js";
import { evaluateMailFilterRules, MailFilterEvaluationResult, MailFilterMatchContext } from "../util/MailFilterUtils.js";
import { resolveActiveOof } from "../util/OofUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import {
    Attachment,
    Attendee,
    AttendeeRole,
    AttendeeResponseStatus,
    AvVerdict,
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    Folder,
    FolderType,
    IngestQueueEntry,
    IngestStatus,
    Mailbox,
    MailFilterRule,
    Message,
    MessageFlags,
    MessageImportance,
    OofReplySuppression,
    QuarantineEntry,
    QuarantineReason,
    RecipientType,
    ScanResult,
    ScanTargetType,
} from "../models/types.js";

/** `true` if two `CalendarEvent.recurrenceId` values name the same occurrence (or both are the master row's
 * "no occurrence" `undefined`) - used to match an iTIP message to the right row among a master/override set
 * sharing the same `icalUid`. */
function recurrenceIdsMatch(a: Date | undefined, b: Date | undefined): boolean {
    if (!a && !b) {
        return true;
    }
    if (!a || !b) {
        return false;
    }
    return a.getTime() === b.getTime();
}
const { Config, Init, Inject, Logger } = ObjectDecorators;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** How far past a booking request's own start `decideResourceBooking()` looks for conflicts against an
 * indefinitely-recurring existing booking - a bound on worst-case cost, not a real policy limit. */
const RESOURCE_BOOKING_HORIZON_MS = 731 * MS_PER_DAY;
/** Cap on how many of a resource's own existing `CalendarEvent` rows `decideResourceBooking()` compares
 * against - a busy resource calendar is expected to be reasonably bounded; this is a safety net. */
const RESOURCE_BOOKING_EXISTING_ROWS_LIMIT = 200;

/** An attachment already persisted to the `BlobStore`, ready to be attached to one or more `Message` rows. */
interface StoredAttachment {
    filename: string;
    contentType: string;
    sizeBytes: number;
    blobKey: string;
    contentId?: string;
    isInline: boolean;
}

/**
 * Drains `IngestQueueEntry` rows staged by `BaseMailIngestRoute`: runs the `ScanPipeline` against each one's
 * raw message, then either delivers it to the mailbox's Inbox, files it in Junk, or holds it in
 * `QuarantineEntry` — depending on `resolveDeliveryVerdict()`. No client protocol (webmail/EAS/MAPI) ever sees
 * a message before this job has processed it.
 *
 * A message verdicted "deliver" additionally passes through two more steps, both pragmatic subsets of their
 * Exchange/MAPI equivalents:
 *
 * - **Mail filter rules** (`MailFilterRule`, MAPI inbox rules / MS-OXORULE): the mailbox's enabled rules are
 * evaluated in `sequence` order via `evaluateMailFilterRules()`; a matching rule's actions can move/copy the
 * message to another folder, mark it read, delete it outright, or forward it — never applied to junk-routed
 * mail, matching Exchange's own behavior.
 * - **Automatic (out-of-office) replies** (MS-ASSettings `Oof` / MAPI `OP_OOF_REPLY`): if the mailbox (or a
 * linked `CalendarEvent`, e.g. a vacation) is currently "out of office" per `resolveActiveOof()`, and the
 * message is eligible per `isAutoReplyEligible()` (RFC 3834 loop prevention), a reply is composed and relayed
 * directly, throttled to at most one per sender within a rolling window via `OofReplySuppression`.
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
    X extends Mailbox,
    MFR extends MailFilterRule,
    CE extends CalendarEvent,
    OS extends OofReplySuppression,
> extends BackgroundService {
    protected abstract ingestQueueClass: any;
    protected abstract folderClass: any;
    protected abstract messageClass: any;
    protected abstract attachmentClass: any;
    protected abstract quarantineEntryClass: any;
    protected abstract scanResultClass: any;
    protected abstract mailboxClass: any;
    protected abstract mailFilterRuleClass: any;
    protected abstract calendarEventClass: any;
    protected abstract oofReplySuppressionClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private ingestQueueRepo?: RepoUtils<Q>;
    private folderRepo?: RecoverableRepoUtils<F>;
    private messageRepo?: RecoverableRepoUtils<M>;
    private attachmentRepo?: RepoUtils<A>;
    private quarantineEntryRepo?: RepoUtils<QE>;
    private scanResultRepo?: RepoUtils<SR>;
    private mailboxRepo?: RepoUtils<X>;
    private mailFilterRuleRepo?: RepoUtils<MFR>;
    private calendarEventRepo?: RecoverableRepoUtils<CE>;
    private oofReplySuppressionRepo?: RepoUtils<OS>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    @Inject("MailTransport")
    private mailTransport?: any;

    /** Publishes a live-update notification (see `push/MailPushRoute.ts`) once a message is delivered. */
    @Inject(NotificationUtils)
    private notificationUtils?: NotificationUtils;

    @Config("mail:jobs:scan_queue:schedule", "*/10 * * * * *")
    private scheduleExpr: string = "*/10 * * * * *";

    @Config("mail:jobs:scan_queue:batch_size", 25)
    private batchSize: number = 25;

    @Config("mail:oof:resuppress_after_hours", 24)
    private resuppressAfterHours: number = 24;

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
        this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailboxClass.name,
            args: [this.mailboxClass],
        });
        this.mailFilterRuleRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.mailFilterRuleClass.name,
            args: [this.mailFilterRuleClass],
        });
        this.calendarEventRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.calendarEventClass.name,
            args: [this.calendarEventClass],
        });
        this.oofReplySuppressionRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.oofReplySuppressionClass.name,
            args: [this.oofReplySuppressionClass],
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
        // A `TransportRule`'s `quarantine` action (stamped by `BaseMailIngestRoute.deliver()`) always wins over
        // an AV/spam-derived verdict of "deliver"/"junk" - but scanning still ran normally above, so a
        // policy-quarantined message still gets a real `ScanResult` for the reviewer to see.
        const verdict = entry.quarantineReason ? "quarantine" : resolveDeliveryVerdict(result);

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
                    reason:
                        result.av.verdict === AvVerdict.INFECTED
                            ? QuarantineReason.INFECTED
                            : (entry.quarantineReason ?? QuarantineReason.OTHER),
                    scanResultUid: scanResult.uid,
                    rawBlobKey: entry.rawBlobKey,
                }),
                { ignoreACL: true },
            );
        } else if (verdict === "deliver" && result.recallOfMessageId) {
            // A recall control message is never filed to the Inbox - matching real Outlook hiding these from
            // the reading pane - only the mutation it triggers (if any) and the report back to the sender.
            await this.processRecall(entry, result.recallOfMessageId);
        } else {
            await this.deliverMessage(entry, raw, targetUid, scanResult, result, verdict === "junk");

            // Mail filter rules, automatic replies, and iTIP processing only apply to mail actually delivered
            // to the Inbox - matching Exchange's own behavior, junk-routed mail never runs any of them.
            if (verdict === "deliver") {
                await this.maybeSendAutoReply(entry, raw, result);
                await this.maybeProcessItipMessage(entry, result);
            }
        }

        await this.ingestQueueRepo!.update(
            { uid: scanning.uid, version: (scanning as any).version, status: IngestStatus.DELIVERED } as any,
            scanning,
            { ignoreACL: true },
        );
    }

    /**
     * Files a "deliver"/"junk"-verdicted message, applying any matching `MailFilterRule`'s actions first (only
     * for a "deliver" verdict - `isJunk` mail skips rule evaluation entirely).
     */
    private async deliverMessage(
        entry: Q,
        raw: Buffer,
        targetUid: string,
        scanResult: SR,
        result: ScanPipelineResult,
        isJunk: boolean,
    ): Promise<void> {
        let sanitizedHtmlBlobKey: string | undefined;
        if (result.sanitizedHtml !== undefined) {
            sanitizedHtmlBlobKey = `sanitized/${crypto.randomUUID()}`;
            await this.blobStore!.put(sanitizedHtmlBlobKey, Buffer.from(result.sanitizedHtml, "utf-8"), {
                contentType: "text/html",
            });
        }

        let filterResult: MailFilterEvaluationResult = { copyToFolderUids: [], deleted: false, markRead: false, forwardTo: [] };
        if (!isJunk) {
            const rules: MFR[] = await this.mailFilterRuleRepo!.find(
                { mailboxUid: entry.mailboxUid, enabled: true, sort: "sequence", limit: 500 } as any,
                { ignoreACL: true, limit: 500 },
            );
            const matchContext: MailFilterMatchContext = {
                from: result.parsedFrom ?? entry.envelopeFrom,
                subject: result.subject ?? "",
                bodyPreview: result.bodyPreview ?? "",
                recipientAddresses: entry.envelopeTo,
                hasAttachment: result.attachments.length > 0,
                importance: MessageImportance.NORMAL,
            };
            filterResult = evaluateMailFilterRules(rules, matchContext);
        }

        if (filterResult.deleted && filterResult.copyToFolderUids.length === 0) {
            // The message is discarded outright and no rule asked for a copy anywhere - nothing further to file.
            return;
        }

        const storedAttachments: StoredAttachment[] = await this.storeAttachmentBlobs(result.attachments);
        const flags: MessageFlags = { read: filterResult.markRead, flagged: false, answered: false, forwarded: false };

        if (!filterResult.deleted) {
            const defaultFolderType = isJunk ? FolderType.JUNK : FolderType.INBOX;
            const folder: F = await this.resolveTargetFolder(entry.mailboxUid, filterResult.moveToFolderUid, defaultFolderType);

            const message: M = await this.messageRepo!.create(
                new this.messageClass({
                    uid: targetUid,
                    folderUid: folder.uid,
                    mailboxUid: entry.mailboxUid,
                    messageId: result.messageIdHeader ?? crypto.randomUUID(),
                    subject: result.subject ?? "",
                    from: { address: entry.envelopeFrom, displayName: result.parsedFrom, type: RecipientType.TO },
                    recipients: entry.envelopeTo.map((address) => ({ address, type: RecipientType.TO })),
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey: entry.rawBlobKey,
                    sanitizedHtmlBlobKey,
                    bodyPreview: result.bodyPreview ?? "",
                    flags,
                    importance: MessageImportance.NORMAL,
                    references: [],
                    hasAttachments: storedAttachments.length > 0,
                    scanResultUid: scanResult.uid,
                }),
                { ignoreACL: true },
            );
            this.notificationUtils?.sendMessage(folder.uid, this.messageClass.name, "create", message);
            await this.attachRows(storedAttachments, message, folder, entry.mailboxUid);
            await this.bumpFolderCounters(folder, filterResult.markRead ? 0 : 1);
        }

        for (const copyFolderUid of filterResult.copyToFolderUids) {
            const copyFolder: F | undefined = await this.folderRepo!.findOne(copyFolderUid, { ignoreACL: true });
            if (!copyFolder) {
                continue;
            }
            const copyMessage: M = await this.messageRepo!.create(
                new this.messageClass({
                    folderUid: copyFolder.uid,
                    mailboxUid: entry.mailboxUid,
                    messageId: result.messageIdHeader ?? crypto.randomUUID(),
                    subject: result.subject ?? "",
                    from: { address: entry.envelopeFrom, displayName: result.parsedFrom, type: RecipientType.TO },
                    recipients: entry.envelopeTo.map((address) => ({ address, type: RecipientType.TO })),
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    bodyBlobKey: entry.rawBlobKey,
                    sanitizedHtmlBlobKey,
                    bodyPreview: result.bodyPreview ?? "",
                    flags,
                    importance: MessageImportance.NORMAL,
                    references: [],
                    hasAttachments: storedAttachments.length > 0,
                    scanResultUid: scanResult.uid,
                }),
                { ignoreACL: true },
            );
            this.notificationUtils?.sendMessage(copyFolder.uid, this.messageClass.name, "create", copyMessage);
            await this.attachRows(storedAttachments, copyMessage, copyFolder, entry.mailboxUid);
            await this.bumpFolderCounters(copyFolder, filterResult.markRead ? 0 : 1);
        }

        for (const forwardTo of filterResult.forwardTo) {
            try {
                // The message already passed the scan pipeline this same run, so it's relayed as-is (no
                // re-scan) - a straight envelope-only forward.
                await this.mailTransport!.send({ raw, envelopeFrom: entry.envelopeFrom, envelopeTo: [forwardTo] });
            } catch (err: any) {
                this.logger?.warn(`ScanQueueJob: failed to forward message to ${forwardTo}: ${err.message}`);
            }
        }
    }

    private async resolveTargetFolder(
        mailboxUid: string,
        moveToFolderUid: string | undefined,
        defaultType: Exclude<FolderType, FolderType.USER>,
    ): Promise<F> {
        if (moveToFolderUid) {
            const moved: F | undefined = await this.folderRepo!.findOne(moveToFolderUid, { ignoreACL: true });
            if (moved) {
                return moved;
            }
            // The rule's target folder no longer exists (e.g. deleted after the rule was created) - fall back
            // to the default destination rather than failing delivery outright.
        }
        return await findOrCreateWellKnownFolder(this.folderRepo!, this.folderClass, mailboxUid, defaultType);
    }

    private async storeAttachmentBlobs(attachments: ScanPipelineAttachmentResult[]): Promise<StoredAttachment[]> {
        const stored: StoredAttachment[] = [];
        for (const attachment of attachments) {
            const blobKey = `attachments/${crypto.randomUUID()}`;
            await this.blobStore!.put(blobKey, attachment.content, { contentType: attachment.contentType });
            stored.push({
                filename: attachment.filename ?? "attachment",
                contentType: attachment.contentType,
                sizeBytes: attachment.content.length,
                blobKey,
                contentId: attachment.contentId,
                isInline: attachment.isInline,
            });
        }
        return stored;
    }

    private async attachRows(stored: StoredAttachment[], message: M, folder: F, mailboxUid: string): Promise<void> {
        for (const attachment of stored) {
            await this.attachmentRepo!.create(
                new this.attachmentClass({
                    messageUid: message.uid,
                    folderUid: folder.uid,
                    mailboxUid,
                    filename: attachment.filename,
                    mimeType: attachment.contentType,
                    sizeBytes: attachment.sizeBytes,
                    blobKey: attachment.blobKey,
                    contentId: attachment.contentId,
                    isInline: attachment.isInline,
                }),
                { ignoreACL: true },
            );
        }
    }

    private async bumpFolderCounters(folder: F, unreadIncrement: number): Promise<void> {
        await this.folderRepo!.update(
            {
                uid: folder.uid,
                version: (folder as any).version,
                unreadCount: folder.unreadCount + unreadIncrement,
                totalCount: folder.totalCount + 1,
                syncKeyVersion: folder.syncKeyVersion + 1,
            } as any,
            folder,
            { ignoreACL: true },
        );
    }

    /**
     * Sends an automatic (out-of-office) reply for a "deliver"-verdicted message, if the mailbox (or a linked
     * `CalendarEvent`) is currently out of office, the message is eligible per RFC 3834 (`isAutoReplyEligible()`),
     * and the sender hasn't already received one within the configured resuppression window.
     */
    private async maybeSendAutoReply(entry: Q, raw: Buffer, result: ScanPipelineResult): Promise<void> {
        if (
            !isAutoReplyEligible(entry.envelopeFrom, {
                autoSubmittedHeader: result.autoSubmittedHeader,
                precedenceHeader: result.precedenceHeader,
            })
        ) {
            return;
        }

        const mailbox: X | undefined = await this.mailboxRepo!.findOne(entry.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            return;
        }

        const now = new Date();
        const activeEvents: CE[] = await this.calendarEventRepo!.find(
            {
                mailboxUid: entry.mailboxUid,
                autoReplyEnabled: true,
                startDate: `lte(${now.toISOString()})`,
                endDate: `gte(${now.toISOString()})`,
                limit: 1,
            } as any,
            { ignoreACL: true, limit: 1 },
        );

        const activeOof = resolveActiveOof(mailbox, activeEvents[0]);
        if (!activeOof) {
            return;
        }

        const existing: OS[] = await this.oofReplySuppressionRepo!.find(
            { mailboxUid: entry.mailboxUid, senderAddress: entry.envelopeFrom, limit: 1 } as any,
            { ignoreACL: true, limit: 1 },
        );
        const suppression: OS | undefined = existing[0];
        if (suppression) {
            const resuppressWindowMs = this.resuppressAfterHours * 60 * 60 * 1000;
            if (now.getTime() - suppression.lastRepliedAt.getTime() < resuppressWindowMs) {
                return;
            }
        }

        try {
            const subject = result.subject ? `Automatic reply: ${result.subject}` : "Automatic reply";
            const composed: Buffer = await new MailComposer({
                from: { name: mailbox.displayName, address: mailbox.primarySmtpAddress },
                to: entry.envelopeFrom,
                subject,
                html: activeOof.message,
                inReplyTo: result.messageIdHeader,
                references: result.messageIdHeader,
                headers: { "Auto-Submitted": "auto-replied" },
            })
                .compile()
                .build();

            await this.mailTransport!.send({
                raw: composed,
                envelopeFrom: mailbox.primarySmtpAddress,
                envelopeTo: [entry.envelopeFrom],
            });

            if (suppression) {
                await this.oofReplySuppressionRepo!.update(
                    { uid: suppression.uid, version: (suppression as any).version, lastRepliedAt: now } as any,
                    suppression,
                    { ignoreACL: true },
                );
            } else {
                await this.oofReplySuppressionRepo!.create(
                    new this.oofReplySuppressionClass({ mailboxUid: entry.mailboxUid, senderAddress: entry.envelopeFrom, lastRepliedAt: now }),
                    { ignoreACL: true },
                );
            }
        } catch (err: any) {
            this.logger?.warn(`ScanQueueJob: failed to send automatic reply for mailbox ${entry.mailboxUid}: ${err.message}`);
        }
    }

    /**
     * Applies a `BaseMessageRoute.recall()` control message's effect in this mailbox (`entry.mailboxUid`):
     * finds the target `Message` by `messageId` - matching regardless of which folder it's since been moved
     * to, mirroring how `findCalendarEventRow()` matches an iTIP message by `icalUid` rather than a foreign
     * key - and deletes it only if still unread, matching real Exchange/Outlook's "Recall This Message"
     * behavior exactly. Either way, reports the outcome back to the original sender - see
     * `sendRecallReport()`.
     */
    private async processRecall(entry: Q, recallOfMessageId: string): Promise<void> {
        const matches: M[] = await this.messageRepo!.find(
            { mailboxUid: entry.mailboxUid, messageId: recallOfMessageId, limit: 5 } as any,
            { ignoreACL: true, limit: 5 },
        );
        const target: M | undefined = matches.find((message) => !message.flags.read);

        let outcome: "succeeded" | "already_read" | "not_found";
        if (target) {
            await this.messageRepo!.delete(target.uid, { ignoreACL: true });
            outcome = "succeeded";
        } else {
            outcome = matches.length > 0 ? "already_read" : "not_found";
        }

        await this.sendRecallReport(entry, outcome);
    }

    /**
     * Sends a plain, visible report email back to `entry.envelopeFrom` (the mailbox that requested the
     * recall) describing what happened in *this* mailbox - mirrors real Outlook's own recall-report
     * behavior (a normal email in the sender's Inbox, not a synced status flag). Best-effort, same as every
     * other cross-mailbox notification in this codebase.
     */
    private async sendRecallReport(entry: Q, outcome: "succeeded" | "already_read" | "not_found"): Promise<void> {
        const mailbox: X | undefined = await this.mailboxRepo!.findOne(entry.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            return;
        }

        // Kept short and single-line deliberately: `MailComposer` quoted-printable-encodes a plain-text body
        // and soft-wraps around 76 characters, which would otherwise split a longer sentence's words across a
        // `=\r\n` line break in the raw wire bytes - annoying for anything that greps the raw message for a
        // specific phrase (this codebase's own tests included).
        const text = {
            succeeded: `Recalled from ${mailbox.primarySmtpAddress} before it was read.`,
            already_read: `Not recalled from ${mailbox.primarySmtpAddress} - already read.`,
            not_found: `Not recalled from ${mailbox.primarySmtpAddress} - not found.`,
        }[outcome];

        try {
            const composed: Buffer = await new MailComposer({
                from: { name: mailbox.displayName, address: mailbox.primarySmtpAddress },
                to: entry.envelopeFrom,
                subject: "Recall report",
                text,
            })
                .compile()
                .build();
            await this.mailTransport!.send({ raw: composed, envelopeFrom: mailbox.primarySmtpAddress, envelopeTo: [entry.envelopeFrom] });
        } catch (err: any) {
            this.logger?.warn(`ScanQueueJob: failed to send recall report for mailbox ${entry.mailboxUid}: ${err.message}`);
        }
    }

    /**
     * Applies the calendar-mutation side effect of an inbound iTIP REQUEST/REPLY/CANCEL message, if this
     * message carries one - the message itself still gets filed to Inbox normally via `deliverMessage()`
     * (unchanged), exactly like Outlook/OWA still show "Jane accepted your meeting" mails in the Inbox
     * alongside the calendar update.
     *
     * Every lookup below matches by `(icalUid, recurrenceId)` together, not `icalUid` alone: a
     * `parsed.recurrenceId` present means the message is about one occurrence's own override row; absent
     * means it's about the master/whole-series row - see `IcsUtils.ts`'s own doc comment on the master/
     * override `CalendarEvent` row model this relies on.
     */
    private async maybeProcessItipMessage(entry: Q, result: ScanPipelineResult): Promise<void> {
        if (!result.icsPart) {
            return;
        }
        const parsed: ParsedIcsEvent | undefined = parseIcsEvent(result.icsPart);
        if (!parsed) {
            return;
        }

        try {
            switch (parsed.method) {
                case "REQUEST":
                    await this.processItipRequest(entry.mailboxUid, parsed);
                    break;
                case "REPLY":
                    await this.processItipReply(entry.mailboxUid, parsed);
                    break;
                case "CANCEL":
                    await this.processItipCancel(entry.mailboxUid, parsed);
                    break;
                default:
                    break;
            }
        } catch (err: any) {
            this.logger?.warn(`ScanQueueJob: failed to process iTIP ${parsed.method} for event ${parsed.uid}: ${err.message}`);
        }
    }

    /** Finds the `CalendarEvent` row in `mailboxUid` matching `(icalUid, recurrenceId)` together, if any. */
    private async findCalendarEventRow(mailboxUid: string, icalUid: string, recurrenceId: Date | undefined): Promise<CE | undefined> {
        const rows: CE[] = await this.calendarEventRepo!.find(
            { mailboxUid, icalUid, limit: 50 } as any,
            { ignoreACL: true, limit: 50 },
        );
        return rows.find((row) => recurrenceIdsMatch(row.recurrenceId, recurrenceId));
    }

    private async processItipRequest(mailboxUid: string, parsed: ParsedIcsEvent): Promise<void> {
        const existing = await this.findCalendarEventRow(mailboxUid, parsed.uid, parsed.recurrenceId);
        if (existing && parsed.sequence <= existing.sequence) {
            // Stale/duplicate resend - already have this revision (or a newer one).
            return;
        }

        let attendees: Attendee[] = parsed.attendees.map((attendee) => ({
            address: attendee.address,
            displayName: attendee.displayName,
            role: AttendeeRole.REQUIRED,
            responseStatus: attendee.partstat ?? AttendeeResponseStatus.NEEDS_ACTION,
            isOrganizer: false,
        }));

        // A resource mailbox (a room/equipment "attendee") with auto-accept enabled decides its own
        // response here - the one and only place this mailbox's own copy of the invite comes into being.
        const mailbox: X | undefined = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
        let decision: AttendeeResponseStatus | undefined;
        if (mailbox?.isResource && mailbox.autoAcceptBookings && parsed.startDate && parsed.endDate) {
            decision = await this.decideResourceBooking(mailbox, parsed);
            const resourceDecision = decision;
            const mailboxAddresses = [mailbox.primarySmtpAddress, ...mailbox.aliasAddresses].map((a) => a.toLowerCase());
            attendees = attendees.map((attendee) =>
                mailboxAddresses.includes(attendee.address.toLowerCase()) ? { ...attendee, responseStatus: resourceDecision } : attendee,
            );
        }

        let row: CE;
        if (!existing) {
            const folder: F = await findOrCreateWellKnownFolder(this.folderRepo!, this.folderClass, mailboxUid, FolderType.CALENDAR);
            row = await this.calendarEventRepo!.create(
                new this.calendarEventClass({
                    folderUid: folder.uid,
                    mailboxUid,
                    title: parsed.summary ?? "",
                    location: parsed.location,
                    startDate: parsed.startDate ?? new Date(),
                    endDate: parsed.endDate ?? new Date(),
                    allDay: false,
                    timezone: "UTC",
                    organizer: parsed.organizer
                        ? { address: parsed.organizer.address, displayName: parsed.organizer.displayName, type: RecipientType.TO }
                        : { address: "", type: RecipientType.TO },
                    attendees,
                    recurrenceRule: parsed.recurrenceRule,
                    recurrenceId: parsed.recurrenceId,
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid: parsed.uid,
                    sequence: parsed.sequence,
                }),
                { ignoreACL: true },
            );
        } else {
            row = await this.calendarEventRepo!.update(
                {
                    uid: existing.uid,
                    version: (existing as any).version,
                    title: parsed.summary ?? existing.title,
                    location: parsed.location,
                    startDate: parsed.startDate ?? existing.startDate,
                    endDate: parsed.endDate ?? existing.endDate,
                    attendees,
                    recurrenceRule: parsed.recurrenceRule ?? existing.recurrenceRule,
                    sequence: parsed.sequence,
                } as any,
                existing,
                { ignoreACL: true },
            );
        }

        if (mailbox && decision !== undefined) {
            await this.finalizeResourceDecision(mailbox, row, decision);
        }
    }

    /**
     * Decides accept/decline for an inbound booking request against `mailbox` (a resource mailbox with
     * `autoAcceptBookings` on) - mirrors Exchange's `Set-CalendarProcessing -AutomateProcessing AutoAccept`
     * policy checks (duration/booking-window limits evaluated against the request's first occurrence only,
     * matching real Exchange's "can't partially book a series" behavior, then conflict detection unless
     * `allowConflicts` is set). Both the incoming request and every existing booking are expanded through
     * `expandOccurrences()` so a recurring series is checked occurrence-by-occurrence, not just at its first
     * instance - see this job's own doc comment / the plan this shipped under for the full rationale.
     */
    private async decideResourceBooking(mailbox: X, parsed: ParsedIcsEvent): Promise<AttendeeResponseStatus> {
        const startDate = parsed.startDate!;
        const endDate = parsed.endDate!;

        // `!= null` (not `!== undefined`) below: an unset optional numeric column comes back from the SQL
        // backend as `null`, not `undefined` (Mongo omits the field entirely) - see the `MailboxSQL`/
        // `MailboxMongo` field doc comments.
        if (mailbox.maxDurationMinutes != null) {
            const durationMinutes = (endDate.getTime() - startDate.getTime()) / 60_000;
            if (durationMinutes > mailbox.maxDurationMinutes) {
                return AttendeeResponseStatus.DECLINED;
            }
        }
        if (mailbox.bookingWindowDays != null) {
            const latestBookableStart = Date.now() + mailbox.bookingWindowDays * MS_PER_DAY;
            if (startDate.getTime() > latestBookableStart) {
                return AttendeeResponseStatus.DECLINED;
            }
        }
        if (mailbox.allowConflicts) {
            return AttendeeResponseStatus.ACCEPTED;
        }

        const horizonEnd = new Date(startDate.getTime() + RESOURCE_BOOKING_HORIZON_MS);
        const requestedOccurrences: OccurrenceWindow[] = expandOccurrences(
            { startDate, endDate, recurrenceRule: parsed.recurrenceRule },
            startDate,
            horizonEnd,
            parsed.recurrenceRule?.exceptions,
        );

        const existingRows: CE[] = await this.calendarEventRepo!.find(
            { mailboxUid: mailbox.uid, limit: RESOURCE_BOOKING_EXISTING_ROWS_LIMIT } as any,
            { ignoreACL: true, limit: RESOURCE_BOOKING_EXISTING_ROWS_LIMIT },
        );

        for (const candidateRow of existingRows) {
            if (candidateRow.icalUid === parsed.uid) {
                // A prior row of this very request (a resend/update) - never conflicts with itself.
                continue;
            }
            const isMaster = !!candidateRow.recurrenceRule && !candidateRow.recurrenceId;
            const excludeDates = isMaster
                ? [
                      ...(candidateRow.recurrenceRule?.exceptions ?? []),
                      ...existingRows
                          .filter((row) => row.icalUid === candidateRow.icalUid && row.recurrenceId)
                          .map((row) => row.recurrenceId!),
                  ]
                : undefined;
            const existingOccurrences = expandOccurrences(
                { startDate: candidateRow.startDate, endDate: candidateRow.endDate, recurrenceRule: candidateRow.recurrenceRule },
                startDate,
                horizonEnd,
                excludeDates,
            );

            for (const requested of requestedOccurrences) {
                for (const existingOccurrence of existingOccurrences) {
                    if (
                        requested.start.getTime() < existingOccurrence.end.getTime() &&
                        requested.end.getTime() > existingOccurrence.start.getTime()
                    ) {
                        return AttendeeResponseStatus.DECLINED;
                    }
                }
            }
        }

        return AttendeeResponseStatus.ACCEPTED;
    }

    /**
     * Applies a resource's auto-accept/decline `decision` to `row` (declining soft-deletes it, same as a
     * human's decline via `BaseCalendarEventRoute.respond()`), then sends an iTIP `REPLY` for the resource's
     * own attendee entry back to the organizer - reusing the exact same `buildEventIcs()`/`MailComposer`/
     * `MailTransport.send()` sequence `respond()` already uses, best-effort (a send failure is logged, not
     * thrown - the calendar mutation itself has already succeeded either way).
     */
    private async finalizeResourceDecision(mailbox: X, row: CE, decision: AttendeeResponseStatus): Promise<void> {
        if (decision === AttendeeResponseStatus.DECLINED) {
            await this.calendarEventRepo!.delete(row.uid, { ignoreACL: true });
        }

        const mailboxAddresses = [mailbox.primarySmtpAddress, ...mailbox.aliasAddresses].map((a) => a.toLowerCase());
        const resourceAttendee = row.attendees.find((attendee) => mailboxAddresses.includes(attendee.address.toLowerCase()));
        if (!resourceAttendee) {
            return;
        }

        try {
            const ics = buildEventIcs({ ...row, attendees: [resourceAttendee] }, "REPLY", { onlyAttendee: resourceAttendee });
            const verb = decision === AttendeeResponseStatus.DECLINED ? "declined" : "accepted";
            const composed: Buffer = await new MailComposer({
                from: { name: mailbox.displayName, address: mailbox.primarySmtpAddress },
                to: row.organizer.address,
                subject: `${decision === AttendeeResponseStatus.DECLINED ? "Declined" : "Accepted"}: ${row.title}`,
                text: `${mailbox.displayName || mailbox.primarySmtpAddress} has automatically ${verb}: ${row.title}`,
                icalEvent: { method: "reply", content: ics },
            })
                .compile()
                .build();
            await this.mailTransport!.send({ raw: composed, envelopeFrom: mailbox.primarySmtpAddress, envelopeTo: [row.organizer.address] });
        } catch (err: any) {
            this.logger?.warn(`ScanQueueJob: failed to send resource auto-response for event ${row.uid}: ${err.message}`);
        }
    }

    private async processItipReply(mailboxUid: string, parsed: ParsedIcsEvent): Promise<void> {
        const existing = await this.findCalendarEventRow(mailboxUid, parsed.uid, parsed.recurrenceId);
        const replyingAttendee = parsed.attendees[0];
        if (!existing || !replyingAttendee?.partstat) {
            return;
        }

        const attendees = existing.attendees.map((attendee) =>
            attendee.address.toLowerCase() === replyingAttendee.address.toLowerCase()
                ? { ...attendee, responseStatus: replyingAttendee.partstat! }
                : attendee,
        );
        await this.calendarEventRepo!.update(
            { uid: existing.uid, version: (existing as any).version, attendees } as any,
            existing,
            { ignoreACL: true },
        );
    }

    private async processItipCancel(mailboxUid: string, parsed: ParsedIcsEvent): Promise<void> {
        if (parsed.recurrenceId) {
            const override = await this.findCalendarEventRow(mailboxUid, parsed.uid, parsed.recurrenceId);
            if (override) {
                await this.calendarEventRepo!.delete(override.uid, { ignoreACL: true });
                return;
            }
            // No override row exists for this occurrence yet - drop it from the master's own recurrence
            // definition instead, the standard RFC 5545 way to exclude one occurrence from an otherwise-
            // unmodified series.
            const master = await this.findCalendarEventRow(mailboxUid, parsed.uid, undefined);
            if (master?.recurrenceRule) {
                const exceptions = [...(master.recurrenceRule.exceptions ?? []), parsed.recurrenceId];
                await this.calendarEventRepo!.update(
                    { uid: master.uid, version: (master as any).version, recurrenceRule: { ...master.recurrenceRule, exceptions } } as any,
                    master,
                    { ignoreACL: true },
                );
            }
            return;
        }

        // No `recurrenceId` - cancelling the whole series: remove the master and every override row sharing
        // its `icalUid`.
        const rows: CE[] = await this.calendarEventRepo!.find(
            { mailboxUid, icalUid: parsed.uid, limit: 50 } as any,
            { ignoreACL: true, limit: 50 },
        );
        for (const row of rows) {
            await this.calendarEventRepo!.delete(row.uid, { ignoreACL: true });
        }
    }
}
