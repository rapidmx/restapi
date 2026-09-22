///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// An independent check that sanitized mail HTML is inert: it re-parses the output (with htmlparser2's DOM, not the sanitizer's own
// event handler) and lists everything in it that could execute, navigate, submit, overlay or load. Its element and attribute lists are
// written out here on purpose - they are the specification the sanitizer is held to, not something imported from it.
import { parseDocument } from "htmlparser2";

const ELEMENTS: Set<string> = new Set(
    (
        "html head body meta style div span p br hr h1 h2 h3 h4 h5 h6 blockquote pre code ul ol li dl dt dd table thead tbody tfoot tr th td caption " +
        "colgroup col a b strong i em u s strike del ins sub sup small big font center abbr cite q mark tt kbd samp var dfn time bdi bdo nobr wbr " +
        "address figure figcaption section article header footer nav main aside menu img"
    ).split(" "),
);

const ATTRIBUTES: Set<string> = new Set(
    (
        "style class id dir lang title alt abbr role aria-hidden aria-label hidden nowrap align valign bgcolor color bordercolor text link alink vlink " +
        "face size width height border cellpadding cellspacing hspace vspace leftmargin topmargin marginwidth marginheight colspan rowspan span " +
        "start scope type background href src target rel name content"
    ).split(" "),
);

const LINK: RegExp = /^(?:https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]*|tel:[^\s"'<>]*)$/i;
const IMAGE: RegExp = /^(?:cid:[A-Za-z0-9._~@+=!$*/-]{1,256}|data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]*={0,2}|https?:\/\/[^\s"'<>]+)$/i;
const CSS_HAZARD: RegExp = /javascript:|vbscript:|expression\s*\(|@import|@font-face|behavior|-moz-binding|progid|position\s*:\s*(?:fixed|absolute|sticky)|z-index|<|\bcontent\s*:|image-set|cursor\s*:|(?:^|[^-\w])var\(/i;
const CSS_URL: RegExp = /url\(\s*'([^']*)'\s*\)/gi;

function cssViolations(css: string, where: string): string[] {
    const found: string[] = [];
    if (CSS_HAZARD.test(css)) {
        found.push(`${where}: hazardous CSS: ${css.slice(0, 120)}`);
    }
    const withoutUrls: string = css.replace(CSS_URL, (_m: string, url: string) => {
        if (!IMAGE.test(url)) {
            found.push(`${where}: url() is not an allowed image: ${url.slice(0, 80)}`);
        }
        return "";
    });
    if (/url\s*\(/i.test(withoutUrls)) {
        found.push(`${where}: url() not in the canonical form: ${css.slice(0, 120)}`);
    }
    return found;
}

/** Everything in `html` that could run, navigate, submit, overlay or load something it should not - empty for inert HTML. */
export function inertViolations(html: string): string[] {
    const found: string[] = [];
    const walk = (nodes: any[]): void => {
        for (const node of nodes) {
            if (node.type === "comment" || node.type === "directive" || node.type === "cdata") {
                if (!(node.type === "directive" && /^!doctype html$/i.test(node.data))) {
                    found.push(`${node.type} node: ${String(node.data).slice(0, 60)}`);
                }
            } else if (node.type === "script") {
                found.push("script element");
            } else if (node.type === "tag" || node.type === "style") {
                const name: string = node.name;
                if (!ELEMENTS.has(name)) {
                    found.push(`element <${name}>`);
                }
                for (const [attribute, value] of Object.entries<string>(node.attribs)) {
                    const where: string = `<${name} ${attribute}>`;
                    if (!ATTRIBUTES.has(attribute) || attribute.startsWith("on")) {
                        found.push(`attribute ${where}`);
                    } else if (attribute === "href" && !LINK.test(value)) {
                        found.push(`${where} = ${value.slice(0, 80)}`);
                    } else if ((attribute === "src" || attribute === "background") && !IMAGE.test(value)) {
                        found.push(`${where} = ${value.slice(0, 80)}`);
                    } else if (attribute === "style") {
                        found.push(...cssViolations(value, where));
                    } else if (attribute === "id" && !value.startsWith("m-")) {
                        found.push(`${where} = ${value} is not prefixed`);
                    } else if (attribute === "target" && (name !== "a" || value !== "_blank")) {
                        found.push(`${where} = ${value}`);
                    } else if (attribute === "rel" && (name !== "a" || value !== "noopener noreferrer nofollow")) {
                        found.push(`${where} = ${value}`);
                    } else if (attribute === "name" && !(name === "meta" && value === "color-scheme")) {
                        found.push(`${where} = ${value}`);
                    }
                }
                if (name === "meta" && !(node.attribs.name === "color-scheme" && /^(?:normal|light|dark|only| )+$/.test(node.attribs.content ?? ""))) {
                    found.push("meta other than color-scheme");
                }
                if (name === "style") {
                    found.push(...cssViolations(node.children.map((child: any) => child.data).join(""), "<style>"));
                }
                if (name !== "style") {
                    walk(node.children ?? []);
                }
            }
        }
    };
    walk(parseDocument(html).children);
    if (/<\/?(?:script|iframe|object|embed|svg|math|form|input|link|base|template|noscript|frameset|frame|applet|textarea|select|video|audio|title)\b/i.test(html)) {
        found.push("a blocked element is in the raw text");
    }
    if (/\son[a-z]+\s*=/i.test(html.replace(/<style>[\s\S]*?<\/style>/g, ""))) {
        found.push("an on* attribute is in the raw text");
    }
    return found;
}
