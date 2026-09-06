///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for ScanPipeline - the injected SpamScanProvider/AvScanProvider are hand-built mocks;
// `mailparser`'s `simpleParser` is exercised for real against small hand-built raw MIME messages (it's a
// regular, already-installed dependency here, not an optional peer one worth mocking away).
import { ScanPipeline, resolveDeliveryVerdict } from "../../src/scan/ScanPipeline.js";
import { AvVerdict, SpamVerdict } from "../../src/models/types.js";
import type { SpamScanResult } from "../../src/scan/SpamScanProvider.js";
import type { AvScanResult } from "../../src/scan/AvScanProvider.js";

function makeEnvelope(overrides: any = {}) {
    return { from: "sender@example.com", to: ["recipient@example.com"], ...overrides };
}

/** Builds a minimal valid multipart RFC 5322 message with an HTML body (containing a <script>) and one attachment. */
function makeRawMessage(opts: { attachmentContent?: string } = {}): Buffer {
    const attachmentContent = opts.attachmentContent ?? "fake pdf content";
    const raw = [
        "From: Sender <sender@example.com>",
        "To: Recipient <recipient@example.com>",
        "Subject: Test message",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="BOUNDARY"',
        "",
        "--BOUNDARY",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<html><body><p>Hello</p><script>alert(1)</script></body></html>",
        "",
        "--BOUNDARY",
        'Content-Type: application/pdf; name="doc.pdf"',
        'Content-Disposition: attachment; filename="doc.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(attachmentContent).toString("base64"),
        "",
        "--BOUNDARY--",
        "",
    ].join("\r\n");
    return Buffer.from(raw);
}

/** A message with no HTML body and no attachments at all. */
function makePlainRawMessage(): Buffer {
    const raw = [
        "From: Sender <sender@example.com>",
        "To: Recipient <recipient@example.com>",
        "Subject: Plain message",
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Just plain text, no HTML, no attachments.",
        "",
    ].join("\r\n");
    return Buffer.from(raw);
}

function cleanSpam(): SpamScanResult {
    return { score: 0, verdict: SpamVerdict.CLEAN, symbols: [] };
}

function cleanAv(): AvScanResult {
    return { verdict: AvVerdict.CLEAN };
}

describe("ScanPipeline Tests", () => {
    let pipeline: ScanPipeline;
    let spamScanProvider: { scoreMessage: ReturnType<typeof vi.fn>; name: string };
    let avScanProvider: { scanBuffer: ReturnType<typeof vi.fn>; name: string };

    beforeEach(() => {
        pipeline = new ScanPipeline();
        spamScanProvider = { name: "test-spam", scoreMessage: vi.fn().mockResolvedValue(cleanSpam()) };
        avScanProvider = { name: "test-av", scanBuffer: vi.fn().mockResolvedValue(cleanAv()) };
    });

    describe("run() - provider requirements", () => {
        it("Throws when no SpamScanProvider is registered.", async () => {
            (pipeline as any).avScanProvider = avScanProvider;

            await expect(pipeline.run(makePlainRawMessage(), makeEnvelope())).rejects.toThrow(
                /requires both a SpamScanProvider and an AvScanProvider/,
            );
        });

        it("Throws when no AvScanProvider is registered.", async () => {
            (pipeline as any).spamScanProvider = spamScanProvider;

            await expect(pipeline.run(makePlainRawMessage(), makeEnvelope())).rejects.toThrow(
                /requires both a SpamScanProvider and an AvScanProvider/,
            );
        });

        it("Throws when neither provider is registered.", async () => {
            await expect(pipeline.run(makePlainRawMessage(), makeEnvelope())).rejects.toThrow(
                /requires both a SpamScanProvider and an AvScanProvider/,
            );
        });
    });

    describe("run() - AV severity combination", () => {
        beforeEach(() => {
            (pipeline as any).spamScanProvider = spamScanProvider;
            (pipeline as any).avScanProvider = avScanProvider;
        });

        it("Picks the raw-message verdict when it is clean and no attachment is infected.", async () => {
            avScanProvider.scanBuffer.mockResolvedValue(cleanAv());

            const result = await pipeline.run(makeRawMessage(), makeEnvelope());

            expect(result.av).toEqual(cleanAv());
            expect(result.attachments).toHaveLength(1);
            expect(result.attachments[0].av).toEqual(cleanAv());
        });

        it("Picks the attachment's verdict when the raw message is clean but the attachment is infected.", async () => {
            // First call is for the raw message buffer, subsequent calls are per-attachment.
            avScanProvider.scanBuffer.mockImplementation(async (content: Buffer) => {
                // The raw message buffer is much larger than the lone attachment's decoded content.
                if (content.length > 200) {
                    return cleanAv();
                }
                return { verdict: AvVerdict.INFECTED, signatureName: "Eicar-Test-Signature" };
            });

            const result = await pipeline.run(makeRawMessage(), makeEnvelope());

            expect(result.av).toEqual({ verdict: AvVerdict.INFECTED, signatureName: "Eicar-Test-Signature" });
            expect(result.attachments[0].av.verdict).toBe(AvVerdict.INFECTED);
        });

        it("Picks the raw-message verdict when it is infected but every attachment is clean.", async () => {
            avScanProvider.scanBuffer.mockImplementation(async (content: Buffer) => {
                if (content.length > 200) {
                    return { verdict: AvVerdict.INFECTED, signatureName: "Raw-Message-Signature" };
                }
                return cleanAv();
            });

            const result = await pipeline.run(makeRawMessage(), makeEnvelope());

            expect(result.av).toEqual({ verdict: AvVerdict.INFECTED, signatureName: "Raw-Message-Signature" });
            expect(result.attachments[0].av).toEqual(cleanAv());
        });

        it("An ERROR verdict on an attachment outranks a CLEAN raw-message verdict but not an INFECTED one.", async () => {
            avScanProvider.scanBuffer.mockImplementation(async (content: Buffer) => {
                if (content.length > 200) {
                    return { verdict: AvVerdict.INFECTED };
                }
                return { verdict: AvVerdict.ERROR };
            });

            const result = await pipeline.run(makeRawMessage(), makeEnvelope());

            expect(result.av.verdict).toBe(AvVerdict.INFECTED);
        });

        it("Runs the raw-message AV scan and every attachment scan, plus the spam scan.", async () => {
            await pipeline.run(makeRawMessage(), makeEnvelope());

            // Once for the raw message, once for the one attachment.
            expect(avScanProvider.scanBuffer).toHaveBeenCalledTimes(2);
            expect(spamScanProvider.scoreMessage).toHaveBeenCalledTimes(1);
        });

        it("Handles a message with no attachments (raw-message verdict only).", async () => {
            const result = await pipeline.run(makePlainRawMessage(), makeEnvelope());

            expect(result.attachments).toEqual([]);
            expect(result.av).toEqual(cleanAv());
            expect(avScanProvider.scanBuffer).toHaveBeenCalledTimes(1);
        });
    });

    describe("run() - HTML sanitization", () => {
        beforeEach(() => {
            (pipeline as any).spamScanProvider = spamScanProvider;
            (pipeline as any).avScanProvider = avScanProvider;
        });

        it("Strips <script> tags from an HTML body into sanitizedHtml.", async () => {
            const result = await pipeline.run(makeRawMessage(), makeEnvelope());

            expect(result.sanitizedHtml).toBeDefined();
            expect(result.sanitizedHtml).not.toContain("<script>");
            expect(result.sanitizedHtml).not.toContain("alert(1)");
            expect(result.sanitizedHtml).toContain("Hello");
        });

        it("Leaves sanitizedHtml undefined when the message has no HTML body.", async () => {
            const result = await pipeline.run(makePlainRawMessage(), makeEnvelope());

            expect(result.sanitizedHtml).toBeUndefined();
        });

        it("Honors a configured allowedTags override.", async () => {
            (pipeline as any).allowedTags = ["p"];

            const result = await pipeline.run(makeRawMessage(), makeEnvelope());

            expect(result.sanitizedHtml?.trim()).toBe("<p>Hello</p>");
        });
    });

    describe("run() - attachment result shape", () => {
        beforeEach(() => {
            (pipeline as any).spamScanProvider = spamScanProvider;
            (pipeline as any).avScanProvider = avScanProvider;
        });

        it("Captures filename/contentType/content/isInline for each attachment.", async () => {
            const result = await pipeline.run(makeRawMessage(), makeEnvelope());

            expect(result.attachments[0]).toEqual(
                expect.objectContaining({
                    filename: "doc.pdf",
                    contentType: "application/pdf",
                    isInline: false,
                    content: expect.any(Buffer),
                }),
            );
            expect(result.attachments[0].content.toString()).toBe("fake pdf content");
        });

        it("Returns the spam scan's result unchanged.", async () => {
            const spamResult: SpamScanResult = { score: 7.5, verdict: SpamVerdict.SUSPECT, symbols: ["FOO", "BAR"] };
            spamScanProvider.scoreMessage.mockResolvedValue(spamResult);

            const result = await pipeline.run(makeRawMessage(), makeEnvelope());

            expect(result.spam).toEqual(spamResult);
        });
    });
});

describe("resolveDeliveryVerdict() Tests", () => {
    it("Routes to quarantine when the AV verdict is INFECTED, regardless of spam verdict.", () => {
        const verdict = resolveDeliveryVerdict({
            spam: { score: 0, verdict: SpamVerdict.CLEAN, symbols: [] },
            av: { verdict: AvVerdict.INFECTED },
            attachments: [],
        });
        expect(verdict).toBe("quarantine");
    });

    it("Routes to junk when the spam verdict is SPAM and AV is clean.", () => {
        const verdict = resolveDeliveryVerdict({
            spam: { score: 20, verdict: SpamVerdict.SPAM, symbols: [] },
            av: { verdict: AvVerdict.CLEAN },
            attachments: [],
        });
        expect(verdict).toBe("junk");
    });

    it("Routes to deliver when both spam and AV are clean/non-spam.", () => {
        const verdict = resolveDeliveryVerdict({
            spam: { score: 0, verdict: SpamVerdict.CLEAN, symbols: [] },
            av: { verdict: AvVerdict.CLEAN },
            attachments: [],
        });
        expect(verdict).toBe("deliver");
    });

    it("Routes to junk for a SUSPECT spam verdict (fail-closed to human review, not blind delivery) with clean AV.", () => {
        const verdict = resolveDeliveryVerdict({
            spam: { score: 3, verdict: SpamVerdict.SUSPECT, symbols: [] },
            av: { verdict: AvVerdict.CLEAN },
            attachments: [],
        });
        expect(verdict).toBe("junk");
    });

    it("Routes to quarantine when the AV verdict is ERROR (scan-engine outage fails closed, not delivered unscanned).", () => {
        const verdict = resolveDeliveryVerdict({
            spam: { score: 0, verdict: SpamVerdict.CLEAN, symbols: [] },
            av: { verdict: AvVerdict.ERROR },
            attachments: [],
        });
        expect(verdict).toBe("quarantine");
    });

    it("Prioritizes quarantine over junk when both AV is infected and spam verdict is SPAM.", () => {
        const verdict = resolveDeliveryVerdict({
            spam: { score: 20, verdict: SpamVerdict.SPAM, symbols: [] },
            av: { verdict: AvVerdict.INFECTED },
            attachments: [],
        });
        expect(verdict).toBe("quarantine");
    });

    it("Prioritizes quarantine (AV ERROR) over junk (SPAM) when both fail-closed conditions are present.", () => {
        const verdict = resolveDeliveryVerdict({
            spam: { score: 20, verdict: SpamVerdict.SPAM, symbols: [] },
            av: { verdict: AvVerdict.ERROR },
            attachments: [],
        });
        expect(verdict).toBe("quarantine");
    });
});
