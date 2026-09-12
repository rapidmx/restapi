///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { assertNotOnLegalHold } from "../util/LegalHoldUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { AuditAction, AuditLogEntry, Message, RetentionPolicy } from "../models/types.js";
const { Config, Init, Logger } = ObjectDecorators;

/** The fixed, well-known identifier of the one `RetentionPolicy` row - mirrors
 * `BaseRetentionPolicyRoute.ts`'s own `RETENTION_POLICY_UID` constant (kept as a separate literal here,
 * not imported, since a job has no business depending on a route module). */
const RETENTION_POLICY_UID = "retention-policy";

/**
 * Enforces `RetentionPolicy` (see that entity's own doc comment in `models/types.ts`) - a configured
 * policy is a written intent, not automatic behavior, until something actually purges the data it
 * describes. Mirrors `QuarantineRetentionJob`'s exact single-page-per-run shape, generalized across two
 * entity types instead of one, each independently gated by whether the corresponding policy field is
 * set at all.
 *
 * `Message` purges are legal-hold-aware (`util/LegalHoldUtils.ts`) - a held message is skipped, not
 * purged, and naturally retried on a later run once its `Matter` closes, the same "skip, don't error"
 * shape `RetentionEnforcementJob`'s own doc comment promises. `AuditLogEntry` purges are not - see
 * `RetentionPolicy.auditLogRetentionDays`'s own doc comment for why `EscrowAuditLogEntry` (a
 * hash-chained ledger) is never a target here at all, by design.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`RetentionEnforcementJobMongo`/
 * `RetentionEnforcementJobSQL`), following the same multi-entity-type generic pattern `ScanQueueJob`/
 * `MailboxQuotaRecalcJob` use.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class RetentionEnforcementJob<RP extends RetentionPolicy, M extends Message, AL extends AuditLogEntry> extends BackgroundService {
    protected abstract retentionPolicyClass: any;
    protected abstract messageClass: any;
    protected abstract auditLogClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so a `Message` purge candidate's legal-hold status
     * can be resolved without depending on either backend directly - see `util/LegalHoldUtils.ts`. */
    protected abstract matterClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private retentionPolicyRepo?: RepoUtils<RP>;
    private messageRepo?: RecoverableRepoUtils<M>;
    private auditLogRepo?: RepoUtils<AL>;

    @Config("mail:jobs:retention_enforcement:schedule", "0 0 4 * * *")
    private scheduleExpr: string = "0 0 4 * * *";

    @Config("mail:jobs:retention_enforcement:batch_size", 500)
    private batchSize: number = 500;

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`). */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.retentionPolicyRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.retentionPolicyClass.name,
            args: [this.retentionPolicyClass],
        });
        this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
            name: this.messageClass.name,
            args: [this.messageClass],
        });
        this.auditLogRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.auditLogClass.name,
            args: [this.auditLogClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.retentionPolicyRepo || !this.messageRepo || !this.auditLogRepo) {
            return;
        }

        const policy: RP | undefined = await this.retentionPolicyRepo.findOne(RETENTION_POLICY_UID, { ignoreACL: true });
        if (!policy) {
            return;
        }

        if (policy.messageRetentionDays) {
            await this.purgeExpiredMessages(policy.messageRetentionDays);
        }
        if (policy.auditLogRetentionDays) {
            await this.purgeExpiredAuditLogEntries(policy.auditLogRetentionDays);
        }
    }

    private async purgeExpiredMessages(maxAgeDays: number): Promise<void> {
        const cutoff: Date = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

        // See `QuarantineRetentionJob.run()`'s identical comment on `lt(...)` and the `limit` double-pass -
        // both apply verbatim here.
        const expired: M[] = await this.messageRepo!.find(
            { sentDate: `lt(${cutoff.toISOString()})`, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        let purgedCount = 0;
        for (const message of expired) {
            try {
                await assertNotOnLegalHold(this._objectFactory!, this.matterClass, message.mailboxUid, message.sentDate);
            } catch {
                // Under an active hold - skip, don't error. Retried automatically on a later run once the
                // matter closes.
                continue;
            }
            try {
                await this.messageRepo!.delete(message.uid, { ignoreACL: true, purge: true });
                purgedCount++;
            } catch (err: any) {
                this.logger?.warn(`RetentionEnforcementJob: failed to purge expired message ${message.uid}: ${err.message}`);
            }
        }

        if (purgedCount > 0) {
            await this.recordPurge("Message", purgedCount, maxAgeDays);
        }
    }

    private async purgeExpiredAuditLogEntries(maxAgeDays: number): Promise<void> {
        const cutoff: Date = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

        const expired: AL[] = await this.auditLogRepo!.find(
            { dateCreated: `lt(${cutoff.toISOString()})`, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        let purgedCount = 0;
        for (const entry of expired) {
            try {
                await this.auditLogRepo!.delete(entry.uid, { ignoreACL: true, purge: true });
                purgedCount++;
            } catch (err: any) {
                this.logger?.warn(`RetentionEnforcementJob: failed to purge expired audit log entry ${entry.uid}: ${err.message}`);
            }
        }

        if (purgedCount > 0) {
            await this.recordPurge("AuditLogEntry", purgedCount, maxAgeDays);
        }
    }

    /** One audit entry per entity type per run, not one per record - a routine background job purging
     * hundreds of expired rows would otherwise flood the audit trail it's supposed to keep readable. */
    private async recordPurge(targetType: string, count: number, maxAgeDays: number): Promise<void> {
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, logger: this.logger },
            {
                action: AuditAction.RETENTION_PURGE_EXECUTED,
                targetType,
                targetUid: "batch",
                details: { count, maxAgeDays },
            },
        );
    }
}
