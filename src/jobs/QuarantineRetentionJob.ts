///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { BlobReferenceSource, deleteBlobsIfUnreferenced, messageBlobReferenceSources } from "../util/BlobReferenceUtils.js";
import { LegalHoldIndex, loadLegalHoldIndex } from "../util/LegalHoldUtils.js";
import { IngestStatus, QuarantineEntry } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/**
 * Purges `QuarantineEntry` rows, their `ScanResult` and their raw message blob once they've sat in quarantine
 * longer than `retention_days`, whether or not they were ever released. A released entry is retained for the
 * same window as an unreleased one — this job doesn't distinguish between them, since both represent quarantine
 * history an operator may want to review for that same window.
 *
 * The raw blob is shared: `BaseMailIngestRoute.deliver()` stores one per SMTP transaction for every recipient, so
 * the same key can back another recipient's delivered `Message` or pending `IngestQueueEntry` (and a released
 * entry's own delivered copy). It is deleted only once no row references it any more - see
 * `util/BlobReferenceUtils.ts`. An entry whose mailbox is a custodian of any open legal hold is kept until the hold
 * closes (conservatively regardless of the hold's date range), like `RetentionEnforcementJob`'s messages.
 *
 * Also purges `DELIVERED` `IngestQueueEntry` rows older than `delivered_ingest_retention_days`, with their raw blobs
 * when unreferenced, and dead-lettered ones (`FAILED`, attempts exhausted) older than `failed_ingest_retention_days` - see
 * `run()`.
 *
 * No search index cleanup is needed here: only `Message` rows are indexed (`SearchIndexJob`), and a quarantined
 * delivery never creates one (`QuarantineEntry.originalMessageUid` is never set); a released entry's delivered copy is
 * an ordinary `Message` this job doesn't touch.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`QuarantineRetentionJobMongo`/
 * `QuarantineRetentionJobSQL`), following the same generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class QuarantineRetentionJob<Q extends QuarantineEntry> extends BackgroundService {
    protected abstract quarantineEntryClass: any;
    protected abstract scanResultClass: any;
    protected abstract messageClass: any;
    protected abstract attachmentClass: any;
    protected abstract ingestQueueEntryClass: any;
    protected abstract matterClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected quarantineEntryRepo?: RepoUtils<Q>;
    protected scanResultRepo?: RepoUtils<any>;
    protected ingestQueueEntryRepo?: RepoUtils<any>;
    protected messageRepo?: RepoUtils<any>;
    protected attachmentRepo?: RepoUtils<any>;
    protected matterRepo?: RepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Config("mail:jobs:quarantine_retention:schedule", "0 0 6 * * *")
    private scheduleExpr: string = "0 0 6 * * *";

    @Config("mail:jobs:quarantine_retention:batch_size", 500)
    private batchSize: number = 500;

    @Config("mail:jobs:quarantine_retention:retention_days", 30)
    private retentionDays: number = 30;

    /** How long a `DELIVERED` `IngestQueueEntry` is kept (for operator review via the ingest queue route) before this
     * job purges it and its raw blob, if unreferenced. `0` disables that cleanup. */
    @Config("mail:jobs:quarantine_retention:delivered_ingest_retention_days", 30)
    private deliveredIngestRetentionDays: number = 30;

    /** How long a dead-lettered `IngestQueueEntry` (`FAILED` with no further attempt scheduled: `ScanQueueJob` gave up on it) is kept for an
     * operator to look at before this job purges it and its raw blob, if unreferenced - the raw message is personal data that
     * would otherwise be kept for ever. `0` disables that cleanup. */
    @Config("mail:jobs:quarantine_retention:failed_ingest_retention_days", 90)
    private failedIngestRetentionDays: number = 90;

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
        if (!this.quarantineEntryRepo && this.quarantineEntryClass) {
            this.quarantineEntryRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.quarantineEntryClass.name,
                args: [this.quarantineEntryClass],
            });
        }
        if (!this.scanResultRepo && this.scanResultClass) {
            this.scanResultRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.scanResultClass.name,
                args: [this.scanResultClass],
            });
        }
        if (!this.ingestQueueEntryRepo && this.ingestQueueEntryClass) {
            this.ingestQueueEntryRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.ingestQueueEntryClass.name,
                args: [this.ingestQueueEntryClass],
            });
        }
        if (!this.messageRepo && this.messageClass) {
            this.messageRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.messageClass.name,
                args: [this.messageClass],
            });
        }
        if (!this.attachmentRepo && this.attachmentClass) {
            this.attachmentRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.attachmentClass.name,
                args: [this.attachmentClass],
            });
        }
        if (!this.matterRepo && this.matterClass) {
            this.matterRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.matterClass.name,
                args: [this.matterClass],
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
        if (!this.quarantineEntryRepo || !this.scanResultRepo || !this.blobStore) {
            return;
        }

        const cutoff: Date = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);
        const blobSources: BlobReferenceSource[] = messageBlobReferenceSources({
            messageRepo: this.messageRepo,
            attachmentRepo: this.attachmentRepo,
            quarantineEntryRepo: this.quarantineEntryRepo,
            ingestQueueEntryRepo: this.ingestQueueEntryRepo,
        });
        const holds: LegalHoldIndex = await loadLegalHoldIndex(this.matterRepo!);
        const heldExclusion: Record<string, any> =
            holds.heldMailboxUids.size > 0 ? { mailboxUid: `nin(${[...holds.heldMailboxUids].join(",")})` } : {};

        await this.purgeSorted<Q>(
            this.quarantineEntryRepo,
            { ...heldExclusion, dateCreated: `lt(${cutoff.toISOString()})` },
            "dateCreated",
            async (entry) => {
                // Content first, the entry itself last (the entry being purged is excluded from the reference check): a failure
                // on the way leaves the entry - and so its blob key - in place for the next run to retry, instead of an
                // orphaned raw message (personal data) nothing points at any more.
                await deleteBlobsIfUnreferenced(this.blobStore!, blobSources, [entry.rawBlobKey], {
                    repo: this.quarantineEntryRepo,
                    uid: entry.uid,
                });
                if (entry.scanResultUid) {
                    await this.scanResultRepo!.delete(entry.scanResultUid, { ignoreACL: true, purge: true });
                }
                await this.quarantineEntryRepo!.delete(entry.uid, { ignoreACL: true, purge: true });
            },
            (entry, err) => this.logger?.warn(`QuarantineRetentionJob: failed to purge quarantine entry ${entry.uid}: ${err.message}`),
        );

        // Delivered `IngestQueueEntry` rows are terminal: once `ScanQueueJob` marks one `DELIVERED` it stops counting as a
        // reference to its raw blob, and nothing reads it again. Left alone they accumulate forever, and so does the raw
        // blob of every delivery that produced no `Message`/`QuarantineEntry` at all (a recall control message, an
        // inbound MDN receipt, an ACME challenge email). Once older than `delivered_ingest_retention_days` the row is
        // purged, then its raw blob only if nothing else references it - an ordinary delivery's raw blob IS the
        // delivered `Message.bodyBlobKey`, and other recipients' still-pending entries share it too, so the reference
        // check (not this job) decides.
        if (this.ingestQueueEntryRepo && this.deliveredIngestRetentionDays > 0) {
            const ingestCutoff: Date = new Date(Date.now() - this.deliveredIngestRetentionDays * 24 * 60 * 60 * 1000);
            await this.purgeSorted<any>(
                this.ingestQueueEntryRepo,
                { ...heldExclusion, status: `eq(${IngestStatus.DELIVERED})`, dateModified: `lt(${ingestCutoff.toISOString()})` },
                "dateModified",
                (entry) => this.purgeIngestEntry(entry, blobSources),
                (entry, err) => this.logger?.warn(`QuarantineRetentionJob: failed to purge delivered ingest entry ${entry.uid}: ${err.message}`),
            );
        }

        // Dead letters: `ScanQueueJob` gave up (`FAILED`, no `nextAttemptAt`), so nothing will ever read the row or its raw message
        // again except an operator who has had `failed_ingest_retention_days` to look. A failed entry still waiting for a retry has a
        // `nextAttemptAt` and is never touched.
        if (this.ingestQueueEntryRepo && this.failedIngestRetentionDays > 0) {
            const failedCutoff: Date = new Date(Date.now() - this.failedIngestRetentionDays * 24 * 60 * 60 * 1000);
            await this.purgeSorted<any>(
                this.ingestQueueEntryRepo,
                { ...heldExclusion, status: `eq(${IngestStatus.FAILED})`, nextAttemptAt: "eq(null)", dateModified: `lt(${failedCutoff.toISOString()})` },
                "dateModified",
                async (entry) => {
                    this.logger?.warn(
                        `QuarantineRetentionJob: purging dead-lettered ingest entry ${entry.uid} (mailbox ${entry.mailboxUid}) after ${this.failedIngestRetentionDays} days: ${entry.errorMessage ?? "no error recorded"}`,
                    );
                    await this.purgeIngestEntry(entry, blobSources);
                },
                (entry, err) => this.logger?.warn(`QuarantineRetentionJob: failed to purge dead-lettered ingest entry ${entry.uid}: ${err.message}`),
            );
        }
    }

    /** Deletes an ingest entry's raw blob first (only if nothing else references it), the row last - see the quarantine purge in `run()`. */
    private async purgeIngestEntry(entry: any, blobSources: BlobReferenceSource[]): Promise<void> {
        await deleteBlobsIfUnreferenced(this.blobStore!, blobSources, [entry.rawBlobKey], {
            repo: this.ingestQueueEntryRepo,
            uid: entry.uid,
        });
        await this.ingestQueueEntryRepo!.delete(entry.uid, { ignoreACL: true, purge: true });
    }

    /**
     * Purges up to `batchSize` rows matching `criteria`, oldest first by `(dateField, uid)`. `ModelUtils.buildSearchQuery`
     * supports single-sided `lt(...)` comparisons with correct Date coercion on both backends. `limit` is passed both via
     * `options` (the Mongo backend) *and* in the query object itself (all `ModelUtils.buildSearchQuerySQL` reads). Rows
     * that fail to purge keep their place in the stable order, so each next page is read past them rather than
     * re-reading the same stuck rows every run.
     */
    private async purgeSorted<T extends { uid: string }>(
        repo: RepoUtils<T>,
        criteria: Record<string, any>,
        dateField: string,
        purge: (row: T) => Promise<void>,
        onError: (row: T, err: any) => void,
    ): Promise<number> {
        const pageSize: number = Math.max(1, Math.min(this.batchSize, 1000));
        let purged = 0;
        let skipped = 0;
        while (purged < this.batchSize) {
            const page: number = Math.floor(skipped / pageSize);
            const rows: T[] = await repo.find(
                { ...criteria, sort: { [dateField]: "ASC", uid: "ASC" }, limit: pageSize, page } as any,
                { ignoreACL: true, limit: pageSize, page, skipCache: true },
            );
            const fresh: T[] = rows.slice(skipped % pageSize);
            if (fresh.length === 0) {
                break;
            }
            for (const row of fresh) {
                if (purged >= this.batchSize) {
                    break;
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
}
