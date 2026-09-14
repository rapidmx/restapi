///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { checkOriginatorHeaders, extractHeader, extractHeaders, prependHeaders } from "../../src/util/MimeHeaderUtils.js";

describe("MimeHeaderUtils Tests", () => {
    describe("checkOriginatorHeaders()", () => {
        const allowed = new Set(["me@example.com", "alias@example.com"]);
        const isAllowed = (address: string): boolean => allowed.has(address.trim().toLowerCase());
        const check = (headers: string): string | undefined => checkOriginatorHeaders(Buffer.from(`${headers}\r\n\r\nBody from: evil@x.com\r\n`), isAllowed);

        it("Passes a plain From header naming an allowed address, any case.", () => {
            expect(check("From: Me@EXAMPLE.com\r\nTo: you@example.com")).toBeUndefined();
        });

        it("Passes quoted display names (even ones containing commas and addresses), comments, encoded words and groups.", () => {
            expect(check('From: "Doe, J <evil@x.com>" <me@example.com>')).toBeUndefined();
            expect(check("From: me@example.com (really evil@x.com)")).toBeUndefined();
            expect(check('From: "Doe \\"evil@x.com\\" J" <me@example.com> (nested (evil@x.com) \\) comment)')).toBeUndefined();
            expect(check("From: =?utf-8?B?w6nDqQ==?= <alias@example.com>")).toBeUndefined();
            expect(check("From: team: me@example.com, =?utf-8?Q?A?= <alias@example.com>;")).toBeUndefined();
            expect(check("From: me@example.com\r\nSender: alias@example.com")).toBeUndefined();
        });

        it("Refuses a foreign address, alone or alongside an allowed one, or inside a group.", () => {
            expect(check("From: evil@x.com")).toContain("From header");
            expect(check("From: me@example.com, evil@x.com")).toContain("From header");
            expect(check("From: team: me@example.com, evil@x.com;")).toContain("From header");
        });

        it("Refuses a foreign address a tolerant parser would demote to a display name.", () => {
            expect(check("From: <me@example.com> <evil@x.com>")).toContain("From header");
            expect(check("From: me@example.com evil@x.com")).toContain("From header");
            expect(check("From: evil@x.com <me@example.com>")).toContain("From header");
        });

        it("Checks folded headers, case-insensitive names, whitespace before the colon, and bare-CR line breaks.", () => {
            expect(check("From: me@example.com,\r\n\tevil@x.com")).toContain("From header");
            expect(check("fRoM: evil@x.com")).toContain("From header");
            expect(check("From : evil@x.com")).toContain("From header");
            expect(check("From: me@example.com\rSender: evil@x.com")).toContain("Sender header");
        });

        it("Refuses duplicate From or Sender headers, a missing From, and a From with no address.", () => {
            expect(check("From: me@example.com\r\nFrom: me@example.com")).toContain("more than one From");
            expect(check("From: me@example.com\r\nSender: me@example.com\r\nsender: me@example.com")).toContain("more than one Sender");
            expect(check("To: you@example.com")).toContain("no From header");
            expect(check("From: undisclosed:;")).toContain("no address");
            expect(check("From: Just A Name")).toContain("From header");
        });

        it("Refuses a Sender naming a foreign address.", () => {
            expect(check("From: me@example.com\r\nSender: evil@x.com")).toContain("Sender header");
        });
    });

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
