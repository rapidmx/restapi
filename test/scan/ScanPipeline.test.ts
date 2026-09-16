///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for ScanPipeline - the injected SpamScanProvider/AvScanProvider are hand-built mocks;
// `mailparser`'s `simpleParser` is exercised for real against small hand-built raw MIME messages (it's a
// regular, already-installed dependency here, not an optional peer one worth mocking away).
import { ScanPipeline, resolveDeliveryVerdict } from "../../src/scan/ScanPipeline.js";
import { AvVerdict, RecipientType, SpamVerdict } from "../../src/models/types.js";
import { MAX_MESSAGE_RECIPIENTS } from "../../src/util/RecipientUtils.js";
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

/** An S/MIME `EnvelopedData` message - the entire body is one opaque `application/pkcs7-mime` part, exactly
 * as this library's own (future) outgoing encrypted mail would be shaped per `specs/end-to-end_encryption.md`. */
function makeEncryptedRawMessage(): Buffer {
    const raw = [
        "From: Sender <sender@example.com>",
        "To: Recipient <recipient@example.com>",
        "Subject: Encrypted message",
        "MIME-Version: 1.0",
        'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
        "Content-Transfer-Encoding: base64",
        'Content-Disposition: attachment; filename="smime.p7m"',
        "",
        Buffer.from("fake CMS EnvelopedData DER bytes").toString("base64"),
        "",
    ].join("\r\n");
    return Buffer.from(raw);
}

/** The OpenPGP/MIME encrypted shape - checked defensively even though this library only ever emits S/MIME. */
function makeMultipartEncryptedRawMessage(): Buffer {
    const raw = [
        "From: Sender <sender@example.com>",
        "To: Recipient <recipient@example.com>",
        "Subject: PGP encrypted message",
        "MIME-Version: 1.0",
        'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="BOUNDARY"',
        "",
        "--BOUNDARY",
        "Content-Type: application/pgp-encrypted",
        "",
        "Version: 1",
        "",
        "--BOUNDARY",
        "Content-Type: application/octet-stream",
        "",
        Buffer.from("fake OpenPGP ciphertext").toString("base64"),
        "",
        "--BOUNDARY--",
        "",
    ].join("\r\n");
    return Buffer.from(raw);
}

/** Opaque S/MIME *signing* (not encryption) - `smime-type=signed-data` still carries the real content, just
 * PKCS#7-encoded, so `isEncryptedBody()` must not treat it as encrypted. This library's own signing never
 * produces this content type (it uses detached `multipart/signed` instead), but a message from an external
 * sender could still arrive shaped this way. */
function makeOpaqueSignedRawMessage(): Buffer {
    const raw = [
        "From: Sender <sender@example.com>",
        "To: Recipient <recipient@example.com>",
        "Subject: Opaque signed message",
        "MIME-Version: 1.0",
        'Content-Type: application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("fake CMS SignedData DER bytes").toString("base64"),
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

    describe("run() - encrypted body detection", () => {
        beforeEach(() => {
            (pipeline as any).spamScanProvider = spamScanProvider;
            (pipeline as any).avScanProvider = avScanProvider;
        });

        it("Sets encrypted: true and derives no sanitizedHtml/bodyPreview for an S/MIME EnvelopedData message.", async () => {
            const result = await pipeline.run(makeEncryptedRawMessage(), makeEnvelope());

            expect(result.encrypted).toBe(true);
            expect(result.sanitizedHtml).toBeUndefined();
            expect(result.bodyPreview).toBeUndefined();
        });

        it("Sets encrypted: true for the multipart/encrypted (OpenPGP/MIME) shape too.", async () => {
            const result = await pipeline.run(makeMultipartEncryptedRawMessage(), makeEnvelope());

            expect(result.encrypted).toBe(true);
        });

        it("Does NOT treat opaque S/MIME signing (smime-type=signed-data) as encrypted.", async () => {
            const result = await pipeline.run(makeOpaqueSignedRawMessage(), makeEnvelope());

            expect(result.encrypted).toBe(false);
        });

        it("Sets encrypted: false for an ordinary HTML message, still deriving sanitizedHtml normally.", async () => {
            const result = await pipeline.run(makeRawMessage(), makeEnvelope());

            expect(result.encrypted).toBe(false);
            expect(result.sanitizedHtml).toBeDefined();
        });

        it("Sets encrypted: false for an ordinary plain-text message.", async () => {
            const result = await pipeline.run(makePlainRawMessage(), makeEnvelope());

            expect(result.encrypted).toBe(false);
        });
    });

    describe("real DI resolution (regression - not the hand-built `new ScanPipeline()` used everywhere above)", () => {
        // Reproduces a real bug found live via a consuming app's docker-compose boot: `ObjectFactory.
        // initialize()` throws "No configuration variable is defined at path: ..." for ANY `@Config` field
        // with neither a config value present nor an explicit default - `allowedTags` had no default,
        // so constructing a `ScanPipeline` (as some other class's own `@Inject`-ed dependency) failed
        // outright whenever the consuming app never set `mail:scan:sanitize:allowed_tags`, silently
        // disabling all spam/AV scanning. `test/config.ts` happens to always set this key (to `[]`), which
        // is exactly why this was never caught by any test going through that shared config - this test
        // uses a minimal config that genuinely omits it, matching what actually broke.
        it("Constructs successfully via the real ObjectFactory even when the config key is entirely absent.", async () => {
            const { ObjectFactory } = await import("@rapidrest/service-core");
            const { Logger } = await import("@rapidrest/core");
            const { RspamdSpamScanProvider } = await import("../../src/scan/RspamdSpamScanProvider.js");
            const { ClamAvScanProvider } = await import("../../src/scan/ClamAvScanProvider.js");

            const minimalConfig = { get: (_path: string) => undefined };
            const objectFactory = new (ObjectFactory as any)(minimalConfig, Logger());
            objectFactory.register(RspamdSpamScanProvider, "SpamScanProvider");
            objectFactory.register(ClamAvScanProvider, "AvScanProvider");

            const instance = await objectFactory.newInstance(ScanPipeline, { name: "ScanPipeline:test" });

            expect(instance).toBeInstanceOf(ScanPipeline);
            expect(instance.allowedTags).toEqual(expect.arrayContaining(["p", "b", "i"]));
            expect(instance.allowedTags).not.toContain("script");
        });
    });

    describe("run() - X-RapidMX-Recall-Of extraction", () => {
        beforeEach(() => {
            (pipeline as any).spamScanProvider = spamScanProvider;
            (pipeline as any).avScanProvider = avScanProvider;
        });

        it("Extracts recallOfMessageId from an X-RapidMX-Recall-Of header.", async () => {
            const raw = Buffer.from(
                [
                    "From: sender@example.com",
                    "To: recipient@example.com",
                    "Subject: Recall: Test message",
                    "X-RapidMX-Recall-Of: abc123@example.com",
                    "",
                    "Recall notice.",
                    "",
                ].join("\r\n"),
            );

            const result = await pipeline.run(raw, makeEnvelope());

            expect(result.recallOfMessageId).toBe("abc123@example.com");
        });

        it("Leaves recallOfMessageId undefined for an ordinary message.", async () => {
            const result = await pipeline.run(makePlainRawMessage(), makeEnvelope());

            expect(result.recallOfMessageId).toBeUndefined();
        });
    });

    describe("run() - Reply-To extraction", () => {
        beforeEach(() => {
            (pipeline as any).spamScanProvider = spamScanProvider;
            (pipeline as any).avScanProvider = avScanProvider;
        });

        it("Extracts replyToAddress from a Reply-To header.", async () => {
            const raw = Buffer.from(
                [
                    "From: sender@example.com",
                    "To: recipient@example.com",
                    "Reply-To: Someone Else <someone-else@example.com>",
                    "Subject: Test message",
                    "",
                    "Body.",
                    "",
                ].join("\r\n"),
            );

            const result = await pipeline.run(raw, makeEnvelope());

            expect(result.replyToAddress).toBe("someone-else@example.com");
        });

        it("Leaves replyToAddress undefined when no Reply-To header is present.", async () => {
            const result = await pipeline.run(makePlainRawMessage(), makeEnvelope());

            expect(result.replyToAddress).toBeUndefined();
        });
    });

    describe("run() - sender display name and header recipient extraction", () => {
        beforeEach(() => {
            (pipeline as any).spamScanProvider = spamScanProvider;
            (pipeline as any).avScanProvider = avScanProvider;
        });

        /** A header-only message carrying whatever originator/recipient headers a test needs. */
        const withHeaders = (...headers: string[]): Buffer =>
            Buffer.from([...headers, "Subject: Test message", "", "Body.", ""].join("\r\n"));

        it("Extracts the sender's display name alone, not the whole From header.", async () => {
            const result = await pipeline.run(withHeaders('From: "Bob Allen" <bob@partner.test>', "To: recipient@example.com"), makeEnvelope());

            expect(result.fromDisplayName).toBe("Bob Allen");
            expect(result.fromAddress).toBe("bob@partner.test");
            // The whole header value is still what mail filter `from` conditions match against.
            expect(result.parsedFrom).toBe('"Bob Allen" <bob@partner.test>');
        });

        it("Leaves fromDisplayName undefined for a bare address, and for a message with no From header at all.", async () => {
            expect((await pipeline.run(withHeaders("From: bob@partner.test", "To: recipient@example.com"), makeEnvelope())).fromDisplayName).toBeUndefined();
            expect((await pipeline.run(withHeaders("To: recipient@example.com"), makeEnvelope())).fromDisplayName).toBeUndefined();
        });

        it("Extracts every To and Cc recipient with its display name, typed by the header it came from.", async () => {
            const result = await pipeline.run(
                withHeaders("From: bob@partner.test", 'To: "Allen, Bob" <bob@partner.test>, carol@partner.test', "Cc: Dave <dave@partner.test>"),
                makeEnvelope(),
            );

            expect(result.headerRecipients).toEqual([
                { address: "bob@partner.test", displayName: "Allen, Bob", type: RecipientType.TO },
                { address: "carol@partner.test", type: RecipientType.TO },
                { address: "dave@partner.test", displayName: "Dave", type: RecipientType.CC },
            ]);
        });

        it("Decodes RFC 2047 encoded words, including one holding a comma and a quote.", async () => {
            const encoded: string = `=?utf-8?B?${Buffer.from('Grüßer, "Jörg"', "utf8").toString("base64")}?=`;
            const result = await pipeline.run(withHeaders("From: bob@partner.test", `To: ${encoded} <jorg@partner.test>`), makeEnvelope());

            expect(result.headerRecipients).toEqual([{ address: "jorg@partner.test", displayName: 'Grüßer, "Jörg"', type: RecipientType.TO }]);
        });

        it("Records a Bcc header the copy genuinely carries, and no bcc entry when it carries none.", async () => {
            const withBcc = await pipeline.run(withHeaders("From: bob@partner.test", "To: carol@partner.test", "Bcc: hidden@partner.test"), makeEnvelope());
            expect(withBcc.headerRecipients).toEqual([
                { address: "carol@partner.test", type: RecipientType.TO },
                { address: "hidden@partner.test", type: RecipientType.BCC },
            ]);

            const withoutBcc = await pipeline.run(withHeaders("From: bob@partner.test", "To: carol@partner.test"), makeEnvelope());
            expect(withoutBcc.headerRecipients.some((r) => r.type === RecipientType.BCC)).toBe(false);
        });

        it("Survives a malformed recipient header, keeping whatever addresses it does name.", async () => {
            const result = await pipeline.run(
                withHeaders("From: bob@partner.test", 'To: Allen, Bob <bob@partner.test>, "unterminated <carol@partner.test>, not-an-address'),
                makeEnvelope(),
            );

            expect(result.headerRecipients.map((r) => r.address)).toContain("bob@partner.test");
            expect(result.headerRecipients.every((r) => r.address.includes("@"))).toBe(true);
        });

        it("Caps a huge recipient header at MAX_MESSAGE_RECIPIENTS.", async () => {
            const many: string = Array.from({ length: 5_000 }, (_unused, i) => `user${i}@partner.test`).join(", ");
            const result = await pipeline.run(withHeaders("From: bob@partner.test", `To: ${many}`), makeEnvelope());

            expect(result.headerRecipients.length).toBe(MAX_MESSAGE_RECIPIENTS);
            expect(result.headerRecipients[0].address).toBe("user0@partner.test");
        });

        it("Reports no header recipients for a message that names none.", async () => {
            expect((await pipeline.run(withHeaders("From: bob@partner.test"), makeEnvelope())).headerRecipients).toEqual([]);
        });
    });

    describe("run() - In-Reply-To/References extraction", () => {
        beforeEach(() => {
            (pipeline as any).spamScanProvider = spamScanProvider;
            (pipeline as any).avScanProvider = avScanProvider;
        });

        it("Extracts inReplyTo and a single-entry references as a one-element array.", async () => {
            const raw = Buffer.from(
                [
                    "From: sender@example.com",
                    "To: recipient@example.com",
                    "Subject: Re: Hello",
                    "In-Reply-To: <parent@example.com>",
                    "References: <parent@example.com>",
                    "",
                    "Reply body.",
                    "",
                ].join("\r\n"),
            );

            const result = await pipeline.run(raw, makeEnvelope());

            expect(result.inReplyTo).toBe("parent@example.com");
            expect(result.references).toEqual(["parent@example.com"]);
        });

        it("Extracts a multi-entry References header as an array, oldest first.", async () => {
            const raw = Buffer.from(
                [
                    "From: sender@example.com",
                    "To: recipient@example.com",
                    "Subject: Re: Hello",
                    "In-Reply-To: <second@example.com>",
                    "References: <root@example.com> <second@example.com>",
                    "",
                    "Reply body.",
                    "",
                ].join("\r\n"),
            );

            const result = await pipeline.run(raw, makeEnvelope());

            expect(result.references).toEqual(["root@example.com", "second@example.com"]);
        });

        it("Defaults inReplyTo to undefined and references to [] for a message with neither header.", async () => {
            const result = await pipeline.run(makePlainRawMessage(), makeEnvelope());

            expect(result.inReplyTo).toBeUndefined();
            expect(result.references).toEqual([]);
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
