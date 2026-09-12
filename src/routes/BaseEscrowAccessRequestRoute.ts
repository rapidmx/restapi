///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/escrow-access-requests")` to its own concrete subclass
// (see `BaseMailIngestRoute`/`BaseKeyVaultRoute`'s identical note) - every method here is defined relative
// to that.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    DatabaseDecorators,
    HttpRequest,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { recordEscrowAuditEntry } from "../util/EscrowAuditUtils.js";
import { findHeldScopeIds, requireEscrowHolder } from "../util/EscrowUtils.js";
import {
    AuditAction,
    EscrowAccessRequest,
    EscrowAuditAction,
    KeyVault,
    Mailbox,
    Matter,
    MasterKeyWrap,
} from "../models/types.js";
const { Config, Logger } = ObjectDecorators;
const { Transactional } = DatabaseDecorators;
const { Get, Param, Post, Query, Request, User: AuthUser } = RouteDecorators;


/** The wire shape `GET /:id/material` returns - only ever the escrow-method wraps, scoped to the
 * matter's own escrow scope, never `wrappedKeys` or any other unlock method. */
export interface EscrowAccessMaterial {
    masterKeyWraps: MasterKeyWrap[];
}

/**
 * Implements `specs/end-to-end_encryption.md`'s M-of-N dual control - a bespoke class (own `init()`-built
 * `RepoUtils`, no `@Model`-driven CRUD, same shape as `BaseKeyVaultRoute`), because this lifecycle doesn't
 * fit `POST`/`PUT`/generic `find()`: creation cross-validates three other entities and seeds `approvals`;
 * mutation only ever happens via `/approve`/`/deny`, never a raw `PUT`; `/material` returns a shape that
 * isn't the entity itself.
 *
 * This is the one route in the whole Escrow Scoping feature that actually returns real (still-encrypted)
 * escrow key material - `/material` filters `KeyVault.masterKeyWraps` down to `method: "escrow"` entries
 * matching the request's own matter's `escrowScopeId`, and never anything else. This server still never
 * sees plaintext either way - the wraps returned here are opaque ciphertext this server can't decrypt,
 * per this whole feature's scope boundary (see `EscrowScope`'s own doc comment).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseEscrowAccessRequestRoute<R extends EscrowAccessRequest, M extends Matter, MB extends Mailbox> {
    protected abstract escrowAccessRequestClass: any;
    protected abstract matterClass: any;
    protected abstract mailboxClass: any;
    protected abstract keyVaultClass: any;
    protected abstract escrowScopeClass: any;
    protected abstract escrowAuditLogClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `deny()` can persist a general `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. A denial grants nothing
     * and uses nothing, so it goes through the ordinary log, not the hash chain. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private requestRepo?: RepoUtils<R>;
    private matterRepo?: RepoUtils<M>;
    private mailboxRepo?: RepoUtils<MB>;
    private keyVaultRepo?: RepoUtils<KeyVault>;

    /** Exposes the `@Model(...)`-supplied entity class so `@Transactional()` on `persistCreate()`/
     * `persistApprove()`/`persistMaterialRead()` can resolve which datasource to open a transaction
     * against - identical reasoning to `BaseKeyVaultRoute`'s own `modelClass` getter. */
    public get modelClass(): any {
        return (this.constructor as any).modelClass;
    }

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.requestRepo) {
            this.requestRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.escrowAccessRequestClass.name,
                args: [this.escrowAccessRequestClass],
            });
        }
        if (!this.matterRepo) {
            this.matterRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.matterClass.name,
                args: [this.matterClass],
            });
        }
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.keyVaultRepo) {
            this.keyVaultRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.keyVaultClass.name,
                args: [this.keyVaultClass],
            });
        }
    }

    private async requireRequest(id: string): Promise<R> {
        const request: R | undefined = await this.requestRepo!.findOne(id, { ignoreACL: true });
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

    /** Same "find-or-report-empty" shape `BaseKeyVaultRoute.findKeyVault()` already establishes - a
     * mailbox that has never enrolled a key has no vault row yet, which is not an error. */
    private async findKeyVault(mailboxUid: string): Promise<KeyVault | undefined> {
        const existing: KeyVault[] = await this.keyVaultRepo!.find({ mailboxUid, limit: 1 } as any, { ignoreACL: true, limit: 1 });
        return existing[0];
    }

    @Post()
    public async create(body: { matterId: string; mailboxUid: string }, @AuthUser user?: JWTUser): Promise<R> {
        await this.init();
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        const matter: M = await this.requireMatter(body.matterId);
        if (matter.closedAt) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This matter is closed.");
        }
        const scope = await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);

        const mailbox: MB | undefined = await this.mailboxRepo!.findOne(body.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!matter.custodianMailboxUids.includes(body.mailboxUid)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This mailbox is not a custodian of this matter.");
        }
        if ((mailbox as any).escrowScopeId !== matter.escrowScopeId) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "This mailbox is not currently assigned to this matter's escrow scope.",
            );
        }

        const approvedAt = new Date();
        const approvals = [{ holderUserUid: user.uid, approvedAt }];
        const instance: R = new this.escrowAccessRequestClass({
            matterId: matter.uid,
            mailboxUid: body.mailboxUid,
            requestedByUserUid: user.uid,
            approvals,
            requiredHoldersAtCreation: scope.requiredHolders,
            status: approvals.length >= scope.requiredHolders ? "approved" : "pending",
        });

        return await this.persistCreate(instance);
    }

    @Transactional()
    protected async persistCreate(instance: R): Promise<R> {
        const created: R = await this.requestRepo!.create(instance, { ignoreACL: true });
        await recordEscrowAuditEntry(this._objectFactory!, this.escrowAuditLogClass, {
            action: EscrowAuditAction.REQUEST_CREATED,
            holderUserUid: created.requestedByUserUid,
            matterId: created.matterId,
            mailboxUid: created.mailboxUid,
            requestId: created.uid,
        });
        return created;
    }

    @Post("/:id/approve")
    public async approve(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<R> {
        await this.init();
        const request: R = await this.requireRequest(id);
        if (request.status !== "pending") {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This request is not pending approval.");
        }
        const matter: M = await this.requireMatter(request.matterId);
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);
        if (request.approvals.some((a) => a.holderUserUid === user!.uid)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "You have already approved this request.");
        }

        return await this.persistApprove(request, user!.uid);
    }

    @Transactional()
    protected async persistApprove(request: R, holderUserUid: string): Promise<R> {
        const approvals = [...request.approvals, { holderUserUid, approvedAt: new Date() }];
        const status = approvals.length >= request.requiredHoldersAtCreation ? "approved" : "pending";
        const updated: R = await this.requestRepo!.update(
            { uid: request.uid, version: (request as any).version, approvals, status } as any,
            request,
            { ignoreACL: true },
        );
        await recordEscrowAuditEntry(this._objectFactory!, this.escrowAuditLogClass, {
            action: EscrowAuditAction.REQUEST_APPROVED,
            holderUserUid,
            matterId: updated.matterId,
            mailboxUid: updated.mailboxUid,
            requestId: updated.uid,
        });
        return updated;
    }

    @Post("/:id/deny")
    public async deny(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<R> {
        await this.init();
        const request: R = await this.requireRequest(id);
        const matter: M = await this.requireMatter(request.matterId);
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);
        if (request.status !== "pending") {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This request is not pending approval.");
        }

        const updated: R = await this.requestRepo!.update(
            { uid: request.uid, version: (request as any).version, status: "denied", deniedByUserUid: user!.uid, deniedAt: new Date() } as any,
            request,
            { user, ignoreACL: true },
        );

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            {
                action: AuditAction.ESCROW_ACCESS_REQUEST_DENIED,
                targetType: "EscrowAccessRequest",
                targetUid: updated.uid,
                mailboxUid: updated.mailboxUid,
                details: { matterId: updated.matterId },
            },
        );

        return updated;
    }

    @Get("/:id/material")
    public async material(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<EscrowAccessMaterial> {
        await this.init();
        const request: R = await this.requireRequest(id);
        if (request.status !== "approved" && request.status !== "fulfilled") {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Dual control threshold not yet met.");
        }
        const matter: M = await this.requireMatter(request.matterId);
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);

        const mailbox: MB | undefined = await this.mailboxRepo!.findOne(request.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const keyVault: KeyVault | undefined = await this.findKeyVault(request.mailboxUid);
        const masterKeyWraps: MasterKeyWrap[] = keyVault?.masterKeyWraps ?? [];

        await this.persistMaterialRead(request, user!.uid, matter.escrowScopeId);

        return {
            masterKeyWraps: masterKeyWraps.filter((w) => w.method === "escrow" && w.escrowScopeId === matter.escrowScopeId),
        };
    }

    @Transactional()
    protected async persistMaterialRead(request: R, holderUserUid: string, escrowScopeId: string): Promise<void> {
        // Audit first - if this throws, the caller's material() never returns anything.
        await recordEscrowAuditEntry(this._objectFactory!, this.escrowAuditLogClass, {
            action: EscrowAuditAction.MATERIAL_READ,
            holderUserUid,
            matterId: request.matterId,
            mailboxUid: request.mailboxUid,
            requestId: request.uid,
            details: { escrowScopeId },
        });
        if (request.status !== "fulfilled") {
            await this.requestRepo!.update(
                { uid: request.uid, version: (request as any).version, status: "fulfilled", fulfilledAt: new Date() } as any,
                request,
                { ignoreACL: true },
            );
        }
    }

    @Get()
    public async find(@Query() query: any, @AuthUser user?: JWTUser): Promise<R[]> {
        await this.init();
        const heldScopeIds: string[] = await findHeldScopeIds(this._objectFactory!, this.escrowScopeClass, user);
        if (heldScopeIds.length === 0) {
            return [];
        }
        const matters: M[] = await this.matterRepo!.find(
            { escrowScopeId: `in(${heldScopeIds.join(",")})` } as any,
            { ignoreACL: true },
        );
        if (matters.length === 0) {
            return [];
        }
        const matterIds: string[] = matters.map((m) => m.uid);
        return await this.requestRepo!.find(
            { ...query, matterId: `in(${matterIds.join(",")})` },
            { limit: query?.limit, page: query?.page, ignoreACL: true },
        );
    }

    @Get("/:id")
    public async findById(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<R> {
        await this.init();
        const request: R = await this.requireRequest(id);
        const matter: M = await this.requireMatter(request.matterId);
        await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);
        return request;
    }
}
