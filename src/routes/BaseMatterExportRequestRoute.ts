///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/matter-export-requests")` to its own concrete subclass
// (see `BaseDataExportRoute`/`BaseMailIngestRoute`'s identical note) - every method here is defined
// relative to that. Deliberately its own top-level collection rather than nested under `/matters/:id/
// export` (the plan's own first-draft wording) - every other async-request resource this roadmap added
// (`DataExportRequest`/`MailboxImportRequest`/`DataSubjectErasureRequest`) already lives at its own
// dedicated collection with independent find/findById/download, and a request a holder may want to list
// or re-download later deserves the same treatment here rather than a one-off nested action route.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, HttpResponse, ModelUtils, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { EscrowAuditUtils } from "../util/EscrowAuditUtils.js";
import { exactInFilter, findHeldScopeIds, requireEscrowHolder } from "../util/EscrowUtils.js";
import { parseListPaging } from "../util/RequestListUtils.js";
import { AuditAction, EscrowAuditAction, EscrowScope, Mailbox, Matter, MatterExportRequest } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Query, RateLimit, Request, Response, User: AuthUser } = RouteDecorators;

/** `create()` is limited per user: each request queues a whole-mailbox export of every custodian and writes a ledger entry for each. */
const CREATE_MAX_ATTEMPTS: number = 10;
const CREATE_WINDOW_SECONDS: number = 3600;

/** Page size for reading every matter under the caller's held scopes - see `find()`. */
const MATTER_PAGE_SIZE = 500;

/**
 * A holder-invoked eDiscovery export spanning a `Matter`'s full custodian set - see
 * `MatterExportRequest`'s own doc comment for why this needs no dual-control approval (unlike
 * `BaseEscrowAccessRequestRoute`) and why only a `"json"` bundle format is offered. Bespoke class (own
 * `@Init`-built `RepoUtils`, no `@Model`-driven CRUD), same shape as `BaseDataExportRoute`.
 *
 * Visibility/creation is gated by `requireEscrowHolder()`/`findHeldScopeIds()` against the matter's own
 * `escrowScopeId` - the same "holder of this specific scope, not just any trusted admin" gate
 * `BaseEscrowAccessRequestRoute`/`BaseMatterRoute` already establish.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMatterExportRequestRoute<T extends MatterExportRequest, M extends Matter, MB extends Mailbox> {
    protected abstract matterExportRequestClass: any;
    protected abstract matterClass: any;
    protected abstract mailboxClass: any;
    protected abstract escrowScopeClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `create()` can persist an `EscrowAuditLogEntry`
     * without depending on either backend directly - see `util/EscrowAuditUtils.ts`. */
    protected abstract escrowAuditLogClass: any;

    /** The concrete `AuditLogEntry` class, supplied by the Mongo/SQL subclasses. Unset: a download is not audited. */
    protected auditLogClass?: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected requestRepo?: RepoUtils<T>;
    protected matterRepo?: RepoUtils<M>;
    protected mailboxRepo?: RepoUtils<MB>;
    protected escrowScopeRepo?: RepoUtils<EscrowScope>;
    protected auditLogRepo?: RepoUtils<any>;
    protected escrowAuditEntryRepo?: RepoUtils<any>;
    protected escrowAuditHeadRepo?: RepoUtils<any>;
    protected auditLogUtils?: AuditLogUtils;
    protected escrowAuditUtils?: EscrowAuditUtils;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.requestRepo && this.matterExportRequestClass) {
            this.requestRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.matterExportRequestClass.name,
                args: [this.matterExportRequestClass],
            });
        }
        if (!this.matterRepo && this.matterClass) {
            this.matterRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.matterClass.name,
                args: [this.matterClass],
            });
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.escrowScopeRepo && this.escrowScopeClass) {
            this.escrowScopeRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.escrowScopeClass.name,
                args: [this.escrowScopeClass],
            });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.auditLogClass.name,
                args: [this.auditLogClass],
            });
        }
        if (!this.escrowAuditEntryRepo && this.escrowAuditLogClass) {
            this.escrowAuditEntryRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.escrowAuditLogClass.name,
                args: [this.escrowAuditLogClass],
            });
        }
        const escrowAuditHeadClass: any = this.escrowAuditLogClass?.escrowAuditHeadClass;
        if (!this.escrowAuditHeadRepo && escrowAuditHeadClass) {
            this.escrowAuditHeadRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: escrowAuditHeadClass.name,
                args: [escrowAuditHeadClass],
            });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, {
                name: this.auditLogClass.name,
                args: [this.auditLogRepo],
            });
        }
        if (!this.escrowAuditUtils && this.escrowAuditLogClass) {
            this.escrowAuditUtils = await this._objectFactory.newInstance(EscrowAuditUtils, {
                name: this.escrowAuditLogClass.name,
                args: [this.escrowAuditEntryRepo, this.escrowAuditHeadRepo],
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

    private async requireMatter(id: string): Promise<M> {
        const matter: M | undefined = await this.matterRepo!.findOne(id, { ignoreACL: true });
        if (!matter) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return matter;
    }

    @Post()
    @RateLimit({ perUser: true, maxAttempts: CREATE_MAX_ATTEMPTS, windowSeconds: CREATE_WINDOW_SECONDS })
    public async create(body: { matterId: string }, @AuthUser user?: JWTUser): Promise<T> {
        const matter: M = await this.requireMatter(body?.matterId);
        await requireEscrowHolder(this.escrowScopeRepo!, matter.escrowScopeId, user);
        // A closed matter is over - same rule as `BaseEscrowAccessRequestRoute.create()`.
        if (matter.closedAt) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This matter is closed.");
        }

        // One export of a matter at a time: each is every custodian's whole mailbox, and a second one while the first is still being built is the same
        // content again.
        for (const status of ["pending", "processing"]) {
            if ((await this.requestRepo!.find({ matterId: ModelUtils.literal(matter.uid), status } as any, { ignoreACL: true, limit: 1 })).length > 0) {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "An export of this matter is already in progress.");
            }
        }
        const created: T = await this.requestRepo!.create(
            new this.matterExportRequestClass({ matterId: matter.uid, requestedByUserUid: user!.uid, status: "pending" }),
            { ignoreACL: true },
        );
        for (const mailboxUid of matter.custodianMailboxUids) {
            // Same "both must agree" check `MatterExportJob`/`BaseMatterSearchRoute` apply before actually
            // touching a custodian mailbox's content - `custodianMailboxUids` is holder-set, unvalidated
            // free text, so a mismatched mailbox here would never end up in the export those two skip it
            // for anyway. Recording a `MATTER_EXPORT_REQUESTED` entry for it regardless would leave the
            // hash-chained escrow ledger permanently, falsely implying that mailbox was ever actually in
            // scope for this request.
            const mailbox: MB | undefined = await this.mailboxRepo!.findOne(mailboxUid, { ignoreACL: true });
            if (!mailbox || mailbox.escrowScopeId !== matter.escrowScopeId) {
                continue;
            }
            await this.escrowAuditUtils!.record({
                action: EscrowAuditAction.MATTER_EXPORT_REQUESTED,
                holderUserUid: user!.uid,
                matterId: matter.uid,
                mailboxUid,
                requestId: created.uid,
            });
        }
        return created;
    }

    /** Lists export requests for matters under scopes the caller holds, newest first. `?limit=` (default 100, at
     * most 500) and `?page=` (0-based) page through them; `?matterId=` narrows to one matter (an empty list for a
     * matter the caller can't see). */
    @Get()
    public async find(
        @Query("limit") limitParam: unknown,
        @Query("page") pageParam: unknown,
        @Query("matterId") matterIdParam: unknown,
        @AuthUser user?: JWTUser,
    ): Promise<T[]> {
        const { limit, page } = parseListPaging({ limit: limitParam, page: pageParam });
        // `exactInFilter()`: a uid holding `,` would otherwise widen these `in(...)` filters to other scopes/matters.
        const heldScopes: string | undefined = exactInFilter(await findHeldScopeIds(this.escrowScopeRepo!, user));
        if (!heldScopes) {
            return [];
        }
        let matterIds: string[] = [];
        for (let matterPage = 0; ; matterPage++) {
            // Every page - a single `find()` stops at 100 rows, hiding the requests of every later matter.
            const batch: M[] = await this.matterRepo!.find(
                { escrowScopeId: heldScopes, sort: "uid", limit: MATTER_PAGE_SIZE, page: matterPage } as any,
                { ignoreACL: true, limit: MATTER_PAGE_SIZE, page: matterPage },
            );
            matterIds.push(...batch.map((m) => m.uid));
            if (batch.length < MATTER_PAGE_SIZE) {
                break;
            }
        }
        if (matterIdParam !== undefined) {
            matterIds = matterIds.filter((uid) => uid === matterIdParam);
        }
        const matterFilter: string | undefined = exactInFilter(matterIds);
        if (!matterFilter) {
            return [];
        }
        return await this.requestRepo!.find({ matterId: matterFilter, sort: "-dateCreated", limit, page } as any, {
            ignoreACL: true,
            limit,
            page,
        });
    }

    @Get("/:id")
    public async findById(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<T> {
        const request: T = await this.requireRequest(id);
        const matter: M = await this.requireMatter(request.matterId);
        await requireEscrowHolder(this.escrowScopeRepo!, matter.escrowScopeId, user);
        return request;
    }

    @Get("/:id/download")
    public async download(
        @Param("id") id: string,
        @Response res: HttpResponse,
        @Request req?: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        if (!this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const request: T = await this.requireRequest(id);
        const matter: M = await this.requireMatter(request.matterId);
        await requireEscrowHolder(this.escrowScopeRepo!, matter.escrowScopeId, user);
        // A closed matter is over - its exports stop being downloadable too, same as `create()` refusing new ones and
        // `BaseEscrowAccessRequestRoute.material()` refusing key material.
        if (matter.closedAt) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This matter is closed.");
        }
        if (request.status !== "ready" || !request.blobKey) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "This export is not ready for download yet.");
        }

        const content: Buffer = await this.blobStore.get(request.blobKey);
        if (this.auditLogUtils) {
            // Whoever takes the export out of the system is on the record: the request's own ledger entries say who asked for it.
            await this.auditLogUtils.record(
                { action: AuditAction.MATTER_EXPORT_DOWNLOAD, targetType: "MatterExportRequest", targetUid: request.uid, details: { matterId: request.matterId } },
                { req, user },
            );
        }
        res.setHeader("content-type", "application/x-ndjson");
        res.setHeader("content-disposition", `attachment; filename="matter-export-${request.matterId}.ndjson"`);
        res.send(content);
    }
}
