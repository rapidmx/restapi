///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrors, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { SETUP_STATE_UID, updateSetupState } from "../util/SetupStateUtils.js";
import { AuditAction, Domain, SetupState } from "../models/types.js";
const { Init } = ObjectDecorators;
const { Get, Post, Put, RequiresTrustedRole, User: AuthUser } = RouteDecorators;

/** The wire shape of `GET /setup`. */
export interface SetupStatus {
    /** Whether an administrator should be taken to the setup wizard. */
    required: boolean;
    startedAt?: Date;
    completedAt?: Date;
    currentStep?: string;
}

/**
 * The admin console's first-run setup wizard state. Setup is `required` until an administrator finishes it, on a
 * deployment that has either started the wizard or has no domains other than the ones seeded from its configuration
 * (`Domain.origin: "seed"`, see `DomainSeeder`) - so an existing deployment that already has domains is never pulled
 * into the wizard just by upgrading, while a fresh one, whose install seeded its domains, is sent there straight away
 * and resumes it if the administrator leaves midway. Trusted roles only: a non-admin's `403` is how the web clients
 * know not to redirect them.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseSetupRoute<T extends SetupState> {
    protected abstract setupStateClass: any;

    protected abstract domainClass: any;

    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private repo?: RepoUtils<T>;

    private domainRepo?: RepoUtils<Domain>;

    /** The `AuditLogEntry` repository, built once by `initialize()`. */
    protected auditLogRepo?: RepoUtils<any>;

    /** Records the audit entries, built once by `initialize()` from `auditLogRepo`. */
    protected auditLogUtils?: AuditLogUtils;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.repo && this.setupStateClass) {
            this.repo = await this._objectFactory.newInstance(RepoUtils, { name: this.setupStateClass.name, args: [this.setupStateClass] });
        }
        if (!this.domainRepo && this.domainClass) {
            this.domainRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.domainClass.name, args: [this.domainClass] });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogRepo) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
    }

    private async findState(): Promise<T | undefined> {
        return (await this.repo!.findOne(SETUP_STATE_UID, { ignoreACL: true })) ?? undefined;
    }

    private async toStatus(state: T | undefined): Promise<SetupStatus> {
        let required: boolean;
        if (state?.completedAt) {
            required = false;
        } else if (state?.startedAt) {
            required = true;
        } else {
            // Any domain not seeded from the configuration, a row from before seeding (no origin) included, means the deployment has domains of its own.
            // Counted on both sides rather than filtered on `origin !== "seed"`, which SQL would read as excluding the rows without an origin. `>=`: a
            // domain seeded between the two reads makes the second count the larger, and still means no domain of the deployment's own.
            const all: number = await this.domainRepo!.count({}, { ignoreACL: true });
            const seeded: number = all > 0 ? await this.domainRepo!.count({ origin: "seed" } as any, { ignoreACL: true }) : 0;
            required = seeded >= all;
        }
        // `?? undefined`: the SQL backend reports an unset nullable column as `null`.
        return {
            required,
            startedAt: state?.startedAt ?? undefined,
            completedAt: state?.completedAt ?? undefined,
            currentStep: state?.currentStep ?? undefined,
        };
    }

    private async audit(action: AuditAction, user?: JWTUser): Promise<void> {
        await this.auditLogUtils!.record(
            { action, targetType: "SetupState", targetUid: SETUP_STATE_UID },
            { user },
        );
    }

    @RequiresTrustedRole()
    @Get()
    public async get(): Promise<SetupStatus> {
        return this.toStatus(await this.findState());
    }

    /**
     * Records the step the administrator is on, marking setup as started - but only while setup is `required`. A step
     * saved on a deployment that doesn't need setup (completed, or with domains and never started) is recorded without
     * starting it, so it can't send every administrator back into the wizard; only `POST /reopen` does that. Two
     * administrators saving at once both succeed: a save that loses the optimistic-lock race re-reads and tries again,
     * as `complete()` and `reopen()` do, and as `DomainSeeder` does when it records the domains it seeded.
     */
    @RequiresTrustedRole()
    @Put()
    public async saveStep(obj: { currentStep?: string } | undefined, @AuthUser user?: JWTUser): Promise<SetupStatus> {
        const step: unknown = obj?.currentStep;
        if (typeof step !== "string" || step.trim() === "" || step.length > 64) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'currentStep' must be a step name.");
        }
        // Saving a step is idempotent, so a save that lost the race is simply retried (`updateSetupState()`).
        const saved: T = await updateSetupState(
            this.repo!,
            async (existing: T) => {
                const patch: Partial<SetupState> = { currentStep: step };
                if (!existing.startedAt && (await this.toStatus(existing)).required) {
                    patch.startedAt = new Date();
                }
                return patch;
            },
            user,
        );
        return this.toStatus(saved);
    }

    @RequiresTrustedRole()
    @Post("/complete")
    public async complete(@AuthUser user?: JWTUser): Promise<SetupStatus> {
        const updated: T = await updateSetupState(this.repo!, async (existing: T) => ({ completedAt: new Date(), startedAt: existing.startedAt ?? new Date() }), user);
        await this.audit(AuditAction.SETUP_COMPLETE, user);
        return this.toStatus(updated);
    }

    /** Sends administrators back through the wizard, starting from its first step. */
    @RequiresTrustedRole()
    @Post("/reopen")
    public async reopen(@AuthUser user?: JWTUser): Promise<SetupStatus> {
        const updated: T = await updateSetupState(this.repo!, async () => ({ completedAt: null as any, startedAt: new Date(), currentStep: null as any }), user);
        await this.audit(AuditAction.SETUP_REOPEN, user);
        return this.toStatus(updated);
    }
}
