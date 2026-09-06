///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
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
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { Attachment, Message } from "../models/types.js";
const { Inject } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Get, Param, Post, Request, Response, User: AuthUser } = RouteDecorators;

/**
 * Extends `BaseScopedChildRoute` (scoped by `folderUid` — see the architecture note on `Message.mailboxUid`)
 * for `Attachment` with `upload`/`download` endpoints that move binary content through the configured
 * `BlobStore` — `Attachment` records never carry binary content inline, only metadata plus a `blobKey`.
 * Ordinary `create` is deliberately NOT used for uploading an attachment's content (it would require the
 * client to already have a `blobKey`, which only this route can mint) — `upload` replaces it as the way a new
 * attachment record is created.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseAttachmentRoute<T extends Attachment, M extends Message = Message> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "folderUid";

    /** The class of the owning `Message` entity, supplied by the Mongo/SQL concrete subclass. */
    protected abstract messageClass: any;

    private messageRepo?: RecoverableRepoUtils<M>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    private async getMessageRepo(): Promise<RecoverableRepoUtils<M>> {
        if (!this.messageRepo) {
            this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                name: this.messageClass.name,
                args: [this.messageClass],
            });
        }
        return this.messageRepo;
    }

    @Summary("Upload attachment")
    @Description("Stores the request body as a new attachment's binary content and creates its metadata record.")
    @Returns([Object])
    @Post("/upload")
    public async upload(@Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T> {
        if (!this.repoUtils || !this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const messageUid: string | string[] | undefined = req.query["messageUid"];
        const filename: string | string[] | undefined = req.query["filename"];
        const mimeType: string | string[] | undefined = req.query["mimeType"];
        const isInline: boolean = req.query["isInline"] === "true";
        const contentId: string | string[] | undefined = req.query["contentId"];
        const raw: Buffer | undefined = req.rawBody;

        if (!raw || raw.length === 0 || Array.isArray(messageUid) || !messageUid || Array.isArray(filename) || !filename) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        // `folderUid`/`mailboxUid` are ALWAYS derived from the owning `Message` record here, never taken from
        // the client — `Attachment.folderUid`/`mailboxUid`'s own doc comment describes them as "denormalized
        // from that Message", and trusting client-supplied values for them (as this route previously did) let
        // any caller with CREATE access to ANY folder they own attach content to a `messageUid` belonging to a
        // completely different mailbox, by simply asserting whatever `folderUid`/`mailboxUid` they liked — a
        // cross-mailbox attachment-planting and quota-poisoning primitive (`MailboxQuotaRecalcJob.
        // recalcMailbox()` sums `Attachment.find({ messageUid })` for every message, with no mailbox check of
        // its own). Resolving the message server-side and checking permission against *its* `folderUid` closes
        // that gap entirely: an attacker can no longer create an attachment against a message they don't have
        // UPDATE access to, regardless of what folder/mailbox uids they supply.
        const messageRepo: RecoverableRepoUtils<M> = await this.getMessageRepo();
        const message: M | undefined = await messageRepo.findOne(messageUid, { ignoreACL: true });
        if (!message) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        if (!(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }

        const blobKey: string = `attachments/${crypto.randomUUID()}`;
        await this.blobStore.put(blobKey, raw, {
            contentType: Array.isArray(mimeType) ? mimeType[0] : mimeType,
        });

        return await this.doCreateObject(
            {
                messageUid,
                folderUid: message.folderUid,
                mailboxUid: message.mailboxUid,
                filename,
                mimeType: (Array.isArray(mimeType) ? mimeType[0] : mimeType) ?? "application/octet-stream",
                sizeBytes: raw.length,
                blobKey,
                contentId: Array.isArray(contentId) ? contentId[0] : contentId,
                isInline,
            } as any,
            { user, ignoreACL: true },
        );
    }

    @Summary("Download attachment content")
    @Description("Streams the binary content of an attachment.")
    @Get("/:id/content")
    public async download(
        @Param("id") id: string,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        if (!this.repoUtils || !this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }

        const attachment: T | undefined = await this.repoUtils.findOne(id, { ignoreACL: true });
        if (!attachment || !(await this.aclUtils!.hasPermission(user, attachment.folderUid, ACLAction.READ))) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        // `HttpResponse` is a framework-agnostic abstraction over multiple HTTP runtimes (uWS, Bun) that does
        // not guarantee a real Node.js `Writable` to pipe a stream into — buffering the full content and
        // calling `send()` is the one approach guaranteed to work across all of them. Revisit with true
        // streaming (e.g. an `HttpResponse.pipeFrom()` runtime primitive) if large-attachment memory use
        // becomes a real problem; deferred here the same way MAPI Fast Transfer streaming is deferred.
        const content: Buffer = await this.blobStore.get(attachment.blobKey);
        res.setHeader("content-type", attachment.mimeType);
        res.setHeader("content-length", attachment.sizeBytes);
        res.setHeader(
            "content-disposition",
            `${attachment.isInline ? "inline" : "attachment"}; filename="${attachment.filename}"`,
        );
        res.send(content);
    }
}
