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
import type { InMemoryBlobStore, RecordingMailTransport } from "../testDoubles.js";

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
}

/** A sent message as text, with quoted-printable soft line breaks and escapes undone, so the calendar file inside reads as written. */
const decoded = (raw: Buffer): string => raw.toString().replace(/=\r?\n/g, "").replace(/=3D/g, "=");

const ics = (o: IcsOptions): string =>
    [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Someone Else//Mail//EN",
        ...(o.method ? [`METHOD:${o.method}`] : []),
        "BEGIN:VEVENT",
        `UID:${o.uid}`,
        `DTSTAMP:${stamp(new Date())}`,
        `DTSTART:${stamp(o.start)}`,
        `DTEND:${stamp(o.end)}`,
        "SUMMARY:Video Test",
        `SEQUENCE:${o.sequence ?? 0}`,
        ...(o.status ? [`STATUS:${o.status}`] : []),
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
        const composer = new MailComposer({
            from: "boss@boss.example.com",
            to: "me@example.com",
            subject: "Invitation: Video Test",
            text: "You have been invited to: Video Test",
            ...(content ? { icalEvent: { method, content } } : {}),
        });
        const raw: Buffer = await composer.compile().build();
        const bodyBlobKey = `bodies/${uuid.v4()}`;
        await ctx.blobStore().put(bodyBlobKey, raw);
        return await ctx.createMessage(mailboxUid, folderUid, {
            bodyBlobKey,
            from: { address: "boss@boss.example.com", type: RecipientType.TO },
            hasAttachments: !!content,
            ...data,
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
        const organized = async () => {
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
