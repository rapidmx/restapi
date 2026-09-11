///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { hasAlignedPassingDkim, parseAuthenticationResults } from "../../src/util/AuthenticationResultsUtils.js";

describe("parseAuthenticationResults() Tests", () => {
    it("Parses a single dkim=pass result with header.d/header.s properties.", () => {
        const result = parseAuthenticationResults("mx.example.com; dkim=pass header.d=example.com header.s=selector1");
        expect(result).toEqual([{ method: "dkim", result: "pass", properties: { "header.d": "example.com", "header.s": "selector1" } }]);
    });

    it("Parses multiple method results from the same header value.", () => {
        const result = parseAuthenticationResults(
            "mx.example.com; dkim=pass header.d=example.com; spf=pass smtp.mailfrom=alice@example.com",
        );
        expect(result).toHaveLength(2);
        expect(result[0].method).toBe("dkim");
        expect(result[1].method).toBe("spf");
    });

    it("Returns an empty array for a value of exactly 'none'.", () => {
        expect(parseAuthenticationResults("mx.example.com; none")).toEqual([]);
    });

    it("Returns an empty array for undefined input.", () => {
        expect(parseAuthenticationResults(undefined)).toEqual([]);
    });

    it("Merges entries across multiple header instances (array input).", () => {
        const result = parseAuthenticationResults([
            "mx1.example.com; dkim=pass header.d=example.com",
            "mx2.example.com; dkim=fail header.d=example.com",
        ]);
        expect(result).toHaveLength(2);
        expect(result.map((e) => e.result)).toEqual(["pass", "fail"]);
    });

    it("Skips a malformed method-result token with no '='.", () => {
        const result = parseAuthenticationResults("mx.example.com; garbage-no-equals");
        expect(result).toEqual([]);
    });

    it("Skips a malformed property token with no '=', keeping the rest of the entry's properties.", () => {
        const result = parseAuthenticationResults("mx.example.com; dkim=pass justaword header.d=example.com");
        expect(result).toEqual([{ method: "dkim", result: "pass", properties: { "header.d": "example.com" } }]);
    });

    it("Strips surrounding quotes from a property value.", () => {
        const result = parseAuthenticationResults('mx.example.com; dkim=pass header.d="example.com"');
        expect(result[0].properties["header.d"]).toBe("example.com");
    });

    it("Lowercases method, result, and property keys but preserves property value case.", () => {
        const result = parseAuthenticationResults("mx.example.com; DKIM=PASS Header.D=Example.COM");
        expect(result[0].method).toBe("dkim");
        expect(result[0].result).toBe("pass");
        expect(result[0].properties["header.d"]).toBe("Example.COM");
    });
});

describe("hasAlignedPassingDkim() Tests", () => {
    it("Returns true for a dkim=pass result whose header.d exactly matches the From domain.", () => {
        const header = "mx.example.com; dkim=pass header.d=example.com";
        expect(hasAlignedPassingDkim(header, "example.com")).toBe(true);
    });

    it("Returns true when header.d is the From domain's organizational (parent) domain.", () => {
        const header = "mx.example.com; dkim=pass header.d=example.com";
        expect(hasAlignedPassingDkim(header, "mail.example.com")).toBe(true);
    });

    it("Returns false when header.d does not align with the From domain at all.", () => {
        const header = "mx.example.com; dkim=pass header.d=attacker.com";
        expect(hasAlignedPassingDkim(header, "example.com")).toBe(false);
    });

    it("Returns false for dkim=fail even with an aligned domain.", () => {
        const header = "mx.example.com; dkim=fail header.d=example.com";
        expect(hasAlignedPassingDkim(header, "example.com")).toBe(false);
    });

    it("Returns false when no Authentication-Results header is present at all.", () => {
        expect(hasAlignedPassingDkim(undefined, "example.com")).toBe(false);
    });

    it("Returns false for a dkim=pass result missing header.d entirely.", () => {
        const header = "mx.example.com; dkim=pass header.s=selector1";
        expect(hasAlignedPassingDkim(header, "example.com")).toBe(false);
    });

    it("Is case-insensitive on both the compared domains.", () => {
        const header = "mx.example.com; dkim=pass header.d=EXAMPLE.com";
        expect(hasAlignedPassingDkim(header, "Example.COM")).toBe(true);
    });
});
