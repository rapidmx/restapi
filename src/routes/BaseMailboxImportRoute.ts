///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/mailbox-import-requests")` to its own concrete subclass
// (see `BaseDataExportRoute`/`BaseMailIngestRoute`'s identical note) - every method here is defined
// relative to that.
import * as crypto from "crypto";
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, HttpRequest, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { hasMailAccess } from "../util/MailAccessUtils.js";
import { resolveCallerMailboxUid } from "../util/MailboxScopeUtils.js";
import { parseListPaging } from "../util/RequestListUtils.js";
import { AuditAction, Folder, Mailbox, MailboxImportFormat, MailboxImportRequest } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Query, Request, User: AuthUser } = RouteDecorators;

const VALID_FORMATS: ReadonlySet<string> = new Set<MailboxImportFormat>(["mbox", "pst"]);

/**
 * Default `mail:import:max_bytes` - 200 MiB, an interim number, not a solved problem. Two genuinely separate
 * things are true at once here.
 *
 * `MailboxImportJob`'s own memory footprint for a large PST/Mbox is fixed (see `MailboxImportJob`'s own doc
 * comment on `resolveLocalSourcePath()`) - it now parses directly off a file path with no corresponding
 * in-memory buffer, so a multi-GB *stored* import file no longer OOMs the process during processing.
 *
 * The UPLOAD that gets a file into storage in the first place is NOT fixed: `req.rawBody` is still fully
 * buffered into one Node `Buffer` by `@rapidrest/service-core`'s own HTTP layer before this route (or any
 * route) ever runs, with no way for a route to opt into streaming that body instead - confirmed by reading
 * the framework's own uWS/Bun adapters, not assumed. Fixing this half needs a real streaming API added to
 * `@rapidrest/service-core` itself (tracked separately, out of scope for this route) - a presigned/direct-
 * to-blob-store upload would also work but was deliberately not chosen as a workaround, since a genuine
 * framework fix is the one actually being pursued.
 *
 * Until that lands, whatever this value is set to is moot beyond whatever the deployment's own
 * `max_body_size` (see `FRAMEWORK_DEFAULT_MAX_BODY_SIZE` below) already allows through - whichever is
 * SMALLER is what an uploader will actually experience, and no value here can exceed the buffered-request
 * reality that constrains it. 200 MiB is a deliberately round, comfortably-sized number for what today's
 * buffered upload path can still support without needing an unusually large `max_body_size` override - not
 * a number tuned to sit just under any one reference deployment's own value (a previous version of this
 * constant did that, at 90 MiB, which solved nothing: it just meant EVERY deployment needed as large a
 * `max_body_size` as this route wanted regardless, the same underlying problem from the other direction).
 * `init()` below still logs a one-time warning if an operator's own `mail:import:max_bytes` override ends up
 * at or above whatever `max_body_size` is actually configured - genuinely useful regardless of what number
 * either side settles on, since it flags exactly the "this check can never fire" condition either way. */
export const DEFAULT_MAX_IMPORT_BYTES = 200 * 1024 * 1024;

/** `@rapidrest/service-core`'s own hard-coded fallback for `max_body_size` (`DEFAULT_MAX_BODY_SIZE` in its
 * `http/uWS/Adapters.js`) - used here only as the assumed value when an operator hasn't set `max_body_size`
 * explicitly, so the sanity check in `init()` still has something concrete to compare against. */
const FRAMEWORK_DEFAULT_MAX_BODY_SIZE = 10 * 1024 * 1024;

/**
 * A GDPR data-portability *import* request - the counterpart to `BaseDataExportRoute` - taking an
 * uploaded Mbox or PST file (via `req.rawBody`, the same raw-byte-upload convention
 * `BaseMailIngestRoute.deliver()` uses) and queuing it for `MailboxImportJob` to process. Bespoke class
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
     * own doc comment for why this exists at all. */
    @Config("mail:import:max_bytes", DEFAULT_MAX_IMPORT_BYTES)
    private maxImportBytes: number = DEFAULT_MAX_IMPORT_BYTES;

    /** The framework's own `max_body_size` (see `DEFAULT_MAX_IMPORT_BYTES`'s doc comment) - read here only
     * to sanity-check `maxImportBytes` against it in `init()`, never to enforce anything itself (the
     * framework already enforces its own value before this route ever runs). */
    @Config("max_body_size", FRAMEWORK_DEFAULT_MAX_BODY_SIZE)
    private maxBodySize: number = FRAMEWORK_DEFAULT_MAX_BODY_SIZE;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.requestRepo) {
            // One-time sanity check (this branch only ever runs once per instance, guarded by the same
            // `!this.requestRepo` as the rest of this block's lazy setup): if `mail:import:max_bytes` is
            // configured at or above `max_body_size`, this route's own 413 check can never fire - every
            // oversized upload would already have been rejected by the framework first, silently making
            // the operator's configured `mail:import:max_bytes` meaningless. See `DEFAULT_MAX_IMPORT_BYTES`.
            if (this.maxImportBytes >= this.maxBodySize) {
                this.logger?.warn(
                    `BaseMailboxImportRoute: mail:import:max_bytes (${this.maxImportBytes}) is >= max_body_size ` +
                        `(${this.maxBodySize}) - the framework will reject oversized uploads before this route's own ` +
                        `check can ever run, making mail:import:max_bytes ineffective. Configure it below max_body_size.`,
                );
            }
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

    @Post()
    public async create(
        @Request req: HttpRequest,
        @Query("targetFolderUid") targetFolderUid: string | undefined,
        @Query("format") format: MailboxImportFormat | undefined,
        @Query("mailboxUid") mailboxUidParam: string | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        await this.init();
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        if (!this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        if (!format || !VALID_FORMATS.has(format)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "format must be one of: mbox, pst.");
        }
        if (!targetFolderUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "targetFolderUid is required.");
        }
        const raw: Buffer | undefined = req.rawBody;
        if (!raw || raw.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        // Checked before any other work (DB lookups, the blob write) - rejects an oversized upload up front
        // rather than after paying for the rest of this handler, though `req.rawBody` is already fully
        // buffered into memory by the time this handler runs at all (a framework-level concern, not this
        // route's - see `DEFAULT_MAX_IMPORT_BYTES`'s own doc comment for the real risk this closes: what
        // `MailboxImportJob` does with the upload afterward).
        if (raw.length > this.maxImportBytes) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 413, `The uploaded file is larger than the ${this.maxImportBytes} bytes allowed.`);
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

        const sourceBlobKey = `mailbox-imports/${crypto.randomUUID()}`;
        await this.blobStore.put(sourceBlobKey, raw, {
            contentType: format === "pst" ? "application/vnd.ms-outlook" : "application/mbox",
        });

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
        if (ownedMailboxUids.length > 0) {
            visible.push({ mailboxUid: `in(${ownedMailboxUids.join(",")})` });
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
