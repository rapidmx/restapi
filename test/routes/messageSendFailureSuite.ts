///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What `POST /messages/:id/send` tells the sender when the mail transport refuses the message - identical on both
// backends. `test/routes/{mongo,sql}/MessageSendFailure.test.ts` supply a server with the `RecordingMailTransport` test
// double, which refuses `reject@example.com` outright and `partial-reject@example.com` alone, with Postfix-style diagnostics.
import { request } from "@rapidrest/service-core/test";
import { simpleParser } from "mailparser";
import { FolderType } from "../../src/models/types.js";
import type { InMemoryBlobStore, RecordingMailTransport } from "../testDoubles.js";

export interface MessageSendFailureSuiteContext {
    app: () => any;
    baseUrl: string;
    ownerToken: string;
    ownerUid: string;
    blobStore: () => InMemoryBlobStore;
    transport: () => RecordingMailTransport;
    createMailbox: (ownerUid: string) => Promise<any>;
    createFolder: (mailboxUid: string, type: FolderType) => Promise<any>;
    createMessage: (mailboxUid: string, folderUid: string, data?: any) => Promise<any>;
    /** Every message in the mailbox's folder of this type (none when the folder doesn't exist). */
    messagesIn: (mailboxUid: string, type: FolderType) => Promise<any[]>;
    findMessage: (uid: string) => Promise<any>;
    findFolder: (mailboxUid: string, type: FolderType) => Promise<any | undefined>;
}

export function messageSendFailureSuite(ctx: MessageSendFailureSuiteContext): void {
    const draftTo = async (recipients: string[], subject = "Q3 plan") => {
        const mailbox = await ctx.createMailbox(ctx.ownerUid);
        const drafts = await ctx.createFolder(mailbox.uid, FolderType.DRAFTS);
        const bodyBlobKey = `bodies/${Math.random().toString(16).slice(2)}`;
        await ctx.blobStore().put(
            bodyBlobKey,
            Buffer.from(`From: owner@example.com\r\nTo: ${recipients.join(", ")}\r\nBcc: hidden@example.com\r\nSubject: ${subject}\r\n\r\nHello there.\r\n`),
        );
        const message = await ctx.createMessage(mailbox.uid, drafts.uid, {
            bodyBlobKey,
            subject,
            recipients: recipients.map((address) => ({ address, type: "to" })),
        });
        return { mailbox, drafts, message };
    };
    const send = (uid: string) => request(ctx.app()).post(`${ctx.baseUrl}/${uid}/send`).set("Authorization", "jwt " + ctx.ownerToken);

    describe("send() when the transport refuses the message", () => {
        it("answers 502 with a sentence saying who was refused and why, and the mail system's own diagnostics in details", async () => {
            const { message } = await draftTo(["reject@example.com"]);

            const result = await send(message.uid);

            expect(result.status).toBe(502);
            expect(result.body.status).toBe(502);
            expect(result.body.message).toBe(
                "This message could not be sent: the mail system refused it for reject@example.com. Reason given: 554 5.7.1 <reject@example.com>: Recipient address rejected: Access denied",
            );
            expect(result.body.details).toEqual({
                transport: "recording",
                recipients: ["reject@example.com"],
                accepted: [],
                rejected: ["reject@example.com"],
                failures: [
                    {
                        address: "reject@example.com",
                        code: 554,
                        enhancedCode: "5.7.1",
                        response: "554 5.7.1 <reject@example.com>: Recipient address rejected: Access denied",
                        command: "RCPT TO",
                        temporary: false,
                    },
                ],
                error: { message: "The recording transport refused the message.", code: "EREJECT", command: "RCPT TO" },
            });
        });

        it("leaves the message in Drafts, releasing its claim, sends it to nobody, and files no notice - the caller is told directly", async () => {
            const { mailbox, drafts, message } = await draftTo(["reject@example.com"]);

            await send(message.uid);

            const after = await ctx.findMessage(message.uid);
            expect(after.folderUid).toBe(drafts.uid);
            expect(after.scheduledSendLeaseExpiresAt).toBeFalsy();
            expect(after.scheduledSendRelayedAt).toBeFalsy();
            expect(ctx.transport().sent).toEqual([]);
            expect(await ctx.messagesIn(mailbox.uid, FolderType.SENT_ITEMS)).toEqual([]);
            expect(await ctx.messagesIn(mailbox.uid, FolderType.INBOX)).toEqual([]);
        });

        it("names every refused recipient when the whole message is refused", async () => {
            const { message } = await draftTo(["reject@example.com", "other@example.com"]);

            const result = await send(message.uid);

            expect(result.status).toBe(502);
            expect(result.body.details.failures.map((failure: any) => failure.address)).toEqual(["reject@example.com", "other@example.com"]);
            expect(result.body.message).toContain("reject@example.com, other@example.com");
        });
    });

    describe("send() when the transport refuses only some recipients", () => {
        it("relays to the others, files the message in Sent Items and answers 200", async () => {
            const { message } = await draftTo(["ok@example.com", "partial-reject@example.com"]);

            const result = await send(message.uid);

            expect(result.status).toBe(200);
            expect(ctx.transport().sent.map((sent) => sent.envelopeTo)).toEqual([["ok@example.com"]]);
        });

        it("files a delivery failure notice in the sender's Inbox, unread, naming the refused recipient with the server's response", async () => {
            const { mailbox, message } = await draftTo(["ok@example.com", "partial-reject@example.com"], "Q3 plan");

            await send(message.uid);

            const notices = await ctx.messagesIn(mailbox.uid, FolderType.INBOX);
            expect(notices).toHaveLength(1);
            const notice = notices[0];
            expect(notice.subject).toBe("Undeliverable: Q3 plan");
            expect(notice.from).toMatchObject({ address: "postmaster@example.com", displayName: "Mail Delivery System" });
            expect(notice.recipients.map((recipient: any) => recipient.address)).toEqual([mailbox.primarySmtpAddress]);
            expect(notice.flags.read).toBe(false);
            expect(notice.bodyPreview).toContain("partial-reject@example.com");
            expect(notice.inReplyTo).toBeTruthy();

            const raw = (await ctx.blobStore().get(notice.bodyBlobKey)).toString();
            const parsed = await simpleParser(raw);
            expect(raw).toMatch(/Content-Type: multipart\/report; report-type=delivery-status/);
            expect(raw).toContain("Auto-Submitted: auto-replied");
            expect(raw).toContain("Final-Recipient: rfc822; partial-reject@example.com");
            expect(raw).toContain("Status: 5.7.1");
            expect(raw).toContain("Diagnostic-Code: smtp; 554 5.7.1 <partial-reject@example.com>: Recipient address rejected: Access denied");
            expect(parsed.text).toContain("The mail system accepted this message for some of its recipients but refused these.");
            // The original's headers, without the blind copy.
            expect(raw).toContain("Subject: Q3 plan");
            expect(raw).not.toContain("hidden@example.com");
            expect(raw).not.toContain("Hello there.");
            // Only the one recipient it refused is listed as failed.
            expect(raw).not.toContain("Final-Recipient: rfc822; ok@example.com");

            const inbox = await ctx.findFolder(mailbox.uid, FolderType.INBOX);
            expect(inbox.unreadCount).toBe(1);
            expect(inbox.totalCount).toBe(1);
        });

        it("is not fooled into a notice when every recipient was accepted", async () => {
            const { mailbox, message } = await draftTo(["ok@example.com"]);

            await send(message.uid);

            expect(await ctx.messagesIn(mailbox.uid, FolderType.INBOX)).toEqual([]);
        });
    });
}
