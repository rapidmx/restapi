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
import { getMailboxUidForFolder } from "../util/FolderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { Attachment, Message } from "../models/types.js";
const { Inject } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Get, Param, Post, Request, Response, User: AuthUser } = RouteDecorators;

/** Strips CR/LF (header injection) from a client-supplied filename before it's ever stored - matches
 * `DistributionListUtils.rewriteHeadersForList()`'s identical `safeName` convention for any other value
 * that ends up interpolated into a raw header. */
function sanitizeFilename(filename: string): string {
    return filename.replace(/[\r\n]/g, "");
}

/** Escapes a filename for safe use inside a `Content-Disposition` quoted-string parameter (RFC 6266) -
 * backslash-escapes any embedded `"`/`\`, and strips CR/LF as defense-in-depth alongside `sanitizeFilename()`
 * (an attachment uploaded before that check existed could still have a raw newline in its stored filename).
 * Without this, an unescaped embedded `"` breaks out of the quoted value and injects a second `filename=`
 * parameter, letting an uploader make a downloaded attachment save under a different, attacker-chosen name
 * than the one shown in the UI/metadata to a later downloader. */
function escapeContentDispositionFilename(filename: string): string {
    return filename.replace(/[\r\n]/g, "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** `Attachment` fields only the server sets: the blob keys (`upload()`/extraction - a client-chosen key would read any
 * stored object back through `download()`), the scan result, and the size/type measured at upload. */
const SERVER_MANAGED_ATTACHMENT_FIELDS = ["blobKey", "extractedTextBlobKey", "scanResultUid", "sizeBytes", "mimeType"] as const;

/** Types `download()` serves under their own `Content-Type` and, when `isInline`, `inline`: raster images only. Every
 * other type - HTML, SVG, XML, PDF, scripts, anything a browser might render or execute in this origin - is served as
 * an `application/octet-stream` download. */
const INLINE_SAFE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

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

    protected readonly serverManagedFields: readonly string[] = SERVER_MANAGED_ATTACHMENT_FIELDS;

    /** The class of the owning `Message` entity, supplied by the Mongo/SQL concrete subclass. */
    protected abstract messageClass: any;

    /** The concrete `Folder` entity class, supplied by the Mongo/SQL concrete subclass - used only by
     * `resolveMailboxUidFor()` below. */
    protected abstract folderClass: any;

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

    /** See `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment - `Attachment` carries its own
     * denormalized `mailboxUid` (`Attachment.mailboxUid`'s own doc comment) that must never diverge from
     * its actual folder's mailbox, the same reasoning already applied to `upload()`'s own comment above. */
    protected async resolveMailboxUidFor(scopeUid: string): Promise<string | undefined> {
        return getMailboxUidForFolder(this._objectFactory!, this.folderClass, scopeUid);
    }

    /** Refused (400): an attachment record is only ever created by `upload()`, which stores the content and mints the
     * blob key. A metadata-only create would either reference no content or a key the client chose. */
    @Post()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Attachments are created with POST /upload.");
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
                filename: sanitizeFilename(filename),
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
        // `mimeType` comes from the sender (or uploader), so only an allowlisted raster image keeps its type or is ever
        // shown inline - anything else rendered in this origin (HTML, SVG, ...) would be stored XSS.
        const baseType: string = String(attachment.mimeType ?? "").split(";")[0].trim().toLowerCase();
        const inlineSafe: boolean = INLINE_SAFE_MIME_TYPES.has(baseType);
        res.setHeader("content-type", inlineSafe ? baseType : "application/octet-stream");
        res.setHeader("content-length", content.length);
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("content-security-policy", "default-src 'none'; sandbox");
        res.setHeader(
            "content-disposition",
            `${attachment.isInline && inlineSafe ? "inline" : "attachment"}; filename="${escapeContentDispositionFilename(attachment.filename)}"`,
        );
        res.send(content);
    }
}
