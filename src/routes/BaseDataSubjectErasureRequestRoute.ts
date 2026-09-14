///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/erasure-requests")` to its own concrete subclass (see
// `BaseDataExportRoute`/`BaseMailIngestRoute`'s identical note) - every method here is defined relative to
// that.
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { assertNotOnLegalHold } from "../util/LegalHoldUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { resolveCallerMailboxUid } from "../util/MailboxScopeUtils.js";
import { parseListPaging } from "../util/RequestListUtils.js";
import { AuditAction, DataSubjectErasureRequest, Mailbox } from "../models/types.js";
const { Config, Logger } = ObjectDecorators;
const { Get, Param, Post, Query, RequiresTrustedRole, User: AuthUser } = RouteDecorators;

/**
 * A GDPR Article 17 ("right to erasure") request - see `DataSubjectErasureRequest`'s own doc comment for
 * why `create()` is self-service only (no admin-on-behalf-of path, unlike `BaseDataExportRoute`/
 * `BaseMailboxImportRoute`) and why the actual destructive cascade happens in `ErasureExecutionJob`
 * rather than synchronously here. Bespoke class (own `init()`-built `RepoUtils`, no `@Model`-driven CRUD),
 * same permission shape as `BaseDataExportRoute`: visibility is "the requester, the target mailbox's own
 * owner, or a trusted admin".
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseDataSubjectErasureRequestRoute<T extends DataSubjectErasureRequest, MB extends Mailbox> {
    protected abstract dataSubjectErasureRequestClass: any;
    protected abstract mailboxClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `approve()` can resolve the target mailbox's
     * legal-hold status without depending on either backend directly - see `util/LegalHoldUtils.ts`. */
    protected abstract matterClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so this route can persist an `AuditLogEntry` without
     * depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    protected trustedRoles: string[] = ["admin"];

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private requestRepo?: RepoUtils<T>;
    private mailboxRepo?: RepoUtils<MB>;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.requestRepo) {
            this.requestRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.dataSubjectErasureRequestClass.name,
                args: [this.dataSubjectErasureRequestClass],
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
     * mailbox's owner. */
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
    public async create(@AuthUser user?: JWTUser): Promise<T> {
        await this.init();
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        const mailboxUid: string | undefined = await resolveCallerMailboxUid(this.mailboxRepo!, user);
        if (!mailboxUid) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const alreadyInFlight: T[] = await this.requestRepo!.find({ mailboxUid, status: "pending" } as any, { ignoreACL: true, limit: 1 });
        if (alreadyInFlight.length > 0) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "An erasure request for this mailbox is already pending review.");
        }

        const created: T = await this.requestRepo!.create(
            new this.dataSubjectErasureRequestClass({ mailboxUid, requestedByUserUid: user.uid, status: "pending" }),
            { ignoreACL: true },
        );

        // The check above and this row's own creation are not atomic - this codebase has no existing
        // precedent for a partial-unique-index scoped to `status = "pending"` (every other unique index
        // in this codebase is unconditional on its column set, which would incorrectly block a legitimate
        // second request after an earlier one was denied), so a genuinely raced double-submit for the SAME
        // mailbox could still create two independent pending rows. Narrows (rather than eliminates) that
        // window: if another pending request for this mailbox now also exists, the earlier of the two
        // (by creation time) wins and this call's own row is immediately superseded instead of being left
        // to sit alongside it as a second, redundant in-flight request a trusted admin could independently
        // approve, queuing the mailbox for `ErasureExecutionJob` twice.
        const stillPending: T[] = await this.requestRepo!.find({ mailboxUid, status: "pending" } as any, { ignoreACL: true, limit: 2 });
        if (stillPending.length > 1) {
            const [winner] = [...stillPending].sort((a, b) => new Date(a.dateCreated).getTime() - new Date(b.dateCreated).getTime());
            if (winner.uid !== created.uid) {
                await this.requestRepo!.update(
                    {
                        uid: created.uid,
                        version: (created as any).version,
                        status: "denied",
                        reviewedByUserUid: created.requestedByUserUid,
                        reason: "Superseded by an earlier concurrent erasure request for the same mailbox.",
                    } as any,
                    created,
                    { ignoreACL: true },
                );
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "An erasure request for this mailbox is already pending review.");
            }
        }

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.ERASURE_REQUEST_CREATED, targetType: "DataSubjectErasureRequest", targetUid: created.uid, mailboxUid },
        );
        return created;
    }

    @RequiresTrustedRole()
    @Post("/:id/approve")
    public async approve(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<T> {
        await this.init();
        const request: T = await this.requireRequest(id);
        if (request.status !== "pending") {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This request is not pending review.");
        }
        // 409 (citing the blocking Matter) if held - the correct GDPR Article 17(3) behavior, not a
        // failure to route around. `ErasureExecutionJob` re-checks this again immediately before the
        // actual cascade, since a hold can be placed in the gap between this approval and that job run.
        await assertNotOnLegalHold(this._objectFactory!, this.matterClass, request.mailboxUid);

        const updated: T = await this.requestRepo!.update(
            { uid: request.uid, version: (request as any).version, status: "approved", reviewedByUserUid: user!.uid } as any,
            request,
            { ignoreACL: true },
        );
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.ERASURE_REQUEST_APPROVED, targetType: "DataSubjectErasureRequest", targetUid: updated.uid, mailboxUid: updated.mailboxUid },
        );
        return updated;
    }

    @RequiresTrustedRole()
    @Post("/:id/deny")
    public async deny(@Param("id") id: string, body: { reason?: string }, @AuthUser user?: JWTUser): Promise<T> {
        await this.init();
        if (!body?.reason) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "reason is required.");
        }
        const request: T = await this.requireRequest(id);
        if (request.status !== "pending") {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This request is not pending review.");
        }

        const updated: T = await this.requestRepo!.update(
            { uid: request.uid, version: (request as any).version, status: "denied", reviewedByUserUid: user!.uid, reason: body.reason } as any,
            request,
            { ignoreACL: true },
        );
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.ERASURE_REQUEST_DENIED, targetType: "DataSubjectErasureRequest", targetUid: updated.uid, mailboxUid: updated.mailboxUid },
        );
        return updated;
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
        return await this.requestRepo!.find({ requestedByUserUid: `eq(${user.uid})`, ...paging } as any, { ignoreACL: true, limit, page });
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
