///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { asEntity } from "../util/EntityUtils.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
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

    protected domainRepo?: RepoUtils<D>;
    protected auditLogRepo?: RepoUtils<any>;
    protected auditLogUtils?: AuditLogUtils;

    @Config("mail:jobs:domain_verification:schedule", "0 */5 * * * *")
    private scheduleExpr: string = "0 */5 * * * *";

    @Config("mail:jobs:domain_verification:batch_size", 100)
    private batchSize: number = 100;

    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.domainRepo && this.domainClass) {
            this.domainRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.domainClass.name,
                args: [this.domainClass],
            });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.auditLogClass.name,
                args: [this.auditLogClass],
            });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, {
                name: this.auditLogClass.name,
                args: [this.auditLogRepo],
            });
        }
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
        // Never-checked domains first, then the longest-unchecked: every check stamps `lastCheckedAt`, so a domain that can never
        // verify (a typo, an abandoned one) goes to the back of the line instead of holding a place in the first batch forever and
        // starving the ones behind it. (Two queries because databases order a null `lastCheckedAt` differently.)
        const candidates: D[] = await this.domainRepo.find(
            { enabled: true, verified: false, lastCheckedAt: "eq(null)", limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );
        if (candidates.length < this.batchSize) {
            const remaining: number = this.batchSize - candidates.length;
            candidates.push(
                ...(await this.domainRepo.find(
                    { enabled: true, verified: false, lastCheckedAt: "ne(null)", sort: { lastCheckedAt: "ASC", uid: "ASC" }, limit: remaining } as any,
                    { ignoreACL: true, limit: remaining },
                )),
            );
        }

        for (const domain of candidates) {
            try {
                const verified: boolean = await checkDomainVerification(this.dnsResolver, domain);
                const patch: any = { uid: domain.uid, version: domain.version, lastCheckedAt: new Date() };
                if (verified) {
                    patch.verified = true;
                    patch.verifiedAt = new Date();
                }
                // `asEntity()`: Mongo `find()` returns plain documents, for which `update()` is unversioned and would
                // clobber a concurrent admin edit (e.g. disabling the domain) made while DNS was being checked. On a
                // version conflict this throws, is logged below, and the domain is simply re-checked next run.
                await this.domainRepo.update(patch, asEntity(this.domainRepo, domain), { version: domain.version, ignoreACL: true });

                if (verified) {
                    await this.auditLogUtils!.record({ action: AuditAction.DOMAIN_VERIFIED, targetType: "Domain", targetUid: domain.uid, details: { name: domain.name } });
                }
            } catch (err: any) {
                this.logger?.warn(`DomainVerificationJob: failed to check domain '${domain.name}': ${err.message}`);
                await this.stampChecked(domain);
            }
        }
    }

    /**
     * Best-effort: records that `domain` was just looked at even though the check or its write threw, so a domain whose
     * check keeps failing goes to the back of the line instead of holding its place in the batch forever. Re-reads the row
     * so a version conflict on the first attempt does not stop the stamp.
     */
    private async stampChecked(domain: D): Promise<void> {
        try {
            const [fresh] = await this.domainRepo!.find({ uid: domain.uid, limit: 1 } as any, { ignoreACL: true, limit: 1 });
            if (fresh && !fresh.verified) {
                await this.domainRepo!.update(
                    { uid: fresh.uid, version: fresh.version, lastCheckedAt: new Date() } as any,
                    asEntity(this.domainRepo!, fresh),
                    { version: fresh.version, ignoreACL: true },
                );
            }
        } catch (err: any) {
            this.logger?.warn(`DomainVerificationJob: could not record the check of domain '${domain.name}': ${err.message}`);
        }
    }
}
