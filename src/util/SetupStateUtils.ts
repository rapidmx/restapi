///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import { ApiErrors, type RepoUtils } from "@rapidrest/service-core";
import { SetupState } from "../models/types.js";
import { asEntity } from "./EntityUtils.js";
import { findOrCreateSingleton } from "./MailboxPolicyUtils.js";

/** The fixed identifier of the one `SetupState` row. */
export const SETUP_STATE_UID = "setup-state";

/** How many times a save that lost a concurrent save's optimistic-lock race is re-read and retried. */
export const SETUP_STATE_SAVE_ATTEMPTS = 5;

/**
 * Applies `patchFor(current)` to the `SetupState` row (created empty if there is none yet) with the row's optimistic version, re-reading and trying again
 * when a concurrent save won the race, up to `SETUP_STATE_SAVE_ATTEMPTS` times: what lets two administrators save wizard steps, and every replica record
 * the domains it seeded, without a lock. `patchFor` is called with the row as it is now on each attempt, so a patch built from it (an append to
 * `seededDomains`) never drops what the winner wrote; returning `undefined` saves nothing and returns the row as it is.
 */
export async function updateSetupState<T extends SetupState>(
    repo: RepoUtils<T>,
    patchFor: (current: T) => Promise<Partial<SetupState> | undefined>,
    user?: JWTUser,
): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        const existing: T = await findOrCreateSingleton(repo, SETUP_STATE_UID);
        const patch: Partial<SetupState> | undefined = await patchFor(existing);
        if (!patch) {
            return existing;
        }
        try {
            // As an entity, so the Mongo backend's plain document is version-checked whatever the service-core release (`asEntity()`).
            return await repo.update({ uid: existing.uid, version: (existing as any).version, ...patch } as any, asEntity(repo, existing), { user, ignoreACL: true });
        } catch (err: any) {
            // A lost race is a 409. `RepoUtils.update()` also reports a 500 when its own write landed but a concurrent write moved the row on before it read
            // the result back. Each patch is built from the row it is applied to, so both are retried.
            if (err instanceof ApiError && (err.status === 409 || err.code === ApiErrors.INTERNAL_ERROR) && attempt < SETUP_STATE_SAVE_ATTEMPTS) {
                continue;
            }
            throw err;
        }
    }
}
