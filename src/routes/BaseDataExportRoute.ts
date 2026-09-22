///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/data-export-requests")` to its own concrete subclass
// (see `BaseMailIngestRoute`/`BaseKeyVaultRoute`'s identical note) - every method here is defined
// relative to that.
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpResponse, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { resolveCallerMailboxUid } from "../util/MailboxScopeUtils.js";
import { parseListPaging } from "../util/RequestListUtils.js";
import { AuditAction, DataExportFormat, DataExportRequest, Mailbox } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Query, Response, User: AuthUser } = RouteDecorators;

const VALID_FORMATS: ReadonlySet<string> = new Set<DataExportFormat>(["json", "mbox"]);

/**
 * A GDPR data-portability/access request for one mailbox's content (see `DataExportRequest`'s own doc
 * comment) - a bespoke class (own `init()`-built `RepoUtils`, no `@Model`-driven CRUD), same shape as
 * `BaseEscrowAccessRequestRoute`: creation resolves and validates a mailbox, `find`/`findById`/
 * `download` are permission-scoped by hand rather than through the generic ACL system, since visibility
 * here is "the requester, the mailbox's own owner, or a trusted admin" - not a class of ACL grant this
 * platform's record-level ACL model expresses.
 *
 * `create()` is BOTH the self-service and admin-mediated endpoint, per the same "trusted caller may act
 * on someone else's behalf, an ordinary caller's own identity always wins" idiom
 * `BaseMailboxRoute.create()` already establishes for `ownerUserUid`: a non-trusted caller's own
 * mailbox is used regardless of what `mailboxUid` they send (if any); only a trusted caller's supplied
 * `mailboxUid` is honored.
 *
 * **This is one of the few things designed to cross mailboxes** (a data-subject access request handled by an
 * administrator): a trusted caller can export - and download the archive of - ANY mailbox's content. It is its own
 * explicit request workflow, not a way in through the mail routes: the request (`DATA_EXPORT_REQUESTED`) and every
 * download by somebody who is not the mailbox owner (`DATA_EXPORT_DOWNLOADED`) are audited.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseDataExportRoute<T extends DataExportRequest, MB extends Mailbox> {
    protected abstract dataExportRequestClass: any;
    protected abstract mailboxClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so this route can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    protected trustedRoles: string[] = ["admin"];

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private requestRepo?: RepoUtils<T>;
    private mailboxRepo?: RepoUtils<MB>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.requestRepo) {
            this.requestRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.dataExportRequestClass.name,
                args: [this.dataExportRequestClass],
            });
        }
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
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
     * mailbox's owner (an admin may have requested an export on an owner's behalf - the owner can still
     * see/download it themselves). */
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
    public async create(body: { mailboxUid?: string; format: DataExportFormat }, @AuthUser user?: JWTUser): Promise<T> {
        await this.init();
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        if (!VALID_FORMATS.has(body?.format)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "format must be one of: json, mbox.");
        }
        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        const mailboxUid: string | undefined =
            isTrusted && body.mailboxUid ? body.mailboxUid : await resolveCallerMailboxUid(this.mailboxRepo!, user);
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const mailbox: MB | undefined = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        const created: T = await this.requestRepo!.create(
            new this.dataExportRequestClass({ mailboxUid, requestedByUserUid: user.uid, format: body.format, status: "pending" }),
            { ignoreACL: true },
        );
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.DATA_EXPORT_REQUESTED, targetType: "DataExportRequest", targetUid: created.uid, mailboxUid },
        );
        return created;
    }

    /** A non-trusted caller sees every request they see under `canView()`'s own broader definition (they
     * made it, OR it's for a mailbox they own) - not just ones `requestedByUserUid` names. An admin-
     * mediated request's `requestedByUserUid` is the ADMIN's uid, never the owner's, so filtering by that
     * field alone would leave an admin-initiated request invisible to the very owner `findById()`/
     * `download()` already let view/download, the moment they learned its uid some other way (there is no
     * notification path) - this endpoint's own contract (this class's doc comment: "an admin may have
     * requested an export on an owner's behalf - the owner can still see/download it themselves") is
     * otherwise silently broken for the one entry point meant to let them discover it exists at all. */
    @Get()
    public async find(@Query("limit") limitParam: unknown, @Query("page") pageParam: unknown, @AuthUser user?: JWTUser): Promise<T[]> {
        await this.init();
        // Newest first, `?limit=` (default 100, at most 500) / `?page=` (0-based) - see `util/RequestListUtils.ts`.
        const { limit, page } = parseListPaging({ limit: limitParam, page: pageParam });
        if (!user) {
            return [];
        }
        const paging = { sort: "-dateCreated", limit, page };
        if (UserUtils.hasRoles(user, this.trustedRoles)) {
            return await this.requestRepo!.find(paging as any, { ignoreACL: true, limit, page });
        }
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

    @Get("/:id/download")
    public async download(@Param("id") id: string, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<void> {
        await this.init();
        if (!this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const request: T = await this.requireRequest(id);
        if (!(await this.canView(request, user))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        if (request.status !== "ready" || !request.blobKey) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "This export is not ready for download yet.");
        }

        const content: Buffer = await this.blobStore.get(request.blobKey);
        const extension = request.format === "mbox" ? "mbox" : "ndjson";
        const owner: MB | undefined = await this.mailboxRepo!.findOne(request.mailboxUid, { ignoreACL: true });
        if (!owner || (owner as any).ownerUserUid !== user!.uid) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, user, logger: this.logger },
                {
                    action: AuditAction.DATA_EXPORT_DOWNLOADED,
                    targetType: "DataExportRequest",
                    targetUid: request.uid,
                    mailboxUid: request.mailboxUid,
                },
            );
        }
        res.setHeader("content-type", request.format === "mbox" ? "application/mbox" : "application/x-ndjson");
        res.setHeader("content-disposition", `attachment; filename="mailbox-export-${request.mailboxUid}.${extension}"`);
        res.send(content);
    }
}
