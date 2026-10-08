///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { CURRENT_IANA_ZONE, IANA_TO_WINDOWS_ZONE, WINDOWS_ZONE_TO_IANA } from "./WindowsZoneData.js";

/** `WINDOWS_ZONE_TO_IANA` keyed case-insensitively, plus the localized display name some clients send in place of
 * the Windows id for UTC. */
const IANA_BY_WINDOWS_LOWER: ReadonlyMap<string, string> = new Map([
    ...Object.entries(WINDOWS_ZONE_TO_IANA).map(([windows, iana]) => [windows.toLowerCase(), iana] as [string, string]),
    ["coordinated universal time", "UTC"],
]);

const WINDOWS_BY_IANA_LOWER: ReadonlyMap<string, string> = new Map(
    Object.entries(IANA_TO_WINDOWS_ZONE).map(([iana, windows]) => [iana.toLowerCase(), windows]),
);

const CURRENT_BY_LOWER: ReadonlyMap<string, string> = new Map(
    Object.entries(CURRENT_IANA_ZONE).map(([legacy, current]) => [legacy.toLowerCase(), current]),
);

/**
 * The current IANA name for `zone` when it's a legacy alias CLDR knows (`Asia/Katmandu` -> `Asia/Kathmandu`,
 * `US/Pacific` -> `America/Los_Angeles`), matched case-insensitively; any other name is returned unchanged. The
 * runtime's own zone list (`Intl.supportedValuesOf("timeZone")`) still uses many legacy names.
 */
export function currentIanaZone(zone: string): string {
    return CURRENT_BY_LOWER.get(zone.trim().toLowerCase()) ?? zone;
}

/**
 * The IANA zone for a Windows time zone id (`"Pacific Standard Time"` -> `"America/Los_Angeles"`), matched
 * case-insensitively, or `undefined` for a name that isn't one. Uses CLDR's representative ("001") zone for each
 * Windows id - see `WindowsZoneData.ts`.
 */
export function ianaZoneForWindowsZone(name: string): string | undefined {
    return IANA_BY_WINDOWS_LOWER.get(name.trim().toLowerCase());
}

/**
 * The Windows time zone id for an IANA zone (`"Europe/Berlin"` -> `"W. Europe Standard Time"`), or `undefined` when
 * CLDR maps it to none. Accepts any IANA alias CLDR knows (`Asia/Kolkata` and `Asia/Calcutta` alike), and whatever
 * spelling `Intl` itself resolves the zone to, matched case-insensitively.
 */
export function windowsZoneForIanaZone(zone: string): string | undefined {
    const direct = WINDOWS_BY_IANA_LOWER.get(zone.trim().toLowerCase());
    if (direct) {
        return direct;
    }
    try {
        const resolved: string = new Intl.DateTimeFormat("en-US", { timeZone: zone.trim() }).resolvedOptions().timeZone;
        return WINDOWS_BY_IANA_LOWER.get(resolved.toLowerCase());
    } catch {
        return undefined;
    }
}
