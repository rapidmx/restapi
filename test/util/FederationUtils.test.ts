///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for resolveFederationPolicy() - the resolver is a hand-built mock, no real DNS. The
// module-level policyCache is shared across every test in this file (same rationale documented in
// FederationUtils.ts itself), so each test uses its own unique domain name to avoid cross-test interference
// rather than resetting shared state - mirrors test/util/DomainUtils.test.ts's own isolation approach.
import { resolveFederationPolicy } from "../../src/util/FederationUtils.js";

function makeResolver(txtRecords: string[][]) {
    return { resolveTxt: vi.fn().mockResolvedValue(txtRecords), resolveMx: vi.fn() };
}

describe("resolveFederationPolicy() Tests", () => {
    it("Resolves a well-formed RMXv1 policy record.", async () => {
        const resolver = makeResolver([["v=RMXv1; id=1; host=mail.example1.com;"]]);

        const result = await resolveFederationPolicy(resolver, "example1.com");

        expect(result).toEqual({ host: "mail.example1.com", id: "1" });
        expect(resolver.resolveTxt).toHaveBeenCalledWith("_rapidmx.example1.com");
    });

    it("Is order-independent on attributes and tolerates a missing trailing semicolon.", async () => {
        const resolver = makeResolver([["host=mail.example2.com; v=RMXv1; id=42"]]);

        const result = await resolveFederationPolicy(resolver, "example2.com");

        expect(result).toEqual({ host: "mail.example2.com", id: "42" });
    });

    it("Rejoins a TXT record split across multiple RFC 1035 chunks before parsing.", async () => {
        const resolver = makeResolver([["v=RMXv1; id=1; ho", "st=mail.example3.com;"]]);

        const result = await resolveFederationPolicy(resolver, "example3.com");

        expect(result).toEqual({ host: "mail.example3.com", id: "1" });
    });

    it("Finds the RapidMX policy record among multiple unrelated TXT records at the same name.", async () => {
        const resolver = makeResolver([["some-other-txt-value"], ["v=RMXv1; id=1; host=mail.example4.com;"]]);

        const result = await resolveFederationPolicy(resolver, "example4.com");

        expect(result).toEqual({ host: "mail.example4.com", id: "1" });
    });

    it("Returns undefined for an unrecognized policy version.", async () => {
        const resolver = makeResolver([["v=RMXv2; id=1; host=mail.example5.com;"]]);

        const result = await resolveFederationPolicy(resolver, "example5.com");

        expect(result).toBeUndefined();
    });

    it("Returns undefined when the host attribute is missing.", async () => {
        const resolver = makeResolver([["v=RMXv1; id=1;"]]);

        const result = await resolveFederationPolicy(resolver, "example6.com");

        expect(result).toBeUndefined();
    });

    it("Returns undefined when the id attribute is missing.", async () => {
        const resolver = makeResolver([["v=RMXv1; host=mail.example7.com;"]]);

        const result = await resolveFederationPolicy(resolver, "example7.com");

        expect(result).toBeUndefined();
    });

    it("Returns undefined when there are no TXT records at all.", async () => {
        const resolver = makeResolver([]);

        const result = await resolveFederationPolicy(resolver, "example8.com");

        expect(result).toBeUndefined();
    });

    it("Returns undefined (never throws) when the resolver itself throws.", async () => {
        const resolver = { resolveTxt: vi.fn().mockRejectedValue(new Error("NXDOMAIN")), resolveMx: vi.fn() };

        const result = await resolveFederationPolicy(resolver, "example9.com");

        expect(result).toBeUndefined();
    });

    it("Caches a positive result - a second call for the same domain does not re-query DNS.", async () => {
        const resolver = makeResolver([["v=RMXv1; id=1; host=mail.example10.com;"]]);

        const first = await resolveFederationPolicy(resolver, "example10.com");
        const second = await resolveFederationPolicy(resolver, "example10.com");

        expect(first).toEqual(second);
        expect(resolver.resolveTxt).toHaveBeenCalledTimes(1);
    });

    it("Caches a negative result - a second call for a non-participating domain does not re-query DNS.", async () => {
        const resolver = makeResolver([]);

        const first = await resolveFederationPolicy(resolver, "example11.com");
        const second = await resolveFederationPolicy(resolver, "example11.com");

        expect(first).toBeUndefined();
        expect(second).toBeUndefined();
        expect(resolver.resolveTxt).toHaveBeenCalledTimes(1);
    });

    it("Negative-caches NXDOMAIN (ENOTFOUND) and ENODATA for the full negative TTL.", async () => {
        for (const [code, domain] of [["ENOTFOUND", "example13.com"], ["ENODATA", "example14.com"]]) {
            const resolver = { resolveTxt: vi.fn().mockRejectedValue(Object.assign(new Error(code), { code })), resolveMx: vi.fn() };

            await resolveFederationPolicy(resolver, domain);
            await resolveFederationPolicy(resolver, domain);

            expect(resolver.resolveTxt).toHaveBeenCalledTimes(1);
        }
    });

    it("Caches a transient DNS failure (SERVFAIL/timeout) only for the short transient TTL.", async () => {
        vi.useFakeTimers();
        try {
            const resolver = {
                resolveTxt: vi
                    .fn()
                    .mockRejectedValueOnce(Object.assign(new Error("queryTxt ESERVFAIL"), { code: "ESERVFAIL" }))
                    .mockResolvedValue([["v=RMXv1; id=1; host=mail.example15.com;"]]),
                resolveMx: vi.fn(),
            };

            await expect(resolveFederationPolicy(resolver, "example15.com")).resolves.toBeUndefined();
            await expect(resolveFederationPolicy(resolver, "example15.com")).resolves.toBeUndefined();
            expect(resolver.resolveTxt).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(61_000);
            await expect(resolveFederationPolicy(resolver, "example15.com")).resolves.toEqual({ host: "mail.example15.com", id: "1" });
            expect(resolver.resolveTxt).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it("Does not cache a transient failure at all when transientFailureTtlSeconds is 0 (including errors without a code).", async () => {
        const resolver = {
            resolveTxt: vi
                .fn()
                .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEOUT" }))
                .mockRejectedValueOnce("raw failure")
                .mockResolvedValue([["v=RMXv1; id=1; host=mail.example16.com;"]]),
            resolveMx: vi.fn(),
        };

        await expect(resolveFederationPolicy(resolver, "example16.com", { transientFailureTtlSeconds: 0 })).resolves.toBeUndefined();
        await expect(resolveFederationPolicy(resolver, "example16.com", { transientFailureTtlSeconds: 0 })).resolves.toBeUndefined();
        await expect(resolveFederationPolicy(resolver, "example16.com", { transientFailureTtlSeconds: 0 })).resolves.toEqual({
            host: "mail.example16.com",
            id: "1",
        });
        expect(resolver.resolveTxt).toHaveBeenCalledTimes(3);
    });

    it("Is case-insensitive on the domain for both the DNS query and the cache key.", async () => {
        const resolver = makeResolver([["v=RMXv1; id=1; host=mail.example12.com;"]]);

        await resolveFederationPolicy(resolver, "EXAMPLE12.com");
        const second = await resolveFederationPolicy(resolver, "example12.COM");

        expect(resolver.resolveTxt).toHaveBeenCalledWith("_rapidmx.example12.com");
        expect(resolver.resolveTxt).toHaveBeenCalledTimes(1);
        expect(second).toEqual({ host: "mail.example12.com", id: "1" });
    });
});
