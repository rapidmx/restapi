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
    RepoUtils,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { ScanPipeline } from "../scan/ScanPipeline.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { classifyRecipientTier } from "../util/DomainUtils.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { scanAndRelay } from "../util/MailSendUtils.js";
import { prependHeaders } from "../util/MimeHeaderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { buildDispositionNotification } from "../util/ReceiptUtils.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import {
    AuditAction,
    FocusedInboxOverride,
    FolderType,
    Mailbox,
    Message,
    MessageClassification,
    MessageFlags,
    MessageReceiptEntry,
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

    /** Safety-net cap on how many of a mailbox's messages `conversations()` scans to build its groups - see
     * that method's own doc comment for why there's no query-time group-by to rely on instead. */
    @Config("mail:conversations:scan_limit", 500)
    private conversationScanLimit: number = 500;

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
                from: { address: mailbox.primarySmtpAddress, displayName: mailbox.displayName },
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

    @Summary("Send message")
    @Description(
        "Scans and relays a drafted message via the configured MailTransport, then moves it into the " +
            "mailbox's Sent Items folder.",
    )
    @Returns([Object])
    @Post("/:id/send")
    public async send(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T> {
        if (!this.repoUtils || !this.blobStore || !this.mailTransport || !this.scanPipeline) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const message: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        // "Do not deliver before" (`PR_DEFERRED_SEND_TIME`) - a future `scheduledSendTime`, set via an ordinary
        // `PUT` on the draft before calling this endpoint, defers relay instead of sending now. The message sits
        // in the mailbox's Outbox folder until `ScheduledSendJob` relays it and clears this field. Canceling a
        // scheduled send is just another ordinary `PUT` (clear the field, or move back to Drafts) - no separate
        // endpoint for that either.
        if (message.scheduledSendTime && message.scheduledSendTime > new Date()) {
            const folderRepo: RecoverableRepoUtils<any> = await this.getFolderRepo();
            const outbox: any = await findOrCreateWellKnownFolder(folderRepo, this.folderClass, message.mailboxUid, FolderType.OUTBOX, user);
            return await this.repoUtils.update(
                { uid: message.uid, version: (message as any).version, folderUid: outbox.uid } as any,
                message,
                { user, ignoreACL: true },
            );
        }

        // The message's `bodyBlobKey` already holds the fully composed RFC 5322 source (assembled by the
        // webmail compose UI, or an EAS/MAPI "send" handler, before this endpoint is called) — this route's
        // job is scanning and relay, not MIME composition.
        let raw: Buffer = await this.blobStore.get(message.bodyBlobKey);
        const envelopeTo: string[] = message.recipients.map((r) => r.address);

        // A receipt request is a single message-level header - RFC 3798 has no "only notify me for these
        // recipients" concept, every recipient's own system independently decides whether to honor it - so
        // the rule is "attach it if it applies to *any* recipient": each recipient is classified by
        // `classifyRecipientTier()` (`util/DomainUtils.ts` - same-org/federated/external), and an explicit
        // per-draft `message.requestReceipt` overrides all three of the sending mailbox's own
        // `alwaysRequestReceipt*` defaults at once when set.
        const sendingMailbox: Mailbox | undefined = await (await this.getMailboxRepo()).findOne(message.mailboxUid, {
            ignoreACL: true,
        });
        let attachesReceiptRequest = false;
        if (sendingMailbox) {
            const effectiveInternal: boolean = message.requestReceipt ?? sendingMailbox.alwaysRequestReceiptInternal;
            const effectiveFederated: boolean = message.requestReceipt ?? sendingMailbox.alwaysRequestReceiptFederated;
            const effectiveExternal: boolean = message.requestReceipt ?? sendingMailbox.alwaysRequestReceiptExternal;
            if (effectiveInternal || effectiveFederated || effectiveExternal) {
                for (const address of envelopeTo) {
                    const tier = await classifyRecipientTier(this._objectFactory!, this.domainClass, address);
                    if (
                        (tier === "same-org" && effectiveInternal) ||
                        (tier === "federated" && effectiveFederated) ||
                        (tier === "external" && effectiveExternal)
                    ) {
                        attachesReceiptRequest = true;
                        break;
                    }
                }
            }
        }
        if (attachesReceiptRequest) {
            raw = prependHeaders(raw, [{ name: "Disposition-Notification-To", value: message.from.address }]);
        }

        const {
            raw: relayedRaw,
            messageId,
            conversationId,
            sanitizedHtmlBlobKey: scannedHtmlBlobKey,
        } = await scanAndRelay(raw, message.from.address, envelopeTo, this.scanPipeline, this.mailTransport, this.blobStore);
        if (relayedRaw !== raw) {
            // `scanAndRelay()` injected a `Message-ID` this draft didn't already have - persist the augmented
            // bytes so a later read (and any future `recall()` of this very message) sees the same header it
            // was actually relayed with.
            await this.blobStore.put(message.bodyBlobKey, relayedRaw, { contentType: "message/rfc822" });
        }

        const folderRepo: RecoverableRepoUtils<any> = await this.getFolderRepo();
        const sentFolder: any = await findOrCreateWellKnownFolder(
            folderRepo,
            this.folderClass,
            message.mailboxUid,
            FolderType.SENT_ITEMS,
            user,
        );
        const flags: MessageFlags = { ...message.flags, read: true };
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

        return await this.repoUtils.update(
            {
                uid: message.uid,
                version: (message as any).version,
                folderUid: sentFolder.uid,
                flags,
                sanitizedHtmlBlobKey,
                messageId,
                conversationId,
                receiptStatus,
            } as any,
            message,
            { user, ignoreACL: true },
        );
    }

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

        const envelopeTo: string[] = message.recipients.map((r) => r.address);
        const composed: Buffer = await new MailComposer({
            from: { address: message.from.address, name: message.from.displayName },
            to: envelopeTo,
            subject: `Recall: ${message.subject}`,
            text: `${message.from.displayName ?? message.from.address} is attempting to recall the message: "${message.subject}".`,
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

    /** Creates - or, when one already exists for this sender, updates - the mailbox's standing
     * Focused/Other instruction for `senderAddress`. */
    private async upsertSenderOverride(
        mailboxUid: string,
        senderAddress: string,
        classifyAs: MessageClassification,
    ): Promise<void> {
        const normalized: string = normalizeAddress(senderAddress);
        const repo: RepoUtils<FocusedInboxOverride> = await this.getFocusedInboxOverrideRepo();
        const existing: FocusedInboxOverride[] = await repo.find(
            { mailboxUid, senderAddress: normalized, limit: 1 } as any,
            { ignoreACL: true, limit: 1 },
        );
        if (existing[0]) {
            await repo.update(
                { uid: existing[0].uid, version: (existing[0] as any).version, classifyAs },
                existing[0],
                { ignoreACL: true },
            );
            return;
        }
        await repo.create(new this.focusedInboxOverrideClass({ mailboxUid, senderAddress: normalized, classifyAs }), {
            ignoreACL: true,
        });
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
        if (
            justMarkedRead &&
            updated.dispositionNotificationTo &&
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

        const tier = await classifyRecipientTier(this._objectFactory!, this.domainClass, message.dispositionNotificationTo!);
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

        const sent: boolean = await this.sendDispositionNotification(
            message.dispositionNotificationTo!,
            mailbox,
            message.messageId,
            message.subject,
            "read",
        );
        if (sent) {
            return await this.repoUtils!.update(
                { uid: message.uid, version: (message as any).version, readReceiptSentAt: new Date() } as any,
                message,
                { ignoreACL: true },
            );
        }
        return message;
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

    /**
     * Wraps the inherited `BaseScopedChildRoute.delete()` (soft/hard-delete, unchanged) with an
     * `AuditLogEntry` - Exchange's own Mailbox Audit Log flags message deletion as one of its two most
     * sensitive tracked mailbox-content actions (recall being the other, see `recall()` above). Fetches
     * the record first since `super.delete()` returns nothing to audit against once it's gone.
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
