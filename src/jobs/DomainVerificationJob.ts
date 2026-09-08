///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { checkDomainVerification } from "../util/DomainVerificationUtils.js";
import { AuditAction, Domain } from "../models/types.js";
const { Config, Inject, Init, Logger } = ObjectDecorators;

/**
 * Periodically checks every enabled-but-unverified `Domain` for its DNS ownership TXT record
 * (`checkDomainVerification()`, shared with `BaseDomainRoute.verify()`'s on-demand action), so an admin
 * doesn't have to manually trigger a check after adding the record - it's simply found on the next pass.
 * Once verified, a domain is never queried again by this job (see `Domain.verified`'s own doc comment).
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`DomainVerificationJobMongo`/
 * `DomainVerificationJobSQL`), following the same generic pattern `QuarantineRetentionJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class DomainVerificationJob<D extends Domain> extends BackgroundService {
    protected abstract domainClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so a successful verification can be recorded as an
     * `AuditLogEntry` without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private domainRepo?: RepoUtils<D>;

    @Config("mail:jobs:domain_verification:schedule", "0 */5 * * * *")
    private scheduleExpr: string = "0 */5 * * * *";

    @Config("mail:jobs:domain_verification:batch_size", 100)
    private batchSize: number = 100;

    // No key = the whole config object, the same decorator `ModelRoute.config` itself uses - needed by
    // `recordAuditLog()`, which constructs a real `Event(config, ...)`.
    @Config()
    private config: any;

    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.domainRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.domainClass.name,
            args: [this.domainClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.domainRepo || !this.dnsResolver) {
            return;
        }

        // `limit` is passed both via `options` and baked into the query object itself - the SQL backend's
        // query builder ignores `options.limit` and falls back to its own default of 100 unless the query
        // object itself carries it (confirmed the same way on `QuarantineRetentionJob.run()`).
        const candidates: D[] = await this.domainRepo.find(
            { enabled: true, verified: false, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const domain of candidates) {
            try {
                const verified: boolean = await checkDomainVerification(this.dnsResolver, domain);
                const patch: any = { uid: domain.uid, version: domain.version, lastCheckedAt: new Date() };
                if (verified) {
                    patch.verified = true;
                    patch.verifiedAt = new Date();
                }
                await this.domainRepo.update(patch, domain, { version: domain.version, ignoreACL: true });

                if (verified) {
                    await recordAuditLog(
                        this._objectFactory!,
                        this.auditLogClass,
                        { config: this.config, logger: this.logger },
                        { action: AuditAction.DOMAIN_VERIFIED, targetType: "Domain", targetUid: domain.uid, details: { name: domain.name } },
                    );
                }
            } catch (err: any) {
                this.logger?.warn(`DomainVerificationJob: failed to check domain '${domain.name}': ${err.message}`);
            }
        }
    }
}
