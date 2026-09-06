///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
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

        // The message's `bodyBlobKey` already holds the fully composed RFC 5322 source (assembled by the
        // webmail compose UI, or an EAS/MAPI "send" handler, before this endpoint is called) — this route's
        // job is scanning and relay, not MIME composition.
        const raw: Buffer = await this.blobStore.get(message.bodyBlobKey);
        const envelopeTo: string[] = message.recipients.map((r) => r.address);

        const { sanitizedHtmlBlobKey: scannedHtmlBlobKey } = await scanAndRelay(
            raw,
            message.from.address,
            envelopeTo,
            this.scanPipeline,
            this.mailTransport,
            this.blobStore,
        );

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
            } as any,
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
