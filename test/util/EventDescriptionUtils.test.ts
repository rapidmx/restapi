///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    MAX_EVENT_DESCRIPTION_HTML_LENGTH,
    MAX_EVENT_DESCRIPTION_LENGTH,
    cleanPlainDescription,
    htmlToPlainText,
    normalizeEventDescription,
    sanitizeEventDescriptionHtml,
    sanitizeInboundDescription,
} from "../../src/util/EventDescriptionUtils.js";

const NOFOLLOW = 'rel="noopener noreferrer"';

describe("sanitizeEventDescriptionHtml()", () => {
    it("Keeps the allow-listed formatting elements and writes them back without attributes.", () => {
        const html = '<p class="x" style="color:red" onclick="steal()">Hello <b id="b">bold</b>, <strong>strong</strong>, <i>it</i>, <em>em</em>, <u>u</u><br/>next</p><ul><li>one</li><li>two</li></ul><ol start="3"><li>a</li></ol>';
        expect(sanitizeEventDescriptionHtml(html)).toBe(
            "<p>Hello <b>bold</b>, <strong>strong</strong>, <i>it</i>, <em>em</em>, <u>u</u><br>next</p><ul><li>one</li><li>two</li></ul><ol><li>a</li></ol>",
        );
    });

    it("Keeps a link's http, https and mailto href with rel=noopener noreferrer, and nothing else on it.", () => {
        expect(sanitizeEventDescriptionHtml('<a href="https://example.com/a?b=1&c=2" target="_blank" onclick="x()" rel="opener">site</a>')).toBe(
            `<a href="https://example.com/a?b=1&amp;c=2" ${NOFOLLOW}>site</a>`,
        );
        expect(sanitizeEventDescriptionHtml('<a href="http://example.com">h</a>')).toBe(`<a href="http://example.com" ${NOFOLLOW}>h</a>`);
        expect(sanitizeEventDescriptionHtml('<a href="mailto:a@example.com">mail</a>')).toBe(`<a href="mailto:a@example.com" ${NOFOLLOW}>mail</a>`);
    });

    it("Turns a link that goes anywhere else into its text: javascript:, data:, vbscript:, file:, tel:, relative and fragment URLs, obfuscated schemes.", () => {
        for (const href of [
            "javascript:alert(1)",
            "  JaVaScRiPt:alert(1)",
            "java\tscript:alert(1)",
            "java&#x09;script:alert(1)",
            "&#106;avascript:alert(1)",
            "data:text/html;base64,PHNjcmlwdD4=",
            "vbscript:msgbox(1)",
            "file:///etc/passwd",
            "tel:+15555550100",
            "/relative/path",
            "//evil.example/x",
            "#fragment",
            "",
        ]) {
            expect(sanitizeEventDescriptionHtml(`<a href="${href}">click</a>`)).toBe("click");
        }
        expect(sanitizeEventDescriptionHtml("<a>no href</a>")).toBe("no href");
    });

    it("Removes script, style, iframe, svg, object and other embedding elements with everything inside them.", () => {
        expect(
            sanitizeEventDescriptionHtml(
                'a<script>alert(1)</script>b<style>p{color:red}</style>c<iframe src="https://evil.example"><p>inner</p></iframe>d<svg onload="x()"><circle/></svg>e<object data="x"><b>o</b></object>f<textarea><b>t</b></textarea>g<noscript><p>n</p></noscript>h<template><p>t</p></template>i',
            ),
        ).toBe("abcdefghi");
        expect(sanitizeEventDescriptionHtml("<link rel=stylesheet href=x><meta http-equiv=refresh content=0><base href=x>ok")).toBe("ok");
    });

    it("Removes images, tables, forms and every other element outside the allow-list but keeps their text.", () => {
        expect(sanitizeEventDescriptionHtml('<img src="https://x.example/i.png" onerror="x()" alt="pic">text')).toBe("text");
        expect(sanitizeEventDescriptionHtml("<div><span>in <font color=red>a</font></span><table><tr><td>cell</td></tr></table></div>")).toBe("in acell");
        expect(sanitizeEventDescriptionHtml('<form action="https://evil.example"><input value="x"><button>go</button></form>')).toBe("go");
        expect(sanitizeEventDescriptionHtml('<h1 style="x">Title</h1><blockquote>q</blockquote>')).toBe("Titleq");
    });

    it("Escapes text, so an entity-encoded tag stays text and never becomes markup.", () => {
        expect(sanitizeEventDescriptionHtml("1 < 2 & 3 > 2 \"quoted\"")).toBe("1 &lt; 2 &amp; 3 &gt; 2 &quot;quoted&quot;");
        expect(sanitizeEventDescriptionHtml("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(sanitizeEventDescriptionHtml("&lt;img src=x onerror=alert(1)&gt;")).toBe("&lt;img src=x onerror=alert(1)&gt;");
    });

    it("Handles nested and broken markup: every kept tag is closed, stray closers vanish, unfinished tags end the input safely.", () => {
        expect(sanitizeEventDescriptionHtml("<b><i>unclosed")).toBe("<b><i>unclosed</i></b>");
        expect(sanitizeEventDescriptionHtml("</b></i>text</p></div>")).toContain("text");
        expect(sanitizeEventDescriptionHtml('<b>x<a href="https://example.com')).toBe("<b>x</b>");
        expect(sanitizeEventDescriptionHtml('<b <script>alert(1)</script> >x')).not.toContain("script");
        expect(sanitizeEventDescriptionHtml("<<script>script>alert(1)<</script>/script>")).not.toMatch(/<script/i);
        expect(sanitizeEventDescriptionHtml("<scr<script>ipt>alert(1)</scr</script>ipt>")).not.toMatch(/<script/i);
        expect(sanitizeEventDescriptionHtml('<p><span><p>x</p></span></p>')).toBe("<p></p><p>x</p><p></p>");
        expect(sanitizeEventDescriptionHtml("<ul><div><li>x</li></div></ul>")).toBe("<ul><li>x</li></ul>");
    });

    it("Never lets an attribute-borne payload through, however it is quoted or split.", () => {
        for (const html of [
            '<b onmouseover=alert(1)>x</b>',
            "<b onmouseover='alert(1)'>x</b>",
            '<b\nonmouseover\n=\nalert(1)>x</b>',
            '<p style="background:url(javascript:alert(1))">x</p>',
            '<a href="https://ok.example" onfocus="alert(1)" autofocus>x</a>',
            '<a href=" javascript:alert(1)">x</a>',
        ]) {
            const clean = sanitizeEventDescriptionHtml(html);
            expect(clean).not.toMatch(/on\w+\s*=/i);
            expect(clean).not.toMatch(/style|javascript/i);
        }
        // A quote in a URL is percent-encoded, never able to end the attribute.
        expect(sanitizeEventDescriptionHtml('<a href="https://ok.example&quot; onclick=&quot;alert(1)">x</a>')).toBe(
            `<a href="https://ok.example%22%20onclick=%22alert(1)" ${NOFOLLOW}>x</a>`,
        );
    });

    it("Strips control characters and NULs from text.", () => {
        expect(sanitizeEventDescriptionHtml("a\u0000b\u0007c\u001bd\te\nf")).toBe("abcd\te\nf");
    });

    it("Bounds nesting depth and element count without throwing, keeping the text.", () => {
        const deep = "<b>".repeat(100) + "core" + "</b>".repeat(100);
        const clean = sanitizeEventDescriptionHtml(deep);
        expect(clean).toContain("core");
        expect((clean.match(/<b>/g) ?? []).length).toBe(32);
        const many = "<i>x</i>".repeat(2500);
        const cleaned = sanitizeEventDescriptionHtml(many);
        expect((cleaned.match(/<i>/g) ?? []).length).toBe(2000);
        expect(cleaned.replace(/<\/?i>/g, "")).toBe("x".repeat(2500));
    });

    it("Cuts oversized input rather than working on all of it.", () => {
        const clean = sanitizeEventDescriptionHtml("x".repeat(MAX_EVENT_DESCRIPTION_HTML_LENGTH * 5));
        expect(clean.length).toBe(MAX_EVENT_DESCRIPTION_HTML_LENGTH * 4);
    });

    it("Is idempotent: sanitizing its own output changes nothing, even for input that restructures when elements are removed.", () => {
        for (const html of [
            "<p>a<p>b<ul><li>c<li>d</ul>",
            '<p><span><p>x</p></span></p>',
            "<b><div><i>x</div></i></b>",
            '<a href="https://x.example/?a=1&b=2">l</a><script>1</script><br><br/>',
            "<p><table><p>q</p></table></p>",
            "1 &lt; 2 &amp;&amp; 3",
        ]) {
            const once = sanitizeEventDescriptionHtml(html);
            expect(sanitizeEventDescriptionHtml(once)).toBe(once);
        }
    });

    it("Copes with a non-string it is handed by mistake.", () => {
        expect(sanitizeEventDescriptionHtml(undefined as any)).toBe("undefined");
    });
});

describe("htmlToPlainText()", () => {
    it("Gives a line per paragraph, break and list item, with bullets and numbers.", () => {
        const html = "<p>First paragraph<br>second line</p><p>Second</p><ul><li>one</li><li>two</li></ul><ol><li>a</li><li>b</li></ol><p>End</p>";
        expect(htmlToPlainText(html)).toBe("First paragraph\nsecond line\nSecond\n- one\n- two\n1. a\n2. b\nEnd");
    });

    it("Writes a link's URL after its text unless the text already is the URL or the mail address.", () => {
        expect(htmlToPlainText('<a href="https://example.com/x">the site</a>')).toBe("the site (https://example.com/x)");
        expect(htmlToPlainText('<a href="https://example.com/x">https://example.com/x</a>')).toBe("https://example.com/x");
        expect(htmlToPlainText('<a href="mailto:a@example.com">a@example.com</a>')).toBe("a@example.com");
        expect(htmlToPlainText("<a>nothing</a>")).toBe("nothing");
    });

    it("Decodes entities, collapses whitespace, shortens blank runs and drops every other tag and dropped element's content.", () => {
        expect(htmlToPlainText("Tom &amp; Jerry &lt;3\n   lots   of   space<script>alert(1)</script><style>p{}</style>!")).toBe("Tom & Jerry <3 lots of space!");
        expect(htmlToPlainText("<div><span>a</span></div><br><br><br><br>b")).toBe("a\n\n\n\nb".replace(/\n{3,}/g, "\n\n"));
        expect(htmlToPlainText("<p>  lead</p><p>trail  </p>")).toBe("lead\ntrail");
        expect(htmlToPlainText("a\u0000b\u0007c")).toBe("abc");
    });

    it("Copes with unbalanced lists and stray closers, and cuts at the plain-text bound.", () => {
        expect(htmlToPlainText("<li>x</li></ul></ol>y")).toBe("- x\ny");
        expect(htmlToPlainText("z".repeat(MAX_EVENT_DESCRIPTION_LENGTH + 500)).length).toBe(MAX_EVENT_DESCRIPTION_LENGTH);
    });
});

describe("cleanPlainDescription()", () => {
    it("Turns every line break into a newline and drops control characters.", () => {
        expect(cleanPlainDescription("a\r\nb\rc\nd\u0000e\u0007f\tg")).toBe("a\nb\nc\nde" + "f\tg");
    });
});

describe("normalizeEventDescription()", () => {
    it("Changes nothing when neither field is given.", () => {
        expect(normalizeEventDescription({})).toEqual({});
    });

    it("Sanitizes the HTML and derives the plain text from it when only the HTML is given.", () => {
        expect(normalizeEventDescription({ descriptionHtml: '<p onclick="x()">Hi <b>there</b></p><script>1</script>' })).toEqual({
            description: "Hi there",
            descriptionHtml: "<p>Hi <b>there</b></p>",
        });
    });

    it("Keeps the plain text given alongside the HTML.", () => {
        expect(normalizeEventDescription({ description: "Custom text", descriptionHtml: "<p>Hi</p>" })).toEqual({ description: "Custom text", descriptionHtml: "<p>Hi</p>" });
    });

    it("Keeps plain text as it is and clears the HTML when only plain text is given.", () => {
        expect(normalizeEventDescription({ description: "Line one\r\nLine two" })).toEqual({ description: "Line one\nLine two", descriptionHtml: null });
    });

    it("Clears a field with null or an empty string, and clears the HTML when nothing survives sanitizing.", () => {
        expect(normalizeEventDescription({ description: null, descriptionHtml: null })).toEqual({ description: null, descriptionHtml: null });
        expect(normalizeEventDescription({ description: "" })).toEqual({ description: null, descriptionHtml: null });
        expect(normalizeEventDescription({ descriptionHtml: null })).toEqual({ descriptionHtml: null });
        expect(normalizeEventDescription({ descriptionHtml: "<script>1</script>" })).toEqual({ descriptionHtml: null });
        expect(normalizeEventDescription({ description: "kept", descriptionHtml: "<script>1</script>" })).toEqual({ description: "kept", descriptionHtml: null });
    });

    it("Falls back to null plain text when the HTML has no text at all.", () => {
        expect(normalizeEventDescription({ descriptionHtml: "<p></p>" })).toEqual({ description: null, descriptionHtml: "<p></p>" });
    });

    it("Refuses a value that isn't a string, and a value over its bound, with a 400.", () => {
        const refused = (input: any): any => {
            try {
                normalizeEventDescription(input);
            } catch (err: any) {
                return err;
            }
            return undefined;
        };
        expect(refused({ description: 5 })?.status).toBe(400);
        expect(refused({ descriptionHtml: {} })?.status).toBe(400);
        expect(refused({ description: "x".repeat(MAX_EVENT_DESCRIPTION_LENGTH + 1) })?.status).toBe(400);
        expect(refused({ descriptionHtml: "x".repeat(MAX_EVENT_DESCRIPTION_HTML_LENGTH + 1) })?.status).toBe(400);
        // Within the bound as sent, over it once the escaping is written: 30,000 `&` become `&amp;`.
        expect(refused({ descriptionHtml: "&".repeat(30_000) })?.status).toBe(400);
        expect(refused({ description: "x".repeat(MAX_EVENT_DESCRIPTION_LENGTH), descriptionHtml: "<p>ok</p>" })).toBeUndefined();
    });
});

describe("sanitizeInboundDescription()", () => {
    it("Gives nothing for nothing.", () => {
        expect(sanitizeInboundDescription(undefined, undefined)).toEqual({});
        expect(sanitizeInboundDescription("", "")).toEqual({});
    });

    it("Sanitizes the HTML and keeps the plain text as sent.", () => {
        expect(sanitizeInboundDescription("Plain", '<p onclick="x()">Rich</p><script>1</script>')).toEqual({ description: "Plain", descriptionHtml: "<p>Rich</p>" });
    });

    it("Derives the plain text when the file has only HTML, and drops HTML that sanitizes to nothing or is too long.", () => {
        expect(sanitizeInboundDescription(undefined, "<p>Only <i>html</i></p>")).toEqual({ description: "Only html", descriptionHtml: "<p>Only <i>html</i></p>" });
        expect(sanitizeInboundDescription("Plain", "<script>1</script>")).toEqual({ description: "Plain" });
        expect(sanitizeInboundDescription("Plain", "&".repeat(30_000))).toEqual({ description: "Plain" });
    });

    it("Cuts overlong plain text instead of failing.", () => {
        expect(sanitizeInboundDescription("y".repeat(MAX_EVENT_DESCRIPTION_LENGTH + 10), undefined).description).toHaveLength(MAX_EVENT_DESCRIPTION_LENGTH);
    });
});
