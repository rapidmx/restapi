///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, NotificationUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { resolveDeliveryVerdict, ScanPipeline, ScanPipelineAttachmentResult, ScanPipelineResult } from "../scan/ScanPipeline.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { hasAlignedPassingDkim } from "../util/AuthenticationResultsUtils.js";
import { isAutoReplyEligible } from "../util/AutoReplyUtils.js";
import { deriveConversationId } from "../util/ConversationUtils.js";
import { classifyRecipientTier, createFederatedPeerCheck, getVerifiedDomainNames } from "../util/DomainUtils.js";
import { classifyMessage, FocusedInboxSignals } from "../util/FocusedInboxUtils.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { buildEventIcs, expandOccurrences, OccurrenceWindow, parseIcsEvent, ParsedIcsEvent } from "../util/IcsUtils.js";
import { applyDiscoveredKeys, ContactKeyState, discoverAndMergeKeys } from "../util/KeyringUtils.js";
import { evaluateMailFilterRules, MailFilterEvaluationResult, MailFilterMatchContext } from "../util/MailFilterUtils.js";
import { extractHeader, extractHeaders } from "../util/MimeHeaderUtils.js";
import { resolveActiveOof } from "../util/OofUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { buildDispositionNotification, parseDispositionNotification } from "../util/ReceiptUtils.js";
import { parseRapidMxKeyHeader } from "../util/RapidMxKeyHeaderUtils.js";
import {
    Attachment,
    Attendee,
    AttendeeRole,
    AttendeeResponseStatus,
    AvVerdict,
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    Contact,
    ContactAddressKind,
    EncryptionOrigin,
    FocusedInboxOverride,
    Folder,
    FolderType,
    IngestQueueEntry,
    IngestStatus,
    KeyDiscoveryResponse,
    Mailbox,
    MailFilterRule,
    Message,
    MessageClassification,
    MessageFlags,
    MessageImportance,
    MessageReceiptEntry,
    OofReplySuppression,
    PublicKey,
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

/** The two `Rfc8823AcmeSigningCertificateEnrollment`-specific methods `tryCorrelateAcmeChallenge()`
 * needs - see `signingCertificateEnrollment`'s own doc comment on why this is a local, narrow shape
 * rather than an import of that concrete class (this file has no other reason to depend on `src/pki/`
 * at all) or an addition to the shared `SigningCertificateEnrollment` interface. */
interface AcmeChallengeCorrelator {
    findPendingEnrollmentId?(identity: string, from: string): Promise<string | undefined>;
    recordChallengeToken?(enrollmentId: string, tokenPart1: string, replyTo: string, messageId: string, subject: string): Promise<void>;
}

/** RFC 8823's own challenge-email format - see `Rfc8823AcmeSigningCertificateEnrollment`'s doc comment
 * and the RFC itself: `Subject: ACME: <token-part1>`, optionally `Re: `-prefixed once a mail client
 * (not relevant here, but real ones exist) replies-of-a-reply. */
const ACME_CHALLENGE_SUBJECT = /^(?:Re: )?ACME: (.+)$/;

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
    FIO extends FocusedInboxOverride,
    C extends Contact,
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
    protected abstract focusedInboxOverrideClass: any;
    protected abstract contactClass: any;
    protected abstract domainClass: any;

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
    private focusedInboxOverrideRepo?: RepoUtils<FIO>;
    private contactRepo?: RecoverableRepoUtils<C>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    @Inject("MailTransport")
    private mailTransport?: any;

    /** Publishes a live-update notification (see `push/MailPushRoute.ts`) once a message is delivered. */
    @Inject(NotificationUtils)
    private notificationUtils?: NotificationUtils;

    /** Backs the real federated-peer check `classifyRecipientTier()` calls (`util/DomainUtils.ts`'s
     * `createFederatedPeerCheck()`) - same DI token `BaseDomainRoute`/`DomainVerificationJob` already
     * register/consume, so every deployment and test environment already has one. */
    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

    /** Same DI token every `SigningCertificateEnrollment` consumer registers under (see
     * `BaseKeyVaultRoute`'s identical `EncryptionCertificateAuthority` pattern) - typed loosely here
     * rather than as the shared `SigningCertificateEnrollment` interface, since
     * `findPendingEnrollmentId()`/`recordChallengeToken()` are specific to the real RFC 8823
     * implementation, not something `NullSigningCertificateEnrollment`/`ManualSigningCertificateEnrollment`
     * have any business declaring. `tryCorrelateAcmeChallenge()` feature-detects both methods before
     * calling either, so a deployment running a different implementation (including the `Null` default)
     * simply never matches - every inbound message falls through to normal delivery unchanged. */
    @Inject("SigningCertificateEnrollment")
    private signingCertificateEnrollment?: AcmeChallengeCorrelator;

    @Config("mail:jobs:scan_queue:schedule", "*/10 * * * * *")
    private scheduleExpr: string = "*/10 * * * * *";

    @Config("mail:jobs:scan_queue:batch_size", 25)
    private batchSize: number = 25;

    @Config("mail:oof:resuppress_after_hours", 24)
    private resuppressAfterHours: number = 24;

    /** Master switch for Focused Inbox classification at delivery time. Off leaves every message's
     * `inferenceClassification` unset, which clients already treat as Focused - so turning this off is
     * equivalent to not having the feature, with no other behavior change. */
    @Config("mail:focused_inbox:enabled", true)
    private focusedInboxEnabled: boolean = true;

    /** The spam score at/above which mail that still cleared the junk cutoff is classified as Other. */
    @Config("mail:focused_inbox:other_spam_score", 3)
    private focusedInboxOtherSpamScore: number = 3;

    /** This server's own inbound mail-exchange hostname, reused as the `Reporting-UA` half of a generated
     * delivery/read receipt MDN (RFC 3798 §3.2.1) - same config `BaseDomainRoute` already reads for its own,
     * unrelated purpose (a `Domain`'s recommended MX record). */
    @Config("mail:dns:mx_hostname", "")
    private mxHostname: string = "";

    /** The `authserv-id` this deployment's trusted MTA/milter hop is configured to stamp on its own
     * `Authentication-Results` header (RFC 8601) - required to gate acceptance of an inbound `RapidMX-Key`
     * header and of MDN receipts on genuine, aligned DKIM verification (see `util/
     * AuthenticationResultsUtils.ts`'s `hasAlignedPassingDkim()` and `BaseMailIngestRoute`'s own doc comment
     * for the corresponding MTA-side requirement). Left unconfigured (`""`), both gates fail closed - no
     * `Authentication-Results` header is ever trusted - rather than silently accepting any header found. */
    @Config("mail:security:trusted_authserv_id", "")
    private trustedAuthservId: string = "";

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
        this.focusedInboxOverrideRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.focusedInboxOverrideClass.name,
            args: [this.focusedInboxOverrideClass],
        });
        this.contactRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.contactClass.name,
            args: [this.contactClass],
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
        } else if (verdict === "deliver" && result.dispositionNotificationPart) {
            // An inbound MDN receipt is never filed either - only the indicator it stamps onto the original
            // sent message, if any is found - see processReceipt()'s own doc comment.
            await this.processReceipt(entry, raw, result.dispositionNotificationPart);
        } else if (verdict === "deliver" && (await this.tryCorrelateAcmeChallenge(entry, result))) {
            // A real RFC 8823 challenge email is CA-internal plumbing, never filed either - same treatment
            // recall control messages and inbound MDNs already get. Unlike those two, correlation here can
            // genuinely fail (a spoofed or stale lookalike, or no outstanding enrollment at all) - in that
            // case `tryCorrelateAcmeChallenge()` itself returns `false` and this branch is never taken, so
            // the message falls through to ordinary delivery below rather than being silently dropped.
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
     * for a "deliver" verdict - `isJunk` mail skips rule evaluation entirely). A requested delivery receipt
     * (see `maybeSendDeliveryReceipt()`) is decided and sent - or held pending approval - only for the
     * *primary* message (never a rule's `copyToFolderUids` copy), and not at all for a message a rule deletes
     * outright: a receipt for a message the mailbox owner's own rule routed elsewhere or discarded entirely
     * would be misleading.
     */
    private async deliverMessage(
        entry: Q,
        raw: Buffer,
        targetUid: string,
        scanResult: SR,
        result: ScanPipelineResult,
        isJunk: boolean,
    ): Promise<void> {
        // Independent of everything below (filtering, filing, junk classification) - `specs/
        // end-to-end_encryption.md`'s "Only inbound messages are processed, keyed on the From address" rule
        // applies to every delivered message regardless of which folder (or none) it ends up filed into.
        await this.processInboundRapidMxKeyHeader(entry, raw, result);

        let sanitizedHtmlBlobKey: string | undefined;
        if (result.sanitizedHtml !== undefined) {
            sanitizedHtmlBlobKey = `sanitized/${crypto.randomUUID()}`;
            await this.blobStore!.put(sanitizedHtmlBlobKey, Buffer.from(result.sanitizedHtml, "utf-8"), {
                contentType: "text/html",
            });
        }

        let filterResult: MailFilterEvaluationResult = {
            copyToFolderUids: [],
            deleted: false,
            markRead: false,
            forwardTo: [],
            labelUidsToApply: [],
        };
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

            const messageId = result.messageIdHeader ?? crypto.randomUUID();
            const conversationId: string | undefined = deriveConversationId(result.references, result.inReplyTo, messageId);
            // Classified before the row is written so the conversation lookup can't match this very message.
            const inferenceClassification: MessageClassification | undefined = await this.classifyForInbox(
                entry,
                result,
                folder,
                isJunk,
                conversationId,
            );
            // A delivery receipt (if requested) is decided and sent - or held pending approval - before the
            // row exists, so the outcome can be written directly into the initial `create()` rather than a
            // second follow-up `update()`. Gated on `dispositionNotificationTo` being present at all: the
            // overwhelmingly common case is no receipt requested, which costs nothing beyond one property
            // check - no mailbox lookup, no `classifyRecipientTier()` query.
            let deliveryReceiptSentAt: Date | undefined;
            let deliveryReceiptPending = false;
            // `specs/end-to-end_encryption.md` §Header Integrity: `Disposition-Notification-To` MUST be
            // DKIM-verified (an unverified header is treated as absent) and MUST be compared against `From`
            // before a response is generated, so an attacker can't inject an arbitrary redirect address into a
            // message and turn this mailbox into an MDN reflector. Also gated on RFC 3834 auto-reply
            // eligibility (`isAutoReplyEligible()`, the same check `maybeSendAutoReply()` uses) - an MDN is
            // itself an automatic reply and shouldn't be generated for bulk/auto-submitted mail either.
            if (
                result.dispositionNotificationTo &&
                result.fromAddress &&
                normalizeAddress(result.dispositionNotificationTo) === normalizeAddress(result.fromAddress) &&
                hasAlignedPassingDkim(
                    extractHeaders(raw, "Authentication-Results"),
                    result.fromAddress.split("@")[1] ?? "",
                    this.trustedAuthservId,
                ) &&
                isAutoReplyEligible(entry.envelopeFrom, {
                    autoSubmittedHeader: result.autoSubmittedHeader,
                    precedenceHeader: result.precedenceHeader,
                })
            ) {
                const mailbox: X | undefined = await this.mailboxRepo!.findOne(entry.mailboxUid, { ignoreACL: true });
                if (mailbox) {
                    const outcome = await this.maybeSendDeliveryReceipt(
                        result.dispositionNotificationTo,
                        mailbox,
                        messageId,
                        result.subject ?? "",
                    );
                    deliveryReceiptSentAt = outcome.sentAt;
                    deliveryReceiptPending = outcome.pending;
                }
            }
            const message: M = await this.messageRepo!.create(
                new this.messageClass({
                    uid: targetUid,
                    folderUid: folder.uid,
                    mailboxUid: entry.mailboxUid,
                    messageId,
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
                    inReplyTo: result.inReplyTo,
                    references: result.references,
                    conversationId,
                    inferenceClassification,
                    hasAttachments: storedAttachments.length > 0,
                    labelUids: filterResult.labelUidsToApply,
                    encrypted: result.encrypted,
                    scanResultUid: scanResult.uid,
                    dispositionNotificationTo: result.dispositionNotificationTo,
                    deliveryReceiptSentAt,
                    deliveryReceiptPending,
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
            const copyMessageId = result.messageIdHeader ?? crypto.randomUUID();
            const copyConversationId: string | undefined = deriveConversationId(
                result.references,
                result.inReplyTo,
                copyMessageId,
            );
            // A rule can copy into the Inbox itself, in which case that copy is classified like any other
            // Inbox mail; a copy filed anywhere else is left unclassified (`classifyForInbox()` returns
            // `undefined` without doing any lookup for a non-Inbox destination).
            const copyClassification: MessageClassification | undefined = await this.classifyForInbox(
                entry,
                result,
                copyFolder,
                isJunk,
                copyConversationId,
            );
            const copyMessage: M = await this.messageRepo!.create(
                new this.messageClass({
                    folderUid: copyFolder.uid,
                    mailboxUid: entry.mailboxUid,
                    messageId: copyMessageId,
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
                    inReplyTo: result.inReplyTo,
                    references: result.references,
                    conversationId: copyConversationId,
                    inferenceClassification: copyClassification,
                    hasAttachments: storedAttachments.length > 0,
                    labelUids: filterResult.labelUidsToApply,
                    encrypted: result.encrypted,
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

    /**
     * Builds the query fragment that matches a `Contact` whose `emails` array contains `address`. MongoDB
     * addresses an array element's own field with dot notation natively, so the default here does exactly
     * that. `ScanQueueJobSQL` overrides it: the SQL backend stores `emails` as a serialized `simple-json`
     * column, where no field-addressing query is possible at all - the same problem/solution as
     * `MailIngestRouteSQL.aliasQueryValue()` and `MailboxRouteSQL.findAccessibleMailboxUids()`.
     */
    protected contactEmailQuery(address: string): any {
        return { "emails.address": address };
    }

    /**
     * Implements `specs/end-to-end_encryption.md`'s In-Band Key Attachment processing rules for an inbound
     * message's `RapidMX-Key` header (Group E3). Reuses `util/KeyringUtils.ts`'s `applyDiscoveredKeys()` -
     * the same TOFU/Key-Conflict/Anti-Downgrade merge logic Group E2's `GET /keys/lookup` uses, applied here
     * to a header-carried key instead of a live Discovery fetch.
     *
     * Fails closed at every gate: more than one `RapidMX-Key` header, an unverified/misaligned DKIM result
     * (`util/AuthenticationResultsUtils.ts`), or a header that doesn't parse
     * (`util/RapidMxKeyHeaderUtils.ts`) are all treated identically to "no key header present at all" - never
     * a thrown error, and never enough to justify creating a new `Contact` on their own (see below).
     *
     * `Contact.lastMessageSeen` is still stamped for an *existing* Contact even when nothing new was
     * discovered, per the spec's Anti-Downgrade rule - but a brand-new `Contact` is only ever created when a
     * key was actually, successfully discovered; recording `lastMessageSeen` alone is not reason enough to
     * add an address to the mailbox's own address book.
     *
     * Keyed on `result.fromAddress` (the parsed `From` header), NOT `entry.envelopeFrom` (the SMTP
     * `MAIL FROM`) - the spec is explicit twice that this processing is "keyed on the From address", and the
     * envelope address legitimately diverges from it on forwarded/mailing-list mail. DKIM/DMARC alignment is
     * likewise defined against `From`, not the envelope, so `hasAlignedPassingDkim()` is checked against
     * `fromAddress`'s domain here too.
     */
    private async processInboundRapidMxKeyHeader(entry: Q, raw: Buffer, result: ScanPipelineResult): Promise<void> {
        const fromAddress: string | undefined = result.fromAddress;
        const fromDomain: string | undefined = fromAddress?.split("@")[1];
        if (!fromAddress || !fromDomain) {
            return;
        }

        let discovered: KeyDiscoveryResponse | undefined;
        const keyHeaders: string[] = extractHeaders(raw, "RapidMX-Key");
        if (
            keyHeaders.length > 0 &&
            hasAlignedPassingDkim(extractHeaders(raw, "Authentication-Results"), fromDomain, this.trustedAuthservId)
        ) {
            const parsed = parseRapidMxKeyHeader(keyHeaders, fromAddress);
            if (parsed) {
                // Anti-Downgrade (spec): the comparison in `KeyringUtils.applyDiscoveredKeys()` is against the
                // *message's* effective date, not wall-clock time - stamping `Date.now()` here would make that
                // comparison vacuously true for a replayed/out-of-order message, defeating the whole point of
                // the check. `Date` header parses to `NaN` for a missing/malformed header; fall back to now
                // only in that case (a message with no usable date can't be replay-dated anyway).
                const dateHeader: string | undefined = extractHeader(raw, "Date");
                const effectiveDate: number = dateHeader ? Date.parse(dateHeader) : NaN;
                discovered = {
                    keys: [parsed.publicKey],
                    encryptPreference: {
                        preferEncrypt: parsed.preferEncrypt,
                        lastSeen: Number.isNaN(effectiveDate) ? Date.now() : effectiveDate,
                    },
                    escrow: false,
                };
            }
        }

        const existingMatches: C[] = await this.contactRepo!.find(
            { mailboxUid: entry.mailboxUid, limit: 1, ...this.contactEmailQuery(fromAddress) },
            { ignoreACL: true, limit: 1 },
        );
        const existingContact: C | undefined = existingMatches[0];
        if (!existingContact && !discovered) {
            // Nothing on file, nothing discovered - recording lastMessageSeen alone isn't reason enough to
            // create a Contact for every random inbound sender.
            return;
        }

        const now: number = Date.now();
        const update: ContactKeyState = applyDiscoveredKeys(existingContact, discovered, now, "header");
        await this.persistContactKeyUpdate(entry.mailboxUid, fromAddress, existingContact, update, now);
    }

    /**
     * Shared persistence tail for both `processInboundRapidMxKeyHeader()` (Group E3) and
     * `maybeRefreshRotatedKey()` (Group E5): stamps `update` (and `lastMessageSeen`) onto `existingContact` if
     * one was found, or creates a brand-new `Contact` in the mailbox's Contacts folder otherwise. Callers are
     * responsible for deciding whether creating a new `Contact` is warranted at all (see each caller's own
     * doc comment) - by the time this runs, that decision has already been made.
     */
    private async persistContactKeyUpdate(
        mailboxUid: string,
        address: string,
        existingContact: C | undefined,
        update: ContactKeyState,
        now: number,
    ): Promise<void> {
        if (existingContact) {
            await this.contactRepo!.update(
                { uid: existingContact.uid, version: (existingContact as any).version, ...update, lastMessageSeen: now } as any,
                existingContact,
                { ignoreACL: true },
            );
            return;
        }

        const folder: F = await findOrCreateWellKnownFolder(this.folderRepo!, this.folderClass, mailboxUid, FolderType.CONTACTS);
        await this.contactRepo!.create(
            new this.contactClass({
                mailboxUid,
                folderUid: folder.uid,
                displayName: address,
                emails: [{ address, type: ContactAddressKind.OTHER }],
                phones: [],
                addresses: [],
                ...update,
                lastMessageSeen: now,
            }),
            { ignoreACL: true },
        );
    }

    /**
     * Implements the receiving half of `specs/end-to-end_encryption.md`'s "Rotation Notification" mechanism
     * (Group E5): when an inbound MDN carries either of `util/ReceiptUtils.ts`'s `rotatedKeyFingerprint`/
     * `policyId` extension fields, this method re-runs real Discovery (`util/KeyringUtils.ts`'s
     * `discoverAndMergeKeys()`) against the authoritative endpoint for `peerAddress` - it never installs the
     * MDN's own claimed fingerprint directly, exactly per the spec's "cache invalidation hint only" rule: an
     * MDN is only hop-authenticated at best, so trusting its claimed value directly would let a forged MDN
     * force a key change. Called from `processReceipt()` only after that method has already confirmed
     * `peerAddress` (the MDN's `Final-Recipient`) matches this inbound message's own authenticated envelope
     * sender - the same forgery guard Group E3's header processing doesn't need (a `RapidMX-Key` header is
     * gated on DKIM instead), but this path does, since an MDN extension field carries no DKIM-oversigning
     * requirement of its own.
     *
     * A `discoverAndMergeKeys()` result of `undefined` (peer isn't a federated domain, or nothing found) is a
     * no-op here too, same as Group E3 - this is purely a hint to look again, never a reason to create or
     * change a `Contact` on its own.
     */
    private async maybeRefreshRotatedKey(mailboxUid: string, peerAddress: string): Promise<void> {
        const existingMatches: C[] = await this.contactRepo!.find(
            { mailboxUid, limit: 1, ...this.contactEmailQuery(peerAddress) },
            { ignoreACL: true, limit: 1 },
        );
        const existingContact: C | undefined = existingMatches[0];

        const now: number = Date.now();
        const update: ContactKeyState | undefined = await discoverAndMergeKeys(this.dnsResolver!, peerAddress, existingContact, now);
        if (!update) {
            return;
        }
        await this.persistContactKeyUpdate(mailboxUid, peerAddress, existingContact, update, now);
    }

    /**
     * Classifies a message about to be filed into `folder` as Focused or Other (see
     * `util/FocusedInboxUtils.ts`'s `classifyMessage()` for the decision itself, which is a pure function -
     * this method only gathers the signals it needs).
     *
     * Returns `undefined` - leaving `Message.inferenceClassification` unset - for anything that isn't
     * ordinary mail landing in the Inbox: junk-routed mail (matching the existing precedent that junk runs
     * no rules, auto-replies, or iTIP processing), mail a `MailFilterRule` filed somewhere other than the
     * Inbox, and every message at all when the feature is switched off. Those cases short-circuit before
     * any lookup, so a deployment not using Focused Inbox pays nothing for it.
     */
    private async classifyForInbox(
        entry: Q,
        result: ScanPipelineResult,
        folder: F,
        isJunk: boolean,
        conversationId: string | undefined,
    ): Promise<MessageClassification | undefined> {
        if (!this.focusedInboxEnabled || isJunk || folder.type !== FolderType.INBOX) {
            return undefined;
        }

        const senderAddress: string = normalizeAddress(entry.envelopeFrom);
        const [override, isKnownCorrespondent, domains] = await Promise.all([
            this.findFocusedInboxOverride(entry.mailboxUid, senderAddress),
            this.isKnownCorrespondent(entry.mailboxUid, senderAddress, conversationId),
            getVerifiedDomainNames(this._objectFactory!, this.domainClass),
        ]);

        const senderDomain: string | undefined = senderAddress.split("@")[1];
        const signals: FocusedInboxSignals = {
            override,
            isInternalSender: !!senderDomain && domains.includes(senderDomain),
            isKnownCorrespondent,
            listUnsubscribeHeader: result.listUnsubscribeHeader,
            precedenceHeader: result.precedenceHeader,
            autoSubmittedHeader: result.autoSubmittedHeader,
            spamScore: result.spam.score,
        };
        return classifyMessage(signals, this.focusedInboxOtherSpamScore);
    }

    /** The user's explicit Focused/Other choice for `senderAddress`, if they've made one. */
    private async findFocusedInboxOverride(
        mailboxUid: string,
        senderAddress: string,
    ): Promise<MessageClassification | undefined> {
        const matches: FIO[] = await this.focusedInboxOverrideRepo!.find(
            { mailboxUid, senderAddress, limit: 1 } as any,
            { ignoreACL: true, limit: 1 },
        );
        return matches[0]?.classifyAs;
    }

    /**
     * Whether this mailbox demonstrably corresponds with `senderAddress`: either it already holds another
     * message in the same conversation (this one is a reply into a thread the user is part of), or the
     * sender is in the mailbox's own Contacts.
     */
    private async isKnownCorrespondent(
        mailboxUid: string,
        senderAddress: string,
        conversationId: string | undefined,
    ): Promise<boolean> {
        if (conversationId) {
            const thread: M[] = await this.messageRepo!.find(
                { mailboxUid, conversationId, limit: 1 } as any,
                { ignoreACL: true, limit: 1 },
            );
            if (thread.length > 0) {
                return true;
            }
        }
        const contacts: C[] = await this.contactRepo!.find(
            { mailboxUid, ...this.contactEmailQuery(senderAddress), limit: 1 },
            { ignoreACL: true, limit: 1 },
        );
        return contacts.length > 0;
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
     * Recognizes an inbound RFC 8823 `email-reply-00` challenge email and, if it correlates to a real
     * outstanding enrollment, records its token-part1 via `recordChallengeToken()` - see this class's
     * own `signingCertificateEnrollment` field doc comment and `processEntry()`'s calling branch for
     * why a `false` return (never filed, never treated as ACME plumbing either) is the safe default
     * for anything that doesn't fully correlate.
     *
     * Cheap checks first (`Auto-Submitted` header, `Subject` shape) before ever touching the injected
     * enrollment service or performing its lookup - the overwhelming majority of inbound mail never
     * has this header at all.
     */
    private async tryCorrelateAcmeChallenge(entry: Q, result: ScanPipelineResult): Promise<boolean> {
        if (result.autoSubmittedHeader !== "auto-generated; type=acme") {
            return false;
        }
        const subjectMatch: RegExpMatchArray | null = result.subject ? ACME_CHALLENGE_SUBJECT.exec(result.subject) : null;
        if (!subjectMatch || !result.fromAddress || !result.messageIdHeader) {
            return false;
        }
        if (
            typeof this.signingCertificateEnrollment?.findPendingEnrollmentId !== "function" ||
            typeof this.signingCertificateEnrollment.recordChallengeToken !== "function"
        ) {
            return false;
        }
        // `entry.envelopeTo` is the raw SMTP `RCPT TO` address(es) for this delivery, which need not be
        // this mailbox's own `primarySmtpAddress` (an alias, or another recipient in the same
        // transaction) - `startEnrollment()`'s `identity` is always submitted as the mailbox's real
        // primary address (see the REST endpoint that calls it), so that's what correlation matches
        // against here, not the envelope.
        const mailbox: X | undefined = await this.mailboxRepo!.findOne(entry.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            return false;
        }

        const enrollmentId: string | undefined = await this.signingCertificateEnrollment.findPendingEnrollmentId(
            mailbox.primarySmtpAddress,
            result.fromAddress,
        );
        if (!enrollmentId) {
            return false;
        }

        await this.signingCertificateEnrollment.recordChallengeToken(
            enrollmentId,
            subjectMatch[1],
            result.replyToAddress ?? result.fromAddress,
            result.messageIdHeader,
            result.subject!,
        );
        return true;
    }

    /**
     * Decides and, if appropriate, immediately sends the delivery-receipt MDN for a message about to be filed
     * into `mailbox`'s Inbox - called from `deliverMessage()` only when `dispositionNotificationTo` (the
     * requester's address, from the inbound `Disposition-Notification-To` header) is present at all.
     *
     * The requester is classified via `classifyRecipientTier()` (`util/DomainUtils.ts` - same-org/federated/
     * external, built on the same "this server's domains" check Focused Inbox's own `classifyForInbox()`
     * already uses), which decides whether `Mailbox.autoSendReceiptsInternal`/`Federated`/`External` applies.
     * When that setting is `false`, nothing is sent - the receipt is left for the mailbox owner's explicit
     * approval instead (see `BaseMessageRoute`'s `POST /:id/receipt/approve`/`/decline`, which call
     * `sendDispositionNotification()` below directly). A send failure is logged and treated the same as never
     * having sent one at all (not left "pending") - matching every other best-effort cross-mailbox
     * notification in this class, none of which retry.
     */
    private async maybeSendDeliveryReceipt(
        dispositionNotificationTo: string,
        mailbox: X,
        originalMessageId: string,
        originalSubject: string,
    ): Promise<{ sentAt?: Date; pending: boolean }> {
        const tier = await classifyRecipientTier(
            this._objectFactory!,
            this.domainClass,
            dispositionNotificationTo,
            createFederatedPeerCheck(this.dnsResolver!),
        );
        const autoSend: boolean =
            tier === "same-org"
                ? mailbox.autoSendReceiptsInternal
                : tier === "federated"
                  ? mailbox.autoSendReceiptsFederated
                  : mailbox.autoSendReceiptsExternal;
        if (!autoSend) {
            return { pending: true };
        }

        const sent: boolean = await this.sendDispositionNotification(
            dispositionNotificationTo,
            mailbox,
            originalMessageId,
            originalSubject,
            "delivery",
        );
        return sent ? { sentAt: new Date(), pending: false } : { pending: false };
    }

    /**
     * Composes and relays one real RFC 3798 MDN via `util/ReceiptUtils.ts`'s `buildDispositionNotification()`
     * - shared by `maybeSendDeliveryReceipt()` (called automatically at delivery time) and
     * `BaseMessageRoute`'s `POST /:id/receipt/approve` (called explicitly, once the mailbox owner approves a
     * receipt this method originally declined to auto-send). Returns whether the send actually succeeded, so
     * each caller can decide for itself what to persist (a `*SentAt` stamp vs. leaving a pending flag alone).
     */
    private async sendDispositionNotification(
        dispositionNotificationTo: string,
        mailbox: X,
        originalMessageId: string,
        originalSubject: string,
        dispositionType: "read" | "delivery",
    ): Promise<boolean> {
        try {
            // Rotation Notification (Group E5) - mirrors E4's "announce my own active encrypt key" logic
            // exactly, just riding on the MDN instead of the original outbound message.
            const activeEncryptKey: PublicKey | undefined = (mailbox.keys ?? []).find(
                (k) => k.useType === "encrypt" && !k.revokedAt && k.notAfter > Date.now(),
            );
            const composed: Buffer = await buildDispositionNotification({
                from: { address: mailbox.primarySmtpAddress, displayName: mailbox.displayName },
                to: dispositionNotificationTo,
                subject: `${dispositionType === "read" ? "Read" : "Delivered"}: ${originalSubject}`,
                finalRecipient: mailbox.primarySmtpAddress,
                originalMessageId,
                dispositionType,
                reportingUa: `${this.mxHostname}; RapidMX`,
                rotatedKeyFingerprint: activeEncryptKey?.fingerprint,
            });
            await this.mailTransport!.send({
                raw: composed,
                envelopeFrom: mailbox.primarySmtpAddress,
                envelopeTo: [dispositionNotificationTo],
            });
            return true;
        } catch (err: any) {
            this.logger?.warn(`ScanQueueJob: failed to send ${dispositionType} receipt for mailbox ${mailbox.uid}: ${err.message}`);
            return false;
        }
    }

    /**
     * Applies the indicator-update side effect of an inbound MDN receipt - this message is never filed as a
     * visible message at all (see `processEntry()`'s own branch for this), regardless of whether it
     * correlates to anything, mirroring `processRecall()`'s identical "not_found" handling. Works uniformly
     * whether the receipt was generated by another mailbox on this same system or by a genuine external mail
     * system - the parsing is real RFC 3798, not a RapidMX-specific shortcut (see `util/ReceiptUtils.ts`'s own
     * doc comment).
     *
     * Correlates by `(mailboxUid, messageId)` exactly like `processRecall()`, then finds the `receiptStatus`
     * entry whose `recipientAddress` matches this MDN's own `Final-Recipient` (normalized) and stamps its
     * `deliveredAt`/`readAt` - or, if none matches (a `DistributionList` member `send()` could never have
     * pre-seeded, or a message sent before this feature existed), appends a new entry rather than dropping the
     * update, so the roster still ends up complete. That append path is a known, deliberately narrow residual
     * gap: fully verifying that an appended address was a genuine `DistributionList` member of the original
     * send would require tracking per-message list-expansion membership, which nothing currently persists -
     * the DKIM/alignment and uniqueness checks below are what stand between it and abuse in the meantime.
     *
     * `specs/end-to-end_encryption.md` §Receipt Verification requires four checks before a receipt is stored,
     * and this method (together with the DKIM/alignment gate below) is the only place that can enforce them -
     * `parseDispositionNotification()` only parses RFC 3798 structure, it verifies nothing:
     *
     * 1. **DKIM.** The MDN carries a valid DKIM signature from the responding domain.
     * 2. **Alignment.** The signing domain aligns with the domain of the original recipient.
     * 3. **Correlation.** `Original-Message-ID` matches a message this server actually sent, from this user,
     * to that recipient (fully enforced for a pre-seeded recipient; see the append-path note above for the
     * residual DL case).
     * 4. **Uniqueness.** No receipt of the same disposition type has already been recorded for that message
     * and recipient, so a replayed MDN can't rewrite stored state.
     *
     * Authenticity check: RFC 3798 semantics mean `Final-Recipient` is always the *generating* mailbox's own
     * address (each recipient reports its own disposition) - so a genuine MDN's claimed `Final-Recipient` must
     * equal the address this inbound message was actually sent from (`entry.envelopeFrom`). Without this check,
     * anyone who can email this mailbox (e.g. a real recipient who legitimately saw the original message's
     * `Message-ID` in their own inbox copy) could forge an MDN claiming an arbitrary `Final-Recipient` -
     * including an address that was never actually sent the message - and have it silently recorded as a real
     * delivered/read timestamp. A mismatch is dropped exactly like an unresolvable `originalMessageId`. This
     * check alone is necessary but not sufficient - `entry.envelopeFrom` is the unauthenticated SMTP
     * `MAIL FROM`, trivially spoofable - which is why check 1/2 (DKIM + alignment) below is required too.
     */
    private async processReceipt(entry: Q, raw: Buffer, dispositionNotificationPart: string): Promise<void> {
        const parsed = parseDispositionNotification(dispositionNotificationPart);
        // Without a `Final-Recipient` there is no address to correlate against, append under, or authenticate -
        // nothing useful this method could do.
        if (!parsed || !parsed.dispositionType || !parsed.finalRecipient) {
            return;
        }
        const recipientAddress: string = normalizeAddress(parsed.finalRecipient);
        if (recipientAddress !== normalizeAddress(entry.envelopeFrom)) {
            this.logger?.warn(
                `ScanQueueJob: dropping MDN for mailbox ${entry.mailboxUid} whose claimed Final-Recipient ` +
                    `does not match its own envelope sender - possible forgery attempt.`,
            );
            return;
        }

        // Receipt Verification checks 1+2: the MDN itself MUST carry a valid DKIM signature whose signing
        // domain aligns with the responding domain (`recipientAddress`'s own domain, already confirmed above
        // to equal the envelope sender's). Without this, an MDN is just an ordinary forgeable message and the
        // Final-Recipient match above proves nothing - the unauthenticated envelope-from used in that
        // comparison is exactly what a forger controls too.
        const respondingDomain: string | undefined = recipientAddress.split("@")[1];
        if (
            !respondingDomain ||
            !hasAlignedPassingDkim(extractHeaders(raw, "Authentication-Results"), respondingDomain, this.trustedAuthservId)
        ) {
            this.logger?.warn(`ScanQueueJob: dropping unverified/unaligned MDN for mailbox ${entry.mailboxUid}.`);
            return;
        }

        // Rotation Notification (Group E5) - a cache-invalidation hint only, independent of whether this MDN
        // also correlates to a message this mailbox can find below.
        if (parsed.rotatedKeyFingerprint || parsed.policyId) {
            await this.maybeRefreshRotatedKey(entry.mailboxUid, parsed.finalRecipient);
        }

        const matches: M[] = await this.messageRepo!.find(
            { mailboxUid: entry.mailboxUid, messageId: parsed.originalMessageId, limit: 5 } as any,
            { ignoreACL: true, limit: 5 },
        );
        const target: M | undefined = matches[0];
        if (!target) {
            return;
        }

        const roster: MessageReceiptEntry[] = target.receiptStatus ?? [];
        const existingIndex: number = roster.findIndex((row) => normalizeAddress(row.recipientAddress) === recipientAddress);
        const stampField: "readAt" | "deliveredAt" = parsed.dispositionType === "read" ? "readAt" : "deliveredAt";
        if (existingIndex >= 0 && roster[existingIndex][stampField]) {
            // Uniqueness (check 4): this exact (message, recipient, disposition type) has already been
            // recorded - a replayed MDN must not be able to rewrite it.
            return;
        }

        const timestamp: string = new Date().toISOString();
        const stamp: Partial<MessageReceiptEntry> = { [stampField]: timestamp };
        const updatedRoster: MessageReceiptEntry[] =
            existingIndex >= 0
                ? roster.map((row, i) => (i === existingIndex ? { ...row, ...stamp } : row))
                : [...roster, { recipientAddress, ...stamp }];

        await this.messageRepo!.update(
            { uid: target.uid, version: (target as any).version, receiptStatus: updatedRoster } as any,
            target,
            { ignoreACL: true },
        );
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
                    await this.processItipRequest(entry.mailboxUid, parsed, result.encrypted);
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

    /** `encrypted` is only ever consulted on the create branch below - an existing row's own
     * `encryptionOrigin` (set once, from whichever REQUEST first created it) is deliberately never
     * overwritten by a later update, per the spec's "sticky" encryption-state rule
     * (`CalendarEvent.encryptionOrigin`'s own doc comment). This inbound iTIP pipeline only ever produces
     * `"derived"` or `"none"` - `"originated"` is set by a client explicitly creating/marking its own
     * outbound invite as encrypted, a different code path entirely (see `MeetingSchedulingJob`). */
    private async processItipRequest(mailboxUid: string, parsed: ParsedIcsEvent, encrypted: boolean): Promise<void> {
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
                    encryptionOrigin: (encrypted ? "derived" : "none") as EncryptionOrigin,
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
