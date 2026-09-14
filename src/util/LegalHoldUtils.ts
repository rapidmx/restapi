///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type ObjectFactory } from "@rapidrest/core";
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { Matter } from "../models/types.js";
import { findPagesByUid } from "./MailboxContentUtils.js";

/** Caches one `RepoUtils` per concrete `Matter` class (Mongo vs SQL) - mirrors `EscrowUtils.ts`'s
 * identical `getEscrowScopeRepo()` pattern. */
const matterRepoCache = new WeakMap<any, Promise<RepoUtils<Matter>>>();

function getMatterRepo(objectFactory: ObjectFactory, matterClass: any): Promise<RepoUtils<Matter>> {
    let cached = matterRepoCache.get(matterClass);
    if (!cached) {
        cached = Promise.resolve(objectFactory.newInstance(RepoUtils, { name: matterClass.name, args: [matterClass] }));
        matterRepoCache.set(matterClass, cached);
    }
    return cached;
}

/** Fetches every page of `repo.find()` results - see `MailboxContentUtils`' identical rationale
 * (a bare, unpaginated `find()` silently truncates at 100 rows). Unlike `EscrowScope` (admin-only,
 * `@RequiresTrustedRole()`-gated creation, so genuinely a handful of rows in practice - see
 * `EscrowUtils.findHeldScopeIds()`), `Matter` is holder-gated CRUD, not admin-gated: any holder can create
 * one, so the global count can plausibly exceed the default page size in a real deployment. A hold check
 * that silently misses a real, active hold past the 100th row would be a legal-hold-enforcement failure,
 * not just an incomplete listing. */
async function findAllMatters(repo: RepoUtils<Matter>, pageSize: number = 500): Promise<Matter[]> {
    const all: Matter[] = [];
    // Keyset-paged on `uid` (see `findPagesByUid()`): unsorted offset paging can skip or repeat rows between pages.
    for await (const batch of findPagesByUid<Matter>(repo, {}, pageSize)) {
        all.push(...batch);
    }
    return all;
}

/**
 * A snapshot of every open `Matter`, loaded once, for a job that has to check many records against legal holds -
 * `findActiveHoldsFor()` reads every `Matter` on each call, which is far too costly per message in a batch.
 * A hold placed after the snapshot was taken isn't seen; callers reload between batches to keep that window short.
 */
export interface LegalHoldIndex {
    /** Every mailbox uid named as a custodian by at least one open `Matter`, regardless of date range. */
    heldMailboxUids: Set<string>;
    /** `true` if an open `Matter` holds `mailboxUid` (at `referenceDate`, when given - see `findActiveHoldsFor()`). */
    isHeld(mailboxUid: string, referenceDate?: Date): boolean;
}

/** Loads a `LegalHoldIndex` - see its doc comment. */
export async function loadLegalHoldIndex(objectFactory: ObjectFactory, matterClass: any): Promise<LegalHoldIndex> {
    const repo: RepoUtils<Matter> = await getMatterRepo(objectFactory, matterClass);
    const open: Matter[] = (await findAllMatters(repo)).filter((matter) => !matter.closedAt);
    const byMailbox: Map<string, Matter[]> = new Map();
    for (const matter of open) {
        for (const mailboxUid of matter.custodianMailboxUids ?? []) {
            const list: Matter[] = byMailbox.get(mailboxUid) ?? [];
            list.push(matter);
            byMailbox.set(mailboxUid, list);
        }
    }
    return {
        heldMailboxUids: new Set(byMailbox.keys()),
        isHeld(mailboxUid: string, referenceDate?: Date): boolean {
            const matters: Matter[] = byMailbox.get(mailboxUid) ?? [];
            if (!referenceDate) {
                return matters.length > 0;
            }
            return matters.some((matter) => matterCovers(matter, referenceDate));
        },
    };
}

function matterCovers(matter: Matter, referenceDate: Date): boolean {
    return (
        referenceDate.getTime() >= new Date(matter.dateRangeStart).getTime() &&
        referenceDate.getTime() <= new Date(matter.dateRangeEnd).getTime()
    );
}

/**
 * Every open `Matter` that places `mailboxUid` under legal hold - a `Matter` names its
 * `custodianMailboxUids`, a `dateRangeStart`/`dateRangeEnd`, and is open until `closedAt` is set (see
 * `Matter`'s own doc comment in `models/types.ts`). When `referenceDate` is given, only a `Matter` whose
 * range actually covers it counts (e.g. a `Message.sentDate` outside the matter's date range was never
 * in scope for it); omit it for a whole-record operation with no single date to check (e.g. deleting an
 * entire `Mailbox`), which matches any open hold on that mailbox regardless of range.
 *
 * Fetches every `Matter` (paginated - see `findAllMatters()`) and filters client-side rather than querying
 * by `custodianMailboxUids` directly - client-side filtering is still fine at this scale (a real
 * deployment's open litigation/compliance holds are nothing like message-count scale), but unlike
 * `EscrowUtils.findHeldScopeIds()`'s admin-only `EscrowScope`, `Matter` is holder-gated CRUD, so the row
 * count isn't bounded the same way and a bare, unpaginated `find()` could silently miss a real hold.
 */
export async function findActiveHoldsFor(
    objectFactory: ObjectFactory,
    matterClass: any,
    mailboxUid: string,
    referenceDate?: Date,
): Promise<Matter[]> {
    const repo: RepoUtils<Matter> = await getMatterRepo(objectFactory, matterClass);
    const matters: Matter[] = await findAllMatters(repo);
    return matters.filter((matter) => {
        if (matter.closedAt || !matter.custodianMailboxUids.includes(mailboxUid)) {
            return false;
        }
        if (!referenceDate) {
            return true;
        }
        return referenceDate.getTime() >= matter.dateRangeStart.getTime() && referenceDate.getTime() <= matter.dateRangeEnd.getTime();
    });
}

/**
 * Throws a `409` naming the blocking `Matter`(s) if `mailboxUid` (at `referenceDate`, when given) is
 * under an active legal hold - see `findActiveHoldsFor()`. Callers use this ONLY to guard a permanent
 * (`purge: true`) delete or an equivalent irreversible operation (GDPR erasure, retention-driven purge) -
 * an ordinary soft-delete stays unaffected, since the record remains recoverable and thus still
 * discoverable. Blocking erasure this way is the legally correct behavior under GDPR Article 17(3), not
 * a workaround to route around.
 */
export async function assertNotOnLegalHold(
    objectFactory: ObjectFactory,
    matterClass: any,
    mailboxUid: string,
    referenceDate?: Date,
): Promise<void> {
    const holds: Matter[] = await findActiveHoldsFor(objectFactory, matterClass, mailboxUid, referenceDate);
    if (holds.length > 0) {
        throw new ApiError(
            ApiErrors.IDENTIFIER_EXISTS,
            409,
            `This action is blocked by an active legal hold: ${holds.map((m) => m.uid).join(", ")}.`,
        );
    }
}
