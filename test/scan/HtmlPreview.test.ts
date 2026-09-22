///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { htmlPreview } from "../../src/scan/HtmlPreview.js";

describe("htmlPreview()", () => {
    it("is the text of the message: blocks as lines, cells as words, whitespace collapsed", () => {
        expect(htmlPreview("<p>Hello   <b>brave</b>\n new world</p><p>Second</p>", 500)).toBe("Hello brave new world\nSecond");
        expect(htmlPreview("<table><tr><td>a</td><td>b</td></tr><tr><th>c</th><td>d</td></tr></table>", 500)).toBe("a b\nc d");
        expect(htmlPreview("one<br>two<hr>three<ul><li>x</li><li>y</li></ul>", 500)).toBe("one\ntwo\nthree\nx\ny");
        expect(htmlPreview("a &amp; b &lt;c&gt; &nbsp;d", 500)).toBe("a & b <c> d");
        expect(htmlPreview("plain text, no markup", 500)).toBe("plain text, no markup");
        expect(htmlPreview("", 500)).toBe("");
        expect(htmlPreview("<div></div>", 500)).toBe("");
    });

    it("leaves out the stylesheet, the head, scripts and other text that is not the message's", () => {
        expect(htmlPreview("<html><head><title>Title</title><style>p{color:red}</style></head><body><style>b{color:blue}</style><script>alert(1)</script><p>Visible</p><noscript>Enable JS</noscript><svg><text>icon</text></svg></body></html>", 500)).toBe("Visible");
    });

    it("leaves out a hidden preheader and the zero-width padding that fills the inbox snippet", () => {
        const preheader = (style: string): string => `<div style="${style}">Preheader text</div><p>Real message</p>`;
        for (const style of [
            "display:none",
            "DISPLAY : NONE !important",
            "visibility:hidden",
            "mso-hide:all",
            "opacity:0",
            "font-size:0",
            "font-size:0px",
            "max-height:0;overflow:hidden",
            "height:0px;overflow:hidden",
            "max-width:0;overflow:hidden",
            "width:0;overflow:hidden",
            "color:red; /* hidden */ display:none",
        ]) {
            expect(htmlPreview(preheader(style), 500)).toBe("Real message");
        }
        expect(htmlPreview(`<span hidden>Hidden</span>Shown`, 500)).toBe("Shown");
        expect(htmlPreview(`<div style="display:none"><p>a<b>b</b><img src="x"></p></div><p>Real</p>`, 500)).toBe("Real");
        expect(htmlPreview("<p>&zwnj;&nbsp;&zwnj;&nbsp;​͏­﻿Real</p>", 500)).toBe("Real");
    });

    it("keeps an element that only looks small", () => {
        for (const style of ["max-height:0", "height:0", "font-size:12px", "opacity:0.5", "display:block", "overflow:hidden", "color:red", "font-size:0.5em", "height:100px;overflow:hidden", "nonsense"]) {
            expect(htmlPreview(`<div style="${style}">Kept</div>`, 500)).toBe("Kept");
        }
    });

    it("stops at the limit, and stops reading soon after it", () => {
        expect(htmlPreview(`<p>${"word ".repeat(400)}</p>`, 500)).toHaveLength(500);
        expect(htmlPreview("<p>abcdefghij</p>", 4)).toBe("abcd");
        const started = performance.now();
        const preview = htmlPreview(`<p>${"x".repeat(1000)}</p>${"<div><p>more</p></div>".repeat(200_000)}`, 500);
        expect(preview).toHaveLength(500);
        expect(performance.now() - started).toBeLessThan(2000);
    });

    it("copes with markup that is broken", () => {
        expect(htmlPreview("<p>unclosed <b>bold <i>italic", 500)).toBe("unclosed bold italic");
        expect(htmlPreview("</div></p>text<", 500)).toBe("text<");
        expect(htmlPreview("<div style='display:none'><p>hidden</div>after", 500)).toBe("after");
    });
});
