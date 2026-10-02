///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "../../src/util/TimeZoneUtils.js";

describe("isValidTimeZone", () => {
    it("accepts the IANA names a browser reports", () => {
        expect(DEFAULT_TIME_ZONE).toBe("UTC");
        for (const zone of ["UTC", "America/Los_Angeles", "Europe/Paris", "Asia/Kolkata"]) {
            expect(isValidTimeZone(zone)).toBe(true);
        }
    });

    it("refuses anything else, so nothing unchecked is stored", () => {
        for (const zone of [undefined, null, 5, "", "Mars/Olympus", "GMT+9 foo", "x".repeat(65), {}, ["UTC"]]) {
            expect(isValidTimeZone(zone)).toBe(false);
        }
    });

    it("refuses an offset zone and a lower-case spelling, which newer runtimes' Intl accepts but the doc excludes", () => {
        for (const zone of ["+03:00", "-08:00", "-0800", "america/new_york", "utc", "Europe/paris"]) {
            expect(isValidTimeZone(zone)).toBe(false);
        }
    });
});
