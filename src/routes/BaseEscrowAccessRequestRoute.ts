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
import {
    evaluateEscrowApprovals,
    exactInFilter,
    findHeldScopeIds,
    requireEscrowHolder,
    resolveEscrowApprovalTtlHours,
} from "../util/EscrowUtils.js";
import { parseListPaging } from "../util/RequestListUtils.js";
import {
    AuditAction,
    EscrowAccessRequest,
    EscrowAuditAction,
    EscrowScope,
    KeyVault,
    Mailbox,
    Matter,
    MasterKeyWrap,
} from "../models/types.js";
const { Config, Logger } = ObjectDecorators;
const { Transactional } = DatabaseDecorators;
const { Get, Param, Post, Query, Request, User: AuthUser } = RouteDecorators;

/** How many times a `persist*()` call is attempted in total - see `retryOnAuditConflict()`. */
const MAX_PERSIST_ATTEMPTS = 3;

/** Page size for reading every matter under the caller's held scopes - see `findAllMatterIds()`. */
const MATTER_PAGE_SIZE = 500;


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

    /**
     * Runs one of the `@Transactional()` `persist*()` methods, retrying the WHOLE call (a fresh transaction each
     * time) when it fails with anything but an `ApiError`. `recordEscrowAuditEntry()` already retries a
     * `sequence` collision with a concurrent append on its own, but inside a transaction that can't work: on
     * PostgreSQL the failed insert aborts the transaction, so every retry within it fails too. `attempt` lets the
     * caller re-read state a previous, non-transactional attempt (a MongoDB deployment without transactions) may
     * already have written. An `ApiError` (a version conflict, a validation failure) is a real answer, not a race.
     */
    private async retryOnAuditConflict<X>(fn: (attempt: number) => Promise<X>): Promise<X> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn(attempt);
            } catch (err) {
                if (err instanceof ApiError || attempt + 1 >= MAX_PERSIST_ATTEMPTS) {
                    throw err;
                }
                this.logger?.warn(`EscrowAccessRequestRoute: retrying after a failed escrow audit append: ${(err as any)?.message}`);
            }
        }
    }

    private async requireRequest(id: string, skipCache: boolean = false): Promise<R> {
        const request: R | undefined = await this.requestRepo!.findOne(id, { ignoreACL: true, skipCache });
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

        return await this.retryOnAuditConflict(() => this.persistCreate(instance));
    }

    @Transactional()
    protected async persistCreate(instance: R): Promise<R> {
        // A retry (see `retryOnAuditConflict()`) reuses `instance` and its uid - without a transaction the first
        // attempt's row can already exist.
        const created: R =
            (await this.requestRepo!.findOne(instance.uid, { ignoreACL: true, skipCache: true })) ??
            (await this.requestRepo!.create(instance, { ignoreACL: true }));
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
        if (matter.closedAt) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "This matter is closed.");
        }
        if (request.approvals.some((a) => a.holderUserUid === user!.uid)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "You have already approved this request.");
        }

        return await this.retryOnAuditConflict(async (attempt) =>
            this.persistApprove(attempt === 0 ? request : await this.requireRequest(id, true), user!.uid),
        );
    }

    @Transactional()
    protected async persistApprove(request: R, holderUserUid: string): Promise<R> {
        // Only on a retry without a transaction (see `retryOnAuditConflict()`) can the approval already be saved.
        const updated: R = request.approvals.some((a) => a.holderUserUid === holderUserUid)
            ? request
            : await this.requestRepo!.update(
                  {
                      uid: request.uid,
                      version: (request as any).version,
                      approvals: [...request.approvals, { holderUserUid, approvedAt: new Date() }],
                      status: request.approvals.length + 1 >= request.requiredHoldersAtCreation ? "approved" : "pending",
                  } as any,
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

    /**
     * Releases the mailbox's escrow wraps for an approved request - re-checking, at read time, everything its
     * approval depended on rather than trusting a status set earlier:
     *
     * - the matter is still open, and the mailbox is still one of its custodians and still assigned to its scope
     * (`409` otherwise);
     * - enough of the approvals come from users who are STILL holders of the scope - an approval from a holder
     * who has since been removed doesn't count (`403`);
     * - the threshold was met no more than `mail:escrow:approval_ttl_hours` (default 72) ago (`403`) - a new
     * request must be approved for access after that.
     */
    @Get("/:id/material")
    public async material(@Param("id") id: string, @AuthUser user?: JWTUser): Promise<EscrowAccessMaterial> {
        await this.init();
        const request: R = await this.requireRequest(id);
        if (request.status !== "approved" && request.status !== "fulfilled") {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Dual control threshold not yet met.");
        }
        const matter: M = await this.requireMatter(request.matterId);
        const scope: EscrowScope = await requireEscrowHolder(this._objectFactory!, this.escrowScopeClass, matter.escrowScopeId, user);
        if (matter.closedAt) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This matter is closed.");
        }

        const mailbox: MB | undefined = await this.mailboxRepo!.findOne(request.mailboxUid, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(matter.custodianMailboxUids ?? []).includes(request.mailboxUid) || (mailbox as any).escrowScopeId !== matter.escrowScopeId) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "This mailbox is no longer a custodian of this matter or no longer assigned to its escrow scope.",
            );
        }
        const approvalState = evaluateEscrowApprovals(request, scope, resolveEscrowApprovalTtlHours(this.config));
        if (!approvalState.thresholdMet) {
            throw new ApiError(
                ApiErrors.AUTH_PERMISSION_FAILURE,
                403,
                "Dual control threshold is no longer met - approvals from users who are no longer holders don't count.",
            );
        }
        if (approvalState.expired) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "This request's approval has expired - open a new access request.");
        }

        const keyVault: KeyVault | undefined = await this.findKeyVault(request.mailboxUid);
        const masterKeyWraps: MasterKeyWrap[] = keyVault?.masterKeyWraps ?? [];

        await this.retryOnAuditConflict(async (attempt) =>
            this.persistMaterialRead(attempt === 0 ? request : await this.requireRequest(id, true), user!.uid, matter.escrowScopeId),
        );

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

    /**
     * Lists the requests for matters under scopes the caller holds, newest first (`dateCreated` descending).
     * `?limit=` (default 100, at most 500) and `?page=` (0-based) page through them; `?matterId=` narrows to one
     * matter (an empty list for a matter the caller can't see). Other plain field filters (e.g. `?status=`) still
     * apply; `$`-prefixed keys are dropped - the SQL backend composes a `$or` branch over the forced `matterId`
     * restriction, which would otherwise let a holder list requests of matters they don't hold.
     */
    @Get()
    public async find(@Query() query: any, @AuthUser user?: JWTUser): Promise<R[]> {
        await this.init();
        const { limit, page } = parseListPaging(query);
        const heldScopes: string | undefined = exactInFilter(await findHeldScopeIds(this._objectFactory!, this.escrowScopeClass, user));
        if (!heldScopes) {
            return [];
        }
        let matterIds: string[] = await this.findAllMatterIds(heldScopes);
        if (query?.matterId !== undefined) {
            matterIds = matterIds.filter((uid) => uid === query.matterId);
        }
        // `exactInFilter()`: a matter uid holding `,` would otherwise widen the `in(...)` below to other matters.
        const matterFilter: string | undefined = exactInFilter(matterIds);
        if (!matterFilter) {
            return [];
        }
        const filter: Record<string, any> = {};
        for (const [key, value] of Object.entries(query ?? {})) {
            if (!key.startsWith("$") && !["matterId", "limit", "page", "sort"].includes(key)) {
                filter[key] = value;
            }
        }
        return await this.requestRepo!.find(
            { ...filter, matterId: matterFilter, sort: "-dateCreated", limit, page } as any,
            { limit, page, ignoreACL: true },
        );
    }

    /** The uid of every matter under `scopeFilter` (an `exactInFilter()` operand) - every page, since a single
     * `find()` stops at 100 rows. */
    private async findAllMatterIds(scopeFilter: string): Promise<string[]> {
        const matterIds: string[] = [];
        for (let page = 0; ; page++) {
            const batch: M[] = await this.matterRepo!.find(
                { escrowScopeId: scopeFilter, sort: "uid", limit: MATTER_PAGE_SIZE, page } as any,
                { ignoreACL: true, limit: MATTER_PAGE_SIZE, page },
            );
            matterIds.push(...batch.map((m) => m.uid));
            if (batch.length < MATTER_PAGE_SIZE) {
                return matterIds;
            }
        }
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
