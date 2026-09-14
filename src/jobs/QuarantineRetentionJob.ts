///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { BlobReferenceSource, deleteBlobsIfUnreferenced, messageBlobReferenceSources } from "../util/BlobReferenceUtils.js";
import { LegalHoldIndex, loadLegalHoldIndex } from "../util/LegalHoldUtils.js";
import { QuarantineEntry } from "../models/types.js";
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

    private quarantineEntryRepo?: RepoUtils<Q>;
    private scanResultRepo?: RepoUtils<any>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Config("mail:jobs:quarantine_retention:schedule", "0 0 6 * * *")
    private scheduleExpr: string = "0 0 6 * * *";

    @Config("mail:jobs:quarantine_retention:batch_size", 500)
    private batchSize: number = 500;

    @Config("mail:jobs:quarantine_retention:retention_days", 30)
    private retentionDays: number = 30;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.quarantineEntryRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.quarantineEntryClass.name,
            args: [this.quarantineEntryClass],
        });
        this.scanResultRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.scanResultClass.name,
            args: [this.scanResultClass],
        });
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
            messageClass: this.messageClass,
            attachmentClass: this.attachmentClass,
            quarantineEntryClass: this.quarantineEntryClass,
            ingestQueueEntryClass: this.ingestQueueEntryClass,
        });
        const holds: LegalHoldIndex = await loadLegalHoldIndex(this._objectFactory!, this.matterClass);
        const pageSize: number = Math.max(1, Math.min(this.batchSize, 1000));

        // `ModelUtils.buildSearchQuery` supports single-sided `lt(...)` comparisons with correct Date coercion on
        // both backends. `limit` is passed both via `options` (the Mongo backend) *and* in the query object itself
        // (all `ModelUtils.buildSearchQuerySQL` reads). Entries of held mailboxes are left out of the query, and
        // entries that fail to purge keep their place in the stable `(dateCreated, uid)` order, so each next page
        // is read past them rather than re-reading the same stuck rows every run.
        let purged = 0;
        let skipped = 0;
        while (purged < this.batchSize) {
            const page: number = Math.floor(skipped / pageSize);
            const rows: Q[] = await this.quarantineEntryRepo.find(
                {
                    ...(holds.heldMailboxUids.size > 0 ? { mailboxUid: `nin(${[...holds.heldMailboxUids].join(",")})` } : {}),
                    dateCreated: `lt(${cutoff.toISOString()})`,
                    sort: { dateCreated: "ASC", uid: "ASC" },
                    limit: pageSize,
                    page,
                } as any,
                { ignoreACL: true, limit: pageSize, page, skipCache: true },
            );
            const fresh: Q[] = rows.slice(skipped % pageSize);
            if (fresh.length === 0) {
                break;
            }
            for (const entry of fresh) {
                if (purged >= this.batchSize) {
                    break;
                }
                try {
                    await this.quarantineEntryRepo.delete(entry.uid, { ignoreACL: true, purge: true });
                    purged++;
                } catch (err: any) {
                    this.logger?.warn(`QuarantineRetentionJob: failed to purge quarantine entry ${entry.uid}: ${err.message}`);
                    skipped++;
                    continue;
                }
                try {
                    if (entry.scanResultUid) {
                        await this.scanResultRepo.delete(entry.scanResultUid, { ignoreACL: true, purge: true });
                    }
                    await deleteBlobsIfUnreferenced(this._objectFactory!, this.blobStore, blobSources, [entry.rawBlobKey]);
                } catch (err: any) {
                    this.logger?.warn(`QuarantineRetentionJob: failed to clean up content of quarantine entry ${entry.uid}: ${err.message}`);
                }
            }
            if (rows.length < pageSize) {
                break;
            }
        }
    }
}
