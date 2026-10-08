///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { currentIanaZone, ianaZoneForWindowsZone, windowsZoneForIanaZone } from "../../src/util/WindowsZones.js";
import { resolveTimeZone } from "../../src/util/IcsUtils.js";
import { IANA_TO_WINDOWS_ZONE, WINDOWS_ZONE_TO_IANA } from "../../src/util/WindowsZoneData.js";

describe("WindowsZones", () => {
    it("ianaZoneForWindowsZone() maps Windows ids to CLDR's representative zone, case-insensitively and trimmed.", () => {
        expect(ianaZoneForWindowsZone("Pacific Standard Time")).toBe("America/Los_Angeles");
        expect(ianaZoneForWindowsZone("  w. europe standard time ")).toBe("Europe/Berlin");
        expect(ianaZoneForWindowsZone("Morocco Standard Time")).toBe("Africa/Casablanca");
        expect(ianaZoneForWindowsZone("Coordinated Universal Time")).toBe("UTC");
        expect(ianaZoneForWindowsZone("Not A Zone")).toBeUndefined();
    });

    it("windowsZoneForIanaZone() maps IANA zones and their aliases, case-insensitively, and returns undefined for unknown or invalid zones.", () => {
        expect(windowsZoneForIanaZone("America/Los_Angeles")).toBe("Pacific Standard Time");
        expect(windowsZoneForIanaZone("america/vancouver")).toBe("Pacific Standard Time");
        expect(windowsZoneForIanaZone("Asia/Kolkata")).toBe("India Standard Time");
        expect(windowsZoneForIanaZone("Asia/Calcutta")).toBe("India Standard Time");
        expect(windowsZoneForIanaZone("Europe/Berlin")).toBe("W. Europe Standard Time");
        expect(windowsZoneForIanaZone("Not/AZone")).toBeUndefined();
    });

    it("currentIanaZone() maps legacy names to current ones, case-insensitively, and leaves any other name unchanged.", () => {
        expect(currentIanaZone("Asia/Katmandu")).toBe("Asia/Kathmandu");
        expect(currentIanaZone("asia/calcutta")).toBe("Asia/Kolkata");
        expect(currentIanaZone("US/Pacific")).toBe("America/Los_Angeles");
        expect(currentIanaZone("Europe/Berlin")).toBe("Europe/Berlin");
        expect(currentIanaZone("Not/AZone")).toBe("Not/AZone");
    });

    it("windowsZoneForIanaZone() falls back to the spelling Intl resolves the zone to.", () => {
        const resolved = new Intl.DateTimeFormat("en-US", { timeZone: "US/Eastern" }).resolvedOptions().timeZone;
        expect(windowsZoneForIanaZone(resolved)).toBe("Eastern Standard Time");
    });

    it("Every Windows id's representative zone is one Intl recognizes, and maps back to the same Windows id.", () => {
        for (const [windows, iana] of Object.entries(WINDOWS_ZONE_TO_IANA)) {
            expect(() => new Intl.DateTimeFormat("en-US", { timeZone: iana })).not.toThrow();
            expect(IANA_TO_WINDOWS_ZONE[iana]).toBe(windows);
        }
    });

    it("resolveTimeZone() now resolves any Windows id CLDR knows, not only the most common ones, and keeps IANA names as given.", () => {
        expect(resolveTimeZone("Mountain Standard Time (Mexico)")).toBe(ianaZoneForWindowsZone("Mountain Standard Time (Mexico)"));
        expect(resolveTimeZone('"Morocco Standard Time"')).toBe("Africa/Casablanca");
        expect(resolveTimeZone("UTC")).toBe("UTC");
        expect(resolveTimeZone("Asia/Kolkata")).toBe("Asia/Kolkata");
    });
});
