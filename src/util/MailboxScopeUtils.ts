///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { JWTUser } from "@rapidrest/core";
import { RepoUtils } from "@rapidrest/service-core";
import { Mailbox } from "../models/types.js";

/**
 * Resolves the `Mailbox` owned by `user` (a mailbox's `ownerUserUid` field, not an ACL lookup — this runs with
 * `ignoreACL: true` deliberately, since it's used to derive the *scope* of what a query is allowed to touch,
 * not to check permission on an already-identified record). Returns `undefined` if `user` is unauthenticated
 * or owns no mailbox.
 *
 * See the doc comment on `findOrCreateWellKnownFolder`'s callers / `BaseMailboxScopedRoute` for why this
 * exists: per-record ACLs in this platform inherit from their class-level ACL whenever no record-specific
 * grant matches the caller, so a class-level grant broad enough to let any authenticated user list/read *some*
 * records of a type also lets them list/read records they don't personally own, once class-level `LIST`/`READ`
 * are opened up at all. The class-level ACL for every mailbox-owned entity in this library therefore denies
 * `LIST`/`READ`/`COUNT`/`EXISTS` to `.*` entirely (see each entity's `@Protect` policy), and routes that need
 * to list/count a caller's own records do so by explicitly scoping the query to their own mailbox and passing
 * `ignoreACL: true` for that specific, safely-bounded query — the same pattern this function supports.
 */
export async function resolveCallerMailboxUid<M extends Mailbox>(
    mailboxRepo: RepoUtils<M>,
    user?: JWTUser,
): Promise<string | undefined> {
    if (!user) {
        return undefined;
    }
    const mailboxes: M[] = await mailboxRepo.find({ ownerUserUid: user.uid }, { ignoreACL: true, limit: 1 });
    return mailboxes[0]?.uid;
}
