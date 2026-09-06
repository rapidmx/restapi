///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { DeviceSyncState } from "../models/types.js";
const { Config, Init, Logger } = ObjectDecorators;

/**
 * Prunes `DeviceSyncState` rows for EAS devices that haven't synced in more than `device_ttl_days` days (or
 * that have never successfully synced at all), keeping the collection from growing unbounded with abandoned
 * device pairings.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`EasDeviceStateCleanupJobMongo`/
 * `EasDeviceStateCleanupJobSQL`), following the same generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class EasDeviceStateCleanupJob<D extends DeviceSyncState> extends BackgroundService {
    protected abstract deviceSyncStateClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private deviceSyncStateRepo?: RepoUtils<D>;

    @Config("mail:jobs:eas_device_cleanup:schedule", "0 0 4 * * *")
    private scheduleExpr: string = "0 0 4 * * *";

    @Config("mail:jobs:eas_device_cleanup:batch_size", 500)
    private batchSize: number = 500;

    @Config("mail:jobs:eas_device_cleanup:device_ttl_days", 90)
    private deviceTtlDays: number = 90;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.deviceSyncStateRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.deviceSyncStateClass.name,
            args: [this.deviceSyncStateClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.deviceSyncStateRepo) {
            return;
        }

        const cutoff: Date = new Date(Date.now() - this.deviceTtlDays * 24 * 60 * 60 * 1000);

        // `ModelUtils.buildSearchQuery` supports single-sided `lt(...)` comparisons with correct Date
        // coercion on both backends, so the "stale" half of this job's criteria is pushed into the query. The
        // "never synced at all" half (`lastSyncAt` unset) is a separate, plain-equality query rather than an
        // `$or` of the two — `$or` support isn't confirmed identical across both backends' query builders, and
        // a second bounded query is just as cheap for a low-frequency daily cleanup job.
        //
        // `limit` is passed both via `options` (all the Mongo backend of `RepoUtils.find()` actually reads)
        // *and* baked into each query object (all `ModelUtils.buildSearchQuerySQL` reads - it ignores
        // `options.limit` entirely and falls back to its own default of 100 otherwise). Confirmed by
        // real-database testing: on the SQL backend, `options.limit` alone silently caps at 100 regardless of
        // the configured batch size.
        const [stale, neverSynced]: [D[], D[]] = await Promise.all([
            this.deviceSyncStateRepo.find(
                { lastSyncAt: `lt(${cutoff.toISOString()})`, limit: this.batchSize } as any,
                { ignoreACL: true, limit: this.batchSize },
            ),
            this.deviceSyncStateRepo.find(
                { lastSyncAt: null, limit: this.batchSize } as any,
                { ignoreACL: true, limit: this.batchSize },
            ),
        ]);

        for (const row of [...stale, ...neverSynced]) {
            try {
                await this.deviceSyncStateRepo.delete(row.uid, { ignoreACL: true, purge: true });
            } catch (err: any) {
                this.logger?.warn(`EasDeviceStateCleanupJob: failed to delete stale device sync state ${row.uid}: ${err.message}`);
            }
        }
    }
}
