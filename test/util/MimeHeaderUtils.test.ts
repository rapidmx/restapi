///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    checkOriginatorHeaders,
    containsCalendarContent,
    extractHeader,
    extractHeaders,
    extractOriginatorHeaders,
    hasAddressLikeDisplayName,
    prepareRelayCopy,
    prependHeaders,
    singleFromAddress,
    verifiedFromAddress,
} from "../../src/util/MimeHeaderUtils.js";

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

    describe("Address-like display names (round 5)", () => {
        const allowed = new Set(["me@example.com", "alias@example.com"]);
        const isAllowed = (address: string): boolean => allowed.has(address.trim().toLowerCase());
        const check = (headers: string): string | undefined =>
            checkOriginatorHeaders(Buffer.from(`${headers}\r\n\r\nBody\r\n`), isAllowed, { rejectAddressLikeDisplayNames: true });

        it("Refuses an address in a display name, comment or group name - including the `From :` and bare-CR forms.", () => {
            expect(check('From: "ceo@victim.com" <me@example.com>')).toContain("display name");
            expect(check('From : "ceo@victim.com" <me@example.com>')).toContain("display name");
            expect(check('To: x@example.com\rFrom : "ceo@victim.com" <me@example.com>')).toContain("display name");
            expect(check("From: me@example.com (ceo@victim.com)")).toContain("display name");
            expect(check("From: ceo@victim.com: me@example.com;")).toBeDefined();
            expect(check('From: me@example.com\r\nSender: "boss@victim.com" <alias@example.com>')).toContain("Sender header");
        });

        it("Decodes RFC 2047 encoded words (Q and B) and catches look-alike at signs.", () => {
            expect(check("From: =?utf-8?q?ceo=40victim.com?= <me@example.com>")).toContain("display name");
            expect(check(`From: =?utf-8?B?${Buffer.from("ceo@victim.com").toString("base64")}?= <me@example.com>`)).toContain("display name");
            expect(check(`From: =?utf-8?B?${Buffer.from("ceo＠victim.com").toString("base64")}?= <me@example.com>`)).toContain("display name");
            // Raw 8-bit UTF-8 in the header block.
            expect(check("From: \"ceo﹫victim.com\" <me@example.com>")).toContain("display name");
        });

        it("Sees an at sign written as a quoted-pair in a display name or comment, and keeps escaped quotes inside the name.", () => {
            expect(hasAddressLikeDisplayName('"ceo\\@victim.com" <me@example.com>')).toBe(true);
            expect(hasAddressLikeDisplayName("me@example.com (ceo\\@victim.com)")).toBe(true);
            // An escaped quote doesn't end the quoted string early, so the @ after it is still inside the name.
            expect(hasAddressLikeDisplayName('"Jane \\" ceo@victim.com" <me@example.com>')).toBe(true);
            expect(hasAddressLikeDisplayName('"Doe \\"Jane\\"" <me@example.com>')).toBe(false);
            // A trailing backslash (an unterminated quoted-pair) is tolerated.
            expect(hasAddressLikeDisplayName('"Jane\\')).toBe(false);
        });

        it("Passes ordinary display names, and leaves the default check unchanged.", () => {
            expect(check('From: "Doe, Jane" <me@example.com>')).toBeUndefined();
            expect(check("From: =?utf-8?B?w6nDqQ==?= <alias@example.com>")).toBeUndefined();
            expect(checkOriginatorHeaders(Buffer.from('From: "ceo@victim.com" <me@example.com>\r\n\r\n'), isAllowed)).toBeUndefined();
        });

        it("hasAddressLikeDisplayName() and extractOriginatorHeaders() are exported for the protocol plugins.", () => {
            expect(hasAddressLikeDisplayName('"a@b.c" <me@example.com>')).toBe(true);
            expect(hasAddressLikeDisplayName("Jane <me@example.com>")).toBe(false);
            expect(hasAddressLikeDisplayName('"unterminated a@b.c')).toBe(true);
            expect(extractOriginatorHeaders(Buffer.from("From : a@x.com\rsender: b@x.com\r\n\r\nFrom: body@x.com"))).toEqual({
                from: ["a@x.com"],
                sender: ["b@x.com"],
            });
        });
    });

    describe("singleFromAddress()/verifiedFromAddress()", () => {
        const TRUSTED = "mx.example.com";

        it("Returns the one From address, normalized, only when there is exactly one.", () => {
            expect(singleFromAddress(Buffer.from("From: Jane <Jane@Example.COM>\r\n\r\n"))).toBe("jane@example.com");
            expect(singleFromAddress(Buffer.from("From: a@example.com, b@example.com\r\n\r\n"))).toBeUndefined();
            expect(singleFromAddress(Buffer.from("From: a@example.com\r\nFrom: a@example.com\r\n\r\n"))).toBeUndefined();
            expect(singleFromAddress(Buffer.from("From: Just A Name\r\n\r\n"))).toBeUndefined();
            expect(singleFromAddress(Buffer.from("To: a@example.com\r\n\r\n"))).toBeUndefined();
        });

        it("Verifies the From only against the topmost trusted Authentication-Results.", () => {
            const pass = `Authentication-Results: ${TRUSTED}; dkim=pass header.d=example.com`;
            const fail = `Authentication-Results: ${TRUSTED}; dkim=fail header.d=example.com`;
            expect(verifiedFromAddress(Buffer.from(`${pass}\r\nFrom: a@example.com\r\n\r\n`), TRUSTED)).toBe("a@example.com");
            // An older trusted pass below a newer trusted fail doesn't count.
            expect(verifiedFromAddress(Buffer.from(`${fail}\r\n${pass}\r\nFrom: a@example.com\r\n\r\n`), TRUSTED)).toBeUndefined();
            expect(verifiedFromAddress(Buffer.from(`${pass}\r\nFrom: a@other.example\r\n\r\n`), TRUSTED)).toBeUndefined();
            expect(verifiedFromAddress(Buffer.from(`${pass}\r\nFrom: a@example.com\r\n\r\n`), "")).toBeUndefined();
            expect(verifiedFromAddress(Buffer.from(`${pass}\r\nTo: a@example.com\r\n\r\n`), TRUSTED)).toBeUndefined();
        });
    });

    describe("containsCalendarContent()", () => {
        it("Finds calendar content types, .ics names (plain, RFC 2231 and RFC 2047) and VCALENDAR bodies.", () => {
            expect(containsCalendarContent(Buffer.from("Content-Type: text/calendar; method=CANCEL\r\n\r\nx"))).toBe(true);
            expect(containsCalendarContent(Buffer.from("Content-Type: multipart/mixed\r\n\r\n--b\r\ncontent-type:\r\n application/ics\r\n\r\nx"))).toBe(true);
            expect(containsCalendarContent(Buffer.from('Subject: x\r\n\r\n--b\r\nContent-Disposition: attachment; filename="invite.ICS"\r\n\r\n'))).toBe(true);
            expect(containsCalendarContent(Buffer.from("Subject: x\r\n\r\nContent-Disposition: attachment; filename*=utf-8''invite%2Eics\r\n"))).toBe(true);
            expect(
                containsCalendarContent(Buffer.from(`Subject: x\r\n\r\nContent-Type: application/octet-stream; name="=?utf-8?B?${Buffer.from("a.ics").toString("base64")}?="\r\n`)),
            ).toBe(true);
            expect(containsCalendarContent(Buffer.from("Subject: x\r\n\r\nbegin:vcalendar\r\n"))).toBe(true);
            expect(containsCalendarContent(Buffer.from("Subject: meeting notes\r\nContent-Type: text/plain; name=\"notes%zz.txt\"\r\n\r\nHello"))).toBe(false);
        });
    });

    describe("prepareRelayCopy()", () => {
        const TRUSTED = "mx.example.com";
        const rewriteFrom = { address: "list@ours.example", name: 'Sales "Team"' };
        const trustHeaders = [
            // Passing DKIM, but not for the From domain.
            "Authentication-Results: mx.example.com; dkim=pass header.d=elsewhere.example",
            "RapidMX-Key: addr=ceo@ours.example; keydata=AAAA",
            "X-RapidMX-Recall-Of : <victim@ours.example>",
            "disposition-notification-to: ceo@ours.example",
        ];

        it("Rewrites an unauthenticated From to the list (DMARC-style) and strips every trust-bearing header.", () => {
            const raw = Buffer.from(
                [...trustHeaders, 'From: "CEO" <ceo@ours.example>', "Sender: ceo@ours.example", "X-Original-From: forged", "Subject: Pay this", "", "Body"].join("\r\n"),
            );
            const copy = prepareRelayCopy(raw, { trustedAuthservId: TRUSTED, rewriteFrom })!.toString("binary");
            const headers = copy.slice(0, copy.indexOf("\r\n\r\n"));
            expect(headers).toContain('From: "Sales \\"Team\\"" <list@ours.example>');
            expect(headers).toContain('X-Original-From: "CEO" <ceo@ours.example>');
            expect(headers).not.toMatch(/^(authentication-results|rapidmx-key|x-rapidmx-recall-of|disposition-notification-to|sender)\s*:/im);
            expect(headers.match(/^from\s*:/gim)).toHaveLength(1);
            expect(headers).not.toContain("forged");
            expect(headers).not.toMatch(/^reply-to:/im);
            expect(copy.endsWith("\r\n\r\nBody")).toBe(true);
        });

        it("Adds Reply-To: <original From> for a forward when the message has none, and encodes a non-ASCII name.", () => {
            const raw = Buffer.from("From: Mallory <m@evil.example>\r\nSubject: x\r\n\r\nBody");
            const copy = prepareRelayCopy(raw, { trustedAuthservId: TRUSTED, rewriteFrom: { address: "me@ours.example", name: "Zoë" }, replyToOriginalFrom: true })!.toString();
            expect(copy).toContain("Reply-To: Mallory <m@evil.example>");
            expect(copy).toContain(`From: =?UTF-8?B?${Buffer.from("Zoë").toString("base64")}?= <me@ours.example>`);
            const withReplyTo = prepareRelayCopy(Buffer.from("From: m@evil.example\r\nReply-To: r@evil.example\r\n\r\nBody"), {
                trustedAuthservId: TRUSTED,
                rewriteFrom: { address: "me@ours.example" },
                replyToOriginalFrom: true,
            })!.toString();
            expect(withReplyTo.match(/^reply-to:/gim)).toHaveLength(1);
            expect(withReplyTo).toContain("From: <me@ours.example>");
        });

        it("Keeps an authenticated From (and its folding) unchanged, still stripping trust-bearing headers.", () => {
            const raw = Buffer.from(
                ["Authentication-Results: mx.example.com; dkim=pass header.d=partner.example", "RapidMX-Key: x", "From: Bob\r\n <bob@partner.example>", "Subject: Hi", "", "Body"].join("\r\n"),
            );
            const copy = prepareRelayCopy(raw, { trustedAuthservId: TRUSTED, rewriteFrom })!.toString();
            expect(copy).toContain("From: Bob\r\n <bob@partner.example>");
            expect(copy).not.toContain("X-Original-From");
            expect(copy).not.toMatch(/^(authentication-results|rapidmx-key)\s*:/im);
        });

        it("Refuses (undefined) calendar content from an unauthenticated sender, but relays it from an authenticated one.", () => {
            const ics = "Content-Type: text/calendar; method=CANCEL\r\n\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR";
            expect(prepareRelayCopy(Buffer.from(`From: ceo@ours.example\r\n${ics}`), { trustedAuthservId: TRUSTED, rewriteFrom })).toBeUndefined();
            expect(
                prepareRelayCopy(Buffer.from(`Authentication-Results: mx.example.com; dkim=pass header.d=partner.example\r\nFrom: bob@partner.example\r\n${ics}`), {
                    trustedAuthservId: TRUSTED,
                    rewriteFrom,
                }),
            ).toBeDefined();
        });

        it("Treats a bare CR as a line break, so a trust header can't hide behind one.", () => {
            const copy = prepareRelayCopy(Buffer.from("From: m@evil.example\rRapidMX-Key: x\r\n\r\nBody"), { trustedAuthservId: TRUSTED, rewriteFrom })!.toString();
            expect(copy).not.toMatch(/rapidmx-key/i);
        });
    });
});
