///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { OofReplySuppression } from "../models/types.js";
const { Config, Init, Logger } = ObjectDecorators;

/**
 * Purges `OofReplySuppression` rows once they're older than `retention_days` - by then well past any realistic
 * `mail:oof:resuppress_after_hours` setting `ScanQueueJob` checks them against, so a row is only ever purged
 * once it's already useless. Direct structural copy of `QuarantineRetentionJob`, this library's only precedent
 * for "purge an aging log-like entity."
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`OofReplySuppressionCleanupJobMongo`/
 * `OofReplySuppressionCleanupJobSQL`), following the same generic pattern `QuarantineRetentionJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class OofReplySuppressionCleanupJob<OS extends OofReplySuppression> extends BackgroundService {
    protected abstract oofReplySuppressionClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private oofReplySuppressionRepo?: RepoUtils<OS>;

    @Config("mail:jobs:oof_suppression_cleanup:schedule", "0 30 6 * * *")
    private scheduleExpr: string = "0 30 6 * * *";

    @Config("mail:jobs:oof_suppression_cleanup:batch_size", 500)
    private batchSize: number = 500;

    @Config("mail:jobs:oof_suppression_cleanup:retention_days", 30)
    private retentionDays: number = 30;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.oofReplySuppressionRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.oofReplySuppressionClass.name,
            args: [this.oofReplySuppressionClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.oofReplySuppressionRepo) {
            return;
        }

        const cutoff: Date = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);

        const expired: OS[] = await this.oofReplySuppressionRepo.find(
            { lastRepliedAt: `lt(${cutoff.toISOString()})`, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const entry of expired) {
            try {
                await this.oofReplySuppressionRepo.delete(entry.uid, { ignoreACL: true, purge: true });
            } catch (err: any) {
                this.logger?.warn(`OofReplySuppressionCleanupJob: failed to purge suppression entry ${entry.uid}: ${err.message}`);
            }
        }
    }
}
