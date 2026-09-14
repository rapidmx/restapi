///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { type ObjectFactory } from "@rapidrest/core";
import { RepoUtils } from "@rapidrest/service-core";
import { Mailbox } from "../models/types.js";

/** Every entity type (besides `Mailbox` itself) `collectMailboxContentLines()` collects - each
 * denormalizes `mailboxUid` directly, so no `Folder` join is needed to scope any of them. */
export type MailboxContentEntity = "message" | "contact" | "contactList" | "calendarEvent" | "task" | "note" | "attachment";

export type MailboxContentEntityClasses = Record<MailboxContentEntity, any>;

/** Default ceiling on the number of NDJSON lines (rows, across every entity type combined)
 * `collectMailboxContentLines()` will accumulate in memory for a single mailbox before giving up - see
 * that function's own doc comment for why. Callers (`DataExportJob`/`MatterExportJob`) expose this as
 * their own `@Config`-overridable field rather than hard-coding it here, since what counts as "too large"
 * depends on the deployment's available memory, not a value this library can confidently pick for every
 * installation. */
export const DEFAULT_MAX_MAILBOX_CONTENT_ROWS = 250_000;

async function getRepo(objectFactory: ObjectFactory, entityClass: any): Promise<RepoUtils<any>> {
    return await objectFactory.newInstance(RepoUtils, { name: entityClass.name, args: [entityClass] });
}

/**
 * Reads every row of `repo` matching `criteria`, one page at a time, using keyset paging on `uid`: each page is
 * `uid > <last uid of the previous page>` sorted by `uid` ascending. Offset paging without a sort (`page=N`) has no
 * stable order on either backend, so rows can be skipped or repeated between pages, and offset paging over a result
 * set the caller is deleting from shifts every later page. Keyset paging stays correct in both cases: a row deleted
 * behind the cursor doesn't move the cursor, and the order is identical on Mongo and SQL.
 *
 * `criteria` must not constrain `uid` itself. Queries are ACL-free and uncached (`skipCache`), and `limit` is passed
 * both in the query object and in `options` (the SQL backend reads only the former, Mongo only the latter). A row
 * inserted concurrently with a `uid` below the cursor isn't seen by this pass - callers that need to catch those
 * (e.g. a purge racing with delivery) run another pass.
 *
 * @param repo The repository to read.
 * @param criteria The search criteria (without `uid`, `sort`, `limit` or `page`).
 * @param pageSize Rows per page, clamped to 1..1000 (the framework's own maximum).
 */
export async function* findPagesByUid<T extends { uid: string } = any>(
    repo: RepoUtils<any>,
    criteria: Record<string, any>,
    pageSize: number = 500,
): AsyncGenerator<T[]> {
    const limit: number = Math.max(1, Math.min(Math.floor(pageSize) || 1, 1000));
    let after: string | undefined;
    for (;;) {
        const query: Record<string, any> = { ...criteria, sort: { uid: "ASC" }, limit };
        if (after !== undefined) {
            query.uid = `gt(${after})`;
        }
        const batch: T[] = await repo.find(query as any, { ignoreACL: true, limit, skipCache: true });
        if (batch.length === 0) {
            return;
        }
        yield batch;
        const last: string = batch[batch.length - 1].uid;
        // Defensive: a cursor that doesn't advance (a backend ignoring the `gt(...)` filter) would loop forever.
        if (batch.length < limit || (after !== undefined && !(last > after))) {
            return;
        }
        after = last;
    }
}

/**
 * Aggregates one mailbox's full content - `Mailbox` itself plus every `Message`/`Contact`/`ContactList`/
 * `CalendarEvent`/`Task`/`Note`/`Attachment` row it owns - into newline-delimited JSON lines, one object
 * per line, each tagged with an `entityType` field. Originally `DataExportJob`'s own private
 * `collectMailboxContent()` method, extracted here so `MatterExportJob` (a Matter-scoped eDiscovery
 * export spanning several mailboxes) can reuse the identical aggregation logic per custodian mailbox
 * rather than duplicating it - the reuse `DataExportJob`'s own doc comment always intended.
 *
 * `messageDateRange`, when given, narrows only the `Message` rows collected (by `sentDate`) - every other
 * entity type is still collected in full for the mailbox. This mirrors `LegalHoldUtils.
 * findActiveHoldsFor()`'s own asymmetric treatment (`Message.sentDate` is the one denormalized,
 * unambiguous "when did this happen" field across this set - `CalendarEvent`/`Task` have their own
 * differently-shaped date semantics that a generic single filter can't correctly express, and are left for
 * a future, more deliberate per-type treatment rather than approximated poorly now). Both bounds are pushed
 * into the query itself as one inclusive `range(start,end)` - the installed `@rapidrest/service-core`'s
 * `range(...)` coerces both operands through the same per-property Date coercion `gte(...)`/`lte(...)` use,
 * on both backends (verified by `MatterExportJob{Mongo,SQL}.test.ts`'s before-start/after-end fixtures) - so
 * out-of-range rows are never loaded, let alone counted against `maxRows`.
 *
 * `maxRows` bounds the total number of lines (across every entity type combined) this function will hold
 * in memory at once - an unbounded mailbox (or, for `MatterExportJob`, an unbounded custodian mailbox
 * within a larger matter) could otherwise grow this array without limit. The remaining budget is enforced
 * inside the paging loop, as each page arrives, so at most one page (`pageSize` rows) beyond the cap is ever
 * loaded before giving up - never the whole oversized table. Exceeding it throws rather than
 * silently truncating the export, since a partial eDiscovery/GDPR bundle that looks complete is worse than
 * one that visibly failed - both `DataExportJob.run()`/`MatterExportJob.run()` already catch a thrown
 * `processRequest()` error and route it through their own `markFailed()`, the same path a missing
 * mailbox/matter already takes, so no new error handling is needed at the call site.
 */
export async function collectMailboxContentLines(
    objectFactory: ObjectFactory,
    entityClasses: MailboxContentEntityClasses,
    mailboxUid: string,
    mailbox: Mailbox,
    messageDateRange?: { start: Date; end: Date },
    maxRows: number = DEFAULT_MAX_MAILBOX_CONTENT_ROWS,
    pageSize: number = 500,
): Promise<string[]> {
    const lines: string[] = [JSON.stringify({ entityType: "Mailbox", ...mailbox })];

    for (const [entityType, entityClass] of Object.entries(entityClasses) as [MailboxContentEntity, any][]) {
        const repo: RepoUtils<any> = await getRepo(objectFactory, entityClass);
        const criteria: Record<string, any> = { mailboxUid };
        if (entityType === "message" && messageDateRange) {
            criteria.sentDate = `range(${messageDateRange.start.toISOString()},${messageDateRange.end.toISOString()})`;
        }
        // Paged (a bare, unpaginated `find()` silently truncates at 100 rows) by stable keyset on `uid` - see
        // `findPagesByUid()` - with the row budget checked as each page arrives rather than after every page has
        // been loaded - an export/eDiscovery collection must be complete, not a sample, but also must not load
        // an unbounded table into memory just to discover it's too big.
        for await (const batch of findPagesByUid(repo, criteria, pageSize)) {
            if (lines.length + batch.length > maxRows) {
                throw new Error(`Mailbox ${mailboxUid}'s content exceeds the maximum of ${maxRows} exportable rows.`);
            }
            for (const row of batch) {
                lines.push(JSON.stringify({ entityType, ...row }));
            }
        }
    }
    return lines;
}
