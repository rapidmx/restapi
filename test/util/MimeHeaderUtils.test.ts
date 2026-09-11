///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { extractHeader, extractHeaders, prependHeaders } from "../../src/util/MimeHeaderUtils.js";

describe("MimeHeaderUtils Tests", () => {
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

        it("Skips a stray leading blank line in the header block rather than treating it as a header.", () => {
            const raw = Buffer.from("\r\nFrom: a@example.com\r\nSubject: Hello\r\n\r\nBody\r\n");
            expect(extractHeader(raw, "Subject")).toBe("Hello");
            expect(extractHeader(raw, "From")).toBe("a@example.com");
        });
    });

    describe("extractHeaders()", () => {
        it("Returns every occurrence of a header that repeats.", () => {
            const raw = Buffer.from(
                "Authentication-Results: mx1.example.com; dkim=pass\r\nAuthentication-Results: mx2.example.com; dkim=fail\r\n\r\nBody\r\n",
            );
            expect(extractHeaders(raw, "Authentication-Results")).toEqual([
                "mx1.example.com; dkim=pass",
                "mx2.example.com; dkim=fail",
            ]);
        });

        it("Returns a single-element array for a header that appears once.", () => {
            const raw = Buffer.from("From: a@example.com\r\nSubject: Hello\r\n\r\nBody\r\n");
            expect(extractHeaders(raw, "Subject")).toEqual(["Hello"]);
        });

        it("Returns an empty array when the header isn't present at all.", () => {
            const raw = Buffer.from("From: a@example.com\r\n\r\nBody\r\n");
            expect(extractHeaders(raw, "Subject")).toEqual([]);
        });

        it("Unfolds a continuation line the same way extractHeader() does.", () => {
            const raw = Buffer.from("Subject: Hello\r\n World\r\n\r\nBody\r\n");
            expect(extractHeaders(raw, "Subject")).toEqual(["Hello World"]);
        });

        it("Is case-insensitive on the header name.", () => {
            const raw = Buffer.from("X-Custom: value\r\n\r\nBody\r\n");
            expect(extractHeaders(raw, "x-custom")).toEqual(["value"]);
        });
    });

    describe("prependHeaders()", () => {
        it("Prepends each given header ahead of the existing ones, preserving the body.", () => {
            const raw = Buffer.from("From: sender@example.com\r\nSubject: Hi\r\n\r\nBody text\r\n");

            const result = prependHeaders(raw, [{ name: "X-Tag", value: "policy-match" }]).toString();

            expect(result).toContain("X-Tag: policy-match");
            expect(result).toContain("From: sender@example.com");
            expect(result).toContain("Subject: Hi");
            expect(result).toContain("Body text");
        });

        it("Prepends multiple headers, in the given order.", () => {
            const raw = Buffer.from("From: sender@example.com\r\n\r\nBody\r\n");

            const result = prependHeaders(raw, [
                { name: "X-First", value: "1" },
                { name: "X-Second", value: "2" },
            ]).toString();

            expect(result.indexOf("X-First: 1")).toBeLessThan(result.indexOf("X-Second: 2"));
            expect(result.indexOf("X-Second: 2")).toBeLessThan(result.indexOf("From: sender@example.com"));
        });

        it("Sanitizes CR/LF injected into a header name/value so it can't break out into its own header line.", () => {
            const raw = Buffer.from("From: sender@example.com\r\n\r\nBody\r\n");

            const result = prependHeaders(raw, [{ name: "X-Tag", value: "evil\r\nX-Injected: true" }]).toString();

            expect(result).not.toContain("\r\nX-Injected: true\r\n");
            expect(result).toContain("X-Tag: evilX-Injected: true");
        });

        it("Handles a message with no blank-line separator at all (no body).", () => {
            const raw = Buffer.from("From: sender@example.com\r\nSubject: NoBody");

            const result = prependHeaders(raw, [{ name: "X-Tag", value: "v" }]).toString();

            expect(result).toContain("X-Tag: v");
            expect(result).toContain("Subject: NoBody");
        });

        it("Returns the raw message unchanged (aside from a no-op prepend) when given an empty headers array.", () => {
            const raw = Buffer.from("From: sender@example.com\r\n\r\nBody\r\n");

            const result = prependHeaders(raw, []).toString();

            expect(result).toContain("From: sender@example.com");
            expect(result).toContain("Body");
        });
    });
});
