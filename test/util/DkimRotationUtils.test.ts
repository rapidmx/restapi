///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Pure unit tests for the DKIM rotation helpers: selectors, dates read back from either backend, the schedule, the live check of a new key and why a
// domain can't rotate. The state machine itself is covered against real databases by test/jobs/dkimRotationSuite.ts.
import {
    configNumber,
    dkimRotationBlocker,
    isConfigFlagOn,
    isDkimKeyLive,
    keptDkimRotationState,
    newDkimSelector,
    nextScheduledDkimRotation,
    resolveDkimManaged,
    rotationDate,
} from "../../src/util/DkimRotationUtils.js";
import { StaticDnsResolver } from "../testDoubles.js";

const DAY = 86_400_000;

describe("DkimRotationUtils", () => {
    describe("newDkimSelector()", () => {
        const now = new Date("2026-10-27T23:30:00Z");

        it("Is rmx<yyyymmdd> in UTC.", () => {
            expect(newDkimSelector(now, [])).toBe("rmx20261027");
            expect(newDkimSelector(new Date("2027-01-05T00:00:00Z"), ["mail"])).toBe("rmx20270105");
        });

        it("Appends b, c, ... on a same-day collision, ignoring unset entries.", () => {
            expect(newDkimSelector(now, ["rmx20261027", undefined, null])).toBe("rmx20261027b");
            expect(newDkimSelector(now, ["rmx20261027", "rmx20261027b"])).toBe("rmx20261027c");
        });

        it("Keeps going past z.", () => {
            const taken: string[] = ["rmx20261027", ..."bcdefghijklmnopqrstuvwxyz".split("").map((c) => `rmx20261027${c}`)];
            expect(newDkimSelector(now, taken)).toBe("rmx20261027aa");
        });
    });

    describe("rotationDate()", () => {
        it("Reads a Date, an ISO string (SQL's JSON column) or a timestamp, and nothing else.", () => {
            const date = new Date("2026-10-27T12:00:00Z");
            expect(rotationDate(date)).toEqual(date);
            expect(rotationDate("2026-10-27T12:00:00.000Z")).toEqual(date);
            expect(rotationDate(date.getTime())).toEqual(date);
            expect(rotationDate(undefined)).toBeUndefined();
            expect(rotationDate(null)).toBeUndefined();
            expect(rotationDate("not a date")).toBeUndefined();
            expect(rotationDate({})).toBeUndefined();
        });
    });

    describe("isConfigFlagOn()", () => {
        it("Takes the default when unset, and reads text the way the environment sets it.", () => {
            expect(isConfigFlagOn(undefined, true)).toBe(true);
            expect(isConfigFlagOn(null, false)).toBe(false);
            expect(isConfigFlagOn(false, true)).toBe(false);
            expect(isConfigFlagOn(0, true)).toBe(false);
            expect(isConfigFlagOn(true, false)).toBe(true);
            for (const off of ["false", "0", "no", " OFF "]) {
                expect(isConfigFlagOn(off, true)).toBe(false);
            }
            expect(isConfigFlagOn("true", false)).toBe(true);
            expect(isConfigFlagOn("yes", false)).toBe(true);
        });
    });

    describe("configNumber()", () => {
        it("Reads a non-negative number or its text, else the default.", () => {
            expect(configNumber(7, 1)).toBe(7);
            expect(configNumber("48", 1)).toBe(48);
            expect(configNumber(0, 1)).toBe(0);
            expect(configNumber(undefined, 180)).toBe(180);
            expect(configNumber("", 180)).toBe(180);
            expect(configNumber(-1, 180)).toBe(180);
            expect(configNumber("soon", 180)).toBe(180);
            expect(configNumber(Infinity, 180)).toBe(180);
        });
    });

    describe("nextScheduledDkimRotation()", () => {
        const created = new Date("2026-01-01T00:00:00Z");

        it("Counts the interval from the domain's creation before any rotation.", () => {
            expect(nextScheduledDkimRotation({ dateCreated: created }, 180)).toEqual(new Date(created.getTime() + 180 * DAY));
            expect(nextScheduledDkimRotation({ dateCreated: created.toISOString() as any, dkimRotation: { phase: "idle" } }, 10)).toEqual(
                new Date(created.getTime() + 10 * DAY),
            );
        });

        it("Counts from the latest of the last rotation and the last cancellation.", () => {
            const rotated = new Date("2026-03-01T00:00:00Z");
            const cancelled = new Date("2026-04-01T00:00:00Z");
            expect(nextScheduledDkimRotation({ dateCreated: created, dkimRotation: { phase: "idle", lastRotatedAt: rotated } }, 1)).toEqual(
                new Date(rotated.getTime() + DAY),
            );
            expect(
                nextScheduledDkimRotation({ dateCreated: created, dkimRotation: { phase: "idle", lastRotatedAt: rotated, lastCancelledAt: cancelled.toISOString() as any } }, 1),
            ).toEqual(new Date(cancelled.getTime() + DAY));
            expect(nextScheduledDkimRotation({ dateCreated: created, dkimRotation: { phase: "idle", lastRotatedAt: cancelled, lastCancelledAt: rotated } }, 1)).toEqual(
                new Date(cancelled.getTime() + DAY),
            );
        });

        it("Is unknown without any date to count from.", () => {
            expect(nextScheduledDkimRotation({}, 180)).toBeUndefined();
        });
    });

    describe("isDkimKeyLive()", () => {
        let resolver: StaticDnsResolver;
        beforeEach(() => {
            resolver = new StaticDnsResolver();
        });

        it("Is live when a TXT record at <selector>._domainkey.<domain> carries the key, its strings rejoined and spaces ignored.", async () => {
            resolver.records.set("rmx1._domainkey.example.com", [["v=DKIM1; k=rsa; ", "p=ABC", "DEF"]]);
            expect(await isDkimKeyLive(resolver, "example.com", "rmx1", "ABCDEF")).toBe(true);
            resolver.records.set("rmx1._domainkey.example.com", [["v=DKIM1; k=rsa; p=ABC DEF"]]);
            expect(await isDkimKeyLive(resolver, "example.com", "rmx1", "ABCDEF")).toBe(true);
        });

        it("Is not live for another key, no record or a failed lookup.", async () => {
            resolver.records.set("rmx1._domainkey.example.com", [["v=DKIM1; k=rsa; p=OTHER"]]);
            expect(await isDkimKeyLive(resolver, "example.com", "rmx1", "ABCDEF")).toBe(false);
            expect(await isDkimKeyLive(resolver, "example.com", "rmx2", "ABCDEF")).toBe(false);
            resolver.failing.add("rmx1._domainkey.example.com");
            expect(await isDkimKeyLive(resolver, "example.com", "rmx1", "OTHER")).toBe(false);
        });

        it("Is never live for an empty key.", async () => {
            resolver.records.set("rmx1._domainkey.example.com", [["v=DKIM1; k=rsa; p="]]);
            expect(await isDkimKeyLive(resolver, "example.com", "rmx1", "")).toBe(false);
        });
    });

    describe("dkimRotationBlocker()", () => {
        const rotating: any = { supportsRotation: true, generateKeyPair: async () => undefined, activate: async () => undefined, signingSelector: async () => undefined };
        const domain: any = { name: "example.com", dkimSelector: "mail", dkimPublicKey: "KEY" };

        it("Says why a domain can't rotate, in order.", () => {
            expect(dkimRotationBlocker(undefined, domain, true, "postfix")).toBe("unsupported");
            expect(dkimRotationBlocker({ supportsRotation: false } as any, domain, true, "postfix")).toBe("unsupported");
            expect(dkimRotationBlocker({ supportsRotation: true } as any, domain, true, "postfix")).toBe("unsupported");
            // Without the MTA's acknowledgement a switch could never be confirmed, and the rotation would stay in switching for good.
            expect(dkimRotationBlocker({ ...rotating, signingSelector: undefined }, domain, true, "postfix")).toBe("unsupported");
            expect(dkimRotationBlocker(rotating, domain, true, "ses")).toBe("ses");
            expect(dkimRotationBlocker(rotating, domain, true, " SES ")).toBe("ses");
            expect(dkimRotationBlocker(rotating, { ...domain, dkimPublicKey: undefined }, true, "postfix")).toBe("no_key");
            expect(dkimRotationBlocker(rotating, { ...domain, dkimSelector: "" }, true, "postfix")).toBe("no_key");
            expect(dkimRotationBlocker(rotating, domain, false, "postfix")).toBe("imported");
            expect(dkimRotationBlocker(rotating, domain, undefined, "postfix")).toBe("unknown_key");
        });

        it("Is nothing for a provider-made key with a rotating provider.", () => {
            expect(dkimRotationBlocker(rotating, domain, true, "postfix")).toBeUndefined();
            expect(dkimRotationBlocker(rotating, domain, true, undefined)).toBeUndefined();
        });
    });

    describe("resolveDkimManaged()", () => {
        const domain: any = { name: "example.com", dkimSelector: "mail", dkimPublicKey: "KEY" };

        it("Keeps a value already recorded.", async () => {
            const findKeyPair = vi.fn();
            expect(await resolveDkimManaged({ findKeyPair } as any, { ...domain, dkimManaged: false })).toBe(false);
            expect(await resolveDkimManaged({ findKeyPair } as any, { ...domain, dkimManaged: true })).toBe(true);
            expect(findKeyPair).not.toHaveBeenCalled();
        });

        it("Asks the provider whether it holds the domain's key: managed only when the keys are the same.", async () => {
            expect(await resolveDkimManaged({ findKeyPair: async () => ({ selector: "mail", publicKey: "KEY" }) } as any, domain)).toBe(true);
            expect(await resolveDkimManaged({ findKeyPair: async () => ({ selector: "mail", publicKey: "OTHER" }) } as any, domain)).toBe(false);
            expect(await resolveDkimManaged({ findKeyPair: async () => undefined } as any, domain)).toBe(false);
        });

        it("Can't tell without a key, a provider or its findKeyPair(), or when the provider fails.", async () => {
            const findKeyPair = async () => ({ selector: "mail", publicKey: "KEY" });
            expect(await resolveDkimManaged({ findKeyPair } as any, { ...domain, dkimPublicKey: undefined })).toBeUndefined();
            expect(await resolveDkimManaged(undefined, domain)).toBeUndefined();
            expect(await resolveDkimManaged({} as any, domain)).toBeUndefined();
            expect(await resolveDkimManaged({ findKeyPair: async () => Promise.reject(new Error("EACCES")) } as any, domain)).toBeUndefined();
        });
    });

    describe("keptDkimRotationState()", () => {
        it("Is an idle state keeping only the schedule, the pause and the selectors minted that day.", () => {
            const rotated = new Date("2026-03-01T00:00:00Z");
            expect(
                keptDkimRotationState({
                    phase: "overlap",
                    previous: { selector: "mail", publicKey: "OLD" },
                    reason: "manual",
                    switchedAt: rotated,
                    lastRotatedAt: rotated,
                    lastCancelledAt: rotated,
                    paused: true,
                    mintedSelectors: ["rmx20260301"],
                    lastError: "x",
                }),
            ).toEqual({ phase: "idle", lastRotatedAt: rotated, lastCancelledAt: rotated, paused: true, mintedSelectors: ["rmx20260301"] });
            expect(keptDkimRotationState(undefined)).toEqual({ phase: "idle" });
            expect(keptDkimRotationState(null)).toEqual({ phase: "idle" });
        });
    });
});
