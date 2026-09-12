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

/** Fetches every page of `repo.find(criteria, ...)` results - see `MailboxQuotaRecalcJob.findAllPages()`'s
 * identical rationale (a bare, unpaginated `find()` silently truncates at 100 rows). An export/eDiscovery
 * collection must be complete, not a sample. */
async function findAllPages(repo: RepoUtils<any>, criteria: Record<string, any>, pageSize: number = 500): Promise<any[]> {
    const all: any[] = [];
    for (let page = 0; ; page++) {
        const batch: any[] = await repo.find({ ...criteria, limit: pageSize, page } as any, { ignoreACL: true, limit: pageSize, page });
        all.push(...batch);
        if (batch.length < pageSize) {
            break;
        }
    }
    return all;
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
 * a future, more deliberate per-type treatment rather than approximated poorly now). The lower bound is
 * pushed into the query itself (`gte(...)`); the upper bound is applied in-process, matching
 * `CalendarReminderJob`'s own documented reason for avoiding the query-DSL's two-sided `range(...)`
 * operator (unconfirmed cross-backend Date coercion) in favor of a single-sided one.
 *
 * `maxRows` bounds the total number of lines (across every entity type combined) this function will hold
 * in memory at once - an unbounded mailbox (or, for `MatterExportJob`, an unbounded custodian mailbox
 * within a larger matter) could otherwise grow this array without limit. Exceeding it throws rather than
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
): Promise<string[]> {
    const lines: string[] = [JSON.stringify({ entityType: "Mailbox", ...mailbox })];

    for (const [entityType, entityClass] of Object.entries(entityClasses) as [MailboxContentEntity, any][]) {
        const repo: RepoUtils<any> = await getRepo(objectFactory, entityClass);
        const criteria: Record<string, any> = { mailboxUid };
        if (entityType === "message" && messageDateRange) {
            criteria.sentDate = `gte(${messageDateRange.start.toISOString()})`;
        }
        let rows: any[] = await findAllPages(repo, criteria);
        if (entityType === "message" && messageDateRange) {
            rows = rows.filter((row) => new Date(row.sentDate).getTime() <= messageDateRange.end.getTime());
        }
        for (const row of rows) {
            lines.push(JSON.stringify({ entityType, ...row }));
            if (lines.length > maxRows) {
                throw new Error(`Mailbox ${mailboxUid}'s content exceeds the maximum of ${maxRows} exportable rows.`);
            }
        }
    }
    return lines;
}
