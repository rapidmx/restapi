///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { extractHeader, rewriteHeadersForList } from "../../src/util/DistributionListUtils.js";
import { DistributionList } from "../../src/models/types.js";

function makeList(overrides?: Partial<DistributionList>): DistributionList {
    return {
        uid: "sales@example.com",
        dateCreated: new Date(),
        dateModified: new Date(),
        version: 0,
        deleted: false,
        primarySmtpAddress: "sales@example.com",
        aliasAddresses: [],
        name: "Sales",
        memberAddresses: [],
        ...overrides,
    };
}

describe("DistributionListUtils Tests", () => {
    describe("extractHeader()", () => {
        it("Finds a simple top-level header, case-insensitively.", () => {
            const raw = Buffer.from("From: a@example.com\r\nSubject: Hello\r\n\r\nBody\r\n");
            expect(extractHeader(raw, "subject")).toBe("Hello");
        });

        it("Returns undefined when the header isn't present.", () => {
            const raw = Buffer.from("From: a@example.com\r\n\r\nBody\r\n");
            expect(extractHeader(raw, "Subject")).toBeUndefined();
        });

        it("Unfolds a continuation line onto a single value joined by a space.", () => {
            const raw = Buffer.from("From: a@example.com\r\nSubject: Hello\r\n World\r\n\r\nBody\r\n");
            expect(extractHeader(raw, "Subject")).toBe("Hello World");
        });

        it("Treats a message with no blank-line separator as having no body, still finding headers.", () => {
            const raw = Buffer.from("From: a@example.com\r\nSubject: NoBody");
            expect(extractHeader(raw, "Subject")).toBe("NoBody");
        });
    });

    describe("rewriteHeadersForList()", () => {
        it("Drops an existing Reply-To and adds Reply-To/List-Id/List-Unsubscribe, preserving the body.", () => {
            const raw = Buffer.from(
                "From: sender@example.com\r\nReply-To: original@example.com\r\nSubject: Hi\r\n\r\nBody text\r\n",
            );
            const list = makeList();

            const result = rewriteHeadersForList(raw, list).toString();

            expect(result).not.toContain("original@example.com");
            expect(result).toContain("Reply-To: sales@example.com");
            expect(result).toContain("List-Id: Sales <sales.example.com>");
            expect(result).toContain("List-Unsubscribe: <mailto:sales@example.com?subject=unsubscribe>");
            expect(result).toContain("Subject: Hi");
            expect(result).toContain("Body text");
        });

        it("Sanitizes CR/LF injected into the list's name/address so it can't break out into its own header line.", () => {
            const raw = Buffer.from("From: sender@example.com\r\n\r\nBody\r\n");
            const list = makeList({ name: "Evil\r\nX-Injected: true", primarySmtpAddress: "sales@example.com" });

            const result = rewriteHeadersForList(raw, list).toString();

            // The injected CR/LF is stripped, so "X-Injected: true" merges harmlessly onto the same
            // List-Id line rather than becoming its own header - never a separate "\r\nX-Injected: true\r\n" line.
            expect(result).not.toContain("\r\nX-Injected: true\r\n");
            expect(result).toContain("List-Id: EvilX-Injected: true <sales.example.com>");
        });

        it("Falls back to the raw address as the List-Id host when it has no '@' (defensive branch).", () => {
            const raw = Buffer.from("From: sender@example.com\r\n\r\nBody\r\n");
            const list = makeList({ primarySmtpAddress: "not-an-address" });

            const result = rewriteHeadersForList(raw, list).toString();

            expect(result).toContain("List-Id: Sales <not-an-address>");
        });

        it("Handles a message with no blank-line separator at all (no body).", () => {
            const raw = Buffer.from("From: sender@example.com\r\nSubject: NoBody");
            const list = makeList();

            const result = rewriteHeadersForList(raw, list).toString();

            expect(result).toContain("Reply-To: sales@example.com");
            expect(result).toContain("Subject: NoBody");
        });
    });
});
