///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { isAutoReplyEligible } from "../../src/util/AutoReplyUtils.js";

describe("isAutoReplyEligible() Tests", () => {
    it("Is eligible when the envelope-from is a real address and no relevant headers are present.", () => {
        expect(isAutoReplyEligible("sender@example.com", {})).toBe(true);
    });

    it("Refuses when envelope-from is empty (bounce message).", () => {
        expect(isAutoReplyEligible("", {})).toBe(false);
        expect(isAutoReplyEligible("   ", {})).toBe(false);
    });

    it("Refuses when Auto-Submitted is present and not 'no'.", () => {
        expect(isAutoReplyEligible("sender@example.com", { autoSubmittedHeader: "auto-replied" })).toBe(false);
        expect(isAutoReplyEligible("sender@example.com", { autoSubmittedHeader: "auto-generated" })).toBe(false);
    });

    it("Is eligible when Auto-Submitted is explicitly 'no' (case-insensitive).", () => {
        expect(isAutoReplyEligible("sender@example.com", { autoSubmittedHeader: "no" })).toBe(true);
        expect(isAutoReplyEligible("sender@example.com", { autoSubmittedHeader: "No" })).toBe(true);
    });

    it("Refuses when Precedence is bulk, list, or junk.", () => {
        expect(isAutoReplyEligible("sender@example.com", { precedenceHeader: "bulk" })).toBe(false);
        expect(isAutoReplyEligible("sender@example.com", { precedenceHeader: "list" })).toBe(false);
        expect(isAutoReplyEligible("sender@example.com", { precedenceHeader: "junk" })).toBe(false);
    });

    it("Is eligible when Precedence is some other value (e.g. 'first-class').", () => {
        expect(isAutoReplyEligible("sender@example.com", { precedenceHeader: "first-class" })).toBe(true);
    });
});
