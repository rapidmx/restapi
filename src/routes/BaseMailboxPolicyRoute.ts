///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import {
    DEFAULT_MAILBOX_QUOTA_BYTES,
    findOrCreateSingleton,
    findOrSeedMailboxPolicy,
    MAILBOX_POLICY_UID,
    MailboxPolicySeed,
} from "../util/MailboxPolicyUtils.js";
import { AuditAction, MailboxPolicy } from "../models/types.js";
const { Config, Logger } = ObjectDecorators;
const { Auth, Get, Put, RequiresTrustedRole, User: AuthUser, Validate } = RouteDecorators;

export { DEFAULT_MAILBOX_QUOTA_BYTES };

/** The wire shape of `MailboxPolicy` - every field always present. */
export interface PublicMailboxPolicy {
    defaultQuotaBytes: number;
    autoProvisionEnabled: boolean;
    autoProvisionQuotaBytes: number;
}

const FIELDS = ["defaultQuotaBytes", "autoProvisionEnabled", "autoProvisionQuotaBytes"] as const;

/**
 * This deployment's mailbox defaults (see `MailboxPolicy`'s own doc comment) - a singleton row, readable by any
 * authenticated user (the admin console's "New mailbox" form reads the default quota) and editable by trusted
 * roles. Modeled on `BaseRetentionPolicyRoute`. The row is seeded from the server's `mail:*` config the first time
 * anything reads it (see `findOrSeedMailboxPolicy()`), and `BaseMailboxRoute.autoProvision()` reads the same row.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMailboxPolicyRoute<T extends MailboxPolicy> {
    protected abstract mailboxPolicyClass: any;

    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private repo?: RepoUtils<T>;

    @Config()
    private config: any;

    @Config("mail:default_quota_bytes", DEFAULT_MAILBOX_QUOTA_BYTES)
    private configDefaultQuotaBytes: number = DEFAULT_MAILBOX_QUOTA_BYTES;

    @Config("mail:auto_provision:enabled", false)
    private configAutoProvisionEnabled: boolean = false;

    @Config("mail:auto_provision:quota_bytes", DEFAULT_MAILBOX_QUOTA_BYTES)
    private configAutoProvisionQuotaBytes: number = DEFAULT_MAILBOX_QUOTA_BYTES;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.repo) {
            this.repo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxPolicyClass.name,
                args: [this.mailboxPolicyClass],
            });
        }
    }

    private seed(): MailboxPolicySeed {
        return {
            defaultQuotaBytes: this.configDefaultQuotaBytes,
            autoProvisionEnabled: this.configAutoProvisionEnabled,
            autoProvisionQuotaBytes: this.configAutoProvisionQuotaBytes,
        };
    }

    /** A row missing a field (`null` on SQL) takes the config value - see `findOrSeedMailboxPolicy()`. */
    private toPublic(policy: MailboxPolicy): PublicMailboxPolicy {
        const seed = this.seed();
        return {
            defaultQuotaBytes: policy.defaultQuotaBytes ?? seed.defaultQuotaBytes,
            autoProvisionEnabled: policy.autoProvisionEnabled ?? seed.autoProvisionEnabled,
            autoProvisionQuotaBytes: policy.autoProvisionQuotaBytes ?? seed.autoProvisionQuotaBytes,
        };
    }

    protected validateUpdate(obj: Partial<PublicMailboxPolicy> | undefined): void {
        for (const field of ["defaultQuotaBytes", "autoProvisionQuotaBytes"] as const) {
            const value = obj?.[field];
            // `Number.isSafeInteger`: larger values can't be stored or compared exactly.
            if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${field}' must be a positive whole number of bytes.`);
            }
        }
        if (obj?.autoProvisionEnabled !== undefined && typeof obj.autoProvisionEnabled !== "boolean") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'autoProvisionEnabled' must be true or false.");
        }
    }

    /** Any signed-in user; an anonymous caller gets a `401`. Display-only, so a failed read falls back to config. */
    @Auth(["jwt"])
    @Get()
    public async get(): Promise<PublicMailboxPolicy> {
        return await findOrSeedMailboxPolicy(this._objectFactory!, this.mailboxPolicyClass, this.seed(), this.logger);
    }

    @RequiresTrustedRole()
    @Put()
    @Validate("validateUpdate")
    public async update(obj: Partial<PublicMailboxPolicy> | undefined, @AuthUser user?: JWTUser): Promise<PublicMailboxPolicy> {
        const patch: Partial<PublicMailboxPolicy> = {};
        for (const field of FIELDS) {
            if (obj?.[field] !== undefined) {
                (patch as any)[field] = obj[field];
            }
        }

        await this.init();
        // Writes need the real row, so unlike `get()` a datastore failure here is an error, not a config fallback.
        const existing: T = await findOrCreateSingleton(this.repo!, this.mailboxPolicyClass, MAILBOX_POLICY_UID, { ...this.seed() });
        const updated: T = await this.repo!.update({ uid: existing.uid, version: (existing as any).version, ...patch } as any, existing, {
            user,
            ignoreACL: true,
        });
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.MAILBOX_POLICY_UPDATE, targetType: "MailboxPolicy", targetUid: MAILBOX_POLICY_UID, details: patch },
        );
        return this.toPublic(updated);
    }
}
