///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import {
    FREE_BUSY_MAX_ADDRESSES,
    FREE_BUSY_MAX_WINDOW_MS,
    FREE_BUSY_VISIBILITIES,
    addressDomain,
    assertFreeBusyVisibility,
    effectiveFreeBusyVisibility,
    isFreeBusyVisibility,
    parseFreeBusyRequest,
} from "../../src/util/FreeBusyLookupUtils.js";

const START = "2026-06-01T09:00:00.000Z";
const END = "2026-06-02T09:00:00.000Z";

describe("FreeBusyLookupUtils Tests", () => {
    describe("visibility", () => {
        it("Names the four values, and only them.", () => {
            expect(FREE_BUSY_VISIBILITIES).toEqual(["domain", "shared", "nobody", "everyone"]);
            for (const value of FREE_BUSY_VISIBILITIES) {
                expect(isFreeBusyVisibility(value)).toBe(true);
            }
            for (const value of ["Domain", "", "all", 1, null, undefined, {}]) {
                expect(isFreeBusyVisibility(value)).toBe(false);
            }
        });

        it("Reads a row with no value - absent or null - as domain.", () => {
            expect(effectiveFreeBusyVisibility({})).toBe("domain");
            expect(effectiveFreeBusyVisibility({ freeBusyVisibility: null as any })).toBe("domain");
            expect(effectiveFreeBusyVisibility({ freeBusyVisibility: "nobody" })).toBe("nobody");
        });

        it("Refuses anything else with a 400.", () => {
            expect(() => assertFreeBusyVisibility("everyone")).not.toThrow();
            for (const value of ["bogus", 5, "", {}]) {
                try {
                    assertFreeBusyVisibility(value);
                    throw new Error("should have thrown");
                } catch (err: any) {
                    expect(err).toBeInstanceOf(ApiError);
                    expect(err.status).toBe(400);
                }
            }
        });

        it("Takes the domain of an address lowercased, after the last @.", () => {
            expect(addressDomain("Ada@Corp.Test")).toBe("corp.test");
            expect(addressDomain("  ada@corp.test ")).toBe("corp.test");
        });
    });

    describe("parseFreeBusyRequest()", () => {
        const status = (body: unknown): number | undefined => {
            try {
                parseFreeBusyRequest(body);
                return undefined;
            } catch (err: any) {
                return err instanceof ApiError ? err.status : -1;
            }
        };

        it("Normalizes and de-duplicates the addresses, keeping first-seen order, and parses the window.", () => {
            const parsed = parseFreeBusyRequest({ addresses: [" Ada@Corp.Test", "bob@corp.test", "ada@corp.test"], start: START, end: "2026-06-02T09:00:00+00:00" });

            expect(parsed.addresses).toEqual(["ada@corp.test", "bob@corp.test"]);
            expect(parsed.start.toISOString()).toBe(START);
            expect(parsed.end.toISOString()).toBe(END);
        });

        it("Accepts 50 addresses and a window of exactly 31 days.", () => {
            const addresses = Array.from({ length: FREE_BUSY_MAX_ADDRESSES }, (_, i) => `u${i}@corp.test`);
            const end = new Date(new Date(START).getTime() + FREE_BUSY_MAX_WINDOW_MS).toISOString();

            expect(status({ addresses, start: START, end })).toBeUndefined();
        });

        it("Refuses a body that is not an object, and missing, empty, oversized or non-list addresses (400).", () => {
            expect(status(undefined)).toBe(400);
            expect(status(null)).toBe(400);
            expect(status("x")).toBe(400);
            expect(status({ start: START, end: END })).toBe(400);
            expect(status({ addresses: "a@b.test", start: START, end: END })).toBe(400);
            expect(status({ addresses: [], start: START, end: END })).toBe(400);
            expect(status({ addresses: Array.from({ length: 51 }, (_, i) => `u${i}@corp.test`), start: START, end: END })).toBe(400);
        });

        it("Refuses an entry that is not one plain address (400).", () => {
            for (const bad of [5, null, {}, "", "nope", "a b@corp.test", "a@b@corp.test", "Ada <ada@corp.test>", "a,b@corp.test", "ada@corp.test\r\nbcc:x@y.test", `${"a".repeat(320)}@corp.test`]) {
                expect(status({ addresses: ["ok@corp.test", bad], start: START, end: END }), String(bad)).toBe(400);
            }
        });

        it("Refuses a start or end that is missing or not an ISO 8601 date-time (400).", () => {
            for (const bad of [undefined, null, 5, "", "tomorrow", "2026-06-01", "2026-13-45T00:00:00Z", { a: 1 }]) {
                expect(status({ addresses: ["a@corp.test"], start: bad, end: END }), String(bad)).toBe(400);
                expect(status({ addresses: ["a@corp.test"], start: START, end: bad }), String(bad)).toBe(400);
            }
        });

        it("Refuses an end that is not after the start, and a window of more than 31 days (400).", () => {
            expect(status({ addresses: ["a@corp.test"], start: END, end: START })).toBe(400);
            expect(status({ addresses: ["a@corp.test"], start: START, end: START })).toBe(400);
            const tooLong = new Date(new Date(START).getTime() + FREE_BUSY_MAX_WINDOW_MS + 1).toISOString();
            expect(status({ addresses: ["a@corp.test"], start: START, end: tooLong })).toBe(400);
        });
    });
});
