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
        // Paged (a bare, unpaginated `find()` silently truncates at 100 rows - see `MailboxQuotaRecalcJob.
        // findAllPages()`), with the row budget checked as each page arrives rather than after every page has
        // been loaded - an export/eDiscovery collection must be complete, not a sample, but also must not load
        // an unbounded table into memory just to discover it's too big.
        for (let page = 0; ; page++) {
            const batch: any[] = await repo.find({ ...criteria, limit: pageSize, page } as any, { ignoreACL: true, limit: pageSize, page });
            if (lines.length + batch.length > maxRows) {
                throw new Error(`Mailbox ${mailboxUid}'s content exceeds the maximum of ${maxRows} exportable rows.`);
            }
            for (const row of batch) {
                lines.push(JSON.stringify({ entityType, ...row }));
            }
            if (batch.length < pageSize) {
                break;
            }
        }
    }
    return lines;
}
