///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What `ScanQueueJob` does with the event dialog's fields in inbound iTIP mail, identical on both backends:
// - a REQUEST files the description (sanitized), visibility and guest permissions on the attendee's copy, and only the attendee on a
//   hidden guest list;
// - a COUNTER carrying X-RAPIDMX-CHANGE-REQUEST from a guest of an event this mailbox organizes is applied when the organizer's own row's
//   guest permissions allow it (and is otherwise the proposal it always was).
// `ScanQueueJob{Mongo,SQL}.test.ts` call this from inside their own `describe`, after their `beforeAll` has built the job and their
// `beforeEach` has emptied the tables and created the mailbox `recipient@example.com`.
import * as uuid from "uuid";
import { ApiError } from "@rapidrest/core";
import { buildEventIcs } from "../../src/util/IcsUtils.js";
import { MAX_EVENT_ATTENDEES, MAX_REQUESTED_GUESTS } from "../../src/util/CalendarEventUtils.js";
import {
    AttendeeResponseStatus,
    AttendeeRole,
    BusyStatus,
    CalendarEvent,
    CalendarEventStatus,
    RecipientType,
} from "../../src/models/types.js";

export interface EventDialogItipContext {
    job: () => any;
    /** Creates the test mailbox, `recipient@example.com`. */
    createMailbox: () => Promise<void>;
    /** Puts `raw` in the blob store, queues an ingest entry for the test mailbox and runs the job. */
    deliver: (raw: Buffer, envelopeFrom: string) => Promise<void>;
    /** Saves a `CalendarEvent` row of the test mailbox (a folder uid of "calendar-folder"); `data` overrides the defaults. */
    saveEvent: (data: any) => Promise<any>;
    events: (icalUid: string) => Promise<any[]>;
    event: (uid: string) => Promise<any>;
    /** Every message delivered to the test mailbox. */
    messages: () => Promise<any[]>;
}

const ME = "recipient@example.com";
const BOSS = "organizer@example.com";
const GUEST = "guest@example.com";
const PEER = "peer@example.com";

const START = new Date("2027-03-01T10:00:00Z");
const END = new Date("2027-03-01T11:00:00Z");
const NEW_START = new Date("2027-03-02T14:00:00Z");
const NEW_END = new Date("2027-03-02T15:30:00Z");

const attendee = (address: string, responseStatus: AttendeeResponseStatus = AttendeeResponseStatus.NEEDS_ACTION, extra: any = {}): any => ({
    address,
    role: AttendeeRole.REQUIRED,
    responseStatus,
    isOrganizer: false,
    ...extra,
});

/** A `CalendarEvent`-shaped value, just enough for `buildEventIcs()`. */
const fixture = (overrides: Partial<CalendarEvent> = {}): CalendarEvent =>
    ({
        uid: "fixture-uid",
        version: 0,
        dateCreated: new Date(),
        dateModified: new Date(),
        deleted: false,
        folderUid: "organizer-folder",
        mailboxUid: "organizer-mailbox",
        title: "Team Sync",
        startDate: START,
        endDate: END,
        allDay: false,
        timezone: "UTC",
        organizer: { address: BOSS, displayName: "Organizer", type: RecipientType.TO },
        attendees: [attendee(ME)],
        status: CalendarEventStatus.CONFIRMED,
        busyStatus: BusyStatus.BUSY,
        icalUid: "fixture-ical-uid",
        sequence: 0,
        encryptionOrigin: "none",
        visibility: "default",
        guestsCanModify: false,
        guestsCanInviteOthers: true,
        guestsCanSeeGuestList: true,
        ...overrides,
    });

/** A raw message carrying `ics` as its `text/calendar` part, from `from` with a passing DKIM result unless `dkim` is `false`. */
function rawItip(ics: string, from: string, dkim: boolean = true): Buffer {
    return Buffer.from(
        [
            `From: ${from}`,
            `To: ${ME}`,
            ...(dkim ? [`Authentication-Results: mx.example.com; dkim=pass header.d=${from.split("@")[1]}`] : []),
            "Subject: Meeting",
            "MIME-Version: 1.0",
            'Content-Type: multipart/mixed; boundary="BOUNDARY"',
            "",
            "--BOUNDARY",
            "Content-Type: text/plain; charset=utf-8",
            "",
            "Meeting.",
            "",
            "--BOUNDARY",
            'Content-Type: text/calendar; method=REQUEST; name="invite.ics"',
            'Content-Disposition: attachment; filename="invite.ics"',
            "",
            ics,
            "",
            "--BOUNDARY--",
            "",
        ].join("\r\n"),
    );
}

export function eventDialogItipSuite(ctx: EventDialogItipContext): void {
    describe("The event dialog's fields in inbound iTIP mail", () => {
        beforeEach(async () => {
            await ctx.createMailbox();
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        /** The one row of `icalUid`. */
        const only = async (icalUid: string): Promise<any> => {
            const rows = await ctx.events(icalUid);
            expect(rows).toHaveLength(1);
            return rows[0];
        };

        describe("Inbound REQUEST: the event dialog's fields on the attendee's copy", () => {
            const deliverRequest = async (event: Partial<CalendarEvent>, icalUid: string = uuid.v4()): Promise<string> => {
                await ctx.deliver(rawItip(buildEventIcs(fixture({ icalUid, ...event }), "REQUEST"), BOSS), BOSS);
                return icalUid;
            };

            it("Files the description, visibility and guest permissions the organizer sent.", async () => {
                const icalUid = await deliverRequest({
                    description: "Agenda, part 1",
                    descriptionHtml: "<p>Agenda, <b>part 1</b></p>",
                    visibility: "confidential",
                    guestsCanModify: true,
                    guestsCanInviteOthers: false,
                    guestsCanSeeGuestList: false,
                });

                const row = await only(icalUid);
                expect(row.description).toBe("Agenda, part 1");
                expect(row.descriptionHtml).toBe("<p>Agenda, <b>part 1</b></p>");
                expect(row.visibility).toBe("confidential");
                expect(row.guestsCanModify).toBe(true);
                expect(row.guestsCanInviteOthers).toBe(false);
                expect(row.guestsCanSeeGuestList).toBe(false);
            });

            it("Files the defaults for an invitation that names none of them.", async () => {
                const row = await only(await deliverRequest({}));

                expect(row.description ?? undefined).toBeUndefined();
                expect(row.descriptionHtml ?? undefined).toBeUndefined();
                expect(row.visibility).toBe("default");
                expect(row.guestsCanModify).toBe(false);
                expect(row.guestsCanInviteOthers).toBe(true);
                expect(row.guestsCanSeeGuestList).toBe(true);
            });

            it("Never trusts the HTML of an inbound invitation.", async () => {
                const icalUid = uuid.v4();
                const ics = buildEventIcs(fixture({ icalUid, description: "Hi" }), "REQUEST").replace(
                    "SEQUENCE:0",
                    'X-ALT-DESC;FMTTYPE=text/html:<p onclick=\\"x()\\">Hi <a href=\\"javascript:alert(1)\\">there</a></p><script>alert(1)</script><img src=x onerror=alert(1)>\r\nSEQUENCE:0',
                );
                await ctx.deliver(rawItip(ics, BOSS), BOSS);

                const row = await only(icalUid);
                expect(row.description).toBe("Hi");
                expect(row.descriptionHtml).toBe("<p>Hi there</p>");
            });

            it("Files only this mailbox's own entry when the organizer hides the guest list, however many the invitation names.", async () => {
                const icalUid = await deliverRequest({ guestsCanSeeGuestList: false, attendees: [attendee(PEER), attendee(ME), attendee(GUEST)] });

                expect((await only(icalUid)).attendees.map((entry: any) => entry.address)).toEqual([ME]);
            });

            it("Leaves the attendees as sent when the list is hidden but none of them is this mailbox, and shows everyone when it is visible.", async () => {
                const hidden = await deliverRequest({ guestsCanSeeGuestList: false, attendees: [attendee(PEER), attendee(GUEST)] });
                const visible = await deliverRequest({ attendees: [attendee(PEER), attendee(ME), attendee(GUEST)] });

                expect((await only(hidden)).attendees.map((entry: any) => entry.address)).toEqual([PEER, GUEST]);
                expect((await only(visible)).attendees).toHaveLength(3);
            });

            it("Updates the fields of a copy that is already on the calendar from a newer invitation, and clears what it no longer carries.", async () => {
                const icalUid = await deliverRequest({ description: "First", descriptionHtml: "<p>First</p>", visibility: "private", guestsCanModify: true, guestsCanSeeGuestList: false });
                await ctx.deliver(rawItip(buildEventIcs(fixture({ icalUid, sequence: 1, description: "Second" }), "REQUEST"), BOSS), BOSS);

                const row = await only(icalUid);
                expect(row.sequence).toBe(1);
                expect(row.description).toBe("Second");
                expect(row.descriptionHtml ?? undefined).toBeUndefined();
                expect(row.visibility).toBe("default");
                expect(row.guestsCanModify).toBe(false);
                expect(row.guestsCanSeeGuestList).toBe(true);

                await ctx.deliver(rawItip(buildEventIcs(fixture({ icalUid, sequence: 2 }), "REQUEST"), BOSS), BOSS);
                const cleared = await only(icalUid);
                expect(cleared.description ?? undefined).toBeUndefined();
            });
        });

        describe("Inbound COUNTER carrying X-RAPIDMX-CHANGE-REQUEST: a guest's request to change an event this mailbox organizes", () => {
            /** The organizer's own row: this mailbox organizes it, `GUEST` and `PEER` answered. */
            const organized = async (data: any = {}): Promise<any> =>
                await ctx.saveEvent({
                    folderUid: "calendar-folder",
                    title: "Team Sync",
                    timezone: "UTC",
                    startDate: START,
                    endDate: END,
                    organizer: { address: ME, type: RecipientType.TO },
                    attendees: [attendee(GUEST, AttendeeResponseStatus.ACCEPTED), attendee(PEER, AttendeeResponseStatus.ACCEPTED)],
                    status: CalendarEventStatus.CONFIRMED,
                    busyStatus: BusyStatus.BUSY,
                    icalUid: uuid.v4(),
                    sequence: 2,
                    inviteSequenceSent: 2,
                    guestsCanModify: true,
                    guestsCanInviteOthers: true,
                    ...data,
                });

            /** Delivers the guest's request for `row`, as `POST /:id/request-change` mails it. */
            const requestChange = async (
                row: any,
                proposed: Partial<CalendarEvent> = {},
                options: { from?: string; dkim?: boolean; extra?: any[]; sequence?: number; changeRequest?: boolean; proposer?: string } = {},
            ): Promise<void> => {
                const from = options.from ?? GUEST;
                const proposer = attendee(options.proposer ?? from, AttendeeResponseStatus.TENTATIVE);
                const ics = buildEventIcs(
                    fixture({
                        icalUid: row.icalUid,
                        title: row.title,
                        startDate: row.startDate,
                        endDate: row.endDate,
                        organizer: { address: ME, type: RecipientType.TO },
                        sequence: options.sequence ?? row.sequence,
                        recurrenceId: row.recurrenceId,
                        ...proposed,
                    }),
                    "COUNTER",
                    { onlyAttendee: proposer, changeRequest: options.changeRequest ?? true, extraAttendees: options.extra ?? [] },
                );
                await ctx.deliver(rawItip(ics, from, options.dkim ?? true), from);
            };

            const counterMessage = async (): Promise<any> => (await ctx.messages()).find((message: any) => message.meetingMethod === "COUNTER");

            it("Applies a change of everything a request can change: the fields, the time, new guests and the sequence, and marks the message.", async () => {
                const row = await organized();

                await requestChange(row, { title: "Team Sync (moved)", location: "Cafe Roma", description: "New plan", descriptionHtml: "<p>New <b>plan</b></p>", startDate: NEW_START, endDate: NEW_END }, {
                    extra: [attendee("new@example.com", AttendeeResponseStatus.NEEDS_ACTION, { displayName: "New Guest" })],
                });

                const changed = await ctx.event(row.uid);
                expect(changed.title).toBe("Team Sync (moved)");
                expect(changed.location).toBe("Cafe Roma");
                expect(changed.description).toBe("New plan");
                expect(changed.descriptionHtml).toBe("<p>New <b>plan</b></p>");
                expect(new Date(changed.startDate).getTime()).toBe(NEW_START.getTime());
                expect(new Date(changed.endDate).getTime()).toBe(NEW_END.getTime());
                // Bumped, and not stamped as sent: `MeetingSchedulingJob` re-invites everyone.
                expect(changed.sequence).toBe(3);
                expect(changed.inviteSequenceSent).toBe(2);
                // The time changed: everyone but the requester goes back to needs-action, the requester is accepted, the new guest is added as required.
                expect(changed.attendees.map((entry: any) => [entry.address, entry.responseStatus])).toEqual([
                    [GUEST, AttendeeResponseStatus.ACCEPTED],
                    [PEER, AttendeeResponseStatus.NEEDS_ACTION],
                    ["new@example.com", AttendeeResponseStatus.NEEDS_ACTION],
                ]);
                expect(changed.attendees[2]).toMatchObject({ role: AttendeeRole.REQUIRED, isOrganizer: false, displayName: "New Guest" });
                // What the organizer's card shows.
                expect((await counterMessage()).meetingResponse).toBe("accepted");
            });

            it("Leaves everyone's answers alone when the time doesn't change.", async () => {
                const row = await organized();

                await requestChange(row, { title: "Renamed" });

                const changed = await ctx.event(row.uid);
                expect(changed.title).toBe("Renamed");
                expect(changed.sequence).toBe(3);
                expect(changed.attendees.map((entry: any) => entry.responseStatus)).toEqual([AttendeeResponseStatus.ACCEPTED, AttendeeResponseStatus.ACCEPTED]);
                expect(new Date(changed.startDate).getTime()).toBe(START.getTime());
            });

            it("Applies a request that only adds guests when guests may invite others, though they may not modify - and dedupes, skips bad addresses and the organizer, and caps a request.", async () => {
                const row = await organized({ guestsCanModify: false });
                const extra = [
                    attendee("a@example.com"),
                    attendee("A@Example.com"),
                    attendee(PEER),
                    attendee(ME),
                    attendee("not an address"),
                    ...Array.from({ length: MAX_REQUESTED_GUESTS + 10 }, (_, index) => attendee(`extra${index}@example.com`)),
                ];

                await requestChange(row, {}, { extra });

                const changed = await ctx.event(row.uid);
                const addresses = changed.attendees.map((entry: any) => entry.address);
                expect(addresses.slice(0, 2)).toEqual([GUEST, PEER]);
                expect(addresses).toHaveLength(2 + MAX_REQUESTED_GUESTS);
                expect(addresses.filter((address: string) => address.toLowerCase() === "a@example.com")).toHaveLength(1);
                expect(addresses).not.toContain("not an address");
                expect(addresses.filter((address: string) => address === ME)).toHaveLength(0);
                expect(changed.sequence).toBe(3);
                expect((await counterMessage()).meetingResponse).toBe("accepted");
            });

            it("Never takes an event past the attendee limit.", async () => {
                const crowd = Array.from({ length: MAX_EVENT_ATTENDEES - 2 }, (_, index) => attendee(`crowd${index}@example.com`));
                const row = await organized({ attendees: [attendee(GUEST, AttendeeResponseStatus.ACCEPTED), ...crowd] });

                await requestChange(row, {}, { extra: [attendee("x1@example.com"), attendee("x2@example.com"), attendee("x3@example.com")] });

                expect((await ctx.event(row.uid)).attendees).toHaveLength(MAX_EVENT_ATTENDEES);
            });

            it("Applies nothing, and marks nothing, when the organizer's own flags don't allow the change - a request with one disallowed change applies none of it.", async () => {
                const noModify = await organized({ guestsCanModify: false });
                const noInvite = await organized({ guestsCanInviteOthers: false });

                await requestChange(noModify, { title: "Sneaky" });
                await requestChange(noModify, { title: "Sneaky", startDate: NEW_START, endDate: NEW_END }, { extra: [attendee("a@example.com")] });
                await requestChange(noInvite, { title: "Renamed too" }, { extra: [attendee("b@example.com")] });
                await requestChange(noInvite, {}, { extra: [attendee("b@example.com")] });

                for (const row of [noModify, noInvite]) {
                    const same = await ctx.event(row.uid);
                    expect(same.title).toBe("Team Sync");
                    expect(same.sequence).toBe(2);
                    expect(same.attendees).toHaveLength(2);
                }
                expect((await ctx.messages()).every((message: any) => !message.meetingResponse)).toBe(true);
                // Still delivered: it is a message like any other, and the organizer can accept the proposed time by hand.
                expect((await ctx.messages()).filter((message: any) => message.meetingMethod === "COUNTER")).toHaveLength(4);
            });

            it("Decides by the organizer's own row, never by the flags the message carries.", async () => {
                const row = await organized({ guestsCanModify: false });

                await requestChange(row, { title: "Forged", guestsCanModify: true, guestsCanInviteOthers: true });

                expect((await ctx.event(row.uid)).title).toBe("Team Sync");
            });

            it("Leaves a COUNTER without the marker as the proposal it always was.", async () => {
                const row = await organized();

                await requestChange(row, { title: "Renamed", startDate: NEW_START, endDate: NEW_END }, { changeRequest: false });

                const same = await ctx.event(row.uid);
                expect(same.title).toBe("Team Sync");
                expect(same.sequence).toBe(2);
                expect((await counterMessage()).meetingResponse ?? undefined).toBeUndefined();
            });

            it("Ignores a request whose sender isn't DKIM-verified, isn't a listed guest, isn't the guest the message names, or is the organizer.", async () => {
                const row = await organized();

                await requestChange(row, { title: "Unverified" }, { dkim: false });
                await requestChange(row, { title: "Stranger" }, { from: "mallory@example.com" });
                await requestChange(row, { title: "Impostor" }, { from: PEER, proposer: GUEST });
                await requestChange(row, { title: "Self" }, { from: ME });

                const same = await ctx.event(row.uid);
                expect(same.title).toBe("Team Sync");
                expect(same.sequence).toBe(2);
            });

            it("Ignores a request for an event this mailbox doesn't organize, one it doesn't have, and one that is cancelled.", async () => {
                const notMine = await organized({ organizer: { address: BOSS, type: RecipientType.TO } });
                const cancelled = await organized({ status: CalendarEventStatus.CANCELLED });

                await requestChange(notMine, { title: "Not mine" });
                await requestChange(cancelled, { title: "Cancelled" });
                await requestChange({ ...notMine, icalUid: uuid.v4() }, { title: "Unknown" });

                expect((await ctx.event(notMine.uid)).title).toBe("Team Sync");
                expect((await ctx.event(cancelled.uid)).title).toBe("Team Sync");
            });

            it("Ignores a request that is stale - made of an older revision - and one that changes nothing; replaying an applied one applies nothing more.", async () => {
                const row = await organized();

                await requestChange(row, { title: "Old copy" }, { sequence: 1 });
                expect((await ctx.event(row.uid)).title).toBe("Team Sync");
                await requestChange(row, {});
                await requestChange(row, { title: "Team Sync", startDate: START, endDate: END });
                expect((await ctx.event(row.uid)).sequence).toBe(2);

                await requestChange(row, { title: "Once" });
                await requestChange(row, { title: "Once" });
                const changed = await ctx.event(row.uid);
                expect(changed.title).toBe("Once");
                expect(changed.sequence).toBe(3);
            });

            it("Ignores a time that ends before it starts but still applies the rest.", async () => {
                const row = await organized();

                await requestChange(row, { title: "Backwards", startDate: NEW_END, endDate: NEW_START });

                const changed = await ctx.event(row.uid);
                expect(changed.title).toBe("Backwards");
                expect(new Date(changed.startDate).getTime()).toBe(START.getTime());
                expect(changed.attendees.map((entry: any) => entry.responseStatus)).toEqual([AttendeeResponseStatus.ACCEPTED, AttendeeResponseStatus.ACCEPTED]);
            });

            it("Bounds a title and a location the request sets.", async () => {
                const row = await organized();

                await requestChange(row, { title: "T".repeat(3000), location: "L".repeat(3000) });

                const changed = await ctx.event(row.uid);
                expect(changed.title).toHaveLength(1000);
                expect(changed.location).toHaveLength(1000);
            });

            it("Changes the occurrence the request names: an override row, not the series.", async () => {
                const icalUid = uuid.v4();
                const master = await organized({ icalUid, recurrenceRule: { freq: "weekly", interval: 1, exceptions: [] } });
                const recurrenceId = new Date(START.getTime() + 7 * 24 * 60 * 60 * 1000);
                const override = await organized({ icalUid, recurrenceId, startDate: recurrenceId, endDate: new Date(recurrenceId.getTime() + 60 * 60 * 1000) });

                await requestChange(override, { title: "One occurrence" });

                expect((await ctx.event(override.uid)).title).toBe("One occurrence");
                expect((await ctx.event(master.uid)).title).toBe("Team Sync");
            });

            it("Retries a version conflict, and logs when it keeps conflicting or the message can't be marked.", async () => {
                const row = await organized();
                const job = ctx.job();
                const errorSpy = vi.spyOn(job.logger, "error");
                const calendarUpdate = vi.spyOn(job.calendarEventRepo, "update");
                const conflict = (): ApiError => new ApiError("CONFLICT", 409, "version");

                calendarUpdate.mockRejectedValueOnce(conflict());
                await requestChange(row, { title: "Second try" });
                expect((await ctx.event(row.uid)).title).toBe("Second try");
                expect((await counterMessage()).meetingResponse).toBe("accepted");

                calendarUpdate.mockRejectedValue(conflict());
                await requestChange(await ctx.event(row.uid), { title: "Never" });
                calendarUpdate.mockRestore();
                expect((await ctx.event(row.uid)).title).toBe("Second try");
                expect(errorSpy.mock.calls.some((call: any[]) => String(call[0]).includes("failed to process iTIP COUNTER"))).toBe(true);
            });

            it("Retries marking the message once, gives up after three conflicts (the change stands), and is fine when the message is gone.", async () => {
                const job = ctx.job();
                const errorSpy = vi.spyOn(job.logger, "error");
                const messageUpdate = vi.spyOn(job.messageRepo, "update");
                const conflict = (): ApiError => new ApiError("CONFLICT", 409, "version");

                const first = await organized();
                messageUpdate.mockRejectedValueOnce(conflict());
                await requestChange(first, { title: "Marked late" });
                expect((await ctx.event(first.uid)).title).toBe("Marked late");
                expect((await counterMessage()).meetingResponse).toBe("accepted");

                const second = await organized();
                messageUpdate.mockRejectedValue(conflict());
                await requestChange(second, { title: "Never marked" });
                messageUpdate.mockRestore();
                expect((await ctx.event(second.uid)).title).toBe("Never marked");
                expect(errorSpy.mock.calls.some((call: any[]) => String(call[0]).includes("failed to process iTIP COUNTER"))).toBe(true);

                const third = await organized();
                const findOne = job.messageRepo.findOne.bind(job.messageRepo);
                const findSpy = vi.spyOn(job.messageRepo, "findOne").mockImplementation(async (id: any, ...rest: any[]) => {
                    const found = await findOne(id, ...rest);
                    return found?.meetingMethod === "COUNTER" ? undefined : found;
                });
                await requestChange(third, { title: "Message vanished" });
                findSpy.mockRestore();
                expect((await ctx.event(third.uid)).title).toBe("Message vanished");
            });
        });
    });
}
