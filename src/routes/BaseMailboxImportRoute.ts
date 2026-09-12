///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/mailbox-import-requests")` to its own concrete subclass
// (see `BaseDataExportRoute`/`BaseMailIngestRoute`'s identical note) - every method here is defined
// relative to that.
import * as crypto from "crypto";
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { resolveCallerMailboxUid } from "../util/MailboxScopeUtils.js";
import { AuditAction, Folder, Mailbox, MailboxImportFormat, MailboxImportRequest } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Query, Request, User: AuthUser } = RouteDecorators;

const VALID_FORMATS: ReadonlySet<string> = new Set<MailboxImportFormat>(["mbox", "pst"]);

/**
 * A GDPR data-portability *import* request - the counterpart to `BaseDataExportRoute` - taking an
 * uploaded Mbox or PST file (via `req.rawBody`, the same raw-byte-upload convention
 * `BaseMailIngestRoute.deliver()` uses) and queuing it for `MailboxImportJob` to process. Bespoke class
 * (own `init()`-built `RepoUtils`, no `@Model`-driven CRUD), same permission shape as
 * `BaseDataExportRoute`: visibility is "the requester, the target mailbox's own owner, or a trusted
 * admin" - not a class of grant this platform's record-level ACL model expresses.
 *
 * `create()` is BOTH the self-service and admin-mediated endpoint, per the same "trusted caller may act
 * on someone else's behalf, an ordinary caller's own identity always wins" idiom `BaseDataExportRoute`
 * already establishes for `mailboxUid`.
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

        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        const mailboxUid: string | undefined =
            isTrusted && mailboxUidParam ? mailboxUidParam : await resolveCallerMailboxUid(this.mailboxRepo!, user);
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

    @Get()
    public async find(@AuthUser user?: JWTUser): Promise<T[]> {
        await this.init();
        if (!user) {
            return [];
        }
        if (UserUtils.hasRoles(user, this.trustedRoles)) {
            return await this.requestRepo!.find({}, { ignoreACL: true });
        }
        // A non-trusted caller sees every request they see under `canView()`'s own broader definition
        // (they made it, OR it's for a mailbox they own) - not just ones `requestedByUserUid` names, the
        // same gap `BaseDataExportRoute.find()`'s identical fix documents in full: an admin-mediated
        // request's `requestedByUserUid` is the ADMIN's uid, never the owner's, so filtering by that field
        // alone would leave it invisible to the very owner `findById()` already lets view.
        const ownRequests: T[] = await this.requestRepo!.find({ requestedByUserUid: user.uid } as any, { ignoreACL: true });
        const ownedMailboxes: MB[] = await this.mailboxRepo!.find({ ownerUserUid: user.uid } as any, { ignoreACL: true });
        if (ownedMailboxes.length === 0) {
            return ownRequests;
        }
        const ownedMailboxUids: string[] = ownedMailboxes.map((m) => m.uid);
        const requestsForOwnedMailboxes: T[] = await this.requestRepo!.find(
            { mailboxUid: `in(${ownedMailboxUids.join(",")})` } as any,
            { ignoreACL: true },
        );
        const byUid = new Map<string, T>();
        for (const request of [...ownRequests, ...requestsForOwnedMailboxes]) {
            byUid.set(request.uid, request);
        }
        return Array.from(byUid.values());
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
