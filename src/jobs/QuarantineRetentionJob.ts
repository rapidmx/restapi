///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { QuarantineEntry } from "../models/types.js";
const { Config, Init, Logger } = ObjectDecorators;

/**
 * Purges `QuarantineEntry` rows (and, once `BlobStore` deletion is wired in here, their `rawBlobKey` payload)
 * once they've sat in quarantine longer than `retention_days`, whether or not they were ever released. A
 * released entry is retained for the same window as an unreleased one — this job doesn't distinguish between
 * them, since both represent quarantine history an operator may want to review for that same window.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`QuarantineRetentionJobMongo`/
 * `QuarantineRetentionJobSQL`), following the same generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class QuarantineRetentionJob<Q extends QuarantineEntry> extends BackgroundService {
    protected abstract quarantineEntryClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private quarantineEntryRepo?: RepoUtils<Q>;

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
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.quarantineEntryRepo) {
            return;
        }

        const cutoff: Date = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);

        // `ModelUtils.buildSearchQuery` supports single-sided `lt(...)` comparisons with correct Date
        // coercion on both backends, so retention age is pushed directly into the query rather than fetched
        // and filtered in-process.
        //
        // `limit` is passed both via `options` (all the Mongo backend of `RepoUtils.find()` actually reads)
        // *and* baked into the query object itself (all `ModelUtils.buildSearchQuerySQL` reads - it ignores
        // `options.limit` entirely and falls back to its own default of 100 otherwise). Confirmed by
        // real-database testing: on the SQL backend, `options.limit` alone silently caps at 100 regardless of
        // the configured batch size.
        const expired: Q[] = await this.quarantineEntryRepo.find(
            { dateCreated: `lt(${cutoff.toISOString()})`, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const entry of expired) {
            try {
                await this.quarantineEntryRepo.delete(entry.uid, { ignoreACL: true, purge: true });
            } catch (err: any) {
                this.logger?.warn(`QuarantineRetentionJob: failed to purge quarantine entry ${entry.uid}: ${err.message}`);
            }
        }
    }
}
