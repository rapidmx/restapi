///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ApiErrorMessages,
    ApiErrors,
    DocDecorators,
    HttpRequest,
    HttpResponse,
    ModelUtils,
    RepoUtils,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { ScanPipeline } from "../scan/ScanPipeline.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { isNonOwnerAccess, recordAuditLog } from "../util/AuditLogUtils.js";
import { classifyRecipientTier, createFederatedPeerCheck, getVerifiedDomainNames } from "../util/DomainUtils.js";
import { findOrCreateWellKnownFolder, getMailboxUidForFolder } from "../util/FolderUtils.js";
import { findActiveHoldsFor } from "../util/LegalHoldUtils.js";
import { scanAndRelay } from "../util/MailSendUtils.js";
import { coerceDateValue } from "../util/DateCoercionUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { boundIndexedValue } from "../util/ConversationUtils.js";
import { checkOriginatorHeaders, extractHeader, prependHeaders, safeDisplayName } from "../util/MimeHeaderUtils.js";
import { isDuplicateKeyError } from "../util/RequestBodyUtils.js";
import { buildRapidMxKeyHeader } from "../util/RapidMxKeyHeaderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { buildDispositionNotification } from "../util/ReceiptUtils.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import {
    AuditAction,
    FocusedInboxOverride,
    FolderType,
    KeyVault,
    Mailbox,
    Message,
    MessageClassification,
    MessageFlags,
    MessageReceiptEntry,
    PublicKey,
    Recipient,
} from "../models/types.js";
const { Config, Inject } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Delete, Get, Param, Post, Put, Query, Request, Response, User: AuthUser } = RouteDecorators;

/** One row of `BaseMessageRoute.conversations()` - a computed summary over every `Message` sharing one
 * `conversationId`, never persisted on its own (see that method's own doc comment). */
export interface ConversationSummary {
    conversationId: string;
    /** The most recent message's subject line. */
    subject: string;
    /** Every message in this conversation, oldest to newest. */
    messageUids: string[];
    /** Every folder (deduped) this conversation has a message in - a conversation can span folders, e.g.
     * an Inbox message and the Sent Items copy of its reply. */
    folderUids: string[];
    messageCount: number;
    unreadCount: number;
    /** The most recent message's `receivedDate` - what conversations are sorted by (newest first). */
    latestDate: Date;
    /** Every distinct participant (deduped by lowercased address) across every message in the
     * conversation - the union of each message's `from` and `recipients`. */
    participants: Recipient[];
    /** `true` if any message in the conversation has an attachment. */
    hasAttachments: boolean;
}

/** `Message` fields only server-side code sets (ingest/scan, send, receipts, recall, indexing, compose). A non-trusted
 * caller's create/update never sets them - see `BaseScopedChildRoute.serverManagedFields`. The blob keys in particular
 * would otherwise let a caller point their message at any stored object (another mailbox's body or attachment) and
 * read it back through `content()`/raw download. `sentDate`/`receivedDate`/`dispositionNotificationTo` are handled
 * separately in `prepareCreate()`/`prepareUpdate()`. */
const SERVER_MANAGED_MESSAGE_FIELDS = [
    "bodyBlobKey",
    "sanitizedHtmlBlobKey",
    "encrypted",
    "scanResultUid",
    "searchIndexedAt",
    "recallRequestedAt",
    "receiptStatus",
    "readReceiptSentAt",
    "readReceiptPending",
    "readReceiptDeclined",
    "deliveryReceiptSentAt",
    "deliveryReceiptPending",
    "deliveryReceiptDeclined",
    // `SearchIndexJob`'s retry state.
    "searchIndexAttempts",
    "searchIndexNextAttemptAt",
    "searchIndexError",
    // `ScheduledSendJob`'s retry state and relay marker (`scheduledSendTime` itself is handled in `prepareUpdate()`).
    "scheduledSendAttempts",
    "scheduledSendError",
    "scheduledSendRelayedAt",
    "scheduledSendLeaseExpiresAt",
    // Derived from the message's `Attachment`s (`BaseAttachmentRoute`, ingest, import).
    "hasAttachments",
    // Superseded draft bodies kept under legal hold (`DraftBodyRetentionUtils`), appended by the compose route only.
    "retainedBodyBlobKeys",
    // Client-written, but only through `setVerificationSeal()` (generation-bound) - stripped for trusted callers too (see
    // `prepareCreate()`/`prepareUpdate()`).
    "verificationSeal",
    "verificationSealGeneration",
] as const;

/** The longest `Message.verificationSeal` `setVerificationSeal()` accepts, in characters. */
export const MAX_VERIFICATION_SEAL_LENGTH = 2048;

/** The characters a `Message.verificationSeal` may use: base64 and base64url, plus `.`/`:` separators. */
const VERIFICATION_SEAL_PATTERN = /^[A-Za-z0-9+/=_.:-]+$/;

/** Every top-level `Date` field of `Message` - coerced on create/update (see `BaseScopedChildRoute.dateFields`). */
const MESSAGE_DATE_FIELDS = [
    "sentDate",
    "receivedDate",
    "searchIndexedAt",
    "searchIndexNextAttemptAt",
    "scheduledSendTime",
    "scheduledSendRelayedAt",
    "scheduledSendLeaseExpiresAt",
    "recallRequestedAt",
    "deliveryReceiptSentAt",
    "readReceiptSentAt",
] as const;

/** Whether `message` has at least one To/Cc/Bcc recipient with an address - what a send needs for its envelope. */
function hasRecipients(message: Pick<Message, "recipients">): boolean {
    return (
        Array.isArray(message.recipients) &&
        message.recipients.some((recipient) => typeof recipient?.address === "string" && recipient.address.trim().length > 0)
    );
}

/** Parses a stored date that may come back as a `Date` or (Mongo) an ISO string; `undefined` if it isn't one. */
function toValidDate(value: unknown): Date | undefined {
    const date: Date | undefined =
        value instanceof Date ? value : typeof value === "string" || typeof value === "number" ? new Date(value) : undefined;
    return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

/** Builds one `ConversationSummary` from every `Message` sharing `conversationId`. */
function summarizeConversation(conversationId: string, messages: Message[]): ConversationSummary {
    const sorted = [...messages].sort((a, b) => a.receivedDate.getTime() - b.receivedDate.getTime());
    const latest = sorted[sorted.length - 1];

    const participantsByAddress = new Map<string, Recipient>();
    for (const message of sorted) {
        for (const participant of [message.from, ...message.recipients]) {
            const key = participant.address.toLowerCase();
            if (!participantsByAddress.has(key)) {
                participantsByAddress.set(key, participant);
            }
        }
    }

    return {
        conversationId,
        subject: latest.subject,
        messageUids: sorted.map((message) => message.uid),
        folderUids: [...new Set(sorted.map((message) => message.folderUid))],
        messageCount: sorted.length,
        unreadCount: sorted.filter((message) => !message.flags.read).length,
        latestDate: latest.receivedDate,
        participants: [...participantsByAddress.values()],
        hasAttachments: sorted.some((message) => message.hasAttachments),
    };
}

/**
 * Extends `BaseScopedChildRoute` (scoped by `folderUid` — see the architecture note on `Message.mailboxUid`)
 * with a `send` endpoint that composes, (re-)scans, and relays a drafted message via `MailTransport`, then
 * moves it into the mailbox's Sent Items folder. Ordinary `create`/`update`/`delete`/`find`/`findById`
 * (save-draft, edit-draft, discard-draft, list, fetch) are handled entirely by the base class — this is the
 * only mail-specific behavior a `Message` needs beyond scoped CRUD.
 *
 * `folderClass` is supplied by the Mongo/SQL concrete subclasses so this class can look up (and, if needed,
 * create) the mailbox's Sent Items folder without depending on either backend directly.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMessageRoute<T extends Message> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "folderUid";

    protected readonly serverManagedFields: readonly string[] = SERVER_MANAGED_MESSAGE_FIELDS;

    protected readonly dateFields: readonly string[] = MESSAGE_DATE_FIELDS;

    protected abstract folderClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `delete()`/`recall()` can persist an
     * `AuditLogEntry` without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `classify()` can record an "always put this
     * sender in Focused/Other" instruction without depending on either backend directly. */
    protected abstract focusedInboxOverrideClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `send()`/the read-receipt trigger can read the
     * sending/recipient mailbox's own receipt settings without depending on either backend directly. */
    protected abstract mailboxClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `classifyRecipientTier()` can classify a receipt
     * request's recipient/requester without depending on either backend directly - same field
     * `ScanQueueJob`/`BaseMailIngestRoute` already carry for the identical purpose. */
    protected abstract domainClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `checkLegalHold()` can resolve an active `Matter`
     * without depending on either backend directly - see `util/LegalHoldUtils.ts`. */
    protected abstract matterClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `setVerificationSeal()` can read the mailbox's `KeyVault`
     * master key generation without depending on either backend directly. */
    protected abstract keyVaultClass: any;

    private keyVaultRepo?: RepoUtils<KeyVault>;

    private folderRepo?: RecoverableRepoUtils<any>;

    private focusedInboxOverrideRepo?: RepoUtils<FocusedInboxOverride>;

    private mailboxRepo?: RepoUtils<Mailbox>;

    /** This server's own inbound mail-exchange hostname, reused as the `Reporting-UA` half of a generated
     * receipt MDN - same config `ScanQueueJob`/`BaseDomainRoute` already read. */
    @Config("mail:dns:mx_hostname", "")
    private mxHostname: string = "";

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject("MailTransport")
    private mailTransport?: any;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    /** Backs the real federated-peer check `classifyRecipientTier()` calls (`util/DomainUtils.ts`'s
     * `createFederatedPeerCheck()`) - same DI token `BaseDomainRoute`/`DomainVerificationJob` already
     * register/consume, so every deployment and test environment already has one. */
    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

    /** Safety-net cap on how many of a mailbox's messages `conversations()` scans to build its groups - see
     * that method's own doc comment for why there's no query-time group-by to rely on instead. */
    @Config("mail:conversations:scan_limit", 500)
    private conversationScanLimit: number = 500;

    /** How long an immediate send's claim (`scheduledSendLeaseExpiresAt`) keeps the message in Outbox - the same setting
     * `ScheduledSendJob` leases its own claims for. Must comfortably exceed a relay's worst-case duration. */
    @Config("mail:jobs:scheduled_send:lease_ms", 900_000)
    private sendLeaseMs: number = 900_000;

    private async getFolderRepo(): Promise<RecoverableRepoUtils<any>> {
        if (!this.folderRepo) {
            this.folderRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                name: this.folderClass.name,
                args: [this.folderClass],
            });
        }
        return this.folderRepo;
    }

    private async getFocusedInboxOverrideRepo(): Promise<RepoUtils<FocusedInboxOverride>> {
        if (!this.focusedInboxOverrideRepo) {
            this.focusedInboxOverrideRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.focusedInboxOverrideClass.name,
                args: [this.focusedInboxOverrideClass],
            });
        }
        return this.focusedInboxOverrideRepo;
    }

    private async getMailboxRepo(): Promise<RepoUtils<Mailbox>> {
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        return this.mailboxRepo;
    }

    /** Every caller passes a folder uid that already passed a permission check, so it's always a real string. */
    private async folderTypeOf(folderUid: string): Promise<FolderType | undefined> {
        const folder: any = await (await this.getFolderRepo()).findOne(folderUid, { ignoreACL: true });
        return folder?.type;
    }

    private async isDraftsFolder(folderUid: string): Promise<boolean> {
        return (await this.folderTypeOf(folderUid)) === FolderType.DRAFTS;
    }

    /** Refused (403): only `send()` puts a message in Outbox, after checking its sender - `ScheduledSendJob` relays
     * whatever it finds there. */
    private static outboxRefusal(): ApiError {
        return new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Messages are only queued in Outbox by sending them.");
    }

    /**
     * Beyond `SERVER_MANAGED_MESSAGE_FIELDS`, a non-trusted caller may only set `sentDate`/`receivedDate` and
     * `dispositionNotificationTo` when creating a draft (target folder is Drafts). Dates on anything else are the
     * server's (`now`, the model default): `checkLegalHold()` scopes a hold by them, so a client-chosen date would take
     * a message out of a hold's range. A non-trusted create never schedules a send or lands in Outbox.
     */
    protected async prepareCreate(obj: any, user: JWTUser | undefined): Promise<void> {
        await super.prepareCreate(obj, user);
        // Never from a create or update body, trusted callers included: a seal is only ever written once, by
        // `setVerificationSeal()`.
        delete obj.verificationSeal;
        delete obj.verificationSealGeneration;
        if (this.isTrusted(user)) {
            return;
        }
        delete obj.scheduledSendTime;
        const folderType: FolderType | undefined = await this.folderTypeOf(obj.folderUid);
        if (folderType === FolderType.OUTBOX) {
            throw BaseMessageRoute.outboxRefusal();
        }
        if (folderType === FolderType.DRAFTS) {
            return;
        }
        delete obj.sentDate;
        delete obj.receivedDate;
        delete obj.dispositionNotificationTo;
    }

    /**
     * A non-trusted update never changes `sentDate`/`receivedDate` (a draft's dates are the compose/send path's, which
     * writes through the repository directly) - otherwise a held message could be re-dated out of its hold's range,
     * or moved to Drafts, re-dated and moved back. `dispositionNotificationTo` stays settable on a message currently
     * in Drafts only.
     */
    //
    // For every caller, trusted included: `verificationSeal`/`verificationSealGeneration` are dropped (see
    // `setVerificationSeal()`), `messageId`/`conversationId` are bounded (`boundIndexedValue()`) - an update is written as a patch without the model constructor that normally bounds them, and an over-long value would fail the
    // write on MySQL/MariaDB - and a message whose send is in flight can't leave Outbox (`assertNotInFlight()`).
    protected async prepareUpdate(obj: any, existing: T, user: JWTUser | undefined): Promise<void> {
        await super.prepareUpdate(obj, existing, user);
        delete obj.verificationSeal;
        delete obj.verificationSealGeneration;
        for (const field of ["messageId", "conversationId"]) {
            if (typeof obj[field] === "string") {
                obj[field] = boundIndexedValue(obj[field]);
            }
        }
        if (typeof obj.folderUid === "string" && obj.folderUid !== existing.folderUid) {
            BaseMessageRoute.assertNotInFlight(existing);
        }
        if (this.isTrusted(user)) {
            return;
        }
        delete obj.sentDate;
        delete obj.receivedDate;
        if ("dispositionNotificationTo" in obj && !(await this.isDraftsFolder(existing.folderUid))) {
            delete obj.dispositionNotificationTo;
        }
        await this.prepareScheduledSendUpdate(obj, existing);
    }

    /**
     * `scheduledSendTime` and Outbox membership are the send path's: `send()` checks the sender, then schedules. A
     * non-trusted update:
     * - can't set `scheduledSendTime` (400 when it would change it; an unchanged or `null` value is dropped, so a
     * round-tripped object still saves);
     * - can't move a message into Outbox (403);
     * - can't move a message into Drafts unless it's already in Drafts or is in Outbox (403): a message in Drafts can be
     * re-assembled (body, subject, recipients rewritten) by the compose route, and a Sent Items copy carries nothing
     * that tells it apart from a real draft, so a sent or received message moved there could be rewritten and moved
     * back, forging mail history (a held custodian's included). Outbox -> Drafts is how a scheduled send is cancelled;
     * it's allowed for what `send()` queues (non-trusted callers can only send from Drafts), not for a delivered message
     * (`scanResultUid`) a mail filter rule filed into Outbox. activesync's `MessageMoveRules` refuses the same moves;
     * - moving a message out of Outbox cancels its scheduled send (the server clears `scheduledSendTime` and the job's
     * retry state) - refused (409) once the message was already relayed and only its filing is pending, and (for any
     * caller, see `prepareUpdate()`) while a send of it is in flight.
     */
    private async prepareScheduledSendUpdate(obj: any, existing: T): Promise<void> {
        if ("scheduledSendTime" in obj) {
            const requested: Date | undefined = toValidDate(obj.scheduledSendTime);
            const current: Date | undefined = toValidDate(existing.scheduledSendTime);
            if (requested && requested.getTime() !== current?.getTime()) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'scheduledSendTime' is set by sending the message (POST /:id/send).");
            }
            delete obj.scheduledSendTime;
        }
        const targetFolderUid: unknown = obj.folderUid;
        if (typeof targetFolderUid !== "string" || targetFolderUid === existing.folderUid) {
            return;
        }
        const targetType: FolderType | undefined = await this.folderTypeOf(targetFolderUid);
        if (targetType === FolderType.OUTBOX) {
            throw BaseMessageRoute.outboxRefusal();
        }
        const sourceType: FolderType | undefined = await this.folderTypeOf(existing.folderUid);
        // Out of Outbox, only a message a send put there: `send()` only queues drafts (for non-trusted callers), while a
        // delivered message (`scanResultUid`) can land in Outbox through a mail filter rule and must not reach Drafts.
        const cancellingSend: boolean = sourceType === FolderType.OUTBOX && !(existing as any).scanResultUid;
        if (targetType === FolderType.DRAFTS && sourceType !== FolderType.DRAFTS && !cancellingSend) {
            throw new ApiError(
                ApiErrors.AUTH_PERMISSION_FAILURE,
                403,
                "Only a draft, or a message taken back out of Outbox, can be moved into Drafts.",
            );
        }
        if (sourceType === FolderType.OUTBOX) {
            if ((existing as any).scheduledSendRelayedAt) {
                throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "This message has already been sent.");
            }
            obj.scheduledSendTime = null;
            obj.scheduledSendAttempts = null;
            obj.scheduledSendError = null;
            obj.scheduledSendLeaseExpiresAt = null;
        }
    }

    /**
     * Refuses (409) to move a message whose send is in flight - claimed for relay by `send()` or `ScheduledSendJob`, its
     * `scheduledSendLeaseExpiresAt` still in the future. Moving it to Drafts would let the user send it again while the
     * first relay is still running (and the claimed send would later file it into Sent Items anyway). Once the lease has
     * lapsed (a crashed relay), the move is allowed again.
     */
    private static assertNotInFlight(existing: Message): void {
        const lease: Date | undefined = toValidDate((existing as any).scheduledSendLeaseExpiresAt);
        if (lease && lease.getTime() > Date.now()) {
            throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "This message is being sent right now.");
        }
    }

    /**
     * Refuses (403) a send/recall whose sender isn't the sending mailbox: `from.address` - and every address in the
     * composed source's own `From` header, when there is one - must be the mailbox's primary address or one of its
     * aliases. `from` is ordinary draft data, and it becomes the envelope sender, so without this any caller with
     * write access to one mailbox could send as any address at all.
     */
    //
    // With `raw`, the composed source's originator headers are checked too (`checkOriginatorHeaders()`): exactly one
    // `From`, at most one `Sender`, every address in them (group members included) the mailbox's own, no address-like
    // text outside an address, and no address in a display name or comment.
    private assertSenderAllowed(mailbox: Mailbox | undefined, message: T, raw?: Buffer): void {
        const allowed: Set<string> = new Set(
            mailbox ? [mailbox.primarySmtpAddress, ...(mailbox.aliasAddresses ?? [])].filter((a) => typeof a === "string").map(normalizeAddress) : [],
        );
        const isAllowed = (address: unknown): boolean => typeof address === "string" && allowed.has(normalizeAddress(address));
        const refused: boolean =
            !isAllowed(message.from?.address) ||
            (raw !== undefined && checkOriginatorHeaders(raw, isAllowed, { rejectAddressLikeDisplayNames: true }) !== undefined);
        if (refused) {
            throw new ApiError(
                ApiErrors.AUTH_PERMISSION_FAILURE,
                403,
                "A message can only be sent from its mailbox's own address or one of its aliases.",
            );
        }
    }

    /**
     * Composes and relays one real RFC 3798 MDN via `util/ReceiptUtils.ts`'s `buildDispositionNotification()`
     * - the exact same shape `ScanQueueJob.sendDispositionNotification()` uses for the automatic path; this
     * route's own copy is used by `approveReceipt()`, where the mailbox owner is explicitly acting on a
     * receipt `ScanQueueJob` originally left pending. Returns whether the send actually succeeded.
     */
    private async sendDispositionNotification(
        dispositionNotificationTo: string,
        mailbox: Mailbox,
        originalMessageId: string,
        originalSubject: string,
        dispositionType: "read" | "delivery",
    ): Promise<boolean> {
        try {
            const composed: Buffer = await buildDispositionNotification({
                from: { address: mailbox.primarySmtpAddress, displayName: safeDisplayName(mailbox.displayName) },
                to: dispositionNotificationTo,
                subject: `${dispositionType === "read" ? "Read" : "Delivered"}: ${originalSubject}`,
                finalRecipient: mailbox.primarySmtpAddress,
                originalMessageId,
                dispositionType,
                reportingUa: `${this.mxHostname}; RapidMX`,
            });
            await this.mailTransport!.send({
                raw: composed,
                envelopeFrom: mailbox.primarySmtpAddress,
                envelopeTo: [dispositionNotificationTo],
            });
            return true;
        } catch (err: any) {
            this.logger?.warn(`BaseMessageRoute: failed to send ${dispositionType} receipt for mailbox ${mailbox.uid}: ${err.message}`);
            return false;
        }
    }

    /**
     * Groups this mailbox's messages into conversations (RFC 5322 References/In-Reply-To threading, via
     * `Message.conversationId`) - one summary row per conversation spanning every folder in the mailbox,
     * newest activity first. Mirrors `BaseFolderRoute.find()`'s own one-mailbox-level-check shape (a
     * single `ACLAction.LIST` check against `mailboxUid` itself, then an `ignoreACL: true` query) rather
     * than this route's own base class's folder-scoped `find()` - that is this codebase's own established
     * pattern for "list this mailbox's children in one call" (see `BaseFolderRoute.find()`'s own doc
     * comment), and `Message.mailboxUid` is already denormalized for exactly this kind of whole-mailbox
     * scan.
     *
     * Grouping happens in application code over one capped `find()` - there is no query-time group-by/
     * aggregation available across both backends this library supports (`RepoUtils` has none, and Mongo's
     * own raw `aggregate()` escape hatch has no SQL equivalent) - so a mailbox busier than
     * `conversationScanLimit` messages will not group its oldest messages correctly.
     */
    @Summary("List conversations")
    @Description(
        "Groups this mailbox's messages into conversations (RFC 5322 References/In-Reply-To threading), " +
            "one summary row per conversation spanning every folder, newest activity first. Scans at most " +
            "conversationScanLimit messages in the mailbox - a mailbox busier than that will not group its " +
            "oldest messages correctly.",
    )
    @Returns([Object])
    @Get("/conversations")
    public async conversations(@Query() query: any, @AuthUser user?: JWTUser): Promise<ConversationSummary[]> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const mailboxUid: string | undefined = query?.mailboxUid;
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        if (!(await this.aclUtils!.hasPermission(user, mailboxUid, ACLAction.LIST))) {
            return [];
        }

        const messages: T[] = await this.repoUtils.find(
            { mailboxUid, limit: this.conversationScanLimit } as any,
            { limit: this.conversationScanLimit, ignoreACL: true },
        );

        const groups = new Map<string, T[]>();
        for (const message of messages) {
            const key = message.conversationId ?? message.uid;
            const existing = groups.get(key);
            if (existing) {
                existing.push(message);
            } else {
                groups.set(key, [message]);
            }
        }

        const summaries: ConversationSummary[] = [...groups.entries()].map(([conversationId, group]) =>
            summarizeConversation(conversationId, group),
        );
        summaries.sort((a, b) => b.latestDate.getTime() - a.latestDate.getTime());
        return summaries;
    }

    /**
     * Sends a draft now, or - with a future `scheduledSendTime` in the body (or already stored on the message by
     * server-side code) - queues it in Outbox for `ScheduledSendJob`. Either way the sender (`from.address` and the
     * composed source's `From`/`Sender` headers) is checked first.
     *
     * An immediate send is claimed before anything is relayed: a version-checked move into Outbox (with no
     * `scheduledSendTime`, so the job leaves it alone) carrying an in-flight lease (`scheduledSendLeaseExpiresAt`,
     * `mail:jobs:scheduled_send:lease_ms`), which only one of two concurrent sends can win and which keeps the message
     * from being moved out of Outbox (409) until it's filed or the lease lapses. A message already in Outbox
     * (scheduled, or claimed by an in-flight send) is refused (409) - move it back to Drafts first. A failed relay moves
     * it back where it was. `scheduledSendRelayedAt` is persisted the moment the transport accepts; a relay that
     * succeeded but couldn't be filed into Sent Items is made due, so `ScheduledSendJob` only finishes the filing and
     * never relays it again. Filing only happens while the message is still in Outbox under this send's claim.
     */
    @Summary("Send message")
    @Description(
        "Scans and relays a drafted message via the configured MailTransport, then moves it into the " +
            "mailbox's Sent Items folder. A future scheduledSendTime in the body queues it in Outbox instead.",
    )
    @Returns([Object])
    @Post("/:id/send")
    public async send(
        @Param("id") id: string,
        body: { scheduledSendTime?: string | null } | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        if (!this.repoUtils || !this.blobStore || !this.mailTransport || !this.scanPipeline) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const message: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true, skipCache: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        const requestedSendTime: Date | undefined = coerceDateValue((body as any)?.scheduledSendTime, "scheduledSendTime") || undefined;

        const folderRepo: RecoverableRepoUtils<any> = await this.getFolderRepo();
        const currentFolderType: FolderType | undefined = await this.folderTypeOf(message.folderUid);
        if ((message as any).scheduledSendRelayedAt || currentFolderType === FolderType.SENT_ITEMS) {
            throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "This message has already been sent.");
        }
        if (currentFolderType === FolderType.OUTBOX) {
            throw new ApiError(
                ApiErrors.INVALID_OBJECT_VERSION,
                409,
                "This message is already queued for sending. Move it back to Drafts to change or resend it.",
            );
        }
        // Only a draft is sent (scheduled or now). Otherwise a sent or received message moved out of Sent Items/Inbox could
        // be "scheduled" into Outbox, taken back to Drafts (the scheduled-send cancel path), re-assembled by the compose
        // route and moved back - rewriting mail history, a held custodian's included. Trusted callers are exempt, like
        // the Drafts/Outbox move rules in `prepareScheduledSendUpdate()`.
        if (!this.isTrusted(user) && currentFolderType !== FolderType.DRAFTS) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Only a message in Drafts can be sent.");
        }

        // Drafts may be saved with no recipients at all; sending one is refused here, before any claim, so it stays
        // where it is (and a scheduled send is never queued only to fail in `ScheduledSendJob`).
        if (!hasRecipients(message)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A message needs at least one To, Cc or Bcc recipient to be sent.");
        }

        const sendingMailbox: Mailbox | undefined = await (await this.getMailboxRepo()).findOne(message.mailboxUid, {
            ignoreACL: true,
        });
        this.assertSenderAllowed(sendingMailbox, message);

        // The message's `bodyBlobKey` already holds the fully composed RFC 5322 source (assembled by the
        // webmail compose UI, or an EAS/MAPI "send" handler, before this endpoint is called) — this route's
        // job is scanning and relay, not MIME composition. Its originator headers are checked before a scheduled send
        // is queued too - `ScheduledSendJob` relays these same bytes.
        let raw: Buffer = await this.blobStore.get(message.bodyBlobKey);
        this.assertSenderAllowed(sendingMailbox, message, raw);

        // "Do not deliver before" (`PR_DEFERRED_SEND_TIME`) - a future `scheduledSendTime` defers relay instead of
        // sending now. The message sits in the mailbox's Outbox folder until `ScheduledSendJob` relays it; moving it
        // back out of Outbox (e.g. to Drafts) cancels it.
        const scheduledSendTime: Date | undefined = requestedSendTime ?? toValidDate(message.scheduledSendTime);
        if (scheduledSendTime && scheduledSendTime.getTime() > Date.now()) {
            const outbox: any = await findOrCreateWellKnownFolder(folderRepo, this.folderClass, message.mailboxUid, FolderType.OUTBOX, user);
            return await this.repoUtils.update(
                {
                    uid: message.uid,
                    version: (message as any).version,
                    folderUid: outbox.uid,
                    scheduledSendTime,
                    scheduledSendAttempts: null,
                    scheduledSendError: null,
                    scheduledSendLeaseExpiresAt: null,
                } as any,
                message,
                { user, ignoreACL: true },
            );
        }

        const envelopeTo: string[] = message.recipients.map((r) => r.address);

        // A receipt request is a single message-level header - RFC 3798 has no "only notify me for these
        // recipients" concept, every recipient's own system independently decides whether to honor it - so
        // the rule is "attach it if it applies to *any* recipient": each recipient is classified by
        // `classifyRecipientTier()` (`util/DomainUtils.ts` - same-org/federated/external), and an explicit
        // per-draft `message.requestReceipt` overrides all three of the sending mailbox's own
        // `alwaysRequestReceipt*` defaults at once when set.
        let attachesReceiptRequest = false;
        if (sendingMailbox) {
            const effectiveInternal: boolean = message.requestReceipt ?? sendingMailbox.alwaysRequestReceiptInternal;
            const effectiveFederated: boolean = message.requestReceipt ?? sendingMailbox.alwaysRequestReceiptFederated;
            const effectiveExternal: boolean = message.requestReceipt ?? sendingMailbox.alwaysRequestReceiptExternal;
            if (effectiveInternal || effectiveFederated || effectiveExternal) {
                // Fetched once and passed to every `classifyRecipientTier()` call below (`verifiedDomainNames`)
                // rather than each iteration independently re-querying "this server's domains" from scratch -
                // a message to N recipients previously cost N sequential `Domain` queries, all inside this
                // HTTP request, before the message was even handed off for relay. The per-recipient DNS
                // federated-peer checks are independent of each other, so they run concurrently
                // (`Promise.all`) instead of a sequential loop - `resolveFederationPolicy()` already caches
                // per domain, so this also collapses to one real lookup per distinct cold domain rather than
                // one per recipient.
                const verifiedDomainNames: string[] = await getVerifiedDomainNames(this._objectFactory!, this.domainClass);
                const federatedPeerCheck = createFederatedPeerCheck(this.dnsResolver!);
                const tiers = await Promise.all(
                    envelopeTo.map((address) =>
                        classifyRecipientTier(this._objectFactory!, this.domainClass, address, federatedPeerCheck, verifiedDomainNames),
                    ),
                );
                attachesReceiptRequest = tiers.some(
                    (tier) =>
                        (tier === "same-org" && effectiveInternal) ||
                        (tier === "federated" && effectiveFederated) ||
                        (tier === "external" && effectiveExternal),
                );
            }
        }
        if (attachesReceiptRequest) {
            raw = prependHeaders(raw, [{ name: "Disposition-Notification-To", value: message.from.address }]);
        }

        // Announces the sending mailbox's current encryption key (C2) to the recipient, mirroring the
        // Disposition-Notification-To attachment above - the Autocrypt-style opportunistic-discovery half of
        // the protocol (E3 is the inbound counterpart). Only the active (non-revoked, non-expired) "encrypt"
        // key is ever announced - a revoked/expired one would be actively harmful advice to a recipient.
        // `?? []`: defense in depth against a legacy row whose SQL `keys` column was backfilled to `null`
        // rather than the column's own default (e.g. a migration applied outside this ORM) - the documented
        // "SQL returns `null`, not `undefined`, for an unset column" hazard this codebase already guards
        // against elsewhere (see `ScanQueueJob`'s own note on the same class of issue).
        const activeEncryptKey: PublicKey | undefined = (sendingMailbox?.keys ?? []).find(
            (k) => k.useType === "encrypt" && !k.revokedAt && k.notAfter > Date.now(),
        );
        if (activeEncryptKey) {
            raw = prependHeaders(raw, [
                {
                    name: "RapidMX-Key",
                    value: buildRapidMxKeyHeader(
                        message.from.address,
                        // `?? {...}`: same legacy-SQL-row `null` hazard as `keys` above.
                        (sendingMailbox!.encryptPreference ?? { preferEncrypt: "nopreference" }).preferEncrypt,
                        activeEncryptKey,
                    ),
                },
            ]);
        }

        // Claim: a version-checked move into Outbox carrying an in-flight lease (`scheduledSendLeaseExpiresAt`) and no
        // `scheduledSendTime`, so `ScheduledSendJob` ignores it. Of two concurrent sends only one gets past this, and while
        // the lease lasts the message can't be moved back out of Outbox (`assertNotInFlight()`) and sent again.
        const outbox: any = await findOrCreateWellKnownFolder(folderRepo, this.folderClass, message.mailboxUid, FolderType.OUTBOX, user);
        const leaseExpiresAt: Date = new Date(Date.now() + Number(this.sendLeaseMs));
        const claimed: T = await this.repoUtils.update(
            {
                uid: message.uid,
                version: (message as any).version,
                folderUid: outbox.uid,
                scheduledSendTime: null,
                scheduledSendLeaseExpiresAt: leaseExpiresAt,
            } as any,
            message,
            { user, ignoreACL: true },
        );
        const {
            raw: relayedRaw,
            messageId,
            conversationId,
            sanitizedHtmlBlobKey: scannedHtmlBlobKey,
            encrypted,
        } = await this.relayClaimed(claimed, message.folderUid, raw, envelopeTo);
        try {
            return await this.fileSentMessage(message, claimed, user, raw, relayedRaw, attachesReceiptRequest, envelopeTo, {
                messageId,
                conversationId,
                scannedHtmlBlobKey,
                encrypted,
            });
            /* v8 ignore start -- only a blob store/database failure after a successful relay */
        } catch (err) {
            await this.markRelayed(claimed, { messageId, conversationId });
            throw err;
        }
        /* v8 ignore stop */
    }

    /** Whether `current` is still in the Outbox `claimed` was claimed in, carrying the lease that claim wrote. */
    private static stillClaimed(current: Message, claimed: Message): boolean {
        const lease = (row: Message): number | undefined => toValidDate((row as any).scheduledSendLeaseExpiresAt)?.getTime();
        return current.folderUid === claimed.folderUid && lease(claimed) !== undefined && lease(current) === lease(claimed);
    }

    /** Files a message `send()` just relayed into Sent Items - only while `send()`'s claim still stands (the message is
     * still in Outbox carrying the claim's lease); otherwise nothing is written and the message is returned as it is. */
    private async fileSentMessage(
        message: T,
        claimed: T,
        user: JWTUser | undefined,
        raw: Buffer,
        relayedRaw: Buffer,
        attachesReceiptRequest: boolean,
        envelopeTo: string[],
        relay: { messageId: string; conversationId: string; scannedHtmlBlobKey?: string; encrypted: boolean },
    ): Promise<T> {
        const { messageId, conversationId, scannedHtmlBlobKey, encrypted } = relay;
        // Re-read: the relay can take a while, and an unrelated write (e.g. a flag change) must not fail the filing.
        const current: T = (await this.repoUtils!.findOne(message.uid, { ignoreACL: true, skipCache: true }))!;
        /* v8 ignore start -- only a lapsed lease (a relay slower than lease_ms) or a trusted caller's move */
        if (!current || !BaseMessageRoute.stillClaimed(current, claimed)) {
            this.logger?.warn(`BaseMessageRoute: not filing message ${message.uid} - it is no longer in Outbox under this send's claim.`);
            return current ?? claimed;
        }
        /* v8 ignore stop */
        if (relayedRaw !== raw) {
            // `scanAndRelay()` injected a `Message-ID` this draft didn't already have - persist the augmented
            // bytes so a later read (and any future `recall()` of this very message) sees the same header it
            // was actually relayed with.
            await this.blobStore!.put(message.bodyBlobKey, relayedRaw, { contentType: "message/rfc822" });
        }

        const folderRepo: RecoverableRepoUtils<any> = await this.getFolderRepo();
        const sentFolder: any = await findOrCreateWellKnownFolder(
            folderRepo,
            this.folderClass,
            message.mailboxUid,
            FolderType.SENT_ITEMS,
            user,
        );
        const flags: MessageFlags = { ...current.flags, read: true };
        // `scanAndRelay()` only stores a new blob when this send pass actually produced sanitized HTML - a
        // message with no HTML body at all keeps whatever `sanitizedHtmlBlobKey` it already had (absent, for a
        // freshly composed draft).
        const sanitizedHtmlBlobKey: string | undefined = scannedHtmlBlobKey ?? (message as any).sanitizedHtmlBlobKey;
        // Seeded only when a receipt was actually requested - nothing could ever populate it otherwise. One
        // placeholder row per *distinct* recipient (including a `DistributionList`'s own address as-is - see
        // `processReceipt()`'s own doc comment for why its expanded members can only ever be discovered
        // later, as their own real MDNs arrive, not predicted here) - deduplicated by normalized address so a
        // recipient appearing twice (e.g. a case-variant duplicate across To/Cc) doesn't seed two rows that
        // `processReceipt()`'s `findIndex()` could only ever update the first of.
        let receiptStatus: MessageReceiptEntry[] | undefined;
        if (attachesReceiptRequest) {
            const seenAddresses: Set<string> = new Set();
            receiptStatus = [];
            for (const address of envelopeTo) {
                const normalized: string = normalizeAddress(address);
                if (!seenAddresses.has(normalized)) {
                    seenAddresses.add(normalized);
                    receiptStatus.push({ recipientAddress: normalized });
                }
            }
        }

        // `messageId`/`conversationId` come from the relayed MIME and are written as a patch (no model constructor), so
        // they are bounded here - see `boundIndexedValue()`.
        return await this.repoUtils!.update(
            {
                uid: message.uid,
                version: (current as any).version,
                folderUid: sentFolder.uid,
                flags,
                sanitizedHtmlBlobKey,
                messageId: boundIndexedValue(messageId),
                conversationId: boundIndexedValue(conversationId),
                receiptStatus,
                encrypted,
                scheduledSendTime: null,
                scheduledSendLeaseExpiresAt: null,
                scheduledSendRelayedAt: null,
            } as any,
            current,
            { user, ignoreACL: true },
        );
    }

    /**
     * Relays a message `send()` has claimed. Before the transport accepts it, any failure (building the receipt/key
     * headers happens before this, scanning in here) moves the message back to `originalFolderUid` - an ordinary
     * failed send. The moment the transport accepts it, `scheduledSendRelayedAt` is persisted on its own
     * (`recordRelayed()`), before any other write; a failure after that marks it relayed and due (`markRelayed()`)
     * instead, so it is never sent twice.
     */
    private async relayClaimed(claimed: T, originalFolderUid: string, raw: Buffer, envelopeTo: string[]) {
        let accepted: boolean = false;
        const trackingTransport = {
            send: async (outbound: any) => {
                const result: any = await this.mailTransport.send(outbound);
                if (result.accepted.length > 0) {
                    accepted = true;
                    await this.recordRelayed(claimed);
                }
                return result;
            },
        };
        try {
            return await scanAndRelay(raw, claimed.from.address, envelopeTo, this.scanPipeline!, trackingTransport, this.blobStore!);
        } catch (err) {
            /* v8 ignore start -- only a blob store failure after the transport accepted the message */
            if (accepted) {
                await this.markRelayed(claimed, { messageId: extractHeader(raw, "Message-ID")?.replace(/^<|>$/g, "") });
                throw err;
            }
            /* v8 ignore stop */
            await this.releaseClaim(claimed, originalFolderUid);
            throw err;
        }
    }

    /**
     * Persists `scheduledSendRelayedAt` on its own, the moment the transport accepted `claimed` - one minimal
     * version-checked write (re-read and retried when an unrelated write bumped the version first), so nothing else in a
     * later write (an over-long header value, a blob store failure) can keep the marker from landing. Best-effort
     * (logged); `markRelayed()` stamps it again if filing fails.
     *
     * The same write makes the message due for `ScheduledSendJob` once the claim's lease lapses (`scheduledSendTime` =
     * the lease expiry, not now, so the job doesn't take over a filing this request is still doing): if the process
     * dies before filing, the job finishes it instead of the message sitting relayed in Outbox forever. The re-read
     * includes soft-deleted rows, so the marker still lands on a message deleted mid-relay (and it can't be sent again
     * after a restore).
     */
    private async recordRelayed(claimed: T): Promise<void> {
        const dueAt: Date = toValidDate((claimed as any).scheduledSendLeaseExpiresAt) ?? new Date();
        let current: T | undefined = claimed;
        for (let attempt = 1; current && attempt <= 3; attempt++) {
            /* v8 ignore next 3 -- only a concurrent writer that already stamped it */
            if ((current as any).scheduledSendRelayedAt) {
                return;
            }
            try {
                await this.repoUtils!.update(
                    { uid: current.uid, version: (current as any).version, scheduledSendRelayedAt: new Date(), scheduledSendTime: dueAt } as any,
                    current,
                    { ignoreACL: true },
                );
                return;
            } catch (err: any) {
                this.logger?.warn(`BaseMessageRoute: failed to record the relay of message ${claimed.uid} (attempt ${attempt}): ${err.message}`);
                current = attempt < 3 ? await this.repoUtils!.findOne(claimed.uid, { ignoreACL: true, skipCache: true, includeDeleted: true }) : undefined;
            }
        }
    }

    /** Moves a claimed-but-unsent message back to where it was (releasing its lease), unless something moved it
     * meanwhile. Best-effort (logged). */
    private async releaseClaim(claimed: T, originalFolderUid: string): Promise<void> {
        try {
            const current: T = (await this.repoUtils!.findOne(claimed.uid, { ignoreACL: true, skipCache: true }))!;
            /* v8 ignore if -- only a concurrent move of the message during its relay */
            if (current.folderUid !== claimed.folderUid) {
                return;
            }
            await this.repoUtils!.update(
                { uid: current.uid, version: (current as any).version, folderUid: originalFolderUid, scheduledSendLeaseExpiresAt: null } as any,
                current,
                { ignoreACL: true },
            );
            /* v8 ignore start -- only a concurrent write or database failure */
        } catch (err: any) {
            this.logger?.warn(`BaseMessageRoute: failed to release the send claim on message ${claimed.uid}: ${err.message}`);
        }
        /* v8 ignore stop */
    }

    /** Records that a message was relayed but not filed: `scheduledSendRelayedAt`, the claim's lease released and - while
     * it's still in the Outbox it was claimed in - a due `scheduledSendTime`, so `ScheduledSendJob` finishes the filing
     * without relaying again. Values from the relayed MIME are bounded (`boundIndexedValue()`). Best-effort (logged). */
    /* v8 ignore start -- reached only when filing fails after a successful relay */
    private async markRelayed(claimed: T, fields: { messageId?: string; conversationId?: string }): Promise<void> {
        const uid: string = claimed.uid;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const current: T | undefined = await this.repoUtils!.findOne(uid, { ignoreACL: true, skipCache: true, includeDeleted: true });
                if (!current) {
                    return;
                }
                const inOutbox: boolean = current.folderUid === claimed.folderUid;
                await this.repoUtils!.update(
                    {
                        uid,
                        version: (current as any).version,
                        ...(fields.messageId !== undefined ? { messageId: boundIndexedValue(fields.messageId) } : {}),
                        ...(fields.conversationId !== undefined ? { conversationId: boundIndexedValue(fields.conversationId) } : {}),
                        scheduledSendRelayedAt: (current as any).scheduledSendRelayedAt ?? new Date(),
                        ...(inOutbox ? { scheduledSendTime: new Date(), scheduledSendLeaseExpiresAt: null } : {}),
                    } as any,
                    current,
                    { ignoreACL: true },
                );
                return;
            } catch (err: any) {
                this.logger?.warn(`BaseMessageRoute: failed to record the relay of message ${uid}: ${err.message}`);
            }
        }
    }
    /* v8 ignore stop */

    /**
     * Attempts to recall a message this mailbox previously sent — Exchange/Outlook's "Recall This Message" —
     * by composing and relaying a small control message, carrying `message.messageId` in a custom
     * `X-RapidMX-Recall-Of` header, to every original recipient. This is asynchronous and best-effort by
     * necessity: there is no direct link between this mailbox's Sent Items copy and a recipient's own Inbox
     * copy (internal delivery goes through the exact same ingest/scan pipeline as external mail), so the
     * actual mutation happens later, on the *recipient's own* `ScanQueueJob` run, when it recognizes this
     * control message and — only if its own copy is still unread, matching real Exchange/Outlook — deletes
     * it (see `ScanQueueJob.processRecall()`). The outcome is reported back to this mailbox as an ordinary
     * visible email rather than synced onto this record.
     *
     * Only available for a message currently in Sent Items (matches Outlook's own restriction — recall isn't
     * offered anywhere else).
     */
    @Summary("Recall message")
    @Description(
        "Attempts to recall (delete before it's read) a message this mailbox previously sent, from every " +
            "original recipient on this mail system. Only available for a message currently in Sent Items. " +
            "Asynchronous and best-effort — see this method's own doc comment.",
    )
    @Returns([Object])
    @Post("/:id/recall")
    public async recall(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<T> {
        if (!this.repoUtils || !this.mailTransport) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const message: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const folderRepo: RecoverableRepoUtils<any> = await this.getFolderRepo();
        const folder: any = await folderRepo.findOne(message.folderUid, { ignoreACL: true });
        if (folder?.type !== FolderType.SENT_ITEMS) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Only a message in Sent Items can be recalled.");
        }
        if (!message.messageId) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This message cannot be recalled.");
        }
        // The recall notice goes out with `from.address` as its sender - same rule as `send()`.
        this.assertSenderAllowed(await (await this.getMailboxRepo()).findOne(message.mailboxUid, { ignoreACL: true }), message);

        const envelopeTo: string[] = message.recipients.map((r) => r.address);
        // `from.displayName` is ordinary client-writable data - an address-like one is left out (`safeDisplayName()`).
        const fromName: string | undefined = safeDisplayName(message.from.displayName);
        const composed: Buffer = await new MailComposer({
            from: { address: message.from.address, name: fromName },
            to: envelopeTo,
            subject: `Recall: ${message.subject}`,
            text: `${fromName ?? message.from.address} is attempting to recall the message: "${message.subject}".`,
            headers: { "X-RapidMX-Recall-Of": message.messageId },
        })
            .compile()
            .build();
        await this.mailTransport.send({ raw: composed, envelopeFrom: message.from.address, envelopeTo });

        const updated: T = await this.repoUtils.update(
            { uid: message.uid, version: (message as any).version, recallRequestedAt: new Date() } as any,
            message,
            { user, ignoreACL: true },
        );

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            {
                action: AuditAction.MESSAGE_RECALL,
                targetType: "Message",
                targetUid: message.uid,
                mailboxUid: message.mailboxUid,
                details: { subject: message.subject, recipientCount: envelopeTo.length },
            },
        );

        return updated;
    }

    /**
     * Moves a message to the mailbox's Archive folder (created lazily on first use, like any other
     * well-known folder - see `findOrCreateWellKnownFolder()`) - a manual, one-click equivalent of moving
     * it there via an ordinary folder `update()`. Blocked for a message currently in Drafts or Outbox:
     * `Message.scheduledSendTime`'s own doc comment notes a scheduled/draft send sits in Outbox until
     * `ScheduledSendJob` relays it, and archiving it out from under that job's own folder-scoped query
     * would silently prevent it from ever being sent. No other folder-type restriction - archiving from
     * Inbox, Sent Items, Junk, or any user folder is fine, and re-archiving an already-archived message is
     * a harmless idempotent no-op.
     */
    @Summary("Archive message")
    @Description(
        "Moves a message to the mailbox's Archive folder (created on first use, like any other well-known " +
            "folder) - a manual, one-click equivalent of moving it there via an ordinary folder update.",
    )
    @Returns([Object])
    @Post("/:id/archive")
    public async archive(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<T> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const message: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const folderRepo: RecoverableRepoUtils<any> = await this.getFolderRepo();
        const currentFolder: any = await folderRepo.findOne(message.folderUid, { ignoreACL: true });
        if (currentFolder?.type === FolderType.DRAFTS || currentFolder?.type === FolderType.OUTBOX) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A message in Drafts or Outbox cannot be archived.");
        }

        const archiveFolder: any = await findOrCreateWellKnownFolder(
            folderRepo,
            this.folderClass,
            message.mailboxUid,
            FolderType.ARCHIVE,
            user,
        );

        return await this.repoUtils.update(
            { uid: message.uid, version: (message as any).version, folderUid: archiveFolder.uid } as any,
            message,
            { user, ignoreACL: true },
        );
    }

    /**
     * Moves a message between the Focused and Other halves of the Inbox, and - with
     * `applyToSender: true` - records a `FocusedInboxOverride` so every future message from that same
     * sender goes there automatically. These are Outlook's two adjacent gestures ("Move to Other" vs.
     * "Always move to Other"), and Microsoft Graph's equivalent pair of calls (a `PATCH` of
     * `inferenceClassification` plus a POST to `inferenceClassificationOverrides`), collapsed into the
     * single round trip a client actually wants.
     *
     * Reclassifying just this one message needs no action at all - the inherited
     * `PUT /:id/inferenceClassification` (`BaseScopedChildRoute.updateProperty()`) already does it; this
     * exists for the override half, and accepts the message update too so a client never has to make both
     * calls and handle one of them failing.
     *
     * The override is keyed on the message's own `from` address (normalized), and upserts: re-classifying
     * the same sender the other way later replaces the instruction rather than accumulating a second,
     * contradictory one.
     */
    @Summary("Classify a message as Focused or Other")
    @Description(
        "Sets the message's Focused Inbox classification and, when applyToSender is set, records an " +
            "override so all future mail from that sender is classified the same way.",
    )
    @Returns([Object])
    @Post("/:id/classify")
    public async classify(
        @Param("id") id: string,
        body: { classifyAs?: string; applyToSender?: boolean } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const classifyAs: string | undefined = body?.classifyAs;
        if (classifyAs !== MessageClassification.FOCUSED && classifyAs !== MessageClassification.OTHER) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `classifyAs must be one of: ${MessageClassification.FOCUSED}, ${MessageClassification.OTHER}.`,
            );
        }

        const message: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        if (body?.applyToSender) {
            await this.upsertSenderOverride(message.mailboxUid, message.from.address, classifyAs);
        }

        return await this.repoUtils.update(
            { uid: message.uid, version: (message as any).version, inferenceClassification: classifyAs } as any,
            message,
            { user, ignoreACL: true },
        );
    }

    /**
     * Stores the client's seal of a signature verification it performed (`Message.verificationSeal`), bound to the key vault
     * master key generation it was sealed under (`verificationSealGeneration`). The server can't verify signatures (it can't
     * decrypt, and isn't trusted to assert verification), so the seal is an opaque string it only stores.
     *
     * - 400 unless `seal` is a non-empty string of at most `MAX_VERIFICATION_SEAL_LENGTH` characters from
     * `[A-Za-z0-9+/=_.:-]` and `masterKeyGeneration` is a non-negative integer; 404 for an unknown message; 403 without
     * READ and UPDATE on the message's folder.
     * - 409 when the mailbox has no `KeyVault` (nothing to seal against), or `masterKeyGeneration` isn't the vault's current
     * generation (absent = 0): a stale client never writes.
     * - No stored seal, or one from an older generation (a rekey made it unopenable): both fields are written, 200. The
     * identical seal at the current generation: 200, no write. Anything else (a different seal at the same or a newer
     * generation): 409.
     *
     * The write is version-checked, so of two concurrent writers only one lands; the other re-reads and gets the rules above
     * again. Not blocked by a legal hold (a seal isn't message content) and not audited (user-private metadata).
     */
    @Summary("Set a message's verification seal")
    @Description(
        "Stores the client's opaque seal of a signature verification it performed on this message, bound to the key vault's " +
            "current master key generation. The same seal again succeeds; a different seal only replaces one from an older generation.",
    )
    @Returns([Object])
    @Put("/:id/verification-seal")
    public async setVerificationSeal(
        @Param("id") id: string,
        body: { seal?: unknown; masterKeyGeneration?: unknown } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const seal: unknown = body?.seal;
        if (typeof seal !== "string" || seal.length > MAX_VERIFICATION_SEAL_LENGTH || !VERIFICATION_SEAL_PATTERN.test(seal)) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `seal must be a non-empty string of at most ${MAX_VERIFICATION_SEAL_LENGTH} base64 or base64url characters.`,
            );
        }
        const generation: unknown = body?.masterKeyGeneration;
        if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "masterKeyGeneration must be a non-negative integer.");
        }
        for (let attempt = 1; ; attempt++) {
            const message: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true, skipCache: true });
            if (!message) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            if (
                !(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.READ)) ||
                !(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.UPDATE))
            ) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
            }
            const currentGeneration: number | undefined = await this.currentMasterKeyGeneration(message.mailboxUid);
            if (currentGeneration === undefined) {
                throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "This mailbox has no key vault to seal against.");
            }
            if (generation !== currentGeneration) {
                throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "masterKeyGeneration isn't the key vault's current generation.");
            }
            const stored: unknown = message.verificationSeal;
            if (typeof stored === "string" && stored.length > 0) {
                const storedGeneration: number = BaseMessageRoute.generationOf(message.verificationSealGeneration);
                if (storedGeneration === currentGeneration && stored === seal) {
                    return message;
                }
                if (storedGeneration >= currentGeneration) {
                    throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "This message already has a different verification seal.");
                }
            }
            try {
                const updated: T = await this.repoUtils.update(
                    {
                        uid: message.uid,
                        version: (message as any).version,
                        verificationSeal: seal,
                        verificationSealGeneration: currentGeneration,
                    } as any,
                    asEntity(this.repoUtils, message),
                    { user, ignoreACL: true },
                );
                this.notificationUtils?.sendMessage(updated.folderUid, this.modelClass.name, "update", updated);
                return updated;
            } catch (err: any) {
                // Lost the optimistic lock: a concurrent seal (resolved on the re-read) or an unrelated write (retried).
                /* v8 ignore next 3 -- only a database failure, or losing the lock to unrelated writes three times running */
                if (err?.status !== 409 || attempt >= 3) {
                    throw err;
                }
            }
        }
    }

    /** A stored generation as a number: anything but a non-negative integer (absent, `null`, a legacy value) counts as 0. */
    private static generationOf(value: unknown): number {
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    }

    /** The mailbox's `KeyVault.masterKeyGeneration` (absent = 0), or `undefined` when the mailbox has no key vault. Read
     * uncached, so a rekey is seen at once. */
    private async currentMasterKeyGeneration(mailboxUid: string): Promise<number | undefined> {
        if (!this.keyVaultRepo) {
            this.keyVaultRepo = await this._objectFactory!.newInstance(RepoUtils, { name: this.keyVaultClass.name, args: [this.keyVaultClass] });
        }
        const vaults: KeyVault[] = await this.keyVaultRepo.find({ mailboxUid: ModelUtils.literal(mailboxUid), limit: 1 } as any, {
            ignoreACL: true,
            limit: 1,
            skipCache: true,
        });
        return vaults[0] ? BaseMessageRoute.generationOf(vaults[0].masterKeyGeneration) : undefined;
    }

    /** Creates - or, when one already exists for this sender, updates - the mailbox's standing
     * Focused/Other instruction for `senderAddress`. */
    private async upsertSenderOverride(
        mailboxUid: string,
        senderAddress: string,
        classifyAs: MessageClassification,
    ): Promise<void> {
        const normalized: string = normalizeAddress(senderAddress);
        const repo: RepoUtils<FocusedInboxOverride> = await this.getFocusedInboxOverrideRepo();
        // `find()` returns plain documents on Mongo, which `update()` doesn't version-check (`asEntity()`). A lost race -
        // a concurrent update (409) or a concurrent create hitting the (mailbox, sender) unique index - re-reads and
        // applies this instruction to the row that won.
        for (let attempt = 1; ; attempt++) {
            const existing: FocusedInboxOverride[] = await repo.find(
                { mailboxUid: ModelUtils.literal(mailboxUid), senderAddress: ModelUtils.literal(normalized), limit: 1 } as any,
                { ignoreACL: true, limit: 1, skipCache: true },
            );
            try {
                if (existing[0]) {
                    await repo.update(
                        { uid: existing[0].uid, version: (existing[0] as any).version, classifyAs },
                        asEntity(repo, existing[0]),
                        { ignoreACL: true },
                    );
                    return;
                }
                await repo.create(new this.focusedInboxOverrideClass({ mailboxUid, senderAddress: normalized, classifyAs }), {
                    ignoreACL: true,
                });
                return;
                /* v8 ignore start -- only a concurrent classify of the same sender reaches here */
            } catch (err: any) {
                if (attempt >= 3 || !(err?.status === 409 || isDuplicateKeyError(err))) {
                    throw err;
                }
            }
            /* v8 ignore stop */
        }
    }

    /**
     * Wraps the inherited `BaseScopedChildRoute.update()` (unchanged) with the read-receipt trigger: if this
     * update carries `flags.read` transitioning `false → true` and the message still has a receipt to answer
     * (`dispositionNotificationTo` set, `readReceiptSentAt`/`readReceiptPending` both still unset - i.e. this
     * is genuinely the first time), decides and sends (or defers pending approval) the read MDN via
     * `maybeSendReadReceipt()`. Reads the pre-update state itself, since `super.update()`'s own inherited
     * behavior has no reason to expose it.
     */
    @Put("/:id")
    public async update(
        @Param("id") id: string,
        obj: UpdateObject<T>,
        @Request req?: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        const existing: T | undefined = this.repoUtils ? await this.repoUtils.findOne(id, { ignoreACL: true }) : undefined;
        const updated: T = await super.update(id, obj, req, user);

        const justMarkedRead: boolean = !!existing && !existing.flags.read && updated.flags.read;
        // Judged on the state before this update as well as after it, so a trusted caller clearing the receipt fields
        // in the same request can't make an already-answered receipt look unanswered.
        if (
            justMarkedRead &&
            updated.dispositionNotificationTo &&
            !existing!.readReceiptSentAt &&
            !existing!.readReceiptPending &&
            !existing!.readReceiptDeclined &&
            !updated.readReceiptSentAt &&
            !updated.readReceiptPending &&
            !updated.readReceiptDeclined
        ) {
            return await this.maybeSendReadReceipt(updated);
        }

        return updated;
    }

    /**
     * Decides whether to auto-send or hold-for-approval the read receipt for `message` (which the caller has
     * already confirmed both requests one and hasn't already been handled), applying `Mailbox.
     * autoSendReceipts*` per the requester's own `RecipientTier` (`util/DomainUtils.ts`'s
     * `classifyRecipientTier()`) - the exact same rule `ScanQueueJob.maybeSendDeliveryReceipt()` applies for a
     * delivery receipt, just triggered here by a read instead of a delivery. A send failure is left unrecorded
     * (neither stamped sent nor marked pending) rather than persisted as a permanent failure - the natural
     * retry opportunity is simply the message being marked read again later (e.g. unread, then read once
     * more). Returns the message as it ends up after this method's own follow-up update, if any - `update()`
     * returns *this* value, not its own pre-receipt snapshot, so the caller actually sees
     * `readReceiptSentAt`/`readReceiptPending` reflected.
     */
    private async maybeSendReadReceipt(message: T): Promise<T> {
        const mailbox: Mailbox | undefined = await (await this.getMailboxRepo()).findOne(message.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            return message;
        }

        const tier = await classifyRecipientTier(
            this._objectFactory!,
            this.domainClass,
            message.dispositionNotificationTo!,
            createFederatedPeerCheck(this.dnsResolver!),
        );
        const autoSend: boolean =
            tier === "same-org"
                ? mailbox.autoSendReceiptsInternal
                : tier === "federated"
                  ? mailbox.autoSendReceiptsFederated
                  : mailbox.autoSendReceiptsExternal;
        if (!autoSend) {
            return await this.repoUtils!.update(
                { uid: message.uid, version: (message as any).version, readReceiptPending: true } as any,
                message,
                { ignoreACL: true },
            );
        }

        // Claim the receipt before sending it: the stamp is written under the optimistic lock first, so of two
        // concurrent "mark read" requests only one gets past this point, and a message's read receipt is sent at most
        // once. A failed send releases the claim, leaving it unrecorded as before (retried on a later read).
        let claimed: T;
        try {
            claimed = await this.repoUtils!.update(
                { uid: message.uid, version: (message as any).version, readReceiptSentAt: new Date() } as any,
                message,
                { ignoreACL: true },
            );
            // The catch is only reachable by losing the optimistic-lock race to a concurrent update of this same message
            // between `update()`'s write and this claim, which no HTTP-level test can reliably win; the other request then
            // owns the receipt, so this one returns without sending.
            /* v8 ignore start */
        } catch {
            return message;
        }
        /* v8 ignore stop */
        const sent: boolean = await this.sendDispositionNotification(
            message.dispositionNotificationTo!,
            mailbox,
            message.messageId,
            message.subject,
            "read",
        );
        if (sent) {
            return claimed;
        }
        return await this.repoUtils!.update(
            { uid: claimed.uid, version: (claimed as any).version, readReceiptSentAt: null } as any,
            claimed,
            { ignoreACL: true },
        );
    }

    /**
     * Sends a receipt `ScanQueueJob`/`update()`'s own automatic path originally left pending the mailbox
     * owner's explicit approval for (`Mailbox.autoSendReceiptsInternal`/`External` was `false` for the
     * requester's category) - the mailbox owner reviewing "sender requested a read receipt" on the message
     * and choosing to answer it after all.
     */
    @Summary("Approve a pending receipt")
    @Description("Sends a delivery or read receipt this mailbox originally held pending the owner's explicit approval.")
    @Returns([Object])
    @Post("/:id/receipt/approve")
    public async approveReceipt(
        @Param("id") id: string,
        body: { type?: "delivery" | "read" } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        const { message, type } = await this.requirePendingReceipt(id, body, user);

        const mailbox: Mailbox | undefined = await (await this.getMailboxRepo()).findOne(message.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const sent: boolean = await this.sendDispositionNotification(
            message.dispositionNotificationTo!,
            mailbox,
            message.messageId,
            message.subject,
            type,
        );

        const patch: any = { uid: message.uid, version: (message as any).version };
        if (type === "delivery") {
            patch.deliveryReceiptPending = false;
            if (sent) {
                patch.deliveryReceiptSentAt = new Date();
            }
        } else {
            patch.readReceiptPending = false;
            if (sent) {
                patch.readReceiptSentAt = new Date();
            }
        }
        return await this.repoUtils!.update(patch, message, { user, ignoreACL: true });
    }

    /** Declines a pending receipt permanently - no later re-prompt for that same event. */
    @Summary("Decline a pending receipt")
    @Description("Permanently declines a delivery or read receipt this mailbox held pending the owner's explicit approval.")
    @Returns([Object])
    @Post("/:id/receipt/decline")
    public async declineReceipt(
        @Param("id") id: string,
        body: { type?: "delivery" | "read" } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        const { message, type } = await this.requirePendingReceipt(id, body, user);

        const patch: any = { uid: message.uid, version: (message as any).version };
        if (type === "delivery") {
            patch.deliveryReceiptPending = false;
            patch.deliveryReceiptDeclined = true;
        } else {
            patch.readReceiptPending = false;
            patch.readReceiptDeclined = true;
        }
        return await this.repoUtils!.update(patch, message, { user, ignoreACL: true });
    }

    /** Shared validation for `approveReceipt()`/`declineReceipt()`: resolves `id`, checks permission, and
     * confirms the requested `type` actually has a receipt pending approval on this message. */
    private async requirePendingReceipt(
        id: string,
        body: { type?: "delivery" | "read" } | undefined,
        user: JWTUser | undefined,
    ): Promise<{ message: T; type: "delivery" | "read" }> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const type: string | undefined = body?.type;
        if (type !== "delivery" && type !== "read") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "type must be one of: delivery, read.");
        }

        const message: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const pending: boolean = type === "delivery" ? message.deliveryReceiptPending : message.readReceiptPending;
        if (!pending || !message.dispositionNotificationTo) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This message has no receipt pending approval.");
        }

        return { message, type };
    }

    /** See `BaseScopedChildRoute.checkLegalHold()`'s own doc comment - `Message` is the one entity a
     * `Matter`'s `custodianMailboxUids` actually protects, checked against its own denormalized
     * `mailboxUid` and `sentDate` (the date a hold's `dateRangeStart`/`dateRangeEnd` is scoped by).
     *
     * Dates are coerced first (a Mongo row can hold an ISO string, which a bare `getTime()` comparison can't use). The
     * reference date is `sentDate`, else `receivedDate`, else the server-set, immutable `dateCreated`; with no valid date
     * at all, any open hold on the mailbox blocks - the conservative direction for a hold. `sentDate`/`receivedDate`
     * aren't client-writable outside drafts (see `prepareCreate()`/`prepareUpdate()`), so a held message can't be
     * re-dated out of range first. */
    protected async checkLegalHold(existing: T): Promise<void> {
        const holds = await findActiveHoldsFor(this._objectFactory!, this.matterClass, existing.mailboxUid);
        if (holds.length === 0) {
            return;
        }
        const reference: Date | undefined =
            toValidDate(existing.sentDate) ?? toValidDate(existing.receivedDate) ?? toValidDate((existing as any).dateCreated);
        const time: number | undefined = reference?.getTime();
        const blocking = holds.filter((matter) => {
            const start: Date | undefined = toValidDate(matter.dateRangeStart);
            const end: Date | undefined = toValidDate(matter.dateRangeEnd);
            return time === undefined || ((!start || time >= start.getTime()) && (!end || time <= end.getTime()));
        });
        if (blocking.length > 0) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                `This action is blocked by an active legal hold: ${blocking.map((m) => m.uid).join(", ")}.`,
            );
        }
    }

    /** See `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment - `Message` is exactly the
     * entity that doc comment's compliance-job list (`ErasureExecutionJob`/`RetentionEnforcementJob`/
     * `LegalHoldUtils`) names as trusting `mailboxUid` directly. */
    protected async resolveMailboxUidFor(scopeUid: string): Promise<string | undefined> {
        return getMailboxUidForFolder(this._objectFactory!, this.folderClass, scopeUid);
    }

    /**
     * Wraps the inherited `BaseScopedChildRoute.delete()` (soft/hard-delete, unchanged) with an
     * `AuditLogEntry` - Exchange's own Mailbox Audit Log flags message deletion as one of its two most
     * sensitive tracked mailbox-content actions (recall being the other, see `recall()` above). Fetches
     * the record first since `super.delete()` returns nothing to audit against once it's gone.
     *
     * Also audits a legal-hold-blocked purge attempt separately, before ever reaching `super.delete()`
     * (which re-checks the same hold itself - the authoritative enforcement point either way; this
     * earlier check exists only so the exact record attempted is available to audit).
     */
    @Delete("/:id")
    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        const existing: T | undefined = this.repoUtils ? await this.repoUtils.findOne(id, { version, ignoreACL: true }) : undefined;

        // Like a move out of Outbox, a delete is refused while a send of the message is in flight (for every caller): a
        // soft-deleted message could otherwise miss its relay marker and be restored and sent a second time.
        if (existing && (await this.aclUtils!.hasPermission(user, existing.folderUid, ACLAction.DELETE))) {
            BaseMessageRoute.assertNotInFlight(existing);
        }

        if (existing && purge === "true") {
            try {
                await this.checkLegalHold(existing);
            } catch (err) {
                await recordAuditLog(
                    this._objectFactory!,
                    this.auditLogClass,
                    { config: this.config, req, user, logger: this.logger },
                    {
                        action: AuditAction.LEGAL_HOLD_BLOCKED_DELETE,
                        targetType: "Message",
                        targetUid: existing.uid,
                        mailboxUid: existing.mailboxUid,
                        details: { subject: existing.subject },
                    },
                );
                throw err;
            }
        }

        await super.delete(id, version, purge, req, user);

        if (existing) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                {
                    action: AuditAction.MESSAGE_DELETE,
                    targetType: "Message",
                    targetUid: existing.uid,
                    mailboxUid: existing.mailboxUid,
                    details: { subject: existing.subject, folderUid: existing.folderUid },
                },
            );
        }
    }

    @Summary("Get message content")
    @Description(
        "Streams the message's sanitized HTML body (post-`ScanPipeline`, safe to render directly) if one " +
            "exists, otherwise falls back to its plain-text preview. Never serves `bodyBlobKey`'s raw MIME " +
            "source directly — that content is never sanitized.",
    )
    @Get("/:id/content")
    public async content(
        @Param("id") id: string,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        if (!this.repoUtils || !this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const message: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!message || !(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.READ))) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        // A missing `mailbox` (a dangling `message.mailboxUid` - e.g. the mailbox was deleted, which has no
        // cascade to its messages, per `ErasureExecutionJob`'s own doc comment) must NOT skip this audit
        // entirely - content is still served below regardless of whether the mailbox lookup succeeded, so
        // failing to resolve ownership is exactly the uncertain case `isNonOwnerAccess()`'s own doc comment
        // says to treat defensively as non-owner, not to silently pass over.
        const mailbox: Mailbox | undefined = await (await this.getMailboxRepo()).findOne(message.mailboxUid, { ignoreACL: true });
        if (!mailbox || isNonOwnerAccess(mailbox, user)) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, user, logger: this.logger },
                {
                    action: AuditAction.MESSAGE_CONTENT_ACCESSED,
                    targetType: "Message",
                    targetUid: message.uid,
                    mailboxUid: message.mailboxUid,
                    details: { subject: message.subject },
                },
            );
        }

        // Defense in depth behind the sanitizer, for a client that opens this URL directly rather than rendering the
        // HTML in its own sandbox: no sniffing, no script, no network fetches, and a sandboxed (opaque-origin) document.
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("content-security-policy", "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; sandbox");
        if (message.sanitizedHtmlBlobKey) {
            const html: Buffer = await this.blobStore.get(message.sanitizedHtmlBlobKey);
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.send(html);
            return;
        }

        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.send(Buffer.from(message.bodyPreview ?? "", "utf-8"));
    }
}
