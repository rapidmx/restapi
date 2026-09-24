///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/mailbox-import-requests")` to its own concrete subclass
// (see `BaseDataExportRoute`/`BaseMailIngestRoute`'s identical note) - every method here is defined
// relative to that.
import * as crypto from "crypto";
import { Readable } from "stream";
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, HttpRequest, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { exactInFilter } from "../util/EscrowUtils.js";
import { hasMailAccess } from "../util/MailAccessUtils.js";
import { resolveCallerMailboxUid } from "../util/MailboxScopeUtils.js";
import { parseListPaging } from "../util/RequestListUtils.js";
import { AuditAction, Folder, Mailbox, MailboxImportFormat, MailboxImportRequest } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Query, Request, StreamingBody, User: AuthUser } = RouteDecorators;

const VALID_FORMATS: ReadonlySet<string> = new Set<MailboxImportFormat>(["mbox", "pst"]);

/**
 * Default `mail:import:max_bytes` - 50 GiB. `create()` is now registered with `@StreamingBody()`
 * (`@rapidrest/service-core` 2.2.0+ - see its `RELEASE_NOTES.md`'s "v2.2.0" entry), so the upload itself is
 * no longer buffered into one Node `Buffer` before this route runs: `req.bodyStream` is consumed and piped
 * straight into `BlobStore.put()` (see `create()`'s own doc comment), which both `LocalFsBlobStore` and
 * `S3BlobStore` already stream to their own backing store rather than holding it all in memory either. That
 * was the actual constraint the previous 90 MiB, then 200 MiB, "interim" values existed to work around
 * (`req.rawBody`/`max_body_size` capping what a buffered upload path could survive) - it no longer applies,
 * so this value can finally reflect the real-world size of the files this route exists to accept: a genuine
 * 20GB+, never-archived PST is not unusual. 50 GiB is a deliberately generous ceiling with headroom above
 * that, not a number tuned to sit just under some other constraint the way the previous two were.
 *
 * This is enforced DURING the stream, not against an already-buffered length: a `Content-Length` header (when
 * the client sends one) is checked up front, before `req.bodyStream` is touched at all or any mailbox/folder
 * lookup runs - `create()`'s existing "before any mailbox/folder lookup or blob write" ordering, unchanged.
 * Independently, a running byte count kept while consuming `req.bodyStream` aborts the upload (cleaning up
 * the partial blob) the moment it's exceeded, so a client that lies about (or omits) `Content-Length` is
 * still bounded to `maxImportBytes` - never however much memory or disk it manages to send before the
 * connection is cut. `MailboxImportJob` (see its own doc comment on `resolveLocalSourcePath()`) processes
 * whatever is accepted here with a bounded footprint regardless of its size, so this ceiling exists only to
 * cap disk usage and upload duration, not to protect process memory the way the old buffered-path values had
 * to. */
export const DEFAULT_MAX_IMPORT_BYTES = 50 * 1024 * 1024 * 1024;

/** Parses an HTTP `Content-Length` header value (as `HttpRequest.headers` may hand it back - a single
 * string, an array from a proxy that split/duplicated it, or absent entirely) into a byte count. Returns
 * `undefined` for anything absent or unparseable - callers must treat that as "length unknown," never as 0,
 * since a chunked-transfer-encoded request legitimately sends no `Content-Length` at all. */
function parseContentLength(value: string | string[] | undefined): number | undefined {
    const raw: string | undefined = Array.isArray(value) ? value[0] : value;
    if (raw === undefined) {
        return undefined;
    }
    const parsed: number = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Largest request body `create()` will read-and-discard before answering a rejected upload - see `discardSmallBody()`. */
const MAX_DISCARDED_BODY_BYTES = 1024 * 1024;
/** Longest `discardSmallBody()` will wait on a client that stalls mid-body before giving up and answering anyway. */
const DISCARD_BODY_TIMEOUT_MS = 5_000;

/**
 * Reads and throws away whatever remains of a rejected upload's request body, so the error `create()` is about to
 * throw actually reaches the client. `@rapidrest/service-core` 2.3.0+ force-closes the connection of a
 * `@StreamingBody()` route that responds before uWS has received the entire declared body (a defence against a
 * client that declares a huge `Content-Length` and never sends it) - which, for a route that rejects before ever
 * touching `req.bodyStream` (a 400/403/404/413 from the checks ahead of the blob write), means the client sees a
 * bare `ECONNRESET` / "socket hang up" instead of the JSON error. Draining lets a small (or already-arrived) body
 * finish so the response goes out gracefully.
 *
 * Bounded on purpose - this must never turn a rejection into the very multi-GB read the streaming upload exists to
 * avoid buffering: nothing is read at all when `Content-Length` declares more than `MAX_DISCARDED_BODY_BYTES`, and
 * for a chunked (undeclared-length) body reading stops once that many bytes have gone by, or after
 * `DISCARD_BODY_TIMEOUT_MS`. In each of those cases the framework's forced close applies, as it should for an
 * upload nobody is going to finish sending.
 */
async function discardSmallBody(stream: Readable | undefined, declaredLength: number | undefined): Promise<void> {
    if (!stream || stream.destroyed || stream.readableEnded) {
        return;
    }
    if (declaredLength !== undefined && declaredLength > MAX_DISCARDED_BODY_BYTES) {
        return;
    }
    await new Promise<void>((resolve) => {
        let discarded = 0;
        const timer: NodeJS.Timeout = setTimeout(finish, DISCARD_BODY_TIMEOUT_MS);
        function onData(chunk: Buffer | string): void {
            discarded += chunk.length;
            if (discarded > MAX_DISCARDED_BODY_BYTES) {
                finish();
            }
        }
        function finish(): void {
            clearTimeout(timer);
            stream!.off("data", onData);
            stream!.off("end", finish);
            stream!.off("error", finish);
            stream!.off("close", finish);
            resolve();
        }
        stream.on("data", onData);
        stream.once("end", finish);
        stream.once("error", finish);
        stream.once("close", finish);
    });
}

/**
 * Wraps `source` (`create()`'s `req.bodyStream`) in a new `Readable` that passes every chunk through
 * unchanged but destroys itself - and, since `for await` propagates a thrown error back into `source`'s own
 * consumption, `source` too - the moment the running total exceeds `maxBytes`, rather than only being able
 * to tell the upload was oversized after buffering the whole thing first. `total()`/`exceeded()` let the
 * caller distinguish an intentional size-limit abort from a genuine downstream failure (e.g. the client
 * disconnecting mid-upload) after `BlobStore.put()` rejects - from the outside, both just look like the
 * stream it was reading from erroring.
 */
function withByteLimit(source: Readable, maxBytes: number): { stream: Readable; total: () => number; exceeded: () => boolean } {
    let total = 0;
    let exceeded = false;
    const stream: Readable = Readable.from(
        (async function* (): AsyncGenerator<Buffer> {
            for await (const chunk of source) {
                const buffer: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += buffer.length;
                if (total > maxBytes) {
                    exceeded = true;
                    throw new Error(`mailbox import upload exceeded the ${maxBytes}-byte limit mid-stream`);
                }
                yield buffer;
            }
        })(),
    );
    return { stream, total: () => total, exceeded: () => exceeded };
}

/**
 * A GDPR data-portability *import* request - the counterpart to `BaseDataExportRoute` - taking an
 * uploaded Mbox or PST file (via `req.bodyStream`, a genuine stream - see `create()`'s own doc comment; NOT
 * the `req.rawBody` raw-byte-upload convention `BaseMailIngestRoute.deliver()` uses, deliberately, given how
 * large a real upload here can be) and queuing it for `MailboxImportJob` to process. Bespoke class
 * (own `init()`-built `RepoUtils`, no `@Model`-driven CRUD), same permission shape as
 * `BaseDataExportRoute`: visibility is "the requester, the target mailbox's own owner, or a trusted
 * admin" - not a class of grant this platform's record-level ACL model expresses.
 *
 * `create()` imports into the caller's own mailbox (an ordinary caller's `?mailboxUid=` is ignored, as before); a trusted
 * caller's `?mailboxUid=` is honored only when they hold CREATE on it (by ownership or an ACL record - a trusted role is no
 * grant: importing plants mail in somebody's mailbox, so an administrator does it by impersonating the owner; 403 otherwise). `find()`/`findById()` show a trusted caller every request - who imported
 * what into which mailbox, and how it went; never the imported content.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMailboxImportRoute<T extends MailboxImportRequest, MB extends Mailbox, F extends Folder> {
    protected abstract mailboxImportRequestClass: any;
    protected abstract mailboxClass: any;
    protected abstract folderClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so this route can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    protected trustedRoles: string[] = ["admin"];

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private requestRepo?: RepoUtils<T>;
    private mailboxRepo?: RepoUtils<MB>;
    private folderRepo?: RepoUtils<F>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    /** The largest source file `create()` accepts, in bytes (413 beyond) - see `DEFAULT_MAX_IMPORT_BYTES`'s
     * own doc comment for why this exists at all, and `create()`'s own doc comment for exactly how it's
     * enforced against a streamed (not buffered) upload. */
    @Config("mail:import:max_bytes", DEFAULT_MAX_IMPORT_BYTES)
    private maxImportBytes: number = DEFAULT_MAX_IMPORT_BYTES;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.requestRepo) {
            this.requestRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxImportRequestClass.name,
                args: [this.mailboxImportRequestClass],
            });
        }
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.folderRepo) {
            this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.folderClass.name,
                args: [this.folderClass],
            });
        }
    }

    private async requireRequest(id: string): Promise<T> {
        const request: T | undefined = await this.requestRepo!.findOne(id, { ignoreACL: true });
        if (!request) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return request;
    }

    /** `true` for a trusted admin, the caller who created the request, or the request's own target
     * mailbox's owner (an admin may have started an import on an owner's behalf - the owner can still
     * see its progress themselves). */
    private async canView(request: T, user: JWTUser | undefined): Promise<boolean> {
        if (!user) {
            return false;
        }
        if (UserUtils.hasRoles(user, this.trustedRoles) || request.requestedByUserUid === user.uid) {
            return true;
        }
        const mailbox: MB | undefined = await this.mailboxRepo!.findOne(request.mailboxUid, { ignoreACL: true });
        return !!mailbox && (mailbox as any).ownerUserUid === user.uid;
    }

    /**
     * `@StreamingBody()` (`@rapidrest/service-core` 2.2.0+) means `req.bodyStream` (a Node `Readable`) is
     * populated instead of `req.body`/`req.rawBody` - the framework never buffers this route's upload into
     * memory at all, and (per `@StreamingBody()`'s own doc comment) skips its own `max_body_size` 413
     * rejection entirely for this route, leaving size enforcement to this method alone. NOT combinable with
     * `@Validate`/`before`/`after` expecting `req.body` - moot here, since this class never used any of
     * those in the first place; every check has always lived in this method's own body, unaffected by the
     * switch to a streamed body.
     *
     * Validates format/targetFolderUid, a `Content-Length` (when the client sends one) up front against
     * `maxImportBytes` - before `req.bodyStream` is touched, or any mailbox/folder lookup runs, same
     * ordering `create()` has always had - then resolves and validates the target mailbox/folder (still with
     * no upload cost). A cheap, read-only quota gate runs next: rejected outright if the target mailbox is
     * already at/over its `quotaBytes`, and `Content-Length` (when sent) is also checked against whatever
     * quota remains - neither of these is a real charge, just a sanity check against the mailbox's own
     * already-fetched row (see the inline comment above `quotaBytes`/`usedBytes` below for why the real,
     * accurate charge stays exclusively `MailboxImportJob`'s own, per extracted message). Only then is
     * `req.bodyStream` finally consumed: piped through a small byte-counting wrapper straight into
     * `this.blobStore.put()` (both `LocalFsBlobStore` and `S3BlobStore` already stream a
     * `NodeJS.ReadableStream` argument to their own backing store, never buffering it into memory either),
     * aborting mid-stream - and cleaning up the partial blob - the moment the running count exceeds
     * whichever of `maxImportBytes`/the mailbox's remaining quota is smaller, regardless of what
     * `Content-Length` claimed or whether one was sent at all. An empty upload (no bytes ever counted) is
     * rejected the same way `Content-Length: 0` already is, just discovered at the end of the stream instead
     * of before it starts.
     */
    @Post()
    @StreamingBody()
    public async create(
        @Request req: HttpRequest,
        @Query("targetFolderUid") targetFolderUid: string | undefined,
        @Query("format") format: MailboxImportFormat | undefined,
        @Query("mailboxUid") mailboxUidParam: string | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        await this.init();
        let target: { mailboxUid: string; remainingQuota: number };
        try {
            target = await this.resolveUploadTarget(req, targetFolderUid, format, mailboxUidParam, user);
        } catch (err: any) {
            // Every rejection ahead of the blob write funnels through here - see `discardSmallBody()` for why the
            // (small) unread body has to be dealt with before the error can reach the client at all.
            await discardSmallBody(req.bodyStream, parseContentLength(req.headers["content-length"]));
            throw err;
        }
        const { mailboxUid, remainingQuota } = target;
        return await this.storeUpload(req.bodyStream!, targetFolderUid!, format!, mailboxUid, remainingQuota, user!);
    }

    /**
     * Everything `create()` checks before a single byte of `req.bodyStream` is consumed: the caller, format,
     * `targetFolderUid`, `Content-Length` and mailbox/folder/quota gates described on `create()` itself. Returns
     * the resolved target mailbox and how much quota it has left, or throws the `ApiError` `create()` answers with.
     */
    private async resolveUploadTarget(
        req: HttpRequest,
        targetFolderUid: string | undefined,
        format: MailboxImportFormat | undefined,
        mailboxUidParam: string | undefined,
        user: JWTUser | undefined,
    ): Promise<{ mailboxUid: string; remainingQuota: number }> {
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        if (!this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        if (!req.bodyStream) {
            // Should be unreachable in production - `@StreamingBody()` always populates this for a POST -
            // but the framework technically declares it optional, so this is defensive, not dead code.
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        if (!format || !VALID_FORMATS.has(format)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "format must be one of: mbox, pst.");
        }
        if (!targetFolderUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "targetFolderUid is required.");
        }
        // Free (no stream reads at all) whenever the client sends a Content-Length - which every real
        // browser/HTTP-client upload of a known-size file does; only a chunked-transfer-encoded request
        // with no declared length skips straight to the running-count check below instead.
        const declaredLength: number | undefined = parseContentLength(req.headers["content-length"]);
        if (declaredLength !== undefined) {
            if (declaredLength === 0) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
            }
            if (declaredLength > this.maxImportBytes) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 413, `The uploaded file is larger than the ${this.maxImportBytes} bytes allowed.`);
            }
        }

        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        let mailboxUid: string | undefined = await resolveCallerMailboxUid(this.mailboxRepo!, user);
        if (isTrusted && mailboxUidParam && mailboxUidParam !== mailboxUid) {
            // A trusted caller's own choice of mailbox is honored only with a grant on it - a trusted role is no grant, so an
            // administrator imports into somebody else's mailbox by impersonating them (403 otherwise, whether or not it exists).
            if (typeof mailboxUidParam !== "string" || !(await hasMailAccess(this.aclUtils, this.trustedRoles, user, mailboxUidParam, ACLAction.CREATE))) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
            }
            mailboxUid = mailboxUidParam;
        }
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const mailbox: MB | undefined = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const folder: F | undefined = await this.folderRepo!.findOne(targetFolderUid, { ignoreACL: true });
        if (!folder || folder.mailboxUid !== mailboxUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "targetFolderUid must name a folder belonging to the target mailbox.");
        }
        // A cheap, read-only, upfront sanity gate - NOT a charge (nothing is written to `usedBytes` here,
        // and never will be by this method): `MailboxImportJob.persistImportedMessage()` remains the one
        // place that actually charges quota, per extracted message, once real content sizes are known (an
        // uploaded PST's raw byte count has no fixed relationship to its eventual reconstructed message
        // sizes, so charging against the raw upload here would double-count against that later, accurate
        // charge, not merely approximate it). This exists only to stop the "obviously already over quota"
        // case from streaming a pointless multi-GB upload before the first per-message charge, days later
        // (this job runs on its own schedule), would have rejected it anyway - see this class's own doc
        // comment on `DEFAULT_MAX_IMPORT_BYTES`.
        const quotaBytes: number = mailbox.quotaBytes ?? 0;
        const usedBytes: number = mailbox.usedBytes ?? 0;
        if (quotaBytes > 0 && usedBytes >= quotaBytes) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 413, "This mailbox has reached its storage quota.");
        }
        // `Infinity` when unlimited (`quotaBytes <= 0`) or not yet provisioned - `Math.min()` below then just
        // reduces to `maxImportBytes` alone, the same as if this mailbox had no quota check applied at all.
        const remainingQuota: number = quotaBytes > 0 ? Math.max(0, quotaBytes - usedBytes) : Infinity;
        if (declaredLength !== undefined && declaredLength > remainingQuota) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 413, "This mailbox does not have enough remaining storage quota for a file this large.");
        }
        return { mailboxUid, remainingQuota };
    }

    /**
     * The part of `create()` that finally consumes `bodyStream`: streams it into the blob store under the smaller of
     * `maxImportBytes`/`remainingQuota`, then queues the `MailboxImportRequest` for `MailboxImportJob`. Any failure
     * here has already consumed (or destroyed) the stream, so unlike `resolveUploadTarget()`'s rejections there's
     * nothing left to discard before answering.
     */
    private async storeUpload(
        bodyStream: Readable,
        targetFolderUid: string,
        format: MailboxImportFormat,
        mailboxUid: string,
        remainingQuota: number,
        user: JWTUser,
    ): Promise<T> {
        const sourceBlobKey = `mailbox-imports/${crypto.randomUUID()}`;
        // The SMALLER of the two ceilings applies - still just one running byte count, `withByteLimit()`
        // itself has no notion of "why" its limit is what it is (see the quota pre-check above for why this
        // is a coarse mid-stream sanity bound, not a real charge).
        const effectiveMaxBytes: number = Math.min(this.maxImportBytes, remainingQuota);
        const quotaIsTighterLimit: boolean = remainingQuota < this.maxImportBytes;
        const counted = withByteLimit(bodyStream, effectiveMaxBytes);
        try {
            await this.blobStore!.put(sourceBlobKey, counted.stream, {
                contentType: format === "pst" ? "application/vnd.ms-outlook" : "application/mbox",
            });
        } catch (err: any) {
            await this.blobStore!.delete(sourceBlobKey).catch(() => undefined);
            if (counted.exceeded()) {
                if (quotaIsTighterLimit) {
                    throw new ApiError(ApiErrors.INVALID_REQUEST, 413, "This mailbox does not have enough remaining storage quota for a file this large.");
                }
                throw new ApiError(ApiErrors.INVALID_REQUEST, 413, `The uploaded file is larger than the ${this.maxImportBytes} bytes allowed.`);
            }
            throw err;
        }
        if (counted.total() === 0) {
            await this.blobStore!.delete(sourceBlobKey).catch(() => undefined);
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const created: T = await this.requestRepo!.create(
            new this.mailboxImportRequestClass({
                mailboxUid,
                requestedByUserUid: user.uid,
                targetFolderUid,
                format,
                sourceBlobKey,
                status: "pending",
            }),
            { ignoreACL: true },
        );
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.MAILBOX_IMPORT_REQUESTED, targetType: "MailboxImportRequest", targetUid: created.uid, mailboxUid },
        );
        return created;
    }

    /** Newest first; `?limit=` (default 100, at most 500) and `?page=` (0-based) page through the list - see
     * `util/RequestListUtils.ts`. */
    @Get()
    public async find(@Query("limit") limitParam: unknown, @Query("page") pageParam: unknown, @AuthUser user?: JWTUser): Promise<T[]> {
        await this.init();
        const { limit, page } = parseListPaging({ limit: limitParam, page: pageParam });
        if (!user) {
            return [];
        }
        const paging = { sort: "-dateCreated", limit, page };
        if (UserUtils.hasRoles(user, this.trustedRoles)) {
            return await this.requestRepo!.find(paging as any, { ignoreACL: true, limit, page });
        }
        // A non-trusted caller sees every request they see under `canView()`'s own broader definition
        // (they made it, OR it's for a mailbox they own) - not just ones `requestedByUserUid` names, the
        // same gap `BaseDataExportRoute.find()`'s identical fix documents in full: an admin-mediated
        // request's `requestedByUserUid` is the ADMIN's uid, never the owner's, so filtering by that field
        // alone would leave it invisible to the very owner `findById()` already lets view.
        // One query (`$or`) rather than two merged lists, so a page is a real page of the combined set.
        const ownedMailboxUids: string[] = (await this.mailboxRepo!.find({ ownerUserUid: `eq(${user.uid})` } as any, { ignoreACL: true })).map(
            (m) => m.uid,
        );
        const visible: any[] = [{ requestedByUserUid: `eq(${user.uid})` }];
        // `exactInFilter()`, not a raw `in(${...join(",")})`: `ModelUtils.splitListOperand()` splits an
        // `in(...)` operand on unescaped commas, so a client-chosen mailbox `uid` containing one (nothing
        // strips `uid` on `BaseMailboxRoute.create()` today) could otherwise widen this filter to match a
        // mailbox its owner never listed here at all - see `BaseDataExportRoute.find()`'s identical fix.
        const ownedMailboxFilter: string | undefined = exactInFilter(ownedMailboxUids);
        if (ownedMailboxFilter) {
            visible.push({ mailboxUid: ownedMailboxFilter });
        }
        return await this.requestRepo!.find({ $or: visible, ...paging } as any, { ignoreACL: true, limit, page });
    }

    @Get("/:id")
    public async findById(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<T> {
        await this.init();
        const request: T = await this.requireRequest(id);
        if (!(await this.canView(request, user))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        return request;
    }
}
