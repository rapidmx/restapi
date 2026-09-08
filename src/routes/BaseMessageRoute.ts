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
    RouteDecorators,
} from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { ScanPipeline } from "../scan/ScanPipeline.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { scanAndRelay } from "../util/MailSendUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { FolderType, Message, MessageFlags } from "../models/types.js";
const { Inject } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Get, Param, Post, Request, Response, User: AuthUser } = RouteDecorators;

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

    private folderRepo?: RecoverableRepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject("MailTransport")
    private mailTransport?: any;

    @Inject(ScanPipeline)
    private scanPipeline?: ScanPipeline;

    private async getFolderRepo(): Promise<RecoverableRepoUtils<any>> {
        if (!this.folderRepo) {
            this.folderRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                name: this.folderClass.name,
                args: [this.folderClass],
            });
        }
        return this.folderRepo;
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
        const raw: Buffer = await this.blobStore.get(message.bodyBlobKey);
        const envelopeTo: string[] = message.recipients.map((r) => r.address);

        const {
            raw: relayedRaw,
            messageId,
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

        return await this.repoUtils.update(
            {
                uid: message.uid,
                version: (message as any).version,
                folderUid: sentFolder.uid,
                flags,
                sanitizedHtmlBlobKey,
                messageId,
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

        return await this.repoUtils.update(
            { uid: message.uid, version: (message as any).version, recallRequestedAt: new Date() } as any,
            message,
            { user, ignoreACL: true },
        );
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
