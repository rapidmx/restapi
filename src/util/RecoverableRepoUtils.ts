///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MongoRepository, RecoverableBaseEntity, type RepoDeleteOptions, RepoUtils } from "@rapidrest/service-core";

/**
 * Extends `RepoUtils` to close a gap in service-core's own soft-delete path: `RepoUtils.delete()`'s
 * soft-delete branch (for a `RecoverableBaseEntity` subclass, when `purge` isn't requested) sets only
 * `deleted: true` — unlike `update()`, it does not bump `dateModified`/`version` (confirmed by reading its
 * source). EAS `Sync`'s per-folder watermark query (`find({dateModified: gt(lastSyncWatermark)})`, see
 * `eas/EasSyncKeyUtils.ts`) needs a soft-deleted row to surface exactly the way an ordinary field change
 * would, or a deletion would never be reported to a device that already synced the item.
 *
 * Stays entirely local to `@rapidrest/mail` (no service-core change): calls `super.delete()` unchanged for
 * everything else (permission checks, ACL cleanup, cache invalidation, notifications, rollback hooks) and
 * only adds one small follow-up write for the two fields service-core's own branch leaves alone. Wired in via
 * the `repoUtilsClass` extension point every concrete Mongo/SQL route already declares (`ModelRoute.ts`'s
 * `this._objectFactory.newInstance(this.repoUtilsClass || RepoUtils, ...)`), and by any job that builds a
 * `RepoUtils` directly for one of the same entity classes.
 *
 * `RepoUtils.truncate()` has no soft-delete branch at all (it always hard-deletes, recoverable or not) — a
 * bulk folder-empty is a documented, out-of-scope-for-this-override gap, not something this class fixes.
 *
 * @author Jean-Philippe Steinmetz
 */
export class RecoverableRepoUtils<T extends RecoverableBaseEntity> extends RepoUtils<T> {
    public async delete(uid: string, options: RepoDeleteOptions): Promise<void> {
        await super.delete(uid, options);

        if (options.purge || !this.repo) {
            return;
        }

        const dateModified: Date = new Date();
        if (this.repo instanceof MongoRepository) {
            await this.repo.updateMany({ uid } as any, { $set: { dateModified }, $inc: { version: 1 } } as any);
        } else {
            await this.repo.update({ uid } as any, { dateModified } as any);
            await this.repo.increment({ uid } as any, "version", 1);
        }
    }
}
