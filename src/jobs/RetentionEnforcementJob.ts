///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { assertNotOnLegalHold } from "../util/LegalHoldUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { Attachment, AuditAction, AuditLogEntry, Message, RetentionPolicy } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

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
 * Both `Message` AND `AuditLogEntry` purges are legal-hold-aware (`util/LegalHoldUtils.ts`) - a held
 * record is skipped, not purged, and naturally retried on a later run once its `Matter` closes, the same
 * "skip, don't error" shape this class's own doc comment promises throughout. An `AuditLogEntry` with no
 * `mailboxUid` at all (an org-wide action - a `DistributionList`/`TransportRule` change isn't scoped to
 * one mailbox) has nothing to check a hold against and is purged unconditionally, same as always.
 * `EscrowAuditLogEntry` (a hash-chained ledger) is never a target here at all, by design - see
 * `RetentionPolicy.auditLogRetentionDays`'s own doc comment.
 *
 * An expiring `Message` also has every `Attachment` referencing it (and both entities' own `BlobStore`
 * content - `bodyBlobKey`/`sanitizedHtmlBlobKey`/`blobKey`/`extractedTextBlobKey`) purged right alongside
 * it - mirroring `ErasureExecutionJob`'s own identical reasoning ("the ORM layer has no idea these opaque
 * byte payloads exist, so leaving them behind after the owning row is gone would defeat the entire point
 * of" a retention policy that represents itself as actually deleting the content it ages out). Deleting a
 * `Message` row has no database-level cascade onto its `Attachment`s (confirmed the same way
 * `ErasureExecutionJob` already had to purge them as an independent step) - without this, PHI/PII a
 * deployment's own compliance policy asserts is gone after N days would in fact remain fully stored and
 * independently downloadable via `BaseAttachmentRoute` indefinitely.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`RetentionEnforcementJobMongo`/
 * `RetentionEnforcementJobSQL`), following the same multi-entity-type generic pattern `ScanQueueJob`/
 * `MailboxQuotaRecalcJob` use.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class RetentionEnforcementJob<RP extends RetentionPolicy, M extends Message, AL extends AuditLogEntry, AT extends Attachment> extends BackgroundService {
    protected abstract retentionPolicyClass: any;
    protected abstract messageClass: any;
    protected abstract auditLogClass: any;
    protected abstract attachmentClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so a `Message` purge candidate's legal-hold status
     * can be resolved without depending on either backend directly - see `util/LegalHoldUtils.ts`. */
    protected abstract matterClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private retentionPolicyRepo?: RepoUtils<RP>;
    private messageRepo?: RecoverableRepoUtils<M>;
    private auditLogRepo?: RepoUtils<AL>;
    private attachmentRepo?: RepoUtils<AT>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

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
        this.attachmentRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.attachmentClass.name,
            args: [this.attachmentClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.retentionPolicyRepo || !this.messageRepo || !this.auditLogRepo || !this.attachmentRepo || !this.blobStore) {
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
                // Every `Attachment` referencing this message first - `Message` deletion has no
                // database-level cascade onto them (see this class's own doc comment), and each one's own
                // `blobKey`/`extractedTextBlobKey` content must be explicitly removed the same way
                // `ErasureExecutionJob` already does for its own cascade. Best-effort per attachment - one
                // failing here shouldn't block the parent message's own purge below, matching this job's
                // existing per-record tolerance elsewhere.
                const attachments: AT[] = await this.attachmentRepo!.find({ messageUid: message.uid, limit: 1000 } as any, {
                    ignoreACL: true,
                    limit: 1000,
                });
                for (const attachment of attachments) {
                    try {
                        await this.blobStore!.delete((attachment as any).blobKey);
                        if ((attachment as any).extractedTextBlobKey) {
                            await this.blobStore!.delete((attachment as any).extractedTextBlobKey);
                        }
                        await this.attachmentRepo!.delete(attachment.uid, { ignoreACL: true, purge: true });
                    } catch (err: any) {
                        this.logger?.warn(
                            `RetentionEnforcementJob: failed to purge attachment ${attachment.uid} for expired message ${message.uid}: ${err.message}`,
                        );
                    }
                }

                await this.blobStore!.delete((message as any).bodyBlobKey);
                if ((message as any).sanitizedHtmlBlobKey) {
                    await this.blobStore!.delete((message as any).sanitizedHtmlBlobKey);
                }
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
            if (entry.mailboxUid) {
                try {
                    await assertNotOnLegalHold(this._objectFactory!, this.matterClass, entry.mailboxUid, entry.dateCreated);
                } catch {
                    // Under an active hold - skip, don't error. Retried automatically on a later run once
                    // the matter closes. Without this check, a `Matter`'s own date range predating this
                    // policy's enforced minimum (`MIN_AUDIT_LOG_RETENTION_DAYS`) could have its audit
                    // trail purged out from under it - the exact record the hold exists to preserve -
                    // while that same mailbox's `Message`s stay correctly protected above.
                    continue;
                }
            }
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
