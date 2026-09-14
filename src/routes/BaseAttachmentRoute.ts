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
    type UpdateObject,
} from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { asEntity } from "../util/EntityUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { Attachment, Message } from "../models/types.js";
const { Inject } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Delete, Get, Head, Param, Post, Put, Query, Request, Response, User: AuthUser } = RouteDecorators;

/** The client query minus `$`-operator keys and `shareToken` - the same rule as `BaseScopedChildRoute`'s own (module-
 * private) `stripUnsafeQueryKeys()` - and minus the location keys `messageFilter()` sets itself. */
function stripUnsafeQueryKeys(query: any): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(query)) {
        if (
            ["shareToken", "folderUid", "mailboxUid", "messageUid"].includes(key) ||
            key.split(".").some((segment) => segment.startsWith("$"))
        ) {
            continue;
        }
        result[key] = value;
    }
    return result;
}

/** Where an attachment really is: its owning message's current folder and mailbox. */
interface AttachmentLocation {
    folderUid: string;
    mailboxUid: string;
}



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
const SERVER_MANAGED_ATTACHMENT_FIELDS = [
    "blobKey",
    "extractedTextBlobKey",
    "scanResultUid",
    "sizeBytes",
    "mimeType",
    // Fixed by `upload()` from the message it was checked against; re-pointing it would attach this content (and its
    // quota) to another mailbox's message.
    "messageUid",
    // `AttachmentExtractionJob`'s retry state.
    "extractionAttempts",
    "extractionNextAttemptAt",
    "extractionError",
] as const;

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
 * **Access follows the owning message's CURRENT folder**, not `Attachment.folderUid`. That field is stamped from the
 * message at upload and nothing re-stamps it when the message is sent, moved or archived, so checking it would hide
 * a sent message's attachments from its own listing and refuse a delegate who can read Sent Items but not Drafts -
 * or, the other way round, keep granting a delegate of the old folder access to a message moved out of their reach.
 * So every read (`find`/`count` by `messageUid`, `findById`, `exists`, `download`) resolves the message and checks
 * its folder, and returns the attachment with `folderUid`/`mailboxUid` set to where it really is. Every write
 * (`update`/`delete`/`truncate`) first re-stamps a stale attachment (`realign()`) so `BaseScopedChildRoute`'s own
 * checks run against the right folder; an attachment is never moved on its own (a client `folderUid`/`mailboxUid`
 * is dropped). An attachment whose message no longer exists keeps its stored location.
 *
 * Listing by `messageUid` is the supported way to list a message's attachments (`folderUid` may be sent too and is
 * ignored). A `folderUid`-only list still requires LIST on that folder and only returns attachments whose message is
 * in it now - never ones stamped with it whose message has since moved elsewhere.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseAttachmentRoute<T extends Attachment, M extends Message = Message> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "folderUid";

    protected readonly serverManagedFields: readonly string[] = SERVER_MANAGED_ATTACHMENT_FIELDS;

    protected readonly dateFields: readonly string[] = ["extractionNextAttemptAt"];

    /** The class of the owning `Message` entity, supplied by the Mongo/SQL concrete subclass. */
    protected abstract messageClass: any;

    private messageRepo?: RecoverableRepoUtils<M>;

    /** Page size for the folder-scoped scans that filter or re-stamp in memory (`count()`/`truncate()`). */
    protected folderScanPageSize: number = 500;

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


    /** The message `messageUid` names, soft-deleted included. */
    private async findMessage(messageUid: string): Promise<M | undefined> {
        const messageRepo: RecoverableRepoUtils<M> = await this.getMessageRepo();
        return messageRepo.findOne(messageUid, { ignoreACL: true, includeDeleted: true });
    }

    /** Where `attachment` really is - its message's current folder and mailbox, or its stored ones if the message is
     * gone. `messages` caches lookups across one request. */
    private async locate(attachment: T, messages?: Map<string, M | undefined>): Promise<AttachmentLocation> {
        let message: M | undefined;
        if (messages?.has(attachment.messageUid)) {
            message = messages.get(attachment.messageUid);
        } else {
            message = await this.findMessage(attachment.messageUid);
            messages?.set(attachment.messageUid, message);
        }
        return message
            ? { folderUid: message.folderUid, mailboxUid: message.mailboxUid }
            : { folderUid: attachment.folderUid, mailboxUid: attachment.mailboxUid };
    }

    /** A copy of `attachment` showing `location`, for responses - the stored record is left alone. */
    private located(attachment: T, location: AttachmentLocation): T {
        return Object.assign(Object.create(Object.getPrototypeOf(attachment)), attachment, location);
    }

    /** The data filter for listing `message`'s attachments: the client query minus anything that could widen it, with
     * `messageUid` forced as a literal. Attachments aren't soft-deleted, so a `deleted` filter is dropped too. */
    private messageFilter(params: any, query: any, message: M): any {
        const filter: any = { ...stripUnsafeQueryKeys(query), ...params, messageUid: `eq(${message.uid})` };
        delete filter.folderUid;
        delete filter.mailboxUid;
        delete filter.deleted;
        return filter;
    }

    /** `query.messageUid` as the one message a list is for; `undefined` when absent, 400 when not a single value. */
    private messageUidOf(query: any): string | undefined {
        const messageUid: unknown = query?.messageUid;
        if (messageUid === undefined) {
            return undefined;
        }
        if (typeof messageUid !== "string" || messageUid.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        return messageUid;
    }

    /** Of a folder-scoped page of attachments, those whose message is in `folderUid` now, shown there. */
    private async keepInFolder(rows: T[], folderUid: string): Promise<T[]> {
        const messages: Map<string, M | undefined> = new Map();
        const kept: T[] = [];
        for (const row of rows) {
            const location: AttachmentLocation = await this.locate(row, messages);
            if (location.folderUid === folderUid) {
                kept.push(this.located(row, location));
            }
        }
        return kept;
    }

    /**
     * Re-stamps `attachment`'s stored `folderUid`/`mailboxUid` from its message when they've gone stale, so the
     * inherited write checks see where it really is. Version-checked and retried on a concurrent write; returns the
     * record as stored afterwards.
     */
    private async realign(attachment: T): Promise<T> {
        let current: T = attachment;
        for (let attempt = 1; ; attempt++) {
            const location: AttachmentLocation = await this.locate(current);
            if (location.folderUid === current.folderUid && location.mailboxUid === current.mailboxUid) {
                return current;
            }
            try {
                return await this.repoUtils!.update(
                    { uid: current.uid, version: (current as any).version, ...location } as any,
                    asEntity(this.repoUtils!, current),
                    { ignoreACL: true },
                );
                /* v8 ignore start -- only a concurrent write to the same attachment reaches here */
            } catch (err: any) {
                const reread: T | undefined = await this.repoUtils!.findOne(current.uid, { ignoreACL: true, skipCache: true });
                if (attempt >= 3 || err?.status !== 409 || !reread) {
                    throw err;
                }
                current = reread;
            }
            /* v8 ignore stop */
        }
    }

    /** Lists attachments by their message's current folder - see this class's doc comment. */
    @Get()
    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<T[]> {
        const messageUid: string | undefined = this.messageUidOf(query);
        if (messageUid === undefined) {
            // `super.find()` answers anything but one plain `folderUid` with a 400.
            return this.keepInFolder(await super.find(params, query, user), String(query.folderUid));
        }
        const message: M | undefined = await this.findMessage(messageUid);
        if (!message || !(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.LIST))) {
            return [];
        }
        const rows: T[] = await this.repoUtils!.find(this.messageFilter(params, query, message), {
            limit: query?.limit,
            page: query?.page,
            version: query?.version,
            user,
            ignoreACL: true,
        });
        const location: AttachmentLocation = { folderUid: message.folderUid, mailboxUid: message.mailboxUid };
        return rows.map((row) => this.located(row, location));
    }

    /** Counts attachments by their message's current folder - see `find()`. */
    @Head()
    public async count(@Param() params: any, @Query() query: any, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<any> {
        const messageUid: string | undefined = this.messageUidOf(query);
        if (messageUid === undefined) {
            const folderUid: unknown = query?.folderUid;
            if (typeof folderUid !== "string" || !folderUid || !(await this.aclUtils!.hasPermission(user, folderUid, ACLAction.COUNT))) {
                return super.count(params, query, res, user);
            }
            // Filtered in memory like `find()`, so every page is read.
            let total: number = 0;
            for (let page = 0; ; page++) {
                const rows: T[] = await super.find(params, { ...query, limit: this.folderScanPageSize, page }, user);
                total += (await this.keepInFolder(rows, folderUid)).length;
                if (rows.length < this.folderScanPageSize) {
                    break;
                }
            }
            return res.status(200).setHeader("content-length", total);
        }
        const message: M | undefined = await this.findMessage(messageUid);
        if (!message || !(await this.aclUtils!.hasPermission(user, message.folderUid, ACLAction.COUNT))) {
            return res.status(200).setHeader("content-length", 0);
        }
        const result: number = await this.repoUtils!.count(this.messageFilter(params, query, message), {
            limit: query?.limit,
            page: query?.page,
            version: query?.version,
            user,
            ignoreACL: true,
        });
        return res.status(200).setHeader("content-length", result);
    }

    /** `attachment` if `user` may perform `action` where it really is, else `undefined`. (Attachments aren't
     * soft-deleted, so there is no `?deleted=true` case.) */
    private async readable(id: string, query: any, user: JWTUser | undefined, action: string): Promise<T | undefined> {
        const existing: T | undefined = await this.repoUtils!.findOne(id, { version: query?.version, ignoreACL: true });
        if (!existing) {
            return undefined;
        }
        const location: AttachmentLocation = await this.locate(existing);
        return (await this.aclUtils!.hasPermission(user, location.folderUid, action)) ? this.located(existing, location) : undefined;
    }

    @Get("/:id")
    public async findById(@Param("id") id: string, @Query() query: any, @AuthUser user?: JWTUser): Promise<T | null> {
        const attachment: T | undefined = await this.readable(id, query, user, ACLAction.READ);
        if (!attachment) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return attachment;
    }

    @Head("/:id")
    public async exists(@Param("id") id: string, @Query() query: any, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<any> {
        return (await this.readable(id, query, user, ACLAction.EXISTS))
            ? res.status(200).setHeader("content-length", 1)
            : res.status(404).setHeader("content-length", 0);
    }

    /** 403 unless `user` may perform `action` in `attachment`'s message's current folder - checked before `realign()`,
     * so a refused caller's attempt changes nothing, and so a caller who can write only the folder the message left is
     * refused even though the stored (stale) `folderUid` would let `BaseScopedChildRoute` through. */
    private async requireAccessWhereItIs(attachment: T, user: JWTUser | undefined, action: string): Promise<void> {
        if (!(await this.aclUtils!.hasPermission(user, (await this.locate(attachment)).folderUid, action))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
    }

    /** As `BaseScopedChildRoute.update()` (which `updateBulk()`/`updateProperty()` also reach), checked against where the
     * attachment really is (`requireAccessWhereItIs()`) and after re-stamping it; the client's `folderUid`/`mailboxUid`
     * are dropped - an attachment moves only with its message. (So `BaseScopedChildRoute`'s client-`mailboxUid`
     * enforcement never runs for an attachment, whose `create()` is refused too: its `folderUid`/`mailboxUid` are only
     * ever written from its message, by `upload()` and `realign()`.) */
    @Put("/:id")
    public async update(@Param("id") id: string, obj: UpdateObject<T>, @Request req?: HttpRequest, @AuthUser user?: JWTUser): Promise<T> {
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            delete (obj as any).folderUid;
            delete (obj as any).mailboxUid;
            const existing: T | undefined = await this.repoUtils!.findOne(id, { skipCache: true, ignoreACL: true });
            if (existing) {
                await this.requireAccessWhereItIs(existing, user, ACLAction.UPDATE);
                const realigned: T = await this.realign(existing);
                // The client's copy was current until the re-stamp bumped the version.
                if ((obj as any).version !== undefined && String((obj as any).version) === String((existing as any).version)) {
                    (obj as any).version = (realigned as any).version;
                }
            }
        }
        return super.update(id, obj, req, user);
    }

    /** As `BaseScopedChildRoute.truncate()`, after re-stamping the scope folder's stale attachments, so one whose
     * message has moved out of the folder isn't deleted by a caller who may truncate only the old folder. */
    @Delete()
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        const folderUid: unknown = query?.folderUid;
        if (typeof folderUid === "string" && folderUid && (await this.aclUtils!.hasPermission(user, folderUid, ACLAction.TRUNCATE))) {
            for (let page = 0; ; page++) {
                const rows: T[] = await this.repoUtils!.find({ folderUid: `eq(${folderUid})`, limit: this.folderScanPageSize, page } as any, {
                    limit: this.folderScanPageSize,
                    page,
                    ignoreACL: true,
                });
                for (const row of rows) {
                    await this.realign(row);
                }
                if (rows.length < this.folderScanPageSize) {
                    break;
                }
            }
        }
        return super.truncate(params, query, user);
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

        const created: T = await this.doCreateObject(
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
        await this.syncMessageHasAttachments(message.uid);
        return created;
    }

    /**
     * Sets the message's `hasAttachments` from whether any `Attachment` still references it - the flag clients filter
     * and search by is derived here rather than written by clients (see `BaseMessageRoute`'s server-managed fields).
     * Version-checked and retried on a concurrent write; best-effort (logged) beyond that.
     */
    private async syncMessageHasAttachments(messageUid: string): Promise<void> {
        const messageRepo: RecoverableRepoUtils<M> = await this.getMessageRepo();
        try {
            for (let attempt = 1; ; attempt++) {
                const count: number = await this.repoUtils!.count({ messageUid: `eq(${messageUid})` } as any, { ignoreACL: true });
                // A message deleted meanwhile throws here and is logged below.
                const message: M = (await messageRepo.findOne(messageUid, { ignoreACL: true, skipCache: true }))!;
                if (!!message.hasAttachments === count > 0) {
                    return;
                }
                try {
                    await messageRepo.update(
                        { uid: message.uid, version: (message as any).version, hasAttachments: count > 0 } as any,
                        message,
                        { ignoreACL: true },
                    );
                    return;
                    /* v8 ignore start -- only a concurrent write to the same message reaches here */
                } catch (err: any) {
                    if (attempt >= 3 || err?.status !== 409) {
                        throw err;
                    }
                }
                /* v8 ignore stop */
            }
            /* v8 ignore start -- database failure */
        } catch (err: any) {
            this.logger?.warn(`BaseAttachmentRoute: failed to update hasAttachments on message ${messageUid}: ${err.message}`);
        }
        /* v8 ignore stop */
    }

    /** As `BaseScopedChildRoute.delete()`, then re-derives the owning message's `hasAttachments`. */
    @Delete("/:id")
    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        const existing: T | undefined = await this.repoUtils!.findOne(id, { version, ignoreACL: true });
        // Checked against where it really is (see this class's doc comment) - re-stamped only for a caller who may delete it
        // there, so a refused caller's attempt changes nothing.
        if (existing) {
            await this.requireAccessWhereItIs(existing, user, ACLAction.DELETE);
            const realigned: T = await this.realign(existing);
            version = version !== undefined ? String((realigned as any).version) : undefined;
        }
        await super.delete(id, version, purge, req, user);
        // `super.delete()` has already answered 404 when there was nothing to delete.
        await this.syncMessageHasAttachments(existing!.messageUid);
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

        // Checked against the message's current folder (see this class's doc comment).
        const attachment: T | undefined = await this.readable(id, {}, user, ACLAction.READ);
        if (!attachment) {
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
