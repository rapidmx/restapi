///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { Parser } from "htmlparser2";

/**
 * The plain-text preview of an HTML body: what a reader would see in its first lines, as text. Used for `Message.bodyPreview` and
 * the mail filter rules that match on it when a message has no plain-text part.
 *
 * Text that is not part of what the reader sees is left out - `<style>` and `<script>` contents, the `<head>`, and the hidden
 * "preheader" many newsletters open with (an element that is `display:none`, `visibility:hidden`, `mso-hide:all`, `opacity:0`,
 * `font-size:0`, or zero-sized with `overflow:hidden`, plus the zero-width padding characters that fill out the inbox snippet) - so a
 * preview starts with the message, not with its stylesheet. It stops reading as soon as it has enough text, which makes it cheap for the
 * multi-hundred-kilobyte bodies a preview is the least of.
 *
 * @author Jean-Philippe Steinmetz
 */

/** Elements whose contents are never text of the message. */
const SKIPPED: Set<string> = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "math", "iframe", "object", "embed", "select", "textarea", "audio", "video", "canvas", "xml"]);

/** Elements that start and end a line. */
const BLOCKS: Set<string> = new Set([
    "p",
    "div",
    "br",
    "hr",
    "li",
    "ul",
    "ol",
    "dl",
    "dt",
    "dd",
    "tr",
    "table",
    "caption",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "pre",
    "section",
    "article",
    "header",
    "footer",
    "nav",
    "aside",
    "main",
    "address",
    "figure",
    "figcaption",
    "center",
    "form",
]);

const ZERO: RegExp = /^0(?:\.0+)?(?:px|pt|em|rem|%)?$/;
const INVISIBLE: RegExp = /[­͏​-‏⁠﻿]/g;

/** Whether an element with these attributes takes no room, or none that can be seen: a preheader, a tracking wrapper. */
function isHidden(attribs: Record<string, string>): boolean {
    if ("hidden" in attribs) {
        return true;
    }
    if (!attribs.style) {
        return false;
    }
    const properties: Map<string, string> = new Map();
    for (const declaration of attribs.style.toLowerCase().replace(/\/\*[\s\S]*?\*\//g, "").split(";")) {
        const colon: number = declaration.indexOf(":");
        if (colon > 0) {
            properties.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).replace(/!important/g, "").replace(/\s+/g, ""));
        }
    }
    const zero = (property: string): boolean => ZERO.test(properties.get(property) ?? "-");
    const clipped: boolean = properties.get("overflow") === "hidden";
    return (
        properties.get("display") === "none" ||
        properties.get("visibility") === "hidden" ||
        properties.get("mso-hide") === "all" ||
        zero("opacity") ||
        zero("font-size") ||
        (clipped && (zero("max-height") || zero("height") || zero("max-width") || zero("width")))
    );
}

/**
 * The first `limit` characters of the text of `html`, block elements as lines and table cells as words, whitespace collapsed. Never
 * throws; a body with no text gives `""`.
 */
export function htmlPreview(html: string, limit: number): string {
    let out: string = "";
    let skipping: number = 0;
    let done: boolean = false;
    const newline = (): void => {
        out = out.replace(/[ ]+$/, "");
        if (out !== "" && !out.endsWith("\n")) {
            out += "\n";
        }
    };
    const space = (): void => {
        if (out !== "" && !/\s$/.test(out)) {
            out += " ";
        }
    };
    const parser: Parser = new Parser(
        {
            onopentag: (name: string, attribs: Record<string, string>) => {
                if (skipping > 0 || SKIPPED.has(name) || isHidden(attribs)) {
                    skipping++;
                } else if (BLOCKS.has(name)) {
                    newline();
                } else if (name === "td" || name === "th") {
                    space();
                }
            },
            onclosetag: (name: string) => {
                // An element's own opening decided whether it counted, and hidden ones counted too, so pair them off by depth: `skipping`
                // is decremented for every close while it is positive, which is exact because closes match opens in order.
                if (skipping > 0) {
                    skipping--;
                } else if (BLOCKS.has(name)) {
                    newline();
                }
            },
            ontext: (data: string) => {
                if (skipping > 0 || done) {
                    return;
                }
                const text: string = data.replace(INVISIBLE, "").replace(/\s+/g, " ");
                out += out === "" || /\s$/.test(out) ? text.replace(/^ /, "") : text;
                done = out.length >= limit + 64;
            },
        },
        { decodeEntities: true, lowerCaseTags: true },
    );
    for (let start = 0; start < html.length && !done; start += 16_384) {
        parser.write(html.slice(start, start + 16_384));
    }
    parser.end();
    return out
        .replace(/[ \t]*\n[ \t]*/g, "\n")
        .trim()
        .slice(0, limit);
}
