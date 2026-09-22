///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// HTML mail through `ScanQueueJob` - identical on both backends: what is stored as the sanitized body keeps the message's design and
// its inline images, and nothing that runs. `test/jobs/{mongo,sql}/ScanQueueJob*.test.ts` supply the real job over a real datastore,
// with a real `ScanPipeline` (real MIME parsing and sanitizing) over always-clean spam/AV providers.
import { readSanitizerVersion, SANITIZER_VERSION } from "../../src/scan/HtmlSanitizer.js";
import { inertViolations } from "../scan/fixtures/inert.js";
import { DESIGN_CORPUS } from "../scan/fixtures/mailCorpus.js";

export interface HtmlMailSuiteContext {
    blobStore: () => any;
    /** Stores `raw`, queues it for the test mailbox and runs the job once. */
    ingest: (raw: Buffer) => Promise<void>;
    /** Every message in the mailbox's Inbox. */
    inbox: () => Promise<any[]>;
    attachmentsOf: (messageUid: string) => Promise<any[]>;
}

const message = (parts: string[]): Buffer => Buffer.from(["From: Shop <news@shop.example.com>", "To: Recipient <recipient@example.com>", "Subject: Autumn sale", "MIME-Version: 1.0", ...parts].join("\r\n"));

const NEWSLETTER_HTML =
    '<!DOCTYPE html><html><head><title>Autumn sale</title><meta name="color-scheme" content="light dark"><style>#header{background-color:#003366;color:#ffffff}.btn{background:#ff6600;border-radius:4px}@media (max-width:480px){.col{display:block!important}}@media (prefers-color-scheme: dark){body{background:#111!important}}@import url(https://evil.example/x.css);</style></head>' +
    '<body bgcolor="#f4f4f4" onload="alert(1)"><div style="display:none;max-height:0;overflow:hidden">Hidden preheader text</div>' +
    '<table width="600" align="center" bgcolor="#ffffff" cellpadding="0"><tr><td id="header" style="font-family:Georgia,serif;font-size:20px"><img src="cid:logo@shop.example.com" alt="Shop" width="120"><img src="https://track.example.com/open.gif" width="1" height="1" alt=""></td></tr>' +
    '<tr><td class="col btn"><a href="https://shop.example.com/sale?a=1&amp;b=2" onclick="steal()">Everything must go</a> <a href="javascript:alert(1)">bad</a></td></tr></table>' +
    "<!--[if mso]><table><tr><td>OUTLOOK ONLY</td></tr></table><![endif]--><script>alert(1)</script></body></html>";

export function htmlMailSuite(ctx: HtmlMailSuiteContext): void {
    describe("HTML mail keeps its design when it is stored", () => {
        it("stores a newsletter's colours, fonts, layout, styles and inline image reference, and nothing that runs or leaks", async () => {
            await ctx.ingest(
                message([
                    'Content-Type: multipart/related; boundary="REL"',
                    "",
                    "--REL",
                    "Content-Type: text/html; charset=utf-8",
                    "",
                    NEWSLETTER_HTML,
                    "",
                    "--REL",
                    'Content-Type: image/png; name="logo.png"',
                    "Content-Transfer-Encoding: base64",
                    "Content-Disposition: inline",
                    "Content-ID: <logo@shop.example.com>",
                    "",
                    Buffer.from("fake png bytes").toString("base64"),
                    "",
                    "--REL--",
                    "",
                ]),
            );

            const [stored] = await ctx.inbox();
            expect(stored.sanitizedHtmlBlobKey).toBeTruthy();
            const html: string = (await ctx.blobStore().get(stored.sanitizedHtmlBlobKey)).toString();
            expect(readSanitizerVersion(html)).toBe(SANITIZER_VERSION);
            expect(html).toContain('<meta name="color-scheme" content="light dark">');
            expect(html).toContain("#m-header{background-color:#003366;color:#ffffff}");
            expect(html).toContain(".btn{background:#ff6600;border-radius:4px}");
            expect(html).toContain("@media (max-width:480px){.col{display:block!important}}");
            expect(html).toContain("@media (prefers-color-scheme: dark){body{background:#111!important}}");
            expect(html).toContain('<body bgcolor="#f4f4f4">');
            expect(html).toContain('<table width="600" align="center" bgcolor="#ffffff" cellpadding="0">');
            expect(html).toContain('<td id="m-header" style="font-family:Georgia,serif;font-size:20px">');
            expect(html).toContain('<img src="cid:logo@shop.example.com" alt="Shop" width="120">');
            expect(html).toContain('<img src="https://track.example.com/open.gif" width="1" height="1" alt="">');
            expect(html).toContain('href="https://shop.example.com/sale?a=1&amp;b=2" target="_blank" rel="noopener noreferrer nofollow">Everything must go</a>');
            expect(html).not.toMatch(/@import|<script|onclick|onload|javascript:|OUTLOOK ONLY|<title/);
            expect(inertViolations(html.replace(/^<!--[^>]*-->/, ""))).toEqual([]);

            // The inline image is an attachment of the message, found by the reference's token; the preview is the message's text.
            const attachments = await ctx.attachmentsOf(stored.uid);
            expect(attachments).toHaveLength(1);
            expect(attachments[0].contentId).toBe("logo@shop.example.com");
            expect(attachments[0].isInline).toBe(true);
            expect(stored.bodyPreview).toBe("Everything must go bad");
        });

        it("stores each realistic message of the corpus with its design and inertly", async () => {
            for (const fixture of DESIGN_CORPUS) {
                await ctx.ingest(message(["Content-Type: text/html; charset=utf-8", "", fixture.html, ""]));
            }

            const stored = await ctx.inbox();
            expect(stored).toHaveLength(DESIGN_CORPUS.length);
            for (const item of stored) {
                const html: string = (await ctx.blobStore().get(item.sanitizedHtmlBlobKey)).toString();
                expect(readSanitizerVersion(html)).toBe(SANITIZER_VERSION);
                expect(inertViolations(html.replace(/^<!--[^>]*-->/, ""))).toEqual([]);
            }
        });

        it("keeps a preview of the text of an HTML-only message without its stylesheet or hidden preheader", async () => {
            await ctx.ingest(message(["Content-Type: text/html; charset=utf-8", "", NEWSLETTER_HTML, ""]));

            const [stored] = await ctx.inbox();
            expect(stored.bodyPreview).toBe("Everything must go bad");
            expect(stored.bodyPreview).not.toContain("Hidden preheader");
            expect(stored.bodyPreview).not.toContain("background");
        });

        it("previews the plain-text part when there is one, as before", async () => {
            await ctx.ingest(
                message([
                    'Content-Type: multipart/alternative; boundary="ALT"',
                    "",
                    "--ALT",
                    "Content-Type: text/plain; charset=utf-8",
                    "",
                    "The plain text part.",
                    "",
                    "--ALT",
                    "Content-Type: text/html; charset=utf-8",
                    "",
                    "<p style=\"color:red\">The <b>HTML</b> part.</p>",
                    "",
                    "--ALT--",
                    "",
                ]),
            );

            const [stored] = await ctx.inbox();
            expect(stored.bodyPreview).toBe("The plain text part.");
            expect((await ctx.blobStore().get(stored.sanitizedHtmlBlobKey)).toString()).toContain('<p style="color:red">The <b>HTML</b> part.</p>');
        });
    });
}
