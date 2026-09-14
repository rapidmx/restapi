///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { BlobReferenceSource, deleteBlobsIfUnreferenced, messageBlobReferenceSources } from "../util/BlobReferenceUtils.js";
import { LegalHoldIndex, loadLegalHoldIndex } from "../util/LegalHoldUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { findPagesByUid } from "../util/MailboxContentUtils.js";
import { removeFromSearchIndex } from "../util/SearchIndexUtils.js";
import type { SearchProvider } from "../search/SearchProvider.js";
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
 * Soft-deleted messages (e.g. in Deleted Items) are purged too, and a purged message's search index document is
 * removed. If any of a message's attachments (or any of its blobs) fails to purge, the message itself is kept and
 * retried on the next run.
 *
 * Message content blobs are shared between recipient mailboxes (and mail-filter copies), so a blob is only
 * deleted once no other row references it - see `util/BlobReferenceUtils.ts`. Each run reads expired rows
 * oldest first in a stable order and pages past rows it skipped (held, or failed to purge), so a stuck row
 * never blocks the rows behind it; mailboxes under any open hold are left out of the message query altogether
 * (holds are loaded once per page via `loadLegalHoldIndex()`, not re-read per record).
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
    /** Counted as references when deciding whether a purged message's shared content blobs can be deleted - see
     * `util/BlobReferenceUtils.ts`. */
    protected abstract quarantineEntryClass: any;
    protected abstract ingestQueueEntryClass: any;

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

    /** Optional: when search isn't configured, index removal is a no-op. */
    @Inject("SearchProvider")
    private searchProvider?: SearchProvider;

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
        const blobSources: BlobReferenceSource[] = messageBlobReferenceSources({
            messageClass: this.messageClass,
            attachmentClass: this.attachmentClass,
            quarantineEntryClass: this.quarantineEntryClass,
            ingestQueueEntryClass: this.ingestQueueEntryClass,
        });

        const purgeMessage = async (message: M): Promise<void> => {
            // Every `Attachment` referencing this message first - `Message` deletion has no database-level cascade
            // onto them (see this class's own doc comment). Any attachment failure propagates and stops this message's
            // purge: the message stays, so the next run finds it - and the attachments it still has - again, rather
            // than an attachment row (and its blobs) outliving a parent nothing will ever revisit.
            //
            // Each row's content goes BEFORE the row itself, and only if no OTHER row still references it (the row
            // being purged is excluded from the reference check): inbound mail and filter-rule copies share blobs
            // across every recipient mailbox (see `util/BlobReferenceUtils.ts`), including mailboxes this policy
            // isn't purging yet or that are held. Deleting content first means a blob-store failure leaves the row -
            // and so its blob keys - in place for the next run to retry, instead of an orphaned blob.
            for await (const attachments of findPagesByUid<AT>(this.attachmentRepo!, { messageUid: message.uid })) {
                for (const attachment of attachments) {
                    await deleteBlobsIfUnreferenced(
                        this._objectFactory!,
                        this.blobStore!,
                        blobSources,
                        [(attachment as any).blobKey, (attachment as any).extractedTextBlobKey],
                        { entityClass: this.attachmentClass, uid: attachment.uid },
                    );
                    await this.attachmentRepo!.delete(attachment.uid, { ignoreACL: true, purge: true });
                }
            }

            await deleteBlobsIfUnreferenced(
                this._objectFactory!,
                this.blobStore!,
                blobSources,
                [(message as any).bodyBlobKey, (message as any).sanitizedHtmlBlobKey],
                { entityClass: this.messageClass, uid: message.uid },
            );
            await this.messageRepo!.delete(message.uid, { ignoreACL: true, purge: true });
            // The search document (subject/body/attachment text) must not outlive the purged message.
            await removeFromSearchIndex(this.searchProvider, "message", message.uid, this.logger);
        };

        // A mailbox under any open hold is left out of the query altogether, so a held custodian's (possibly huge)
        // expired mail never fills the batch ahead of purgeable mail. That is deliberately conservative: its expired
        // mail outside the hold's date range also waits until the hold closes.
        const excludeHeld = (holds: LegalHoldIndex): Record<string, any> =>
            holds.heldMailboxUids.size > 0 ? { mailboxUid: `nin(${[...holds.heldMailboxUids].join(",")})` } : {};

        // Live messages, then soft-deleted ones (e.g. in Deleted Items): `find()` excludes soft-deleted rows unless
        // `deleted: true` is asked for explicitly, and a retention policy that ages content out must purge a
        // recoverable copy just the same. Both share this run's `batchSize` budget.
        let purgedCount = 0;
        for (const deletedCriteria of [{}, { deleted: true }]) {
            purgedCount += await this.purgeSortedBatches<M>(
                this.messageRepo!,
                "sentDate",
                cutoff,
                (holds) => ({ ...excludeHeld(holds), ...deletedCriteria }),
                (holds, message) => holds.isHeld(message.mailboxUid, message.sentDate),
                purgeMessage,
                (message, err) => this.logger?.warn(`RetentionEnforcementJob: failed to purge expired message ${message.uid}: ${err.message}`),
                this.batchSize - purgedCount,
            );
            if (purgedCount >= this.batchSize) {
                break;
            }
        }

        if (purgedCount > 0) {
            await this.recordPurge("Message", purgedCount, maxAgeDays);
        }
    }

    private async purgeExpiredAuditLogEntries(maxAgeDays: number): Promise<void> {
        const cutoff: Date = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

        const purgedCount: number = await this.purgeSortedBatches<AL>(
            this.auditLogRepo!,
            "dateCreated",
            cutoff,
            // No query-side exclusion: `mailboxUid NOT IN (...)` would also drop org-wide entries (a NULL
            // `mailboxUid`) on SQL. Held entries are skipped past instead.
            () => ({}),
            // Without this check, a `Matter`'s own date range predating this policy's enforced minimum
            // (`MIN_AUDIT_LOG_RETENTION_DAYS`) could have its audit trail purged out from under it. An entry with
            // no `mailboxUid` (an org-wide action) has nothing to check a hold against.
            (holds, entry) => !!entry.mailboxUid && holds.isHeld(entry.mailboxUid, entry.dateCreated),
            async (entry) => {
                await this.auditLogRepo!.delete(entry.uid, { ignoreACL: true, purge: true });
            },
            (entry, err) => this.logger?.warn(`RetentionEnforcementJob: failed to purge expired audit log entry ${entry.uid}: ${err.message}`),
        );

        if (purgedCount > 0) {
            await this.recordPurge("AuditLogEntry", purgedCount, maxAgeDays);
        }
    }

    /**
     * Purges up to `batchSize` rows whose `dateField` is before `cutoff`, oldest first. Rows that are skipped
     * (under a legal hold) or fail to purge stay in place and keep their position in the stable
     * `(dateField, uid)` order, so the remaining result set is always "every row skipped so far, then rows not
     * yet looked at" - each next page is read past the skipped count instead of re-reading the same stuck rows
     * forever. Holds are reloaded once per page (one `Matter` read per page rather than per record). Returns
     * how many rows were purged.
     */
    private async purgeSortedBatches<T extends { uid: string }>(
        repo: RepoUtils<T>,
        dateField: string,
        cutoff: Date,
        queryExclusions: (holds: LegalHoldIndex) => Record<string, any>,
        isHeld: (holds: LegalHoldIndex, row: T) => boolean,
        purge: (row: T) => Promise<void>,
        onError: (row: T, err: any) => void,
        budget: number = this.batchSize,
    ): Promise<number> {
        const pageSize: number = Math.max(1, Math.min(this.batchSize, 1000));
        // Bounds a run that finds nothing but skipped rows, so a large held backlog can't make one run unbounded.
        const maxExamined: number = pageSize * 20;
        let purged = 0;
        let skipped = 0;
        let examined = 0;
        while (purged < budget && examined < maxExamined) {
            const holds: LegalHoldIndex = await loadLegalHoldIndex(this._objectFactory!, this.matterClass);
            const page: number = Math.floor(skipped / pageSize);
            const rows: T[] = await repo.find(
                {
                    ...queryExclusions(holds),
                    [dateField]: `lt(${cutoff.toISOString()})`,
                    sort: { [dateField]: "ASC", uid: "ASC" },
                    limit: pageSize,
                    page,
                } as any,
                { ignoreACL: true, limit: pageSize, page, skipCache: true },
            );
            // The first `skipped % pageSize` rows of this page are rows already skipped on an earlier page.
            const fresh: T[] = rows.slice(skipped % pageSize);
            if (fresh.length === 0) {
                break;
            }
            for (const row of fresh) {
                if (purged >= budget) {
                    break;
                }
                examined++;
                if (isHeld(holds, row)) {
                    // Under an active hold - skip, don't error. Retried automatically on a later run once the
                    // matter closes.
                    skipped++;
                    continue;
                }
                try {
                    await purge(row);
                    purged++;
                } catch (err: any) {
                    onError(row, err);
                    skipped++;
                }
            }
            if (rows.length < pageSize) {
                break;
            }
        }
        return purged;
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
