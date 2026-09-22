///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    DEFAULT_ALLOWED_TAGS,
    readSanitizerVersion,
    resolveInlineImages,
    SANITIZER_VERSION,
    sanitizeMailHtml,
    stampSanitizedHtml,
    stripSanitizerStamp,
} from "../../src/scan/HtmlSanitizer.js";
import { DESIGN_CORPUS, HOSTILE_CORPUS } from "./fixtures/mailCorpus.js";
import { inertViolations } from "./fixtures/inert.js";

/** The `<body>` of a sanitized document. */
const bodyOf = (html: string): string => /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1];
/** The sanitized body of `html` (a fragment), for tests about one element. */
const sanitizeBody = (html: string, options?: Parameters<typeof sanitizeMailHtml>[1]): string => bodyOf(sanitizeMailHtml(html, options));

describe("HtmlSanitizer", () => {
    describe("design corpus: realistic mail keeps its design", () => {
        for (const fixture of DESIGN_CORPUS) {
            it(fixture.id, () => {
                const output: string = sanitizeMailHtml(fixture.html);

                for (const keep of fixture.keeps) {
                    expect(output).toMatch(typeof keep === "string" ? new RegExp(keep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : keep);
                }
                for (const drop of fixture.drops ?? []) {
                    expect(output).not.toMatch(typeof drop === "string" ? new RegExp(drop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : drop);
                }
                expect(inertViolations(output)).toEqual([]);
                expect(sanitizeMailHtml(output)).toBe(output);
            });
        }
    });

    describe("hostile corpus: nothing executes, navigates, submits, overlays or loads", () => {
        it("has at least 60 payloads", () => {
            expect(HOSTILE_CORPUS.length).toBeGreaterThanOrEqual(60);
        });

        for (const payload of HOSTILE_CORPUS) {
            it(payload.id, () => {
                const started: number = performance.now();
                const output: string = sanitizeMailHtml(payload.html);
                const elapsed: number = performance.now() - started;

                expect(inertViolations(output)).toEqual([]);
                expect(sanitizeMailHtml(output)).toBe(output);
                // Bounded work whatever the input: even 5 MB of CSS or 50,000 nested elements is answered in well under a few seconds.
                expect(elapsed).toBeLessThan(5000);
                expect(output.length).toBeLessThan(payload.html.length * 4 + 1000);
            });
        }

        it("keeps the harmless text around a blocked payload", () => {
            expect(sanitizeBody(`<p>before</p><script>alert(1)</script><p>after</p>`)).toBe("<p>before</p><p>after</p>");
            expect(sanitizeBody(`<a href=" javascript:alert(1)">click <b>me</b></a>`)).toBe("<a>click <b>me</b></a>");
            expect(sanitizeBody(`<form action="https://evil.example/"><b>keep</b><input name=x><button>Go</button></form>`)).toBe("<b>keep</b>Go");
        });

        it("bounds what a 5 MB stylesheet, 30,000 rules and 50,000 nested elements can cost", () => {
            const css: string = sanitizeMailHtml(`<style>${"a{color:red}".repeat(400_000)}</style>`, { maxCssBytes: 1000 });
            expect(css.length).toBeLessThan(1200);
            const rules: string = sanitizeMailHtml(`<style>${Array.from({ length: 300 }, (_, i) => `.c${i}{color:red}`).join("")}</style>`, { maxCssRules: 10 });
            expect(rules.match(/\.c\d+\{/g)).toHaveLength(10);
            const nested: string = sanitizeMailHtml("<div>".repeat(1000) + "deep" + "</div>".repeat(1000), { maxDepth: 20 });
            expect(nested.match(/<div>/g)).toHaveLength(20);
            expect(nested).toContain("deep");
            const many: string = sanitizeMailHtml("<i>x</i>".repeat(100), { maxElements: 10 });
            expect(many.match(/<i>/g)).toHaveLength(10);
            expect(many.match(/x/g)).toHaveLength(100);
            expect(sanitizeMailHtml("a".repeat(1000), { maxInputLength: 10 })).toContain(">aaaaaaaaaa<");
        });
    });

    describe("what is written", () => {
        it("is a complete, well-formed document with the message's own body attributes", () => {
            expect(sanitizeMailHtml("<p>x</p>")).toBe("<!DOCTYPE html><html><head></head><body><p>x</p></body></html>");
            expect(sanitizeMailHtml(`<html lang="fr" dir="rtl"><body bgcolor="#123456" style="margin:0" onload="x()" class="a"><p>x</p></body></html>`)).toBe(
                `<!DOCTYPE html><html lang="fr" dir="rtl"><head></head><body bgcolor="#123456" style="margin:0" class="a"><p>x</p></body></html>`,
            );
            // The first <html> and <body> speak for the page; a second of either is ignored (its content stays).
            expect(sanitizeMailHtml(`<body class="one"><body class="two"><html lang="de"><p>x</p></html><html lang="fr">`)).toBe(
                `<!DOCTYPE html><html lang="de"><head></head><body class="one"><p>x</p></body></html>`,
            );
        });

        it("escapes text and attribute values, and drops control characters", () => {
            expect(sanitizeBody(`<p title='a"b&amp;c<d'>1 &lt; 2 &amp; "quoted" 'single' &gt; 0\u0001\u0007</p>`)).toBe(
                `<p title="a&quot;b&amp;c&lt;d">1 &lt; 2 &amp; &quot;quoted&quot; &#39;single&#39; &gt; 0</p>`,
            );
            expect(sanitizeBody("tab\there\r\nline")).toBe("tab\there\r\nline");
        });

        it("keeps whitespace inside text but not the whitespace around <html> and <head>", () => {
            expect(sanitizeMailHtml("<!DOCTYPE html>\n<html>\n<head>\n</head>\n<body>a <b>b</b> c</body>\n</html>\n")).toBe(
                "<!DOCTYPE html><html><head></head><body>a <b>b</b> c\n</body></html>",
            );
            expect(sanitizeBody("plain text only &amp; <b>bold")).toBe("plain text only &amp; <b>bold</b>");
        });

        it("writes void elements without a closing tag and closes everything else", () => {
            expect(sanitizeBody(`a<br>b<hr>c<wbr><table><colgroup><col span="2"></colgroup><tr><td>x<p>y`)).toBe(
                `a<br>b<hr>c<wbr><table><colgroup><col span="2"></colgroup><tr><td>x<p>y</p></td></tr></table>`,
            );
        });

        it("keeps the text of an element it does not know and drops the tag (Outlook's o:p, custom elements, form wrappers)", () => {
            expect(sanitizeBody(`<o:p>keep</o:p><x-widget>me</x-widget><marquee>too</marquee><label>and</label><details><summary>this</summary></details>`)).toBe("keepmetooandthis");
        });

        it("drops svg/math prefixed elements and everything in them", () => {
            expect(sanitizeBody(`<svg:svg><svg:text>a</svg:text></svg:svg><math:math>b</math:math>c`)).toBe("c");
        });

        it("keeps the head's colour-scheme declaration and only that", () => {
            expect(sanitizeMailHtml(`<head><meta name="Color-Scheme" content=" Light   DARK "><meta name="color-scheme" content="evil; x"><meta name="viewport" content="x"><meta charset="utf-8"></head>`)).toBe(
                `<!DOCTYPE html><html><head><meta name="color-scheme" content="light dark"></head><body></body></html>`,
            );
            expect(sanitizeMailHtml(`<div><meta name="color-scheme" content="dark"></div><noscript><meta name="color-scheme" content="dark"></noscript>`)).toContain(`content="dark"`);
            expect(sanitizeMailHtml(`<noscript><meta name="color-scheme" content="dark"></noscript>`)).not.toContain("color-scheme");
        });
    });

    describe("elements", () => {
        it("keeps the structural, text, table, list, link and image elements", () => {
            const body: string = DEFAULT_ALLOWED_TAGS.filter((tag) => !["style", "br", "hr", "img", "col", "wbr"].includes(tag))
                .map((tag) => `<${tag}>x</${tag}>`)
                .join("");
            const output: string = sanitizeBody(body);
            for (const tag of DEFAULT_ALLOWED_TAGS.filter((name) => !["style", "img", "br", "hr", "col", "wbr"].includes(name))) {
                expect(output).toContain(`<${tag}>`);
            }
        });

        it("drops the dangerous elements with what is inside them", () => {
            const blocked = [
                "script",
                "noscript",
                "iframe",
                "frameset",
                "object",
                "applet",
                "select",
                "option",
                "textarea",
                "title",
                "svg",
                "math",
                "video",
                "audio",
                "canvas",
                "template",
                "slot",
                "dialog",
                "xml",
                "xmp",
                "plaintext",
                "listing",
                "noembed",
                "noframes",
                "datalist",
            ];
            for (const tag of blocked) {
                expect(sanitizeBody(`a<${tag}>secret</${tag}>b`)).toBe("ab");
            }
            for (const tag of ["input", "link", "meta", "base", "param", "source", "track", "area", "embed"]) {
                expect(sanitizeBody(`a<${tag} src="x" name="y" value="z">b`)).toBe("ab");
            }
        });

        it("drops <style> when the allowed elements exclude it, and <img> likewise", () => {
            expect(sanitizeMailHtml(`<style>a{color:red}</style><p>x</p><img src="cid:a" alt="A">`, { allowedTags: ["p"] })).toBe(
                "<!DOCTYPE html><html><head></head><body><p>x</p></body></html>",
            );
            expect(sanitizeMailHtml(`<style>a{color:red}</style><p>x</p><img src="cid:a" alt="A">`, { allowedTags: ["style", "img"] })).toBe(
                `<!DOCTYPE html><html><head><style>a{color:red}</style></head><body>x<img src="cid:a" alt="A"></body></html>`,
            );
            expect(sanitizeBody(`<p>x</p><b>y</b>`, { allowedTags: ["p", "SCRIPT"] })).toBe("<p>x</p>y");
            // The list restricts; it never adds: `script` is not something a setting can allow, and an empty list means all of them.
            expect(sanitizeBody(`<script>1</script><b>y</b>`, { allowedTags: ["script", "b"] })).toBe("<b>y</b>");
            expect(sanitizeBody(`<b>y</b>`, { allowedTags: [] })).toBe("<b>y</b>");
        });

        it("keeps a <style>'s type and media only when they are plain CSS", () => {
            const styles = (html: string): string => /<head>([\s\S]*?)<\/head>/.exec(sanitizeMailHtml(html))![1];
            expect(styles(`<style type="text/css">a{color:red}</style>`)).toBe("<style>a{color:red}</style>");
            expect(styles(`<style type="text/javascript">a{color:red}</style>`)).toBe("");
            expect(styles(`<style media="screen and (max-width: 600px)">a{color:red}</style>`)).toBe("<style>@media screen and (max-width: 600px){a{color:red}}</style>");
            expect(styles(`<style media="all">a{color:red}</style>`)).toBe("<style>a{color:red}</style>");
            expect(styles(`<style media="screen{}body{x:y}">a{color:red}</style>`)).toBe("");
            expect(styles(`<style>@media print{a{color:red}}</style><style>/* nothing */</style><style></style>`)).toBe("<style>@media print{a{color:red}}</style>");
        });

        it("moves every <style>, wherever it was, into the head", () => {
            expect(sanitizeMailHtml(`<p>a</p><div><style>b{color:blue}</style></div><head><style>a{color:red}</style></head>`)).toBe(
                "<!DOCTYPE html><html><head><style>b{color:blue}</style><style>a{color:red}</style></head><body><p>a</p><div></div></body></html>",
            );
        });

        it("does not treat text in a <style> as text", () => {
            expect(sanitizeBody(`<style>p{color:red}</style>visible`)).toBe("visible");
        });

        it("writes a page even from what mailparser or a client may hand over (no markup at all, text at the top level)", () => {
            expect(sanitizeMailHtml("")).toBe("<!DOCTYPE html><html><head></head><body></body></html>");
            expect(sanitizeBody("just text")).toBe("just text");
            expect(sanitizeMailHtml("<html>  <head>x</head><body>y</body></html> tail")).toBe("<!DOCTYPE html><html><head></head><body>xy tail</body></html>");
        });
    });

    describe("attributes", () => {
        it("keeps the presentational attributes with valid values and drops the rest", () => {
            const output: string = sanitizeBody(
                `<table width="600px" height=100% border=0 cellpadding=5 cellspacing="0" bgcolor="#FFF" align=center valign=top bordercolor=red hspace=3 vspace=4 nowrap hidden data-x="1" onclick="x" accesskey=x tabindex=1 contenteditable draggable=true><tr><td colspan=2 rowspan="3" abbr="Ab" scope=col headers="h1" width=auto height="1e3">x</td></tr></table>`,
            );
            expect(output).toBe(
                `<table width="600px" height="100%" border="0" cellpadding="5" cellspacing="0" bgcolor="#FFF" align="center" valign="top" bordercolor="red" hspace="3" vspace="4" nowrap="" hidden=""><tr><td colspan="2" rowspan="3" abbr="Ab" scope="col">x</td></tr></table>`,
            );
            // Element-specific attributes are dropped anywhere else.
            expect(sanitizeBody(`<div colspan=2 cellpadding=3 span=2 start=3 scope=row abbr=x type=a text=red link=red>x</div>`)).toBe("<div>x</div>");
            expect(sanitizeBody(`<ol type="a" start="3"><li type="disc">x</li></ol><ul type="square"></ul><ol type="evil"></ol>`)).toBe(`<ol type="a" start="3"><li type="disc">x</li></ol><ul type="square"></ul><ol></ol>`);
        });

        it("validates colours, words, sizes, faces, languages and counts", () => {
            expect(sanitizeBody(`<font color="#a1b2c3" face="Arial, 'Helvetica Neue'" size="+1">x</font>`)).toBe(`<font color="#a1b2c3" face="Arial, 'Helvetica Neue'" size="+1">x</font>`);
            expect(sanitizeBody(`<font color="rgb(1, 2, 3)">a</font><font color="red;x">b</font><font color="url(x)">c</font><font size="big">d</font><font face="a{b}">e</font>`)).toBe(
                `<font color="rgb(1, 2, 3)">a</font><font>b</font><font>c</font><font>d</font><font>e</font>`,
            );
            expect(sanitizeBody(`<p dir="RTL" lang="en-GB">a</p><p dir="sideways" lang="e n">b</p><p lang="x-9999999999">c</p>`)).toBe(`<p dir="rtl" lang="en-GB">a</p><p>b</p><p>c</p>`);
            expect(sanitizeBody(`<div role="presentation" aria-hidden="true" aria-label=" Hi\u0001 " title="  "></div><div role="x y" aria-hidden="maybe"></div>`)).toBe(
                `<div role="presentation" aria-hidden="true" aria-label="Hi"></div><div></div>`,
            );
            expect(sanitizeBody(`<p class="  a   b\tc " id="x"></p><p class="   " id="a b"></p>`)).toBe(`<p class="a b c" id="m-x"></p><p></p>`);
            expect(sanitizeBody(`<table><tr><td colspan="99999" rowspan="x">y</td></tr></table>`)).toBe(`<table><tr><td>y</td></tr></table>`);
        });

        it("drops attributes whose text is empty once cleaned", () => {
            expect(sanitizeBody(`<table><tr><td abbr=" " title="">x</td></tr></table><p aria-label="  " alt=" ">y</p>`)).toBe(`<table><tr><td>x</td></tr></table><p alt="">y</p>`);
        });

        it("reads no more of a <style> than its output could use", () => {
            expect(sanitizeMailHtml(`<style>a{color:red}b{color:red}c{color:red}d{color:red}</style>`, { maxCssBytes: 5 })).toBe("<!DOCTYPE html><html><head></head><body></body></html>");
        });

        it("drops an attribute value that is too long", () => {
            expect(sanitizeBody(`<p title="${"a".repeat(20_000)}">x</p>`)).toBe("<p>x</p>");
            expect(sanitizeBody(`<p title="${"a".repeat(5000)}">x</p>`)).toBe(`<p title="${"a".repeat(1000)}">x</p>`);
        });

        it("prefixes ids, once, and drops name and headers (DOM clobbering)", () => {
            expect(sanitizeBody(`<p id="bodyTable">a</p><p id="m-bodyTable">b</p><p id="x.y">c</p><a name="top" id="body">d</a>`)).toBe(`<p id="m-bodyTable">a</p><p id="m-bodyTable">b</p><p>c</p><a id="m-body">d</a>`);
        });

        it("forces every link to open in a new tab without an opener", () => {
            expect(sanitizeBody(`<a href="https://a.example/?x=1&y=2" target="_top" rel="opener" download ping="https://x">a</a><a href="mailto:a@b.example">b</a><a href="tel:+15551234567">c</a>`)).toBe(
                `<a href="https://a.example/?x=1&amp;y=2" target="_blank" rel="noopener noreferrer nofollow">a</a><a href="mailto:a@b.example" target="_blank" rel="noopener noreferrer nofollow">b</a><a href="tel:+15551234567" target="_blank" rel="noopener noreferrer nofollow">c</a>`,
            );
        });

        it("keeps text for a link that goes nowhere a reader could safely follow", () => {
            for (const href of ["javascript:alert(1)", " java\tscript:alert(1)", "//host/x", "/relative", "relative.html", "#anchor", "data:text/html,x", "cid:x", "ftp://host/x", "http://", "https://h/\\x", "https://h/" + "a".repeat(9000)]) {
                expect(sanitizeBody(`<a href="${href}">t</a>`)).toBe("<a>t</a>");
            }
            expect(sanitizeBody(`<a href="\u0001https://h/">t</a>`)).toBe("<a>t</a>");
            expect(sanitizeBody(`<a href='https://h/a b"c>d'>t</a>`)).toBe(`<a href="https://h/a%20b%22c%3Ed" target="_blank" rel="noopener noreferrer nofollow">t</a>`);
            expect(sanitizeBody(`<a href=" \nHTTPS://H.example/x\t">t</a>`)).toContain(`href="HTTPS://H.example/x"`);
        });

        it("keeps images by cid, small data URIs and http(s); drops the src of anything else but keeps the alt", () => {
            expect(sanitizeBody(`<img src="cid:logo@x" alt="Logo" width=100 height="50" border=0 align=left hspace=2 srcset="a 1x" loading=lazy usemap="#m">`)).toBe(
                `<img src="cid:logo@x" alt="Logo" width="100" height="50" border="0" align="left" hspace="2">`,
            );
            expect(sanitizeBody(`<img src="cid:%3Cimage001%40x%3E" alt="a"><img src="CID:has space" alt="b"><img src="cid:%zz" alt="c">`)).toBe(`<img src="cid:image001@x" alt="a"><img alt="b"><img alt="c">`);
            expect(sanitizeBody(`<img src="https://cdn.example.com/a.png?x=1&y=2" alt="">`)).toBe(`<img src="https://cdn.example.com/a.png?x=1&amp;y=2" alt="">`);
            expect(sanitizeBody(`<img src="javascript:alert(1)" alt="x"><img src="/local.png" alt="y"><img src="//evil/x.png" alt="z">`)).toBe(`<img alt="x"><img alt="y"><img alt="z">`);
        });

        it("drops an image that has neither a usable source nor text", () => {
            expect(sanitizeBody(`a<img src="javascript:x">b<img src="cid:ok">c<img alt=" ">d<img>`)).toBe(`ab<img src="cid:ok">cd`);
        });

        it("keeps data: images of the raster types up to the size limit and drops the rest", () => {
            const png: string = Buffer.alloc(3000, 7).toString("base64");
            expect(sanitizeBody(`<img src="data:image/png;base64,${png}">`)).toBe(`<img src="data:image/png;base64,${png}">`);
            expect(sanitizeBody(`<img src="DATA:image/JPG;base64,${png.slice(0, 8)}\n${png.slice(8, 16)}">`)).toBe(`<img src="data:image/jpeg;base64,${png.slice(0, 16)}">`);
            for (const type of ["gif", "webp", "avif", "jpeg"]) {
                expect(sanitizeBody(`<img src="data:image/${type};base64,AAAA">`)).toContain(`data:image/${type};base64,AAAA`);
            }
            expect(sanitizeBody(`<img src="data:image/png;base64,${png}" alt="big">`, { maxDataImageBytes: 100 })).toBe(`<img alt="big">`);
            for (const bad of ["data:image/svg+xml;base64,PHN2Zy8+", "data:image/png,rawbytes", "data:image/png;base64,", "data:image/png;base64,@@@", "data:text/html;base64,AAAA", "data:image/png;charset=x;base64,AAAA"]) {
                expect(sanitizeBody(`<img src="${bad}" alt="x">`)).toBe(`<img alt="x">`);
            }
        });

        it("applies the same rules to a background attribute", () => {
            expect(sanitizeBody(`<table background="cid:bg@x"><tr><td background="https://x.example/t.gif">a</td><td background="javascript:1">b</td></tr></table>`)).toBe(
                `<table background="cid:bg@x"><tr><td background="https://x.example/t.gif">a</td><td>b</td></tr></table>`,
            );
        });
    });

    describe("style attributes and blocks", () => {
        it("keeps the design and drops what overlays, loads or runs", () => {
            expect(
                sanitizeBody(
                    `<div style="COLOR:Red;background:#FFF url(cid:a) no-repeat;position:fixed;z-index:9;mso-line-height-rule:exactly;font:12px/1.5 'Helvetica Neue',Arial;behavior:url(x);width:expression(1);content:'x';cursor:pointer;display:grid">x</div>`,
                ),
            ).toBe(`<div style="color:Red;background:#FFF url('cid:a') no-repeat;font:12px/1.5 'Helvetica Neue',Arial">x</div>`);
            expect(sanitizeBody(`<div style="display:none;position:relative;overflow:hidden;float:left">x</div><div style="overflow:scroll;position:absolute">y</div>`)).toBe(
                `<div style="display:none;position:relative;overflow:hidden;float:left">x</div><div>y</div>`,
            );
        });

        it("renames ID selectors like the id attributes they select, and keeps @media blocks", () => {
            const head = (html: string): string => /<style>([\s\S]*?)<\/style>/.exec(sanitizeMailHtml(html))![1];
            expect(head(`<style>#a .b>#c:hover{color:red}@media (prefers-color-scheme: dark){#a{color:#fff!important}}</style>`)).toBe(
                "#m-a .b>#m-c:hover{color:red}@media (prefers-color-scheme: dark){#m-a{color:#fff!important}}",
            );
        });

        it("drops a style attribute that has nothing left, and keeps repeats identical", () => {
            expect(sanitizeBody(`<p style="mso-bidi-font-size:11pt;position:fixed">a</p><p style="color:red">b</p><p style="color:red">c</p>`)).toBe(`<p>a</p><p style="color:red">b</p><p style="color:red">c</p>`);
        });
    });

    describe("idempotence and stability", () => {
        it("sanitizing again after unwrapping changes nothing, even where removing an element changes how the rest nests", () => {
            const html = `<p>a<x-foo><p>b</p></x-foo></p><ul><li>a<o:p><li>b</o:p></ul><table><tr><td>a<font><td>b</font></table>`;
            const once: string = sanitizeMailHtml(html);
            expect(sanitizeMailHtml(once)).toBe(once);
            expect(sanitizeMailHtml(sanitizeMailHtml(once))).toBe(once);
        });

        it("terminates for input that keeps changing shape", () => {
            let html = "<p>x</p>";
            for (let i = 0; i < 40; i++) {
                html = `<x-a><p>${html}<x-b></p></x-b></x-a>`;
            }
            expect(() => sanitizeMailHtml(html)).not.toThrow();
        });

        it("never throws for arbitrary input", () => {
            const random = (seed: number): (() => number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
            const rand = random(42);
            const pieces = ["<", ">", "</", "<p", "<div>", "</div>", "<a href=", '"', "'", "=", " ", "&#", "&amp;", "<style>", "</style>", "url(", ")", "{", "}", ";", ":", "\\", "/*", "*/", "<!--", "-->", "javascript:", "x", "0", "\u0000", " ", "<script>", "<svg>", "@media", "!important", "cid:"];
            for (let i = 0; i < 300; i++) {
                let html = "";
                for (let j = 0; j < 60; j++) {
                    html += pieces[Math.floor(rand() * pieces.length)];
                }
                const output: string = sanitizeMailHtml(html);
                expect(inertViolations(output)).toEqual([]);
                expect(sanitizeMailHtml(output)).toBe(output);
            }
        });
    });

    describe("version stamp", () => {
        it("is written in front of, read from and stripped from a stored blob", () => {
            const stamped: string = stampSanitizedHtml("<p>x</p>");
            expect(stamped).toBe(`<!--rapidmx-sanitized:${SANITIZER_VERSION}--><p>x</p>`);
            expect(readSanitizerVersion(stamped)).toBe(SANITIZER_VERSION);
            expect(readSanitizerVersion(Buffer.from(stamped))).toBe(SANITIZER_VERSION);
            expect(stripSanitizerStamp(stamped)).toBe("<p>x</p>");
            expect(readSanitizerVersion("<p>old sanitizer output</p>")).toBe(0);
            expect(readSanitizerVersion(Buffer.from("<!--rapidmx-sanitized:x-->"))).toBe(0);
            expect(readSanitizerVersion(`<!--rapidmx-sanitized:7-->`)).toBe(7);
        });

        it("cannot be forged from inside a message: a comment in the input is dropped", () => {
            expect(sanitizeMailHtml(`<!--rapidmx-sanitized:99--><p>x</p>`)).not.toContain("rapidmx-sanitized");
        });
    });

    describe("resolveInlineImages()", () => {
        const html: string = sanitizeMailHtml(
            `<img src="cid:a@x" alt="A"><img src="cid:gone@x" alt="G"><table background="cid:bg"><tr><td background="cid:gone2">x</td></tr></table><div style="background:url(cid:a@x) no-repeat;list-style-image:url(cid:gone3)">y</div><style>.h{background-image:url(cid:a@x)}.g{background-image:url(cid:gone4)}</style>`,
        );

        it("points known references at what the resolver says and drops the rest, in attributes and in CSS", () => {
            const resolved: string = resolveInlineImages(html, (token) => ({ "a@x": "/api/mail/attachments/u1/content", bg: "/api/mail/attachments/u2/content" })[token]);

            expect(resolved).toContain(`<img src="/api/mail/attachments/u1/content" alt="A">`);
            expect(resolved).toContain(`<img alt="G">`);
            expect(resolved).toContain(`<table background="/api/mail/attachments/u2/content"><tr><td>x</td></tr></table>`);
            expect(resolved).toContain(`style="background:url('/api/mail/attachments/u1/content') no-repeat;list-style-image:none"`);
            expect(resolved).toContain(`.h{background-image:url('/api/mail/attachments/u1/content')}.g{background-image:none}`);
            expect(resolved).not.toContain("cid:");
            expect(inertViolations(resolved.replace(/\/api\/mail\/attachments\//g, "https://h.example/"))).toEqual([]);
        });

        it("escapes what the resolver returns", () => {
            expect(resolveInlineImages(`<img src="cid:a">`, () => `x"y<z&`)).toBe(`<img src="x&quot;y&lt;z&amp;">`);
            expect(resolveInlineImages(`<div style="background:url('cid:a')">`, () => `x'y\\z<`)).toBe(`<div style="background:url('x%27y%5cz%3c')">`);
        });

        it("leaves HTML without cid references alone, and cannot be fooled by text that looks like one", () => {
            expect(resolveInlineImages("<p>no images</p>", () => "x")).toBe("<p>no images</p>");
            const text: string = sanitizeMailHtml(`<p>src="cid:a" and url('cid:a')</p>`);
            expect(resolveInlineImages(text, () => "REPLACED")).toBe(text);
        });
    });
});
