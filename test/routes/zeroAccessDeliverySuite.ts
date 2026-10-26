///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Zero-access delivery (`specs/search.md` §3) end to end through `POST /internal/mta/deliver`, identical on both backends:
// `test/routes/{mongo,sql}/ZeroAccessDelivery.test.ts` supply a server with the ingest route mounted, the shared test doubles
// registered, and accessors for the rows it writes.
import "reflect-metadata";
import { createHash, webcrypto } from "node:crypto";
import { gunzipSync } from "node:zlib";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import * as x509 from "@peculiar/x509";
import { ACLAction, RepoUtils } from "@rapidrest/service-core";
import { request } from "@rapidrest/service-core/test";
import { IngestStatus, TransportRuleActionType, type ZeroAccessKey } from "../../src/models/types.js";
import type { InMemoryBlobStore, NoopSearchProvider } from "../testDoubles.js";
import { isoWeekId } from "../../src/zeroaccess/ZeroAccessSealer.js";
import { ZeroAccessWriter } from "../../src/zeroaccess/ZeroAccessWriter.js";
import { MailEventStream } from "../../src/events/MailEventStream.js";
import { postfixDsn } from "../fixtures/postfixDsn.js";
import { deliveryFailureUid } from "../../src/util/DeliveryFailureNoticeUtils.js";
import { nameBasedUuid } from "../../src/util/UuidUtils.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ENGINE = new pkijs.CryptoEngine({ name: "test", crypto: webcrypto as unknown as Crypto }) as unknown as pkijs.ICryptoEngine;

export interface ZeroAccessDeliverySuiteContext {
    app: () => any;
    baseUrl: string;
    secret: string;
    blobStore: () => InMemoryBlobStore;
    /** The registered search provider test double. */
    searchProvider: () => NoopSearchProvider;
    createMailbox: (data?: any) => Promise<any>;
    updateMailbox: (uid: string, fields: any) => Promise<void>;
    /** Saves the singleton `EncryptionPolicy` with `allowZeroAccess` (`undefined` leaves the row out entirely). */
    setAllowZeroAccess: (allow: boolean | undefined) => Promise<void>;
    /** Writes the mailbox's access list. */
    setAcl: (mailboxUid: string, records: { userOrRoleId: string; actions: string[] }[]) => Promise<void>;
    createTransportRule: (data: any) => Promise<any>;
    entries: () => Promise<any[]>;
    messages: () => Promise<any[]>;
    indexEntries: () => Promise<any[]>;
    quarantineEntries: () => Promise<any[]>;
    attachments: () => Promise<any[]>;
    calendarEvents: () => Promise<any[]>;
    /** Saves a `CalendarEvent` row with these fields over the backend's defaults. */
    createCalendarEvent: (data: any) => Promise<any>;
    /** The messages route, e.g. `/mongo/messages`. */
    messagesUrl: string;
    /** A token for `uid`. */
    tokenFor: (uid: string) => string;
    /** A folder of `mailboxUid`, with the access list the message route expects. */
    createFolder: (mailboxUid: string, type: string) => Promise<any>;
    createMessage: (data: any) => Promise<any>;
    createAttachment: (data: any) => Promise<any>;
    findMessage: (uid: string) => Promise<any>;
    /** The calendar event route, e.g. `/mongo/calendar-events`. */
    calendarEventsUrl: string;
    /** Runs one pass of `ZeroAccessBackfillJob`. */
    runBackfill: () => Promise<void>;
    /** Runs one pass of `ScheduledSendJob`. */
    runScheduledSend: () => Promise<void>;
    updateMessage: (uid: string, fields: object) => Promise<void>;
    /** Saves a `DataSubjectErasureRequest` for `mailboxUid` in `status`. */
    createErasureRequest: (mailboxUid: string, status: string) => Promise<any>;
}

interface Recipient {
    certificate: pkijs.Certificate;
    privateKey: CryptoKey;
    key: ZeroAccessKey;
}

/** A zero-access keypair for a mailbox: the `ZeroAccessKey` its row holds, and the private half to check what was sealed to it. */
async function makeKey(): Promise<Recipient> {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=za@example.com",
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        keys: keys as CryptoKeyPair,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    const der = Buffer.from(cert.rawData);
    const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
    const privateKey = (await webcrypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKey;
    return {
        certificate: new pkijs.Certificate({ schema: asn1js.fromBER(cert.rawData).result }),
        privateKey,
        key: {
            publicKey: der.toString("base64"),
            type: "x509",
            useType: "zero-access",
            fingerprint: createHash("sha256").update(der).digest("hex"),
            notBefore: Date.now() - 1000,
            notAfter: Date.now() + 86_400_000,
        },
    };
}

async function open(der: Buffer, recipient: Recipient): Promise<Buffer> {
    const contentInfo = new pkijs.ContentInfo({ schema: asn1js.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength)).result });
    const envelopedData = new pkijs.EnvelopedData({ schema: contentInfo.content });
    return Buffer.from(await envelopedData.decrypt(0, { recipientCertificate: recipient.certificate, recipientPrivateKey: recipient.privateKey }, ENGINE));
}

/** The sealed MIME blob's encrypted content, decrypted. */
async function openSealedMessage(blob: Buffer, recipient: Recipient): Promise<Buffer> {
    const body: string = blob.toString("latin1").split("\r\n\r\n")[1];
    return open(Buffer.from(body.replace(/\r\n/g, ""), "base64"), recipient);
}

const CANARY_SUBJECT = "Merger codename Bluebird";
const CANARY_BODY = "the acquisition closes on Friday";
const CANARY_ATTACHMENT = "board minutes attached";

function rawMessage(to: string): Buffer {
    return Buffer.from(
        [
            "From: Bob <bob@example.org>",
            `To: ${to}`,
            `Subject: ${CANARY_SUBJECT}`,
            "Date: Thu, 22 Oct 2026 10:00:00 +0000",
            "Message-ID: <za-1@example.org>",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="b1"',
            "",
            "--b1",
            "Content-Type: text/plain; charset=utf-8",
            "",
            `Hi, ${CANARY_BODY}.`,
            "--b1",
            'Content-Type: text/plain; name="minutes.txt"',
            'Content-Disposition: attachment; filename="minutes.txt"',
            "",
            CANARY_ATTACHMENT,
            "--b1--",
            "",
        ].join("\r\n"),
    );
}

/** A DKIM-verified (as this deployment's MTA would stamp it) message from bob@example.org carrying an iTIP `method` with `vevent` lines. */
function itipMessage(to: string, method: string, vevent: string[]): Buffer {
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", `METHOD:${method}`, "BEGIN:VEVENT", ...vevent, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    return Buffer.from(
        [
            "From: bob@example.org",
            `To: ${to}`,
            "Authentication-Results: mx.example.com; dkim=pass header.d=example.org",
            "Subject: Invitation",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="b2"',
            "",
            "--b2",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "You are invited.",
            "--b2",
            `Content-Type: text/calendar; method=${method}; name="invite.ics"`,
            'Content-Disposition: attachment; filename="invite.ics"',
            "",
            ics,
            "--b2--",
            "",
        ].join("\r\n"),
    );
}

export function zeroAccessDeliverySuite(ctx: ZeroAccessDeliverySuiteContext): void {
    const deliver = (to: string[], raw: Buffer) =>
        request(ctx.app())
            .post(`${ctx.baseUrl}/deliver`)
            .set("Authorization", `Bearer ${ctx.secret}`)
            .set("X-Envelope-From", "bob@example.org")
            .set("X-Envelope-To", to.join(","))
            .set("Content-Type", "message/rfc822")
            .send(raw);

    /** Every stored blob's key and content. */
    const blobs = (): [string, Buffer][] => [...((ctx.blobStore() as any).store as Map<string, Buffer>).entries()];

    const zeroAccessMailbox = async (recipient: Recipient, data: any = {}) => ctx.createMailbox({ zeroAccessKeys: [recipient.key], ...data });

    describe("zero-access delivery", () => {
        it("seals the message, its summary and its index entry to the mailbox's key, and stores no plaintext anywhere", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            const raw = rawMessage(mailbox.primarySmtpAddress);

            const result = await deliver([mailbox.primarySmtpAddress], raw);

            expect(result.status).toBe(202);
            const [entry] = await ctx.entries();
            expect(entry).toMatchObject({ mailboxUid: mailbox.uid, rawBlobKey: "", zeroAccessKeyFingerprint: recipient.key.fingerprint, status: IngestStatus.DELIVERED });

            const [message] = await ctx.messages();
            expect(message.subject).toBe("[...]");
            expect(message.bodyPreview).toBe("");
            expect(message.hasAttachments).toBe(true);
            expect(message.sanitizedHtmlBlobKey ?? undefined).toBeUndefined();
            expect(message.bodyBlobKey).toBe(`za/${mailbox.uid}/${message.uid}`);
            expect(message.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
            expect(await ctx.attachments()).toEqual([]);

            // The stored message is the original MIME, byte for byte, once decrypted.
            const sealed: Buffer = await ctx.blobStore().get(message.bodyBlobKey);
            expect((await openSealedMessage(sealed, recipient)).equals(raw)).toBe(true);
            const summary = JSON.parse((await open(Buffer.from(message.zeroAccess.sealedSummary, "base64"), recipient)).toString("utf-8"));
            expect(summary.subject).toBe(CANARY_SUBJECT);
            expect(summary.preview).toContain(CANARY_BODY);

            const [indexEntry] = await ctx.indexEntries();
            expect(indexEntry).toMatchObject({ mailboxUid: mailbox.uid, messageUid: message.uid, keyFingerprint: recipient.key.fingerprint });
            expect(indexEntry.weekId).toMatch(/^\d{4}-W\d{2}$/);
            const document = JSON.parse(gunzipSync(await open(Buffer.from(indexEntry.sealed, "base64"), recipient)).toString("utf-8"));
            expect(document).toMatchObject({ v: 1, messageUid: message.uid, subject: CANARY_SUBJECT, from: "bob@example.org", attachmentNames: ["minutes.txt"] });
            expect(document.body).toContain(CANARY_BODY);
            expect(document.attachmentText.join(" ")).toContain(CANARY_ATTACHMENT);

            // No ingest spool, sanitized copy, attachment blob or extracted text - nothing readable is left in storage.
            for (const [key, content] of blobs()) {
                expect(key.startsWith("ingest/")).toBe(false);
                const text: string = content.toString("latin1");
                for (const canary of [CANARY_SUBJECT, CANARY_BODY, CANARY_ATTACHMENT]) {
                    expect(text.includes(canary), `${key} holds "${canary}"`).toBe(false);
                }
            }
        });

        it("seals only the zero-access recipient's copy of a message also addressed to a mailbox without it", async () => {
            const recipient = await makeKey();
            const sealedMailbox = await zeroAccessMailbox(recipient);
            const plainMailbox = await ctx.createMailbox();

            const result = await deliver([sealedMailbox.primarySmtpAddress, plainMailbox.primarySmtpAddress], rawMessage(sealedMailbox.primarySmtpAddress));

            expect(result.status).toBe(202);
            const entries = await ctx.entries();
            const sealedEntry = entries.find((e) => e.mailboxUid === sealedMailbox.uid);
            const plainEntry = entries.find((e) => e.mailboxUid === plainMailbox.uid);
            expect(sealedEntry.status).toBe(IngestStatus.DELIVERED);
            // The plaintext recipient is queued as before, from the raw blob written for it alone.
            expect(plainEntry).toMatchObject({ status: IngestStatus.PENDING });
            expect(plainEntry.zeroAccessKeyFingerprint ?? undefined).toBeUndefined();
            expect(plainEntry.rawBlobKey.startsWith("ingest/")).toBe(true);
            expect(await ctx.messages()).toHaveLength(1);
        });

        it("tells the mail event stream a zero-access bounce arrived, but nothing parsed from its body", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            const publish = vi.spyOn(MailEventStream.prototype, "publish").mockResolvedValue();
            try {
                const result = await deliver([mailbox.primarySmtpAddress], postfixDsn({ to: mailbox.primarySmtpAddress, recipient: "canary-diagnostic@example.net" }));

                expect(result.status).toBe(202);
                expect(publish).toHaveBeenCalledTimes(1);
                const event: any = publish.mock.calls[0][0];
                expect(event).toMatchObject({ type: "message.delivered", mailboxUid: mailbox.uid, zeroAccess: true });
                expect(event.deliveryStatusReport ?? event.feedbackReport ?? event.reportAuthenticated ?? event.subject).toBeUndefined();
                expect(JSON.stringify(event)).not.toContain("canary-diagnostic");
            } finally {
                publish.mockRestore();
            }
        });

        it("seals each of a delivery's zero-access recipients' copies, indexing the attachment text it extracts once for all of them", async () => {
            const first = await makeKey();
            const second = await makeKey();
            const a = await zeroAccessMailbox(first);
            const b = await zeroAccessMailbox(second);

            const result = await deliver([a.primarySmtpAddress, b.primarySmtpAddress], rawMessage(a.primarySmtpAddress));

            expect(result.status).toBe(202);
            const entries = await ctx.indexEntries();
            expect(entries.map((entry) => entry.mailboxUid).sort()).toEqual([a.uid, b.uid].sort());
            for (const [mailbox, recipient] of [[a, first], [b, second]] as const) {
                const entry = entries.find((e) => e.mailboxUid === mailbox.uid);
                const document = JSON.parse(gunzipSync(await open(Buffer.from(entry.sealed, "base64"), recipient)).toString("utf-8"));
                expect(document.attachmentText.join(" ")).toContain(CANARY_ATTACHMENT);
            }
        });

        it.each([
            ["the administrator disallowed it", async (mailbox: any) => ctx.setAllowZeroAccess(false)],
            ["the owner turned it off", async (mailbox: any) => ctx.updateMailbox(mailbox.uid, { zeroAccessEnabled: false })],
        ])("stores the message as it arrives when %s", async (_why, arrange) => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            await arrange(mailbox);

            const result = await deliver([mailbox.primarySmtpAddress], rawMessage(mailbox.primarySmtpAddress));

            expect(result.status).toBe(202);
            const [entry] = await ctx.entries();
            expect(entry.status).toBe(IngestStatus.PENDING);
            expect(entry.zeroAccessKeyFingerprint ?? undefined).toBeUndefined();
            expect(entry.rawBlobKey.startsWith("ingest/")).toBe(true);
        });

        it.each([
            [
                "has a delegate",
                async (mailbox: any) =>
                    ctx.setAcl(mailbox.uid, [
                        { userOrRoleId: mailbox.ownerUserUid, actions: [ACLAction.FULL] },
                        { userOrRoleId: "delegate-uid", actions: [ACLAction.READ] },
                    ]),
            ],
            ["has no owner", async (mailbox: any) => ctx.updateMailbox(mailbox.uid, { ownerUserUid: null })],
        ])("seals the message for a shared mailbox that %s - its members read it through member key wraps", async (_why, arrange) => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            await arrange(mailbox);

            const result = await deliver([mailbox.primarySmtpAddress], rawMessage(mailbox.primarySmtpAddress));

            expect(result.status).toBe(202);
            const [entry] = await ctx.entries();
            expect(entry.status).toBe(IngestStatus.DELIVERED);
            expect(entry.zeroAccessKeyFingerprint).toBe(recipient.key.fingerprint);
        });

        it("seals a message for a mailbox that has a key and nothing set, the server allowing it by default", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            await ctx.setAllowZeroAccess(undefined);
            await ctx.setAcl(mailbox.uid, [
                { userOrRoleId: mailbox.ownerUserUid, actions: [ACLAction.FULL] },
                { userOrRoleId: "admin", actions: [ACLAction.READ] },
            ]);

            await deliver([mailbox.primarySmtpAddress], rawMessage(mailbox.primarySmtpAddress));

            expect((await ctx.entries())[0].status).toBe(IngestStatus.DELIVERED);
        });

        it("seals a quarantined message too, keeping no plaintext for review", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            await ctx.createTransportRule({ actions: [{ type: TransportRuleActionType.QUARANTINE }] });
            const raw = rawMessage(mailbox.primarySmtpAddress);

            const result = await deliver([mailbox.primarySmtpAddress], raw);

            expect(result.status).toBe(202);
            const [held] = await ctx.quarantineEntries();
            expect(held.rawBlobKey.startsWith(`za/${mailbox.uid}/`)).toBe(true);
            expect((await openSealedMessage(await ctx.blobStore().get(held.rawBlobKey), recipient)).equals(raw)).toBe(true);
            expect(await ctx.messages()).toEqual([]);
            expect(blobs().some(([key]) => key.startsWith("ingest/"))).toBe(false);
        });

        it("files the notice of a zero-access sender's message to nobody here sealed, spooling nothing readable", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            const nobody = `nobody-${Math.random().toString(16).slice(2)}@example.com`;
            const raw = Buffer.from(
                [`From: ${mailbox.primarySmtpAddress}`, `To: ${nobody}`, `Subject: ${CANARY_SUBJECT}`, "Message-ID: <za-dropped@example.com>", "", CANARY_BODY, ""].join("\r\n"),
            );
            const send = () =>
                request(ctx.app())
                    .post(`${ctx.baseUrl}/deliver`)
                    .set("Authorization", `Bearer ${ctx.secret}`)
                    .set("X-Envelope-From", mailbox.primarySmtpAddress)
                    .set("X-Envelope-To", nobody)
                    .set("Content-Type", "message/rfc822")
                    .send(raw);

            expect((await send()).status).toBe(202);
            // The MTA's retry of the same transaction files nothing twice.
            expect((await send()).status).toBe(202);

            const messages = await ctx.messages();
            expect(messages).toHaveLength(1);
            const [notice] = messages;
            expect(notice.mailboxUid).toBe(mailbox.uid);
            expect(notice.subject).toBe("[...]");
            expect(notice.bodyPreview).toBe("");
            expect(notice.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
            expect((await openSealedMessage(await ctx.blobStore().get(notice.bodyBlobKey), recipient)).toString("latin1")).toContain(nobody);
            expect(blobs().some(([key]) => key.startsWith("ingest/"))).toBe(false);
            for (const [key, content] of blobs()) {
                expect(content.toString("latin1").includes(CANARY_SUBJECT), `${key} holds the subject`).toBe(false);
            }
        });

        it("answers 503 when a zero-access recipient can't be delivered, and files it exactly once when the MTA retries", async () => {
            const recipient = await makeKey();
            const broken: ZeroAccessKey = { ...recipient.key, publicKey: Buffer.from("not a certificate").toString("base64") };
            const mailbox = await ctx.createMailbox({ zeroAccessKeys: [broken] });
            const raw = rawMessage(mailbox.primarySmtpAddress);

            const failed = await deliver([mailbox.primarySmtpAddress], raw);

            expect(failed.status).toBe(503);
            const [entry] = await ctx.entries();
            expect(entry.status).toBe(IngestStatus.FAILED);
            expect(await ctx.messages()).toEqual([]);

            // The key is repaired; the MTA resends the same transaction.
            await ctx.updateMailbox(mailbox.uid, { zeroAccessKeys: [recipient.key] });
            const retried = await deliver([mailbox.primarySmtpAddress], raw);
            const again = await deliver([mailbox.primarySmtpAddress], raw);

            expect(retried.status).toBe(202);
            expect(again.status).toBe(202);
            expect(await ctx.entries()).toHaveLength(1);
            expect((await ctx.entries())[0].status).toBe(IngestStatus.DELIVERED);
            expect(await ctx.messages()).toHaveLength(1);
            expect(await ctx.indexEntries()).toHaveLength(1);
        });

        it("answers 503 while an erasure of the mailbox is pending, so the MTA keeps the message rather than it being lost", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            await ctx.createErasureRequest(mailbox.uid, "approved");
            const raw = rawMessage(mailbox.primarySmtpAddress);

            const deferred = await deliver([mailbox.primarySmtpAddress], raw);

            expect(deferred.status).toBe(503);
            const [entry] = await ctx.entries();
            expect(entry.status).toBe(IngestStatus.FAILED);
            expect(entry.attempts).toBe(0);
            expect(await ctx.messages()).toEqual([]);

            // The MTA's retry while it is still pending is deferred again, never filed or counted.
            expect((await deliver([mailbox.primarySmtpAddress], raw)).status).toBe(503);
            expect((await ctx.entries())[0].attempts).toBe(0);
        });

        it("seals an invitation's title, location and description on the event it creates and on its later updates", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            const vevent = (sequence: number, summary: string) => [
                "UID:za-event-1",
                "DTSTAMP:20261022T100000Z",
                "DTSTART:20261101T100000Z",
                "DTEND:20261101T110000Z",
                `SUMMARY:${summary}`,
                "LOCATION:Room 42",
                "DESCRIPTION:Discuss Bluebird",
                "ORGANIZER;CN=Bob:mailto:bob@example.org",
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${mailbox.primarySmtpAddress}`,
                `SEQUENCE:${sequence}`,
            ];

            expect((await deliver([mailbox.primarySmtpAddress], itipMessage(mailbox.primarySmtpAddress, "REQUEST", vevent(0, "Secret board meeting")))).status).toBe(202);

            const [event] = await ctx.calendarEvents();
            expect(event.title).toBe("[...]");
            expect(event.location ?? undefined).toBeUndefined();
            expect(event.description ?? undefined).toBeUndefined();
            expect(event.encryptionOrigin).toBe("derived");
            // Time and attendees stay plaintext, for free/busy and scheduling.
            expect(new Date(event.startDate).toISOString()).toBe("2026-11-01T10:00:00.000Z");
            expect(event.attendees.map((a: any) => a.address)).toEqual([mailbox.primarySmtpAddress]);
            expect(event.sealedContent.keyFingerprint).toBe(recipient.key.fingerprint);
            expect(JSON.parse((await open(Buffer.from(event.sealedContent.sealed, "base64"), recipient)).toString("utf-8"))).toEqual({
                title: "Secret board meeting",
                location: "Room 42",
                description: "Discuss Bluebird",
            });

            expect((await deliver([mailbox.primarySmtpAddress], itipMessage(mailbox.primarySmtpAddress, "REQUEST", vevent(1, "Renamed meeting")))).status).toBe(202);

            const [updated] = await ctx.calendarEvents();
            expect(updated.title).toBe("[...]");
            expect(JSON.parse((await open(Buffer.from(updated.sealedContent.sealed, "base64"), recipient)).toString("utf-8")).title).toBe("Renamed meeting");
        });

        it("drops the per-field sealed copies of an event a zero-access revision replaces, so no client opens the old title over it", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            const calendar = await ctx.createFolder(mailbox.uid, "calendar");
            // Filed field by field while the calendar was protected and the mail wasn't.
            await ctx.createCalendarEvent({
                uid: nameBasedUuid(`itip:${mailbox.uid}:za-event-2:master`),
                mailboxUid: mailbox.uid,
                folderUid: calendar.uid,
                icalUid: "za-event-2",
                title: "Protected event",
                sealedFields: { title: "b2xk", location: "b2xk" },
                organizer: { address: "bob@example.org", type: "to" },
                attendees: [{ address: mailbox.primarySmtpAddress, role: "required", responseStatus: "needsAction", isOrganizer: false }],
                sequence: 0,
                inviteSequenceSent: 0,
            });
            const vevent = [
                "UID:za-event-2",
                "DTSTAMP:20261022T100000Z",
                "DTSTART:20261101T100000Z",
                "DTEND:20261101T110000Z",
                "SUMMARY:Moved meeting",
                "LOCATION:Room 9",
                "ORGANIZER;CN=Bob:mailto:bob@example.org",
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${mailbox.primarySmtpAddress}`,
                "SEQUENCE:1",
            ];

            expect((await deliver([mailbox.primarySmtpAddress], itipMessage(mailbox.primarySmtpAddress, "REQUEST", vevent))).status).toBe(202);

            const [event] = await ctx.calendarEvents();
            expect(event.sequence).toBe(1);
            expect(event.title).toBe("[...]");
            expect(event.sealedFields ?? null).toBeNull();
            expect(JSON.parse((await open(Buffer.from(event.sealedContent.sealed, "base64"), recipient)).toString("utf-8"))).toMatchObject({ title: "Moved meeting", location: "Room 9" });
        });

        it("keeps an event's title when a zero-access revision names none: its sealed copy stays, a readable one is sealed", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            const calendar = await ctx.createFolder(mailbox.uid, "calendar");
            const row = (icalUid: string, fields: object) =>
                ctx.createCalendarEvent({
                    uid: nameBasedUuid(`itip:${mailbox.uid}:${icalUid}:master`),
                    mailboxUid: mailbox.uid,
                    folderUid: calendar.uid,
                    icalUid,
                    organizer: { address: "bob@example.org", type: "to" },
                    attendees: [{ address: mailbox.primarySmtpAddress, role: "required", responseStatus: "needsAction", isOrganizer: false }],
                    sequence: 0,
                    inviteSequenceSent: 0,
                    ...fields,
                });
            // One sealed field by field while the calendar was protected and the mail wasn't; one filed readable before either was.
            await row("za-event-3", { title: "Protected event", sealedFields: { title: "b2xk", location: "b2xk" } });
            await row("za-event-4", { title: "CANARY review", location: "CANARY room" });
            const revision = (icalUid: string) => [
                `UID:${icalUid}`,
                "DTSTAMP:20261022T100000Z",
                "DTSTART:20261101T150000Z",
                "DTEND:20261101T160000Z",
                "LOCATION:Room 9",
                "ORGANIZER;CN=Bob:mailto:bob@example.org",
                `ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${mailbox.primarySmtpAddress}`,
                "SEQUENCE:1",
            ];

            for (const icalUid of ["za-event-3", "za-event-4"]) {
                expect((await deliver([mailbox.primarySmtpAddress], itipMessage(mailbox.primarySmtpAddress, "REQUEST", revision(icalUid)))).status).toBe(202);
            }

            const events = await ctx.calendarEvents();
            const kept = events.find((event) => event.icalUid === "za-event-3");
            expect(kept).toMatchObject({ sequence: 1, title: "[...]" });
            expect(kept.sealedFields).toEqual({ title: "b2xk" });
            expect(JSON.parse((await open(Buffer.from(kept.sealedContent.sealed, "base64"), recipient)).toString("utf-8"))).toMatchObject({ title: "", location: "Room 9" });
            const sealed = events.find((event) => event.icalUid === "za-event-4");
            expect(sealed).toMatchObject({ sequence: 1, title: "[...]" });
            expect(JSON.stringify(sealed)).not.toContain("CANARY");
            expect(JSON.parse((await open(Buffer.from(sealed.sealedContent.sealed, "base64"), recipient)).toString("utf-8"))).toMatchObject({ title: "CANARY review", location: "Room 9" });
        });

        it("seals the reader's own edit of a sealed event again, storing none of it readable, and ignores a sealedContent sent with it", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            const vevent = ["UID:meet-edit@example.org", "SEQUENCE:0", "DTSTART:20261101T150000Z", "DTEND:20261101T160000Z", "SUMMARY:Board meeting", "ORGANIZER:mailto:bob@example.org", `ATTENDEE:mailto:${mailbox.primarySmtpAddress}`];
            await deliver([mailbox.primarySmtpAddress], itipMessage(mailbox.primarySmtpAddress, "REQUEST", vevent));
            await vi.waitFor(async () => expect((await ctx.calendarEvents()).filter((e) => e.mailboxUid === mailbox.uid)).toHaveLength(1), { timeout: 5000, interval: 20 });
            const [event] = (await ctx.calendarEvents()).filter((e) => e.mailboxUid === mailbox.uid);
            await ctx.setAcl(mailbox.uid, [{ userOrRoleId: mailbox.ownerUserUid, actions: [ACLAction.FULL] }]);

            const result = await request(ctx.app())
                .put(`${ctx.calendarEventsUrl}/${event.uid}`)
                .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                .send({ ...event, title: "Board meeting (moved)", location: "Room 9", description: "Bring the numbers", sealedContent: { keyFingerprint: "forged", sealed: "x" } });

            expect(result.status).toBeLessThan(300);
            const [stored] = (await ctx.calendarEvents()).filter((e) => e.mailboxUid === mailbox.uid);
            expect(stored).toMatchObject({ title: "[...]" });
            expect(stored.location ?? null).toBeNull();
            expect(stored.description ?? null).toBeNull();
            expect(stored.sealedContent.keyFingerprint).toBe(recipient.key.fingerprint);
            expect(JSON.parse((await open(Buffer.from(stored.sealedContent.sealed, "base64"), recipient)).toString("utf-8"))).toEqual({
                title: "Board meeting (moved)",
                location: "Room 9",
                description: "Bring the numbers",
            });

            // A move touches no content: the sealed content stays as it is.
            const moved = await request(ctx.app())
                .put(`${ctx.calendarEventsUrl}/${event.uid}`)
                .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                .send({ uid: event.uid, version: stored.version, startDate: "2026-11-02T15:00:00.000Z", endDate: "2026-11-02T16:00:00.000Z" });
            expect(moved.status).toBeLessThan(300);
            const [afterMove] = (await ctx.calendarEvents()).filter((e) => e.mailboxUid === mailbox.uid);
            expect(afterMove.sealedContent).toEqual(stored.sealedContent);

            // With the key it was sealed to gone, its content can't be changed (it would have to be stored readable).
            await ctx.updateMailbox(mailbox.uid, { zeroAccessKeys: [] });
            const refused = await request(ctx.app())
                .put(`${ctx.calendarEventsUrl}/${event.uid}`)
                .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                .send({ uid: event.uid, version: afterMove.version, title: "Readable now?" });
            expect(refused.status).toBe(409);
        });

        it("applies only the time of a guest's change request to a zero-access organizer's event, never its content", async () => {
            const recipient = await makeKey();
            const mailbox = await zeroAccessMailbox(recipient);
            await ctx.createCalendarEvent({
                mailboxUid: mailbox.uid,
                folderUid: "calendar",
                title: "[...]",
                startDate: new Date("2026-11-01T10:00:00Z"),
                endDate: new Date("2026-11-01T11:00:00Z"),
                organizer: { address: mailbox.primarySmtpAddress, type: "to" },
                attendees: [{ address: "bob@example.org", role: "required", responseStatus: "accepted", isOrganizer: false }],
                icalUid: "za-event-2",
                sequence: 0,
                guestsCanModify: true,
            });

            const counter = itipMessage(mailbox.primarySmtpAddress, "COUNTER", [
                "UID:za-event-2",
                "DTSTAMP:20261022T100000Z",
                "DTSTART:20261101T120000Z",
                "DTEND:20261101T130000Z",
                "SUMMARY:Leaked title",
                "LOCATION:Leaked room",
                "DESCRIPTION:Leaked notes",
                `ORGANIZER:mailto:${mailbox.primarySmtpAddress}`,
                "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.org",
                "X-RAPIDMX-CHANGE-REQUEST:TRUE",
                "SEQUENCE:0",
            ]);
            expect((await deliver([mailbox.primarySmtpAddress], counter)).status).toBe(202);

            const [event] = await ctx.calendarEvents();
            expect(event.title).toBe("[...]");
            expect(event.location ?? undefined).toBeUndefined();
            expect(event.description ?? undefined).toBeUndefined();
            expect(new Date(event.startDate).toISOString()).toBe("2026-11-01T12:00:00.000Z");
        });

        describe("backfill of existing mail", () => {
            const WEEK_OF = (date: Date) => isoWeekId(date);
            /** A readable message as stored before zero-access: its raw blob, a sanitized copy and an attachment row and blob. */
            const stored = async (mailbox: any, folder: any, fields: any = {}) => {
                const bodyBlobKey = `ingest/${Math.random().toString(16).slice(2)}`;
                await ctx.blobStore().put(bodyBlobKey, rawMessage(mailbox.primarySmtpAddress));
                const sanitizedHtmlBlobKey = `sanitized/${Math.random().toString(16).slice(2)}`;
                await ctx.blobStore().put(sanitizedHtmlBlobKey, Buffer.from(`<p>${CANARY_BODY}</p>`));
                const message = await ctx.createMessage({
                    mailboxUid: mailbox.uid,
                    folderUid: folder.uid,
                    subject: CANARY_SUBJECT,
                    bodyPreview: CANARY_BODY,
                    from: { address: "bob@example.org", type: "to" },
                    recipients: [{ address: mailbox.primarySmtpAddress, type: "to" }],
                    bodyBlobKey,
                    sanitizedHtmlBlobKey,
                    hasAttachments: true,
                    receivedDate: new Date("2026-03-04T10:00:00Z"),
                    searchIndexedAt: new Date(),
                    ...fields,
                });
                const attachmentBlobKey = `attachments/${Math.random().toString(16).slice(2)}`;
                await ctx.blobStore().put(attachmentBlobKey, Buffer.from(CANARY_ATTACHMENT));
                await ctx.createAttachment({ messageUid: message.uid, folderUid: folder.uid, mailboxUid: mailbox.uid, filename: "minutes.txt", mimeType: "text/plain", sizeBytes: 22, blobKey: attachmentBlobKey });
                return { message, bodyBlobKey, sanitizedHtmlBlobKey, attachmentBlobKey };
            };

            it("seals the calendar events of a mailbox whose calendar it protects, skipping those already done, and leaves its mail alone", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient, { zeroAccessTypes: { mail: false, calendar: true } });
                const calendar = await ctx.createFolder(mailbox.uid, "calendar");
                const fields = { mailboxUid: mailbox.uid, folderUid: calendar.uid, location: "CANARY room 4" };
                const readable = await ctx.createCalendarEvent({ ...fields, title: "CANARY board meeting" });
                const done = await ctx.createCalendarEvent({ ...fields, title: "Marked done", sealedFields: {} });

                await ctx.runBackfill();

                const events = await ctx.calendarEvents();
                const sealed = events.find((event) => event.uid === readable.uid);
                expect(sealed).toMatchObject({ title: "Protected event" });
                expect(JSON.stringify(sealed)).not.toContain("CANARY");
                expect(Object.keys(sealed.sealedFields).sort()).toEqual(["location", "title"]);
                expect(events.find((event) => event.uid === done.uid)).toMatchObject({ title: "Marked done", location: "CANARY room 4" });
            });

            it("seals a mailbox's readable mail into its own week and removes every readable copy", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const inbox = await ctx.createFolder(mailbox.uid, "inbox");
                const { message, bodyBlobKey, sanitizedHtmlBlobKey, attachmentBlobKey } = await stored(mailbox, inbox);

                await ctx.runBackfill();

                const sealed = await ctx.findMessage(message.uid);
                expect(sealed).toMatchObject({ subject: "[...]", bodyPreview: "", bodyBlobKey: `za/${mailbox.uid}/${message.uid}` });
                expect(sealed.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                expect(sealed.sanitizedHtmlBlobKey ?? undefined).toBeUndefined();
                expect(sealed.searchIndexedAt ?? undefined).toBeUndefined();
                expect((await openSealedMessage(await ctx.blobStore().get(sealed.bodyBlobKey), recipient)).toString("latin1")).toContain(CANARY_BODY);
                for (const key of [bodyBlobKey, sanitizedHtmlBlobKey, attachmentBlobKey]) {
                    expect(await ctx.blobStore().exists(key)).toBe(false);
                }
                expect(await ctx.attachments()).toEqual([]);
                expect((await ctx.indexEntries()).map((entry) => [entry.messageUid, entry.weekId])).toEqual([[message.uid, WEEK_OF(new Date("2026-03-04T10:00:00Z"))]]);
                for (const [key, content] of blobs()) {
                    expect(content.toString("latin1"), key).not.toContain(CANARY_BODY);
                }

                // Nothing left to do: a second run changes nothing.
                await ctx.runBackfill();
                expect((await ctx.findMessage(message.uid)).version).toBe(sealed.version);
            });

            it("sends a sealed message back to be indexed even after its indexing retries had run out, so its readable document goes", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const inbox = await ctx.createFolder(mailbox.uid, "inbox");
                // Indexed readable, then changed during a search outage long enough to use up every retry.
                const { message } = await stored(mailbox, inbox, { searchIndexedAt: null, searchIndexAttempts: 5, searchIndexNextAttemptAt: null, searchIndexError: "down" });

                await ctx.runBackfill();

                const sealed = await ctx.findMessage(message.uid);
                expect(sealed.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                for (const field of ["searchIndexedAt", "searchIndexAttempts", "searchIndexNextAttemptAt", "searchIndexError"]) {
                    expect(sealed[field] ?? null, field).toBeNull();
                }
            });

            it("seals drafts and restorable deleted mail, but leaves Outbox, end-to-end mail and a mailbox without zero-access alone", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const drafts = await ctx.createFolder(mailbox.uid, "drafts");
                const outbox = await ctx.createFolder(mailbox.uid, "outbox");
                const inbox = await ctx.createFolder(mailbox.uid, "inbox");
                const draft = (await stored(mailbox, drafts)).message;
                const deleted = (await stored(mailbox, inbox, { deleted: true })).message;
                const sending = (await stored(mailbox, outbox, { scheduledSendTime: new Date(Date.now() + 3_600_000) })).message;
                const e2e = (await stored(mailbox, inbox, { encrypted: true })).message;
                const plain = await ctx.createMailbox();
                const plainInbox = await ctx.createFolder(plain.uid, "inbox");
                const untouched = (await stored(plain, plainInbox)).message;

                await ctx.runBackfill();

                expect((await ctx.findMessage(draft.uid)).bodyBlobKey).toMatch(new RegExp(`^za/${mailbox.uid}/drafts/`));
                expect((await ctx.findMessage(deleted.uid)).zeroAccess).toBeTruthy();
                for (const uid of [sending.uid, e2e.uid, untouched.uid]) {
                    expect((await ctx.findMessage(uid)).zeroAccess ?? undefined).toBeUndefined();
                }
            });

            it("keeps a sealed draft's attachment rows and blobs, its working attachments, dropping only their extracted text, and writes its index entry", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const drafts = await ctx.createFolder(mailbox.uid, "drafts");
                const { message, bodyBlobKey, sanitizedHtmlBlobKey, attachmentBlobKey } = await stored(mailbox, drafts);
                const [attachment] = (await ctx.attachments()).filter((row) => row.messageUid === message.uid);
                const textBlobKey = `attachment-text/${Math.random().toString(16).slice(2)}`;
                await ctx.blobStore().put(textBlobKey, Buffer.from(CANARY_ATTACHMENT));
                await ctx.createAttachment({ ...attachment, uid: undefined, version: undefined, _id: undefined, filename: "notes.txt", extractedTextBlobKey: textBlobKey });

                await ctx.runBackfill();

                const sealed = await ctx.findMessage(message.uid);
                expect(sealed.bodyBlobKey).toMatch(new RegExp(`^za/${mailbox.uid}/drafts/`));
                // The replaced body and render go; the attachments stay, for the compose window and the send built from them.
                for (const key of [bodyBlobKey, sanitizedHtmlBlobKey, textBlobKey]) {
                    expect(await ctx.blobStore().exists(key), key).toBe(false);
                }
                const kept = (await ctx.attachments()).filter((row) => row.messageUid === message.uid);
                expect(kept.map((row) => row.filename).sort()).toEqual(["minutes.txt", "notes.txt"]);
                expect(kept.every((row) => (row.extractedTextBlobKey ?? null) === null)).toBe(true);
                expect((await ctx.blobStore().get(attachmentBlobKey)).toString()).toBe(CANARY_ATTACHMENT);
                expect((await ctx.indexEntries()).map((entry) => entry.messageUid)).toEqual([message.uid]);
            });

            it("seals an Outbox message whose send failed for good as a draft, and one relayed but never filed as sent mail, leaving a pending one", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const outbox = await ctx.createFolder(mailbox.uid, "outbox");
                const failed = await stored(mailbox, outbox, { scheduledSendTime: null, scheduledSendError: "550 5.1.1 no such user", scheduledSendAttempts: 1 });
                const unfiled = await stored(mailbox, outbox, { scheduledSendTime: null, scheduledSendRelayedAt: new Date(), scheduledSendAttempts: 5, scheduledSendError: "filing failed" });
                const claimed = (await stored(mailbox, outbox, { scheduledSendTime: null, scheduledSendLeaseExpiresAt: new Date(Date.now() + 600_000) })).message;
                const retrying = (await stored(mailbox, outbox, { scheduledSendTime: new Date(Date.now() + 60_000), scheduledSendAttempts: 1 })).message;

                await ctx.runBackfill();

                const failedRow = await ctx.findMessage(failed.message.uid);
                expect(failedRow.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                expect(failedRow.bodyBlobKey).toMatch(new RegExp(`^za/${mailbox.uid}/drafts/`));
                expect(failedRow.subject).toBe("[...]");
                expect(await ctx.blobStore().exists(failed.bodyBlobKey)).toBe(false);
                expect(await ctx.blobStore().exists(failed.attachmentBlobKey)).toBe(true);
                const unfiledRow = await ctx.findMessage(unfiled.message.uid);
                expect(unfiledRow.bodyBlobKey).toBe(`za/${mailbox.uid}/${unfiled.message.uid}`);
                for (const key of [unfiled.bodyBlobKey, unfiled.sanitizedHtmlBlobKey, unfiled.attachmentBlobKey]) {
                    expect(await ctx.blobStore().exists(key), key).toBe(false);
                }
                expect((await ctx.attachments()).map((row) => row.messageUid).sort()).toEqual([failed.message.uid, claimed.uid, retrying.uid].sort());
                for (const uid of [claimed.uid, retrying.uid]) {
                    expect((await ctx.findMessage(uid)).zeroAccess ?? undefined).toBeUndefined();
                }
                // A sealed draft can't be relayed: retrying it from Outbox answers 409, so the client assembles it again.
                await ctx.setAcl(mailbox.uid, [{ userOrRoleId: mailbox.ownerUserUid, actions: [ACLAction.FULL] }]);
                const send = await request(ctx.app())
                    .post(`${ctx.messagesUrl}/${failed.message.uid}/send`)
                    .set("Authorization", `jwt ${ctx.tokenFor(mailbox.ownerUserUid)}`)
                    .send({ background: true });
                expect(send.status).toBe(409);
                expect(JSON.stringify(send.body)).toContain("zero-access");
            });

            it("removes the search document of restorable deleted mail it seals, which the search indexer never revisits", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const inbox = await ctx.createFolder(mailbox.uid, "inbox");
                const deleted = (await stored(mailbox, inbox, { deleted: true })).message;
                const live = (await stored(mailbox, inbox)).message;
                // Both indexed readable while they were live.
                for (const message of [deleted, live]) {
                    await ctx.searchProvider().index({ entityType: "message", entityUid: message.uid, mailboxUid: mailbox.uid, subject: CANARY_SUBJECT, body: CANARY_BODY } as any);
                }

                await ctx.runBackfill();

                expect((await ctx.findMessage(deleted.uid)).zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                expect(ctx.searchProvider().indexed.has(`message:${deleted.uid}`)).toBe(false);
                // A live one is sent back to the indexer instead, which replaces its document with metadata.
                expect(ctx.searchProvider().indexed.has(`message:${live.uid}`)).toBe(true);
                expect((await ctx.findMessage(live.uid)).searchIndexedAt ?? null).toBeNull();
            });

            it("seals a message stored before Message.encrypted existed, whose column holds nothing", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const inbox = await ctx.createFolder(mailbox.uid, "inbox");
                const { message } = await stored(mailbox, inbox);
                await ctx.updateMessage(message.uid, { encrypted: null });

                await ctx.runBackfill();

                const sealed = await ctx.findMessage(message.uid);
                expect(sealed.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                expect(sealed.subject).toBe("[...]");
            });

            it("seals a message whose HTML is nested too deeply for mailparser's own conversion, rather than giving up on it", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const inbox = await ctx.createFolder(mailbox.uid, "inbox");
                const { message, bodyBlobKey } = await stored(mailbox, inbox);
                const nested = "<div>".repeat(3000) + CANARY_BODY + "</div>".repeat(3000);
                await ctx.blobStore().put(bodyBlobKey, Buffer.from(`Subject: ${CANARY_SUBJECT}\r\nContent-Type: text/html\r\n\r\n${nested}`));

                await ctx.runBackfill();

                const sealed = await ctx.findMessage(message.uid);
                expect(sealed.zeroAccessBackfillError ?? undefined).toBeUndefined();
                expect(sealed.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                expect(await ctx.blobStore().exists(bodyBlobKey)).toBe(false);
            });

            it("marks a message it can't read and never selects it again", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const inbox = await ctx.createFolder(mailbox.uid, "inbox");
                const { message, bodyBlobKey } = await stored(mailbox, inbox);
                await ctx.blobStore().delete(bodyBlobKey);

                await ctx.runBackfill();
                const marked = await ctx.findMessage(message.uid);
                await ctx.runBackfill();

                expect(marked.zeroAccessBackfillError).toContain("couldn't be read");
                expect(marked.zeroAccess ?? undefined).toBeUndefined();
                expect((await ctx.findMessage(message.uid)).version).toBe(marked.version);
            });
        });

        describe("Sent Items copies", () => {
            /** A draft from `mailbox` with a body blob and one attachment blob holding the canaries. */
            const draft = async (mailbox: any) => {
                // The owner's own record, as a created mailbox has: what the message route checks a send against.
                await ctx.setAcl(mailbox.uid, [{ userOrRoleId: mailbox.ownerUserUid, actions: [ACLAction.FULL] }]);
                const drafts = await ctx.createFolder(mailbox.uid, "drafts");
                const bodyBlobKey = `bodies/${Math.random().toString(16).slice(2)}`;
                await ctx.blobStore().put(
                    bodyBlobKey,
                    Buffer.from(`From: ${mailbox.primarySmtpAddress}\r\nTo: carol@example.org\r\nSubject: ${CANARY_SUBJECT}\r\n\r\n${CANARY_BODY}\r\n`),
                );
                const message = await ctx.createMessage({
                    mailboxUid: mailbox.uid,
                    folderUid: drafts.uid,
                    subject: CANARY_SUBJECT,
                    bodyPreview: CANARY_BODY,
                    from: { address: mailbox.primarySmtpAddress, type: "to" },
                    recipients: [{ address: "carol@example.org", type: "to" }],
                    bodyBlobKey,
                    hasAttachments: true,
                });
                const attachmentBlobKey = `attachments/${Math.random().toString(16).slice(2)}`;
                await ctx.blobStore().put(attachmentBlobKey, Buffer.from(CANARY_ATTACHMENT));
                await ctx.createAttachment({ messageUid: message.uid, folderUid: drafts.uid, mailboxUid: mailbox.uid, filename: "minutes.txt", mimeType: "text/plain", sizeBytes: 22, blobKey: attachmentBlobKey });
                return { message, bodyBlobKey, attachmentBlobKey };
            };

            const expectSealedSentCopy = async (uid: string, recipient: Recipient, plaintextKeys: string[]) => {
                const filed = await ctx.findMessage(uid);
                expect(filed.subject).toBe("[...]");
                expect(filed.bodyPreview).toBe("");
                expect(filed.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                expect(filed.bodyBlobKey).toBe(`za/${filed.mailboxUid}/${uid}`);
                const original = (await openSealedMessage(await ctx.blobStore().get(filed.bodyBlobKey), recipient)).toString("latin1");
                expect(original).toContain(CANARY_BODY);
                expect(await ctx.attachments()).toEqual([]);
                for (const key of plaintextKeys) {
                    expect(await ctx.blobStore().exists(key)).toBe(false);
                }
                expect((await ctx.indexEntries()).map((entry) => entry.messageUid)).toEqual([uid]);
            };

            it("seals the Sent Items copy of a message sent now, and removes the draft's plaintext body and attachments", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const { message, bodyBlobKey, attachmentBlobKey } = await draft(mailbox);

                const result = await request(ctx.app())
                    .post(`${ctx.messagesUrl}/${message.uid}/send`)
                    .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                    .send({});

                expect(result.status).toBeLessThan(300);
                await expectSealedSentCopy(message.uid, recipient, [bodyBlobKey, attachmentBlobKey]);
            });

            it("sends the sealed Sent Items copy to be indexed again, so the search index drops the readable draft's text", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const { message } = await draft(mailbox);
                // The readable draft assembled for sending was indexed, and had used up some retries.
                await ctx.updateMessage(message.uid, { searchIndexedAt: new Date(), searchIndexAttempts: 2, searchIndexError: "earlier failure" });

                const result = await request(ctx.app())
                    .post(`${ctx.messagesUrl}/${message.uid}/send`)
                    .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                    .send({});

                expect(result.status).toBeLessThan(300);
                const filed = await ctx.findMessage(message.uid);
                expect(filed.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                expect(filed.searchIndexedAt ?? null).toBeNull();
                expect(filed.searchIndexAttempts ?? null).toBeNull();
                expect(filed.searchIndexError ?? null).toBeNull();
            });

            it("files the notice of a send refused for some recipients sealed, quoting the subject nowhere readable", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const { message } = await draft(mailbox);
                await ctx.updateMessage(message.uid, {
                    recipients: [
                        { address: "carol@example.org", type: "to" },
                        { address: "partial-reject@example.com", type: "to" },
                    ],
                });

                const result = await request(ctx.app())
                    .post(`${ctx.messagesUrl}/${message.uid}/send`)
                    .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                    .send({});

                expect(result.status).toBeLessThan(300);
                const uid = deliveryFailureUid(mailbox.uid, `send-partial:${message.uid}`);
                const notice = await ctx.findMessage(uid);
                expect(notice.subject).toBe("[...]");
                expect(notice.bodyPreview).toBe("");
                expect(notice.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                expect(await ctx.blobStore().exists(`notices/${uid}`)).toBe(false);
                const opened = (await openSealedMessage(await ctx.blobStore().get(notice.bodyBlobKey), recipient)).toString("latin1");
                expect(opened).toContain("partial-reject@example.com");
                for (const [key, content] of blobs()) {
                    expect(content.toString("latin1").includes(CANARY_SUBJECT), `${key} holds the subject`).toBe(false);
                }
            });

            it("seals the Sent Items copy of a message sent in the background", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const { message, bodyBlobKey, attachmentBlobKey } = await draft(mailbox);
                await ctx.updateMessage(message.uid, { searchIndexedAt: new Date() });

                const result = await request(ctx.app())
                    .post(`${ctx.messagesUrl}/${message.uid}/send`)
                    .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                    .send({ background: true });

                expect(result.status).toBeLessThan(300);
                // The job files the sealed copy before it removes the draft's plaintext, so wait for both.
                await vi.waitFor(() => expectSealedSentCopy(message.uid, recipient, [bodyBlobKey, attachmentBlobKey]), { timeout: 10_000, interval: 50 });
                // Indexed again, as metadata only now.
                expect((await ctx.findMessage(message.uid)).searchIndexedAt ?? null).toBeNull();
            }, 20_000);

            it("leaves no readable sanitized render behind when filing a relayed message fails and the job finishes it", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const { message, bodyBlobKey } = await draft(mailbox);
                await ctx
                    .blobStore()
                    .put(bodyBlobKey, Buffer.from(`From: ${mailbox.primarySmtpAddress}\r\nTo: carol@example.org\r\nSubject: ${CANARY_SUBJECT}\r\nContent-Type: text/html\r\n\r\n<p>${CANARY_BODY}</p>\r\n`));
                const renders = (): string[] => blobs().filter(([key]) => key.startsWith("sanitized/")).map(([key]) => key);
                // A render the draft already had, which the relay's own replaces.
                const draftRender = `sanitized/draft-${message.uid}`;
                await ctx.blobStore().put(draftRender, Buffer.from(`<p>${CANARY_BODY}</p>`));
                await ctx.updateMessage(message.uid, { sanitizedHtmlBlobKey: draftRender });
                // Sealing the Sent Items copy fails once, after the relay: the filing throws.
                const store: any = ctx.blobStore();
                const realPut = store.put.bind(store);
                const put = vi.spyOn(store, "put").mockImplementation(async (key: any, ...rest: any[]) => {
                    if (String(key).startsWith("za/")) {
                        throw new Error("simulated store failure");
                    }
                    return realPut(key, ...rest);
                });

                const result = await request(ctx.app())
                    .post(`${ctx.messagesUrl}/${message.uid}/send`)
                    .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                    .send({});
                put.mockRestore();

                expect(result.status).toBeGreaterThanOrEqual(500);
                const relayed = await ctx.findMessage(message.uid);
                expect(relayed.scheduledSendRelayedAt).toBeTruthy();
                // The relay's render is recorded on the row, not left for nobody to find.
                expect(renders()).toEqual([relayed.sanitizedHtmlBlobKey]);

                await ctx.runScheduledSend();

                const filed = await ctx.findMessage(message.uid);
                expect(filed.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                expect(filed.sanitizedHtmlBlobKey ?? null).toBeNull();
                expect(renders()).toEqual([]);
                for (const [key, content] of blobs()) {
                    expect(content.toString("latin1"), key).not.toContain(CANARY_BODY);
                }
            });

            for (const background of [false, true]) {
                it(`files a ${background ? "background" : "immediate"} reply sealed, with no render left behind, when looking up its thread fails after the relay`, async () => {
                    const recipient = await makeKey();
                    const mailbox = await zeroAccessMailbox(recipient);
                    const { message, bodyBlobKey } = await draft(mailbox);
                    await ctx
                        .blobStore()
                        .put(
                            bodyBlobKey,
                            Buffer.from(
                                `From: ${mailbox.primarySmtpAddress}\r\nTo: carol@example.org\r\nSubject: Re: ${CANARY_SUBJECT}\r\nIn-Reply-To: <parent@example.org>\r\nReferences: <parent@example.org>\r\nContent-Type: text/html\r\n\r\n<p>${CANARY_BODY}</p>\r\n`,
                            ),
                        );
                    await ctx.updateMessage(message.uid, { inReplyTo: "parent@example.org", references: ["parent@example.org"] });
                    // The ancestor lookup (`findThreadConversationId()`) fails: the database dropped the connection right after the relay.
                    const realFind = RepoUtils.prototype.find;
                    let failed: number = 0;
                    const find = vi.spyOn(RepoUtils.prototype, "find").mockImplementation(async function (this: any, query: any, ...rest: any[]) {
                        if (query && typeof query === "object" && "messageId" in query && "mailboxUid" in query) {
                            failed++;
                            throw new Error("connection reset");
                        }
                        return realFind.call(this, query, ...rest);
                    } as any);
                    try {
                        const result = await request(ctx.app())
                            .post(`${ctx.messagesUrl}/${message.uid}/send`)
                            .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                            .send(background ? { background: true } : {});
                        expect(result.status).toBeLessThan(300);
                        if (background) {
                            await vi.waitFor(async () => expect((await ctx.findMessage(message.uid)).zeroAccess).toBeTruthy(), { timeout: 10_000, interval: 50 });
                        }
                    } finally {
                        find.mockRestore();
                    }

                    expect(failed).toBeGreaterThan(0);
                    const filed = await ctx.findMessage(message.uid);
                    expect(filed.zeroAccess.keyFingerprint).toBe(recipient.key.fingerprint);
                    // The headers' own conversation, since the thread couldn't be looked up.
                    expect(filed.conversationId).toBeTruthy();
                    expect(blobs().filter(([key]) => key.startsWith("sanitized/"))).toEqual([]);
                    for (const [key, content] of blobs()) {
                        expect(content.toString("latin1"), key).not.toContain(CANARY_BODY);
                    }
                }, 20_000);
            }

            for (const background of [false, true]) {
                it(`files ${background ? "a background" : "an immediate"} send whose Outbox row the search indexer stamps while its Sent copy is sealed`, async () => {
                    const recipient = await makeKey();
                    const mailbox = await zeroAccessMailbox(recipient);
                    const { message, bodyBlobKey, attachmentBlobKey } = await draft(mailbox);
                    // A `SearchIndexJob` stamp (a version-checked write) lands between the filing's read of the row and its update.
                    const realSealRaw = ZeroAccessWriter.prototype.sealRaw;
                    let stamped: number = 0;
                    const sealRaw = vi.spyOn(ZeroAccessWriter.prototype, "sealRaw").mockImplementation(async function (this: any, ...args: any[]) {
                        if (args[2] === message.uid && stamped === 0) {
                            stamped++;
                            const row = await ctx.findMessage(message.uid);
                            await ctx.updateMessage(message.uid, { searchIndexedAt: new Date(), version: row.version + 1 });
                        }
                        return (realSealRaw as any).apply(this, args);
                    } as any);
                    try {
                        const result = await request(ctx.app())
                            .post(`${ctx.messagesUrl}/${message.uid}/send`)
                            .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                            .send(background ? { background: true } : {});
                        expect(result.status).toBeLessThan(300);
                        if (background) {
                            await vi.waitFor(async () => expect((await ctx.findMessage(message.uid)).zeroAccess).toBeTruthy(), { timeout: 10_000, interval: 50 });
                        }
                    } finally {
                        sealRaw.mockRestore();
                    }

                    expect(stamped).toBe(1);
                    await expectSealedSentCopy(message.uid, recipient, [bodyBlobKey, attachmentBlobKey]);
                    const filed = await ctx.findMessage(message.uid);
                    expect(filed.scheduledSendAttempts ?? null).toBeNull();
                    expect(filed.scheduledSendError ?? null).toBeNull();
                    expect(filed.searchIndexedAt ?? null).toBeNull();
                }, 20_000);

                it(`leaves ${background ? "a background" : "an immediate"} send unfiled when its claim was taken over while its Sent copy was sealed`, async () => {
                    const recipient = await makeKey();
                    const mailbox = await zeroAccessMailbox(recipient);
                    const { message } = await draft(mailbox);
                    const realSealRaw = ZeroAccessWriter.prototype.sealRaw;
                    const otherLease = new Date(Date.now() + 3_600_000);
                    const sealRaw = vi.spyOn(ZeroAccessWriter.prototype, "sealRaw").mockImplementation(async function (this: any, ...args: any[]) {
                        if (args[2] === message.uid) {
                            const row = await ctx.findMessage(message.uid);
                            await ctx.updateMessage(message.uid, { scheduledSendLeaseExpiresAt: otherLease, version: row.version + 1 });
                        }
                        return (realSealRaw as any).apply(this, args);
                    } as any);
                    try {
                        const result = await request(ctx.app())
                            .post(`${ctx.messagesUrl}/${message.uid}/send`)
                            .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                            .send(background ? { background: true } : {});
                        expect(result.status).toBeLessThan(300);
                        if (background) {
                            await vi.waitFor(() => expect(sealRaw).toHaveBeenCalled(), { timeout: 10_000, interval: 50 });
                            await ctx.runScheduledSend();
                        }
                    } finally {
                        sealRaw.mockRestore();
                    }

                    const unfiled = await ctx.findMessage(message.uid);
                    expect(unfiled.zeroAccess ?? null).toBeNull();
                    expect(new Date(unfiled.scheduledSendLeaseExpiresAt).getTime()).toBe(otherLease.getTime());
                    expect(blobs().filter(([key]) => key.startsWith("sanitized/"))).toEqual([]);
                }, 20_000);
            }

            it("gives up filing a send, as relayed, when concurrent writes keep winning the filing's version check", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const { message } = await draft(mailbox);
                const realUpdate = RepoUtils.prototype.update;
                let raced: number = 0;
                const update = vi.spyOn(RepoUtils.prototype, "update").mockImplementation(async function (this: any, obj: any, ...rest: any[]) {
                    if (obj?.uid === message.uid && obj?.sentByServerAt) {
                        raced++;
                        const row = await ctx.findMessage(message.uid);
                        await ctx.updateMessage(message.uid, { version: row.version + 1 });
                    }
                    return realUpdate.call(this, obj, ...rest);
                } as any);
                try {
                    const result = await request(ctx.app())
                        .post(`${ctx.messagesUrl}/${message.uid}/send`)
                        .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                        .send({});
                    expect(result.status).toBe(409);
                } finally {
                    update.mockRestore();
                }
                expect(raced).toBe(3);
                // Recorded as relayed, so the job only finishes the filing.
                expect((await ctx.findMessage(message.uid)).scheduledSendRelayedAt).toBeTruthy();
            });

            it("refuses to send a draft still stored sealed, which it can't relay", async () => {
                const recipient = await makeKey();
                const mailbox = await zeroAccessMailbox(recipient);
                const { message } = await draft(mailbox);
                await ctx.updateMessage(message.uid, { zeroAccess: { keyFingerprint: recipient.key.fingerprint, sealedSummary: "s" } });

                const result = await request(ctx.app())
                    .post(`${ctx.messagesUrl}/${message.uid}/send`)
                    .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                    .send({});

                expect(result.status).toBe(409);
                expect(result.body.message).toContain("zero-access");
            });

            it("files the Sent Items copy of a mailbox without zero-access as before", async () => {
                const mailbox = await ctx.createMailbox();
                const { message, bodyBlobKey } = await draft(mailbox);

                await request(ctx.app())
                    .post(`${ctx.messagesUrl}/${message.uid}/send`)
                    .set("Authorization", "jwt " + ctx.tokenFor(mailbox.ownerUserUid))
                    .send({});

                const filed = await ctx.findMessage(message.uid);
                expect(filed.zeroAccess ?? undefined).toBeUndefined();
                expect(filed.bodyBlobKey).toBe(bodyBlobKey);
                expect(await ctx.attachments()).toHaveLength(1);
            });
        });

        it("keeps sealing a retried transaction even after zero-access was turned off in between", async () => {
            const recipient = await makeKey();
            const broken: ZeroAccessKey = { ...recipient.key, publicKey: Buffer.from("not a certificate").toString("base64") };
            const mailbox = await ctx.createMailbox({ zeroAccessKeys: [broken] });
            const raw = rawMessage(mailbox.primarySmtpAddress);
            expect((await deliver([mailbox.primarySmtpAddress], raw)).status).toBe(503);

            await ctx.updateMailbox(mailbox.uid, { zeroAccessKeys: [recipient.key], zeroAccessEnabled: false });
            expect((await deliver([mailbox.primarySmtpAddress], raw)).status).toBe(202);

            const [message] = await ctx.messages();
            expect(message.subject).toBe("[...]");
            expect(blobs().some(([key]) => key.startsWith("ingest/"))).toBe(false);
        });
    });
}
