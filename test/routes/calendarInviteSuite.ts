///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The meeting invitation in a message (`GET /invite/:messageUid`, `POST .../respond`, `.../remove`, `.../propose`,
// `.../accept-proposal`) - what a mail client's Accept / Tentative / Decline card and RSVP button do - identical on both
// backends. `test/routes/{mongo,sql}/CalendarEventRoute.test.ts` supply a started server, the `RecordingMailTransport` and
// `InMemoryBlobStore` test doubles and raw row access. Every case goes through real HTTP against a real database.
import { request } from "@rapidrest/service-core/test";
import { RepoUtils } from "@rapidrest/service-core";
import { ApiError } from "@rapidrest/core";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import * as uuid from "uuid";
import { AttendeeResponseStatus, AttendeeRole, BusyStatus, CalendarEventStatus, FolderType, RecipientType } from "../../src/models/types.js";
import { nameBasedUuid } from "../../src/util/UuidUtils.js";
import { MAX_EVENT_DESCRIPTION_HTML_LENGTH } from "../../src/util/EventDescriptionUtils.js";
import type { InMemoryBlobStore, RecordingMailTransport } from "../testDoubles.js";
import { openSealedField, type TestZeroAccessKey } from "../zeroAccessTestKeys.js";

export interface CalendarInviteSuiteContext {
    app: () => any;
    baseUrl: string;
    ownerToken: string;
    otherToken: string;
    ownerUid: string;
    blobStore: () => InMemoryBlobStore;
    transport: () => RecordingMailTransport;
    /** A mailbox owned by `ownerUid`, full ACL for it. */
    createMailbox: (ownerUid: string) => Promise<any>;
    createFolder: (mailboxUid: string, type: FolderType) => Promise<any>;
    createCalendarEvent: (mailboxUid: string, folderUid: string, data?: any) => Promise<any>;
    createMessage: (mailboxUid: string, folderUid: string, data?: any) => Promise<any>;
    findMessage: (uid: string) => Promise<any>;
    /** Every calendar event row of a mailbox. */
    findEvents: (mailboxUid: string) => Promise<any[]>;
    /** Clears the organizer recorded on a calendar event row. */
    deleteEventOrganizer: (uid: string) => Promise<void>;
    /** Gives a mailbox a zero-access key (its mail is then sealed, unless `types` says otherwise), returning it. */
    addZeroAccessKey: (mailboxUid: string, types?: Record<string, boolean>) => Promise<TestZeroAccessKey>;
    /** Saves a `CalendarEventAttendeeLink` row. */
    createAttendeeLink: (data: any) => Promise<any>;
}

const HOUR = 60 * 60 * 1000;
const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

interface IcsOptions {
    method?: string;
    uid: string;
    start: Date;
    end: Date;
    sequence?: number;
    organizer: string;
    attendees: { address: string; partstat?: string }[];
    status?: string;
    /** More content lines of the event (`DESCRIPTION:...`, `CLASS:...`, `X-RAPIDMX-...`). */
    extra?: string[];
    /** The file's `PRODID`; defaults to another vendor's, as an invitation from an outside organizer has. */
    prodId?: string;
}

/** A sent message as text, with quoted-printable soft line breaks and escapes undone, so the calendar file inside reads as written. */
const decoded = (raw: Buffer): string => raw.toString().replace(/=\r?\n/g, "").replace(/=3D/g, "=");

const ics = (o: IcsOptions): string =>
    [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        `PRODID:${o.prodId ?? "-//Someone Else//Mail//EN"}`,
        ...(o.method ? [`METHOD:${o.method}`] : []),
        "BEGIN:VEVENT",
        `UID:${o.uid}`,
        `DTSTAMP:${stamp(new Date())}`,
        `DTSTART:${stamp(o.start)}`,
        `DTEND:${stamp(o.end)}`,
        "SUMMARY:Video Test",
        `SEQUENCE:${o.sequence ?? 0}`,
        ...(o.status ? [`STATUS:${o.status}`] : []),
        ...(o.extra ?? []),
        `ORGANIZER;CN=Boss:mailto:${o.organizer}`,
        ...o.attendees.map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT${a.partstat ? `;PARTSTAT=${a.partstat}` : ""}:mailto:${a.address}`),
        "END:VEVENT",
        "END:VCALENDAR",
    ].join("\r\n");

export function calendarInviteSuite(ctx: CalendarInviteSuiteContext): void {
    const as = (token: string) => (req: any) => req.set("Authorization", "jwt " + token);
    const owner = as(ctx.ownerToken);
    const inviteUrl = (messageUid: string, action: string = "") => `${ctx.baseUrl}/invite/${messageUid}${action}`;
    const start = new Date(Date.now() + 48 * HOUR);
    const end = new Date(start.getTime() + HOUR);
    const eventUid = "invite-uid-1@boss.example.com";

    /** A stored message from someone else carrying `content` as a `text/calendar` part (the shape a mail client sends). */
    const receive = async (mailboxUid: string, folderUid: string, content: string | undefined, method: string = "request", data?: any) => {
        const { unverified, ...fields } = data ?? {};
        const composer = new MailComposer({
            from: "boss@boss.example.com",
            to: "me@example.com",
            subject: "Invitation: Video Test",
            text: "You have been invited to: Video Test",
            // What this deployment's MTA stamps on a message whose sender's DKIM signature verified.
            ...(unverified ? {} : { headers: { "Authentication-Results": "mx.example.com; dkim=pass header.d=boss.example.com" } }),
            ...(content ? { icalEvent: { method, content } } : {}),
        });
        const raw: Buffer = await composer.compile().build();
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await ctx.blobStore().put(bodyBlobKey, raw);
        return await ctx.createMessage(mailboxUid, folderUid, {
            bodyBlobKey,
            from: { address: "boss@boss.example.com", type: RecipientType.TO },
            hasAttachments: !!content,
            ...fields,
        });
    };

    /** A mailbox of the owner with an Inbox and a Calendar, and the address invitations are sent to. */
    const setup = async () => {
        const mailbox = await ctx.createMailbox(ctx.ownerUid);
        const inbox = await ctx.createFolder(mailbox.uid, FolderType.INBOX);
        const calendar = await ctx.createFolder(mailbox.uid, FolderType.CALENDAR);
        return { mailbox, inbox, calendar, me: mailbox.primarySmtpAddress as string };
    };

    const requestFor = (me: string, extra: Partial<IcsOptions> = {}): string =>
        ics({ method: "REQUEST", uid: eventUid, start, end, organizer: "boss@boss.example.com", attendees: [{ address: me, partstat: "NEEDS-ACTION" }], ...extra });

    describe("zero-access messages (the client sends the calendar file)", () => {
        /** A zero-access message as stored: the sealed form's outer headers - its MTA's `Authentication-Results` among them - over an
         * opaque body the server can't read a calendar file from. */
        const keys: Map<string, TestZeroAccessKey> = new Map();
        const keyOf = async (mailboxUid: string): Promise<TestZeroAccessKey> => {
            if (!keys.has(mailboxUid)) {
                keys.set(mailboxUid, await ctx.addZeroAccessKey(mailboxUid));
            }
            return keys.get(mailboxUid)!;
        };
        const receiveSealed = async (mailboxUid: string, folderUid: string, verified: boolean = true) => {
            const raw: Buffer = Buffer.from(
                [
                    ...(verified ? ["Authentication-Results: mx.example.com; dkim=pass header.d=boss.example.com"] : []),
                    "From: boss@boss.example.com",
                    "To: me@example.com",
                    "Subject: [...]",
                    "MIME-Version: 1.0",
                    'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
                    "Content-Transfer-Encoding: base64",
                    "",
                    Buffer.from("not a calendar").toString("base64"),
                    "",
                ].join("\r\n"),
            );
            const bodyBlobKey = `za/${mailboxUid}/${uuid.v4()}`;
            await ctx.blobStore().put(bodyBlobKey, raw);
            return await ctx.createMessage(mailboxUid, folderUid, {
                bodyBlobKey,
                subject: "[...]",
                from: { address: "boss@boss.example.com", type: RecipientType.TO },
                hasAttachments: true,
                zeroAccess: { keyFingerprint: (await keyOf(mailboxUid)).key.fingerprint, sealedSummary: "s" },
            });
        };

        it("Describes the invitation from the calendar file the client decrypted, and has none to read without it.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receiveSealed(mailbox.uid, inbox.uid);

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/view"))).send({ ics: requestFor(me) });

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({ method: "REQUEST", uid: eventUid, summary: "Video Test", canRespond: true });
            expect((await owner(request(ctx.app()).get(inviteUrl(message.uid)))).status).toBe(404);
        });

        it("Answers it from the client's calendar file: the meeting goes on the calendar and the organizer gets the reply.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receiveSealed(mailbox.uid, inbox.uid);

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted", ics: requestFor(me) });

            expect(result.status).toBe(200);
            expect(result.body.onCalendar).toBe(true);
            const events: any[] = await ctx.findEvents(mailbox.uid);
            expect(events.map((event: any) => event.icalUid)).toEqual([eventUid]);
            expect(ctx.transport().sent.length).toBeGreaterThan(0);
            // Filed as inbound delivery files a zero-access invitation: its content only sealed, to the message's key.
            expect(events[0].title).toBe("[...]");
            expect(events[0].encryptionOrigin).toBe("derived");
            expect(JSON.stringify(events[0])).not.toContain("Video Test");
            expect(events[0].sealedContent.keyFingerprint).toBe((await keyOf(mailbox.uid)).key.fingerprint);
        });

        it("Keeps the meeting sealed when it is answered again after a decline, and seals a newer revision it applies", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receiveSealed(mailbox.uid, inbox.uid);
            const answer = async (responseStatus: string, file: string) =>
                await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus, ics: file });

            expect((await answer("declined", requestFor(me))).status).toBe(200);
            expect((await answer("accepted", requestFor(me))).status).toBe(200);
            const [accepted] = await ctx.findEvents(mailbox.uid);
            expect(accepted.title).toBe("[...]");
            expect(accepted.sealedContent).toBeTruthy();

            const newer = await answer("accepted", requestFor(me, { sequence: 1, extra: ["LOCATION:Room 9"] }));
            expect(newer.status).toBe(200);
            const [updated] = await ctx.findEvents(mailbox.uid);
            expect(updated.sequence).toBe(1);
            expect(updated.title).toBe("[...]");
            expect(updated.location ?? null).toBeNull();
            expect(JSON.stringify(updated)).not.toContain("Room 9");
            expect(updated.sealedContent.sealed).not.toBe(accepted.sealedContent.sealed);
        });

        it("Seals a newer revision into the message's key though the copy was sealed field by field while the calendar was protected", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            // Mail stays zero-access; the calendar isn't protected any more (undecided here), but the copy kept its per-field sealing.
            const message = await receiveSealed(mailbox.uid, inbox.uid);
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                uid: nameBasedUuid(`itip:${mailbox.uid}:${eventUid}:master`),
                icalUid: eventUid,
                title: "Protected event",
                sealedFields: { title: "c2VhbGVk", location: "c2VhbGVk" },
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
                sequence: 0,
                inviteSequenceSent: 0,
            });

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({
                responseStatus: "accepted",
                ics: requestFor(me, { sequence: 1, extra: ["LOCATION:CANARY Room 9", "DESCRIPTION:CANARY agenda"] }),
            });

            expect(result.status).toBe(200);
            const [row] = await ctx.findEvents(mailbox.uid);
            expect(row.sequence).toBe(1);
            expect(row.title).toBe("[...]");
            expect(row.location ?? null).toBeNull();
            expect(row.description ?? null).toBeNull();
            expect(JSON.stringify(row)).not.toContain("CANARY");
            expect(JSON.stringify(row)).not.toContain("Video Test");
            expect(row.sealedContent.keyFingerprint).toBe((await keyOf(mailbox.uid)).key.fingerprint);
            // The per-field copies the revision replaces go, so no client opens the old ones over it.
            expect(row.sealedFields ?? null).toBeNull();
        });

        describe("one occurrence detached from a series filed from a zero-access invitation (a create naming its icalUid)", () => {
            /** A mailbox whose mail is zero-access and whose calendar isn't protected, with a daily series accepted from a sealed message. */
            const acceptedSeries = async () => {
                const context = await setup();
                keys.set(context.mailbox.uid, await ctx.addZeroAccessKey(context.mailbox.uid, { mail: true, calendar: false, contacts: false, tasks: false }));
                const message = await receiveSealed(context.mailbox.uid, context.inbox.uid);
                const answered = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({
                    responseStatus: "accepted",
                    ics: requestFor(context.me, { extra: ["RRULE:FREQ=DAILY;COUNT=5"] }),
                });
                expect(answered.status).toBe(200);
                const [series] = await ctx.findEvents(context.mailbox.uid);
                expect(series.sealedContent).toBeTruthy();
                return { ...context, series };
            };
            const occurrenceStart = new Date(start.getTime() + 24 * HOUR);
            const occurrence = (mailbox: any, calendar: any, me: string, fields: any = {}) => ({
                mailboxUid: mailbox.uid,
                folderUid: calendar.uid,
                icalUid: eventUid,
                recurrenceId: occurrenceStart,
                startDate: new Date(occurrenceStart.getTime() + 2 * HOUR),
                endDate: new Date(occurrenceStart.getTime() + 3 * HOUR),
                allDay: false,
                title: "CANARY Video Test",
                location: "CANARY https://meet.example.com/m/1#k=secret",
                description: "CANARY agenda",
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.ACCEPTED, isOrganizer: false }],
                ...fields,
            });

            it("Seals the occurrence's content to the series' key, though the calendar isn't protected, and stores only placeholders", async () => {
                const { mailbox, calendar, me, series } = await acceptedSeries();

                const result = await owner(request(ctx.app()).post(ctx.baseUrl)).send(
                    occurrence(mailbox, calendar, me, { sealedFields: { title: "c2VhbGVk" }, sealedContent: { keyFingerprint: "forged", sealed: "eA==" } }),
                );

                expect(result.status).toBeLessThan(300);
                const row: any = (await ctx.findEvents(mailbox.uid)).find((event: any) => event.uid !== series.uid);
                expect(row).toBeTruthy();
                expect(row.title).toBe("[...]");
                expect(row.location ?? null).toBeNull();
                expect(row.description ?? null).toBeNull();
                expect(row.descriptionHtml ?? null).toBeNull();
                expect(row.sealedFields ?? null).toBeNull();
                expect(row.encryptionOrigin).toBe("derived");
                expect(JSON.stringify(row)).not.toContain("CANARY");
                expect(JSON.stringify(row)).not.toContain("secret");
                expect(JSON.stringify(result.body)).not.toContain("CANARY");
                expect(row.sealedContent.keyFingerprint).toBe(series.sealedContent.keyFingerprint);
                expect(await openSealedField(row.sealedContent.sealed, keys.get(mailbox.uid)!)).toEqual({
                    title: "CANARY Video Test",
                    location: "CANARY https://meet.example.com/m/1#k=secret",
                    description: "CANARY agenda",
                });
            });

            it("Refuses (409) the occurrence when the series' key is gone, storing nothing", async () => {
                const { mailbox, calendar, me } = await acceptedSeries();
                // The mailbox's keys replaced wholesale: the series' key is no longer among them.
                await ctx.addZeroAccessKey(mailbox.uid, { mail: true, calendar: false, contacts: false, tasks: false });

                const result = await owner(request(ctx.app()).post(ctx.baseUrl)).send(occurrence(mailbox, calendar, me));

                expect(result.status).toBe(409);
                const rows: any[] = await ctx.findEvents(mailbox.uid);
                expect(rows).toHaveLength(1);
                expect(JSON.stringify(rows)).not.toContain("CANARY");
            });

            it("Gives an occurrence a client that couldn't open the series sends back with its placeholders the series' sealed content", async () => {
                const { mailbox, calendar, me, series } = await acceptedSeries();

                const result = await owner(request(ctx.app()).post(ctx.baseUrl)).send(
                    occurrence(mailbox, calendar, me, { title: "[...]", location: null, description: null }),
                );

                expect(result.status).toBeLessThan(300);
                const row: any = (await ctx.findEvents(mailbox.uid)).find((event: any) => event.uid !== series.uid);
                expect(row.title).toBe("[...]");
                expect(row.sealedContent).toEqual(series.sealedContent);
                expect(row.sealedFields ?? null).toBeNull();
                expect((await openSealedField(row.sealedContent.sealed, keys.get(mailbox.uid)!)).title).toBe("Video Test");
            });

            it("Gives such an occurrence the title's sealed copy too when the series' sealed content names no title", async () => {
                const { mailbox, calendar, me } = await setup();
                const key = await keyOf(mailbox.uid);
                // What a revision without SUMMARY over a copy sealed field by field leaves: content sealed with an empty title, and the
                // title's per-field copy.
                const series = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                    icalUid: eventUid,
                    title: "[...]",
                    startDate: start,
                    endDate: end,
                    recurrenceRule: { freq: "daily", interval: 1, exceptions: [] },
                    sealedContent: { keyFingerprint: key.key.fingerprint, sealed: "eA==" },
                    sealedFields: { title: "c2VhbGVkIHRpdGxl" },
                    organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                    attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.ACCEPTED, isOrganizer: false }],
                });

                const result = await owner(request(ctx.app()).post(ctx.baseUrl)).send(
                    occurrence(mailbox, calendar, me, { title: "[...]", location: null, description: null }),
                );

                expect(result.status).toBeLessThan(300);
                const row: any = (await ctx.findEvents(mailbox.uid)).find((event: any) => event.uid !== series.uid);
                expect(row.sealedContent).toEqual(series.sealedContent);
                expect(row.sealedFields).toEqual({ title: "c2VhbGVkIHRpdGxl" });
            });

            it("Leaves a create of another icalUid, or of another mailbox's series, to the calendar's own setting", async () => {
                const { mailbox, calendar, me } = await acceptedSeries();
                const other = await setup();

                const unrelated = await owner(request(ctx.app()).post(ctx.baseUrl)).send(occurrence(mailbox, calendar, me, { icalUid: "another@boss.example.com", recurrenceId: undefined }));
                const elsewhere = await owner(request(ctx.app()).post(ctx.baseUrl)).send(occurrence(other.mailbox, other.calendar, other.me));

                expect(unrelated.status).toBeLessThan(300);
                expect(elsewhere.status).toBeLessThan(300);
                const readable: any = (await ctx.findEvents(mailbox.uid)).find((event: any) => event.icalUid === "another@boss.example.com");
                expect(readable.title).toBe("CANARY Video Test");
                expect(readable.sealedContent ?? null).toBeNull();
                const [copied] = await ctx.findEvents(other.mailbox.uid);
                expect(copied.title).toBe("CANARY Video Test");
                expect(copied.sealedContent ?? null).toBeNull();
            });
        });

        describe("an update of an event filed from a zero-access invitation by a client that couldn't open it", () => {
            const acceptedMeeting = async () => {
                const context = await setup();
                const message = await receiveSealed(context.mailbox.uid, context.inbox.uid);
                expect((await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted", ics: requestFor(context.me) })).status).toBe(200);
                const [row] = await ctx.findEvents(context.mailbox.uid);
                return { ...context, row };
            };

            it("Keeps the sealed content of the event written back as it was served, with a new time", async () => {
                const { mailbox, row } = await acceptedMeeting();
                const served = await owner(request(ctx.app()).get(`${ctx.baseUrl}/${row.uid}`));
                expect(served.body).toMatchObject({ title: "[...]" });
                const later = new Date(start.getTime() + 3 * HOUR);

                const result = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({
                    ...served.body,
                    startDate: later,
                    endDate: new Date(later.getTime() + HOUR),
                });

                expect(result.status).toBe(200);
                const [updated] = await ctx.findEvents(mailbox.uid);
                expect(new Date(updated.startDate).getTime()).toBe(later.getTime());
                expect(updated.sealedContent).toEqual(row.sealedContent);
                expect((await openSealedField(updated.sealedContent.sealed, keys.get(mailbox.uid)!)).title).toBe("Video Test");
            });

            it("Refuses (409) a new location sent with the placeholder title, which resealing would lose", async () => {
                const { mailbox, row } = await acceptedMeeting();

                const result = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({
                    uid: row.uid,
                    version: row.version,
                    title: "[...]",
                    location: "CANARY Room 5",
                });

                expect(result.status).toBe(409);
                const [unchanged] = await ctx.findEvents(mailbox.uid);
                expect(unchanged.sealedContent).toEqual(row.sealedContent);
                expect(JSON.stringify(unchanged)).not.toContain("CANARY");
            });
        });

        describe("an update of an event filed from a zero-access invitation by a client that opened it", () => {
            const acceptedMeeting = async () => {
                const context = await setup();
                const message = await receiveSealed(context.mailbox.uid, context.inbox.uid);
                const answer = async (file: string) =>
                    await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted", ics: file });
                expect((await answer(requestFor(context.me, { extra: ["LOCATION:Room 9"] }))).status).toBe(200);
                const [row] = await ctx.findEvents(context.mailbox.uid);
                expect(row.location ?? null).toBeNull();
                return { ...context, row, answer };
            };
            /** A save of the event dialog: the opened content, whatever else changed. */
            const save = async (row: any, fields: any) =>
                await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({ uid: row.uid, version: row.version, title: "Video Test", location: "Room 9", ...fields });

            it("Keeps the sequence for a save that changes only the reminder, so the organizer's next revision is applied", async () => {
                const { mailbox, me, row, answer } = await acceptedMeeting();

                expect((await save(row, { reminderMinutesBeforeStart: 5, sequence: 0 })).status).toBe(200);

                const [saved] = await ctx.findEvents(mailbox.uid);
                expect(saved.sequence).toBe(0);
                expect(saved.reminderMinutesBeforeStart).toBe(5);
                expect(saved.location ?? null).toBeNull();
                const later = new Date(start.getTime() + 4 * HOUR);
                expect((await answer(requestFor(me, { sequence: 1, start: later, end: new Date(later.getTime() + HOUR), extra: ["LOCATION:Room 9"] }))).status).toBe(200);
                const [moved] = await ctx.findEvents(mailbox.uid);
                expect(moved.sequence).toBe(1);
                // To the second, as the calendar file carries it.
                expect(new Date(moved.startDate).getTime()).toBe(Math.floor(later.getTime() / 1000) * 1000);
            });

            it("Takes a sequence the client raised for a changed location, and drops one that isn't higher than the stored one", async () => {
                const { mailbox, row } = await acceptedMeeting();

                expect((await save(row, { location: "CANARY Room 10", sequence: 1 })).status).toBe(200);
                const [raised] = await ctx.findEvents(mailbox.uid);
                expect(raised.sequence).toBe(1);
                expect(JSON.stringify(raised)).not.toContain("CANARY");

                expect((await save(raised, { location: "CANARY Room 10", reminderMinutesBeforeStart: 30, sequence: 0 })).status).toBe(200);
                const [kept] = await ctx.findEvents(mailbox.uid);
                expect(kept.sequence).toBe(1);
                expect(kept.reminderMinutesBeforeStart).toBe(30);
            });

            it("Checks, bounds and sanitizes the description it seals, as for any other event (round 7, #707)", async () => {
                const { mailbox, row } = await acceptedMeeting();

                expect((await save(row, { descriptionHtml: `<p>${"x".repeat(MAX_EVENT_DESCRIPTION_HTML_LENGTH)}</p>` })).status).toBe(400);
                expect((await save(row, { description: 42 })).status).toBe(400);
                const [unchanged] = await ctx.findEvents(mailbox.uid);
                expect(unchanged.sealedContent).toEqual(row.sealedContent);

                expect((await save(row, { descriptionHtml: '<p>Agenda<script>alert("x")</script></p>' })).status).toBe(200);
                const [saved] = await ctx.findEvents(mailbox.uid);
                const opened: any = await openSealedField(saved.sealedContent.sealed, keys.get(mailbox.uid)!);
                expect(opened.descriptionHtml).toContain("Agenda");
                expect(opened.descriptionHtml).not.toContain("script");
                // The plain text derived from the HTML, as for a readable event.
                expect(opened.description).toBe("Agenda");
            });
        });

        describe("a meeting the mailbox organizes whose content is sealed whole", () => {
            const GUEST = "guest@elsewhere.example";
            const organized = async () => {
                const context = await setup();
                const key = await keyOf(context.mailbox.uid);
                const row = await ctx.createCalendarEvent(context.mailbox.uid, context.calendar.uid, {
                    icalUid: `organized-${uuid.v4()}`,
                    title: "[...]",
                    sealedContent: { keyFingerprint: key.key.fingerprint, sealed: "eA==" },
                    organizer: { address: context.me, type: RecipientType.TO },
                    attendees: [{ address: GUEST, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
                    sequence: 0,
                    inviteSequenceSent: 0,
                });
                return { ...context, row };
            };
            const moved = (row: any, fields: any = {}) => ({
                uid: row.uid,
                version: row.version,
                startDate: new Date(start.getTime() + 5 * HOUR),
                endDate: new Date(start.getTime() + 6 * HOUR),
                ...fields,
            });

            it("Invites for a move from the content the organizer's client opened, never from the placeholders", async () => {
                const { mailbox, row } = await organized();
                const before = ctx.transport().sent.length;

                const result = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send(
                    moved(row, { title: "CANARY Board review", location: "CANARY Room 2", description: null, descriptionHtml: null }),
                );

                expect(result.status).toBe(200);
                const sent = ctx.transport().sent.slice(before);
                expect(sent).toHaveLength(1);
                const text = decoded(sent[0].raw);
                expect(text).toContain("SUMMARY:CANARY Board review");
                expect(text).not.toContain("[...]");
                const [stored] = await ctx.findEvents(mailbox.uid);
                expect(stored.inviteSequenceSent).toBe(stored.sequence);
                expect(stored.title).toBe("[...]");
                expect(JSON.stringify(stored)).not.toContain("CANARY");
            });

            it("Sends nothing for a move by a client that couldn't open it, leaving the revision pending", async () => {
                const { mailbox, row } = await organized();
                const before = ctx.transport().sent.length;

                const result = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send(moved(row, { title: "[...]", location: null }));

                expect(result.status).toBe(200);
                expect(ctx.transport().sent.length).toBe(before);
                const [stored] = await ctx.findEvents(mailbox.uid);
                expect(stored.sequence).toBe(1);
                expect(stored.inviteSequenceSent).toBe(0);
                expect(stored.sealedContent).toEqual(row.sealedContent);
            });

            it("Invites no one for a save of the opened meeting that changes only its reminder, and everyone when its client raises the sequence", async () => {
                const { mailbox, row } = await organized();
                const before = ctx.transport().sent.length;
                const opened = { uid: row.uid, title: "CANARY Board review", location: "CANARY Room 2" };

                const reminder = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({ ...opened, version: row.version, reminderMinutesBeforeStart: 15 });

                expect(reminder.status).toBe(200);
                expect(ctx.transport().sent.length).toBe(before);
                const [saved] = await ctx.findEvents(mailbox.uid);
                expect(saved.sequence).toBe(0);

                const relocated = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({
                    ...opened,
                    version: saved.version,
                    location: "CANARY Room 3",
                    sequence: 1,
                });

                expect(relocated.status).toBe(200);
                const sent = ctx.transport().sent.slice(before);
                expect(sent).toHaveLength(1);
                expect(decoded(sent[0].raw)).toContain("LOCATION:CANARY Room 3");
                const [stored] = await ctx.findEvents(mailbox.uid);
                expect(stored.sequence).toBe(1);
                expect(stored.inviteSequenceSent).toBe(1);
                expect(JSON.stringify(stored)).not.toContain("CANARY");
            });

            it("Sends a changed description when its client raises the sequence, and nothing without it - the server can't see the change", async () => {
                const { mailbox, row } = await organized();
                const before = ctx.transport().sent.length;
                const opened = { uid: row.uid, title: "CANARY Board review", location: "CANARY Room 2" };

                const unsignalled = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({
                    ...opened,
                    version: row.version,
                    description: "CANARY old agenda",
                });

                expect(unsignalled.status).toBe(200);
                expect(ctx.transport().sent.length).toBe(before);
                const [saved] = await ctx.findEvents(mailbox.uid);
                expect(saved.sequence).toBe(0);

                const signalled = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({
                    ...opened,
                    version: saved.version,
                    description: "CANARY new agenda",
                    sequence: 1,
                });

                expect(signalled.status).toBe(200);
                const sent = ctx.transport().sent.slice(before);
                expect(sent).toHaveLength(1);
                expect(decoded(sent[0].raw)).toContain("DESCRIPTION:CANARY new agenda");
                const [stored] = await ctx.findEvents(mailbox.uid);
                expect(stored.sequence).toBe(1);
                expect(stored.inviteSequenceSent).toBe(1);
                expect(JSON.stringify(stored)).not.toContain("CANARY");
            });
        });

        it("Keeps the title's sealed copy when an answered revision names no title, though its location goes into sealed content", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            // Mail stays zero-access; the calendar isn't protected any more, but the copy kept its per-field sealing.
            const message = await receiveSealed(mailbox.uid, inbox.uid);
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                uid: nameBasedUuid(`itip:${mailbox.uid}:${eventUid}:master`),
                icalUid: eventUid,
                title: "Protected event",
                sealedFields: { title: "c2VhbGVkIHRpdGxl" },
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
                sequence: 0,
                inviteSequenceSent: 0,
            });

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({
                responseStatus: "accepted",
                ics: requestFor(me, { sequence: 1, extra: ["LOCATION:CANARY Room 9"] }).replace("SUMMARY:Video Test\r\n", ""),
            });

            expect(result.status).toBe(200);
            const [row] = await ctx.findEvents(mailbox.uid);
            expect(row.sequence).toBe(1);
            expect(row.sealedContent.keyFingerprint).toBe((await keyOf(mailbox.uid)).key.fingerprint);
            expect(row.location ?? null).toBeNull();
            expect(JSON.stringify(row)).not.toContain("CANARY");
            // The only copy of the title there is.
            expect(row.sealedFields).toEqual({ title: "c2VhbGVkIHRpdGxl" });
        });

        describe("a copy whose title has a per-field sealed copy beside its sealed content (round 5, #521)", () => {
            const combined = async () => {
                const context = await setup();
                const key = await keyOf(context.mailbox.uid);
                const row = await ctx.createCalendarEvent(context.mailbox.uid, context.calendar.uid, {
                    uid: nameBasedUuid(`itip:${context.mailbox.uid}:${eventUid}:master`),
                    icalUid: eventUid,
                    title: "[...]",
                    sealedContent: { keyFingerprint: key.key.fingerprint, sealed: "eA==" },
                    sealedFields: { title: "c2VhbGVkIHRpdGxl" },
                    organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                    attendees: [
                        { address: context.me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false },
                    ],
                    sequence: 0,
                    inviteSequenceSent: 0,
                });
                return { ...context, row };
            };

            it("Drops the title's per-field copy when the reader renames the event, so the old title can't be opened over the new one", async () => {
                const { mailbox, row } = await combined();

                const result = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({
                    uid: row.uid,
                    version: row.version,
                    title: "CANARY Budget v2",
                    location: "CANARY Room 4",
                });

                expect(result.status).toBe(200);
                const [stored] = await ctx.findEvents(mailbox.uid);
                expect(stored.sealedFields ?? null).toBeNull();
                expect(stored.sealedContent.sealed).not.toBe("eA==");
                expect(stored.title).toBe("[...]");
                expect(JSON.stringify(stored)).not.toContain("CANARY");
            });

            it("Keeps the title's per-field copy for a save that seals nothing (a reminder change)", async () => {
                const { mailbox, row } = await combined();

                const result = await owner(request(ctx.app()).put(`${ctx.baseUrl}/${row.uid}`)).send({
                    uid: row.uid,
                    version: row.version,
                    reminderMinutesBeforeStart: 15,
                });

                expect(result.status).toBe(200);
                const [stored] = await ctx.findEvents(mailbox.uid);
                expect(stored.sealedFields).toEqual({ title: "c2VhbGVkIHRpdGxl" });
                expect(stored.sealedContent).toEqual(row.sealedContent);
            });

            it("Drops the title's per-field copy when an answered revision names a title", async () => {
                const { mailbox, inbox, me } = await combined();
                const message = await receiveSealed(mailbox.uid, inbox.uid);

                const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({
                    responseStatus: "accepted",
                    ics: requestFor(me, { sequence: 1 }),
                });

                expect(result.status).toBe(200);
                const [stored] = await ctx.findEvents(mailbox.uid);
                expect(stored.sequence).toBe(1);
                expect(stored.sealedFields ?? null).toBeNull();
                expect(stored.sealedContent.sealed).not.toBe("eA==");
            });
        });

        it("Clears the readable location of a copy not sealed yet when a newer revision in a protected calendar names none", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            await ctx.addZeroAccessKey(mailbox.uid, { mail: false, calendar: true, contacts: false, tasks: false });
            // Filed before the calendar was protected, and not reached by the backfill yet.
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                uid: nameBasedUuid(`itip:${mailbox.uid}:${eventUid}:master`),
                icalUid: eventUid,
                title: "Video Test",
                location: "CANARY board room, door code 4411",
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
                sequence: 0,
                inviteSequenceSent: 0,
            });
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me, { sequence: 1 }));

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            expect(result.status).toBe(200);
            const [row] = await ctx.findEvents(mailbox.uid);
            expect(row.sequence).toBe(1);
            expect(row.location ?? null).toBeNull();
            expect(JSON.stringify(row)).not.toContain("CANARY");
            expect(Object.keys(row.sealedFields)).toEqual(["title"]);
        });

        it("Still tells a verified organizer's change of a meeting on the calendar from a forged one, by the stored Authentication-Results.", async () => {
            const { mailbox, inbox, me } = await setup();
            const first = await receiveSealed(mailbox.uid, inbox.uid);
            await owner(request(ctx.app()).post(inviteUrl(first.uid, "/respond"))).send({ responseStatus: "accepted", ics: requestFor(me) });
            const forged = await receiveSealed(mailbox.uid, inbox.uid, false);
            const verified = await receiveSealed(mailbox.uid, inbox.uid);
            const update = requestFor(me, { sequence: 1 });

            const refused = await owner(request(ctx.app()).post(inviteUrl(forged.uid, "/respond"))).send({ responseStatus: "accepted", ics: update });
            const accepted = await owner(request(ctx.app()).post(inviteUrl(verified.uid, "/respond"))).send({ responseStatus: "accepted", ics: update });

            expect(refused.status).toBe(403);
            expect(accepted.status).toBe(200);
        });

        it("Refuses a calendar file for a message the server reads itself, and one that isn't text.", async () => {
            const { mailbox, inbox, me } = await setup();
            const plain = await receive(mailbox.uid, inbox.uid, requestFor(me));
            const sealed = await receiveSealed(mailbox.uid, inbox.uid);

            expect((await owner(request(ctx.app()).post(inviteUrl(plain.uid, "/view"))).send({ ics: requestFor(me) })).status).toBe(400);
            expect((await owner(request(ctx.app()).post(inviteUrl(sealed.uid, "/view"))).send({ ics: 42 })).status).toBe(400);
            expect((await owner(request(ctx.app()).post(inviteUrl(sealed.uid, "/remove"))).send({})).status).toBe(404);
        });
    });

    describe("GET /invite/:messageUid", () => {
        it("Describes the invitation a message carries and what the reader can do with it.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));

            const result = await owner(request(ctx.app()).get(inviteUrl(message.uid)));

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({
                method: "REQUEST",
                uid: eventUid,
                summary: "Video Test",
                isOrganizer: false,
                onCalendar: false,
                canRespond: true,
                canPropose: true,
                canAdd: false,
                canRemove: false,
                conflicts: [],
            });
            expect(result.body.organizer.address).toBe("boss@boss.example.com");
            expect(new Date(result.body.startDate).getTime()).toBe(Math.floor(start.getTime() / 1000) * 1000);
        });

        it("Lists the reader's own busy events that overlap the meeting as conflicts, and the events around it as the schedule.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            const clash = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                title: "Dentist",
                startDate: new Date(start.getTime() + 30 * 60 * 1000),
                endDate: new Date(start.getTime() + 90 * 60 * 1000),
            });
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                title: "Lunch (free)",
                busyStatus: BusyStatus.FREE,
                startDate: start,
                endDate: end,
            });
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                title: "Next day",
                startDate: new Date(start.getTime() + 30 * HOUR),
                endDate: new Date(start.getTime() + 31 * HOUR),
            });
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));

            const result = await owner(request(ctx.app()).get(inviteUrl(message.uid)));

            expect(result.body.conflicts.map((entry: any) => entry.title)).toEqual(["Dentist"]);
            expect(result.body.conflicts[0].uid).toBe(clash.uid);
            expect(result.body.schedule.map((entry: any) => entry.title).sort()).toEqual(["Dentist", "Lunch (free)"]);
        });

        it("Does not count the meeting itself, once on the calendar, as a conflict.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));
            await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            const result = await owner(request(ctx.app()).get(inviteUrl(message.uid)));

            expect(result.body.onCalendar).toBe(true);
            expect(result.body.response).toBe("accepted");
            expect(result.body.conflicts).toEqual([]);
        });

        it("Reads a reply as the attendee's answer, with nothing to answer.", async () => {
            const { mailbox, inbox } = await setup();
            const reply = ics({
                method: "REPLY",
                uid: eventUid,
                start,
                end,
                organizer: mailbox.primarySmtpAddress,
                attendees: [{ address: "boss@boss.example.com", partstat: "TENTATIVE" }],
            });
            const message = await receive(mailbox.uid, inbox.uid, reply, "reply");

            const result = await owner(request(ctx.app()).get(inviteUrl(message.uid)));

            expect(result.body.method).toBe("REPLY");
            expect(result.body.reply).toMatchObject({ address: "boss@boss.example.com", responseStatus: "tentative" });
            expect(result.body).toMatchObject({ canRespond: false, canAdd: false, canRemove: false, canPropose: false });
        });

        it("Reads a file that names no METHOD as an event that can be added.", async () => {
            const { mailbox, inbox } = await setup();
            const plain = ics({ uid: "exported@x", start, end, organizer: "boss@boss.example.com", attendees: [] });
            const message = await receive(mailbox.uid, inbox.uid, plain, "publish");
            // The composer stamps its own method; a bare export has none - strip it as a file saved from another client would be.
            const blobKey = message.bodyBlobKey as string;
            const raw = (await ctx.blobStore().get(blobKey)).toString().replace(/method=PUBLISH/i, "").replace(/^METHOD:PUBLISH\r?\n/im, "");
            await ctx.blobStore().put(blobKey, Buffer.from(raw));

            const result = await owner(request(ctx.app()).get(inviteUrl(message.uid)));

            expect(result.status).toBe(200);
            expect(result.body.canAdd).toBe(true);
            expect(result.body.canRespond).toBe(false);
        });

        it("Is a 404 for a message with no calendar file, an encrypted one, and one whose blob is gone.", async () => {
            const { mailbox, inbox, me } = await setup();
            const plain = await receive(mailbox.uid, inbox.uid, undefined);
            const encrypted = await receive(mailbox.uid, inbox.uid, requestFor(me), "request", { encrypted: true });
            const gone = await ctx.createMessage(mailbox.uid, inbox.uid, { bodyBlobKey: `bodies/${uuid.v4()}` });

            for (const message of [plain, encrypted, gone]) {
                expect((await owner(request(ctx.app()).get(inviteUrl(message.uid)))).status).toBe(404);
            }
            expect((await owner(request(ctx.app()).get(inviteUrl(uuid.v4())))).status).toBe(404);
        });

        it("Is a 404 for someone who can't read the message.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));

            const result = await as(ctx.otherToken)(request(ctx.app()).get(inviteUrl(message.uid)));

            expect(result.status).toBe(404);
        });
    });

    describe("the event dialog's fields in an invitation", () => {
        const dialogExtra = [
            "DESCRIPTION:Agenda: budget",
            'X-ALT-DESC;FMTTYPE=text/html:<p onclick=\\"x()\\">Agenda: <b>budget</b></p><script>alert(1)</script>',
            "CLASS:PRIVATE",
            "X-RAPIDMX-GUESTS-CAN-MODIFY:TRUE",
            "X-RAPIDMX-GUESTS-CAN-INVITE:FALSE",
            "X-RAPIDMX-GUESTS-CAN-SEE-GUEST-LIST:FALSE",
        ];
        const everyone = (me: string) => [{ address: me, partstat: "NEEDS-ACTION" }, { address: "peer@example.com", partstat: "ACCEPTED" }, { address: "third@example.com" }];

        it("Reports the description (sanitized), visibility and guest permissions, and offers a guest only the requests the organizer allows.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me, { extra: dialogExtra }));

            const before = await owner(request(ctx.app()).get(inviteUrl(message.uid)));
            expect(before.body).toMatchObject({
                description: "Agenda: budget",
                descriptionHtml: "<p>Agenda: <b>budget</b></p>",
                visibility: "private",
                guestPermissions: { guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: false },
                onCalendar: false,
                canRequestChange: false,
                canRequestInvite: false,
            });

            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                icalUid: eventUid,
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
            });
            const after = await owner(request(ctx.app()).get(inviteUrl(message.uid)));
            expect(after.body).toMatchObject({ onCalendar: true, canRequestChange: true, canRequestInvite: false });
            expect(after.body.calendarEventUid).toBeTruthy();
        });

        it("Reports the defaults for an invitation that names none of them (another vendor's organizer never acts on a request to add guests).", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));

            const result = await owner(request(ctx.app()).get(inviteUrl(message.uid)));

            expect(result.body.visibility).toBe("default");
            expect(result.body.guestPermissions).toEqual({ guestsCanModify: false, guestsCanInviteOthers: false, guestsCanSeeGuestList: true });
            expect(result.body.description).toBeUndefined();
        });

        it("Lists only the reader for a guest when the organizer hides the guest list, and everyone when it is visible or the reader organizes.", async () => {
            const { mailbox, inbox, me } = await setup();
            const hidden = await receive(mailbox.uid, inbox.uid, requestFor(me, { extra: ["X-RAPIDMX-GUESTS-CAN-SEE-GUEST-LIST:FALSE"], attendees: everyone(me) }));
            const shown = await receive(mailbox.uid, inbox.uid, requestFor(me, { attendees: everyone(me) }));
            const own = await receive(mailbox.uid, inbox.uid, requestFor(me, { organizer: me, extra: ["X-RAPIDMX-GUESTS-CAN-SEE-GUEST-LIST:FALSE"], attendees: everyone("friend@example.com") }));

            expect((await owner(request(ctx.app()).get(inviteUrl(hidden.uid)))).body.attendees.map((entry: any) => entry.address)).toEqual([me]);
            expect((await owner(request(ctx.app()).get(inviteUrl(shown.uid)))).body.attendees).toHaveLength(3);
            expect((await owner(request(ctx.app()).get(inviteUrl(own.uid)))).body.attendees).toHaveLength(3);
        });

        it("Files the description, visibility and guest permissions with the calendar copy an answer creates - and only the reader of a hidden guest list.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me, { extra: dialogExtra, attendees: everyone(me) }));

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            expect(result.status).toBe(200);
            const [row] = await ctx.findEvents(mailbox.uid);
            expect(row).toMatchObject({
                description: "Agenda: budget",
                descriptionHtml: "<p>Agenda: <b>budget</b></p>",
                visibility: "private",
                guestsCanModify: true,
                guestsCanInviteOthers: false,
                guestsCanSeeGuestList: false,
            });
            expect(row.attendees.map((attendee: any) => attendee.address)).toEqual([me]);
        });

        it("Updates the description, visibility and guest permissions of the copy on the calendar from a newer invitation, and clears what it no longer has.", async () => {
            const { mailbox, inbox, me } = await setup();
            const first = await receive(mailbox.uid, inbox.uid, requestFor(me, { extra: dialogExtra }));
            await owner(request(ctx.app()).post(inviteUrl(first.uid, "/respond"))).send({ responseStatus: "accepted" });
            const newer = await receive(mailbox.uid, inbox.uid, requestFor(me, { sequence: 3 }));

            const result = await owner(request(ctx.app()).post(inviteUrl(newer.uid, "/respond"))).send({ responseStatus: "tentative" });

            expect(result.status).toBe(200);
            const [row] = await ctx.findEvents(mailbox.uid);
            expect(row.description ?? undefined).toBeUndefined();
            expect(row.descriptionHtml ?? undefined).toBeUndefined();
            // Another vendor's invitation names no permissions, and its server would never act on a request to add guests: only the list is visible.
            expect(row).toMatchObject({ visibility: "default", guestsCanModify: false, guestsCanInviteOthers: false, guestsCanSeeGuestList: true, sequence: 3 });
        });

        it("Reads a missing invite permission as allowed only in an invitation another RapidMX server wrote, so a request to add guests is offered only where it can work.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            const outside = await receive(mailbox.uid, inbox.uid, requestFor(me));
            await owner(request(ctx.app()).post(inviteUrl(outside.uid, "/respond"))).send({ responseStatus: "accepted" });
            const outsideView = await owner(request(ctx.app()).get(inviteUrl(outside.uid)));
            expect(outsideView.body).toMatchObject({ canRequestInvite: false, canRequestChange: false });
            expect((await ctx.findEvents(mailbox.uid))[0]).toMatchObject({ guestsCanInviteOthers: false });
            await owner(request(ctx.app()).post(inviteUrl(outside.uid, "/respond"))).send({ responseStatus: "declined" });
            expect(calendar.uid).toBeTruthy();

            const ours = await receive(mailbox.uid, inbox.uid, requestFor(me, { prodId: "-//RapidMX//Mail Server//EN" }));
            const acc = await owner(request(ctx.app()).post(inviteUrl(ours.uid, "/respond"))).send({ responseStatus: "accepted" });
            const oursView = await owner(request(ctx.app()).get(inviteUrl(ours.uid)));
            expect(oursView.body).toMatchObject({ canRequestInvite: true, canRequestChange: false });
            expect((await ctx.findEvents(mailbox.uid))[0]).toMatchObject({ guestsCanInviteOthers: true });
        });

        it("Mails the organizer a REPLY without any of the event's details, and a proposal without them either.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me, { extra: dialogExtra }));

            await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });
            await owner(request(ctx.app()).post(inviteUrl(message.uid, "/propose"))).send({ startDate: new Date(start.getTime() + HOUR).toISOString(), endDate: new Date(end.getTime() + HOUR).toISOString() });

            expect(ctx.transport().sent).toHaveLength(2);
            for (const sent of ctx.transport().sent) {
                const raw = decoded(sent.raw);
                for (const property of ["DESCRIPTION:", "X-ALT-DESC", "CLASS:", "X-RAPIDMX-"]) {
                    expect(raw).not.toContain(property);
                }
            }
        });

        it("Describes a guest's change request to the organizer: a proposal to accept while it is not applied, and an applied change once the message says so.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            const guestAddress = "guest@example.com";
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                icalUid: eventUid,
                organizer: { address: me, type: RecipientType.TO },
                attendees: [{ address: guestAddress, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.TENTATIVE, isOrganizer: false }],
                guestsCanModify: true,
            });
            const counter = ics({
                method: "COUNTER",
                uid: eventUid,
                start,
                end,
                organizer: me,
                attendees: [{ address: guestAddress, partstat: "TENTATIVE" }, { address: "added@example.com" }],
                extra: ["X-RAPIDMX-CHANGE-REQUEST:TRUE"],
            });
            const pending = await receive(mailbox.uid, inbox.uid, counter, "counter", { from: { address: guestAddress, type: RecipientType.TO } });

            const before = await owner(request(ctx.app()).get(inviteUrl(pending.uid)));
            expect(before.body).toMatchObject({ method: "COUNTER", changeRequest: { applied: false }, canAcceptProposal: true, isOrganizer: true });
            expect(before.body.attendees.map((entry: any) => entry.address)).toEqual([guestAddress, "added@example.com"]);

            const applied = await receive(mailbox.uid, inbox.uid, counter, "counter", { from: { address: guestAddress, type: RecipientType.TO }, meetingResponse: "accepted" });
            const after = await owner(request(ctx.app()).get(inviteUrl(applied.uid)));
            expect(after.body).toMatchObject({ changeRequest: { applied: true }, canAcceptProposal: false, response: "accepted" });
        });
    });

    describe("POST /invite/:messageUid/respond", () => {
        it("Accepting puts the meeting on the calendar at the uid inbound processing uses, and mails the organizer a REPLY.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({ onCalendar: true, response: "accepted", canRespond: true });
            const events = await ctx.findEvents(mailbox.uid);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({
                uid: nameBasedUuid(`itip:${mailbox.uid}:${eventUid}:master`),
                folderUid: calendar.uid,
                title: "Video Test",
                icalUid: eventUid,
                sequence: 0,
                inviteSequenceSent: 0,
            });
            expect(events[0].organizer.address).toBe("boss@boss.example.com");
            expect(events[0].attendees.find((a: any) => a.address === me).responseStatus).toBe("accepted");
            expect(new Date(events[0].startDate).getTime()).toBe(Math.floor(start.getTime() / 1000) * 1000);
            expect(result.body.calendarEventUid).toBe(events[0].uid);

            const sent = ctx.transport().sent;
            expect(sent).toHaveLength(1);
            expect(sent[0].envelopeTo).toEqual(["boss@boss.example.com"]);
            const raw = decoded(sent[0].raw);
            expect(raw).toContain("METHOD:REPLY");
            expect(raw).toContain("PARTSTAT=ACCEPTED");
            expect(raw).toContain(`UID:${eventUid}`);
            expect((await ctx.findMessage(message.uid)).meetingResponse).toBe("accepted");
        });

        it("Never sends the meeting's location back in the REPLY, so a keyed join link's #k= key can't reach the organizer's mailbox.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me, { extra: ["LOCATION:https://meet.example.com/j/T#k=CANARYKEY"] }));

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            expect(result.status).toBe(200);
            const raw = decoded(ctx.transport().sent[0].raw);
            expect(raw).toContain("METHOD:REPLY");
            expect(raw).not.toContain("LOCATION");
            expect(raw).not.toContain("CANARYKEY");
        });

        it("Tentatively accepting adds it as tentative, and changing the answer updates the one copy rather than making another.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));

            await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "tentative" });
            let events = await ctx.findEvents(mailbox.uid);
            expect(events).toHaveLength(1);
            expect(events[0].busyStatus).toBe(BusyStatus.TENTATIVE);
            expect(events[0].attendees.find((a: any) => a.address === me).responseStatus).toBe("tentative");

            const again = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            expect(again.body.response).toBe("accepted");
            events = await ctx.findEvents(mailbox.uid);
            expect(events).toHaveLength(1);
            expect(events[0].busyStatus).toBe(BusyStatus.BUSY);
            expect(events[0].attendees.find((a: any) => a.address === me).responseStatus).toBe("accepted");
            expect(ctx.transport().sent).toHaveLength(2);
        });

        it("Declining adds nothing to the calendar, removes a copy that was there, still mails the REPLY, and is remembered.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));

            const declined = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "declined" });

            expect(declined.status).toBe(200);
            expect(declined.body).toMatchObject({ onCalendar: false, response: "declined" });
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(0);
            expect(decoded(ctx.transport().sent[0].raw)).toContain("PARTSTAT=DECLINED");
            expect((await ctx.findMessage(message.uid)).meetingResponse).toBe("declined");

            await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(1);
            await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "declined" });
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(0);
        });

        it("Answers on the copy inbound processing already filed, and takes a newer revision's details.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            const filed = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                uid: nameBasedUuid(`itip:${mailbox.uid}:${eventUid}:master`),
                icalUid: eventUid,
                title: "Old title",
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
                sequence: 0,
                inviteSequenceSent: 0,
            });
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me, { sequence: 2 }));

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            expect(result.status).toBe(200);
            const events = await ctx.findEvents(mailbox.uid);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ uid: filed.uid, title: "Video Test", sequence: 2, inviteSequenceSent: 2 });
            expect(events[0].attendees[0].responseStatus).toBe("accepted");
        });

        it("Refuses a status that is an Object.prototype key, not only one that isn't a status.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));

            for (const responseStatus of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
                expect((await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus })).status).toBe(400);
            }
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(0);
            expect(ctx.transport().sent).toHaveLength(0);
        });

        it("Won't let an invitation that isn't from the organizer of the meeting on the calendar change or remove it.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            const filed = await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                icalUid: eventUid,
                title: "Real title",
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
                sequence: 0,
                inviteSequenceSent: 0,
            });
            const evil = { from: { address: "evil@evil.example.com", type: RecipientType.TO } };
            // An invitation naming another organizer, and one that names the organizer but isn't from them.
            const rewritten = await receive(mailbox.uid, inbox.uid, requestFor(me, { sequence: 5, organizer: "evil@evil.example.com" }), "request", evil);
            const spoofed = await receive(mailbox.uid, inbox.uid, requestFor(me, { sequence: 5 }), "request", evil);
            const cancelled = await receive(mailbox.uid, inbox.uid, requestFor(me, { method: "CANCEL", status: "CANCELLED" }), "cancel", evil);

            for (const message of [rewritten, spoofed]) {
                for (const responseStatus of ["accepted", "declined"]) {
                    expect((await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus })).status).toBe(403);
                }
            }
            expect((await owner(request(ctx.app()).post(inviteUrl(cancelled.uid, "/remove")))).status).toBe(403);
            const events = await ctx.findEvents(mailbox.uid);
            expect(events).toHaveLength(1);
            expect(events[0]).toMatchObject({ uid: filed.uid, title: "Real title", sequence: 0 });
        });

        it("Holds an occurrence of a series on the calendar to the series' organizer, though the occurrence has no row yet.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                icalUid: eventUid,
                title: "Real series",
                recurrenceRule: "FREQ=WEEKLY;COUNT=5",
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
            });
            const evil = { from: { address: "evil@evil.example.com", type: RecipientType.TO } };
            const forged = await receive(
                mailbox.uid,
                inbox.uid,
                requestFor(me, { sequence: 5, organizer: "evil@evil.example.com", extra: [`RECURRENCE-ID:${stamp(start)}`] }),
                "request",
                evil,
            );
            expect((await owner(request(ctx.app()).post(inviteUrl(forged.uid, "/respond"))).send({ responseStatus: "accepted" })).status).toBe(403);
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(1);
        });

        it("Needs the sender of an update to a meeting on the calendar to be DKIM-verified, not only to be named as its organizer.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                icalUid: eventUid,
                title: "Real title",
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
            });
            const answer = (uid: string) => owner(request(ctx.app()).post(inviteUrl(uid, "/respond"))).send({ responseStatus: "accepted" });
            const spoofed = await receive(mailbox.uid, inbox.uid, requestFor(me, { sequence: 5 }), "request", { unverified: true });
            expect((await answer(spoofed.uid)).status).toBe(403);
            const signed = await receive(mailbox.uid, inbox.uid, requestFor(me, { sequence: 5 }));
            expect((await answer(signed.uid)).status).toBe(200);
        });

        it("Checks the organizer of an invitation against the calendar copy whatever is missing: no ORGANIZER in the file, none on the copy, and a file with no METHOD is no invitation to act on.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            const crlf = String.fromCharCode(13, 10);
            const withoutOrganizer = requestFor(me, { sequence: 5 })
                .split(crlf)
                .filter((line) => !line.startsWith("ORGANIZER"))
                .join(crlf);
            const noOrganizerFile = await receive(mailbox.uid, inbox.uid, withoutOrganizer);
            const noMethodFile = await receive(mailbox.uid, inbox.uid, ics({ uid: eventUid, start, end, organizer: "boss@boss.example.com", attendees: [] }), "publish");
            const answer = (uid: string) => owner(request(ctx.app()).post(inviteUrl(uid, "/respond"))).send({ responseStatus: "accepted" });
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                icalUid: eventUid,
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.NEEDS_ACTION, isOrganizer: false }],
            });

            expect((await answer(noOrganizerFile.uid)).status).toBe(403);
            // A file with no METHOD isn't one of the kinds checked here; it is refused for what it is.
            expect((await answer(noMethodFile.uid)).status).toBe(400);

            // A calendar copy that records no organizer matches nobody.
            const [row] = await ctx.findEvents(mailbox.uid);
            const mine = await receive(mailbox.uid, inbox.uid, requestFor(me, { sequence: 6 }));
            await ctx.deleteEventOrganizer(row.uid);
            expect((await answer(mine.uid)).status).toBe(403);
        });

        it("Will not answer the reader's own invitation, a cancellation, a reply, or with a status that isn't one.", async () => {
            const { mailbox, inbox, me } = await setup();
            const own = await receive(mailbox.uid, inbox.uid, requestFor(me, { organizer: me, attendees: [{ address: "friend@example.com" }] }));
            const cancel = await receive(mailbox.uid, inbox.uid, requestFor(me, { method: "CANCEL", status: "CANCELLED" }), "cancel");
            const fine = await receive(mailbox.uid, inbox.uid, requestFor(me));

            for (const message of [own, cancel]) {
                const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });
                expect(result.status).toBe(400);
            }
            for (const responseStatus of ["needs-action", "maybe", undefined]) {
                const result = await owner(request(ctx.app()).post(inviteUrl(fine.uid, "/respond"))).send({ responseStatus });
                expect(result.status).toBe(400);
            }
            expect(ctx.transport().sent).toHaveLength(0);
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(0);
        });

        it("Lists the mailbox in the reply as the attendee the invitation named, an alias included.", async () => {
            const { mailbox, inbox } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor("someone-else@example.com"));

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            // The invitation isn't addressed to this mailbox at all: it is answered as the mailbox itself.
            expect(result.status).toBe(200);
            expect(ctx.transport().sent[0].envelopeFrom).toBe(mailbox.primarySmtpAddress);
        });

        it("Adds a published event on Accept, mailing no one.", async () => {
            const { mailbox, inbox } = await setup();
            const publish = ics({ method: "PUBLISH", uid: "publish@x", start, end, organizer: "boss@boss.example.com", attendees: [] });
            const message = await receive(mailbox.uid, inbox.uid, publish, "publish");

            const view = await owner(request(ctx.app()).get(inviteUrl(message.uid)));
            expect(view.body).toMatchObject({ canAdd: true, canRespond: false });
            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({ onCalendar: true, canAdd: false });
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(1);
            expect(ctx.transport().sent).toHaveLength(0);
        });

        it("Is refused for someone with no write access to the message, changing nothing.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));

            const result = await as(ctx.otherToken)(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            expect(result.status).toBe(403);
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(0);
            expect(ctx.transport().sent).toHaveLength(0);
        });

        it("Still answers when the REPLY can't be mailed.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));
            vi.spyOn(ctx.transport(), "send").mockRejectedValueOnce(new Error("relay down"));

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });

            expect(result.status).toBe(200);
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(1);
        });
    });

    describe("POST /invite/:messageUid/remove", () => {
        it("Takes a cancelled meeting off the calendar, mailing no one.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                icalUid: eventUid,
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [{ address: me, role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.ACCEPTED, isOrganizer: false }],
            });
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me, { method: "CANCEL", status: "CANCELLED" }), "cancel");
            expect((await owner(request(ctx.app()).get(inviteUrl(message.uid)))).body).toMatchObject({ canRemove: true, onCalendar: true, canRespond: false });

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/remove")));

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({ onCalendar: false, canRemove: false });
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(0);
            expect(ctx.transport().sent).toHaveLength(0);
        });

        it("Is a 400 for anything but a cancellation of a meeting on the calendar.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));
            const cancel = await receive(mailbox.uid, inbox.uid, requestFor(me, { method: "CANCEL", status: "CANCELLED" }), "cancel");

            expect((await owner(request(ctx.app()).post(inviteUrl(message.uid, "/remove")))).status).toBe(400);
            expect((await owner(request(ctx.app()).post(inviteUrl(cancel.uid, "/remove")))).status).toBe(400);
        });
    });

    describe("POST /invite/:messageUid/propose", () => {
        it("Mails the organizer a COUNTER with the proposed time and the comment, and leaves the calendar alone.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));
            const proposedStart = new Date(start.getTime() + 2 * HOUR);
            const proposedEnd = new Date(proposedStart.getTime() + HOUR);

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/propose"))).send({
                startDate: proposedStart.toISOString(),
                endDate: proposedEnd.toISOString(),
                comment: "Can we do it later?",
            });

            expect(result.status).toBe(200);
            const sent = ctx.transport().sent;
            expect(sent).toHaveLength(1);
            expect(sent[0].envelopeTo).toEqual(["boss@boss.example.com"]);
            const raw = decoded(sent[0].raw);
            expect(raw).toContain("METHOD:COUNTER");
            expect(raw).toContain(`DTSTART:${stamp(proposedStart)}`);
            expect(raw).toContain(`DTEND:${stamp(proposedEnd)}`);
            expect(raw).toContain(`UID:${eventUid}`);
            expect(raw).toContain("New Time Proposed: Video Test");
            expect(raw).toContain("Can we do it later?");
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(0);
        });

        it("Is a 400 for a bad time, and for a message that isn't an invitation to answer.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));
            const own = await receive(mailbox.uid, inbox.uid, requestFor(me, { organizer: me, attendees: [{ address: "friend@example.com" }] }));
            const good = { startDate: start.toISOString(), endDate: end.toISOString() };

            for (const body of [{}, { startDate: "soon", endDate: end.toISOString() }, { startDate: end.toISOString(), endDate: start.toISOString() }]) {
                expect((await owner(request(ctx.app()).post(inviteUrl(message.uid, "/propose"))).send(body)).status).toBe(400);
            }
            expect((await owner(request(ctx.app()).post(inviteUrl(own.uid, "/propose"))).send(good)).status).toBe(400);
            expect(ctx.transport().sent).toHaveLength(0);
        });
    });

    describe("POST /invite/:messageUid/accept-proposal", () => {
        const organized = async (data: any = {}) => {
            const context = await setup();
            const event = await ctx.createCalendarEvent(context.mailbox.uid, context.calendar.uid, {
                icalUid: eventUid,
                title: "Video Test",
                startDate: start,
                endDate: end,
                sequence: 1,
                inviteSequenceSent: 1,
                organizer: { address: context.me, type: RecipientType.TO },
                status: CalendarEventStatus.CONFIRMED,
                attendees: [
                    { address: "boss@boss.example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.TENTATIVE, isOrganizer: false },
                    { address: "other@example.com", role: AttendeeRole.REQUIRED, responseStatus: AttendeeResponseStatus.ACCEPTED, isOrganizer: false },
                ],
                ...data,
            });
            return { ...context, event };
        };
        const counter = (me: string, proposedStart: Date, proposedEnd: Date, from = "boss@boss.example.com") =>
            ics({ method: "COUNTER", uid: eventUid, start: proposedStart, end: proposedEnd, sequence: 1, organizer: me, attendees: [{ address: from, partstat: "TENTATIVE" }] });

        it("Moves the meeting to the proposed time, bumps its sequence so attendees are re-invited, and resets the others' answers.", async () => {
            const { mailbox, inbox, me, event } = await organized();
            const proposedStart = new Date(start.getTime() + 3 * HOUR);
            const proposedEnd = new Date(proposedStart.getTime() + HOUR);
            const message = await receive(mailbox.uid, inbox.uid, counter(me, proposedStart, proposedEnd), "counter");

            const view = await owner(request(ctx.app()).get(inviteUrl(message.uid)));
            expect(view.body).toMatchObject({ method: "COUNTER", canAcceptProposal: true, isOrganizer: true, canRespond: false });
            expect(view.body.reply).toMatchObject({ address: "boss@boss.example.com" });

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/accept-proposal")));

            expect(result.status).toBe(200);
            const [row] = await ctx.findEvents(mailbox.uid);
            expect(row.uid).toBe(event.uid);
            expect(new Date(row.startDate).getTime()).toBe(Math.floor(proposedStart.getTime() / 1000) * 1000);
            expect(new Date(row.endDate).getTime()).toBe(Math.floor(proposedEnd.getTime() / 1000) * 1000);
            expect(row.sequence).toBe(2);
            expect(row.inviteSequenceSent).toBe(1);
            expect(row.attendees.find((a: any) => a.address === "boss@boss.example.com").responseStatus).toBe("accepted");
            expect(row.attendees.find((a: any) => a.address === "other@example.com").responseStatus).toBe("needsAction");
            expect((await ctx.findMessage(message.uid)).meetingResponse).toBe("accepted");
        });

        it("Sends a sealed meeting's updated invitations from the content the organizer's client sends, and moves nothing without it.", async () => {
            const { mailbox, inbox, me, event } = await organized({ title: "Protected event", sealedFields: { title: "c2VhbGVk" } });
            const proposedStart = new Date(start.getTime() + 3 * HOUR);
            const message = await receive(mailbox.uid, inbox.uid, counter(me, proposedStart, new Date(proposedStart.getTime() + HOUR)), "counter");
            ctx.transport().sent = [];

            const refused = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/accept-proposal")));
            expect(refused.status).toBe(400);
            expect(refused.body.message ?? refused.text).toContain("invitationContent");
            expect((await ctx.findEvents(mailbox.uid))[0]).toMatchObject({ uid: event.uid, sequence: 1 });
            expect(ctx.transport().sent).toHaveLength(0);

            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/accept-proposal"))).send({ invitationContent: { title: "CANARY review", location: "Room 4" } });
            expect(result.status, JSON.stringify(result.body)).toBe(200);
            const [row] = await ctx.findEvents(mailbox.uid);
            expect(row.sequence).toBe(2);
            // Sent here, so stamped: the scheduling job never composes it from the placeholders.
            expect(row.inviteSequenceSent).toBe(2);
            expect(row.title).toBe("Protected event");
            expect(JSON.stringify(row)).not.toContain("CANARY");
            expect(ctx.transport().sent.map((sent: any) => sent.envelopeTo).flat().sort()).toEqual(["boss@boss.example.com", "other@example.com"]);
            expect(decoded(ctx.transport().sent[0].raw)).toContain("SUMMARY:CANARY review");
        });

        it("Moves a keyed meeting only with the guests' link keys, and one its organizer sends encrypted without any.", async () => {
            const { mailbox, inbox, me, event } = await organized({ videoMeetingUid: "vm-1" });
            await ctx.createAttendeeLink({ mailboxUid: mailbox.uid, calendarEventUid: event.uid, attendeeAddress: "other@example.com", url: "https://meet.example/j/x", keyed: true });
            const proposedStart = new Date(start.getTime() + 3 * HOUR);
            const message = await receive(mailbox.uid, inbox.uid, counter(me, proposedStart, new Date(proposedStart.getTime() + HOUR)), "counter");

            expect((await owner(request(ctx.app()).post(inviteUrl(message.uid, "/accept-proposal"))).send({ invitationContent: { title: "Video Test" } })).status).toBe(400);
            expect((await ctx.findEvents(mailbox.uid))[0].sequence).toBe(1);

            const KEY = "k=" + "Zx9_-".repeat(9);
            const result = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/accept-proposal"))).send({
                invitationContent: { title: "Video Test", meetingLinkSecrets: { "other@example.com": KEY } },
            });
            expect(result.status, JSON.stringify(result.body)).toBe(200);
            const [row] = await ctx.findEvents(mailbox.uid);
            expect(row.sequence).toBe(2);
            expect(row.inviteSequenceSent).toBe(2);
            expect(JSON.stringify(row)).not.toContain(KEY);

            const encrypted = await organized({ title: "Protected event", sealedFields: { title: "c2VhbGVk" }, encryptionOrigin: "originated" });
            const proposal = await receive(encrypted.mailbox.uid, encrypted.inbox.uid, counter(encrypted.me, proposedStart, new Date(proposedStart.getTime() + HOUR)), "counter");
            expect((await owner(request(ctx.app()).post(inviteUrl(proposal.uid, "/accept-proposal")))).status).toBe(200);
            expect((await ctx.findEvents(encrypted.mailbox.uid))[0]).toMatchObject({ sequence: 2, inviteSequenceSent: 2 });
        });

        it("Refuses a proposal whose sender's DKIM signature wasn't verified, changing nothing.", async () => {
            const { mailbox, inbox, me, event } = await organized();
            const message = await receive(mailbox.uid, inbox.uid, counter(me, end, new Date(end.getTime() + HOUR)), "counter", { unverified: true });

            expect((await owner(request(ctx.app()).get(inviteUrl(message.uid)))).body).toMatchObject({ canAcceptProposal: true });
            expect((await owner(request(ctx.app()).post(inviteUrl(message.uid, "/accept-proposal")))).status).toBe(403);
            const [row] = await ctx.findEvents(mailbox.uid);
            expect(row.uid).toBe(event.uid);
            expect(row.sequence).toBe(1);
        });

        it("Refuses a proposal from someone the meeting doesn't list, and one for a meeting the reader doesn't organize.", async () => {
            const { mailbox, inbox, me, event } = await organized();
            const stranger = await receive(mailbox.uid, inbox.uid, counter(me, end, new Date(end.getTime() + HOUR), "stranger@evil.example.com"), "counter", {
                from: { address: "stranger@evil.example.com", type: RecipientType.TO },
            });
            const impostor = await receive(mailbox.uid, inbox.uid, counter(me, end, new Date(end.getTime() + HOUR)), "counter", {
                from: { address: "other@example.com", type: RecipientType.TO },
            });

            expect((await owner(request(ctx.app()).post(inviteUrl(stranger.uid, "/accept-proposal")))).status).toBe(400);
            // Sent by a listed attendee, but naming someone else as the proposer: nothing to accept.
            expect((await owner(request(ctx.app()).post(inviteUrl(impostor.uid, "/accept-proposal")))).status).toBe(400);
            const [row] = await ctx.findEvents(mailbox.uid);
            expect(row.uid).toBe(event.uid);
            expect(row.sequence).toBe(1);
        });
    });

    describe("the reader's schedule around an invitation", () => {
        const attendee = (address: string, responseStatus: AttendeeResponseStatus) => ({ address, role: AttendeeRole.REQUIRED, responseStatus, isOrganizer: false });

        afterEach(() => {
            // The spy of a test below that fails the calendar's reads would otherwise outlive it, emptying every later schedule.
            vi.restoreAllMocks();
        });

        it("Expands recurring events, honors moved occurrences, and leaves out cancelled events, declined ones and free time.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            const day = 24 * HOUR;
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                title: "Standup",
                startDate: new Date(start.getTime() - 3 * day),
                endDate: new Date(end.getTime() - 3 * day),
                recurrenceRule: { freq: "daily", interval: 1, exceptions: [] },
            });
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                title: "Gym",
                icalUid: "gym@x",
                startDate: new Date(start.getTime() - 2 * day),
                endDate: new Date(end.getTime() - 2 * day),
                recurrenceRule: { freq: "daily", interval: 1, exceptions: [] },
            });
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                title: "Gym (moved)",
                icalUid: "gym@x",
                recurrenceId: start,
                startDate: new Date(start.getTime() + 5 * HOUR),
                endDate: new Date(end.getTime() + 5 * HOUR),
            });
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, { title: "Cancelled", status: CalendarEventStatus.CANCELLED, startDate: start, endDate: end });
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                title: "Declined",
                startDate: start,
                endDate: end,
                attendees: [attendee(me, AttendeeResponseStatus.DECLINED)],
            });
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                title: "Unanswered",
                startDate: start,
                endDate: end,
                attendees: [attendee(me, AttendeeResponseStatus.NEEDS_ACTION)],
            });
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));

            const result = await owner(request(ctx.app()).get(inviteUrl(message.uid)));

            expect(result.status).toBe(200);
            expect(result.body.conflicts.map((entry: any) => entry.title).sort()).toEqual(["Standup", "Unanswered"]);
            expect(result.body.conflicts.find((entry: any) => entry.title === "Unanswered").tentative).toBe(true);
            expect(result.body.conflicts.find((entry: any) => entry.title === "Standup").tentative).toBe(false);
            const titles = result.body.schedule.map((entry: any) => entry.title);
            expect(titles).toContain("Gym (moved)");
            expect(titles).not.toContain("Cancelled");
            // The moved occurrence's original time is not phantom-generated by the series.
            expect(titles.filter((title: string) => title === "Gym")).toHaveLength(0);
            expect(result.body.schedule.find((entry: any) => entry.title === "Declined").busy).toBe(false);
        });

        it("Still describes the invitation when the calendar can't be read.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));
            const original = RepoUtils.prototype.find;
            vi.spyOn(RepoUtils.prototype, "find").mockImplementation(function (this: any, query: any, ...rest: any[]) {
                if (query?.startDate) {
                    return Promise.reject(new Error("database down"));
                }
                return (original as any).call(this, query, ...rest);
            });

            const result = await owner(request(ctx.app()).get(inviteUrl(message.uid)));

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({ method: "REQUEST", schedule: [], conflicts: [] });
        });

        it("Is a 404 when the message's mailbox no longer exists.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me), "request", { mailboxUid: uuid.v4() });

            expect((await owner(request(ctx.app()).get(inviteUrl(message.uid)))).status).toBe(404);
        });

        it("Has no schedule for an invitation that names no start time.", async () => {
            const { mailbox, inbox, me } = await setup();
            const timeless = requestFor(me)
                .split("\r\n")
                .filter((line) => !line.startsWith("DTSTART") && !line.startsWith("DTEND"))
                .join("\r\n");
            const message = await receive(mailbox.uid, inbox.uid, timeless);

            const result = await owner(request(ctx.app()).get(inviteUrl(message.uid)));

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({ schedule: [], conflicts: [] });
        });
    });

    describe("answering while something else writes at the same time", () => {
        const conflict = () => new ApiError("CONFLICT", 409, "version conflict");
        const isMessagePatch = (patch: any) => patch?.meetingResponse !== undefined;
        const isEventPatch = (patch: any) => patch?.attendees !== undefined;
        const attendee = (address: string, responseStatus: AttendeeResponseStatus) => ({ address, role: AttendeeRole.REQUIRED, responseStatus, isOrganizer: false });

        it("Retries an answer on the calendar copy that a concurrent write changed, and gives up on a persistent conflict.", async () => {
            const { mailbox, inbox, calendar, me } = await setup();
            await ctx.createCalendarEvent(mailbox.uid, calendar.uid, {
                uid: nameBasedUuid(`itip:${mailbox.uid}:${eventUid}:master`),
                icalUid: eventUid,
                organizer: { address: "boss@boss.example.com", type: RecipientType.TO },
                attendees: [attendee(me, AttendeeResponseStatus.NEEDS_ACTION)],
            });
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));
            const original = RepoUtils.prototype.update;
            let failures = 1;
            const spy = vi.spyOn(RepoUtils.prototype, "update").mockImplementation(function (this: any, patch: any, ...rest: any[]) {
                if (isEventPatch(patch) && failures-- > 0) {
                    return Promise.reject(conflict());
                }
                return (original as any).call(this, patch, ...rest);
            });

            const once = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });
            expect(once.status).toBe(200);
            expect((await ctx.findEvents(mailbox.uid))[0].attendees[0].responseStatus).toBe("accepted");

            failures = 100;
            const always = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "tentative" });
            spy.mockRestore();
            expect(always.status).toBe(409);
        });

        it("Retries filing the calendar copy when inbound processing filed its own between the lookup and the write, and gives up on a persistent failure.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));
            const original = RepoUtils.prototype.create;
            let failures = 1;
            let status = 409;
            const spy = vi.spyOn(RepoUtils.prototype, "create").mockImplementation(function (this: any, entity: any, ...rest: any[]) {
                if (entity?.icalUid === eventUid && failures-- > 0) {
                    return Promise.reject(new ApiError("CONFLICT", status, "duplicate"));
                }
                return (original as any).call(this, entity, ...rest);
            });

            const once = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });
            expect(once.status).toBe(200);
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(1);

            await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "declined" });
            expect(await ctx.findEvents(mailbox.uid)).toHaveLength(0);
            failures = 100;
            const always = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });
            expect(always.status).toBe(409);
            failures = 100;
            status = 500;
            const broken = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });
            spy.mockRestore();
            expect(broken.status).toBe(500);
        });

        it("Retries recording the answer on the message once, and only logs when it can't be recorded.", async () => {
            const { mailbox, inbox, me } = await setup();
            const message = await receive(mailbox.uid, inbox.uid, requestFor(me));
            const original = RepoUtils.prototype.update;
            let failures = 1;
            const spy = vi.spyOn(RepoUtils.prototype, "update").mockImplementation(function (this: any, patch: any, ...rest: any[]) {
                if (isMessagePatch(patch) && failures-- > 0) {
                    return Promise.reject(conflict());
                }
                return (original as any).call(this, patch, ...rest);
            });

            expect((await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "tentative" })).status).toBe(200);
            expect((await ctx.findMessage(message.uid)).meetingResponse).toBe("tentative");

            failures = 100;
            const noisy = await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "accepted" });
            expect(noisy.status).toBe(200);
            expect((await ctx.findMessage(message.uid)).meetingResponse).toBe("tentative");

            // The message is gone by the time of the retry: nothing to record, and no failure.
            failures = 1;
            const originalFindOne = RepoUtils.prototype.findOne;
            const findSpy = vi.spyOn(RepoUtils.prototype, "findOne").mockImplementation(function (this: any, id: any, ...rest: any[]) {
                return id === message.uid && failures <= 0 ? Promise.resolve(undefined) : (originalFindOne as any).call(this, id, ...rest);
            });
            expect((await owner(request(ctx.app()).post(inviteUrl(message.uid, "/respond"))).send({ responseStatus: "declined" })).status).toBe(200);
            findSpy.mockRestore();
            spy.mockRestore();
        });
    });
}
