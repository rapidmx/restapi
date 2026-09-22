///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { readSanitizerVersion, SANITIZER_VERSION, stampSanitizedHtml } from "../../src/scan/HtmlSanitizer.js";
import { pointInlineImages, RETRY_AFTER_MS, SanitizedBodyLoader } from "../../src/scan/SanitizedBody.js";
import { InMemoryBlobStore } from "../testDoubles.js";

describe("SanitizedBodyLoader", () => {
    const OLD = "<p>old sanitizer output</p>";
    const FRESH = "<!DOCTYPE html><html><head></head><body><p>fresh</p></body></html>";
    let blobs: InMemoryBlobStore;
    let sanitizeRaw: ReturnType<typeof vi.fn>;
    let logger: { warn: ReturnType<typeof vi.fn> };
    let loader: SanitizedBodyLoader;
    const message = { uid: "msg-1", bodyBlobKey: "bodies/msg-1", sanitizedHtmlBlobKey: "sanitized/msg-1" };

    beforeEach(async () => {
        blobs = new InMemoryBlobStore();
        await blobs.put(message.bodyBlobKey, Buffer.from("From: a@b.example\r\n\r\nraw"));
        await blobs.put(message.sanitizedHtmlBlobKey, Buffer.from(OLD));
        sanitizeRaw = vi.fn(async () => stampSanitizedHtml(FRESH));
        logger = { warn: vi.fn() };
        loader = new SanitizedBodyLoader(blobs, { sanitizeRaw } as any, { maxRawBytes: 1000, timeoutMs: 2000 }, logger);
    });

    const stored = async (): Promise<string> => (await blobs.get(message.sanitizedHtmlBlobKey)).toString();

    it("serves a blob the current sanitizer wrote as it is, without its stamp and without touching the raw message", async () => {
        await blobs.put(message.sanitizedHtmlBlobKey, Buffer.from(stampSanitizedHtml(FRESH)));

        expect(await loader.load(message)).toBe(FRESH);
        expect(sanitizeRaw).not.toHaveBeenCalled();
    });

    it("serves a blob a newer sanitizer wrote", async () => {
        await blobs.put(message.sanitizedHtmlBlobKey, Buffer.from(`<!--rapidmx-sanitized:${SANITIZER_VERSION + 1}--><p>future</p>`));

        expect(await loader.load(message)).toBe("<p>future</p>");
        expect(sanitizeRaw).not.toHaveBeenCalled();
    });

    it("re-sanitizes a blob with no stamp or an older one from the raw message, once, and overwrites it", async () => {
        expect(await loader.load(message)).toBe(FRESH);
        expect(sanitizeRaw).toHaveBeenCalledTimes(1);
        expect(sanitizeRaw.mock.calls[0][0].toString()).toContain("raw");
        expect(readSanitizerVersion(await stored())).toBe(SANITIZER_VERSION);
        expect(await stored()).toBe(stampSanitizedHtml(FRESH));

        // Every later read is a plain read of the new blob.
        expect(await loader.load(message)).toBe(FRESH);
        expect(sanitizeRaw).toHaveBeenCalledTimes(1);

        await blobs.put(message.sanitizedHtmlBlobKey, Buffer.from(`<!--rapidmx-sanitized:1-->${OLD}`));
        expect(await loader.load(message)).toBe(FRESH);
        expect(sanitizeRaw).toHaveBeenCalledTimes(2);
    });

    it("shares one run between readers that ask at the same time", async () => {
        const results = await Promise.all([loader.load(message), loader.load(message), loader.load(message)]);

        expect(results).toEqual([FRESH, FRESH, FRESH]);
        expect(sanitizeRaw).toHaveBeenCalledTimes(1);
    });

    describe("never worse than before", () => {
        it("serves the stored HTML when the sanitizer fails, says so, and does not try again for a while", async () => {
            sanitizeRaw.mockRejectedValue(new Error("parse exploded"));

            expect(await loader.load(message)).toBe(OLD);
            expect(await loader.load(message)).toBe(OLD);
            expect(sanitizeRaw).toHaveBeenCalledTimes(1);
            expect(logger.warn).toHaveBeenCalledTimes(1);
            expect(logger.warn.mock.calls[0][0]).toContain("msg-1");
            expect(logger.warn.mock.calls[0][0]).toContain("parse exploded");
            expect(await stored()).toBe(OLD);

            const now = Date.now();
            vi.spyOn(Date, "now").mockReturnValue(now + RETRY_AFTER_MS + 1);
            sanitizeRaw.mockResolvedValue(stampSanitizedHtml(FRESH));
            expect(await loader.load(message)).toBe(FRESH);
            expect(sanitizeRaw).toHaveBeenCalledTimes(2);
        });

        it("works without a logger", async () => {
            loader = new SanitizedBodyLoader(blobs, { sanitizeRaw } as any, { maxRawBytes: 1000, timeoutMs: 2000 });
            sanitizeRaw.mockRejectedValue(new Error("x"));

            expect(await loader.load(message)).toBe(OLD);
        });

        it("serves the stored HTML when the raw message is missing, too large, or has no HTML any more", async () => {
            expect(await loader.load({ ...message, bodyBlobKey: undefined })).toBe(OLD);
            expect(await loader.load({ ...message, sanitizedHtmlBlobKey: "sanitized/other", bodyBlobKey: "bodies/missing" }).catch(() => "missing sanitized blob")).toBe("missing sanitized blob");

            await blobs.put("sanitized/big", Buffer.from(OLD));
            await blobs.put("bodies/big", Buffer.alloc(2000));
            expect(await loader.load({ uid: "big", bodyBlobKey: "bodies/big", sanitizedHtmlBlobKey: "sanitized/big" })).toBe(OLD);

            await blobs.put("sanitized/none", Buffer.from(OLD));
            sanitizeRaw.mockResolvedValue(undefined);
            expect(await loader.load({ uid: "none", bodyBlobKey: message.bodyBlobKey, sanitizedHtmlBlobKey: "sanitized/none" })).toBe(OLD);
            expect(sanitizeRaw).toHaveBeenCalledTimes(1);
        });

        it("does not bring back a blob that was erased while it worked", async () => {
            sanitizeRaw.mockImplementation(async () => {
                await blobs.delete(message.sanitizedHtmlBlobKey);
                return stampSanitizedHtml(FRESH);
            });

            expect(await loader.load(message)).toBe(OLD);
            expect(await blobs.exists(message.sanitizedHtmlBlobKey)).toBe(false);
        });

        it("answers with the stored HTML when the re-sanitization takes too long, and lets it finish for the next reader", async () => {
            loader = new SanitizedBodyLoader(blobs, { sanitizeRaw } as any, { maxRawBytes: 1000, timeoutMs: 10 }, logger);
            sanitizeRaw.mockImplementation(async () => {
                await new Promise((resolve) => setTimeout(resolve, 80));
                return stampSanitizedHtml(FRESH);
            });

            expect(await loader.load(message)).toBe(OLD);
            await vi.waitFor(async () => expect(await stored()).toBe(stampSanitizedHtml(FRESH)), { timeout: 2000 });
            expect(await loader.load(message)).toBe(FRESH);
        });

        it("remembers only so many failures", async () => {
            for (let i = 0; i < 2100; i++) {
                await blobs.put(`sanitized/${i}`, Buffer.from(OLD));
                expect(await loader.load({ uid: `m${i}`, sanitizedHtmlBlobKey: `sanitized/${i}` })).toBe(OLD);
            }
            // The oldest were forgotten, so the first is tried again.
            sanitizeRaw.mockResolvedValue(stampSanitizedHtml(FRESH));
            expect(await loader.load({ uid: "m0", bodyBlobKey: message.bodyBlobKey, sanitizedHtmlBlobKey: "sanitized/0" })).toBe(FRESH);
        });
    });
});

describe("pointInlineImages()", () => {
    const html = `<img src="cid:a@x" alt="A"><img src="cid:B@X" alt="B"><img src="cid:gone" alt="G"><div style="background:url('cid:a@x')"></div>`;
    const attachments = [
        { uid: "u1", contentId: "<a@x>" },
        { uid: "u/2", contentId: "b@x" },
        { uid: "u3" },
        { uid: "u4", contentId: "" },
    ];

    it("points each reference at the attachment whose Content-ID it names (brackets and case aside) and drops the rest", () => {
        expect(pointInlineImages(html, attachments, "attachment", "/api/mail/attachments")).toBe(
            `<img src="/api/mail/attachments/u1/content" alt="A"><img src="/api/mail/attachments/u%2F2/content" alt="B"><img alt="G"><div style="background:url('/api/mail/attachments/u1/content')"></div>`,
        );
        expect(pointInlineImages(`<img src="cid:a@x">`, attachments, "attachment", "https://h.example/api/mail/attachments///")).toBe(`<img src="https://h.example/api/mail/attachments/u1/content">`);
    });

    it("leaves known references as cid: for a client that resolves them itself, and drops the unknown", () => {
        expect(pointInlineImages(html, attachments, "keep", "/api/mail/attachments")).toBe(`<img src="cid:a@x" alt="A"><img src="cid:B@X" alt="B"><img alt="G"><div style="background:url('cid:a@x')"></div>`);
    });

    it("drops every reference when the message has no attachments", () => {
        expect(pointInlineImages(html, [], "keep", "/x")).toBe(`<img alt="A"><img alt="B"><img alt="G"><div style="background:none"></div>`);
    });
});
