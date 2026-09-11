///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { AuditAction, EncryptionPolicy, PolicyState } from "../models/types.js";
const { Config, Logger } = ObjectDecorators;
const { Get, Put, RequiresTrustedRole, User: AuthUser, Validate } = RouteDecorators;

/** The fixed, well-known identifier of the one `EncryptionPolicy` row this route ever reads/writes - same
 * singleton-row convention as `BaseBrandingRoute.ts`'s `BRANDING_UID`. */
const ENCRYPTION_POLICY_UID = "encryption-policy";

/** The wire shape of `EncryptionPolicy` - identical to the entity today, but kept as its own type (mirroring
 * `BaseBrandingRoute.ts`'s `PublicBranding`) so a future field this route shouldn't expose (e.g. internal
 * bookkeeping) doesn't leak by accident. */
export type PublicEncryptionPolicy = Pick<EncryptionPolicy, "encryptSameOrg" | "encryptFederated" | "encryptExternal">;

/** All-`"optional"` defaults `GET /encryption-policy` returns when nothing has been configured yet - never a
 * `404`, so a client's compose-time policy check never has to special-case "not configured". `"optional"`
 * (not `"prohibited"`) matches the spec's explicit same-organisation default, extended to all three tiers
 * since encryption is a *protective* capability with no reason to default more restrictively for a
 * federated/external tier than for same-organisation. */
const DEFAULT_ENCRYPTION_POLICY: PublicEncryptionPolicy = {
    encryptSameOrg: "optional",
    encryptFederated: "optional",
    encryptExternal: "optional",
};

const VALID_POLICY_STATES: ReadonlySet<string> = new Set<PolicyState>(["automatic", "optional", "prohibited"]);

/**
 * The system-wide encryption policy (`specs/end-to-end_encryption.md`'s "Encryption Policy States" section) -
 * a singleton row, admin-editable, readable by any authenticated user. Modeled directly on
 * `BaseBrandingRoute.ts`: a bespoke class (own `init()`-built `RepoUtils`, no `@Model`) since there is exactly
 * one row, never a real collection, and its read/write halves need different authorization (any authenticated
 * user MAY read, only a trusted role may write).
 *
 * Unlike `Branding`, `GET` here is authenticated-only (not public) - a compose UI needs this to decide what
 * encryption controls to offer, which requires being logged in as some mailbox's user in the first place, but
 * it is not admin-only information the way writing it is.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseEncryptionPolicyRoute<T extends EncryptionPolicy> {
    protected abstract encryptionPolicyClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `update()` can persist an `AuditLogEntry` without
     * depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private encryptionPolicyRepo?: RepoUtils<T>;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`) -
     * same reasoning as `BaseBrandingRoute.ts`'s identical field. */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.encryptionPolicyRepo) {
            this.encryptionPolicyRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.encryptionPolicyClass.name,
                args: [this.encryptionPolicyClass],
            });
        }
    }

    /**
     * Same TOCTOU-tolerant create-or-fetch as `BaseBrandingRoute.findOrCreate()` - two concurrent first-ever
     * callers can both observe `existing === undefined` and both reach `create()`; the loser's `create()`
     * throws a raw driver duplicate-key error, and since this is a singleton keyed on the fixed
     * `ENCRYPTION_POLICY_UID`, re-fetching and returning the now-existing row is the correct outcome.
     */
    private async findOrCreate(): Promise<T> {
        const existing: T | undefined = await this.encryptionPolicyRepo!.findOne(ENCRYPTION_POLICY_UID, { ignoreACL: true });
        if (existing) {
            return existing;
        }
        try {
            return await this.encryptionPolicyRepo!.create(new this.encryptionPolicyClass({ uid: ENCRYPTION_POLICY_UID }), {
                ignoreACL: true,
            });
        } catch (err) {
            const winner: T | undefined = await this.encryptionPolicyRepo!.findOne(ENCRYPTION_POLICY_UID, { ignoreACL: true });
            if (winner) {
                return winner;
            }
            throw err;
        }
    }

    private toPublic(policy: T): PublicEncryptionPolicy {
        return {
            encryptSameOrg: policy.encryptSameOrg,
            encryptFederated: policy.encryptFederated,
            encryptExternal: policy.encryptExternal,
        };
    }

    /** Only ever copies a field into the returned patch if the caller actually supplied it, so an
     * unrelated field this route doesn't recognize can never ride along into `repoUtils.update()`. */
    private extractPatch(obj: Partial<PublicEncryptionPolicy> | undefined): Partial<PublicEncryptionPolicy> {
        const patch: Partial<PublicEncryptionPolicy> = {};
        for (const field of ["encryptSameOrg", "encryptFederated", "encryptExternal"] as const) {
            const value = obj?.[field];
            if (value !== undefined) {
                patch[field] = value;
            }
        }
        return patch;
    }

    /** Runs as `@Validate` middleware, strictly before `update()` is ever invoked - guarantees a rejected
     * (400) request never has the side effect of materializing the singleton row on what would otherwise
     * be its first write, the same guarantee the inline check this replaced was written to preserve. */
    protected validateUpdate(obj: Partial<PublicEncryptionPolicy> | undefined): void {
        for (const field of ["encryptSameOrg", "encryptFederated", "encryptExternal"] as const) {
            const value = obj?.[field];
            if (value !== undefined && !VALID_POLICY_STATES.has(value)) {
                throw new ApiError(
                    ApiErrors.INVALID_REQUEST,
                    400,
                    `'${field}' must be one of "automatic", "optional", "prohibited".`,
                );
            }
        }
    }

    @Get()
    public async get(@AuthUser user?: JWTUser): Promise<PublicEncryptionPolicy> {
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        await this.init();
        const existing: T | undefined = await this.encryptionPolicyRepo!.findOne(ENCRYPTION_POLICY_UID, { ignoreACL: true });
        return existing ? this.toPublic(existing) : DEFAULT_ENCRYPTION_POLICY;
    }

    @RequiresTrustedRole()
    @Put()
    @Validate("validateUpdate")
    public async update(obj: Partial<PublicEncryptionPolicy> | undefined, @AuthUser user?: JWTUser): Promise<PublicEncryptionPolicy> {
        const patch: Partial<PublicEncryptionPolicy> = this.extractPatch(obj);

        await this.init();
        const existing: T = await this.findOrCreate();

        const updated: T = await this.encryptionPolicyRepo!.update(
            { uid: existing.uid, version: (existing as any).version, ...patch } as any,
            existing,
            { user, ignoreACL: true },
        );
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.ENCRYPTION_POLICY_UPDATE, targetType: "EncryptionPolicy", targetUid: ENCRYPTION_POLICY_UID, details: patch },
        );
        return this.toPublic(updated);
    }
}
