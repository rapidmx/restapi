///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** A user uid as this platform issues them: a lowercase UUID. Never a role name, `anonymous`, or the `.*`/`*` wildcards
 * the ACL system also understands - any of which, used where one user is meant, would reach far more than one person. */
export const USER_UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `value` as a user uid - lowercased, since ACL records and `Mailbox.ownerUserUid` are compared as exact strings - or
 * `undefined` when it isn't UUID-shaped.
 */
export function normalizeUserUid(value: unknown): string | undefined {
    const lower: string | undefined = typeof value === "string" ? value.toLowerCase() : undefined;
    return lower !== undefined && USER_UID_PATTERN.test(lower) ? lower : undefined;
}
