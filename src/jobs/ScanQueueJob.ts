///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ModelUtils, NotificationUtils, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import { BlobStore } from "../blob/BlobStore.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { resolveDeliveryVerdict, ScanPipeline, ScanPipelineAttachmentResult, ScanPipelineResult } from "../scan/ScanPipeline.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { hasAlignedPassingDkim } from "../util/AuthenticationResultsUtils.js";
import { isAutoReplyEligible } from "../util/AutoReplyUtils.js";
import { boundIndexedValue, findThreadConversationId, resolveConversationId } from "../util/ConversationUtils.js";
import { classifyRecipientTier, createFederatedPeerCheck, getVerifiedDomainNames } from "../util/DomainUtils.js";
import { classifyMessage, FocusedInboxSignals } from "../util/FocusedInboxUtils.js";
import { isHeaderOversignedByAlignedDkim, topmostTrustedAuthenticationResults } from "../util/DkimOversignUtils.js";
import { refreshFolderCounts, type FolderCountsContext } from "../util/FolderCountUtils.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { buildEventIcs, expandOccurrencesDetailed, OccurrenceExpansion, OccurrenceWindow, parseIcsEvent, ParsedIcsEvent } from "../util/IcsUtils.js";
import { removeFromSearchIndex } from "../util/SearchIndexUtils.js";
import type { SearchProvider } from "../search/SearchProvider.js";
import { DataSubjectErasureRequestMongo } from "../models/mongo/DataSubjectErasureRequestMongo.js";
import { DataSubjectErasureRequestSQL } from "../models/sql/DataSubjectErasureRequestSQL.js";
import { ERASURE_IN_PROGRESS } from "./ErasureExecutionJob.js";
import { writeContactKeys } from "../util/ContactKeyUtils.js";
import { applyDiscoveredKeys, ContactKeyState, discoverAndMergeKeys } from "../util/KeyringUtils.js";
import { evaluateMailFilterRules, MailFilterEvaluationResult, MailFilterMatchContext } from "../util/MailFilterUtils.js";
import { extractHeader, extractHeaders, prepareRelayCopy, prependHeaders, safeDisplayName, verifiedFromAddress } from "../util/MimeHeaderUtils.js";
import { resolveActiveOof } from "../util/OofUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { buildDispositionNotification, parseDispositionNotification } from "../util/ReceiptUtils.js";
import { parseRapidMxKeyHeader } from "../util/RapidMxKeyHeaderUtils.js";
import { buildDeliveredRecipients } from "../util/RecipientUtils.js";
import { nameBasedUuid } from "../util/UuidUtils.js";
import { sendOrThrow } from "../transport/TransportResultUtils.js";
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
    Recipient,
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
/** Header each mail-filter-rule forward adds (value: the forwarding mailbox's address) - see `forwardByRule()`. */
const FORWARD_LOOP_HEADER = "X-RapidMX-Loop";
/** How many rule forwards a single message may pass through before it's treated as looping. */
const MAX_FORWARD_HOPS = 5;
/** How far past a booking request's own start `decideResourceBooking()` looks for conflicts against an
 * indefinitely-recurring existing booking - a bound on worst-case cost, not a real policy limit. */
const RESOURCE_BOOKING_HORIZON_MS = 731 * MS_PER_DAY;
/** Window size `decideResourceBooking()` expands a booking request in, so no single expansion hits its per-call cap. */
const RESOURCE_BOOKING_CHUNK_MS = 60 * MS_PER_DAY;
/** How many occurrences of one booking request `decideResourceBooking()` checks before declining as unverifiable. */
const RESOURCE_BOOKING_MAX_REQUESTED_OCCURRENCES = 5000;
/** Page size `decideResourceBooking()` reads a resource's existing `CalendarEvent` rows in. */
const RESOURCE_BOOKING_EXISTING_ROWS_LIMIT = 500;
/** How many pages of existing bookings `decideResourceBooking()` reads before declining as unverifiable. */
const RESOURCE_BOOKING_MAX_PAGES = 20;
/** How far before a booking request's start `decideResourceBooking()` looks for override rows (`recurrenceId`) of an
 * existing recurring booking - an override moved away from an original instant slightly before the request can
 * still vacate a phantom occurrence that overlaps it. Missing one only makes the check more conservative. */
const RESOURCE_BOOKING_OVERRIDE_LOOKBACK_MS = MS_PER_DAY;

/** The headers whose mere presence triggers a state change here, and so must be DKIM-oversigned by the `From`
 * domain before they're honored - see `util/DkimOversignUtils.ts`. */
const RAPIDMX_KEY_HEADER = "RapidMX-Key";
const RECALL_HEADER = "X-RapidMX-Recall-Of";

/** A claim on one `IngestQueueEntry` by this worker: `row` is always the latest version this worker wrote, so
 * any later write (lease renewal, `DELIVERED`, `FAILED`) is version-checked against exactly that - a mismatch
 * means another worker took the entry over (or finished it), and this worker must stop touching it. */
interface EntryClaim<Q> {
    row: Q;
    /** When the current lease was granted (epoch ms) - see `renewLeaseIfDue()`. */
    leaseGrantedAt: number;
}

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
    protected abstract keyVaultClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private ingestQueueRepo?: RepoUtils<Q>;
    private folderRepo?: RecoverableRepoUtils<F>;
    private messageRepo?: RecoverableRepoUtils<M>;
    private attachmentRepo?: RepoUtils<A>;
    private quarantineEntryRepo?: RepoUtils<QE>;
    private scanResultRepo?: RepoUtils<SR>;
    private mailboxRepo?: RepoUtils<X>;
    private keyVaultRepo?: RepoUtils<any>;
    private mailFilterRuleRepo?: RepoUtils<MFR>;
    private calendarEventRepo?: RecoverableRepoUtils<CE>;
    private oofReplySuppressionRepo?: RepoUtils<OS>;
    private focusedInboxOverrideRepo?: RepoUtils<FIO>;
    private contactRepo?: RecoverableRepoUtils<C>;
    /** Read-only: consulted before filing so nothing is delivered into a mailbox `ErasureExecutionJob` is erasing. */
    private erasureRequestRepo?: RepoUtils<any>;

    /** The `DataSubjectErasureRequest` model class for this backend. Defaults to the Mongo or SQL class matching
     * `ingestQueueClass`'s backend; a subclass may set it explicitly. */
    protected dataSubjectErasureRequestClass?: any;

    /** Optional - when search isn't configured, index removal is a no-op (see `removeFromSearchIndex()`). */
    @Inject("SearchProvider")
    private searchProvider?: SearchProvider;

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

    /** How many times an entry is attempted before it stays `FAILED` for good. */
    @Config("mail:jobs:scan_queue:max_attempts", 5)
    private maxAttempts: number = 5;

    /** The delay before the first retry of a failed entry; each later retry waits twice as long as the last. */
    @Config("mail:jobs:scan_queue:retry_backoff_seconds", 60)
    private retryBackoffSeconds: number = 60;

    /** How long a worker's claim on an entry lasts. A `SCANNING` entry past its lease is assumed abandoned (its
     * worker died) and is claimed again - keep this well above the slowest realistic scan. */
    @Config("mail:jobs:scan_queue:lease_seconds", 600)
    private leaseSeconds: number = 600;

    /** How long an entry for a mailbox with a pending (not yet running) erasure waits before it is looked at again - see
     * `erasureDisposition()`. */
    @Config("mail:jobs:scan_queue:erasure_defer_seconds", 300)
    private erasureDeferSeconds: number = 300;

    /** How old an entry may get while deferred for a pending erasure before it is delivered anyway - see
     * `erasureDisposition()`. */
    @Config("mail:jobs:scan_queue:erasure_defer_max_seconds", 3600)
    private erasureDeferMaxSeconds: number = 3600;

    /** `ErasureExecutionJob`'s claim lease: an `in_progress` erasure request not renewed within it is no longer running. */
    @Config("mail:jobs:erasure_execution:claim_lease_seconds", 900)
    private erasureClaimLeaseSeconds: number = 900;

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

    /** Gmail-style `user+tag@domain` plus-addressing - see `discoverLocalKeys()` (`util/LocalKeyDiscoveryUtils.ts`). */
    @Config("mail:plus_addressing:enabled", true)
    private plusAddressingEnabled: boolean = true;

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
        const erasureClass: any =
            this.dataSubjectErasureRequestClass ??
            (String(this.ingestQueueClass?.name ?? "").endsWith("SQL") ? DataSubjectErasureRequestSQL : DataSubjectErasureRequestMongo);
        try {
            this.erasureRequestRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: erasureClass.name,
                args: [erasureClass],
            });
        } catch (err: any) {
            // Only possible when the datastore wasn't given this model at all (a trimmed-down wiring) - the erasure
            // check then can't run, which is logged on every delivery attempt rather than blocking all mail.
            this.logger?.warn(`ScanQueueJob: erasure-status checks unavailable (${erasureClass.name} repo failed to initialize): ${err?.message}`);
        }
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    /**
     * Processes up to `batchSize` entries that are due: new (`PENDING`) entries, `FAILED` entries whose retry time
     * has come, and `SCANNING` entries whose worker's lease has expired (the worker died mid-scan). Each is
     * claimed with a version-checked update first - a replica that loses that race just skips the entry.
     *
     * A processing failure schedules a retry with exponential backoff (`retry_backoff_seconds` × 2^(attempts-1))
     * until `max_attempts`, after which the entry stays `FAILED` with its last error for an operator. Delivery is
     * idempotent across retries and takeovers (see `processEntry()`), so a retry never files a second copy.
     *
     * `attempts` counts *claims*, not recorded failures: it's incremented inside the version-checked claim itself, so
     * a message that kills its worker outright (and so never reaches `recordFailure()`) still exhausts
     * `max_attempts` through repeated lease takeovers instead of crash-looping forever.
     */
    public async run(): Promise<void> {
        const candidates: Q[] = await this.findDueEntries(new Date());

        for (const entry of candidates) {
            let claim: EntryClaim<Q> | undefined;
            try {
                claim = await this.claimEntry(entry);
            } catch (err: any) {
                // Another replica claimed (or finished) it first - not an error, and nothing to record.
                this.logger?.debug(`ScanQueueJob: skipped ingest entry ${entry.uid}, claimed elsewhere: ${err.message}`);
                continue;
            }
            if (!claim) {
                continue;
            }
            try {
                await this.processEntry(claim);
            } catch (err: any) {
                this.logger?.error(`ScanQueueJob: failed to process ingest entry ${entry.uid}: ${err.message}`);
                await this.recordFailure(claim, err);
            }
        }
    }

    /** The due entries, oldest first - see `run()`. `limit` must be passed both via `options` (the Mongo backend)
     * *and* in the query object itself (all `ModelUtils.buildSearchQuerySQL` reads). */
    private async findDueEntries(now: Date): Promise<Q[]> {
        const leaseMs: number = this.leaseSeconds * 1000;
        const queries: Record<string, any>[] = [
            { status: IngestStatus.PENDING },
            { status: IngestStatus.FAILED, nextAttemptAt: `lte(${now.toISOString()})` },
            { status: IngestStatus.SCANNING, scanLeaseExpiresAt: `lt(${now.toISOString()})` },
            // Claimed before leases existed (or by a worker that crashed before writing one).
            {
                status: IngestStatus.SCANNING,
                scanLeaseExpiresAt: "exists(false)",
                dateModified: `lt(${new Date(now.getTime() - leaseMs).toISOString()})`,
            },
        ];
        const seen: Set<string> = new Set();
        const due: Q[] = [];
        for (const query of queries) {
            const rows: Q[] = await this.ingestQueueRepo!.find(
                { ...query, sort: { dateCreated: "ASC", uid: "ASC" }, limit: this.batchSize } as any,
                { ignoreACL: true, limit: this.batchSize, skipCache: true },
            );
            for (const row of rows) {
                if (!seen.has(row.uid)) {
                    seen.add(row.uid);
                    due.push(row);
                }
            }
        }
        due.sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime());
        return due.slice(0, this.batchSize);
    }

    /**
     * Claims `entry` for this worker with one version-checked update (it throws when another worker got there first)
     * that also increments `attempts` and starts the lease from *now* - not from when `run()` began, which would
     * shorten the lease of every entry later in the batch. Returns the claim, or `undefined` when the entry has
     * already used every attempt (only reachable through lease takeovers of a worker that died mid-processing), in
     * which case it's parked `FAILED` for good instead of being processed again.
     */
    private async claimEntry(entry: Q): Promise<EntryClaim<Q> | undefined> {
        const attempts: number = (entry.attempts ?? 0) + 1;
        if (attempts > this.maxAttempts) {
            await this.ingestQueueRepo!.update(
                {
                    uid: entry.uid,
                    version: (entry as any).version,
                    status: IngestStatus.FAILED,
                    errorMessage: (entry.errorMessage ?? `Abandoned by its worker after ${this.maxAttempts} attempts.`).slice(0, 4000),
                    nextAttemptAt: null,
                    scanLeaseExpiresAt: null,
                } as any,
                asEntity(this.ingestQueueRepo!, entry),
                { ignoreACL: true },
            );
            this.logger?.error(`ScanQueueJob: giving up on ingest entry ${entry.uid} after ${this.maxAttempts} attempts.`);
            return undefined;
        }
        const grantedAt: number = Date.now();
        await this.ingestQueueRepo!.update(
            {
                uid: entry.uid,
                version: (entry as any).version,
                status: IngestStatus.SCANNING,
                attempts,
                scanLeaseExpiresAt: new Date(grantedAt + this.leaseSeconds * 1000),
            } as any,
            asEntity(this.ingestQueueRepo!, entry),
            { ignoreACL: true },
        );
        // `entry` is now stale (its `version` no longer matches the persisted row) — re-fetch before the next
        // optimistic-locked update rather than reusing the pre-update snapshot.
        return { row: (await this.ingestQueueRepo!.findOne(entry.uid, { ignoreACL: true }))!, leaseGrantedAt: grantedAt };
    }

    /**
     * Extends `claim`'s lease once half of it has elapsed - called at checkpoints between `processEntry()`'s slow
     * steps (the scan itself, filing). Version-checked like every other write to a claimed entry, so it throws when
     * another worker already took the entry over after this lease lapsed; that aborts this worker's processing
     * before it files anything further, and `recordFailure()` then leaves the entry to its new owner.
     */
    private async renewLeaseIfDue(claim: EntryClaim<Q>): Promise<void> {
        const leaseMs: number = this.leaseSeconds * 1000;
        const now: number = Date.now();
        if (now - claim.leaseGrantedAt < leaseMs / 2) {
            return;
        }
        await this.ingestQueueRepo!.update(
            { uid: claim.row.uid, version: (claim.row as any).version, scanLeaseExpiresAt: new Date(now + leaseMs) } as any,
            asEntity(this.ingestQueueRepo!, claim.row),
            { ignoreACL: true },
        );
        claim.row = (await this.ingestQueueRepo!.findOne(claim.row.uid, { ignoreACL: true }))!;
        claim.leaseGrantedAt = now;
    }

    /** Records a processing failure: schedules the next retry, or leaves the entry `FAILED` for good once
     * `max_attempts` is reached (`attempts` was already counted by the claim). Only while the entry is still this
     * worker's claim - its version still the one this worker last wrote: an entry another worker has since taken
     * over after a lapsed lease, or delivered, is left entirely to that worker. */
    private async recordFailure(claim: EntryClaim<Q>, err: any): Promise<void> {
        const uid: string = claim.row.uid;
        try {
            const current: Q | undefined = await this.ingestQueueRepo!.findOne(uid, { ignoreACL: true });
            if (!current || (current as any).version !== (claim.row as any).version || current.status !== IngestStatus.SCANNING) {
                this.logger?.warn(`ScanQueueJob: not recording the failure of ingest entry ${uid} - it's no longer this worker's claim.`);
                return;
            }
            const attempts: number = current.attempts ?? 1;
            const exhausted: boolean = attempts >= this.maxAttempts;
            const nextAttemptAt: Date | null = exhausted
                ? null
                : new Date(Date.now() + this.retryBackoffSeconds * 1000 * Math.pow(2, attempts - 1));
            await this.ingestQueueRepo!.update(
                {
                    uid,
                    version: (current as any).version,
                    status: IngestStatus.FAILED,
                    errorMessage: String(err?.message ?? err).slice(0, 4000),
                    nextAttemptAt,
                    scanLeaseExpiresAt: null,
                } as any,
                asEntity(this.ingestQueueRepo!, current),
                { ignoreACL: true },
            );
            if (exhausted) {
                this.logger?.error(`ScanQueueJob: giving up on ingest entry ${uid} after ${attempts} attempts.`);
            }
        } catch (updateErr: any) {
            this.logger?.warn(`ScanQueueJob: failed to record the failure of ingest entry ${uid}: ${updateErr.message}`);
        }
    }

    /**
     * What `processEntry()` does with an entry for a mailbox that may be under erasure (`DataSubjectErasureRequest`):
     *
     * - While the mailbox row exists, requests created before it (`dateCreated`) are ignored: the mailbox uid is its
     * address, so such a request belongs to an earlier, erased mailbox at the same address, not to its current owner.
     * - `"drop"` whenever the mailbox row is gone and any `"approved"`, `"in_progress"` or `"completed"` request exists
     * for the address: delivering would re-create the erased subject's folders and messages from nothing (e.g. a request
     * handed back to `"approved"` by a plugin after the cascade already deleted the mailbox, or the stale claim of a
     * cascade that stopped after that point). Also `"drop"` while a request is `"in_progress"` (`ERASURE_IN_PROGRESS`)
     * under a live claim (renewed within `mail:jobs:erasure_execution:claim_lease_seconds`) - the cascade is running.
     * - `"defer"`, only while the mailbox row still exists, when a request is `"approved"` (queued, or handed back because
     * a legal hold or an unloaded plugin blocks it) or `"in_progress"` under a stale claim - but only until the entry is
     * `mail:jobs:scan_queue:erasure_defer_max_seconds` old. After that it is delivered: a request can stay blocked for as
     * long as a hold lasts, and the custodian's mail must not be held back (let alone lost) for that long. The cascade
     * purges delivered content (and queued entries) when it does run.
     * - `"deliver"` otherwise (including a `"completed"` request whose mailbox row survived).
     *
     * Throws on a datastore error, so a transient failure retries the entry rather than filing into a mailbox that might
     * be under erasure.
     */
    private async erasureDisposition(entry: Q): Promise<"deliver" | "defer" | "drop"> {
        const mailboxUid: string = entry.mailboxUid;
        if (!this.erasureRequestRepo) {
            this.logger?.warn(`ScanQueueJob: can't check erasure status of mailbox ${mailboxUid} - no DataSubjectErasureRequest repo.`);
            return "deliver";
        }
        const statuses: string[] = ["approved", ERASURE_IN_PROGRESS, "completed"];
        const rows: any[] = (
            await this.erasureRequestRepo.find({ mailboxUid, status: `in(${statuses.join(",")})`, limit: 50 } as any, {
                ignoreACL: true,
                limit: 50,
                skipCache: true,
            })
        ).filter((row) => row.mailboxUid === mailboxUid && statuses.includes(row.status));
        if (rows.length === 0) {
            return "deliver";
        }
        const time = (value: unknown): number => (value ? new Date(value as any).getTime() : NaN);
        const mailbox: X | undefined = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            // Nothing to deliver into, and there's no mailbox row to date the requests by, so every one counts.
            return "drop";
        }
        const mailboxCreatedAt: number = time(mailbox.dateCreated);
        // `!(a < b)` keeps a request whose dates can't be read - erring towards honoring it.
        const relevant: any[] = rows.filter((row) => Number.isNaN(mailboxCreatedAt) || !(time(row.dateCreated) < mailboxCreatedAt));
        const now: number = Date.now();
        const liveClaim = (row: any): boolean => row.status === ERASURE_IN_PROGRESS && time(row.dateModified) >= now - this.erasureClaimLeaseSeconds * 1000;
        if (relevant.some(liveClaim)) {
            return "drop";
        }
        if (relevant.some((row) => row.status === "approved" || row.status === ERASURE_IN_PROGRESS)) {
            const age: number = now - time(entry.dateCreated);
            return age < this.erasureDeferMaxSeconds * 1000 ? "defer" : "deliver";
        }
        return "deliver";
    }

    /** Applies `erasureDisposition()` to a claimed entry: drops or defers it and returns `true`, or returns `false` when
     * it should be delivered. */
    private async stopForErasure(claim: EntryClaim<Q>): Promise<boolean> {
        const entry: Q = claim.row;
        const erasure = await this.erasureDisposition(entry);
        if (erasure === "drop") {
            this.logger?.warn(`ScanQueueJob: dropping ingest entry ${entry.uid} - mailbox ${entry.mailboxUid} is being erased.`);
            await this.markDelivered(claim, "Dropped: the mailbox is being erased.");
            return true;
        }
        if (erasure === "defer") {
            this.logger?.info(`ScanQueueJob: deferring ingest entry ${entry.uid} - an erasure of mailbox ${entry.mailboxUid} is pending.`);
            await this.deferEntry(claim, "Deferred: an erasure of the mailbox is pending.");
            return true;
        }
        return false;
    }

    /**
     * Hands a claimed entry back for a later attempt without counting it as one: `FAILED` with `nextAttemptAt`
     * `mail:jobs:scan_queue:erasure_defer_seconds` from now and the claim's `attempts` increment undone - so waiting on an
     * erasure never exhausts `max_attempts`. Version-checked against this worker's claim.
     */
    private async deferEntry(claim: EntryClaim<Q>, note: string): Promise<void> {
        await this.ingestQueueRepo!.update(
            {
                uid: claim.row.uid,
                version: (claim.row as any).version,
                status: IngestStatus.FAILED,
                attempts: Math.max(0, (claim.row.attempts ?? 1) - 1),
                nextAttemptAt: new Date(Date.now() + this.erasureDeferSeconds * 1000),
                scanLeaseExpiresAt: null,
                errorMessage: note,
            } as any,
            asEntity(this.ingestQueueRepo!, claim.row),
            { ignoreACL: true },
        );
    }

    /** Only the topmost `Authentication-Results` header this deployment's trusted MTA stamped
     * (`topmostTrustedAuthenticationResults()`) - an older trusted instance (e.g. on a message re-ingested through a
     * forward) must never be counted alongside it. */
    private authenticationResults(raw: Buffer): string[] {
        return topmostTrustedAuthenticationResults(extractHeaders(raw, "Authentication-Results"), this.trustedAuthservId);
    }

    /** Blob key of the marker `forwardByRuleOnce()` writes once an entry's rule forward has been relayed. */
    private forwardMarkerKey(entryUid: string): string {
        return `ingest-markers/${entryUid}/forwarded`;
    }

    /**
     * Scans and files one claimed entry. Every row it creates has a uid derived from the entry's own uid
     * (`nameBasedUuid()`), and each is looked up before being created, so re-processing an entry - a retry after a
     * failure part-way through, or a takeover of an expired lease while the first worker was still running - never
     * files a second copy, quarantines twice or records a second `ScanResult`. Side effects that follow delivery are
     * repeat-safe too: the automatic reply is tracked per entry (`maybeSendAutoReplyOnce()`), rule forwards likewise
     * (`forwardByRuleOnce()`), the delivery receipt on the message row (`completeDeliveryReceipt()`), and iTIP processing
     * is idempotent.
     *
     * **Mailbox under erasure** (`erasureDisposition()`). While an erasure cascade is actually running (an
     * `in_progress` request under a live claim), or once it completed and the mailbox is gone, an entry for that mailbox
     * is dropped - no `ScanResult`, quarantine, filing, recall/receipt/iTIP mutation - and closed as `DELIVERED` with an
     * explanatory `errorMessage`: the same terminal "accepted, nothing filed" outcome a `MailFilterRule` delete
     * produces. While a request is only waiting (`approved`, possibly blocked by a legal hold or an unloaded plugin, or
     * a stale claim), the entry is deferred for a bounded time (`deferEntry()`), then delivered. Requests older than
     * the mailbox row (an earlier mailbox at the same address) are ignored. A dropped entry's row and raw blob are left
     * for `ErasureExecutionJob`, which purges `IngestQueueEntry` rows (and their blobs) by `mailboxUid`; an entry created
     * after its purge pass already ran keeps its row and raw blob - a residual this job doesn't delete itself, since the
     * raw blob may be shared with other recipients' entries.
     */
    private async processEntry(claim: EntryClaim<Q>): Promise<void> {
        const entry: Q = claim.row;

        // Checked before scanning, so an entry deferred for a pending erasure isn't re-scanned on every deferral, and again
        // after it, since a cascade can start while the (slow) scan runs.
        if (await this.stopForErasure(claim)) {
            return;
        }
        const raw: Buffer = await this.blobStore!.get(entry.rawBlobKey);
        const result: ScanPipelineResult = await this.scanPipeline!.run(raw, {
            from: entry.envelopeFrom,
            to: entry.envelopeTo,
        });
        // Scanning is the slow part - make sure this worker still owns the entry before writing anything.
        await this.renewLeaseIfDue(claim);
        if (await this.stopForErasure(claim)) {
            return;
        }

        // A `TransportRule`'s `quarantine` action (stamped by `BaseMailIngestRoute.deliver()`) always wins over
        // an AV/spam-derived verdict of "deliver"/"junk" - but scanning still ran normally above, so a
        // policy-quarantined message still gets a real `ScanResult` for the reviewer to see.
        const verdict = entry.quarantineReason ? "quarantine" : resolveDeliveryVerdict(result);

        // The `Message`/`QuarantineEntry` this scan is *for* doesn't exist yet, and `ScanResult.targetUid`
        // needs to reference it - pre-generating the target's uid here (rather than letting `create()` mint
        // one) breaks that chicken-and-egg ordering: the target entity is then created *with* this exact uid
        // (BaseEntity's constructor honors an explicitly supplied `uid`), so both records can reference each
        // other correctly regardless of which is actually persisted first. Both uids are derived from the entry's
        // uid, so a re-processed entry finds (and reuses) what an earlier attempt already created.
        const targetUid: string = nameBasedUuid(`ingest:${entry.uid}:target`);
        const scanResultUid: string = nameBasedUuid(`ingest:${entry.uid}:scan`);
        const scanResult: SR =
            (await this.scanResultRepo!.findOne(scanResultUid, { ignoreACL: true })) ??
            (await this.scanResultRepo!.create(
                new this.scanResultClass({
                    uid: scanResultUid,
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
            ));

        // The recall header is only ever honored from the original message's own, DKIM-verified sender, and only when
        // that sender's aligned signature oversigns it (so it can't be appended to some other genuinely signed message
        // from the same domain and replayed) - see `verifiedFromAddress()`, `isOversignedByFromDomain()` and
        // `processRecall()`. Otherwise it's ordinary mail.
        const recallOfMessageId: string | undefined =
            result.recallOfMessageId && this.verifiedFromAddress(raw, result) && this.isOversignedByFromDomain(raw, result, RECALL_HEADER)
                ? result.recallOfMessageId
                : undefined;

        if (verdict === "quarantine") {
            if (!(await this.quarantineEntryRepo!.findOne(targetUid, { ignoreACL: true }))) {
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
            }
        } else if (verdict === "deliver" && recallOfMessageId) {
            // A recall control message is never filed to the Inbox - matching real Outlook hiding these from
            // the reading pane - only the mutation it triggers (if any) and the report back to the sender.
            await this.processRecall(entry, raw, result, recallOfMessageId);
        } else if (verdict === "deliver" && result.dispositionNotificationPart) {
            // An inbound MDN receipt is never filed either - only the indicator it stamps onto the original
            // sent message, if any is found - see processReceipt()'s own doc comment.
            await this.processReceipt(entry, raw, result.dispositionNotificationPart);
        } else if (verdict === "deliver" && (await this.tryCorrelateAcmeChallenge(entry, raw, result))) {
            // A real RFC 8823 challenge email is CA-internal plumbing, never filed either - same treatment
            // recall control messages and inbound MDNs already get. Unlike those two, correlation here can
            // genuinely fail (a spoofed or stale lookalike, or no outstanding enrollment at all) - in that
            // case `tryCorrelateAcmeChallenge()` itself returns `false` and this branch is never taken, so
            // the message falls through to ordinary delivery below rather than being silently dropped.
        } else {
            await this.deliverMessage(claim, raw, targetUid, scanResult, result, verdict === "junk");

            // Mail filter rules, automatic replies, and iTIP processing only apply to mail actually delivered
            // to the Inbox - matching Exchange's own behavior, junk-routed mail never runs any of them. An
            // automatic reply is sent at most once per entry, tracked on its own (`maybeSendAutoReplyOnce()`) rather than
            // by whether this attempt filed the message - so a retry of an attempt that filed the message but failed
            // before replying still replies. iTIP processing is idempotent (sequence/state checks), so a retry re-applies
            // it safely.
            if (verdict === "deliver") {
                await this.maybeSendAutoReplyOnce(entry, raw, result);
                await this.maybeProcessItipMessage(entry, raw, result);
            }
        }

        await this.markDelivered(claim);
    }

    /** Closes `claim`'s entry as `DELIVERED` (version-checked against this worker's claim), then best-effort removes
     * the per-entry marker blob `forwardByRuleOnce()` may have written - no retry can need it any more. */
    private async markDelivered(claim: EntryClaim<Q>, note?: string): Promise<void> {
        await this.ingestQueueRepo!.update(
            {
                uid: claim.row.uid,
                version: (claim.row as any).version,
                status: IngestStatus.DELIVERED,
                scanLeaseExpiresAt: null,
                ...(note ? { errorMessage: note } : {}),
            } as any,
            asEntity(this.ingestQueueRepo!, claim.row),
            { ignoreACL: true },
        );
        for (const markerKey of [this.forwardMarkerKey(claim.row.uid), this.autoReplyMarkerKey(claim.row.uid)]) {
            try {
                await this.blobStore!.delete(markerKey);
            } catch (err: any) {
                this.logger?.debug(`ScanQueueJob: failed to remove marker ${markerKey} of ingest entry ${claim.row.uid}: ${err?.message}`);
            }
        }
    }

    /** Blob key of the marker `maybeSendAutoReplyOnce()` writes once an entry's automatic reply was handled. */
    private autoReplyMarkerKey(entryUid: string): string {
        return `ingest-markers/${entryUid}/auto-replied`;
    }

    /**
     * `maybeSendAutoReply()` at most once per ingest entry, across retries: a marker blob (`autoReplyMarkerKey()`) is
     * checked first and written once the reply was handled (sent, suppressed, or not applicable) - the same "act, then
     * record" order `forwardByRuleOnce()` uses, so only a failure between the two can repeat it (and
     * `OofReplySuppression` still throttles that). `markDelivered()` removes the marker.
     */
    private async maybeSendAutoReplyOnce(entry: Q, raw: Buffer, result: ScanPipelineResult): Promise<void> {
        const markerKey: string = this.autoReplyMarkerKey(entry.uid);
        if (await this.blobStore!.exists(markerKey)) {
            return;
        }
        await this.maybeSendAutoReply(entry, raw, result);
        await this.blobStore!.put(markerKey, Buffer.from(new Date().toISOString(), "utf-8"), { contentType: "text/plain" });
    }

    /** `true` if `headerName` is oversigned by a trusted-verified DKIM signature aligned with the message's `From`
     * domain - see `util/DkimOversignUtils.ts`. */
    private isOversignedByFromDomain(raw: Buffer, result: ScanPipelineResult, headerName: string): boolean {
        const fromDomain: string | undefined = result.fromAddress ? normalizeAddress(result.fromAddress).split("@")[1] : undefined;
        return (
            !!fromDomain &&
            isHeaderOversignedByAlignedDkim(raw, headerName, fromDomain, this.authenticationResults(raw), this.trustedAuthservId)
        );
    }

    /**
     * Files a "deliver"/"junk"-verdicted message, applying any matching `MailFilterRule`'s actions first (only
     * for a "deliver" verdict - `isJunk` mail skips rule evaluation entirely). A requested delivery receipt
     * (see `completeDeliveryReceipt()`) is decided and sent - or held pending approval - only for the
     * *primary* message (never a rule's `copyToFolderUids` copy), and not at all for a message a rule deletes
     * outright: a receipt for a message the mailbox owner's own rule routed elsewhere or discarded entirely
     * would be misleading.
     *
     * The receipt is only sent once the `Message` row (and its attachments/counters) exists - never before - and
     * the send is recorded on that row (`deliveryReceiptSentAt`/`deliveryReceiptPending`), which is what a retry
     * checks: see `completeDeliveryReceipt()`. A rule forward is likewise relayed at most once per entry, whether
     * or not the rule also deleted the message: see `forwardByRuleOnce()`.
     */
    private async deliverMessage(
        claim: EntryClaim<Q>,
        raw: Buffer,
        targetUid: string,
        scanResult: SR,
        result: ScanPipelineResult,
        isJunk: boolean,
    ): Promise<void> {
        const entry: Q = claim.row;
        // Who this message was actually addressed to, and who sent it, as its own headers say - shared by the
        // primary row and any rule copy below. The SMTP envelope names only the single mailbox this copy is
        // being filed into (plus, for a bcc'd or alias-only recipient, an address no header mentions at all,
        // which `buildDeliveredRecipients()` keeps as a `bcc` entry), so recording the envelope alone left every
        // delivered copy claiming it had exactly one recipient - see `util/RecipientUtils.ts`.
        const recipients: Recipient[] = buildDeliveredRecipients(result.headerRecipients, entry.envelopeTo);
        // `displayName` is the sender's display name alone (`parsedFrom` is the whole `From` header value, name
        // and address both, which a client then rendered a second time after the address it also shows).
        // A bounce (a delivery status notification) has a null envelope sender - `<>` - so what its reader is shown is the address
        // in its own `From` header (`MAILER-DAEMON@host`), not a blank.
        const sender: Recipient = { address: entry.envelopeFrom || result.fromAddress || "", displayName: result.fromDisplayName, type: RecipientType.TO };
        // Independent of everything below (filtering, filing, junk classification) - `specs/
        // end-to-end_encryption.md`'s "Only inbound messages are processed, keyed on the From address" rule
        // applies to every delivered message regardless of which folder (or none) it ends up filed into.
        await this.processInboundRapidMxKeyHeader(entry, raw, result);

        // An earlier attempt at this same entry already filed the primary message (see `processEntry()`): this
        // attempt completes whatever that one didn't (attachments, rule copies) but sends nothing again.
        const alreadyFiled: boolean = !!(await this.messageRepo!.findOne(targetUid, { ignoreACL: true }));

        let sanitizedHtmlBlobKey: string | undefined;
        if (result.sanitizedHtml !== undefined) {
            sanitizedHtmlBlobKey = `sanitized/${targetUid}`;
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
            // The message is discarded outright and no rule asked for a copy anywhere - nothing further to file, but a
            // matching rule's forward still applies (Exchange's "forward, then delete" rule combination).
            await this.renewLeaseIfDue(claim);
            await this.forwardByRuleOnce(entry, raw, result, filterResult.forwardTo);
            return;
        }

        const storedAttachments: StoredAttachment[] = await this.storeAttachmentBlobs(result.attachments, targetUid);
        const flags: MessageFlags = { read: filterResult.markRead, flagged: false, answered: false, forwarded: false };

        if (!filterResult.deleted && alreadyFiled) {
            const existing: M = (await this.messageRepo!.findOne(targetUid, { ignoreACL: true }))!;
            const existingFolder: F | undefined = await this.folderRepo!.findOne(existing.folderUid, { ignoreACL: true });
            if (existingFolder) {
                await this.attachRows(storedAttachments, existing, existingFolder, entry.mailboxUid);
            }
            // The earlier attempt may have failed after filing but before its receipt was sent/recorded.
            await this.completeDeliveryReceipt(entry, raw, result, existing);
        } else if (!filterResult.deleted) {
            const defaultFolderType = isJunk ? FolderType.JUNK : FolderType.INBOX;
            const folder: F = await this.resolveTargetFolder(entry.mailboxUid, filterResult.moveToFolderUid, defaultFolderType);

            const messageId = result.messageIdHeader ?? crypto.randomUUID();
            // The conversation an ancestor of this message is already filed under in this mailbox, falling back
            // to what its own `References`/`In-Reply-To` derive - see `util/ConversationUtils.ts`.
            const conversationId: string | undefined = await this.resolveConversation(entry.mailboxUid, result, messageId);
            // Classified before the row is written so the conversation lookup can't match this very message.
            const inferenceClassification: MessageClassification | undefined = await this.classifyForInbox(
                entry,
                result,
                folder,
                isJunk,
                conversationId,
            );
            await this.renewLeaseIfDue(claim);
            const message: M = await this.messageRepo!.create(
                new this.messageClass({
                    uid: targetUid,
                    folderUid: folder.uid,
                    mailboxUid: entry.mailboxUid,
                    messageId,
                    subject: result.subject ?? "",
                    from: { ...sender },
                    recipients: recipients.map((recipient) => ({ ...recipient })),
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
                    deliveryReceiptPending: false,
                }),
                { ignoreACL: true },
            );
            this.notificationUtils?.sendMessage(folder.uid, this.messageClass.name, "create", message);
            await this.attachRows(storedAttachments, message, folder, entry.mailboxUid);
            await refreshFolderCounts(this.folderCountsContext(), [folder.uid], { bumpSyncKey: true });
            await this.completeDeliveryReceipt(entry, raw, result, message);
        }

        for (const copyFolderUid of filterResult.copyToFolderUids) {
            const copyFolder: F | undefined = await this.folderRepo!.findOne(copyFolderUid, { ignoreACL: true });
            // A rule may only file into its own mailbox's folders - a rule naming another mailbox's folder (the
            // route checks this when the rule is saved, but the folder or rule may have changed since) is ignored.
            if (!copyFolder || copyFolder.deleted || copyFolder.mailboxUid !== entry.mailboxUid) {
                continue;
            }
            const copyUid: string = nameBasedUuid(`${targetUid}:copy:${copyFolder.uid}`);
            const existingCopy: M | undefined = await this.messageRepo!.findOne(copyUid, { ignoreACL: true });
            if (existingCopy) {
                await this.attachRows(storedAttachments, existingCopy, copyFolder, entry.mailboxUid);
                continue;
            }
            const copyMessageId = result.messageIdHeader ?? crypto.randomUUID();
            const copyConversationId: string | undefined = await this.resolveConversation(
                entry.mailboxUid,
                result,
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
                    uid: copyUid,
                    folderUid: copyFolder.uid,
                    mailboxUid: entry.mailboxUid,
                    messageId: copyMessageId,
                    subject: result.subject ?? "",
                    from: { ...sender },
                    recipients: recipients.map((recipient) => ({ ...recipient })),
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
            await refreshFolderCounts(this.folderCountsContext(), [copyFolder.uid], { bumpSyncKey: true });
        }

        await this.renewLeaseIfDue(claim);
        await this.forwardByRuleOnce(entry, raw, result, filterResult.forwardTo);
    }

    /**
     * Relays a rule forward (`forwardByRule()`) at most once per ingest entry, across retries and whether or not
     * the rule also deleted the message (so there may be no `Message` row to remember it by). Idempotency is a
     * marker blob keyed by the entry's uid (`forwardMarkerKey()`), checked before and written right *after* the
     * relay - the same "send, then record" order `completeDeliveryReceipt()` uses - so only a failure between the
     * relay and the marker write can repeat it. `markDelivered()` removes the marker once the entry is closed.
     */
    private async forwardByRuleOnce(entry: Q, raw: Buffer, result: ScanPipelineResult, forwardTo: string[]): Promise<void> {
        if (forwardTo.length === 0) {
            return;
        }
        const markerKey: string = this.forwardMarkerKey(entry.uid);
        if (await this.blobStore!.exists(markerKey)) {
            return;
        }
        await this.forwardByRule(entry, raw, result, forwardTo);
        await this.blobStore!.put(markerKey, Buffer.from(new Date().toISOString(), "utf-8"), { contentType: "text/plain" });
    }

    /**
     * Sends (or holds pending approval) the delivery receipt `message` asked for, *after* the row has been filed - at
     * most once. The outcome is claimed on the row *before* anything is sent, the way `BaseMessageRoute`'s read receipt
     * is: a version-checked write of `deliveryReceiptSentAt` (or `deliveryReceiptPending`), re-read and retried when an
     * unrelated write got there first (e.g. the client marking the message read), and skipped when a receipt was already
     * sent, is pending, or was declined. Only then is the receipt sent; a failed send releases the claim
     * (`releaseDeliveryReceiptClaim()`) so a later retry can send it. A crash between the claim and the send loses the
     * receipt rather than sending it twice.
     *
     * Gated exactly as before: `specs/end-to-end_encryption.md` §Header Integrity - `Disposition-Notification-To`
     * MUST be DKIM-verified (an unverified header is treated as absent) and MUST equal `From`, so an attacker can't
     * turn this mailbox into an MDN reflector - plus RFC 3834 auto-reply eligibility (`isAutoReplyEligible()`), since
     * an MDN is itself an automatic reply.
     */
    private async completeDeliveryReceipt(entry: Q, raw: Buffer, result: ScanPipelineResult, message: M): Promise<void> {
        if (
            !result.dispositionNotificationTo ||
            !result.fromAddress ||
            normalizeAddress(result.dispositionNotificationTo) !== normalizeAddress(result.fromAddress) ||
            !hasAlignedPassingDkim(this.authenticationResults(raw), result.fromAddress.split("@")[1] ?? "", this.trustedAuthservId) ||
            !isAutoReplyEligible(entry.envelopeFrom, {
                autoSubmittedHeader: result.autoSubmittedHeader,
                precedenceHeader: result.precedenceHeader,
            })
        ) {
            return;
        }
        const current: M | undefined = await this.messageRepo!.findOne(message.uid, { ignoreACL: true });
        if (!current || current.deliveryReceiptSentAt || current.deliveryReceiptPending || current.deliveryReceiptDeclined) {
            return;
        }
        const mailbox: X | undefined = await this.mailboxRepo!.findOne(entry.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            return;
        }

        const tier = await classifyRecipientTier(
            this._objectFactory!,
            this.domainClass,
            result.dispositionNotificationTo,
            createFederatedPeerCheck(this.dnsResolver!),
        );
        const autoSend: boolean =
            tier === "same-org"
                ? mailbox.autoSendReceiptsInternal
                : tier === "federated"
                  ? mailbox.autoSendReceiptsFederated
                  : mailbox.autoSendReceiptsExternal;
        // Not auto-sent: left for the mailbox owner's explicit approval (`BaseMessageRoute`'s `POST /:id/receipt/approve`).
        const claimed: M | undefined = await this.claimDeliveryReceipt(
            message.uid,
            autoSend ? { deliveryReceiptSentAt: new Date() } : { deliveryReceiptPending: true },
        );
        if (!claimed || !autoSend) {
            return;
        }
        const sent: boolean = await this.sendDispositionNotification(
            result.dispositionNotificationTo,
            mailbox,
            claimed.messageId,
            claimed.subject ?? "",
            "delivery",
        );
        if (!sent) {
            // Best-effort, as before: a failed send is logged (by `sendDispositionNotification()`) and not left recorded.
            await this.releaseDeliveryReceiptClaim(claimed);
        }
    }

    /** Writes `patch` (the delivery receipt's outcome) onto message `uid` with a version-checked update, re-reading and
     * retrying (3 attempts) on a version conflict. Returns the written row, or `undefined` when the receipt is already
     * handled (sent, pending or declined) or the message is gone. */
    private async claimDeliveryReceipt(uid: string, patch: Record<string, any>): Promise<M | undefined> {
        for (let attempt = 1; ; attempt++) {
            const current: M | undefined = await this.messageRepo!.findOne(uid, { ignoreACL: true });
            if (!current || current.deliveryReceiptSentAt || current.deliveryReceiptPending || current.deliveryReceiptDeclined) {
                return undefined;
            }
            try {
                return await this.messageRepo!.update(
                    { uid: current.uid, version: (current as any).version, ...patch } as any,
                    asEntity(this.messageRepo!, current),
                    { ignoreACL: true },
                );
            } catch (err: any) {
                if (attempt >= 3 || err?.status !== 409) {
                    throw err;
                }
            }
        }
    }

    /** Clears the `deliveryReceiptSentAt` `claimDeliveryReceipt()` wrote for a receipt that then failed to send - only
     * while the row still carries that exact claim. Re-read and retried on a version conflict; best-effort (logged). */
    private async releaseDeliveryReceiptClaim(claimed: M): Promise<void> {
        const claimedAt: number = new Date(claimed.deliveryReceiptSentAt as any).getTime();
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const current: M | undefined = await this.messageRepo!.findOne(claimed.uid, { ignoreACL: true });
                if (!current?.deliveryReceiptSentAt || new Date(current.deliveryReceiptSentAt).getTime() !== claimedAt) {
                    return;
                }
                await this.messageRepo!.update(
                    { uid: current.uid, version: (current as any).version, deliveryReceiptSentAt: null } as any,
                    asEntity(this.messageRepo!, current),
                    { ignoreACL: true },
                );
                return;
            } catch (err: any) {
                this.logger?.warn(`ScanQueueJob: failed to release the delivery receipt claim on message ${claimed.uid} (attempt ${attempt}): ${err?.message}`);
            }
        }
    }

    /**
     * Relays `raw` to each of a mail filter rule's forward addresses. The message already passed the scan
     * pipeline this same run, so it's relayed without a re-scan, with four guards a rule-driven forward needs:
     *
     * - **No automatic mail** (`Auto-Submitted` other than `no`, RFC 3834) - an auto-reply or bounce is never
     * forwarded, which is what stops two mailboxes forwarding to each other from bouncing mail back and forth.
     * - **Loop detection** - each forward adds an `X-RapidMX-Loop: <mailbox address>` header; a message already
     * carrying this mailbox's own marker, or `MAX_FORWARD_HOPS` markers in total, isn't forwarded again.
     * - **Envelope sender rewrite** - the forward is sent from this mailbox's own address, so SPF/DMARC evaluate against
     * a domain this server may send for and bounces come back here instead of to a third party (a minimal form of SRS).
     * - **No laundering** - the copy is built by `prepareRelayCopy()`, the same policy distribution-list relays use: the
     * MTA DKIM-signs the forward as this server's domain, so trust-bearing headers (`Authentication-Results`,
     * `RapidMX-Key`, `X-RapidMX-Recall-Of`, `Disposition-Notification-To`) are stripped, an unauthenticated `From` is
     * rewritten to this mailbox (the original kept in `X-Original-From` and `Reply-To`), and unauthenticated calendar
     * content isn't forwarded at all. Without this, a forged `From: ceo@<our domain>` forwarded back into this server
     * would arrive with `dkim=pass` for our own domain and pass every recall/key/iTIP trust check.
     *
     * A transport rejection is logged per address, like a thrown error.
     */
    private async forwardByRule(entry: Q, raw: Buffer, result: ScanPipelineResult, forwardTo: string[]): Promise<void> {
        if (result.autoSubmittedHeader && result.autoSubmittedHeader.trim().toLowerCase() !== "no") {
            this.logger?.info(`ScanQueueJob: not forwarding automatically submitted mail for mailbox ${entry.mailboxUid}.`);
            return;
        }
        const mailbox: X | undefined = await this.mailboxRepo!.findOne(entry.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            return;
        }
        const ownAddress: string = normalizeAddress(mailbox.primarySmtpAddress);
        const loopMarkers: string[] = extractHeaders(raw, FORWARD_LOOP_HEADER).map((value) => normalizeAddress(value));
        if (loopMarkers.includes(ownAddress) || loopMarkers.length >= MAX_FORWARD_HOPS) {
            this.logger?.warn(`ScanQueueJob: not forwarding message for mailbox ${entry.mailboxUid} - forwarding loop detected.`);
            return;
        }
        // The scan pipeline's own MIME parse can find calendar parts the header-level check in `prepareRelayCopy()`
        // can't - an unauthenticated message carrying one isn't forwarded either.
        const copy: Buffer | undefined =
            result.icsPart !== undefined && !verifiedFromAddress(raw, this.trustedAuthservId)
                ? undefined
                : prepareRelayCopy(raw, {
                      trustedAuthservId: this.trustedAuthservId,
                      rewriteFrom: { address: mailbox.primarySmtpAddress, name: mailbox.displayName },
                      replyToOriginalFrom: true,
                  });
        if (!copy) {
            this.logger?.warn(`ScanQueueJob: not forwarding calendar content from an unauthenticated sender for mailbox ${entry.mailboxUid}.`);
            return;
        }
        const forwardRaw: Buffer = prependHeaders(copy, [{ name: FORWARD_LOOP_HEADER, value: mailbox.primarySmtpAddress }]);
        for (const address of forwardTo) {
            try {
                await sendOrThrow(this.mailTransport, { raw: forwardRaw, envelopeFrom: mailbox.primarySmtpAddress, envelopeTo: [address] });
            } catch (err: any) {
                this.logger?.warn(`ScanQueueJob: failed to forward message to ${address}: ${err.message}`);
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
            // Only a folder of this same mailbox - see the identical check on rule copies in `deliverMessage()`.
            if (moved && !moved.deleted && moved.mailboxUid === mailboxUid) {
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
        return { "emails.address": ModelUtils.literal(address) };
    }

    /**
     * The query value matching one element of `Mailbox.aliasAddresses` - a literal on MongoDB (implicit array-element
     * equality); `ScanQueueJobSQL` overrides it for the serialized `simple-json` column, exactly as
     * `BaseMailIngestRoute.aliasQueryValue()` does.
     */
    protected aliasQueryValue(address: string): any {
        return ModelUtils.literal(address);
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
        const keyHeaders: string[] = extractHeaders(raw, RAPIDMX_KEY_HEADER);
        // Aligned, passing DKIM alone isn't enough: the header must also be *oversigned* by that aligned signature,
        // or anyone holding one genuinely signed message from this domain could append their own key header to it
        // and replay it (`util/DkimOversignUtils.ts`).
        if (
            keyHeaders.length > 0 &&
            hasAlignedPassingDkim(this.authenticationResults(raw), fromDomain, this.trustedAuthservId) &&
            isHeaderOversignedByAlignedDkim(raw, RAPIDMX_KEY_HEADER, fromDomain, this.authenticationResults(raw), this.trustedAuthservId)
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

        const now: number = Date.now();
        let headerConflict = false;
        await this.persistContactKeyUpdate(entry.mailboxUid, fromAddress, now, (existingContact) => {
            if (!existingContact && !discovered) {
                // Nothing on file, nothing discovered - recording lastMessageSeen alone isn't reason enough to
                // create a Contact for every random inbound sender.
                return undefined;
            }
            const update: ContactKeyState = applyDiscoveredKeys(existingContact, discovered, now, "header", fromAddress);
            headerConflict = !!update.keyConflicts?.some((conflict) => conflict.source === "header" && conflict.observedAt === now);
            return update;
        });

        // A `RapidMX-Key` header carries no issuer certificate, so a rotated key seen there can only be recorded as a
        // conflict. The discovery endpoint publishes the issuer, so look again there: when the peer rotated within the
        // same CA after retiring the old key, the automatic replacement applies and the conflict clears.
        if (headerConflict) {
            await this.refreshKeysAfterHeaderConflict(entry.mailboxUid, fromAddress);
        }
    }

    /**
     * Re-runs discovery for `address` after its `RapidMX-Key` header conflicted with the pinned key
     * (`processInboundRapidMxKeyHeader()`), through the same shared contact write as `maybeRefreshRotatedKey()`. Bounded
     * like that refresh: a domain that isn't a federated peer is negatively cached (`util/FederationUtils.ts`), a
     * response is served from the per-address cache until its `max-age` (`util/KeyDiscoveryClient.ts`), and the fetch
     * has a timeout. It never fails delivery: an error is logged and the header's conflict stays recorded.
     */
    private async refreshKeysAfterHeaderConflict(mailboxUid: string, address: string): Promise<void> {
        try {
            await this.maybeRefreshRotatedKey(mailboxUid, address);
        } catch (err: any) {
            this.logger?.warn(`ScanQueueJob: key discovery refresh for mailbox ${mailboxUid} after a key header conflict failed: ${err?.message ?? err}`);
        }
    }

    /**
     * Shared persistence tail for both `processInboundRapidMxKeyHeader()` (Group E3) and
     * `maybeRefreshRotatedKey()` (Group E5): reads the Contact for `address`, asks `merge` for its new key state
     * (`undefined` writes nothing) and stamps it (and `lastMessageSeen`) onto that Contact, or creates a brand-new
     * `Contact` in the mailbox's Contacts folder when there is none. Callers decide in `merge` whether creating a new
     * `Contact` is warranted at all (see each caller's own doc comment). Goes through `util/ContactKeyUtils.ts`'s
     * `writeContactKeys()` - version-checked update, deterministic-uid create, re-read and re-merge after a lost race - so
     * a concurrent key lookup or `POST /:id/keys/trust` for the same address can't end with two contacts or two pins.
     */
    private async persistContactKeyUpdate(
        mailboxUid: string,
        address: string,
        now: number,
        merge: (existingContact: C | undefined) => Promise<ContactKeyState | undefined> | ContactKeyState | undefined,
    ): Promise<void> {
        await writeContactKeys<C, F>(
            {
                contactRepo: this.contactRepo!,
                folderRepo: this.folderRepo!,
                contactClass: this.contactClass,
                folderClass: this.folderClass,
                mailboxUid,
                address,
                findContact: async () =>
                    (
                        await this.contactRepo!.find(
                            { mailboxUid, limit: 1, ...this.contactEmailQuery(address) },
                            { ignoreACL: true, limit: 1, skipCache: true },
                        )
                    )[0],
            },
            async (existingContact) => {
                const update: ContactKeyState | undefined = await merge(existingContact);
                return update ? ({ ...update, lastMessageSeen: now } as Partial<C>) : undefined;
            },
        );
    }

    /**
     * Implements the receiving half of `specs/end-to-end_encryption.md`'s "Rotation Notification" mechanism
     * (Group E5): when an inbound MDN carries either of `util/ReceiptUtils.ts`'s `rotatedKeyFingerprint`/
     * `policyId` extension fields, this method re-runs real Discovery (`util/KeyringUtils.ts`'s
     * `discoverAndMergeKeys()`) against the authoritative source for `peerAddress` - the local mailbox when the peer lives
     * on this deployment (no DNS, no HTTP), else its remote endpoint - it never installs the
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
        const now: number = Date.now();
        // Only a rotation notice needs it, so it isn't set up for every delivery.
        this.keyVaultRepo ??= await this._objectFactory!.newInstance(RepoUtils, { name: this.keyVaultClass.name, args: [this.keyVaultClass] });
        await this.persistContactKeyUpdate(mailboxUid, peerAddress, now, (existingContact) =>
            discoverAndMergeKeys(this.dnsResolver!, peerAddress, existingContact, now, {
                mailboxRepo: this.mailboxRepo!,
                keyVaultRepo: this.keyVaultRepo!,
                domainNames: () => getVerifiedDomainNames(this._objectFactory!, this.domainClass),
                aliasQueryValue: (address) => this.aliasQueryValue(address),
                plusAddressing: this.plusAddressingEnabled,
            }),
        );
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
            { mailboxUid, senderAddress: ModelUtils.literal(senderAddress), limit: 1 } as any,
            { ignoreACL: true, limit: 1 },
        );
        return matches[0]?.classifyAs;
    }

    /**
     * The conversation a message being delivered into `mailboxUid` belongs to: the one an ancestor named in its
     * `References`/`In-Reply-To` is already filed under here, falling back to what those headers derive on their
     * own (`util/ConversationUtils.ts`'s `resolveConversationId()`). The lookup is what holds a chain deeper
     * than one reply together when the sending client sets only `In-Reply-To`, and it is the same resolution
     * `BaseMessageRoute.send()` applies to the sender's Sent Items copy, so every copy of a thread in a mailbox
     * carries the same `conversationId`.
     */
    private async resolveConversation(mailboxUid: string, result: ScanPipelineResult, messageId: string): Promise<string> {
        return await resolveConversationId(result.references, result.inReplyTo, messageId, (ancestors) =>
            findThreadConversationId(this.messageRepo!, mailboxUid, ancestors),
        );
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
                { mailboxUid, conversationId: ModelUtils.literal(conversationId), limit: 1 } as any,
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

    /** Stores each attachment under a key derived from the target message's uid and its position, so a
     * re-processed entry overwrites the same blobs instead of leaving orphaned copies behind. */
    private async storeAttachmentBlobs(attachments: ScanPipelineAttachmentResult[], targetUid: string): Promise<StoredAttachment[]> {
        const stored: StoredAttachment[] = [];
        for (const [index, attachment] of attachments.entries()) {
            const blobKey = `attachments/${targetUid}-${index}`;
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

    /** Creates the `Attachment` rows for `message`, each under a uid derived from the message's uid and the
     * attachment's position; rows an earlier attempt already created are left as they are. */
    private async attachRows(stored: StoredAttachment[], message: M, folder: F, mailboxUid: string): Promise<void> {
        for (const [index, attachment] of stored.entries()) {
            const uid: string = nameBasedUuid(`${message.uid}:attachment:${index}`);
            if (await this.attachmentRepo!.findOne(uid, { ignoreACL: true })) {
                continue;
            }
            await this.attachmentRepo!.create(
                new this.attachmentClass({
                    uid,
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

    /** What `util/FolderCountUtils.ts` needs to recompute, cache and publish a folder's counts: a folder's
     * `unreadCount`/`totalCount` are derived from its messages, so after filing (or deleting) one the counts are
     * recomputed and published as a live event rather than incremented. Best-effort (never fails the delivery). */
    private folderCountsContext(): FolderCountsContext {
        return {
            messageRepo: this.messageRepo!,
            folderRepo: this.folderRepo!,
            folderClass: this.folderClass,
            notificationUtils: this.notificationUtils,
            logger: this.logger,
        };
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

        // Stored bounded (`OofReplySuppression`'s constructor), so looked up bounded; re-checked in memory since the
        // unchecked envelope sender could otherwise be read as a query operator (e.g. `ne(x)`).
        const senderKey: string = boundIndexedValue(entry.envelopeFrom);
        const existing: OS[] = (
            await this.oofReplySuppressionRepo!.find({ mailboxUid: entry.mailboxUid, senderAddress: ModelUtils.literal(senderKey), limit: 1 } as any, {
                ignoreACL: true,
                limit: 1,
            })
        ).filter((row) => row.senderAddress === senderKey);
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
                from: { name: safeDisplayName(mailbox.displayName), address: mailbox.primarySmtpAddress },
                to: entry.envelopeFrom,
                subject,
                html: activeOof.message,
                inReplyTo: result.messageIdHeader,
                references: result.messageIdHeader,
                headers: { "Auto-Submitted": "auto-replied" },
            })
                .compile()
                .build();

            // Throws when the transport accepted nothing, so a reply that was never sent isn't recorded as sent.
            await sendOrThrow(this.mailTransport, {
                raw: composed,
                envelopeFrom: mailbox.primarySmtpAddress,
                envelopeTo: [entry.envelopeFrom],
            });

            if (suppression) {
                await this.oofReplySuppressionRepo!.update(
                    { uid: suppression.uid, version: (suppression as any).version, lastRepliedAt: now } as any,
                    asEntity(this.oofReplySuppressionRepo!, suppression),
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
     * The message's `From` address when it's authenticated - a passing DKIM result aligned with the `From`
     * domain, stamped by this deployment's trusted MTA hop (`hasAlignedPassingDkim()`) - otherwise `undefined`.
     * Mail this server's own mailboxes send (recall notices, iTIP invitations and replies) is DKIM-signed on the
     * way out and arrives back through the same MTA, so it passes this check exactly like external mail does.
     */
    private verifiedFromAddress(raw: Buffer, result: ScanPipelineResult): string | undefined {
        const fromAddress: string | undefined = result.fromAddress ? normalizeAddress(result.fromAddress) : undefined;
        const domain: string | undefined = fromAddress?.split("@")[1];
        if (!fromAddress || !domain) {
            return undefined;
        }
        return hasAlignedPassingDkim(this.authenticationResults(raw), domain, this.trustedAuthservId) ? fromAddress : undefined;
    }

    /**
     * Applies a `BaseMessageRoute.recall()` control message's effect in this mailbox (`entry.mailboxUid`):
     * finds the target `Message` by `messageId` - matching regardless of which folder it's since been moved
     * to, mirroring how `findCalendarEventRow()` matches an iTIP message by `icalUid` rather than a foreign
     * key - and deletes it only if still unread, matching real Exchange/Outlook's "Recall This Message"
     * behavior exactly. Either way, reports the outcome back to the original sender - see
     * `sendRecallReport()`.
     *
     * Only reached for a recall whose `From` is DKIM-verified (`processEntry()`), and only a message that same
     * address sent can be recalled: a message from anyone else with that `Message-ID` is treated as not found, so a
     * recall can neither delete another sender's mail nor learn whether it was read.
     */
    private async processRecall(entry: Q, raw: Buffer, result: ScanPipelineResult, recallOfMessageId: string): Promise<void> {
        const sender: string = this.verifiedFromAddress(raw, result)!;
        // `Message.messageId` is stored bounded (`boundIndexedValue()`), so the lookup is bounded too - and re-checked for
        // exact equality, since a sender-supplied value like `ne(x)` would otherwise be parsed as a query operator.
        const messageKey: string = boundIndexedValue(recallOfMessageId);
        const matches: M[] = (
            await this.messageRepo!.find(
                { mailboxUid: entry.mailboxUid, messageId: ModelUtils.literal(messageKey), limit: 5 } as any,
                { ignoreACL: true, limit: 5 },
            )
        ).filter((message) => message.messageId === messageKey && normalizeAddress(message.from?.address ?? "") === sender);
        const target: M | undefined = matches.find((message) => !message.flags?.read);

        let outcome: "succeeded" | "already_read" | "not_found";
        if (target && (await this.lockUnreadForRecall(target))) {
            await this.messageRepo!.delete(target.uid, { ignoreACL: true });
            await refreshFolderCounts(this.folderCountsContext(), [target.folderUid]);
            // Recalled content must stop being searchable, not just hidden from folder views.
            await removeFromSearchIndex(this.searchProvider, "message", target.uid, this.logger);
            outcome = "succeeded";
        } else {
            outcome = matches.length > 0 ? "already_read" : "not_found";
        }

        await this.sendRecallReport(entry, sender, outcome);
    }

    /**
     * Sends a plain, visible report email back to `sender` (the verified address that requested the
     * recall) describing what happened in *this* mailbox - mirrors real Outlook's own recall-report
     * behavior (a normal email in the sender's Inbox, not a synced status flag). Best-effort, same as every
     * other cross-mailbox notification in this codebase.
     */
    /**
     * Confirms `target` is still unread with a version-checked no-op write (bumping its version) right before
     * `processRecall()` deletes it, so a read that lands between the recall's `find()` and its delete makes the
     * recall report "already read" instead of silently deleting a message the recipient has just opened. Retries
     * a version conflict caused by some other change a few times. `RepoUtils.delete()` itself has no version
     * check, so this narrows the race to the gap between this write and the delete rather than closing it.
     */
    private async lockUnreadForRecall(target: M): Promise<boolean> {
        for (let attempt = 1; attempt <= 3; attempt++) {
            const current: M | undefined = await this.messageRepo!.findOne(target.uid, { ignoreACL: true });
            if (!current || current.deleted || current.flags?.read) {
                return false;
            }
            try {
                await this.messageRepo!.update(
                    { uid: current.uid, version: (current as any).version, flags: current.flags } as any,
                    asEntity(this.messageRepo!, current),
                    { ignoreACL: true, skipPush: true },
                );
                return true;
            } catch (err: any) {
                this.logger?.debug(`ScanQueueJob: recall lock on message ${target.uid} conflicted (attempt ${attempt}): ${err?.message}`);
            }
        }
        return false;
    }

    private async sendRecallReport(entry: Q, sender: string, outcome: "succeeded" | "already_read" | "not_found"): Promise<void> {
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
                from: { name: safeDisplayName(mailbox.displayName), address: mailbox.primarySmtpAddress },
                to: sender,
                subject: "Recall report",
                text,
            })
                .compile()
                .build();
            await sendOrThrow(this.mailTransport, { raw: composed, envelopeFrom: mailbox.primarySmtpAddress, envelopeTo: [sender] });
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
    private async tryCorrelateAcmeChallenge(entry: Q, raw: Buffer, result: ScanPipelineResult): Promise<boolean> {
        if (result.autoSubmittedHeader !== "auto-generated; type=acme") {
            return false;
        }
        const subjectMatch: RegExpMatchArray | null = result.subject ? ACME_CHALLENGE_SUBJECT.exec(result.subject) : null;
        if (!subjectMatch || !result.fromAddress || !result.messageIdHeader) {
            return false;
        }
        // The challenge must really come from the CA: a `From` with aligned, passing DKIM. Anyone can send mail
        // that merely looks like a challenge, and recording a forged token would have this server answer it.
        if (!this.verifiedFromAddress(raw, result)) {
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

        try {
            // Refuses (throws) a Reply-To outside the CA's own domain - the reply carries the token, so it must not
            // be redirectable to an address of the sender's choosing.
            await this.signingCertificateEnrollment.recordChallengeToken(
                enrollmentId,
                subjectMatch[1],
                result.replyToAddress ?? result.fromAddress,
                result.messageIdHeader,
                result.subject!,
            );
        } catch (err: any) {
            this.logger?.warn(`ScanQueueJob: not recording ACME challenge for enrollment ${enrollmentId}: ${err.message}`);
            return false;
        }
        return true;
    }

    /**
     * Composes and relays one real RFC 3798 MDN via `util/ReceiptUtils.ts`'s `buildDispositionNotification()`
     * - shared by `completeDeliveryReceipt()` (called automatically at delivery time) and
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
                from: { address: mailbox.primarySmtpAddress, displayName: safeDisplayName(mailbox.displayName) },
                to: dispositionNotificationTo,
                subject: `${dispositionType === "read" ? "Read" : "Delivered"}: ${originalSubject}`,
                finalRecipient: mailbox.primarySmtpAddress,
                originalMessageId,
                dispositionType,
                reportingUa: `${this.mxHostname}; RapidMX`,
                rotatedKeyFingerprint: activeEncryptKey?.fingerprint,
            });
            await sendOrThrow(this.mailTransport, {
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
            !hasAlignedPassingDkim(this.authenticationResults(raw), respondingDomain, this.trustedAuthservId)
        ) {
            this.logger?.warn(`ScanQueueJob: dropping unverified/unaligned MDN for mailbox ${entry.mailboxUid}.`);
            return;
        }

        // Rotation Notification (Group E5) - a cache-invalidation hint only, independent of whether this MDN
        // also correlates to a message this mailbox can find below.
        if (parsed.rotatedKeyFingerprint || parsed.policyId) {
            await this.maybeRefreshRotatedKey(entry.mailboxUid, parsed.finalRecipient);
        }

        // Bounded and exact-matched for the same reasons as `processRecall()`'s lookup.
        const messageKey: string = boundIndexedValue(parsed.originalMessageId);
        const matches: M[] = (
            await this.messageRepo!.find({ mailboxUid: entry.mailboxUid, messageId: ModelUtils.literal(messageKey), limit: 5 } as any, { ignoreACL: true, limit: 5 })
        ).filter((message) => message.messageId === messageKey);
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
            asEntity(this.messageRepo!, target),
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
    private async maybeProcessItipMessage(entry: Q, raw: Buffer, result: ScanPipelineResult): Promise<void> {
        if (!result.icsPart) {
            return;
        }
        const parsed: ParsedIcsEvent | undefined = parseIcsEvent(result.icsPart);
        if (!parsed) {
            return;
        }
        // RFC 5546 §6.1: an iTIP message changes a calendar only when it comes from the party entitled to send it.
        // Without an authenticated sender anyone could move, rewrite or cancel meetings, or forge attendee replies.
        const sender: string | undefined = this.verifiedFromAddress(raw, result);
        if (!sender) {
            this.logger?.warn(`ScanQueueJob: ignoring iTIP ${parsed.method} for event ${parsed.uid} - its sender isn't DKIM-verified.`);
            return;
        }

        try {
            switch (parsed.method) {
                case "REQUEST":
                    await this.processItipRequest(entry.mailboxUid, parsed, result.encrypted, sender);
                    break;
                case "REPLY":
                    await this.processItipReply(entry.mailboxUid, parsed, sender);
                    break;
                case "CANCEL":
                    await this.processItipCancel(entry.mailboxUid, parsed, sender);
                    break;
                default:
                    break;
            }
        } catch (err: any) {
            this.logger?.warn(`ScanQueueJob: failed to process iTIP ${parsed.method} for event ${parsed.uid}: ${err.message}`);
        }
    }

    /** Every `CalendarEvent` row in `mailboxUid` sharing `icalUid` (a master and its override rows). `icalUid` is
     * stored bounded (`boundIndexedValue()`), so it's looked up bounded, and exact-matched in memory: a sender-supplied
     * UID like `ne(x)` would otherwise be parsed as a query operator and match (and let a CANCEL delete) other events. */
    private async findCalendarEventRows(mailboxUid: string, icalUid: string): Promise<CE[]> {
        const key: string = boundIndexedValue(icalUid);
        const rows: CE[] = await this.calendarEventRepo!.find({ mailboxUid, icalUid: ModelUtils.literal(key), limit: 50 } as any, { ignoreACL: true, limit: 50 });
        return rows.filter((row) => row.icalUid === key);
    }

    /** Finds the `CalendarEvent` row in `mailboxUid` matching `(icalUid, recurrenceId)` together, if any. */
    private async findCalendarEventRow(mailboxUid: string, icalUid: string, recurrenceId: Date | undefined): Promise<CE | undefined> {
        const rows: CE[] = await this.findCalendarEventRows(mailboxUid, icalUid);
        return rows.find((row) => recurrenceIdsMatch(row.recurrenceId, recurrenceId));
    }

    /** `true` if `sender` is the organizer of the series `rows` belong to (every row of one `icalUid` shares it). */
    private isOrganizerOf(rows: CE[], sender: string): boolean {
        return rows.length > 0 && rows.every((row) => normalizeAddress(row.organizer?.address ?? "") === sender);
    }

    /** `encrypted` is only ever consulted on the create branch below - an existing row's own
     * `encryptionOrigin` (set once, from whichever REQUEST first created it) is deliberately never
     * overwritten by a later update, per the spec's "sticky" encryption-state rule
     * (`CalendarEvent.encryptionOrigin`'s own doc comment). This inbound iTIP pipeline only ever produces
     * `"derived"` or `"none"` - `"originated"` is set by a client explicitly creating/marking its own
     * outbound invite as encrypted, a different code path entirely (see `MeetingSchedulingJob`). */
    private async processItipRequest(mailboxUid: string, parsed: ParsedIcsEvent, encrypted: boolean, sender: string): Promise<void> {
        const seriesRows: CE[] = await this.findCalendarEventRows(mailboxUid, parsed.uid);
        const existing: CE | undefined = seriesRows.find((row) => recurrenceIdsMatch(row.recurrenceId, parsed.recurrenceId));
        // Only the organizer may create or update a meeting: the sender must be the organizer the REQUEST names,
        // and - for a meeting this mailbox already has - the organizer on record, so a REQUEST can't take over
        // someone else's meeting by naming itself the organizer.
        if (!parsed.organizer || normalizeAddress(parsed.organizer.address) !== sender) {
            this.logger?.warn(`ScanQueueJob: ignoring iTIP REQUEST for event ${parsed.uid} - its sender isn't the organizer it names.`);
            return;
        }
        if (seriesRows.length > 0 && !this.isOrganizerOf(seriesRows, sender)) {
            this.logger?.warn(`ScanQueueJob: ignoring iTIP REQUEST for event ${parsed.uid} - its sender isn't the event's organizer.`);
            return;
        }
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
                    // The organizer's TZID (IANA-resolved), so a recurring meeting expands in its own zone across DST.
                    timezone: parsed.timezone ?? "UTC",
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
                    // This is an attendee's copy of someone else's invitation - marked as already sent so
                    // `MeetingSchedulingJob` never re-sends it as if this mailbox were the organizer.
                    inviteSequenceSent: parsed.sequence,
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
                    inviteSequenceSent: parsed.sequence,
                } as any,
                asEntity(this.calendarEventRepo!, existing),
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
     * `expandOccurrencesDetailed()` so a recurring series is checked occurrence-by-occurrence, not just at its first
     * instance. The request is expanded in windows and each existing booking only across the span of the requested
     * occurrences it is compared with (`bookingConflicts()`), so no ordinary series hits the per-expansion cap; only an
     * expansion that stays truncated even then declines, since it can't prove "no conflict".
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
        // Expanded in `RESOURCE_BOOKING_CHUNK_MS` windows, so an ordinary open-ended series (e.g. every weekday, ~520
        // occurrences over the horizon) isn't cut off by `expandOccurrencesDetailed()`'s per-call cap. Only a chunk that
        // is itself truncated, or more than `RESOURCE_BOOKING_MAX_REQUESTED_OCCURRENCES` occurrences in all, declines.
        const requestedByStart: Map<number, OccurrenceWindow> = new Map();
        for (let chunkStart = startDate.getTime(); chunkStart < horizonEnd.getTime(); chunkStart += RESOURCE_BOOKING_CHUNK_MS) {
            const chunk: OccurrenceExpansion = expandOccurrencesDetailed(
                // `allDay: false` matches the row `processItipRequest()` stores for this request (`ParsedIcsEvent` carries
                // no all-day flag); `timezone` keeps a recurring request's wall-clock stepping DST-correct.
                { startDate, endDate, recurrenceRule: parsed.recurrenceRule, timezone: parsed.timezone, allDay: false },
                new Date(chunkStart),
                new Date(Math.min(chunkStart + RESOURCE_BOOKING_CHUNK_MS, horizonEnd.getTime())),
                parsed.recurrenceRule?.exceptions,
            );
            for (const occurrence of chunk.occurrences) {
                requestedByStart.set(occurrence.start.getTime(), occurrence);
            }
            /* v8 ignore next 5 -- a safety net: the supported frequencies (at most daily) stay far below both caps */
            if (chunk.truncated || requestedByStart.size > RESOURCE_BOOKING_MAX_REQUESTED_OCCURRENCES) {
                // Every occurrence past the expansion cap would go unchecked - can't prove there's no conflict.
                this.logger?.warn(`ScanQueueJob: declining booking request ${parsed.uid} for resource ${mailbox.uid} - too many requested occurrences to check for conflicts.`);
                return AttendeeResponseStatus.DECLINED;
            }
            if (!parsed.recurrenceRule) {
                break;
            }
        }
        const requestedOccurrences: OccurrenceWindow[] = [...requestedByStart.values()];
        // Per-occurrence overrides sent alongside the master move (or keep) individual occurrences. Their own windows are
        // checked *in addition to* the master's unmodified occurrences, not instead of them: only the master row is
        // stored for this booking, so the vacated original instants still read as busy to every later request - checking
        // both keeps this decision consistent with what's persisted while never accepting a moved occurrence that
        // conflicts. A cancelled override adds nothing.
        for (const override of parsed.overrides ?? []) {
            if (override.startDate && override.endDate && override.status?.toUpperCase() !== "CANCELLED" && override.startDate.getTime() < horizonEnd.getTime()) {
                requestedOccurrences.push({ start: override.startDate, end: override.endDate });
            }
        }
        if (requestedOccurrences.length === 0) {
            return AttendeeResponseStatus.ACCEPTED;
        }
        requestedOccurrences.sort((a, b) => a.start.getTime() - b.start.getTime());
        // Existing bookings only matter where they could touch a requested occurrence.
        const windowStart: Date = requestedOccurrences[0].start;
        const windowEnd: Date = new Date(Math.max(...requestedOccurrences.map((occurrence) => occurrence.end.getTime())));

        // Three bounded reads instead of "every row starting before the horizon" (which also returned every past
        // booking, so a resource with a long history hit the page cap and declined everything):
        // 1. rows that themselves overlap the window (non-recurring bookings and override rows, plus any recurring
        //    master whose first instance does);
        // 2. recurring masters, whose later occurrences can reach the window however long ago they started - ended
        //    series (`until` before the window) are dropped in memory, since `recurrenceRule` isn't queryable by field
        //    on the SQL backend;
        // 3. override rows near/after the window, whose `recurrenceId`s exclude the master's phantom occurrence.
        // A read too large to complete declines, rather than risking a double booking on the rows it didn't see.
        const overlapping: CE[] | undefined = await this.readBookingPages({
            mailboxUid: mailbox.uid,
            startDate: `lt(${windowEnd.toISOString()})`,
            endDate: `gt(${windowStart.toISOString()})`,
        });
        const masters: CE[] | undefined = overlapping && (await this.readBookingPages({ mailboxUid: mailbox.uid, recurrenceRule: "ne(null)" }));
        const overrides: CE[] | undefined =
            masters &&
            (await this.readBookingPages({
                mailboxUid: mailbox.uid,
                recurrenceId: `gte(${new Date(windowStart.getTime() - RESOURCE_BOOKING_OVERRIDE_LOOKBACK_MS).toISOString()})`,
            }));
        if (!overlapping || !masters || !overrides) {
            this.logger?.warn(`ScanQueueJob: declining booking request ${parsed.uid} for resource ${mailbox.uid} - too many existing bookings to check for conflicts.`);
            return AttendeeResponseStatus.DECLINED;
        }

        const candidates: Map<string, CE> = new Map();
        for (const row of overlapping) {
            candidates.set(row.uid, row);
        }
        for (const row of masters) {
            const until: Date | undefined = row.recurrenceRule?.until ? new Date(row.recurrenceRule.until) : undefined;
            if (!row.recurrenceId && (!until || Number.isNaN(until.getTime()) || until.getTime() >= windowStart.getTime())) {
                candidates.set(row.uid, row);
            }
        }

        for (const candidateRow of candidates.values()) {
            if (candidateRow.icalUid === boundIndexedValue(parsed.uid)) {
                // A prior row of this very request (a resend/update) - never conflicts with itself.
                continue;
            }
            const isMaster = !!candidateRow.recurrenceRule && !candidateRow.recurrenceId;
            const excludeDates = isMaster
                ? [
                      ...(candidateRow.recurrenceRule?.exceptions ?? []),
                      ...[...overlapping, ...overrides]
                          .filter((row) => row.icalUid === candidateRow.icalUid && row.recurrenceId)
                          .map((row) => row.recurrenceId!),
                  ]
                : undefined;
            const conflict: boolean | undefined = this.bookingConflicts(candidateRow, excludeDates, requestedOccurrences, 0, requestedOccurrences.length);
            if (conflict === undefined) {
                this.logger?.warn(`ScanQueueJob: declining booking request ${parsed.uid} for resource ${mailbox.uid} - existing booking ${candidateRow.uid} has too many occurrences to check for conflicts.`);
                return AttendeeResponseStatus.DECLINED;
            }
            if (conflict) {
                return AttendeeResponseStatus.DECLINED;
            }
        }

        return AttendeeResponseStatus.ACCEPTED;
    }

    /**
     * Whether existing booking `row` overlaps any of `requested[lo..hi)` (sorted by start). The row is expanded only
     * across the span of that group of requested occurrences; when that expansion is truncated the group is split in
     * half and each half checked on its own narrower span, so a long-running existing series is never expanded over
     * the whole horizon at once. `undefined` when even a single requested occurrence's own span can't be expanded
     * completely - no conflict can be ruled out.
     */
    private bookingConflicts(
        row: CE,
        excludeDates: (Date | string)[] | undefined,
        requested: OccurrenceWindow[],
        lo: number,
        hi: number,
    ): boolean | undefined {
        const group: OccurrenceWindow[] = requested.slice(lo, hi);
        const spanStart: Date = group[0].start;
        const spanEnd: Date = new Date(Math.max(...group.map((occurrence) => occurrence.end.getTime())));
        const existing: OccurrenceExpansion = expandOccurrencesDetailed(
            { startDate: row.startDate, endDate: row.endDate, recurrenceRule: row.recurrenceRule, timezone: row.timezone, allDay: row.allDay },
            spanStart,
            spanEnd,
            excludeDates,
        );
        if (existing.truncated) {
            if (hi - lo <= 1) {
                return undefined;
            }
            const mid: number = lo + Math.floor((hi - lo) / 2);
            const first: boolean | undefined = this.bookingConflicts(row, excludeDates, requested, lo, mid);
            if (first !== false) {
                return first;
            }
            return this.bookingConflicts(row, excludeDates, requested, mid, hi);
        }
        return group.some((requestedOccurrence) =>
            existing.occurrences.some(
                (existingOccurrence) =>
                    requestedOccurrence.start.getTime() < existingOccurrence.end.getTime() &&
                    requestedOccurrence.end.getTime() > existingOccurrence.start.getTime(),
            ),
        );
    }
    /** Reads every page of a resource's `CalendarEvent` rows matching `criteria`, in a stable order - or `undefined`
     * once `RESOURCE_BOOKING_MAX_PAGES` full pages have been read without reaching the end. */
    private async readBookingPages(criteria: Record<string, any>): Promise<CE[] | undefined> {
        const all: CE[] = [];
        for (let page = 0; page < RESOURCE_BOOKING_MAX_PAGES; page++) {
            const rows: CE[] = await this.calendarEventRepo!.find(
                { ...criteria, sort: { startDate: "ASC", uid: "ASC" }, limit: RESOURCE_BOOKING_EXISTING_ROWS_LIMIT, page } as any,
                { ignoreACL: true, limit: RESOURCE_BOOKING_EXISTING_ROWS_LIMIT, page, skipCache: true },
            );
            all.push(...rows);
            if (rows.length < RESOURCE_BOOKING_EXISTING_ROWS_LIMIT) {
                return all;
            }
        }
        return undefined;
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
            await this.deleteReceivedEventCopy(row);
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
                from: { name: safeDisplayName(mailbox.displayName), address: mailbox.primarySmtpAddress },
                to: row.organizer.address,
                subject: `${decision === AttendeeResponseStatus.DECLINED ? "Declined" : "Accepted"}: ${row.title}`,
                text: `${mailbox.displayName || mailbox.primarySmtpAddress} has automatically ${verb}: ${row.title}`,
                icalEvent: { method: "reply", content: ics },
            })
                .compile()
                .build();
            await sendOrThrow(this.mailTransport, { raw: composed, envelopeFrom: mailbox.primarySmtpAddress, envelopeTo: [row.organizer.address] });
        } catch (err: any) {
            this.logger?.warn(`ScanQueueJob: failed to send resource auto-response for event ${row.uid}: ${err.message}`);
        }
    }

    /**
     * Soft-deletes this mailbox's copy of someone else's meeting (declined by a resource, or cancelled by its
     * organizer). `cancelNoticeSentAt` is stamped first: `MeetingSchedulingJob` sends cancellations for deleted
     * events it hasn't stamped, and this mailbox isn't the organizer, so it has nothing to send.
     */
    private async deleteReceivedEventCopy(row: CE): Promise<void> {
        const current: CE | undefined = await this.calendarEventRepo!.findOne(row.uid, { ignoreACL: true });
        if (current && !current.cancelNoticeSentAt) {
            await this.calendarEventRepo!.update(
                { uid: current.uid, version: (current as any).version, cancelNoticeSentAt: new Date() } as any,
                asEntity(this.calendarEventRepo!, current),
                { ignoreACL: true, skipPush: true },
            );
        }
        await this.calendarEventRepo!.delete(row.uid, { ignoreACL: true });
    }

    /** Applies an attendee's REPLY - only from that attendee themselves, and only to an attendee the event lists. */
    private async processItipReply(mailboxUid: string, parsed: ParsedIcsEvent, sender: string): Promise<void> {
        const existing = await this.findCalendarEventRow(mailboxUid, parsed.uid, parsed.recurrenceId);
        const replyingAttendee = parsed.attendees[0];
        if (!existing || !replyingAttendee?.partstat) {
            return;
        }
        if (normalizeAddress(replyingAttendee.address) !== sender) {
            this.logger?.warn(`ScanQueueJob: ignoring iTIP REPLY for event ${parsed.uid} - its sender isn't the attendee replying.`);
            return;
        }
        // RFC 5546 §2.1.5: a REPLY to an older revision of the event (lower SEQUENCE) is stale - applying it would
        // resurrect a response the attendee gave to a meeting that has since changed. Same-SEQUENCE replies are still
        // applied in arrival order: `parseIcsEvent()` doesn't expose DTSTAMP, and no per-attendee reply stamp is stored.
        if ((parsed.sequence ?? 0) < (existing.sequence ?? 0)) {
            this.logger?.info(`ScanQueueJob: ignoring stale iTIP REPLY for event ${parsed.uid} (SEQUENCE ${parsed.sequence} < ${existing.sequence}).`);
            return;
        }

        const attendees = existing.attendees.map((attendee) =>
            normalizeAddress(attendee.address) === sender ? { ...attendee, responseStatus: replyingAttendee.partstat! } : attendee,
        );
        await this.calendarEventRepo!.update(
            { uid: existing.uid, version: (existing as any).version, attendees } as any,
            asEntity(this.calendarEventRepo!, existing),
            { ignoreACL: true },
        );
    }

    /** Applies the organizer's CANCEL - only from the organizer on record for this mailbox's copy of the event. */
    private async processItipCancel(mailboxUid: string, parsed: ParsedIcsEvent, sender: string): Promise<void> {
        const rows: CE[] = await this.findCalendarEventRows(mailboxUid, parsed.uid);
        if (rows.length === 0) {
            return;
        }
        if (!this.isOrganizerOf(rows, sender)) {
            this.logger?.warn(`ScanQueueJob: ignoring iTIP CANCEL for event ${parsed.uid} - its sender isn't the event's organizer.`);
            return;
        }
        // A CANCEL for an older revision (lower SEQUENCE than the row it would cancel - the matching override, else the
        // master) is stale: the organizer has since re-sent the meeting, so it must not delete the current copy.
        const cancelled: CE | undefined =
            (parsed.recurrenceId ? rows.find((row) => recurrenceIdsMatch(row.recurrenceId, parsed.recurrenceId)) : undefined) ??
            rows.find((row) => !row.recurrenceId);
        if (cancelled && (parsed.sequence ?? 0) < (cancelled.sequence ?? 0)) {
            this.logger?.info(`ScanQueueJob: ignoring stale iTIP CANCEL for event ${parsed.uid} (SEQUENCE ${parsed.sequence} < ${cancelled.sequence}).`);
            return;
        }

        if (parsed.recurrenceId) {
            const override: CE | undefined = rows.find((row) => recurrenceIdsMatch(row.recurrenceId, parsed.recurrenceId));
            if (override) {
                await this.deleteReceivedEventCopy(override);
                return;
            }
            // No override row exists for this occurrence yet - drop it from the master's own recurrence
            // definition instead, the standard RFC 5545 way to exclude one occurrence from an otherwise-
            // unmodified series.
            const master: CE | undefined = rows.find((row) => !row.recurrenceId);
            if (master?.recurrenceRule) {
                const exceptions = [...(master.recurrenceRule.exceptions ?? []), parsed.recurrenceId];
                await this.calendarEventRepo!.update(
                    { uid: master.uid, version: (master as any).version, recurrenceRule: { ...master.recurrenceRule, exceptions } } as any,
                    asEntity(this.calendarEventRepo!, master),
                    { ignoreACL: true },
                );
            }
            return;
        }

        // No `recurrenceId` - cancelling the whole series: remove the master and every override row sharing
        // its `icalUid`.
        for (const row of rows) {
            await this.deleteReceivedEventCopy(row);
        }
    }
}
