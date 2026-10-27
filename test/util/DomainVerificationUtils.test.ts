///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    acceptsLegacyApex,
    buildVerificationRecordName,
    buildVerificationTxtValue,
    checkDomainVerification,
    DOMAIN_VERIFICATION_RECORD_LABEL,
    DOMAIN_VERIFICATION_TXT_PREFIX,
    findDomainVerification,
} from "../../src/util/DomainVerificationUtils.js";
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

/** A resolver answering TXT lookups from `records` (hostname -> records), throwing (NXDOMAIN) for any other name. */
function txtResolver(records: Record<string, string[][]>) {
    return {
        resolveTxt: vi.fn(async (hostname: string) => {
            if (!(hostname in records)) {
                throw new Error(`NXDOMAIN ${hostname}`);
            }
            return records[hostname];
        }),
    };
}

describe("DomainVerificationUtils Tests", () => {
    describe("buildVerificationTxtValue()", () => {
        it("Prefixes the token with the expected constant.", () => {
            expect(buildVerificationTxtValue("abc123")).toBe(`${DOMAIN_VERIFICATION_TXT_PREFIX}abc123`);
        });
    });

    describe("buildVerificationRecordName()", () => {
        it("Puts the record at _rapidmx-verify under the domain, never at the apex.", () => {
            expect(DOMAIN_VERIFICATION_RECORD_LABEL).toBe("_rapidmx-verify");
            expect(buildVerificationRecordName("example.com")).toBe("_rapidmx-verify.example.com");
            expect(buildVerificationRecordName("mail.example.co.uk")).toBe("_rapidmx-verify.mail.example.co.uk");
        });
    });

    describe("findDomainVerification()", () => {
        it("Verifies at _rapidmx-verify.<domain> and says so.", async () => {
            const resolver = txtResolver({ "_rapidmx-verify.example.com": [["rapidmx-domain-verification=abc123"]] });

            const result = await findDomainVerification(resolver, makeDomain());

            expect(result).toEqual({ verified: true, location: "record", atRecord: true, atLegacyApex: false });
            expect(resolver.resolveTxt).toHaveBeenCalledWith("_rapidmx-verify.example.com");
            expect(resolver.resolveTxt).toHaveBeenCalledWith("example.com");
        });

        it("Verifies at the legacy apex while the legacy location is accepted (the default), and says where it was found.", async () => {
            const resolver = txtResolver({ "example.com": [["v=spf1 mx ~all"], ["rapidmx-domain-verification=abc123"]] });

            expect(await findDomainVerification(resolver, makeDomain())).toEqual({ verified: true, location: "legacy_apex", atRecord: false, atLegacyApex: true });
            expect(await findDomainVerification(resolver, makeDomain(), true)).toEqual(expect.objectContaining({ verified: true, location: "legacy_apex" }));
        });

        it("Refuses the legacy apex once the legacy location is no longer accepted, while still reporting the token is there.", async () => {
            const resolver = txtResolver({ "example.com": [["rapidmx-domain-verification=abc123"]] });

            const result = await findDomainVerification(resolver, makeDomain(), false);

            expect(result).toEqual({ verified: false, atRecord: false, atLegacyApex: true });
            expect(await checkDomainVerification(resolver, makeDomain(), false)).toBe(false);
        });

        it("Prefers the record when the token is at both locations.", async () => {
            const resolver = txtResolver({
                "_rapidmx-verify.example.com": [["rapidmx-domain-verification=abc123"]],
                "example.com": [["rapidmx-domain-verification=abc123"]],
            });

            expect(await findDomainVerification(resolver, makeDomain(), false)).toEqual({ verified: true, location: "record", atRecord: true, atLegacyApex: true });
        });

        it("Rejoins a TXT record split across multiple chunks at both locations.", async () => {
            const chunked = [["rapidmx-domain-verif", "ication=abc123"]];

            expect((await findDomainVerification(txtResolver({ "_rapidmx-verify.example.com": chunked }), makeDomain())).location).toBe("record");
            expect((await findDomainVerification(txtResolver({ "example.com": chunked }), makeDomain())).location).toBe("legacy_apex");
        });

        it("Verifies at one location when the other is NXDOMAIN, either way round.", async () => {
            expect((await findDomainVerification(txtResolver({ "_rapidmx-verify.example.com": [["rapidmx-domain-verification=abc123"]] }), makeDomain())).verified).toBe(true);
            expect((await findDomainVerification(txtResolver({ "example.com": [["rapidmx-domain-verification=abc123"]] }), makeDomain())).verified).toBe(true);
        });

        it("Does not verify on another token, a token with more after it, or nothing at all.", async () => {
            const resolver = txtResolver({
                "_rapidmx-verify.example.com": [["rapidmx-domain-verification=other"]],
                "example.com": [["rapidmx-domain-verification=abc1234"]],
            });

            expect(await findDomainVerification(resolver, makeDomain())).toEqual({ verified: false, atRecord: false, atLegacyApex: false });
            expect(await findDomainVerification(txtResolver({}), makeDomain())).toEqual({ verified: false, atRecord: false, atLegacyApex: false });
        });
    });

    describe("checkDomainVerification()", () => {
        it("Returns true when a TXT record matches the expected value exactly.", async () => {
            const resolver = { resolveTxt: vi.fn().mockResolvedValue([["rapidmx-domain-verification=abc123"]]) };

            const result = await checkDomainVerification(resolver, makeDomain());

            expect(result).toBe(true);
            expect(resolver.resolveTxt).toHaveBeenCalledWith("_rapidmx-verify.example.com");
        });

        it("Rejoins a TXT record split across multiple chunks before comparing.", async () => {
            const resolver = {
                resolveTxt: vi.fn().mockResolvedValue([["rapidmx-domain-verif", "ication=abc123"]]),
            };

            const result = await checkDomainVerification(resolver, makeDomain());

            expect(result).toBe(true);
        });

        it("Returns false when no TXT record matches.", async () => {
            const resolver = { resolveTxt: vi.fn().mockResolvedValue([["some-other-value"]]) };

            const result = await checkDomainVerification(resolver, makeDomain());

            expect(result).toBe(false);
        });

        it("Returns false when there are no TXT records at all.", async () => {
            const resolver = { resolveTxt: vi.fn().mockResolvedValue([]) };

            const result = await checkDomainVerification(resolver, makeDomain());

            expect(result).toBe(false);
        });

        it("Returns false (rather than throwing) when the resolver itself throws.", async () => {
            const resolver = { resolveTxt: vi.fn().mockRejectedValue(new Error("NXDOMAIN")) };

            const result = await checkDomainVerification(resolver, makeDomain());

            expect(result).toBe(false);
        });
    });

    describe("acceptsLegacyApex()", () => {
        it("reads the configured flag, text from the environment included", () => {
            for (const off of [false, 0, "false", "FALSE", " 0 ", "no", "off"]) {
                expect(acceptsLegacyApex(off), String(off)).toBe(false);
            }
            for (const on of [undefined, null, true, 1, "true", "1", "yes", ""]) {
                expect(acceptsLegacyApex(on), String(on)).toBe(true);
            }
        });

        it("refuses a token only at the apex when the flag is the text \"false\"", async () => {
            const token = buildVerificationTxtValue("abc123");
            const resolver = { resolveTxt: vi.fn(async (name: string) => (name === "example.com" ? [[token]] : Promise.reject(new Error("NXDOMAIN")))) };
            expect((await findDomainVerification(resolver, makeDomain({ verificationToken: "abc123" }), "false" as any)).verified).toBe(false);
        });
    });
});
