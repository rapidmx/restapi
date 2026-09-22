///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for scanAndRelay() - the injected ScanPipeline is a hand-built mock (it's tested on its
// own merits in scan/ScanPipeline.test.ts), while BlobStore/MailTransport are the shared, real-ish test
// doubles from testDoubles.ts so this can assert what actually got relayed/stored.
import {
    applyThreadHeaders,
    MAX_RELAYED_REFERENCES,
    MAX_RELAYED_REFERENCES_LENGTH,
    prepareOutboundMime,
    scanAndRelay,
    seedReceiptStatus,
    threadHeaders,
} from "../../src/util/MailSendUtils.js";
import { AvVerdict, SpamVerdict } from "../../src/models/types.js";
import { MailRelayError } from "../../src/transport/TransportResultUtils.js";
import { InMemoryBlobStore, RecordingMailTransport, StaticDnsResolver } from "../testDoubles.js";

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
        expect(scanPipeline.run).toHaveBeenCalledWith(raw, { from: "sender@example.com", to: ["recipient@example.com"] }, { skipPreview: true });
    });

    it("Generates and injects a Message-ID when the raw message has none, using envelopeFrom's domain.", async () => {
        const raw = makeRawMessage();

        const result = await scanAndRelay(raw, "sender@example.com", ["recipient@example.com"], scanPipeline as any, mailTransport, blobStore);

        expect(result.messageId.endsWith("@example.com")).toBe(true);
        expect(result.raw).not.toBe(raw);
        expect(result.raw.toString()).toContain(`Message-ID: <${result.messageId}>`);
        // The augmented raw - not the original - is what actually gets scanned and relayed.
        expect(scanPipeline.run).toHaveBeenCalledWith(result.raw, { from: "sender@example.com", to: ["recipient@example.com"] }, { skipPreview: true });
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

    it("Throws a 502 MailRelayError when the mail transport rejects the message outright, saying who and why.", async () => {
        const response = "554 5.7.1 <recipient@example.com>: Recipient address rejected: Access denied";
        vi.spyOn(mailTransport, "send").mockResolvedValue({
            accepted: [],
            rejected: ["recipient@example.com"],
            failures: [{ address: "recipient@example.com", code: 554, enhancedCode: "5.7.1", response, command: "RCPT TO" }],
            error: { message: "Sendmail exited with code 75", code: "ESENDMAIL", exitCode: 75, stderr: "sendmail: fatal: x" },
        });

        const error: any = await scanAndRelay(
            makeRawMessage(),
            "sender@example.com",
            ["recipient@example.com"],
            scanPipeline as any,
            mailTransport,
            blobStore,
        ).catch((err) => err);

        expect(error).toBeInstanceOf(MailRelayError);
        expect(error.status).toBe(502);
        expect(error.message).toBe(
            "This message could not be sent: the mail system refused it for recipient@example.com. Reason given: " + response,
        );
        expect(error.details).toEqual({
            transport: "recording",
            recipients: ["recipient@example.com"],
            accepted: [],
            rejected: ["recipient@example.com"],
            failures: [
                { address: "recipient@example.com", code: 554, enhancedCode: "5.7.1", response, command: "RCPT TO", temporary: false },
            ],
            error: { message: "Sendmail exited with code 75", code: "ESENDMAIL", exitCode: 75, stderr: "sendmail: fatal: x" },
        });
    });

    it("Reports the recipients a transport refused while relaying to the others as undelivered, and still succeeds.", async () => {
        vi.spyOn(mailTransport, "send").mockResolvedValue({
            accepted: ["a@example.com"],
            rejected: ["b@example.com"],
            failures: [{ address: "b@example.com", response: "550 5.1.1 no such user" }],
        });

        const result = await scanAndRelay(
            makeRawMessage(),
            "sender@example.com",
            ["a@example.com", "b@example.com"],
            scanPipeline as any,
            mailTransport,
            blobStore,
        );

        expect(result.undelivered).toEqual({
            transport: "recording",
            recipients: ["a@example.com", "b@example.com"],
            accepted: ["a@example.com"],
            rejected: ["b@example.com"],
            failures: [{ address: "b@example.com", code: 550, enhancedCode: "5.1.1", response: "550 5.1.1 no such user", temporary: false }],
        });
    });

    it("Reports nothing undelivered when every recipient was accepted.", async () => {
        const result = await scanAndRelay(makeRawMessage(), "sender@example.com", ["a@example.com"], scanPipeline as any, mailTransport, blobStore);

        expect(result.undelivered).toBeUndefined();
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

    it("Reports the References/In-Reply-To the relayed bytes carry, so a caller needn't parse them again.", async () => {
        scanPipeline.run.mockResolvedValue(makeCleanScanResult({ references: ["root@example.com"], inReplyTo: "root@example.com" }));

        const result = await scanAndRelay(
            makeRawMessage(),
            "sender@example.com",
            ["recipient@example.com"],
            scanPipeline as any,
            mailTransport,
            blobStore,
        );

        expect(result.references).toEqual(["root@example.com"]);
        expect(result.inReplyTo).toBe("root@example.com");
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

describe("threadHeaders()/applyThreadHeaders() Tests", () => {
    const value = (headers: { name: string; value: string }[], name: string): string | undefined =>
        headers.find((header) => header.name === name)?.value;

    it("Writes In-Reply-To and a References chain ending in the replied-to message.", () => {
        const headers = threadHeaders(makeRawMessage(), { inReplyTo: "second@example.com", references: ["root@example.com", "second@example.com"] });
        expect(value(headers, "In-Reply-To")).toBe("<second@example.com>");
        expect(value(headers, "References")).toBe("<root@example.com> <second@example.com>");
    });

    it("Appends the replied-to message to a chain that doesn't already end with it.", () => {
        expect(value(threadHeaders(makeRawMessage(), { inReplyTo: "second@example.com", references: ["root@example.com"] }), "References")).toBe(
            "<root@example.com> <second@example.com>",
        );
        expect(
            value(threadHeaders(makeRawMessage(), { inReplyTo: "root@example.com", references: ["root@example.com", "second@example.com"] }), "References"),
        ).toBe("<second@example.com> <root@example.com>");
    });

    it("Writes References alone for a draft that records a chain but no direct parent.", () => {
        const headers = threadHeaders(makeRawMessage(), { references: ["root@example.com"] });
        expect(value(headers, "In-Reply-To")).toBeUndefined();
        expect(value(headers, "References")).toBe("<root@example.com>");
    });

    it("Writes both from a direct parent alone.", () => {
        const headers = threadHeaders(makeRawMessage(), { inReplyTo: "root@example.com" });
        expect(value(headers, "In-Reply-To")).toBe("<root@example.com>");
        expect(value(headers, "References")).toBe("<root@example.com>");
    });

    it("Writes nothing for a message that replies to nothing.", () => {
        expect(threadHeaders(makeRawMessage(), {})).toEqual([]);
        expect(threadHeaders(makeRawMessage(), { inReplyTo: "", references: [] })).toEqual([]);
        expect(threadHeaders(makeRawMessage(), { references: null })).toEqual([]);
        expect(applyThreadHeaders(makeRawMessage(), {}).toString()).toBe(makeRawMessage().toString());
    });

    it("Never second-guesses MIME that already carries threading headers of its own.", () => {
        expect(threadHeaders(makeRawMessage(["In-Reply-To: <own@example.com>"]), { inReplyTo: "other@example.com" })).toEqual([]);
        expect(threadHeaders(makeRawMessage(["References: <own@example.com>"]), { inReplyTo: "other@example.com" })).toEqual([]);
        const raw = makeRawMessage(["References: <own@example.com>"]);
        expect(applyThreadHeaders(raw, { inReplyTo: "other@example.com" })).toBe(raw);
    });

    it("Drops an entry that can't go into a header, and writes nothing when none is left.", () => {
        expect(value(threadHeaders(makeRawMessage(), { inReplyTo: "<parent@example.com>", references: ["<root@example.com>"] }), "References")).toBe(
            "<root@example.com> <parent@example.com>",
        );
        expect(value(threadHeaders(makeRawMessage(), { inReplyTo: "a b@example.com", references: ["ok@example.com"] }), "In-Reply-To")).toBeUndefined();
        expect(value(threadHeaders(makeRawMessage(), { inReplyTo: "a b@example.com", references: ["ok@example.com"] }), "References")).toBe("<ok@example.com>");
        expect(threadHeaders(makeRawMessage(), { inReplyTo: `line${String.fromCharCode(13, 10)}Injected: yes`, references: [] })).toEqual([]);
        expect(threadHeaders(makeRawMessage(), { inReplyTo: undefined, references: [42 as any] })).toEqual([]);
    });

    it("Keeps the thread's root and the newest ancestors when the chain is too long, in entries and in characters.", () => {
        const many: string[] = Array.from({ length: MAX_RELAYED_REFERENCES + 10 }, (_, i) => `r${i}@example.com`);
        const written: string = value(threadHeaders(makeRawMessage(), { inReplyTo: "parent@example.com", references: many }), "References")!;
        const ids: string[] = written.split(" ");
        expect(ids).toHaveLength(MAX_RELAYED_REFERENCES);
        expect(ids[0]).toBe("<r0@example.com>");
        expect(ids[ids.length - 1]).toBe("<parent@example.com>");

        const huge: string[] = Array.from({ length: 6 }, (_, i) => `${"x".repeat(200)}${i}@example.com`);
        const trimmed: string = value(threadHeaders(makeRawMessage(), { references: huge }), "References")!;
        expect(trimmed.length).toBeLessThanOrEqual(MAX_RELAYED_REFERENCES_LENGTH);
        expect(trimmed.startsWith(`<${huge[0]}>`)).toBe(true);
        expect(trimmed.endsWith(`<${huge[huge.length - 1]}>`)).toBe(true);
    });

    it("Keeps a single over-long reference rather than dropping the only thing it has.", () => {
        const one: string = `${"y".repeat(MAX_RELAYED_REFERENCES_LENGTH + 50)}@example.com`;
        expect(value(threadHeaders(makeRawMessage(), { references: [one] }), "References")).toBe(`<${one}>`);
    });

    it("Prepends the headers to the relayed bytes, leaving the body alone.", () => {
        const raw = makeRawMessage(["Message-ID: <self@example.com>"]);
        const threaded: Buffer = applyThreadHeaders(raw, { inReplyTo: "root@example.com", references: ["root@example.com"] });
        expect(threaded).not.toBe(raw);
        expect(threaded.toString()).toContain("In-Reply-To: <root@example.com>");
        expect(threaded.toString()).toContain("References: <root@example.com>");
        expect(threaded.toString()).toContain("Message-ID: <self@example.com>");
        expect(threaded.toString().endsWith(`Hello world${String.fromCharCode(13, 10)}`)).toBe(true);
    });
});

describe("prepareOutboundMime() and seedReceiptStatus() Tests", () => {
    const raw = makeRawMessage();
    const message = { from: { address: "sender@example.com" }, recipients: [{ address: "someone@example.com" }] };
    const mailbox = (overrides: any = {}): any => ({
        alwaysRequestReceiptInternal: false,
        alwaysRequestReceiptFederated: false,
        alwaysRequestReceiptExternal: false,
        keys: [],
        ...overrides,
    });
    // A fresh class per test: the domain repository is cached per class.
    const factoryWithDomains = (...names: string[]): any => ({ newInstance: async () => ({ find: async () => names.map((name) => ({ name })) }) });

    it("returns the bytes untouched, requesting no receipt, without a mailbox or when the mailbox and message ask for none", async () => {
        const dns = new StaticDnsResolver();

        expect(await prepareOutboundMime({ raw, message, mailbox: undefined, objectFactory: factoryWithDomains(), domainClass: class A {}, dnsResolver: dns })).toEqual({
            raw,
            attachesReceiptRequest: false,
        });
        const none = await prepareOutboundMime({ raw, message, mailbox: mailbox(), objectFactory: factoryWithDomains(), domainClass: class B {}, dnsResolver: dns });
        expect(none.raw).toBe(raw);
        expect(none.attachesReceiptRequest).toBe(false);
    });

    it("requests a receipt for a recipient in a tier the mailbox asks receipts for, by the mailbox's own default", async () => {
        const dns = new StaticDnsResolver();
        const internal = await prepareOutboundMime({
            raw,
            message,
            mailbox: mailbox({ alwaysRequestReceiptInternal: true }),
            objectFactory: factoryWithDomains("example.com"),
            domainClass: class C {},
            dnsResolver: dns,
        });
        const externalOnly = await prepareOutboundMime({
            raw,
            message,
            mailbox: mailbox({ alwaysRequestReceiptInternal: true }),
            objectFactory: factoryWithDomains("elsewhere.example"),
            domainClass: class D {},
            dnsResolver: dns,
        });

        expect(internal.attachesReceiptRequest).toBe(true);
        expect(internal.raw.toString()).toMatch(/^Disposition-Notification-To: sender@example.com\r\n/);
        expect(externalOnly.attachesReceiptRequest).toBe(false);
        expect(externalOnly.raw).toBe(raw);
    });

    it("lets the message's own requestReceipt override the mailbox's defaults either way", async () => {
        const dns = new StaticDnsResolver();
        const asked = await prepareOutboundMime({ raw, message: { ...message, requestReceipt: true }, mailbox: mailbox(), objectFactory: factoryWithDomains(), domainClass: class E {}, dnsResolver: dns });
        const declined = await prepareOutboundMime({
            raw,
            message: { ...message, requestReceipt: false },
            mailbox: mailbox({ alwaysRequestReceiptInternal: true, alwaysRequestReceiptExternal: true }),
            objectFactory: factoryWithDomains("example.com"),
            domainClass: class F {},
            dnsResolver: dns,
        });

        expect(asked.attachesReceiptRequest).toBe(true);
        expect(declined.attachesReceiptRequest).toBe(false);
    });

    it("requests no receipt when it has nothing to classify recipients with (no domain class or no resolver)", async () => {
        const asks = { ...message, requestReceipt: true };

        expect((await prepareOutboundMime({ raw, message: asks, mailbox: mailbox(), objectFactory: factoryWithDomains() })).attachesReceiptRequest).toBe(false);
        expect(
            (await prepareOutboundMime({ raw, message: asks, mailbox: mailbox(), objectFactory: factoryWithDomains(), domainClass: class G {} })).attachesReceiptRequest,
        ).toBe(false);
    });

    it("announces the mailbox's active encryption key, and only an active one", async () => {
        const dns = new StaticDnsResolver();
        const key = (overrides: any = {}) => ({ useType: "encrypt", type: "x509", publicKey: "S0VZ", notAfter: Date.now() + 60_000, ...overrides });
        const send = async (keys: any[], encryptPreference?: any) =>
            (await prepareOutboundMime({ raw, message, mailbox: mailbox({ keys, encryptPreference }), objectFactory: factoryWithDomains(), domainClass: class H {}, dnsResolver: dns })).raw.toString();

        expect(await send([key()], { preferEncrypt: "mutual" })).toMatch(/^RapidMX-Key: addr=sender@example.com; prefer-encrypt=mutual; type=x509; keydata=S0VZ\r\n/);
        expect(await send([key()])).toContain("prefer-encrypt=nopreference");
        expect(await send([key({ revokedAt: Date.now() - 1 }), key({ notAfter: Date.now() - 1 }), key({ useType: "sign" })])).toBe(raw.toString());
        expect((await prepareOutboundMime({ raw, message, mailbox: { ...mailbox(), keys: null }, objectFactory: factoryWithDomains(), domainClass: class I {}, dnsResolver: dns })).raw).toBe(raw);
    });

    it("seeds one tracking row per distinct recipient, case variants collapsed", () => {
        expect(seedReceiptStatus(["A@Example.com", "b@example.com", "a@example.com"])).toEqual([
            { recipientAddress: "a@example.com" },
            { recipientAddress: "b@example.com" },
        ]);
        expect(seedReceiptStatus([])).toEqual([]);
    });
});
