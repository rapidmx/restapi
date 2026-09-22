///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `GET /messages/:id/content` serving a message's sanitized HTML over a real HTTP server, identical on both backends: inline
// (`cid:`) images pointed at the message's attachments, the two image modes, and a message stored by an older sanitizer brought up
// to date on its first read. `test/routes/{mongo,sql}/MessageSanitizedContent.test.ts` supply the server. Who may read a message is
// not asserted here (see the access suites); only that it still answers 404 to what does not exist.
import { request } from "@rapidrest/service-core/test";
import { FolderType } from "../../src/models/types.js";
import { readSanitizerVersion, SANITIZER_VERSION, sanitizeMailHtml, stampSanitizedHtml } from "../../src/scan/HtmlSanitizer.js";
import type { InMemoryBlobStore } from "../testDoubles.js";

export interface SanitizedContentSuiteContext {
    app: () => any;
    baseUrl: string;
    ownerToken: string;
    ownerUid: string;
    blobStore: () => InMemoryBlobStore;
    createMailbox: (ownerUid: string) => Promise<any>;
    createFolder: (mailboxUid: string, type: FolderType) => Promise<any>;
    createMessage: (mailboxUid: string, folderUid: string, data?: any) => Promise<any>;
    createAttachment: (message: any, data: { contentId?: string; filename?: string; mimeType?: string }) => Promise<any>;
}

/** A raw message: an HTML body with a newsletter's design and a related inline PNG. */
const RAW_MIME = [
    "From: Sender <sender@example.com>",
    "To: Recipient <recipient@example.com>",
    "Subject: Autumn sale",
    "MIME-Version: 1.0",
    'Content-Type: multipart/related; boundary="REL"',
    "",
    "--REL",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<html><head><style>.hero{background-color:#003366;color:#fff}@media (prefers-color-scheme: dark){.hero{background-color:#001122}}</style></head><body bgcolor="#f4f4f4"><table width="600" bgcolor="#ffffff"><tr><td class="hero" style="font-family:Arial;font-size:18px"><img src="cid:logo@example.com" alt="Logo" width="40"> Sale <script>alert(1)</script></td></tr></table></body></html>',
    "",
    "--REL",
    'Content-Type: image/png; name="logo.png"',
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: inline",
    "Content-ID: <logo@example.com>",
    "",
    Buffer.from("fake png bytes").toString("base64"),
    "",
    "--REL--",
    "",
].join("\r\n");

export function sanitizedContentSuite(ctx: SanitizedContentSuiteContext): void {
    const get = (uid: string, options: { query?: string; headers?: Record<string, string> } = {}) => {
        let chain = request(ctx.app()).get(`${ctx.baseUrl}/${uid}/content${options.query ?? ""}`).set("Authorization", "jwt " + ctx.ownerToken);
        for (const [name, value] of Object.entries(options.headers ?? {})) {
            chain = chain.set(name, value);
        }
        return chain;
    };
    let mailbox: any;
    let inbox: any;

    beforeEach(async () => {
        mailbox = await ctx.createMailbox(ctx.ownerUid);
        inbox = await ctx.createFolder(mailbox.uid, FolderType.INBOX);
    });

    /** A message whose sanitized blob was written by the current sanitizer and refers to `logo@example.com` and a missing part. */
    const currentMessage = async (): Promise<any> => {
        const key = `sanitized/${Math.random().toString(16).slice(2)}`;
        await ctx.blobStore().put(key, Buffer.from(stampSanitizedHtml(sanitizeMailHtml(`<p>Hi</p><img src="cid:logo@example.com" alt="Logo"><img src="cid:gone@example.com" alt="Gone"><div style="background:url(cid:logo@example.com)">x</div>`))));
        return await ctx.createMessage(mailbox.uid, inbox.uid, { sanitizedHtmlBlobKey: key });
    };

    describe("inline images", () => {
        it("points each cid: image at the message's attachment and drops the src of one that has no attachment, keeping its alt", async () => {
            const message = await currentMessage();
            const logo = await ctx.createAttachment(message, { contentId: "<logo@example.com>", filename: "logo.png", mimeType: "image/png" });

            const result = await get(message.uid);

            expect(result.status).toBe(200);
            expect(result.headers["content-type"]).toContain("text/html");
            expect(result.headers["x-content-type-options"]).toBe("nosniff");
            expect(result.headers["content-security-policy"]).toContain("img-src data: 'self'");
            expect(result.text).toContain(`<img src="/api/mail/attachments/${logo.uid}/content" alt="Logo">`);
            expect(result.text).toContain(`<img alt="Gone">`);
            expect(result.text).toContain(`background:url('/api/mail/attachments/${logo.uid}/content')`);
            expect(result.text).not.toContain("cid:");
            expect(result.text).not.toContain("rapidmx-sanitized");
        });

        it("matches a Content-ID without its angle brackets and regardless of case", async () => {
            const message = await currentMessage();
            const logo = await ctx.createAttachment(message, { contentId: "LOGO@Example.com" });

            const result = await get(message.uid);

            expect(result.text).toContain(`<img src="/api/mail/attachments/${logo.uid}/content" alt="Logo">`);
        });

        it("leaves known references as cid: for `?cid=keep`, and for a fetch() that says so (Sec-Fetch-Dest: empty)", async () => {
            const message = await currentMessage();
            await ctx.createAttachment(message, { contentId: "logo@example.com" });

            for (const options of [{ query: "?cid=keep" }, { headers: { "Sec-Fetch-Dest": "empty" } }]) {
                const result = await get(message.uid, options);

                expect(result.status).toBe(200);
                expect(result.text).toContain(`<img src="cid:logo@example.com" alt="Logo">`);
                expect(result.text).toContain(`<img alt="Gone">`);
            }
        });

        it("points at the attachments for a browser navigation (Sec-Fetch-Dest: document) and for `?cid=attachment` even from a fetch()", async () => {
            const message = await currentMessage();
            const logo = await ctx.createAttachment(message, { contentId: "logo@example.com" });

            for (const options of [{ headers: { "Sec-Fetch-Dest": "document" } }, { query: "?cid=attachment", headers: { "Sec-Fetch-Dest": "empty" } }]) {
                expect((await get(message.uid, options)).text).toContain(`src="/api/mail/attachments/${logo.uid}/content"`);
            }
        });

        it("serves a message without inline images without looking for attachments", async () => {
            const key = `sanitized/${Math.random().toString(16).slice(2)}`;
            await ctx.blobStore().put(key, Buffer.from(stampSanitizedHtml(sanitizeMailHtml("<p>No images</p>"))));
            const message = await ctx.createMessage(mailbox.uid, inbox.uid, { sanitizedHtmlBlobKey: key });

            const result = await get(message.uid);

            expect(result.status).toBe(200);
            expect(result.text).toContain("<p>No images</p>");
        });
    });

    describe("a message stored by an older sanitizer", () => {
        const oldMessage = async (data: any = {}): Promise<{ message: any; key: string }> => {
            const id = Math.random().toString(16).slice(2);
            const key = `sanitized/${id}`;
            await ctx.blobStore().put(`bodies/${id}`, Buffer.from(RAW_MIME));
            // What the old sanitizer stored: the message with its styling and image stripped, and no version stamp.
            await ctx.blobStore().put(key, Buffer.from("<table><tr><td>Sale</td></tr></table>"));
            return { message: await ctx.createMessage(mailbox.uid, inbox.uid, { sanitizedHtmlBlobKey: key, bodyBlobKey: `bodies/${id}`, ...data }), key };
        };

        it("is sanitized again from its raw MIME on the first read, and the design comes back", async () => {
            const { message, key } = await oldMessage();
            const logo = await ctx.createAttachment(message, { contentId: "<logo@example.com>" });

            const result = await get(message.uid);

            expect(result.status).toBe(200);
            expect(result.text).toContain('<body bgcolor="#f4f4f4">');
            expect(result.text).toContain("<style>.hero{background-color:#003366;color:#fff}@media (prefers-color-scheme: dark){.hero{background-color:#001122}}</style>");
            expect(result.text).toContain('<table width="600" bgcolor="#ffffff">');
            expect(result.text).toContain('<td class="hero" style="font-family:Arial;font-size:18px">');
            expect(result.text).toContain(`<img src="/api/mail/attachments/${logo.uid}/content" alt="Logo" width="40">`);
            expect(result.text).not.toContain("<script");

            const stored = (await ctx.blobStore().get(key)).toString();
            expect(readSanitizerVersion(stored)).toBe(SANITIZER_VERSION);
            expect(stored).toContain('<img src="cid:logo@example.com" alt="Logo" width="40">');
        });

        it("costs one re-sanitization, not one per read: the blob is current afterwards", async () => {
            const { message, key } = await oldMessage();
            await get(message.uid);
            const once = (await ctx.blobStore().get(key)).toString();
            const raw = ctx.blobStore();
            const spy = vi.spyOn(raw, "get");

            const second = await get(message.uid);

            expect(second.status).toBe(200);
            expect(second.text).toContain("<style>.hero");
            expect((await ctx.blobStore().get(key)).toString()).toBe(once);
            expect(spy.mock.calls.map((call) => call[0])).not.toContain(message.bodyBlobKey);
        });

        it("serves a message whose stamp is older than the current version the same way", async () => {
            const { message, key } = await oldMessage();
            await ctx.blobStore().put(key, Buffer.from("<!--rapidmx-sanitized:1--><table><tr><td>Sale</td></tr></table>"));

            const result = await get(message.uid);

            expect(result.text).toContain("<style>.hero");
            expect(readSanitizerVersion((await ctx.blobStore().get(key)).toString())).toBe(SANITIZER_VERSION);
        });

        it("serves the HTML it has when the raw message is gone, and does not fail the request", async () => {
            const { message, key } = await oldMessage();
            await ctx.blobStore().delete(message.bodyBlobKey);

            const result = await get(message.uid);

            expect(result.status).toBe(200);
            expect(result.text).toBe("<table><tr><td>Sale</td></tr></table>");
            expect((await ctx.blobStore().get(key)).toString()).toBe("<table><tr><td>Sale</td></tr></table>");
        });
    });

    describe("what is unchanged", () => {
        it("falls back to the plain-text preview for a message with no sanitized HTML", async () => {
            const message = await ctx.createMessage(mailbox.uid, inbox.uid, { bodyPreview: "Just plain text" });

            const result = await get(message.uid);

            expect(result.status).toBe(200);
            expect(result.headers["content-type"]).toContain("text/plain");
            expect(result.text).toBe("Just plain text");
        });

        it("answers 404 for a message that does not exist", async () => {
            expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(404);
        });
    });
}
