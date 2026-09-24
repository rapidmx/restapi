///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The time zone a mailbox has when nothing better is known (what its owner's device would say, for a self-service mailbox). */
export const DEFAULT_TIME_ZONE = "UTC";

/**
 * Whether `zone` is an IANA time zone name this runtime knows (`"America/Los_Angeles"`, `"UTC"`) - the form a browser reports
 * from `Intl.DateTimeFormat().resolvedOptions().timeZone`. Anything else, and anything with an offset or a name that only some
 * other implementation would accept, is `false`, so a value that came from a client is never stored unchecked.
 */
export function isValidTimeZone(zone: unknown): zone is string {
    if (typeof zone !== "string" || zone.length === 0 || zone.length > 64) {
        return false;
    }
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}
