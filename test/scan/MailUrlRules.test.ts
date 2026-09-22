///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { cidToken, hasControl, sanitizeImageUrl, sanitizeLinkUrl, stripControls, stripTextControls } from "../../src/scan/MailUrlRules.js";

describe("MailUrlRules", () => {
    it("recognises and strips control characters", () => {
        expect(hasControl("plain")).toBe(false);
        expect(hasControl("a\u0001b")).toBe(true);
        expect(hasControl("a\u009fb")).toBe(true);
        expect(stripControls("a\u0000b\tc\u007fd\u0085e")).toBe("abcde");
        expect(stripTextControls("a\u0000b\tc\nd\re\u007ff\u0085g\u000bh\u000ci")).toBe("ab\tc\nd\refghi");
    });

    describe("cidToken()", () => {
        it("takes the Content-ID out of every spelling of a cid: reference", () => {
            expect(cidToken("image001@x")).toBe("image001@x");
            expect(cidToken("<image001@x>")).toBe("image001@x");
            expect(cidToken("%3Cimage001%40x%3E")).toBe("image001@x");
            expect(cidToken("  ii_1a2b3c ")).toBe("ii_1a2b3c");
            expect(cidToken("part1.06090408.01060107@example.com")).toBe("part1.06090408.01060107@example.com");
        });

        it("refuses what a Content-ID does not contain", () => {
            for (const bad of ["", "a b", "a\"b", "a'b", "a<b", "a&b", "a\\b", "%zz", "x".repeat(300), "é", "a(b)", "a;b", "a?b"]) {
                expect(cidToken(bad)).toBeUndefined();
            }
        });
    });

    describe("sanitizeImageUrl()", () => {
        it("keeps cid:, http(s) and small raster data: URLs in canonical form", () => {
            expect(sanitizeImageUrl("cid:logo@x", 1000)).toBe("cid:logo@x");
            expect(sanitizeImageUrl(" CID:<logo@x> ", 1000)).toBe("cid:logo@x");
            expect(sanitizeImageUrl("https://cdn.example.com/a b.png?x=1&y='2'", 1000)).toBe("https://cdn.example.com/a%20b.png?x=1&y=%272%27");
            expect(sanitizeImageUrl("HTTP://h.example/x", 1000)).toBe("HTTP://h.example/x");
            expect(sanitizeImageUrl("data:image/png;base64,QUJD", 1000)).toBe("data:image/png;base64,QUJD");
            expect(sanitizeImageUrl("data:IMAGE/JPG;base64,QUJD\nREVG", 1000)).toBe("data:image/jpeg;base64,QUJDREVG");
            expect(sanitizeImageUrl("data:image/webp;base64,QQ==", 1000)).toBe("data:image/webp;base64,QQ==");
        });

        it("ignores the tabs, newlines and control characters a browser ignores, before deciding what a URL is", () => {
            expect(sanitizeImageUrl("ht\ttp\ns://h.example/x", 1000)).toBe("https://h.example/x");
            expect(sanitizeImageUrl("\u0001https://h.example/x", 1000)).toBeUndefined();
            expect(sanitizeImageUrl("java\tscript:alert(1)", 1000)).toBeUndefined();
        });

        it("refuses every other scheme, relative URLs, SVG and oversized or malformed data", () => {
            for (const bad of [
                "javascript:alert(1)",
                "vbscript:x",
                "file:///etc/passwd",
                "ftp://h.example/x",
                "//h.example/x",
                "/x.png",
                "x.png",
                "https://",
                "https:///x",
                "https://h.example/\\x",
                "cid:",
                "cid:a b",
                "data:image/svg+xml;base64,PHN2Zy8+",
                "data:image/png;base64,",
                "data:image/png;base64,!!!",
                "data:image/png,rawbytes",
                "data:text/html;base64,QUJD",
                "data:image/png;base64,QUJD" + "A".repeat(2000),
            ]) {
                expect(sanitizeImageUrl(bad, 1000)).toBeUndefined();
            }
            expect(sanitizeImageUrl("https://h.example/" + "a".repeat(9000), 1000)).toBeUndefined();
        });

        it("measures a data: image by the bytes it decodes to, not the characters it is written in", () => {
            const bytes = 3000;
            const data = `data:image/png;base64,${Buffer.alloc(bytes, 1).toString("base64")}`;
            expect(sanitizeImageUrl(data, bytes)).toBe(data);
            expect(sanitizeImageUrl(data, bytes - 1)).toBeUndefined();
        });
    });

    describe("sanitizeLinkUrl()", () => {
        it("keeps http, https, mailto and tel", () => {
            expect(sanitizeLinkUrl("https://a.example/x?y=1&z=2#f")).toBe("https://a.example/x?y=1&z=2#f");
            expect(sanitizeLinkUrl(" \thttp://a.example/ \n")).toBe("http://a.example/");
            expect(sanitizeLinkUrl("mailto:a@b.example?subject=hi there")).toBe("mailto:a@b.example?subject=hi%20there");
            expect(sanitizeLinkUrl("MAILTO:a@b.example")).toBe("MAILTO:a@b.example");
            expect(sanitizeLinkUrl("tel:+1-555-0100")).toBe("tel:+1-555-0100");
        });

        it("encodes what could end an attribute or a CSS string early", () => {
            expect(sanitizeLinkUrl(`https://a.example/"'<>\`{}|^`)).toBe("https://a.example/%22%27%3C%3E%60%7B%7D%7C%5E");
        });

        it("refuses everything else", () => {
            for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "cid:x", "//a.example/", "/x", "#x", "x", "https://", "https://a.example\\x", "\u0001https://a.example/", "https://a.example/\u0001", "https://a.example/" + "a".repeat(9000)]) {
                expect(sanitizeLinkUrl(bad)).toBeUndefined();
            }
        });
    });
});
