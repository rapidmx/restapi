///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { checkDnsSetup } from "../../src/util/DnsSetupUtils.js";
import { buildVerificationTxtValue } from "../../src/util/DomainVerificationUtils.js";
import type { Domain } from "../../src/models/types.js";

function makeDomain(overrides?: Partial<Domain>): Domain {
    return {
        uid: "example.com",
        name: "example.com",
        enabled: true,
        verified: false,
        verificationToken: "abc123",
        ...overrides,
    } as Domain;
}

function makeResolver(overrides?: { resolveTxt?: any; resolveMx?: any }) {
    return {
        resolveTxt: overrides?.resolveTxt ?? vi.fn().mockRejectedValue(new Error("no records")),
        resolveMx: overrides?.resolveMx ?? vi.fn().mockRejectedValue(new Error("no records")),
    };
}

function findCheck(checks: Awaited<ReturnType<typeof checkDnsSetup>>, type: string) {
    return checks.find((c) => c.type === type)!;
}

describe("checkDnsSetup() Tests", () => {
    it("Returns all 5 record types.", async () => {
        const resolver = makeResolver();

        const checks = await checkDnsSetup(resolver, makeDomain(), "");

        expect(checks.map((c) => c.type).sort()).toEqual(["dkim", "dmarc", "mx", "ownership", "spf"].sort());
    });

    describe("ownership", () => {
        it("Matches when the TXT record has the expected verification value.", async () => {
            const domain = makeDomain();
            const resolver = makeResolver({
                resolveTxt: vi.fn().mockResolvedValue([[buildVerificationTxtValue(domain.verificationToken)]]),
            });

            const checks = await checkDnsSetup(resolver, domain, "");

            const ownership = findCheck(checks, "ownership");
            expect(ownership.configured).toBe(true);
            expect(ownership.found).toBe(true);
            expect(ownership.matches).toBe(true);
            expect(ownership.recommendedValue).toBe(buildVerificationTxtValue(domain.verificationToken));
        });

        it("Does not match when no TXT record is found.", async () => {
            const resolver = makeResolver();

            const checks = await checkDnsSetup(resolver, makeDomain(), "");

            const ownership = findCheck(checks, "ownership");
            expect(ownership.found).toBe(false);
            expect(ownership.matches).toBe(false);
        });
    });

    describe("mx", () => {
        it("Is not configured when no mx hostname is given.", async () => {
            const resolver = makeResolver();

            const checks = await checkDnsSetup(resolver, makeDomain(), "");

            const mx = findCheck(checks, "mx");
            expect(mx.configured).toBe(false);
            expect(mx.found).toBe(false);
            expect(mx.matches).toBe(false);
            expect(mx.recommendedValue).toBeUndefined();
            expect(resolver.resolveMx).not.toHaveBeenCalled();
        });

        it("Matches when a live MX record's exchange equals the configured hostname.", async () => {
            const resolver = makeResolver({
                resolveMx: vi.fn().mockResolvedValue([{ priority: 10, exchange: "mail.example.com." }]),
            });

            const checks = await checkDnsSetup(resolver, makeDomain(), "mail.example.com");

            const mx = findCheck(checks, "mx");
            expect(mx.configured).toBe(true);
            expect(mx.recommendedValue).toBe("10 mail.example.com");
            expect(mx.found).toBe(true);
            expect(mx.matches).toBe(true);
            expect(mx.actualValue).toBe("10 mail.example.com.");
        });

        it("Does not match when the live MX record points elsewhere.", async () => {
            const resolver = makeResolver({
                resolveMx: vi.fn().mockResolvedValue([{ priority: 10, exchange: "other-mail.example.com" }]),
            });

            const checks = await checkDnsSetup(resolver, makeDomain(), "mail.example.com");

            const mx = findCheck(checks, "mx");
            expect(mx.found).toBe(true);
            expect(mx.matches).toBe(false);
        });

        it("Treats a resolver failure as not found/not matching, without throwing.", async () => {
            const resolver = makeResolver({ resolveMx: vi.fn().mockRejectedValue(new Error("NXDOMAIN")) });

            const checks = await checkDnsSetup(resolver, makeDomain(), "mail.example.com");

            const mx = findCheck(checks, "mx");
            expect(mx.found).toBe(false);
            expect(mx.matches).toBe(false);
        });
    });

    describe("spf", () => {
        it("Matches a live TXT record starting with v=spf1 and containing the mx mechanism.", async () => {
            const resolver = makeResolver({ resolveTxt: vi.fn().mockResolvedValue([["v=spf1 mx ~all"]]) });

            const checks = await checkDnsSetup(resolver, makeDomain(), "");

            const spf = findCheck(checks, "spf");
            expect(spf.configured).toBe(true);
            expect(spf.recommendedValue).toBe("v=spf1 mx ~all");
            expect(spf.found).toBe(true);
            expect(spf.matches).toBe(true);
        });

        it("Found but not matching when v=spf1 is present without an mx mechanism.", async () => {
            const resolver = makeResolver({
                resolveTxt: vi.fn().mockResolvedValue([["v=spf1 include:_spf.example.net ~all"]]),
            });

            const checks = await checkDnsSetup(resolver, makeDomain(), "");

            const spf = findCheck(checks, "spf");
            expect(spf.found).toBe(true);
            expect(spf.matches).toBe(false);
        });

        it("Not found when there's no v=spf1 record at all.", async () => {
            const resolver = makeResolver({ resolveTxt: vi.fn().mockResolvedValue([["unrelated-txt-record"]]) });

            const checks = await checkDnsSetup(resolver, makeDomain(), "");

            const spf = findCheck(checks, "spf");
            expect(spf.found).toBe(false);
            expect(spf.matches).toBe(false);
        });
    });

    describe("dkim", () => {
        it("Is not configured when the domain has no dkimSelector/dkimPublicKey.", async () => {
            const resolver = makeResolver();

            const checks = await checkDnsSetup(resolver, makeDomain(), "");

            const dkim = findCheck(checks, "dkim");
            expect(dkim.configured).toBe(false);
            expect(dkim.found).toBe(false);
            expect(dkim.matches).toBe(false);
            expect(resolver.resolveTxt).not.toHaveBeenCalledWith(expect.stringContaining("_domainkey"));
        });

        it("Matches when the live TXT record contains the exact public key.", async () => {
            const domain = makeDomain({ dkimSelector: "default", dkimPublicKey: "MIGfMA0GCSq" });
            const resolver = makeResolver({
                resolveTxt: vi.fn().mockImplementation(async (hostname: string) => {
                    if (hostname === "default._domainkey.example.com") {
                        return [["v=DKIM1; k=rsa; p=MIGfMA0GCSq"]];
                    }
                    throw new Error("no records");
                }),
            });

            const checks = await checkDnsSetup(resolver, domain, "");

            const dkim = findCheck(checks, "dkim");
            expect(dkim.configured).toBe(true);
            expect(dkim.recordName).toBe("default._domainkey.example.com");
            expect(dkim.recommendedValue).toBe("v=DKIM1; k=rsa; p=MIGfMA0GCSq");
            expect(dkim.found).toBe(true);
            expect(dkim.matches).toBe(true);
        });

        it("Found but not matching when the live record has a different public key.", async () => {
            const domain = makeDomain({ dkimSelector: "default", dkimPublicKey: "MIGfMA0GCSq" });
            const resolver = makeResolver({
                resolveTxt: vi.fn().mockResolvedValue([["v=DKIM1; k=rsa; p=SomeOtherKey"]]),
            });

            const checks = await checkDnsSetup(resolver, domain, "");

            const dkim = findCheck(checks, "dkim");
            expect(dkim.found).toBe(true);
            expect(dkim.matches).toBe(false);
        });
    });

    describe("dmarc", () => {
        it("Defaults to policy 'none' when the domain hasn't customized it.", async () => {
            const resolver = makeResolver();

            const checks = await checkDnsSetup(resolver, makeDomain(), "");

            const dmarc = findCheck(checks, "dmarc");
            expect(dmarc.configured).toBe(true);
            expect(dmarc.recordName).toBe("_dmarc.example.com");
            expect(dmarc.recommendedValue).toBe("v=DMARC1; p=none;");
        });

        it("Includes the rua tag when a report email is set.", async () => {
            const domain = makeDomain({ dmarcPolicy: "quarantine", dmarcReportEmail: "dmarc@example.com" });
            const resolver = makeResolver();

            const checks = await checkDnsSetup(resolver, domain, "");

            const dmarc = findCheck(checks, "dmarc");
            expect(dmarc.recommendedValue).toBe("v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com;");
        });

        it("Matches when a live v=DMARC1 record is found, regardless of exact policy.", async () => {
            const resolver = makeResolver({
                resolveTxt: vi.fn().mockResolvedValue([["v=DMARC1; p=reject;"]]),
            });

            const checks = await checkDnsSetup(resolver, makeDomain(), "");

            const dmarc = findCheck(checks, "dmarc");
            expect(dmarc.found).toBe(true);
            expect(dmarc.matches).toBe(true);
        });

        it("Not found when there's no DMARC record.", async () => {
            const resolver = makeResolver();

            const checks = await checkDnsSetup(resolver, makeDomain(), "");

            const dmarc = findCheck(checks, "dmarc");
            expect(dmarc.found).toBe(false);
            expect(dmarc.matches).toBe(false);
        });
    });

    it("A failing lookup for one record type doesn't blank out the others.", async () => {
        const domain = makeDomain({ dkimSelector: "default", dkimPublicKey: "key123" });
        const resolver = makeResolver({
            resolveTxt: vi.fn().mockImplementation(async (hostname: string) => {
                if (hostname === "example.com") {
                    return [[buildVerificationTxtValue(domain.verificationToken)]];
                }
                throw new Error("no records");
            }),
            resolveMx: vi.fn().mockRejectedValue(new Error("no records")),
        });

        const checks = await checkDnsSetup(resolver, domain, "mail.example.com");

        expect(findCheck(checks, "ownership").matches).toBe(true);
        expect(findCheck(checks, "mx").found).toBe(false);
        expect(findCheck(checks, "spf").found).toBe(false);
        expect(findCheck(checks, "dkim").found).toBe(false);
        expect(findCheck(checks, "dmarc").found).toBe(false);
    });
});
