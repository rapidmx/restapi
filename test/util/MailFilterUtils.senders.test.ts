///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailFilterMatchContext, matchesConditions } from "../../src/util/MailFilterUtils.js";
import { MessageImportance } from "../../src/models/types.js";

function makeContext(overrides: Partial<MailFilterMatchContext> = {}): MailFilterMatchContext {
    return {
        from: "Jane Doe <jane@example.com>",
        subject: "Weekly Newsletter",
        bodyPreview: "Here is your update.",
        recipientAddresses: ["me@example.com"],
        hasAttachment: false,
        importance: MessageImportance.NORMAL,
        ...overrides,
    };
}

describe("Exact-match sender conditions Tests", () => {
    const ctx = (overrides: Partial<MailFilterMatchContext> = {}) =>
        makeContext({ from: "Ann <ann@x.com>", fromAddress: "ann@x.com", envelopeFrom: "bounce@list.example", ...overrides });

    it("fromEquals matches the From address exactly and case-insensitively, and never as a substring (ann@x.com is not joann@x.com).", () => {
        expect(matchesConditions({ fromEquals: ["ANN@X.com"] }, ctx())).toBe(true);
        expect(matchesConditions({ fromEquals: ["ann@x.com"] }, ctx({ from: "JoAnn <joann@x.com>", fromAddress: "joann@x.com" }))).toBe(false);
        expect(matchesConditions({ fromEquals: ["joann@x.com"] }, ctx())).toBe(false);
    });

    it("fromEquals matches the envelope sender too, when the From header differs.", () => {
        expect(matchesConditions({ fromEquals: ["bounce@list.example"] }, ctx())).toBe(true);
        expect(matchesConditions({ fromEquals: ["Bounce@List.Example"] }, ctx({ fromAddress: "someone@else.example" }))).toBe(true);
        expect(matchesConditions({ fromEquals: ["nobody@x.com"] }, ctx())).toBe(false);
    });

    it("fromEquals is OR-matched across its entries and never matches an empty list.", () => {
        expect(matchesConditions({ fromEquals: ["nobody@x.com", "ann@x.com"] }, ctx())).toBe(true);
        expect(matchesConditions({ fromEquals: [] }, ctx())).toBe(false);
    });

    it("fromDomainEquals matches the exact domain of either sender - not a subdomain, not a longer domain.", () => {
        expect(matchesConditions({ fromDomainEquals: ["x.com"] }, ctx())).toBe(true);
        expect(matchesConditions({ fromDomainEquals: ["@X.COM"] }, ctx())).toBe(true);
        expect(matchesConditions({ fromDomainEquals: ["list.example"] }, ctx())).toBe(true);
        expect(matchesConditions({ fromDomainEquals: ["x.com"] }, ctx({ fromAddress: "a@mail.x.com", envelopeFrom: "a@mail.x.com" }))).toBe(false);
        expect(matchesConditions({ fromDomainEquals: ["x.com"] }, ctx({ fromAddress: "a@notx.com", envelopeFrom: "a@notx.com" }))).toBe(false);
        expect(matchesConditions({ fromDomainEquals: [] }, ctx())).toBe(false);
    });

    it("Is ANDed with the other conditions.", () => {
        expect(matchesConditions({ fromEquals: ["ann@x.com"], subjectContains: ["newsletter"] }, ctx())).toBe(true);
        expect(matchesConditions({ fromEquals: ["ann@x.com"], subjectContains: ["invoice"] }, ctx())).toBe(false);
    });

    it("Ignores an empty envelope sender (a bounce) and falls back to the address inside `from` when neither address is given.", () => {
        expect(matchesConditions({ fromEquals: ["mailer-daemon@x.com"] }, ctx({ fromAddress: "mailer-daemon@x.com", envelopeFrom: "" }))).toBe(true);
        expect(matchesConditions({ fromEquals: ["jane@example.com"] }, makeContext())).toBe(true);
        expect(matchesConditions({ fromEquals: ["plain@example.com"] }, makeContext({ from: "Plain@Example.com" }))).toBe(true);
        expect(matchesConditions({ fromDomainEquals: ["example.com"] }, makeContext())).toBe(true);
        expect(matchesConditions({ fromEquals: ["x@y.com"] }, makeContext({ from: "no address at all" }))).toBe(false);
    });

    it("Leaves fromContains a substring match: ann@x.com does match joann@x.com there.", () => {
        expect(matchesConditions({ fromContains: ["ann@x.com"] }, ctx({ from: "JoAnn <joann@x.com>" }))).toBe(true);
    });
});
