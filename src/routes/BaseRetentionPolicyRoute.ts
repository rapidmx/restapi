///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { AuditAction, MIN_AUDIT_LOG_RETENTION_DAYS, RetentionPolicy } from "../models/types.js";
const { Config, Logger } = ObjectDecorators;
const { Get, Put, RequiresTrustedRole, User: AuthUser, Validate } = RouteDecorators;

/** The fixed, well-known identifier of the one `RetentionPolicy` row this route ever reads/writes - same
 * singleton-row convention as `BaseBrandingRoute.ts`'s `BRANDING_UID`/`BaseEncryptionPolicyRoute.ts`'s
 * `ENCRYPTION_POLICY_UID`. */
const RETENTION_POLICY_UID = "retention-policy";

/** The wire shape of `RetentionPolicy` - identical to the entity today, kept as its own type mirroring
 * `BaseEncryptionPolicyRoute.ts`'s `PublicEncryptionPolicy` so a future internal-only field doesn't leak
 * by accident. */
export type PublicRetentionPolicy = Pick<RetentionPolicy, "messageRetentionDays" | "auditLogRetentionDays">;

/** All-`undefined` defaults `GET /retention-policy` returns when nothing has been configured yet - never
 * a `404`, matching `BaseEncryptionPolicyRoute.ts`'s identical reasoning. `undefined` means "no automatic
 * purge configured" for both fields - see `RetentionPolicy`'s own doc comment in `models/types.ts`. */
const DEFAULT_RETENTION_POLICY: PublicRetentionPolicy = {};

/**
 * This deployment's data-retention policy (see `RetentionPolicy`'s own doc comment) - a singleton row,
 * admin-editable, readable by any authenticated user. Modeled directly on
 * `BaseEncryptionPolicyRoute.ts`/`BaseBrandingRoute.ts`: a bespoke class (own `init()`-built `RepoUtils`,
 * no `@Model`) since there is exactly one row, never a real collection, and its read/write halves need
 * different authorization.
 *
 * Enforcement itself lives in `RetentionEnforcementJob`, not here - this route only stores the
 * configuration.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseRetentionPolicyRoute<T extends RetentionPolicy> {
    protected abstract retentionPolicyClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `update()` can persist an `AuditLogEntry` without
     * depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private retentionPolicyRepo?: RepoUtils<T>;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`) -
     * same reasoning as `BaseBrandingRoute.ts`'s identical field. */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.retentionPolicyRepo) {
            this.retentionPolicyRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.retentionPolicyClass.name,
                args: [this.retentionPolicyClass],
            });
        }
    }

    /**
     * Same TOCTOU-tolerant create-or-fetch as `BaseBrandingRoute.findOrCreate()`/
     * `BaseEncryptionPolicyRoute.findOrCreate()` - two concurrent first-ever callers can both observe
     * `existing === undefined` and both reach `create()`; the loser's `create()` throws a raw driver
     * duplicate-key error, and since this is a singleton keyed on the fixed `RETENTION_POLICY_UID`,
     * re-fetching and returning the now-existing row is the correct outcome.
     */
    private async findOrCreate(): Promise<T> {
        const existing: T | undefined = await this.retentionPolicyRepo!.findOne(RETENTION_POLICY_UID, { ignoreACL: true });
        if (existing) {
            return existing;
        }
        try {
            return await this.retentionPolicyRepo!.create(new this.retentionPolicyClass({ uid: RETENTION_POLICY_UID }), {
                ignoreACL: true,
            });
        } catch (err) {
            const winner: T | undefined = await this.retentionPolicyRepo!.findOne(RETENTION_POLICY_UID, { ignoreACL: true });
            if (winner) {
                return winner;
            }
            throw err;
        }
    }

    /** `?? undefined` on every field: an unset nullable column comes back as `null` on the SQL backend
     * but is simply omitted (`undefined`) on Mongo - see the identical note elsewhere in this codebase on
     * `Mailbox.maxDurationMinutes`/`BaseBrandingRoute`'s `brandingToPublicDTO()`. Normalized here so
     * `GET`'s response shape is identical regardless of which backend a deployment runs. */
    private toPublic(policy: T): PublicRetentionPolicy {
        return {
            messageRetentionDays: policy.messageRetentionDays ?? undefined,
            auditLogRetentionDays: policy.auditLogRetentionDays ?? undefined,
        };
    }

    /** Only ever copies a field into the returned patch if the caller actually supplied it, so an
     * unrelated field this route doesn't recognize can never ride along into `repoUtils.update()` - same
     * as `BaseEncryptionPolicyRoute.extractPatch()`. Clearing a previously-configured value back to "no
     * automatic purge" isn't supported by this endpoint (a fast-follow if a real need for it shows up) -
     * matches that same sibling route's own scope. */
    private extractPatch(obj: Partial<PublicRetentionPolicy> | undefined): Partial<PublicRetentionPolicy> {
        const patch: Partial<PublicRetentionPolicy> = {};
        for (const field of ["messageRetentionDays", "auditLogRetentionDays"] as const) {
            const value = obj?.[field];
            if (value !== undefined) {
                patch[field] = value;
            }
        }
        return patch;
    }

    /** Runs as `@Validate` middleware, strictly before `update()` is ever invoked - guarantees a rejected
     * (400) request never has the side effect of materializing the singleton row on what would otherwise
     * be its first write, same guarantee `BaseEncryptionPolicyRoute.validateUpdate()` preserves. */
    protected validateUpdate(obj: Partial<PublicRetentionPolicy> | undefined): void {
        for (const field of ["messageRetentionDays", "auditLogRetentionDays"] as const) {
            const value = obj?.[field];
            if (value === undefined) {
                continue;
            }
            if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${field}' must be a positive integer number of days.`);
            }
        }
        if (obj?.auditLogRetentionDays !== undefined && obj.auditLogRetentionDays < MIN_AUDIT_LOG_RETENTION_DAYS) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `'auditLogRetentionDays' cannot be set below ${MIN_AUDIT_LOG_RETENTION_DAYS} days.`,
            );
        }
    }

    @Get()
    public async get(@AuthUser user?: JWTUser): Promise<PublicRetentionPolicy> {
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        await this.init();
        const existing: T | undefined = await this.retentionPolicyRepo!.findOne(RETENTION_POLICY_UID, { ignoreACL: true });
        return existing ? this.toPublic(existing) : DEFAULT_RETENTION_POLICY;
    }

    @RequiresTrustedRole()
    @Put()
    @Validate("validateUpdate")
    public async update(obj: Partial<PublicRetentionPolicy> | undefined, @AuthUser user?: JWTUser): Promise<PublicRetentionPolicy> {
        const patch: Partial<PublicRetentionPolicy> = this.extractPatch(obj);

        await this.init();
        const existing: T = await this.findOrCreate();

        const updated: T = await this.retentionPolicyRepo!.update(
            { uid: existing.uid, version: (existing as any).version, ...patch } as any,
            existing,
            { user, ignoreACL: true },
        );
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.RETENTION_POLICY_UPDATE, targetType: "RetentionPolicy", targetUid: RETENTION_POLICY_UID, details: patch },
        );
        return this.toPublic(updated);
    }
}
