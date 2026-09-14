///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrors, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { findOrCreateSingleton } from "../util/MailboxPolicyUtils.js";
import { AuditAction, Domain, SetupState } from "../models/types.js";
const { Config, Logger } = ObjectDecorators;
const { Get, Post, Put, RequiresTrustedRole, User: AuthUser } = RouteDecorators;

/** The fixed identifier of the one `SetupState` row. */
const SETUP_STATE_UID = "setup-state";

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
 * deployment that has either started the wizard or has no domains at all - so an existing deployment that already
 * has domains is never pulled into the wizard just by upgrading, while a fresh one is sent there straight away and
 * resumes it if the administrator leaves midway. Trusted roles only: a non-admin's `403` is how the web clients
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

    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.repo) {
            this.repo = await this._objectFactory!.newInstance(RepoUtils, { name: this.setupStateClass.name, args: [this.setupStateClass] });
            this.domainRepo = await this._objectFactory!.newInstance(RepoUtils, { name: this.domainClass.name, args: [this.domainClass] });
        }
    }

    private async findState(): Promise<T | undefined> {
        return (await this.repo!.findOne(SETUP_STATE_UID, { ignoreACL: true })) ?? undefined;
    }

    private async findOrCreate(): Promise<T> {
        return findOrCreateSingleton(this.repo!, this.setupStateClass, SETUP_STATE_UID);
    }

    private async save(existing: T, patch: Partial<SetupState>, user?: JWTUser): Promise<T> {
        return await this.repo!.update({ uid: existing.uid, version: (existing as any).version, ...patch } as any, existing, {
            user,
            ignoreACL: true,
        });
    }

    private async toStatus(state: T | undefined): Promise<SetupStatus> {
        let required: boolean;
        if (state?.completedAt) {
            required = false;
        } else if (state?.startedAt) {
            required = true;
        } else {
            const domains: Domain[] = await this.domainRepo!.find({ limit: 1 } as any, { ignoreACL: true, limit: 1 });
            required = domains.length === 0;
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
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action, targetType: "SetupState", targetUid: SETUP_STATE_UID },
        );
    }

    @RequiresTrustedRole()
    @Get()
    public async get(): Promise<SetupStatus> {
        await this.init();
        return this.toStatus(await this.findState());
    }

    /** Records the step the administrator is on, marking setup as started. */
    @RequiresTrustedRole()
    @Put()
    public async saveStep(obj: { currentStep?: string } | undefined, @AuthUser user?: JWTUser): Promise<SetupStatus> {
        const step: unknown = obj?.currentStep;
        if (typeof step !== "string" || step.trim() === "" || step.length > 64) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'currentStep' must be a step name.");
        }
        await this.init();
        const existing: T = await this.findOrCreate();
        const patch: Partial<SetupState> = { currentStep: step };
        if (!existing.startedAt) {
            patch.startedAt = new Date();
        }
        return this.toStatus(await this.save(existing, patch, user));
    }

    @RequiresTrustedRole()
    @Post("/complete")
    public async complete(@AuthUser user?: JWTUser): Promise<SetupStatus> {
        await this.init();
        const existing: T = await this.findOrCreate();
        const updated: T = await this.save(existing, { completedAt: new Date(), startedAt: existing.startedAt ?? new Date() }, user);
        await this.audit(AuditAction.SETUP_COMPLETE, user);
        return this.toStatus(updated);
    }

    /** Sends administrators back through the wizard, starting from its first step. */
    @RequiresTrustedRole()
    @Post("/reopen")
    public async reopen(@AuthUser user?: JWTUser): Promise<SetupStatus> {
        await this.init();
        const existing: T = await this.findOrCreate();
        const updated: T = await this.save(existing, { completedAt: null as any, startedAt: new Date(), currentStep: null as any }, user);
        await this.audit(AuditAction.SETUP_REOPEN, user);
        return this.toStatus(updated);
    }
}
