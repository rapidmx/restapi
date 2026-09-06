///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, ACLUtils, RepoUtils, type AccessControlList } from "@rapidrest/service-core";
import { CalendarShareLink } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/**
 * Garbage-collects expired `CalendarShareLink` rows (anonymous external calendar-sharing links whose
 * `expiresAt` has passed), also revoking the `ACLRecord` each link's `token` was granted on its shared
 * folder's `AccessControlList` (see `BaseCalendarShareLinkRoute`, which grants/upserts that same record on
 * create/update — this job is the other half of keeping it in sync, for links that expire rather than being
 * explicitly deleted via the API).
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`ExternalShareExpirationJobMongo`/
 * `ExternalShareExpirationJobSQL`), following the same generic pattern `ScanQueueJob` uses.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class ExternalShareExpirationJob<S extends CalendarShareLink> extends BackgroundService {
    protected abstract calendarShareLinkClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private calendarShareLinkRepo?: RepoUtils<S>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Config("mail:jobs:external_share_expiration:schedule", "0 0 5 * * *")
    private scheduleExpr: string = "0 0 5 * * *";

    @Config("mail:jobs:external_share_expiration:batch_size", 500)
    private batchSize: number = 500;

    @Logger
    private logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        this.calendarShareLinkRepo = await this._objectFactory!.newInstance(RepoUtils, {
            name: this.calendarShareLinkClass.name,
            args: [this.calendarShareLinkClass],
        });
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    public async run(): Promise<void> {
        if (!this.calendarShareLinkRepo) {
            return;
        }

        const now: Date = new Date();

        // `ModelUtils.buildSearchQuery` supports single-sided `lt(...)`/`gt(...)`/`gte(...)`/`lte(...)`
        // comparisons with correct Date coercion on both backends (only its two-sided `range(...)` operator
        // has a documented Date-coercion gap) - a plain `lt(now)` on `expiresAt` also naturally excludes rows
        // where it's unset, on both Mongo (`$lt` against a missing field never matches) and SQL (comparing
        // NULL is never true), so this needs no additional in-process filtering for that case.
        //
        // `limit` is passed both via `options` (all the Mongo backend of `RepoUtils.find()` actually reads)
        // *and* baked into the query object itself (all `ModelUtils.buildSearchQuerySQL` reads - it ignores
        // `options.limit` entirely and falls back to its own default of 100 otherwise). Confirmed by
        // real-database testing: on the SQL backend, `options.limit` alone silently caps at 100 regardless of
        // the configured batch size.
        const links: S[] = await this.calendarShareLinkRepo.find(
            { expiresAt: `lt(${now.toISOString()})`, limit: this.batchSize } as any,
            { ignoreACL: true, limit: this.batchSize },
        );

        for (const link of links) {
            try {
                await this.calendarShareLinkRepo.delete(link.uid, { ignoreACL: true, purge: true });
                await this.revokeShareTokenAccess(link.folderUid, link.token);
            } catch (err: any) {
                this.logger?.warn(`ExternalShareExpirationJob: failed to delete expired share link ${link.uid}: ${err.message}`);
            }
        }
    }

    /** Removes any ACL record for `token` from `folderUid`'s ACL - see `BaseCalendarShareLinkRoute`'s identical
     * helper for the full rationale (kept as a separate copy here rather than a shared import, since this job
     * has no other dependency on the routes layer and the logic is a few lines). A no-op if the folder has no
     * ACL document or no matching record - failing open here keeps a missing/corrupt folder ACL from turning a
     * routine expiration sweep into a failed job run for every OTHER link in the same batch. */
    private async revokeShareTokenAccess(folderUid: string, token: string): Promise<void> {
        const acl: AccessControlList | undefined = await this.aclUtils?.findACL(folderUid);
        if (!acl) {
            return;
        }
        const records = acl.records.filter((record) => record.userOrRoleId !== token);
        if (records.length === acl.records.length) {
            return;
        }
        acl.records = records;
        await this.aclUtils!.saveACL(acl);
    }
}
