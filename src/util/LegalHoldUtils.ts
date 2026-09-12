///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type ObjectFactory } from "@rapidrest/core";
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { Matter } from "../models/types.js";

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

/**
 * Every open `Matter` that places `mailboxUid` under legal hold - a `Matter` names its
 * `custodianMailboxUids`, a `dateRangeStart`/`dateRangeEnd`, and is open until `closedAt` is set (see
 * `Matter`'s own doc comment in `models/types.ts`). When `referenceDate` is given, only a `Matter` whose
 * range actually covers it counts (e.g. a `Message.sentDate` outside the matter's date range was never
 * in scope for it); omit it for a whole-record operation with no single date to check (e.g. deleting an
 * entire `Mailbox`), which matches any open hold on that mailbox regardless of range.
 *
 * Fetches every `Matter` and filters client-side rather than querying by `custodianMailboxUids` directly
 * - same reasoning `EscrowUtils.findHeldScopeIds()` already documents: the number of matters in a real
 * deployment (open litigation/compliance holds) is nothing like record-count scale.
 */
export async function findActiveHoldsFor(
    objectFactory: ObjectFactory,
    matterClass: any,
    mailboxUid: string,
    referenceDate?: Date,
): Promise<Matter[]> {
    const repo: RepoUtils<Matter> = await getMatterRepo(objectFactory, matterClass);
    const matters: Matter[] = await repo.find({}, { ignoreACL: true });
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
