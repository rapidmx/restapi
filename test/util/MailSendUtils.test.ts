///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for scanAndRelay() - the injected ScanPipeline is a hand-built mock (it's tested on its
// own merits in scan/ScanPipeline.test.ts), while BlobStore/MailTransport are the shared, real-ish test
// doubles from testDoubles.ts so this can assert what actually got relayed/stored.
import { scanAndRelay } from "../../src/util/MailSendUtils.js";
import { AvVerdict, SpamVerdict } from "../../src/models/types.js";
import { InMemoryBlobStore, RecordingMailTransport } from "../testDoubles.js";

function makeCleanScanResult(overrides: any = {}) {
    return {
        spam: { score: 0, verdict: SpamVerdict.CLEAN, symbols: [] },
        av: { verdict: AvVerdict.CLEAN },
        attachments: [],
        references: [],
        inReplyTo: undefined,
        encrypted: false,
        ...overrides,
    };
}

function makeRawMessage(extraHeaders: string[] = []): Buffer {
    const raw = ["From: sender@example.com", "To: recipient@example.com", "Subject: Hello", ...extraHeaders, "", "Hello world", ""].join(
        "\r\n",
    );
    return Buffer.from(raw);
}

describe("scanAndRelay() Tests", () => {
    let scanPipeline: { run: ReturnType<typeof vi.fn> };
    let mailTransport: RecordingMailTransport;
    let blobStore: InMemoryBlobStore;

    beforeEach(() => {
        scanPipeline = { run: vi.fn().mockResolvedValue(makeCleanScanResult()) };
        mailTransport = new RecordingMailTransport();
        blobStore = new InMemoryBlobStore();
    });

    it("Leaves an existing Message-ID header untouched, returning its bracket-stripped value.", async () => {
        const raw = makeRawMessage(["Message-ID: <existing-id@example.com>"]);

        const result = await scanAndRelay(raw, "sender@example.com", ["recipient@example.com"], scanPipeline as any, mailTransport, blobStore);

        expect(result.messageId).toBe("existing-id@example.com");
        expect(result.raw).toBe(raw);
        expect(mailTransport.sent[0].raw).toBe(raw);
        expect(scanPipeline.run).toHaveBeenCalledWith(raw, { from: "sender@example.com", to: ["recipient@example.com"] });
    });

    it("Generates and injects a Message-ID when the raw message has none, using envelopeFrom's domain.", async () => {
        const raw = makeRawMessage();

        const result = await scanAndRelay(raw, "sender@example.com", ["recipient@example.com"], scanPipeline as any, mailTransport, blobStore);

        expect(result.messageId.endsWith("@example.com")).toBe(true);
        expect(result.raw).not.toBe(raw);
        expect(result.raw.toString()).toContain(`Message-ID: <${result.messageId}>`);
        // The augmented raw - not the original - is what actually gets scanned and relayed.
        expect(scanPipeline.run).toHaveBeenCalledWith(result.raw, { from: "sender@example.com", to: ["recipient@example.com"] });
        expect(mailTransport.sent[0].raw).toBe(result.raw);
    });

    it("Falls back to 'localhost' for the generated Message-ID's domain when envelopeFrom has none.", async () => {
        const result = await scanAndRelay(
            makeRawMessage(),
            "no-domain",
            ["recipient@example.com"],
            scanPipeline as any,
            mailTransport,
            blobStore,
        );

        expect(result.messageId.endsWith("@localhost")).toBe(true);
    });

    it("Throws a 422 ApiError when the scan pipeline's verdict is not 'deliver'.", async () => {
        scanPipeline.run.mockResolvedValue(makeCleanScanResult({ spam: { score: 20, verdict: SpamVerdict.SPAM, symbols: [] } }));

        await expect(
            scanAndRelay(makeRawMessage(), "sender@example.com", ["recipient@example.com"], scanPipeline as any, mailTransport, blobStore),
        ).rejects.toThrow(/failed spam\/malware scanning/);
    });

    it("Throws a 502 ApiError when the mail transport rejects the message outright.", async () => {
        vi.spyOn(mailTransport, "send").mockResolvedValue({ accepted: [], rejected: ["recipient@example.com"] });

        await expect(
            scanAndRelay(makeRawMessage(), "sender@example.com", ["recipient@example.com"], scanPipeline as any, mailTransport, blobStore),
        ).rejects.toThrow(/mail transport rejected/);
    });

    it("Stores a sanitized HTML blob when the scan result produced one.", async () => {
        scanPipeline.run.mockResolvedValue(makeCleanScanResult({ sanitizedHtml: "<p>Hi</p>" }));

        const result = await scanAndRelay(
            makeRawMessage(),
            "sender@example.com",
            ["recipient@example.com"],
            scanPipeline as any,
            mailTransport,
            blobStore,
        );

        expect(result.sanitizedHtmlBlobKey).toBeDefined();
        const stored: Buffer = await blobStore.get(result.sanitizedHtmlBlobKey!);
        expect(stored.toString()).toBe("<p>Hi</p>");
    });

    it("Leaves sanitizedHtmlBlobKey undefined when the scan result produced no sanitized HTML.", async () => {
        const result = await scanAndRelay(
            makeRawMessage(),
            "sender@example.com",
            ["recipient@example.com"],
            scanPipeline as any,
            mailTransport,
            blobStore,
        );

        expect(result.sanitizedHtmlBlobKey).toBeUndefined();
    });

    it("Derives conversationId from the scan result's references (a reply), reusing the same scan - no second parse.", async () => {
        scanPipeline.run.mockResolvedValue(makeCleanScanResult({ references: ["root@example.com", "second@example.com"], inReplyTo: "second@example.com" }));

        const result = await scanAndRelay(
            makeRawMessage(),
            "sender@example.com",
            ["recipient@example.com"],
            scanPipeline as any,
            mailTransport,
            blobStore,
        );

        expect(result.conversationId).toBe("root@example.com");
        expect(scanPipeline.run).toHaveBeenCalledTimes(1);
    });

    it("Falls back to the message's own (possibly-generated) messageId as conversationId when there's no References/In-Reply-To.", async () => {
        const result = await scanAndRelay(
            makeRawMessage(),
            "sender@example.com",
            ["recipient@example.com"],
            scanPipeline as any,
            mailTransport,
            blobStore,
        );

        expect(result.conversationId).toBe(result.messageId);
    });

    it("Passes through the scan result's encrypted flag unchanged.", async () => {
        scanPipeline.run.mockResolvedValue(makeCleanScanResult({ encrypted: true }));

        const result = await scanAndRelay(
            makeRawMessage(),
            "sender@example.com",
            ["recipient@example.com"],
            scanPipeline as any,
            mailTransport,
            blobStore,
        );

        expect(result.encrypted).toBe(true);
    });
});
