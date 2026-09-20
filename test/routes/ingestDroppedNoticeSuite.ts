///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What `POST /internal/mta/deliver` does for the sender when a recipient of a message a local mailbox sent resolves to
// nothing - identical on both backends. `test/routes/{mongo,sql}/MailIngestRoute.test.ts` supply a server with the ingest
// route mounted, the shared test doubles registered and the internal bearer secret configured.
import { request } from "@rapidrest/service-core/test";
import { simpleParser } from "mailparser";
import { IngestStatus } from "../../src/models/types.js";
import { deliveryFailureKey, deliveryFailureUid } from "../../src/util/DeliveryFailureNoticeUtils.js";
import type { InMemoryBlobStore } from "../testDoubles.js";
import { DSN_DELAYED_450, DSN_ENVELOPE, DSN_EXPIRED_450, DSN_UNKNOWN_RECIPIENT_550 } from "../fixtures/postfixCapturedDsn.js";

export interface IngestDroppedNoticeSuiteContext {
    app: () => any;
    baseUrl: string;
    secret: string;
    blobStore: () => InMemoryBlobStore;
    createMailbox: (data?: any) => Promise<any>;
    /** Every ingest queue entry in the datastore. */
    entries: () => Promise<any[]>;
}

/**
 * What `POST /internal/mta/deliver` does with a genuine Postfix bounce, exactly as `@rapidmx/postfix-bridge` hands it over: the
 * null envelope sender `<>` arrives as a present-but-EMPTY `X-Envelope-From` header (`test/fixtures/postfixCapturedDsn.ts`).
 */
export function ingestBounceSuite(ctx: IngestDroppedNoticeSuiteContext): void {
    const forwarded = DSN_ENVELOPE.forwardedToIngest;
    const cases = [
        { name: "unknown recipient 550", raw: DSN_UNKNOWN_RECIPIENT_550 },
        { name: "expired 450", raw: DSN_EXPIRED_450 },
        { name: "delayed 450", raw: DSN_DELAYED_450 },
    ];

    describe("a Postfix bounce from the null sender", () => {
        for (const { name, raw } of cases) {
            it(`queues the ${name} notice for its addressee with an empty envelope sender - not a 4xx, not the From header - and answers 202`, async () => {
                const alice = await ctx.createMailbox({ primarySmtpAddress: forwarded["X-Envelope-To"] });

                const result = await request(ctx.app())
                    .post(`${ctx.baseUrl}/deliver`)
                    .set("Authorization", `Bearer ${ctx.secret}`)
                    .set("X-Envelope-From", forwarded["X-Envelope-From"])
                    .set("X-Envelope-To", forwarded["X-Envelope-To"])
                    .set("Content-Type", forwarded.contentType)
                    .send(raw);

                expect(result.status).toBe(202);
                expect(result.body.results).toEqual([{ rcpt: "alice@owned.lab", queued: true }]);
                const entries = await ctx.entries();
                expect(entries).toHaveLength(1);
                expect(entries[0]).toMatchObject({
                    mailboxUid: alice.uid,
                    envelopeFrom: "",
                    envelopeTo: ["alice@owned.lab"],
                    status: IngestStatus.PENDING,
                });
                expect((await ctx.blobStore().get(entries[0].rawBlobKey)).equals(raw)).toBe(true);
            });
        }

        it("treats a missing X-Envelope-From the same as an empty one", async () => {
            await ctx.createMailbox({ primarySmtpAddress: forwarded["X-Envelope-To"] });

            const result = await request(ctx.app())
                .post(`${ctx.baseUrl}/deliver`)
                .set("Authorization", `Bearer ${ctx.secret}`)
                .set("X-Envelope-To", forwarded["X-Envelope-To"])
                .set("Content-Type", forwarded.contentType)
                .send(DSN_UNKNOWN_RECIPIENT_550);

            expect(result.status).toBe(202);
            expect((await ctx.entries())[0]).toMatchObject({ envelopeFrom: "" });
        });

        it("is not itself bounced when its addressee does not exist - a bounce is never bounced", async () => {
            const result = await request(ctx.app())
                .post(`${ctx.baseUrl}/deliver`)
                .set("Authorization", `Bearer ${ctx.secret}`)
                .set("X-Envelope-From", "")
                .set("X-Envelope-To", "ghost@owned.lab")
                .set("Content-Type", "message/rfc822")
                .send(DSN_UNKNOWN_RECIPIENT_550);

            expect(result.status).toBe(202);
            expect(result.body.results).toEqual([{ rcpt: "ghost@owned.lab", queued: false }]);
            expect(await ctx.entries()).toEqual([]);
        });
    });
}

export function ingestDroppedNoticeSuite(ctx: IngestDroppedNoticeSuiteContext): void {
    const message = (headers: string[] = [], to = "nobody@example.com") =>
        Buffer.from(
            [
                "From: JP <owner@example.com>",
                `To: ${to}`,
                "Subject: Hello there",
                "Date: Sat, 19 Sep 2026 22:00:00 -0700",
                "Message-ID: <orig-1@example.com>",
                ...headers,
                "",
                "Secret body",
                "",
            ].join("\r\n"),
        );
    const deliver = (from: string, to: string[], raw: Buffer) =>
        request(ctx.app())
            .post(`${ctx.baseUrl}/deliver`)
            .set("Authorization", `Bearer ${ctx.secret}`)
            .set("X-Envelope-From", from)
            .set("X-Envelope-To", to.join(","))
            .set("Content-Type", "message/rfc822")
            .send(raw);

    describe("a dropped recipient of a message a local mailbox sent", () => {
        it("queues a delivery failure notice for the sender - a null-sender bounce naming the recipient - and still answers 202", async () => {
            const sender = await ctx.createMailbox({ primarySmtpAddress: "owner@example.com" });

            const result = await deliver("owner@example.com", ["nobody@example.com"], message());

            expect(result.status).toBe(202);
            expect(result.body.results).toEqual([{ rcpt: "nobody@example.com", queued: false }]);
            const entries = await ctx.entries();
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({
                mailboxUid: sender.uid,
                envelopeFrom: "",
                envelopeTo: ["owner@example.com"],
                status: IngestStatus.PENDING,
            });
            const raw: Buffer = await ctx.blobStore().get(entries[0].rawBlobKey);
            const text = raw.toString();
            expect(text).toMatch(/Content-Type: multipart\/report; report-type=delivery-status/);
            expect(text).toContain("Return-Path: <>");
            expect(text).toContain("Auto-Submitted: auto-replied");
            expect(text).toContain("Final-Recipient: rfc822; nobody@example.com");
            expect(text).toContain("Status: 5.1.1");
            expect(text).toContain("Diagnostic-Code: smtp; 550 5.1.1 <nobody@example.com>: Recipient address rejected: User unknown in this mail system");
            expect(text).toContain("Subject: Hello there");
            expect(text).not.toContain("Secret body");
            const parsed = await simpleParser(raw);
            expect(parsed.subject).toBe("Undeliverable: Hello there");
            expect(parsed.text).toContain("No mailbox or distribution list exists at nobody@example.com.");
            expect(parsed.text).toContain("Sent:       Sun, 20 Sep 2026 05:00:00 GMT");
            expect(parsed.inReplyTo).toBe("<orig-1@example.com>");
        });

        it("files it once per message and recipient - the MTA handing over the same transaction again adds nothing", async () => {
            await ctx.createMailbox({ primarySmtpAddress: "owner@example.com" });

            await deliver("owner@example.com", ["nobody@example.com"], message());
            await deliver("owner@example.com", ["nobody@example.com"], message());
            expect(await ctx.entries()).toHaveLength(1);

            await deliver("owner@example.com", ["someone-else@example.com"], message());
            expect(await ctx.entries()).toHaveLength(2);
        });

        it("derives the entry's uid from the mailbox, message and recipient, so a redelivery collides on it", async () => {
            const sender = await ctx.createMailbox({ primarySmtpAddress: "owner@example.com" });

            await deliver("owner@example.com", ["nobody@example.com"], message());

            expect((await ctx.entries())[0].uid).toBe(
                deliveryFailureUid(sender.uid, deliveryFailureKey("dropped", "<orig-1@example.com>", "nobody@example.com")),
            );
        });

        it("keys a message with no Message-ID by its content, and copes with a Date it can't read or no Subject", async () => {
            await ctx.createMailbox({ primarySmtpAddress: "owner@example.com" });
            const bare = Buffer.from("From: owner@example.com\r\nTo: nobody@example.com\r\nDate: not a date\r\n\r\nHi\r\n");

            await deliver("owner@example.com", ["nobody@example.com"], bare);
            await deliver("owner@example.com", ["nobody@example.com"], bare);

            const entries = await ctx.entries();
            expect(entries).toHaveLength(1);
            const parsed = await simpleParser(await ctx.blobStore().get(entries[0].rawBlobKey));
            expect(parsed.subject).toBe("Undeliverable: your message");
            expect(parsed.text).not.toContain("Sent:");
        });

        it("tells the sender's mailbox when they sent from one of its aliases, matched case-insensitively", async () => {
            const sender = await ctx.createMailbox({ primarySmtpAddress: "owner@example.com", aliasAddresses: ["alias@example.com"] });

            await deliver("Alias@Example.com", ["nobody@example.com"], message());

            const entries = await ctx.entries();
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ mailboxUid: sender.uid, envelopeTo: ["owner@example.com"] });
        });

        it("still queues the message for a recipient that does resolve, alongside the notice for one that doesn't", async () => {
            const sender = await ctx.createMailbox({ primarySmtpAddress: "owner@example.com" });
            const friend = await ctx.createMailbox({ primarySmtpAddress: "friend@example.com" });

            const result = await deliver("owner@example.com", ["friend@example.com", "nobody@example.com"], message([], "friend@example.com, nobody@example.com"));

            expect(result.body.results).toEqual([
                { rcpt: "friend@example.com", queued: true },
                { rcpt: "nobody@example.com", queued: false },
            ]);
            const entries = await ctx.entries();
            expect(entries.map((entry) => [entry.mailboxUid, entry.envelopeFrom]).sort()).toEqual(
                [
                    [friend.uid, "owner@example.com"],
                    [sender.uid, ""],
                ].sort(),
            );
        });

        it("says nothing when the sender is not one of this server's mailboxes", async () => {
            await ctx.createMailbox({ primarySmtpAddress: "owner@example.com" });

            const result = await deliver("stranger@elsewhere.example", ["nobody@example.com"], message());

            expect(result.status).toBe(202);
            expect(await ctx.entries()).toEqual([]);
        });

        it("says nothing to a null sender - a bounce is never bounced", async () => {
            await ctx.createMailbox({ primarySmtpAddress: "owner@example.com" });

            const result = await deliver("", ["nobody@example.com"], message());

            expect(result.status).toBe(202);
            expect(await ctx.entries()).toEqual([]);
        });

        it("says nothing for an automatically generated message, unless it says it isn't one", async () => {
            await ctx.createMailbox({ primarySmtpAddress: "owner@example.com" });

            await deliver("owner@example.com", ["nobody@example.com"], message(["Auto-Submitted: auto-replied"]));
            await deliver("owner@example.com", ["nobody@example.com"], message(["Auto-Submitted: auto-generated"]));
            expect(await ctx.entries()).toEqual([]);

            await deliver("owner@example.com", ["nobody@example.com"], message(["Auto-Submitted: No"]));
            expect(await ctx.entries()).toHaveLength(1);
        });

        it("never fails the delivery because the notice could not be queued", async () => {
            await ctx.createMailbox({ primarySmtpAddress: "owner@example.com" });
            const spy = vi.spyOn(ctx.blobStore(), "put").mockImplementation(async () => {
                throw new Error("blob store down");
            });

            try {
                const result = await deliver("owner@example.com", ["nobody@example.com"], message());

                expect(result.status).toBe(202);
                expect(result.body.results).toEqual([{ rcpt: "nobody@example.com", queued: false }]);
                expect(await ctx.entries()).toEqual([]);
            } finally {
                spy.mockRestore();
            }
        });
    });
}
