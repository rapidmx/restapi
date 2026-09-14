///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { hasAlignedPassingDkim, parseAuthenticationResults } from "../../src/util/AuthenticationResultsUtils.js";

describe("parseAuthenticationResults() Tests", () => {
    it("Parses a single dkim=pass result with header.d/header.s properties.", () => {
        const result = parseAuthenticationResults("mx.example.com; dkim=pass header.d=example.com header.s=selector1");
        expect(result).toEqual([
            { authservId: "mx.example.com", method: "dkim", result: "pass", properties: { "header.d": "example.com", "header.s": "selector1" } },
        ]);
    });

    it("Parses multiple method results from the same header value.", () => {
        const result = parseAuthenticationResults(
            "mx.example.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=alice@example.com",
        );
        expect(result).toHaveLength(2);
        expect(result[0].method).toBe("dkim");
        expect(result[1].method).toBe("spf");
        expect(result.every((e) => e.authservId === "mx.example.com")).toBe(true);
    });

    it("Returns an empty array for a value of exactly 'none'.", () => {
        expect(parseAuthenticationResults("mx.example.com; none")).toEqual([]);
    });

    it("Returns an empty array for undefined input.", () => {
        expect(parseAuthenticationResults(undefined)).toEqual([]);
    });

    it("Returns an empty array for a header value with no segments at all (just whitespace/semicolons).", () => {
        expect(parseAuthenticationResults("  ; ; ")).toEqual([]);
    });

    it("Merges entries across multiple header instances (array input), each keeping its own authserv-id.", () => {
        const result = parseAuthenticationResults([
            "mx1.example.com; dkim=pass header.d=example.com",
            "mx2.example.com; dkim=fail header.d=example.com",
        ]);
        expect(result).toHaveLength(2);
        expect(result.map((e) => e.result)).toEqual(["pass", "fail"]);
        expect(result.map((e) => e.authservId)).toEqual(["mx1.example.com", "mx2.example.com"]);
    });

    it("Skips a malformed method-result token with no '='.", () => {
        const result = parseAuthenticationResults("mx.example.com; garbage-no-equals");
        expect(result).toEqual([]);
    });

    it("Skips a malformed property token with no '=', keeping the rest of the entry's properties.", () => {
        const result = parseAuthenticationResults("mx.example.com; dkim=pass justaword header.d=example.com");
        expect(result).toEqual([{ authservId: "mx.example.com", method: "dkim", result: "pass", properties: { "header.d": "example.com" } }]);
    });

    it("Strips surrounding quotes from a property value.", () => {
        const result = parseAuthenticationResults('mx.example.com; dkim=pass header.d="example.com"');
        expect(result[0].properties["header.d"]).toBe("example.com");
    });

    it("Lowercases the authserv-id, method, result, and property keys but preserves property value case.", () => {
        const result = parseAuthenticationResults("MX.Example.COM; DKIM=PASS Header.D=Example.COM");
        expect(result[0].authservId).toBe("mx.example.com");
        expect(result[0].method).toBe("dkim");
        expect(result[0].result).toBe("pass");
        expect(result[0].properties["header.d"]).toBe("Example.COM");
    });

    describe("RFC 8601 comments and quoted strings", () => {
        it("Ignores a comment that contains a forged 'dkim=pass' result.", () => {
            const result = parseAuthenticationResults("mx.example.com; dkim=fail (dkim=pass header.d=example.com) header.d=example.com");
            expect(result).toEqual([{ authservId: "mx.example.com", method: "dkim", result: "fail", properties: { "header.d": "example.com" } }]);
        });

        it("Ignores a comment containing ';', so it can't start a forged result segment.", () => {
            const result = parseAuthenticationResults("mx.example.com; dkim=fail header.d=example.com (bad sig; dkim=pass header.d=example.com)");
            expect(result).toHaveLength(1);
            expect(result[0].result).toBe("fail");
        });

        it("Handles nested comments and escaped parentheses inside a comment.", () => {
            const header = "mx.example.com; dkim=fail (outer (inner \\) still inner; dkim=pass header.d=example.com) still outer \\( ; dkim=pass) header.d=example.com";
            const result = parseAuthenticationResults(header);
            expect(result).toEqual([{ authservId: "mx.example.com", method: "dkim", result: "fail", properties: { "header.d": "example.com" } }]);
        });

        it("Treats an unterminated comment as running to the end of the value.", () => {
            const result = parseAuthenticationResults("mx.example.com; dkim=fail (dkim=pass header.d=example.com; dkim=pass header.d=example.com");
            expect(result).toEqual([{ authservId: "mx.example.com", method: "dkim", result: "fail", properties: {} }]);
        });

        it("Strips a comment from the authserv-id segment (including a ';' inside it).", () => {
            const result = parseAuthenticationResults("mx.example.com (trusted; dkim=pass header.d=example.com); dkim=fail header.d=example.com");
            expect(result).toEqual([{ authservId: "mx.example.com", method: "dkim", result: "fail", properties: { "header.d": "example.com" } }]);
        });

        it("A comment before the authserv-id is not mistaken for it.", () => {
            const result = parseAuthenticationResults("(mx.example.com) evil.example; dkim=pass header.d=example.com");
            expect(result[0].authservId).toBe("evil.example");
            expect(hasAlignedPassingDkim("(mx.example.com) evil.example; dkim=pass header.d=example.com", "example.com", "mx.example.com")).toBe(false);
        });

        it("Keeps a quoted value containing ';' and whitespace intact rather than splitting on it.", () => {
            const header = 'mx.example.com; dkim=fail reason="bad; dkim=pass header.d=example.com" header.d=evil.com header.s=sel';
            const result = parseAuthenticationResults(header);
            expect(result).toEqual([
                {
                    authservId: "mx.example.com",
                    method: "dkim",
                    result: "fail",
                    properties: { reason: "bad; dkim=pass header.d=example.com", "header.d": "evil.com", "header.s": "sel" },
                },
            ]);
            expect(hasAlignedPassingDkim(header, "example.com", "mx.example.com")).toBe(false);
        });

        it("Doesn't treat parentheses inside a quoted string as a comment.", () => {
            const result = parseAuthenticationResults('mx.example.com; dkim=pass reason="looks (like a" header.d=example.com');
            expect(result[0].properties).toEqual({ reason: "looks (like a", "header.d": "example.com" });
        });

        it("Resolves backslash escapes inside a quoted string, including an escaped quote.", () => {
            const result = parseAuthenticationResults('mx.example.com; dkim=pass reason="say \\"hi\\"; ok" header.d=example.com');
            expect(result[0].properties).toEqual({ reason: 'say "hi"; ok', "header.d": "example.com" });
        });

        it("Accepts whitespace/comments around '=', an authserv-id version, and a method version.", () => {
            const header = "mx.example.com 1; dkim/1 = pass header.d (signing domain) = example.com";
            const result = parseAuthenticationResults(header);
            expect(result).toEqual([{ authservId: "mx.example.com", method: "dkim", result: "pass", properties: { "header.d": "example.com" } }]);
            expect(hasAlignedPassingDkim(header, "example.com", "mx.example.com")).toBe(true);
        });

        it("Allows a comment directly after '=' (key=(comment)value).", () => {
            const result = parseAuthenticationResults("mx.example.com; dkim=pass header.s=(selector)sel1 header.d=example.com");
            expect(result[0].properties).toEqual({ "header.s": "sel1", "header.d": "example.com" });
        });

        it("Never throws on malformed '=' placement or unterminated quoted strings.", () => {
            const stray = parseAuthenticationResults("mx.example.com; =pass; dkim=pass header.d=example.com =oops");
            expect(stray.find((entry) => entry.method === "dkim")!.properties["header.d"]).toBe("example.com");

            expect(parseAuthenticationResults('mx.example.com; dkim=pass header.d="example.com')[0].properties["header.d"]).toBe("example.com");
            expect(parseAuthenticationResults('mx.example.com; dkim=pass header.d="')[0].properties["header.d"]).toBe("");
        });

        it("Skips a non-string entry in an array of header values.", () => {
            const result = parseAuthenticationResults([undefined as unknown as string, "mx.example.com; dkim=pass header.d=example.com"]);
            expect(result).toHaveLength(1);
        });

        it("Accepts a quoted authserv-id.", () => {
            expect(parseAuthenticationResults('"mx.example.com"; dkim=pass header.d=example.com')[0].authservId).toBe("mx.example.com");
        });
    });
});

describe("hasAlignedPassingDkim() Tests", () => {
    const TRUSTED = "mx.example.com";

    it("Returns true for a dkim=pass result whose header.d exactly matches the From domain, from the trusted authserv-id.", () => {
        const header = "mx.example.com; dkim=pass header.d=example.com";
        expect(hasAlignedPassingDkim(header, "example.com", TRUSTED)).toBe(true);
    });

    it("Returns false when header.d is only the From domain's organizational (parent) domain - alignment is strict, not relaxed.", () => {
        // Relaxed (DMARC-style) alignment would require a public-suffix list this codebase doesn't depend on;
        // a naive subdomain check is unsafe on shared-suffix hosting domains, so only exact alignment is
        // trusted - see `domainsAlign()`'s own doc comment.
        const header = "mx.example.com; dkim=pass header.d=example.com";
        expect(hasAlignedPassingDkim(header, "mail.example.com", TRUSTED)).toBe(false);
    });

    it("Returns false when header.d does not align with the From domain at all.", () => {
        const header = "mx.example.com; dkim=pass header.d=attacker.com";
        expect(hasAlignedPassingDkim(header, "example.com", TRUSTED)).toBe(false);
    });

    it("Returns false for dkim=fail even with an aligned domain.", () => {
        const header = "mx.example.com; dkim=fail header.d=example.com";
        expect(hasAlignedPassingDkim(header, "example.com", TRUSTED)).toBe(false);
    });

    it("Returns false when no Authentication-Results header is present at all.", () => {
        expect(hasAlignedPassingDkim(undefined, "example.com", TRUSTED)).toBe(false);
    });

    it("Returns false for a dkim=pass result missing header.d entirely.", () => {
        const header = "mx.example.com; dkim=pass header.s=selector1";
        expect(hasAlignedPassingDkim(header, "example.com", TRUSTED)).toBe(false);
    });

    it("Is case-insensitive on both the compared domains.", () => {
        const header = "mx.example.com; dkim=pass header.d=EXAMPLE.com";
        expect(hasAlignedPassingDkim(header, "Example.COM", TRUSTED)).toBe(true);
    });

    it("Returns false (fails closed) when trustedAuthservId is unconfigured, even for an otherwise-valid header.", () => {
        const header = "mx.example.com; dkim=pass header.d=example.com";
        expect(hasAlignedPassingDkim(header, "example.com", "")).toBe(false);
    });

    it("Returns false for a header whose authserv-id does not match the configured trusted value - the header could have been forged by the sender, since nothing here strips a pre-existing instance before the trusted MTA adds its own.", () => {
        const header = "attacker-forged.example.com; dkim=pass header.d=example.com";
        expect(hasAlignedPassingDkim(header, "example.com", TRUSTED)).toBe(false);
    });

    it("Trusts only the entry from the matching authserv-id when multiple header instances are present.", () => {
        const header = ["forged.evil.com; dkim=pass header.d=example.com", "mx.example.com; dkim=fail header.d=example.com"];
        // The genuine (trusted-authserv-id) entry reports dkim=fail, and the forged one - despite claiming
        // dkim=pass - must never be trusted just because it also claims to align.
        expect(hasAlignedPassingDkim(header, "example.com", TRUSTED)).toBe(false);
    });
});
