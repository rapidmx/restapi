///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    createCssContext,
    escapeCssIdent,
    escapeCssString,
    prefixId,
    sanitizeInlineStyle,
    sanitizeMediaCondition,
    sanitizeStyleSheet,
    serializeCssTokens,
    tokenizeCss,
    type CssToken,
} from "../../src/scan/CssSanitizer.js";

const context = (maxBytes: number = 100_000, maxRules: number = 5000, maxDataImageBytes: number = 1000) => createCssContext(maxBytes, maxRules, maxDataImageBytes);
const sheet = (css: string, ctx = context()): string => sanitizeStyleSheet(css, ctx);
const inline = (css: string, ctx = context()): string => sanitizeInlineStyle(css, ctx);
const types = (css: string): string[] => tokenizeCss(css).map((token: CssToken) => token.type);
const roundTrip = (css: string): string => serializeCssTokens(tokenizeCss(css));

describe("CssSanitizer", () => {
    describe("tokenizer", () => {
        it("recognises the token types of CSS Syntax Level 3", () => {
            expect(types("a 1 2px 3% #id @m (x) [y] {z} ; : , 'str' url(x) f( +.5 -1e3 !")).toEqual([
                "ident",
                "ws",
                "number",
                "ws",
                "dimension",
                "ws",
                "percentage",
                "ws",
                "hash",
                "ws",
                "atkeyword",
                "ws",
                "(",
                "ident",
                ")",
                "ws",
                "[",
                "ident",
                "]",
                "ws",
                "{",
                "ident",
                "}",
                "ws",
                "semicolon",
                "ws",
                "colon",
                "ws",
                "comma",
                "ws",
                "string",
                "ws",
                "url",
                "ws",
                "function",
                "ws",
                "number",
                "ws",
                "number",
                "ws",
                "delim",
            ]);
        });

        it("decodes escapes in names, strings and URLs", () => {
            const [ident, , quoted, , str, , url] = tokenizeCss(String.raw`\75rl u\72l( "a\62 c\
d" ) "a\62 c\
d" url(\6a avascript\3a x)`);
            expect(ident).toMatchObject({ type: "ident", value: "url" });
            expect(quoted).toMatchObject({ type: "url", value: "abcd" });
            expect(str).toMatchObject({ type: "string", value: "abcd" });
            expect(url).toMatchObject({ type: "url", value: "javascript:x" });
            expect(tokenizeCss(String.raw`\0 \110000 \d800 \1F600`)).toMatchObject([{ type: "ident", value: "���\u{1F600}" }]);
            expect(tokenizeCss(String.raw`a\.b \😀`).map((token: CssToken) => token.value)).toEqual(["a.b", " ", "😀"]);
        });

        it("turns comments into whitespace and joins nothing across them", () => {
            expect(types("a/**/b")).toEqual(["ident", "ws", "ident"]);
            expect(types("/* leading */a/* unterminated")).toEqual(["ident", "ws"]);
            expect(types("  a")).toEqual(["ident"]);
        });

        it("marks an unterminated string or url as bad, and stops it at the line's end", () => {
            expect(types(`'never ends`)).toEqual(["bad"]);
            expect(types(`'ends\nhere'`)).toEqual(["bad", "ws", "ident", "bad"]);
            expect(types(`'x\\`)).toEqual(["bad"]);
            expect(types(`url(x y)`)).toEqual(["bad"]);
            expect(types(`url(x"y)`)).toEqual(["bad"]);
            expect(types(`url('x' y)`)).toEqual(["bad"]);
            expect(types(`url('unterminated`)).toEqual(["bad"]);
            expect(types(`url(a\\`)).toEqual(["bad"]);
            expect(types(`url(a\\\nb) z`)).toEqual(["bad", "ws", "ident"]);
            expect(types(`url(a`)).toEqual(["bad"]);
            expect(types(`url(a\u0001b)`)).toEqual(["bad"]);
            expect(types(`url( x )`)).toEqual(["url"]);
            expect(types(`url( 'x' )`)).toEqual(["url"]);
            expect(types(`url(`)).toEqual(["bad"]);
            expect(tokenizeCss(`url(a\\29 b)`)[0]).toMatchObject({ type: "url", value: "a)b" });
        });

        it("distinguishes numbers, dimensions and identifiers that start with a sign or dot", () => {
            expect(tokenizeCss("-1px +2 .5em -.5 - + . 1e3x 1e 5%")).toMatchObject([
                { type: "dimension", value: "-1", unit: "px" },
                { type: "ws" },
                { type: "number", value: "+2" },
                { type: "ws" },
                { type: "dimension", value: ".5", unit: "em" },
                { type: "ws" },
                { type: "number", value: "-.5" },
                { type: "ws" },
                { type: "delim", value: "-" },
                { type: "ws" },
                { type: "delim", value: "+" },
                { type: "ws" },
                { type: "delim", value: "." },
                { type: "ws" },
                { type: "dimension", value: "1e3", unit: "x" },
                { type: "ws" },
                { type: "dimension", value: "1", unit: "e" },
                { type: "ws" },
                { type: "percentage", value: "5" },
            ]);
            expect(types("-webkit-x --y -\\61 -->")).toEqual(["ident", "ws", "ident", "ws", "ident", "delim"]);
        });

        it("treats a hash that is not an identifier, a bare # or @, and an invalid escape as delimiters or non-id hashes", () => {
            expect(tokenizeCss("#123 #a #\\31 x # @ @1 \\\n")).toMatchObject([
                { type: "hash", isId: false },
                { type: "ws" },
                { type: "hash", isId: true },
                { type: "ws" },
                { type: "hash", isId: true },
                { type: "ws" },
                { type: "delim", value: "#" },
                { type: "ws" },
                { type: "delim", value: "@" },
                { type: "ws" },
                { type: "delim", value: "@" },
                { type: "number", value: "1" },
                { type: "ws" },
                { type: "delim", value: "\\" },
                { type: "ws" },
            ]);
        });

        it("reads any character, including astral ones and a NUL, as part of a name or a delimiter", () => {
            expect(tokenizeCss("é😀a\0b \u{1F600}")).toMatchObject([{ type: "ident", value: "é😀a�b" }, { type: "ws" }, { type: "ident", value: "\u{1F600}" }]);
            expect(tokenizeCss("\r\n\f")).toEqual([]);
            expect(tokenizeCss("%")).toMatchObject([{ type: "delim", value: "%" }]);
            expect(tokenizeCss("\u{1F4A9}")).toMatchObject([{ type: "ident" }]);
            expect(tokenizeCss("<")).toMatchObject([{ type: "delim", value: "<" }]);
        });
    });

    describe("serializer", () => {
        it("writes tokens back so they read the same, with single spaces and none next to commas or just inside parentheses", () => {
            expect(roundTrip("  rgb( 0 , 0 ,0 )   #FFF  ")).toBe("rgb(0,0,0) #FFF");
            expect(roundTrip("a /* c */ b")).toBe("a b");
            expect(roundTrip("calc( 1px + (2px * 3) )")).toBe("calc(1px + (2px * 3))");
            expect(roundTrip("@media 1% 2px 'x' url(y)")).toBe("@media 1% 2px 'x' url('y')");
        });

        it("escapes identifiers and strings so nothing can leave them", () => {
            expect(escapeCssIdent("a<b")).toBe("a\\3c b");
            expect(escapeCssIdent("1a")).toBe("\\31 a");
            expect(escapeCssIdent("-1a")).toBe("-\\31 a");
            expect(escapeCssIdent("-")).toBe("\\-");
            expect(escapeCssIdent("a b.c\u0001")).toBe("a\\ b\\.c\\1 ");
            expect(escapeCssIdent("é_-9")).toBe("é_-9");
            expect(escapeCssIdent("1a", true)).toBe("1a");
            expect(escapeCssString(`a'b\\c<d\n\u0000e"`)).toBe(`'a\\'b\\\\c\\3c d\\a \\0 e"'`);
            for (const text of ["a<b", "1a", "-1a", "a b", "\u0001x", "😀", "-", "--x", "a\\b"]) {
                expect(tokenizeCss(escapeCssIdent(text))[0]).toMatchObject({ type: "ident", value: text });
            }
            for (const text of [`a'b`, `a\\b`, "a<b\n", "x\u007f"]) {
                expect(tokenizeCss(escapeCssString(text))[0]).toMatchObject({ type: "string", value: text });
            }
        });

        it("keeps an at-keyword, a dimension's unit and a hash exact", () => {
            expect(serializeCssTokens([{ type: "atkeyword", value: "media" }])).toBe("@media");
            expect(roundTrip("12px #1a2 5e2em")).toBe("12px #1a2 5e2em");
        });
    });

    describe("declarations", () => {
        it("keeps allowed properties in canonical form and drops the rest", () => {
            expect(inline("COLOR : Red ; Background-Color:#FFF;;margin:0 auto;font:12px/1.5 'Helvetica Neue', Arial")).toBe(
                "color:Red;background-color:#FFF;margin:0 auto;font:12px/1.5 'Helvetica Neue',Arial",
            );
            expect(inline("mso-line-height-rule:exactly;z-index:3;content:'x';cursor:pointer;filter:alpha(opacity=50);transform:scale(2);animation:x 1s;--custom:1;behavior:url(x);-moz-binding:url(x)")).toBe("");
            expect(inline("width:100%;height:auto;min-width:0;max-height:none;box-sizing:border-box;aspect-ratio:16/9;gap:4px;order:1")).toBe(
                "width:100%;height:auto;min-width:0;max-height:none;box-sizing:border-box;aspect-ratio:16/9;gap:4px;order:1",
            );
            expect(inline("-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;-webkit-border-radius:3px;border-top-left-radius:3px;text-shadow:0 0 1px #000;list-style:none;outline:0;flex:1 1 0%;justify-content:center;-webkit-font-smoothing:antialiased;color-scheme:light dark")).toBe(
                "-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;-webkit-border-radius:3px;border-top-left-radius:3px;text-shadow:0 0 1px #000;list-style:none;outline:0;flex:1 1 0%;justify-content:center;-webkit-font-smoothing:antialiased;color-scheme:light dark",
            );
        });

        it("keeps !important and its spacing variants, and refuses a bang anywhere else", () => {
            expect(inline("color:red !important;width:1px! IMPORTANT;height:2px!important")).toBe("color:red!important;width:1px!important;height:2px!important");
            expect(inline("color:red !ie;width:!important;height:1px !important x;margin:!important 0")).toBe("");
        });

        it("checks display, position and overflow values", () => {
            expect(inline("display:BLOCK;display:inline-block;display:table-cell;display:flex;display:none;display:list-item")).toBe(
                "display:BLOCK;display:inline-block;display:table-cell;display:flex;display:none;display:list-item",
            );
            expect(inline("display:grid;display:block flex;display:contents;display:5;display:var(--x)")).toBe("");
            expect(inline("position:relative;position:STATIC;position:absolute;position:fixed;position:sticky;position:relative absolute;position:5")).toBe("position:relative;position:STATIC");
            expect(inline("overflow:hidden;overflow:auto;overflow:visible hidden;overflow-x:hidden;overflow-y:auto;overflow:scroll;overflow:hidden auto visible;overflow:clip;overflow:5")).toBe(
                "overflow:hidden;overflow:auto;overflow:visible hidden;overflow-x:hidden;overflow-y:auto",
            );
            expect(inline("overflow-wrap:break-word")).toBe("overflow-wrap:break-word");
            expect(inline("display:-webkit-flex;display:-ms-flexbox")).toBe("display:-webkit-flex");
        });

        it("allows only the functions colours, arithmetic and gradients use", () => {
            expect(inline("color:rgba(0,0,0,.5);color:hsl(10 20% 30% / 40%);width:calc(100% - (2 * 10px));width:min(1px,2px);background:linear-gradient(to right,#fff 0%,#000 100%)")).toBe(
                "color:rgba(0,0,0,.5);color:hsl(10 20% 30% / 40%);width:calc(100% - (2 * 10px));width:min(1px,2px);background:linear-gradient(to right,#fff 0%,#000 100%)",
            );
            expect(inline("background:-webkit-gradient(linear,left top,left bottom,from(#fff),to(#000),color-stop(.5,#eee));background:-webkit-linear-gradient(top,#fff,#000)")).toContain("-webkit-gradient(linear");
            expect(inline("width:expression(1);width:var(--x);background:image(x);background:image-set('x' 1x);background:element(#a);background:paint(x);width:attr(x);width:env(x);color:unknown(1)")).toBe("");
        });

        it("refuses values with tokens that have no place in one", () => {
            for (const value of ["a:b", "{x}", "[x]", "@x", "x@y", "1 < 2", "a > b", "a\\", "'unterminated", "url(bad url)", "(unbalanced", "unbalanced)", "a,b)", "f(x", "a\u0001b", "url(a b)"]) {
                expect(inline(`color:${value}`)).toBe("");
            }
            expect(inline("color:red\\9")).toBe("");
            expect(inline("width:calc(((((((((1)))))))))")).toBe("");
            expect(inline(`color:${"a ".repeat(300)}`)).toBe("");
            expect(inline(`color:${"a".repeat(6000)}`)).toBe("");
            expect(inline("color:")).toBe("");
            expect(inline("color")).toBe("");
            expect(inline("5:red")).toBe("");
            expect(inline("color red")).toBe("");
            expect(inline(":red")).toBe("");
            expect(inline("*zoom:1;_height:1px")).toBe("");
        });

        it("keeps strings and hashes, and refuses an identifier or string with a control character", () => {
            expect(inline("font-family:'Segoe UI (Web)',\"Open Sans\";color:#abc")).toBe("font-family:'Segoe UI (Web)','Open Sans';color:#abc");
            expect(inline("font-family:'a\\a b'")).toBe("");
        });

        it("checks url() against the image URL rules, only where an image may go", () => {
            expect(inline("background:url(cid:logo@x);background-image:url('https://x.example/a.png?b=1');list-style-image:url(data:image/png;base64,AAAA);list-style:url(cid:a)")).toBe(
                "background:url('cid:logo@x');background-image:url('https://x.example/a.png?b=1');list-style-image:url('data:image/png;base64,AAAA');list-style:url('cid:a')",
            );
            expect(inline("-webkit-background-image:url(cid:a)")).toBe("-webkit-background-image:url('cid:a')");
            expect(inline("color:url(cid:a);width:url(https://x.example/);border-image:url(cid:a);-webkit-mask-image:url(cid:a);background-attachment:fixed")).toBe("");
            expect(inline("background:url(javascript:alert(1));background:url(//x.example/);background:url(/x);background:url(data:image/svg+xml;base64,AAAA);background:url(file:///x)")).toBe("");
            expect(inline("background:url(cid:../x)")).toBe("background:url('cid:../x')");
            expect(inline(`background:url(data:image/png;base64,${"A".repeat(4000)})`, context(100000, 5000, 1000))).toBe("");
            expect(inline(`background:url(data:image/png;base64,${"A".repeat(1300)})`, context(100000, 5000, 1000))).toContain("data:image/png");
        });

        it("bounds an attribute's length", () => {
            expect(inline(`${"color:red;".repeat(3000)}`).length).toBeLessThanOrEqual(16_384 + 2000);
        });
    });

    describe("selectors and rules", () => {
        it("keeps type, class, id, attribute, combinator and pseudo selectors, renaming ids", () => {
            expect(sheet("*{color:red} html,body{color:red} a.b#c[d]>e+f~g h{color:red} a[href^='http' i]{color:red} a:hover::before,li:nth-child(2n+1),p:not(.a,#b) span,q:is(a,b){color:red}")).toBe(
                "*{color:red}html,body{color:red}a.b#m-c[d]>e+f~g h{color:red}a[href^='http' i]{color:red}a:hover::before,li:nth-child(2n+1),p:not(.a,#m-b) span,q:is(a,b){color:red}",
            );
            expect(sheet("#m-x{color:red}#x{color:red}")).toBe("#m-x{color:red}#m-x{color:red}");
            expect(sheet("a:-webkit-any(b,c){color:red}")).toBe("a:-webkit-any(b,c){color:red}");
            expect(sheet("[a|=b],[a$=b],[a*=b],[a~=b]{color:red}")).toBe("[a|=b],[a$=b],[a*=b],[a~=b]{color:red}");
            expect(prefixId("x")).toBe("m-x");
            expect(prefixId("m-x")).toBe("m-x");
        });

        it("drops a selector it cannot vouch for and keeps the others in the list", () => {
            expect(sheet("a,#1x,b{color:red}")).toBe("a,b{color:red}");
            expect(sheet("a,b c,d:nth-child(1){color:red}")).toBe("a,b c,d:nth-child(1){color:red}");
            for (const selector of [
                "a{b}",
                "%x",
                "a!b",
                "a&b",
                "#1",
                "a:evil(b)",
                "a evil(b)",
                "a:not(b",
                "a)",
                "a[b",
                "a]b",
                "a[b[c]]",
                "a(b)",
                "a:not([b=url(x)])",
                "a:nth-child(2n+1",
                "1",
                "2px",
                "5%",
                ",",
                "a:not(b,",
                "a[b,c]",
                "url(x)",
                "'x'a",
                "@x",
                "a:not(:not(:not(:not(:not(:not(:not(:not(:not(:not(b))))))))))",
            ]) {
                expect(sheet(`${selector}{color:red}`)).toBe(selector === "'x'a" ? "'x'a{color:red}" : "");
            }
            expect(sheet(`${"a,".repeat(150)}b{color:red}`).split(",")).toHaveLength(100);
            expect(sheet(`${"a".repeat(1100)}{color:red}`)).toBe("");
        });

        it("drops a rule with no declaration left and an empty or selectorless rule", () => {
            expect(sheet("a{mso-x:1;position:fixed} {color:red} b{color:red}")).toBe("b{color:red}");
            expect(sheet("a{}")).toBe("");
        });

        it("drops every at-rule but @media, and keeps @media (nested to three levels), without the excess", () => {
            expect(
                sheet(
                    "@charset 'x';@import url(x.css);@namespace x 'y';@font-face{font-family:x;src:url(x)}@keyframes k{from{color:red}}@page{margin:0}@supports (display:grid){a{color:red}}@container (min-width:1px){a{color:red}}@x;@media print{a{color:red}}",
                ),
            ).toBe("@media print{a{color:red}}");
            expect(sheet("@media screen{@media (min-width:1px){@media (max-width:5px){@media (min-width:9px){a{color:red}}}}}")).toBe("");
            expect(sheet("@media screen{@media (min-width:1px){@media (max-width:5px){a{color:red}}}}")).toBe("@media screen{@media (min-width:1px){@media (max-width:5px){a{color:red}}}}");
            expect(sheet("@media screen{@import 'x';@font-face{src:url(x)}}")).toBe("");
            expect(sheet("@media screen{}@media print{b{color:red}}")).toBe("@media print{b{color:red}}");
        });

        it("keeps a media query only when it is made of media types, features, and/not/only and commas", () => {
            expect(sanitizeMediaCondition("only screen and (min-width: 600px), print and (orientation:landscape)")).toBe("only screen and (min-width: 600px),print and (orientation:landscape)");
            expect(sanitizeMediaCondition("(min-aspect-ratio: 16/9) and (min-resolution: 2dppx) and (min-width: 50%)")).toBe("(min-aspect-ratio: 16/9) and (min-resolution: 2dppx) and (min-width: 50%)");
            expect(sanitizeMediaCondition("  ")).toBe("all");
            expect(sanitizeMediaCondition("all")).toBe("all");
            for (const query of ["screen and (min-width:calc(1px))", "screen{}", "url(x)", "'x'", "(min-width:1px", "screen)", "(width<=600px)", "screen;", "@x", "screen, #a", "screen\\", `${"(".repeat(9)}${")".repeat(9)}`, "x".repeat(600)]) {
                expect(sanitizeMediaCondition(query)).toBeUndefined();
            }
            expect(sheet("@media (prefers-color-scheme: dark){a{color:#fff}}")).toBe("@media (prefers-color-scheme: dark){a{color:#fff}}");
            expect(sheet("@media screen and (width<=600px){a{color:red}}")).toBe("");
        });

        it("tolerates the syntax errors real mail is full of", () => {
            expect(sheet("<!-- a{color:red} --> b{color:blue}")).toBe("a{color:red}b{color:blue}");
            expect(sheet("a{color:red;;;} }} b{color:blue} {")).toBe("a{color:red}b{color:blue}");
            expect(sheet("a{color:red")).toBe("a{color:red}");
            expect(sheet("a{color:red} b")).toBe("a{color:red}");
            expect(sheet("a{background:url(x y);color:red}")).toBe("a{color:red}");
            expect(sheet("a{color:red}/* unterminated")).toBe("a{color:red}");
            expect(sheet("a { b: c { d: e } color: red }")).toBe("");
            expect(sheet("a[title=\"}\"] {color:red} b{color:blue}")).toBe("a[title='}']{color:red}b{color:blue}");
            expect(sheet("a:not([b='{']){color:red}")).toBe("a:not([b='{']){color:red}");
            expect(sheet("a{width:calc(1px + {)};color:red}b{color:blue}")).toBe("");
            expect(sheet("(x{y}) a{color:red}")).toBe("");
            expect(sheet("a{color:red} } b{color:blue}")).toBe("a{color:red}b{color:blue}");
        });

        it("never writes a < (which could close the <style> element)", () => {
            expect(sheet(`a[title="</style><script>alert(1)</script>"]{color:red}`)).toBe(`a[title='\\3c /style>\\3c script>alert(1)\\3c /script>']{color:red}`);
            expect(sheet(`.a\\<b{color:red}`)).toBe(`.a\\3c b{color:red}`);
            expect(sheet(`a{font-family:'</style>'}`)).not.toContain("<");
            expect(sheet(`a{background:url('https://x.example/</style>')}`)).not.toContain("<");
        });
    });

    describe("limits", () => {
        it("stops at the rule count and the byte count", () => {
            const rules = Array.from({ length: 50 }, (_, i) => `.c${i}{color:red}`).join("");
            expect(sheet(rules, context(100_000, 5)).match(/\.c\d+/g)).toHaveLength(5);
            expect(sheet(rules, context(100)).length).toBeLessThanOrEqual(100);
            expect(sheet("a{color:red}", context(100, 0))).toBe("");
            expect(sheet("a{color:red}", context(0, 100))).toBe("");
        });

        it("counts what a stylesheet writes against the same budget as the next", () => {
            const ctx = context(30, 100);
            expect(sheet("a{color:red}b{color:red}", ctx)).toBe("a{color:red}b{color:red}");
            expect(ctx.bytesLeft).toBeLessThan(10);
            expect(sheet("c{color:red}", ctx)).toBe("");
        });

        it("counts a media block's own bytes, and drops one that no longer fits", () => {
            const ctx = context(60, 100);
            expect(sheet("@media screen{a{color:red}}", ctx)).toBe("@media screen{a{color:red}}");
            expect(ctx.bytesLeft).toBeLessThan(60 - 12);
        });

        it("does not even read the CSS beyond what the budget could keep", () => {
            const started = performance.now();
            expect(sheet("a{color:red}".repeat(1_000_000), context(1000)).length).toBeLessThanOrEqual(1000);
            expect(performance.now() - started).toBeLessThan(1000);
        });
    });
});
