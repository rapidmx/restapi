///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    chooseApexSpf,
    isSpfValue,
    isVerificationTokenValue,
    MAX_APEX_TXT_KEEP,
    MAX_APEX_TXT_VALUE_LENGTH,
    normalizeApexTxtKeep,
    suggestApexTxtKeep,
} from "../../src/util/ApexTxtUtils.js";
import { DEFAULT_SPF_VALUE } from "../../src/util/DnsSetupUtils.js";

describe("ApexTxtUtils", () => {
    it("tells SPF records and RapidMX ownership tokens from other values", () => {
        expect(isSpfValue("v=spf1 mx ~all")).toBe(true);
        expect(isSpfValue("V=SPF1 -all")).toBe(true);
        expect(isSpfValue("v=spf1")).toBe(true);
        expect(isSpfValue("v=spf10 mx")).toBe(false);
        expect(isSpfValue("google-site-verification=v=spf1")).toBe(false);
        expect(isVerificationTokenValue("rapidmx-domain-verification=abc")).toBe(true);
        expect(isVerificationTokenValue("google-site-verification=abc")).toBe(false);
    });

    it("suggests keeping every value at the apex except SPF records and RapidMX ownership tokens, without repeats", () => {
        expect(
            suggestApexTxtKeep([
                "google-site-verification=a",
                "v=spf1 include:_spf.google.com ~all",
                "rapidmx-domain-verification=tok",
                "MS=ms123",
                "google-site-verification=a",
            ]),
        ).toEqual(["google-site-verification=a", "MS=ms123"]);
        expect(suggestApexTxtKeep([])).toEqual([]);
    });

    it("keeps an existing SPF record verbatim when it already includes mx, and replaces one without", () => {
        expect(chooseApexSpf(["ms=1", "v=spf1 mx include:_spf.google.com ~all"])).toBe("v=spf1 mx include:_spf.google.com ~all");
        expect(chooseApexSpf(["v=spf1 include:_spf.google.com ~all"])).toBe(DEFAULT_SPF_VALUE);
        expect(chooseApexSpf(["v=spf1 a:mx.example.com -all"])).toBe(DEFAULT_SPF_VALUE);
        expect(chooseApexSpf([])).toBe(DEFAULT_SPF_VALUE);
    });

    it("keeps only an SPF record that authorizes the domain's own MX hosts", () => {
        for (const kept of ["v=spf1 +mx -all", "v=spf1 MX ~all", "v=spf1 mx/24 ~all", "v=spf1 mx//64 -all", "v=spf1 ip4:192.0.2.1 mx/24//64", "v=spf1 mx"]) {
            expect(chooseApexSpf([kept]), kept).toBe(kept);
        }
        // Failing the MX hosts, not vouching for them, or another domain's MX hosts: replaced.
        for (const replaced of ["v=spf1 -mx ~all", "v=spf1 ~mx -all", "v=spf1 ?mx -all", "v=spf1 mx:legacy-relay.example.net -all", "v=spf1 mx:other.example.net/24 -all", "v=spf1 mxx ~all"]) {
            expect(chooseApexSpf([replaced]), replaced).toBe(DEFAULT_SPF_VALUE);
        }
    });

    describe("normalizeApexTxtKeep()", () => {
        it("trims values, drops repeats and RapidMX ownership tokens, and keeps the admin's order", () => {
            expect(normalizeApexTxtKeep(["  ms=1 ", "google-site-verification=a", "ms=1", "rapidmx-domain-verification=tok"])).toEqual(["ms=1", "google-site-verification=a"]);
            expect(normalizeApexTxtKeep([])).toEqual([]);
            expect(normalizeApexTxtKeep(undefined)).toEqual([]);
        });

        it("refuses an SPF record: RapidMX publishes the one SPF record a name may have", () => {
            expect(() => normalizeApexTxtKeep(["v=spf1 -all"])).toThrow(expect.objectContaining({ status: 400 }));
        });

        it("refuses anything but a list of non-empty text without control characters, within the limits", () => {
            for (const bad of ["ms=1", [1], [""], ["   "], ["a\nb"], ["a\u0000"], ["x".repeat(MAX_APEX_TXT_VALUE_LENGTH + 1)], { 0: "a" }]) {
                expect(() => normalizeApexTxtKeep(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ status: 400 }));
            }
            expect(() => normalizeApexTxtKeep(Array.from({ length: MAX_APEX_TXT_KEEP + 1 }, (_, i) => `v${i}`))).toThrow(expect.objectContaining({ status: 400 }));
            expect(normalizeApexTxtKeep(["x".repeat(MAX_APEX_TXT_VALUE_LENGTH)])).toHaveLength(1);
        });
    });
});
