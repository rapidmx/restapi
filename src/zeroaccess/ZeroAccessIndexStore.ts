///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MongoRepository, type RepoUtils } from "@rapidrest/service-core";
import type { ZeroAccessSegmentOrigin } from "../models/types.js";
import { nameBasedUuid } from "../util/UuidUtils.js";
import { isoWeekId } from "./ZeroAccessSealer.js";

/** An ISO week id (`isoWeekId()`), e.g. `2026-W43`. */
export const WEEK_ID_PATTERN: RegExp = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;

/** The uid of a mailbox's segment row for a week and origin - one row per week and origin, replaced by each generation. */
export function zeroAccessSegmentUid(mailboxUid: string, weekId: string, origin: ZeroAccessSegmentOrigin): string {
    return nameBasedUuid(`za-segment:${mailboxUid}:${weekId}:${origin}`);
}

/** Where a segment generation's sealed file is stored. Random per upload, so a lost race never overwrites the winner's file. */
export function zeroAccessSegmentBlobKey(mailboxUid: string, weekId: string, generation: number, nonce: string): string {
    return `za-index/${mailboxUid}/${weekId}/${generation}-${nonce}`;
}

/** The start (Monday 00:00 UTC) of ISO week `weekId`, or `undefined` for a malformed id. */
export function isoWeekStart(weekId: string): Date | undefined {
    const match: RegExpExecArray | null = WEEK_ID_PATTERN.exec(weekId);
    if (!match) {
        return undefined;
    }
    const year: number = Number(match[1]);
    const week: number = Number(match[2]);
    // Week 1 is the week with the year's first Thursday, i.e. the one holding 4 January.
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const mondayOfWeek1: number = jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000;
    const start = new Date(mondayOfWeek1 + (week - 1) * 7 * 86_400_000);
    // A year has 52 or 53 weeks: week 53 of a 52-week year is really the next year's week 1, so it isn't a week of its own.
    return isoWeekId(start) === weekId ? start : undefined;
}

/** A week's pending (not yet compacted) entries of a mailbox. */
export interface PendingWeek {
    weekId: string;
    count: number;
    /** When the newest of them was written. */
    latestEntryAt: Date;
}

/**
 * A mailbox's pending `ZeroAccessIndexEntry` rows counted per week with one grouped query - a `$group` on MongoDB, a `GROUP BY` on SQL -
 * never loading an entry (their sealed content is the bulk of them). Ordered by week.
 */
export async function pendingEntriesByWeek(entryRepo: RepoUtils<any>, mailboxUid: string): Promise<PendingWeek[]> {
    const repo: any = entryRepo.repo;
    const rows: any[] =
        repo instanceof MongoRepository
            ? await repo
                  .aggregate([
                      { $match: { mailboxUid } },
                      { $group: { _id: "$weekId", count: { $sum: 1 }, latest: { $max: "$dateCreated" } } },
                  ])
                  .toArray()
            : await repo
                  .createQueryBuilder("e")
                  .select("e.weekId", "_id")
                  .addSelect("COUNT(*)", "count")
                  .addSelect("MAX(e.dateCreated)", "latest")
                  .where("e.mailboxUid = :mailboxUid", { mailboxUid })
                  .groupBy("e.weekId")
                  .getRawMany();
    return rows
        .map((row) => ({ weekId: String(row._id), count: Number(row.count), latestEntryAt: new Date(row.latest) }))
        .sort((a, b) => a.weekId.localeCompare(b.weekId));
}
