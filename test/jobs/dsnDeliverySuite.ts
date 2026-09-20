///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Inbound delivery status notifications (bounces) through `ScanQueueJob` - identical on both backends.
// `test/jobs/{mongo,sql}/ScanQueueJob*.test.ts` supply the real job over a real datastore, with the shared test doubles
// (a real `ScanPipeline` over always-clean spam/AV providers).
import { simpleParser } from "mailparser";
import { IngestStatus } from "../../src/models/types.js";
import { buildDeliveryFailureNotice } from "../../src/util/DeliveryFailureNoticeUtils.js";
import { postfixDsn } from "../fixtures/postfixDsn.js";
import { DSN_DELAYED_450, DSN_ENVELOPE, DSN_EXPIRED_450, DSN_UNKNOWN_RECIPIENT_550 } from "../fixtures/postfixCapturedDsn.js";

export interface DsnDeliverySuiteContext {
    blobStore: () => any;
    /** Stores `raw`, queues it as an ingest entry for the test mailbox (with `envelopeFrom` - `""` is the null sender - and,
     * when given, `envelopeTo`) and runs the job once. Returns the entry's uid. */
    ingest: (raw: Buffer, envelopeFrom: string, envelopeTo?: string[]) => Promise<string>;
    entryStatus: (uid: string) => Promise<IngestStatus>;
    /** Every message in the mailbox's Inbox. */
    inbox: () => Promise<any[]>;
    quarantined: () => Promise<any[]>;
    /** What the job relayed through the mail transport (an auto-reply, a forward...). */
    relayed: () => any[];
}

export function dsnDeliverySuite(ctx: DsnDeliverySuiteContext): void {
    describe("Inbound delivery status notifications (bounces)", () => {
        it("Files a Postfix bounce - null envelope sender, MAILER-DAEMON From, multipart/report - in the Inbox, unread and not quarantined", async () => {
            const uid = await ctx.ingest(postfixDsn({ to: "recipient@example.com" }), "");

            expect(await ctx.entryStatus(uid)).toBe(IngestStatus.DELIVERED);
            expect(await ctx.quarantined()).toEqual([]);
            const messages = await ctx.inbox();
            expect(messages).toHaveLength(1);
            const message = messages[0];
            expect(message.subject).toBe("Undelivered Mail Returned to Sender");
            // Its reader is shown who it is from - the From header's address, since the envelope has none.
            expect(message.from.address).toBe("MAILER-DAEMON@mail.example.com");
            expect(message.from.displayName).toBe("Mail Delivery System");
            expect(message.recipients.map((recipient: any) => recipient.address)).toContain("recipient@example.com");
            expect(message.flags.read).toBe(false);
            expect(message.encrypted).toBe(false);
            expect(message.messageId).toBe("20260920050005.3E23A2A11B3@mail.example.com");
        });

        it("Keeps the diagnostic text: the preview carries what the report says, and the stored source the whole notification", async () => {
            await ctx.ingest(postfixDsn({ to: "recipient@example.com", recipient: "carol@example.org" }), "");

            const message = (await ctx.inbox())[0];
            expect(message.bodyPreview).toBe("carol@example.org: failed (5.7.1) - 554 5.7.1 <carol@example.org>: Recipient address rejected: Access denied");
            const raw: string = (await ctx.blobStore().get(message.bodyBlobKey)).toString();
            expect(raw).toContain("Final-Recipient: rfc822; carol@example.org");
            expect(raw).toContain("Status: 5.7.1");
            expect(raw).toContain("Diagnostic-Code: smtp; 554 5.7.1 <carol@example.org>: Recipient address rejected:");
            // A client can render the whole report from the source.
            const parsed = await simpleParser(raw);
            expect(parsed.text).toContain("<carol@example.org>: host mx.example.net[192.0.2.25] said: 554 5.7.1");
        });

        it("Sanitizes an HTML notification for display without losing its diagnostic text", async () => {
            const html = "<p>Delivery to <b>bob@example.net</b> failed: <code>554 5.7.1 Access denied</code></p><script>alert(1)</script>";

            await ctx.ingest(postfixDsn({ to: "recipient@example.com", html }), "");

            const message = (await ctx.inbox())[0];
            expect(message.sanitizedHtmlBlobKey).toBeTruthy();
            const sanitized: string = (await ctx.blobStore().get(message.sanitizedHtmlBlobKey)).toString();
            expect(sanitized).toContain("554 5.7.1 Access denied");
            expect(sanitized).toContain("bob@example.net");
            expect(sanitized).not.toContain("<script");
            expect(sanitized).not.toContain("alert(1)");
        });

        describe("captured from a real Postfix (postfix-bridge lab, 2026-09-20)", () => {
            const envelopeTo: string[] = [...DSN_ENVELOPE.smtp.rcptTo];
            const cases = [
                { name: "unknown recipient 550 (failed)", raw: DSN_UNKNOWN_RECIPIENT_550, subject: "Undelivered Mail Returned to Sender", action: "Action: failed", status: "Status: 5.1.1", said: "said: 550 5.1.1", recipient: "nobody@refuse.lab", actionWord: "failed", statusCode: "5.1.1" },
                { name: "expired 450 (failed)", raw: DSN_EXPIRED_450, subject: "Undelivered Mail Returned to Sender", action: "Action: failed", status: "Status: 4.2.0", said: "said: 450 4.2.0", recipient: "tmp@defer.lab", actionWord: "failed", statusCode: "4.2.0" },
                { name: "delayed 450 (still being retried)", raw: DSN_DELAYED_450, subject: "Delayed Mail (still being retried)", action: "Action: delayed", status: "Status: 4.2.0", said: "said: 450 4.2.0", recipient: "tmp@defer.lab", actionWord: "delayed", statusCode: "4.2.0" },
            ];

            for (const { name, raw, subject, action, status, said, recipient, actionWord, statusCode } of cases) {
                it(`Files the ${name} notice from the null sender in the Inbox: unread, not quarantined, from MAILER-DAEMON, diagnostics intact`, async () => {
                    const uid = await ctx.ingest(raw, DSN_ENVELOPE.forwardedToIngest["X-Envelope-From"], envelopeTo);

                    expect(await ctx.entryStatus(uid)).toBe(IngestStatus.DELIVERED);
                    expect(await ctx.quarantined()).toEqual([]);
                    const messages = await ctx.inbox();
                    expect(messages).toHaveLength(1);
                    const message = messages[0];
                    expect(message.subject).toBe(subject);
                    expect(message.from).toMatchObject({ address: "MAILER-DAEMON@mail.owned.lab", displayName: "Mail Delivery System" });
                    expect(message.recipients.map((recipient: any) => recipient.address)).toEqual(["alice@owned.lab"]);
                    expect(message.flags.read).toBe(false);
                    expect(message.encrypted).toBe(false);
                    // The list preview is what the report says, not the notification's boilerplate that would fill it.
                    expect(message.bodyPreview.startsWith(`${recipient}: ${actionWord} (${statusCode}) - `)).toBe(true);
                    expect(message.bodyPreview).toContain(`<${recipient}>: Recipient`);
                    expect(message.bodyPreview).not.toContain("This is the mail system");
                    expect(ctx.relayed()).toEqual([]);

                    // The stored source is the notice exactly as Postfix wrote it, so a client can show the whole report.
                    const stored: Buffer = await ctx.blobStore().get(message.bodyBlobKey);
                    expect(stored.equals(raw)).toBe(true);
                    const parsed = await simpleParser(stored);
                    expect(parsed.text).toContain(said);
                    expect(parsed.text).toMatch(/Recipient (address rejected|temporarily unavailable)/);
                    const report = stored.toString().replace(/\r\n/g, "\n");
                    expect(report).toContain(action);
                    expect(report).toContain(status);
                });
            }

            it("Presents the delayed notice as not yet failed: Postfix's own warning is the message, and nothing marks it as a failure", async () => {
                await ctx.ingest(DSN_DELAYED_450, "", envelopeTo);

                const message = (await ctx.inbox())[0];
                expect(message.subject).toBe("Delayed Mail (still being retried)");
                expect(message.subject).not.toMatch(/undeliver|fail/i);
                expect(message.bodyPreview).toBe(
                    "tmp@defer.lab: delayed (4.2.0) - 450 4.2.0 <tmp@defer.lab>: Recipient temporarily unavailable, try again later",
                );
                expect(message.importance).not.toBe("high");
                // The whole notification - Postfix's warning that no resend is needed - is in the stored source.
                const parsed = await simpleParser(await ctx.blobStore().get(message.bodyBlobKey));
                expect(parsed.text).toContain("THIS IS A WARNING ONLY.  YOU DO NOT NEED TO RESEND YOUR MESSAGE.");
                expect(parsed.text).toContain("Will-Retry-Until: Sun, 20 Sep 2026 07:30:56 +0000 (UTC)");
            });

            it("Keeps the diagnostic lines readable in the plain-text body: the server's own words, unwrapped, unmangled", async () => {
                await ctx.ingest(DSN_UNKNOWN_RECIPIENT_550, "", envelopeTo);

                const message = (await ctx.inbox())[0];
                const parsed = await simpleParser(await ctx.blobStore().get(message.bodyBlobKey));
                expect(parsed.text).toContain(
                    "<nobody@refuse.lab>: host mx.refuse.lab[172.28.0.32] said: 550 5.1.1\n" +
                        "    <nobody@refuse.lab>: Recipient address rejected: User unknown in virtual\n" +
                        "    mailbox table (in reply to RCPT TO command)",
                );
                // A text-only notice has no HTML to sanitize: nothing is rewritten on the way to the reader.
                expect(message.sanitizedHtmlBlobKey).toBeFalsy();
            });
        });

        it("Sends no auto-reply or other message in response to a bounce", async () => {
            await ctx.ingest(postfixDsn({ to: "recipient@example.com" }), "");

            expect(ctx.relayed()).toEqual([]);
        });

        it("Files the notice this server writes for a failed send like any other bounce", async () => {
            const notice = await buildDeliveryFailureNotice({
                mailboxUid: "ignored",
                mailboxAddress: "recipient@example.com",
                key: "k",
                original: { subject: "Q3 plan", messageId: "orig-1@example.com", date: new Date("2026-09-19T22:00:00Z") },
                failures: [{ address: "bob@example.net", code: 550, enhancedCode: "5.1.1", response: "550 5.1.1 User unknown", temporary: false }],
            });

            const uid = await ctx.ingest(notice.raw, "");

            expect(await ctx.entryStatus(uid)).toBe(IngestStatus.DELIVERED);
            expect(await ctx.quarantined()).toEqual([]);
            const message = (await ctx.inbox())[0];
            expect(message.subject).toBe("Undeliverable: Q3 plan");
            expect(message.from).toMatchObject({ address: "postmaster@example.com", displayName: "Mail Delivery System" });
            expect(message.inReplyTo).toBe("orig-1@example.com");
            expect(message.bodyPreview).toBe("bob@example.net: failed (5.1.1) - 550 5.1.1 User unknown");
        });

        it("Still shows the envelope sender of an ordinary message as its sender, whatever its From header says", async () => {
            const raw = Buffer.from("From: header@example.org\r\nTo: recipient@example.com\r\nSubject: Ordinary\r\n\r\nHi\r\n");

            await ctx.ingest(raw, "envelope@example.net");

            expect((await ctx.inbox())[0].from.address).toBe("envelope@example.net");
        });

        it("Falls back to no address at all for a null-sender message that has no From header either", async () => {
            await ctx.ingest(Buffer.from("To: recipient@example.com\r\nSubject: Orphan\r\n\r\nHi\r\n"), "");

            expect((await ctx.inbox())[0].from.address).toBe("");
        });
    });
}
