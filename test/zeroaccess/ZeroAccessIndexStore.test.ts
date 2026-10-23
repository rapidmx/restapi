///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { isoWeekId } from "../../src/zeroaccess/ZeroAccessSealer.js";
import { isoWeekStart, zeroAccessSegmentBlobKey, zeroAccessSegmentUid } from "../../src/zeroaccess/ZeroAccessIndexStore.js";

describe("ZeroAccessIndexStore", () => {
    it("finds the Monday a week starts on, across year boundaries", () => {
        expect(isoWeekStart("2026-W01")?.toISOString()).toBe("2025-12-29T00:00:00.000Z");
        expect(isoWeekStart("2026-W43")?.toISOString()).toBe("2026-10-19T00:00:00.000Z");
        expect(isoWeekStart("2020-W53")?.toISOString()).toBe("2020-12-28T00:00:00.000Z");
        for (const date of [new Date("2026-01-01T12:00:00Z"), new Date("2027-01-03T23:59:59Z"), new Date()]) {
            expect(isoWeekStart(isoWeekId(date))!.getTime()).toBeLessThanOrEqual(date.getTime());
        }
    });

    it("refuses a malformed week and a week 53 the year doesn't have", () => {
        expect(isoWeekStart("2026-43")).toBeUndefined();
        expect(isoWeekStart("2026-W00")).toBeUndefined();
        expect(isoWeekStart("2026-W54")).toBeUndefined();
        expect(isoWeekStart("2025-W53")).toBeUndefined();
        expect(isoWeekStart("2026-W53")?.toISOString()).toBe("2026-12-28T00:00:00.000Z");
    });

    it("names one segment row per mailbox, week and origin, and a fresh blob per upload", () => {
        expect(zeroAccessSegmentUid("mb", "2026-W43", "zero-access")).toBe(zeroAccessSegmentUid("mb", "2026-W43", "zero-access"));
        expect(zeroAccessSegmentUid("mb", "2026-W43", "client")).not.toBe(zeroAccessSegmentUid("mb", "2026-W43", "zero-access"));
        expect(zeroAccessSegmentBlobKey("mb", "2026-W43", 2, "n")).toBe("za-index/mb/2026-W43/2-n");
    });
});
