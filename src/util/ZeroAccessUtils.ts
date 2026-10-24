///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Mailbox, SyncClients, ZeroAccessDataType, ZeroAccessKey, ZeroAccessTypes } from "../models/types.js";

/** Every data type zero-access encryption can cover, in the order settings list them. */
export const ZERO_ACCESS_DATA_TYPES: readonly ZeroAccessDataType[] = ["mail", "calendar", "contacts", "tasks"];

/** Whether `value` is one of `ZERO_ACCESS_DATA_TYPES`. */
export function isZeroAccessDataType(value: unknown): value is ZeroAccessDataType {
    return ZERO_ACCESS_DATA_TYPES.includes(value as ZeroAccessDataType);
}

/** Whether the mailbox's `zeroAccessTypes` includes `type`. An undecided type: mail is on (as it was before types existed), the
 * others are off until `settleZeroAccessTypes()` decides them. */
export function zeroAccessTypeIncluded(mailbox: Pick<Mailbox, "zeroAccessTypes">, type: ZeroAccessDataType): boolean {
    const chosen: boolean | undefined = mailbox.zeroAccessTypes?.[type];
    return typeof chosen === "boolean" ? chosen : type === "mail";
}

/** The data types the mailbox's ActiveSync and Outlook clients sync: each ActiveSync device's own, and every type for Outlook. */
export function syncedDataTypes(syncClients: SyncClients | null | undefined): Set<ZeroAccessDataType> {
    const types: Set<ZeroAccessDataType> = new Set();
    for (const device of syncClients?.activesync?.devices ?? []) {
        for (const type of device.types ?? []) {
            if (isZeroAccessDataType(type)) {
                types.add(type);
            }
        }
    }
    if (syncClients?.mapi) {
        ZERO_ACCESS_DATA_TYPES.forEach((type) => types.add(type));
    }
    return types;
}

/**
 * The default for each data type (`specs/search.md` §3 *What It Covers*): on, except a type the owner's ActiveSync or Outlook
 * clients sync - those can't read it protected - which is off. Mail is the exception among those: on once the owner has exported
 * their keys (`zeroAccessKeysExportedAt`), since a device with the key installed reads protected mail.
 */
export function defaultZeroAccessTypes(mailbox: Pick<Mailbox, "syncClients" | "zeroAccessKeysExportedAt">): Required<ZeroAccessTypes> {
    const synced: Set<ZeroAccessDataType> = syncedDataTypes(mailbox.syncClients);
    return {
        mail: !synced.has("mail") || !!mailbox.zeroAccessKeysExportedAt,
        calendar: !synced.has("calendar"),
        contacts: !synced.has("contacts"),
        tasks: !synced.has("tasks"),
    };
}

/**
 * The mailbox's `zeroAccessTypes` with every undecided type decided, or `undefined` when none is undecided. A type the owner already
 * chose is kept. `activating`: zero-access is being turned on for the mailbox now, so mail takes its device default too; otherwise
 * an undecided mail stays on, so settling never takes protection away from mail that already has it.
 */
export function settleZeroAccessTypes(
    mailbox: Pick<Mailbox, "zeroAccessTypes" | "syncClients" | "zeroAccessKeysExportedAt">,
    activating: boolean,
): Required<ZeroAccessTypes> | undefined {
    const chosen: ZeroAccessTypes = mailbox.zeroAccessTypes ?? {};
    if (ZERO_ACCESS_DATA_TYPES.every((type) => typeof chosen[type] === "boolean")) {
        return undefined;
    }
    const defaults: Required<ZeroAccessTypes> = defaultZeroAccessTypes(mailbox);
    const settled = {} as Required<ZeroAccessTypes>;
    for (const type of ZERO_ACCESS_DATA_TYPES) {
        const own: boolean | undefined = chosen[type];
        settled[type] = typeof own === "boolean" ? own : type === "mail" && !activating ? true : defaults[type];
    }
    return settled;
}

/**
 * Why zero-access encryption (`specs/search.md` §3) is or isn't in effect for a mailbox - one value per reason, so a
 * client can explain a disabled setting instead of just showing it off.
 *
 * - `active`: mail is encrypted at rest on arrival.
 * - `disabled_by_admin`: the server's "Allow zero-access encryption" is off (`EncryptionPolicy.allowZeroAccess`).
 * - `disabled_by_owner`: the mailbox's own "Enable zero-access encryption" is off (`Mailbox.zeroAccessEnabled`).
 * - `type_not_included`: the mailbox's "What to protect" leaves this data type out (`Mailbox.zeroAccessTypes`).
 * - `no_key`: no zero-access key is enrolled yet. The owner's client provisions one the next time they unlock; for a mailbox without an
 * owner, the client of a member with full access does, wrapping it to every member (`KeyVault.memberKeyWraps`).
 *
 * A shared mailbox - one with delegates, or with no owner - is no exception: its members read it through member key wraps
 * (`specs/search.md` §3 *Shared Mailboxes*).
 */
export type ZeroAccessStatus = "active" | "disabled_by_admin" | "disabled_by_owner" | "type_not_included" | "no_key";

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

/** Whether zero-access encryption is in effect for `type` (mail unless given) of `mailbox` and, if not, why - see
 * `ZeroAccessStatus`. The checks run in the order a user can act on them: the administrator's switch first, then the owner's, then
 * the owner's choice of types, then its key. */
export function zeroAccessStatus(
    mailbox: Pick<Mailbox, "ownerUserUid" | "zeroAccessEnabled" | "zeroAccessKeys" | "zeroAccessTypes">,
    context: ZeroAccessContext,
    type: ZeroAccessDataType = "mail",
): ZeroAccessStatus {
    if (context.allowZeroAccess === false) {
        return "disabled_by_admin";
    }
    // Unset (or a SQL `null` from before the column existed) means on.
    if (mailbox.zeroAccessEnabled === false) {
        return "disabled_by_owner";
    }
    if (!zeroAccessTypeIncluded(mailbox, type)) {
        return "type_not_included";
    }
    return activeZeroAccessKey(mailbox) ? "active" : "no_key";
}

/** Whether new `type` content (mail unless given) of `mailbox` must be encrypted at rest - `zeroAccessStatus()` is `active`. */
export function isZeroAccessActive(
    mailbox: Pick<Mailbox, "ownerUserUid" | "zeroAccessEnabled" | "zeroAccessKeys" | "zeroAccessTypes">,
    context: ZeroAccessContext,
    type: ZeroAccessDataType = "mail",
): boolean {
    return zeroAccessStatus(mailbox, context, type) === "active";
}
