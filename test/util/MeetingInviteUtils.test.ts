///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { AttendeeResponseStatus } from "../../src/models/types.js";
import {
    conflictsOf,
    describeInvite,
    extractIcsFromRaw,
    inviteIsAllDay,
    inviteResponseOf,
    mailboxAddressSet,
    meetingMethodOf,
    messageMayCarryInvite,
    parseInviteIcs,
    participantStatusOf,
    sameRecurrenceId,
    type InviteScheduleEntry,
} from "../../src/util/MeetingInviteUtils.js";

const ICS = (extra: string[] = [], method: string | null = "REQUEST"): string =>
    [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        ...(method ? [`METHOD:${method}`] : []),
        "BEGIN:VEVENT",
        "UID:abc@x",
        "DTSTART:20260930T200000Z",
        "DTEND:20260930T210000Z",
        "SUMMARY:Sync",
        "SEQUENCE:1",
        "ORGANIZER:mailto:boss@x.com",
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@x.com",
        ...extra,
        "END:VEVENT",
        "END:VCALENDAR",
    ].join("\r\n");

const entry = (overrides: Partial<InviteScheduleEntry>): InviteScheduleEntry => ({
    uid: "e1",
    title: "Other",
    startDate: "2026-09-30T20:30:00.000Z",
    endDate: "2026-09-30T21:30:00.000Z",
    allDay: false,
    busy: true,
    tentative: false,
    ...overrides,
});

describe("MeetingInviteUtils", () => {
    it("maps attendee statuses to what a reader answered, and to a participant's status", () => {
        expect(inviteResponseOf(AttendeeResponseStatus.ACCEPTED)).toBe("accepted");
        expect(inviteResponseOf(AttendeeResponseStatus.TENTATIVE)).toBe("tentative");
        expect(inviteResponseOf(AttendeeResponseStatus.DECLINED)).toBe("declined");
        expect(inviteResponseOf(AttendeeResponseStatus.NEEDS_ACTION)).toBeUndefined();
        expect(inviteResponseOf(undefined)).toBeUndefined();
        expect(participantStatusOf(AttendeeResponseStatus.NEEDS_ACTION)).toBe("needs-action");
        expect(participantStatusOf(AttendeeResponseStatus.ACCEPTED)).toBe("accepted");
        expect(participantStatusOf(undefined)).toBeUndefined();
    });

    it("finds the calendar file in a raw message, by content type or file name, and nothing in one without or that can't be read", async () => {
        const byType = await new MailComposer({ from: "a@x.com", to: "b@x.com", text: "hi", icalEvent: { method: "request", content: ICS() } }).compile().build();
        expect(await extractIcsFromRaw(byType)).toContain("UID:abc@x");
        const byName = await new MailComposer({
            from: "a@x.com",
            to: "b@x.com",
            text: "hi",
            attachments: [{ filename: "Invite.ICS", content: ICS(), contentType: "application/octet-stream" }],
        })
            .compile()
            .build();
        expect(await extractIcsFromRaw(byName)).toContain("UID:abc@x");
        const none = await new MailComposer({ from: "a@x.com", to: "b@x.com", text: "hi" }).compile().build();
        expect(await extractIcsFromRaw(none)).toBeUndefined();
        expect(await extractIcsFromRaw(undefined as any)).toBeUndefined();
    });

    it("reads a file naming no METHOD as a PUBLISH, and leaves a METHOD it can't parse alone", () => {
        expect(parseInviteIcs(ICS([], null))?.method).toBe("PUBLISH");
        expect(parseInviteIcs(ICS())?.method).toBe("REQUEST");
        expect(parseInviteIcs("BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR")).toBeUndefined();
        expect(parseInviteIcs("not a calendar")).toBeUndefined();
        expect(meetingMethodOf(ICS([], "counter"))).toBe("COUNTER");
        expect(meetingMethodOf(ICS([], null))).toBe("PUBLISH");
        expect(meetingMethodOf(undefined)).toBeUndefined();
        expect(meetingMethodOf("junk")).toBeUndefined();
    });

    it("answers whether a message can carry a readable invitation, and whether one is all-day", () => {
        expect(messageMayCarryInvite({ encrypted: false })).toBe(true);
        expect(messageMayCarryInvite({ encrypted: true })).toBe(false);
        const day = 24 * 60 * 60 * 1000;
        expect(inviteIsAllDay({ startDate: new Date(0), endDate: new Date(day) })).toBe(true);
        expect(inviteIsAllDay({ startDate: new Date(0), endDate: new Date(day), timezone: "UTC" })).toBe(false);
        expect(inviteIsAllDay({ startDate: new Date(0), endDate: new Date(0) })).toBe(false);
        expect(inviteIsAllDay({ startDate: new Date(1), endDate: new Date(day) })).toBe(false);
        expect(inviteIsAllDay({ endDate: new Date(day) })).toBe(false);
    });

    it("compares recurrence ids, and collects a mailbox's addresses normalized", () => {
        expect(sameRecurrenceId(undefined, undefined)).toBe(true);
        expect(sameRecurrenceId(new Date(5), undefined)).toBe(false);
        expect(sameRecurrenceId(undefined, new Date(5))).toBe(false);
        expect(sameRecurrenceId(new Date(5), new Date(5))).toBe(true);
        expect(sameRecurrenceId(new Date(5), new Date(6))).toBe(false);
        expect([...mailboxAddressSet({ primarySmtpAddress: "Me@X.com", aliasAddresses: ["Alias@x.com"] })].sort()).toEqual(["alias@x.com", "me@x.com"]);
        expect(mailboxAddressSet({ primarySmtpAddress: "me@x.com" }).size).toBe(1);
        expect(mailboxAddressSet(undefined).size).toBe(0);
    });

    it("lists the busy entries overlapping a time as conflicts", () => {
        const start = new Date("2026-09-30T20:00:00Z");
        const end = new Date("2026-09-30T21:00:00Z");
        const schedule = [
            entry({ uid: "clash" }),
            entry({ uid: "free", busy: false }),
            entry({ uid: "before", startDate: "2026-09-30T18:00:00.000Z", endDate: "2026-09-30T20:00:00.000Z" }),
            entry({ uid: "after", startDate: "2026-09-30T21:00:00.000Z", endDate: "2026-09-30T22:00:00.000Z" }),
        ];
        expect(conflictsOf(schedule, start, end).map((e) => e.uid)).toEqual(["clash"]);
        expect(conflictsOf(schedule, start, undefined)).toEqual([]);
        expect(conflictsOf(schedule, undefined, end)).toEqual([]);
    });

    describe("describeInvite()", () => {
        const me = new Set(["me@x.com"]);
        const existing: any = { uid: "cal-1", sequence: 3, attendees: [{ address: "ME@x.com", responseStatus: AttendeeResponseStatus.TENTATIVE }] };

        it("reports a request the reader can answer, with the answer their calendar copy holds", () => {
            const view = describeInvite(parseInviteIcs(ICS())!, me, existing, { from: { address: "boss@x.com" } } as any, [entry({})]);
            expect(view).toMatchObject({
                method: "REQUEST",
                canRespond: true,
                canPropose: true,
                canAdd: false,
                canRemove: false,
                onCalendar: true,
                calendarEventUid: "cal-1",
                response: "tentative",
                outdated: true,
                recurring: false,
                isOrganizer: false,
            });
            expect(view.conflicts).toHaveLength(1);
            expect(view.schedule).toHaveLength(1);
            expect(view.attendees[0]).toMatchObject({ address: "me@x.com", responseStatus: "tentative" });
        });

        it("prefers what the message records over the calendar copy, and offers no answer to the reader's own meeting or a cancellation", () => {
            const parsed = parseInviteIcs(ICS())!;
            expect(describeInvite(parsed, me, existing, { meetingResponse: "declined" } as any).response).toBe("declined");
            expect(describeInvite(parsed, new Set(["boss@x.com"]), undefined, {} as any)).toMatchObject({ isOrganizer: true, canRespond: false, canPropose: false });
            expect(describeInvite(parseInviteIcs(ICS(["STATUS:CANCELLED"]))!, me, undefined, {} as any)).toMatchObject({ canRespond: false, canPropose: false });
            expect(describeInvite(parseInviteIcs(ICS(["RRULE:FREQ=DAILY"]))!, me, undefined, {} as any).recurring).toBe(true);
        });

        it("offers Add for a published event not yet on the calendar, and Remove for a cancellation that is", () => {
            const publish = parseInviteIcs(ICS([], "PUBLISH"))!;
            expect(describeInvite(publish, me, undefined, {} as any)).toMatchObject({ canAdd: true, canRespond: false });
            expect(describeInvite(publish, me, existing, {} as any).canAdd).toBe(false);
            const cancel = parseInviteIcs(ICS([], "CANCEL"))!;
            expect(describeInvite(cancel, me, existing, {} as any)).toMatchObject({ canRemove: true, canRespond: false });
            expect(describeInvite(cancel, me, undefined, {} as any).canRemove).toBe(false);
        });

        it("reads who a reply is from, and lets the organizer accept a counter only from a listed attendee", () => {
            const replyOf = (status: string, method = "REPLY") =>
                parseInviteIcs(ICS([], method).replace("mailto:me@x.com", "mailto:guest@x.com").replace("NEEDS-ACTION", status))!;
            const reply = describeInvite(replyOf("TENTATIVE"), new Set(["boss@x.com"]), undefined, {} as any);
            expect(reply.reply).toMatchObject({ address: "guest@x.com", responseStatus: "tentative" });
            expect(reply).toMatchObject({ canRespond: false, canAcceptProposal: false });

            const organized: any = { uid: "cal-2", sequence: 1, attendees: [{ address: "guest@x.com", responseStatus: AttendeeResponseStatus.TENTATIVE }] };
            const counter = replyOf("TENTATIVE", "COUNTER");
            const boss = new Set(["boss@x.com"]);
            expect(describeInvite(counter, boss, organized, { from: { address: "Guest@x.com" } } as any).canAcceptProposal).toBe(true);
            expect(describeInvite(counter, boss, organized, { from: { address: "stranger@x.com" } } as any).canAcceptProposal).toBe(false);
            expect(describeInvite(counter, boss, undefined, { from: { address: "guest@x.com" } } as any).canAcceptProposal).toBe(false);
            expect(describeInvite(counter, boss, organized, {} as any).canAcceptProposal).toBe(false);
            expect(describeInvite(counter, new Set(["someone@x.com"]), organized, { from: { address: "guest@x.com" } } as any).canAcceptProposal).toBe(false);
        });
    });
});
