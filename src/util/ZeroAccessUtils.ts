///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Mailbox, ZeroAccessKey } from "../models/types.js";

/**
 * Why zero-access encryption (`specs/search.md` §3) is or isn't in effect for a mailbox - one value per reason, so a
 * client can explain a disabled setting instead of just showing it off.
 *
 * - `active`: mail is encrypted at rest on arrival.
 * - `disabled_by_admin`: the server's "Allow zero-access encryption" is off (`EncryptionPolicy.allowZeroAccess`).
 * - `disabled_by_owner`: the mailbox's own "Enable zero-access encryption" is off (`Mailbox.zeroAccessEnabled`).
 * - `no_key`: no zero-access key is enrolled yet. The owner's client provisions one the next time they unlock; for a mailbox without an
 * owner, the client of a member with full access does, wrapping it to every member (`KeyVault.memberKeyWraps`).
 *
 * A shared mailbox - one with delegates, or with no owner - is no exception: its members read it through member key wraps
 * (`specs/search.md` §3 *Shared Mailboxes*).
 */
export type ZeroAccessStatus = "active" | "disabled_by_admin" | "disabled_by_owner" | "no_key";

/** What `zeroAccessStatus()` needs beyond the mailbox itself. */
export interface ZeroAccessContext {
    /** The effective `EncryptionPolicy.allowZeroAccess` (the stored value, or `mail:zero_access:allowed`). */
    allowZeroAccess: boolean;
}

/**
 * The mailbox's current zero-access key: the unrevoked one with the latest `notBefore` (later position on a tie). Expiry is
 * deliberately ignored - only this server ever encrypts to the key, so an expired certificate carries no security meaning,
 * and treating it as absent would quietly drop the mailbox back to plaintext.
 */
export function activeZeroAccessKey(mailbox: Pick<Mailbox, "zeroAccessKeys">): ZeroAccessKey | undefined {
    let active: ZeroAccessKey | undefined;
    for (const key of mailbox.zeroAccessKeys ?? []) {
        if (!key.revokedAt && (!active || key.notBefore >= active.notBefore)) {
            active = key;
        }
    }
    return active;
}

/** Whether zero-access encryption is in effect for `mailbox` and, if not, why - see `ZeroAccessStatus`. The checks run in the
 * order a user can act on them: the administrator's switch first, then the owner's, then its key. */
export function zeroAccessStatus(
    mailbox: Pick<Mailbox, "ownerUserUid" | "zeroAccessEnabled" | "zeroAccessKeys">,
    context: ZeroAccessContext,
): ZeroAccessStatus {
    if (context.allowZeroAccess === false) {
        return "disabled_by_admin";
    }
    // Unset (or a SQL `null` from before the column existed) means on.
    if (mailbox.zeroAccessEnabled === false) {
        return "disabled_by_owner";
    }
    return activeZeroAccessKey(mailbox) ? "active" : "no_key";
}

/** Whether new mail for `mailbox` must be encrypted at rest - `zeroAccessStatus()` is `active`. */
export function isZeroAccessActive(
    mailbox: Pick<Mailbox, "ownerUserUid" | "zeroAccessEnabled" | "zeroAccessKeys">,
    context: ZeroAccessContext,
): boolean {
    return zeroAccessStatus(mailbox, context) === "active";
}
