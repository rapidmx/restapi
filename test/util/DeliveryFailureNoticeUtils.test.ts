///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the delivery failure notice generator and filer. The filing is exercised end to end against real
// MongoDB and SQL in the send, scheduled-send and ingest suites; here the repos are hand-built so the races and retries
// a real datastore can't be made to produce on demand are covered too.
vi.mock("../../src/util/FolderUtils.js", () => ({
    findOrCreateWellKnownFolder: vi.fn(),
}));

import { simpleParser } from "mailparser";
import { findOrCreateWellKnownFolder } from "../../src/util/FolderUtils.js";
import {
    buildDeliveryFailureNotice,
    type DeliveryFailureNoticeInput,
    deliveryFailureKey,
    deliveryFailureUid,
    describeOriginal,
    fileDeliveryFailureNotice,
    MAX_NOTICE_HEADER_BYTES,
    MAX_NOTICE_RECIPIENTS,
    originalHeaderBlock,
    tryFileDeliveryFailureNotice,
} from "../../src/util/DeliveryFailureNoticeUtils.js";
import { InMemoryBlobStore } from "../testDoubles.js";

const NOW = new Date("2026-09-20T07:00:00Z");

/** The body of the MIME part of `raw` whose Content-Type starts with `type`. */
function partOf(raw: Buffer, type: string): string {
    const text = raw.toString("utf8");
    const boundary = text.match(/boundary="([^"]+)"/)![1];
    const part = text.split("--" + boundary).find((candidate) => candidate.trimStart().startsWith("Content-Type: " + type))!;
    return part.slice(part.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
}

function input(over: Partial<DeliveryFailureNoticeInput> = {}): DeliveryFailureNoticeInput {
    return {
        mailboxUid: "mailbox-1",
        mailboxAddress: "jp@example.com",
        key: "send-partial:message-1",
        original: {
            subject: "Q3 plan",
            messageId: "orig-1@example.com",
            date: new Date("2026-09-19T22:00:00Z"),
            headers: "From: jp@example.com\r\nTo: bob@example.net\r\nSubject: Q3 plan",
        },
        failures: [
            {
                address: "bob@example.net",
                code: 554,
                enhancedCode: "5.7.1",
                response: "554 5.7.1 <bob@example.net>: Recipient address rejected: Access denied",
                command: "RCPT TO",
                temporary: false,
            },
        ],
        now: NOW,
        ...over,
    };
}

describe("deliveryFailureKey()/deliveryFailureUid()", () => {
    it("Joins the parts, and derives the same uid for the same mailbox and key but not another.", () => {
        expect(deliveryFailureKey("dropped", "<a@b>", "c@d")).toBe("dropped:<a@b>:c@d");
        expect(deliveryFailureUid("m1", "k")).toBe(deliveryFailureUid("m1", "k"));
        expect(deliveryFailureUid("m1", "k")).not.toBe(deliveryFailureUid("m2", "k"));
        expect(deliveryFailureUid("m1", "k")).not.toBe(deliveryFailureUid("m1", "k2"));
        expect(deliveryFailureUid("m1", "k")).toMatch(/^[0-9a-f-]{36}$/);
    });
});

describe("originalHeaderBlock()", () => {
    it("Keeps the header block only, dropping Bcc (folded lines too) and non-ASCII bytes.", () => {
        const raw = Buffer.from(
            "From: jp@example.com\r\nBcc: secret@example.com,\r\n other@example.com\r\nSubject: café\r\n folded\r\nTo: bob@example.net\r\n\r\nBody text",
            "utf8",
        );

        expect(originalHeaderBlock(raw)).toBe("From: jp@example.com\r\nSubject: caf??\r\n folded\r\nTo: bob@example.net");
    });

    it("Copes with LF-only line endings and a message that is all header, and cuts a huge block.", () => {
        expect(originalHeaderBlock(Buffer.from("From: a@b.c\nSubject: x\n\nbody"))).toBe("From: a@b.c\r\nSubject: x");
        expect(originalHeaderBlock(Buffer.from("From: a@b.c"))).toBe("From: a@b.c");
        expect(originalHeaderBlock(Buffer.from("X-Big: " + "y".repeat(40_000)))).toHaveLength(MAX_NOTICE_HEADER_BYTES);
    });
});

describe("describeOriginal()", () => {
    const blobStore = new InMemoryBlobStore();

    it("Reads the header block and Message-ID out of the stored source, stripping the brackets.", async () => {
        await blobStore.put("b1", Buffer.from("Message-ID: <stored-1@example.com>\r\nSubject: Hi\r\n\r\nBody"));

        const original = await describeOriginal(blobStore, {
            subject: "Hi",
            sentDate: new Date("2026-09-19T22:00:00Z"),
            conversationId: "conv-1",
            bodyBlobKey: "b1",
        });

        expect(original).toEqual({
            subject: "Hi",
            messageId: "stored-1@example.com",
            date: new Date("2026-09-19T22:00:00Z"),
            conversationId: "conv-1",
            headers: "Message-ID: <stored-1@example.com>\r\nSubject: Hi",
        });
    });

    it("Prefers a Message-ID it is given, then the message's own, and a raw source it is given over the stored one.", async () => {
        await blobStore.put("b2", Buffer.from("Message-ID: <stored@example.com>\r\n\r\n"));

        expect((await describeOriginal(blobStore, { bodyBlobKey: "b2", messageId: "row@example.com" }, { messageId: "<given@example.com>" })).messageId).toBe(
            "given@example.com",
        );
        expect((await describeOriginal(blobStore, { bodyBlobKey: "b2", messageId: "row@example.com" })).messageId).toBe("row@example.com");
        const viaRaw = await describeOriginal(blobStore, { bodyBlobKey: "b2" }, { raw: Buffer.from("Message-ID: <raw@example.com>\r\nX: y\r\n\r\n") });
        expect(viaRaw).toMatchObject({ messageId: "raw@example.com", headers: "Message-ID: <raw@example.com>\r\nX: y" });
    });

    it("Still describes the message when its source can't be read, or it has none, or no Message-ID at all.", async () => {
        expect(await describeOriginal(blobStore, { subject: "Gone", bodyBlobKey: "missing" })).toEqual({
            subject: "Gone",
            messageId: undefined,
            date: undefined,
            conversationId: undefined,
            headers: undefined,
        });
        expect((await describeOriginal(blobStore, { subject: "No blob" })).headers).toBeUndefined();
        await blobStore.put("b3", Buffer.from("Subject: x\r\n\r\n"));
        expect((await describeOriginal(blobStore, { bodyBlobKey: "b3" })).messageId).toBeUndefined();
    });
});

describe("buildDeliveryFailureNotice()", () => {
    it("Composes an RFC 3464 report from the mailbox's domain that no auto-responder will answer.", async () => {
        const notice = await buildDeliveryFailureNotice(input());
        const raw = notice.raw.toString("utf8");
        const parsed = await simpleParser(notice.raw);

        expect(notice.from).toBe("postmaster@example.com");
        expect(notice.subject).toBe("Undeliverable: Q3 plan");
        expect(notice.messageId).toMatch(/^[0-9a-f-]{36}@example\.com$/);
        expect(notice.preview).toBe(
            "Delivery to bob@example.net failed: 554 5.7.1 <bob@example.net>: Recipient address rejected: Access denied",
        );
        expect(raw).toContain("Return-Path: <>");
        expect(raw).toMatch(/Content-Type: multipart\/report; report-type=delivery-status;/);
        expect(raw).toContain("Auto-Submitted: auto-replied");
        expect(raw).toContain("X-Auto-Response-Suppress: All");
        expect(parsed.from?.value[0]).toMatchObject({ name: "Mail Delivery System", address: "postmaster@example.com" });
        expect(parsed.to).toMatchObject({ value: [{ address: "jp@example.com" }] });
        expect(parsed.subject).toBe("Undeliverable: Q3 plan");
        expect(parsed.messageId).toBe(`<${notice.messageId}>`);
        expect(parsed.inReplyTo).toBe("<orig-1@example.com>");
        expect(parsed.references).toBe("<orig-1@example.com>");
        expect(parsed.date).toEqual(NOW);
    });

    it("Explains in plain words who it failed for, with the status, the server's response and the command.", async () => {
        const notice = await buildDeliveryFailureNotice(input({ transport: "postfix-sendmail" }));
        const parsed = await simpleParser(notice.raw);

        expect(parsed.text).toContain("This is the mail system at example.com.");
        expect(parsed.text).toContain("Your message could not be delivered to this recipient. The mail system will not try again.");
        expect(parsed.text).toContain("Subject:    Q3 plan");
        expect(parsed.text).toContain("Sent:       Sat, 19 Sep 2026 22:00:00 GMT");
        expect(parsed.text).toContain("Message-ID: <orig-1@example.com>");
        expect(parsed.text).toContain("bob@example.net");
        expect(parsed.text).toContain("Status:           5.7.1 (permanent failure)");
        expect(parsed.text).toContain("SMTP reply code:  554");
        expect(parsed.text).toContain("Server response:  554 5.7.1 <bob@example.net>: Recipient address rejected: Access denied");
        expect(parsed.text).toContain("Command:          RCPT TO");
        expect(parsed.text).toContain("Transport:   postfix-sendmail");
        expect(parsed.text).toContain("its body is not included");
    });

    it("Carries a message/delivery-status part with the recipient's action, status and diagnostic code, and the original headers.", async () => {
        const notice = await buildDeliveryFailureNotice(
            input({
                failures: [
                    { address: "bob@example.net", code: 554, enhancedCode: "5.7.1", response: "554 5.7.1 denied\nsecond line" },
                    { address: "carol@example.net", temporary: true, response: "connect refused" },
                    { address: "dave@example.net", code: 452 },
                    { address: "erin@example.net", stderr: "sendmail: fatal: badé" },
                    { address: "frank@example.net" },
                ],
            }),
        );
        const parsed = await simpleParser(notice.raw);
        const status = partOf(notice.raw, "message/delivery-status");
        const headers = partOf(notice.raw, "text/rfc822-headers");

        expect(status).toBe(
            [
                "Reporting-MTA: dns; example.com",
                "Arrival-Date: Sat, 19 Sep 2026 22:00:00 GMT",
                "",
                "Final-Recipient: rfc822; bob@example.net",
                "Action: failed",
                "Status: 5.7.1",
                "Diagnostic-Code: smtp; 554 5.7.1 denied second line",
                "Last-Attempt-Date: Sun, 20 Sep 2026 07:00:00 GMT",
                "",
                "Final-Recipient: rfc822; carol@example.net",
                "Action: failed",
                "Status: 4.0.0",
                "Diagnostic-Code: X-RapidMX; connect refused",
                "Last-Attempt-Date: Sun, 20 Sep 2026 07:00:00 GMT",
                "",
                "Final-Recipient: rfc822; dave@example.net",
                "Action: failed",
                "Status: 4.0.0",
                "Last-Attempt-Date: Sun, 20 Sep 2026 07:00:00 GMT",
                "",
                "Final-Recipient: rfc822; erin@example.net",
                "Action: failed",
                "Status: 5.0.0",
                "Diagnostic-Code: X-RapidMX; sendmail: fatal: bad?",
                "Last-Attempt-Date: Sun, 20 Sep 2026 07:00:00 GMT",
                "",
                "Final-Recipient: rfc822; frank@example.net",
                "Action: failed",
                "Status: 5.0.0",
                "Last-Attempt-Date: Sun, 20 Sep 2026 07:00:00 GMT",
                "",
            ].join("\r\n"),
        );
        expect(headers).toBe("From: jp@example.com\r\nTo: bob@example.net\r\nSubject: Q3 plan");
    });

    it("Says whether it was temporary, how often it was tried, and the reason and transport error in words.", async () => {
        const notice = await buildDeliveryFailureNotice(
            input({
                failures: [{ address: "bob@example.net", temporary: true, stderr: "sendmail: fatal: queue full\nline two" }],
                error: { message: "Sendmail exited with code 75", code: "ESENDMAIL", exitCode: 75, responseCode: 451, requestId: "req-9" },
                reason: "Gave up after 5 attempts: Sendmail exited with code 75",
                attempts: 5,
                transport: "postfix-sendmail",
            }),
        );
        const text = (await simpleParser(notice.raw)).text!;

        expect(text).toContain("the failure looked temporary, but delivery was still failing after 5 attempts, so the mail system has given up.");
        expect(text).toContain("Reason: Gave up after 5 attempts: Sendmail exited with code 75");
        expect(text).toContain("Status:           4.0.0 (temporary failure)");
        expect(text).toContain("Delivery agent output:");
        expect(text).toContain("      sendmail: fatal: queue full\n      line two");
        expect(text).toContain("Error:       Sendmail exited with code 75 (ESENDMAIL)");
        expect(text).toContain("Exit status: 75");
        expect(text).toContain("Reply code:  451");
        expect(text).toContain("Request id:  req-9");
    });

    it("Says a temporary failure was given up on even with no attempt count, and lists several recipients.", async () => {
        const text = (
            await simpleParser(
                (await buildDeliveryFailureNotice(input({ failures: [{ address: "a@x.net", temporary: true }, { address: "b@x.net", temporary: true }] }))).raw,
            )
        ).text!;

        expect(text).toContain("to these recipients - the failure looked temporary, but the mail system has given up.");
    });

    it("Does not repeat delivery agent output that is also the server response, and leaves an absent status line out.", async () => {
        const text = (await simpleParser((await buildDeliveryFailureNotice(input({ failures: [{ address: "a@x.net", response: "same", stderr: "same" }] }))).raw)).text!;

        expect(text).not.toContain("Delivery agent output");
        expect(text).toContain("Server response:  same");
        expect(text).not.toContain("SMTP reply code");
        expect(text).not.toContain("Command:");
        expect(text).not.toContain("Technical details");
    });

    it("Lists at most MAX_NOTICE_RECIPIENTS recipients and counts the rest.", async () => {
        const failures = Array.from({ length: MAX_NOTICE_RECIPIENTS + 7 }, (_, i) => ({ address: `user${i}@example.net`, response: "no" }));
        const notice = await buildDeliveryFailureNotice(input({ failures }));
        const parsed = await simpleParser(notice.raw);
        const status = partOf(notice.raw, "message/delivery-status");

        expect(parsed.text).toContain("...and 7 more");
        expect(parsed.text).toContain(`user${MAX_NOTICE_RECIPIENTS - 1}@example.net`);
        expect(parsed.text).not.toContain(`user${MAX_NOTICE_RECIPIENTS}@example.net`);
        expect(status.match(/Final-Recipient/g)).toHaveLength(MAX_NOTICE_RECIPIENTS);
    });

    it("Copes with a message that has no subject, date, Message-ID or headers, and with no failures at all.", async () => {
        const notice = await buildDeliveryFailureNotice({
            mailboxUid: "m",
            mailboxAddress: "jp",
            key: "k",
            original: {},
            failures: [],
            reason: "The message has no recipients.",
            now: NOW,
        });
        const parsed = await simpleParser(notice.raw);

        expect(notice.from).toBe("postmaster@localhost");
        expect(notice.subject).toBe("Undeliverable: your message");
        expect(notice.preview).toBe("Delivery to the recipient failed: The message has no recipients.");
        expect(parsed.inReplyTo).toBeUndefined();
        expect(parsed.text).toContain("Subject:    (no subject)");
        expect(parsed.text).not.toContain("Sent:");
        expect(parsed.text).not.toContain("Message-ID: <");
        expect(parsed.text).toContain("Reason: The message has no recipients.");
        const empty = await buildDeliveryFailureNotice({ ...input({ original: {}, failures: [] }), reason: undefined, error: undefined });
        expect(empty.preview).toBe("Delivery to the recipient failed: delivery failed");
    });

    it("Keeps a header-breaking subject on one line and bounded.", async () => {
        const notice = await buildDeliveryFailureNotice(input({ original: { subject: "line one\r\nBcc: attacker@example.org " + "z".repeat(400) } }));
        const parsed = await simpleParser(notice.raw);

        expect(notice.subject.length).toBeLessThanOrEqual(250);
        expect(notice.raw.toString().split("\r\n\r\n")[0]).not.toMatch(/^Bcc:/m);
        expect(parsed.bcc).toBeUndefined();
        expect(parsed.subject).toBe(notice.subject);
    });

    it("Defaults its date to now.", async () => {
        const notice = await buildDeliveryFailureNotice({ ...input(), now: undefined });

        expect(Math.abs((await simpleParser(notice.raw)).date!.getTime() - Date.now())).toBeLessThan(60_000);
    });
});

describe("fileDeliveryFailureNotice()", () => {
    const inbox = { uid: "inbox-1", version: 3, unreadCount: 4, totalCount: 9, syncKeyVersion: 7 };
    const findOrCreate = findOrCreateWellKnownFolder as unknown as ReturnType<typeof vi.fn>;
    let blobStore: InMemoryBlobStore;
    let messageRepo: any;
    let folderRepo: any;
    let notificationUtils: any;
    let logger: any;
    let sink: any;

    class MessageClass {
        constructor(public fields: any) {
            Object.assign(this, fields);
        }
    }

    beforeEach(() => {
        blobStore = new InMemoryBlobStore();
        messageRepo = {
            findOne: vi.fn().mockResolvedValue(undefined),
            create: vi.fn().mockImplementation(async (message: any) => message),
        };
        folderRepo = {
            update: vi.fn().mockResolvedValue(undefined),
            findOne: vi.fn(),
            instantiateObject: vi.fn((fields: any) => fields),
        };
        notificationUtils = { sendMessage: vi.fn() };
        logger = { warn: vi.fn() };
        findOrCreate.mockReset().mockResolvedValue({ ...inbox });
        sink = { messageRepo, messageClass: MessageClass, folderRepo, folderClass: class {}, blobStore, notificationUtils, logger };
    });

    it("Files the notice unread in the Inbox under a uid derived from its key, stores its source, bumps the Inbox and notifies clients.", async () => {
        const message = await fileDeliveryFailureNotice(sink, input());
        const uid = deliveryFailureUid("mailbox-1", "send-partial:message-1");

        expect(message.fields).toMatchObject({
            uid,
            folderUid: "inbox-1",
            mailboxUid: "mailbox-1",
            subject: "Undeliverable: Q3 plan",
            from: { address: "postmaster@example.com", displayName: "Mail Delivery System", type: "to" },
            recipients: [{ address: "jp@example.com", type: "to" }],
            bodyBlobKey: `notices/${uid}`,
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            importance: "high",
            inReplyTo: "orig-1@example.com",
            references: ["orig-1@example.com"],
            conversationId: "orig-1@example.com",
            hasAttachments: false,
            labelUids: [],
        });
        expect(message.fields.bodyPreview).toContain("bob@example.net");
        expect((await blobStore.get(`notices/${uid}`)).toString()).toContain("Final-Recipient: rfc822; bob@example.net");
        expect(findOrCreate).toHaveBeenCalledWith(folderRepo, sink.folderClass, "mailbox-1", "inbox");
        expect(folderRepo.update).toHaveBeenCalledWith(
            { uid: "inbox-1", version: 3, unreadCount: 5, totalCount: 10, syncKeyVersion: 8 },
            expect.anything(),
            { ignoreACL: true },
        );
        expect(notificationUtils.sendMessage).toHaveBeenCalledWith("inbox-1", "MessageClass", "create", message);
    });

    it("Joins the original's conversation when it has one, starts its own when the original has no Message-ID, and needs no notifier.", async () => {
        const joined = await fileDeliveryFailureNotice(sink, input({ original: { messageId: "orig-1@example.com", conversationId: "root-1@example.com" } }));
        expect(joined.fields.conversationId).toBe("root-1@example.com");

        const alone = await fileDeliveryFailureNotice({ ...sink, notificationUtils: undefined }, input({ key: "other", original: {} }));
        expect(alone.fields.inReplyTo).toBeUndefined();
        expect(alone.fields.references).toEqual([]);
        expect(alone.fields.conversationId).toBe(alone.fields.messageId);
    });

    it("Files nothing again for a failure it has already reported - even one whose notice was deleted.", async () => {
        messageRepo.findOne.mockResolvedValue({ uid: "existing", deleted: true });

        expect(await fileDeliveryFailureNotice(sink, input())).toBeUndefined();
        expect(messageRepo.findOne).toHaveBeenCalledWith(deliveryFailureUid("mailbox-1", "send-partial:message-1"), { ignoreACL: true, includeDeleted: true });
        expect(messageRepo.create).not.toHaveBeenCalled();
        expect(notificationUtils.sendMessage).not.toHaveBeenCalled();
        expect(folderRepo.update).not.toHaveBeenCalled();
    });

    it("Files nothing when a concurrent filer of the same failure wins the uid, and rethrows any other create failure.", async () => {
        messageRepo.findOne.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ uid: "winner" });
        messageRepo.create.mockRejectedValueOnce(new Error("duplicate key"));
        expect(await fileDeliveryFailureNotice(sink, input())).toBeUndefined();
        expect(notificationUtils.sendMessage).not.toHaveBeenCalled();

        messageRepo.findOne.mockReset().mockResolvedValue(undefined);
        messageRepo.create.mockRejectedValueOnce(new Error("datastore down"));
        await expect(fileDeliveryFailureNotice(sink, input())).rejects.toThrow("datastore down");
    });

    it("Re-reads the Inbox and retries bumping its counters when another writer changed it first.", async () => {
        folderRepo.update.mockRejectedValueOnce(new Error("version conflict")).mockResolvedValueOnce(undefined);
        folderRepo.findOne.mockResolvedValue({ ...inbox, version: 4, unreadCount: 6, totalCount: 11, syncKeyVersion: 9 });

        await fileDeliveryFailureNotice(sink, input());

        expect(folderRepo.update).toHaveBeenCalledTimes(2);
        expect(folderRepo.update).toHaveBeenLastCalledWith(
            { uid: "inbox-1", version: 4, unreadCount: 7, totalCount: 12, syncKeyVersion: 10 },
            expect.anything(),
            { ignoreACL: true },
        );
    });

    it("Gives up bumping the counters when the Inbox is unchanged (a real failure), and after five conflicts.", async () => {
        folderRepo.update.mockRejectedValue(new Error("write failed"));
        folderRepo.findOne.mockResolvedValue({ ...inbox });
        await expect(fileDeliveryFailureNotice(sink, input())).rejects.toThrow("write failed");
        expect(folderRepo.update).toHaveBeenCalledTimes(1);

        folderRepo.update.mockReset().mockRejectedValue(new Error("always conflicting"));
        let version = 3;
        folderRepo.findOne.mockImplementation(async () => ({ ...inbox, version: ++version }));
        messageRepo.findOne.mockResolvedValue(undefined);
        await expect(fileDeliveryFailureNotice(sink, input({ key: "again" }))).rejects.toThrow("always conflicting");
        expect(folderRepo.update).toHaveBeenCalledTimes(5);

        folderRepo.update.mockReset().mockRejectedValue(new Error("gone"));
        folderRepo.findOne.mockResolvedValue(undefined);
        await expect(fileDeliveryFailureNotice(sink, input({ key: "gone" }))).rejects.toThrow("gone");
    });
});

describe("tryFileDeliveryFailureNotice()", () => {
    const findOrCreate = findOrCreateWellKnownFolder as unknown as ReturnType<typeof vi.fn>;

    class MessageClass {
        constructor(public fields: any) {
            Object.assign(this, fields);
        }
    }

    const makeSink = (over: any = {}) => ({
        messageRepo: { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockImplementation(async (m: any) => m) },
        messageClass: MessageClass,
        folderRepo: { update: vi.fn() },
        folderClass: class {},
        blobStore: new InMemoryBlobStore(),
        logger: { warn: vi.fn() },
        ...over,
    });

    beforeEach(() => {
        findOrCreate.mockReset().mockResolvedValue({ uid: "inbox-1", version: 1, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 });
    });

    it("Files what build() describes and returns the message.", async () => {
        const sink = makeSink();

        const message = await tryFileDeliveryFailureNotice(sink, "message 1", async () => input());

        expect(message.fields.subject).toBe("Undeliverable: Q3 plan");
        expect(sink.logger.warn).not.toHaveBeenCalled();
    });

    it("Files nothing when there is nobody to tell.", async () => {
        const sink = makeSink();

        expect(await tryFileDeliveryFailureNotice(sink, "message 1", async () => undefined)).toBeUndefined();
        expect(sink.messageRepo.create).not.toHaveBeenCalled();
    });

    it("Logs and swallows whatever goes wrong reading what the notice needs, or filing it - with or without a logger.", async () => {
        const sink = makeSink();
        expect(
            await tryFileDeliveryFailureNotice(sink, "message 1", async () => {
                throw new Error("mailbox lookup failed");
            }),
        ).toBeUndefined();
        expect(sink.logger.warn).toHaveBeenCalledWith("Failed to file the delivery failure notice for message 1: mailbox lookup failed");

        sink.messageRepo.create.mockRejectedValue(new Error("datastore down"));
        expect(await tryFileDeliveryFailureNotice(sink, "message 2", async () => input())).toBeUndefined();
        expect(sink.logger.warn).toHaveBeenLastCalledWith("Failed to file the delivery failure notice for message 2: datastore down");

        const quiet = makeSink({ logger: undefined });
        expect(
            await tryFileDeliveryFailureNotice(quiet, "message 3", async () => {
                throw Object.assign(new Error("not an Error instance"), { message: undefined });
            }),
        ).toBeUndefined();
    });
});
