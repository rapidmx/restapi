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
import { ApiErrorMessages, ApiErrors, HttpResponse, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { recordEscrowAuditEntry } from "../util/EscrowAuditUtils.js";
import { requireEscrowHolder, findHeldScopeIds } from "../util/EscrowUtils.js";
import { EscrowAuditAction, Mailbox, Matter, MatterExportRequest } from "../models/types.js";
const { Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Response, User: AuthUser } = RouteDecorators;

/**
 * A holder-invoked eDiscovery export spanning a `Matter`'s full custodian set - see
 * `MatterExportRequest`'s own doc comment for why this needs no dual-control approval (unlike
 * `BaseEscrowAccessRequestRoute`) and why only a `"json"` bundle format is offered. Bespoke class (own
 * `init()`-built `RepoUtils`, no `@Model`-driven CRUD), same shape as `BaseDataExportRoute`.
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

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private requestRepo?: RepoUtils<T>;
    private matterRepo?: RepoUtils<M>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.requestRepo) {
            this.requestRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.matterExportRequestClass.name,
                args: [this.matterExportRequestClass],
            });
        }
        if (!this.matterRepo) {
            this.matterRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.matterClass.name,
                args: [this.matterClass],
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
    public async create(body: { matterId: string }, @AuthUser user?: JWTUser): Promise<T> {
        await this.init();
        const matter: M = await this.requireMatter(body?.matterId);
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);

        const created: T = await this.requestRepo!.create(
            new this.matterExportRequestClass({ matterId: matter.uid, requestedByUserUid: user!.uid, status: "pending" }),
            { ignoreACL: true },
        );
        for (const mailboxUid of matter.custodianMailboxUids) {
            await recordEscrowAuditEntry(this._objectFactory!, this.escrowAuditLogClass, {
                action: EscrowAuditAction.MATTER_EXPORT_REQUESTED,
                holderUserUid: user!.uid,
                matterId: matter.uid,
                mailboxUid,
                requestId: created.uid,
            });
        }
        return created;
    }

    @Get()
    public async find(@AuthUser user?: JWTUser): Promise<T[]> {
        await this.init();
        const heldScopeIds: string[] = await findHeldScopeIds(this._objectFactory!, this.escrowScopeClass, user);
        if (heldScopeIds.length === 0) {
            return [];
        }
        const matters: M[] = await this.matterRepo!.find({ escrowScopeId: `in(${heldScopeIds.join(",")})` } as any, { ignoreACL: true });
        if (matters.length === 0) {
            return [];
        }
        const matterIds: string[] = matters.map((m) => m.uid);
        return await this.requestRepo!.find({ matterId: `in(${matterIds.join(",")})` } as any, { ignoreACL: true });
    }

    @Get("/:id")
    public async findById(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<T> {
        await this.init();
        const request: T = await this.requireRequest(id);
        const matter: M = await this.requireMatter(request.matterId);
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);
        return request;
    }

    @Get("/:id/download")
    public async download(@Param("id") id: string, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<void> {
        await this.init();
        if (!this.blobStore) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const request: T = await this.requireRequest(id);
        const matter: M = await this.requireMatter(request.matterId);
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);
        if (request.status !== "ready" || !request.blobKey) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "This export is not ready for download yet.");
        }

        const content: Buffer = await this.blobStore.get(request.blobKey);
        res.setHeader("content-type", "application/x-ndjson");
        res.setHeader("content-disposition", `attachment; filename="matter-export-${request.matterId}.ndjson"`);
        res.send(content);
    }
}
