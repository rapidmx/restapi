///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { buildVerificationTxtValue, checkDomainVerification, DOMAIN_VERIFICATION_TXT_PREFIX } from "../../src/util/DomainVerificationUtils.js";
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

describe("DomainVerificationUtils Tests", () => {
    describe("buildVerificationTxtValue()", () => {
        it("Prefixes the token with the expected constant.", () => {
            expect(buildVerificationTxtValue("abc123")).toBe(`${DOMAIN_VERIFICATION_TXT_PREFIX}abc123`);
        });
    });

    describe("checkDomainVerification()", () => {
        it("Returns true when a TXT record matches the expected value exactly.", async () => {
            const resolver = { resolveTxt: vi.fn().mockResolvedValue([["rapidmx-domain-verification=abc123"]]) };

            const result = await checkDomainVerification(resolver, makeDomain());

            expect(result).toBe(true);
            expect(resolver.resolveTxt).toHaveBeenCalledWith("example.com");
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
});
