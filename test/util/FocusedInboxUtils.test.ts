///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { classifyMessage, FocusedInboxSignals } from "../../src/util/FocusedInboxUtils.js";
import { MessageClassification } from "../../src/models/types.js";

const OTHER_SPAM_SCORE = 3;

/** Signals for ordinary personal mail from a stranger - the baseline every test varies one field of. */
function makeSignals(overrides?: Partial<FocusedInboxSignals>): FocusedInboxSignals {
    return {
        isInternalSender: false,
        isKnownCorrespondent: false,
        spamScore: 0,
        ...overrides,
    };
}

describe("classifyMessage() Tests", () => {
    it("Defaults to focused - mail is never hidden on a guess.", () => {
        expect(classifyMessage(makeSignals(), OTHER_SPAM_SCORE)).toBe(MessageClassification.FOCUSED);
    });

    describe("override", () => {
        it("An override to other wins over every focused signal.", () => {
            const signals = makeSignals({
                override: MessageClassification.OTHER,
                isInternalSender: true,
                isKnownCorrespondent: true,
            });

            expect(classifyMessage(signals, OTHER_SPAM_SCORE)).toBe(MessageClassification.OTHER);
        });

        it("An override to focused wins over every other signal.", () => {
            const signals = makeSignals({
                override: MessageClassification.FOCUSED,
                listUnsubscribeHeader: "<https://example.com/unsubscribe>",
                precedenceHeader: "bulk",
                autoSubmittedHeader: "auto-generated",
                spamScore: 99,
            });

            expect(classifyMessage(signals, OTHER_SPAM_SCORE)).toBe(MessageClassification.FOCUSED);
        });
    });

    describe("bulk/automated indicators", () => {
        it("A List-Unsubscribe header classifies as other.", () => {
            const signals = makeSignals({ listUnsubscribeHeader: "<https://example.com/unsubscribe>" });

            expect(classifyMessage(signals, OTHER_SPAM_SCORE)).toBe(MessageClassification.OTHER);
        });

        it.each(["bulk", "list", "junk", "BULK", " Bulk "])(
            "A Precedence of '%s' classifies as other.",
            (precedenceHeader) => {
                expect(classifyMessage(makeSignals({ precedenceHeader }), OTHER_SPAM_SCORE)).toBe(
                    MessageClassification.OTHER,
                );
            },
        );

        it("A Precedence this library doesn't treat as bulk is ignored.", () => {
            expect(classifyMessage(makeSignals({ precedenceHeader: "first-class" }), OTHER_SPAM_SCORE)).toBe(
                MessageClassification.FOCUSED,
            );
        });

        it("An Auto-Submitted other than 'no' classifies as other.", () => {
            expect(classifyMessage(makeSignals({ autoSubmittedHeader: "auto-generated" }), OTHER_SPAM_SCORE)).toBe(
                MessageClassification.OTHER,
            );
        });

        it("An explicit 'Auto-Submitted: no' is a human sender, not an automated one (RFC 3834).", () => {
            expect(classifyMessage(makeSignals({ autoSubmittedHeader: " NO " }), OTHER_SPAM_SCORE)).toBe(
                MessageClassification.FOCUSED,
            );
        });

        it("Bulk beats the positive signals - an internal newsletter is still newsletter traffic.", () => {
            const signals = makeSignals({
                isInternalSender: true,
                isKnownCorrespondent: true,
                precedenceHeader: "bulk",
            });

            expect(classifyMessage(signals, OTHER_SPAM_SCORE)).toBe(MessageClassification.OTHER);
        });
    });

    describe("positive signals", () => {
        it("An internal sender classifies as focused.", () => {
            expect(classifyMessage(makeSignals({ isInternalSender: true }), OTHER_SPAM_SCORE)).toBe(
                MessageClassification.FOCUSED,
            );
        });

        it("A known correspondent classifies as focused.", () => {
            expect(classifyMessage(makeSignals({ isKnownCorrespondent: true }), OTHER_SPAM_SCORE)).toBe(
                MessageClassification.FOCUSED,
            );
        });

        it("A known correspondent stays focused even with a spam score over the threshold.", () => {
            const signals = makeSignals({ isKnownCorrespondent: true, spamScore: OTHER_SPAM_SCORE + 5 });

            expect(classifyMessage(signals, OTHER_SPAM_SCORE)).toBe(MessageClassification.FOCUSED);
        });
    });

    describe("spam score", () => {
        it("A score at the threshold classifies as other.", () => {
            expect(classifyMessage(makeSignals({ spamScore: OTHER_SPAM_SCORE }), OTHER_SPAM_SCORE)).toBe(
                MessageClassification.OTHER,
            );
        });

        it("A score just under the threshold stays focused.", () => {
            expect(classifyMessage(makeSignals({ spamScore: OTHER_SPAM_SCORE - 0.1 }), OTHER_SPAM_SCORE)).toBe(
                MessageClassification.FOCUSED,
            );
        });
    });
});
