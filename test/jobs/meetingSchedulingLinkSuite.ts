///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What `MeetingSchedulingJob` does with `CalendarEvent.videoMeetingUid` and the generic, plugin-agnostic
// `CalendarEventAttendeeLink` rows a plugin writes for it - identical on both backends.
// `MeetingSchedulingJob{Mongo,SQL}.test.ts` call this from inside their own `describe`, after their `beforeAll`
// has built the job and their `beforeEach` has emptied the event table and the recording transport.
//
// The property this suite exists to protect, beyond the personalization itself: an event with no linked video
// meeting (the overwhelmingly common case) must still take the exact same compose-once/fan-out-by-envelope path
// it always has, issuing no extra query of any kind - asserted directly, by spying on the job's own
// attendee-link repository and proving it was never consulted.
import { AttendeeResponseStatus, AttendeeRole, CalendarEventStatus } from "../../src/models/types.js";
import type { RecordingMailTransport } from "../testDoubles.js";

/** One `CalendarEventAttendeeLink` row, as a plugin would write it. */
export interface AttendeeLinkSeed {
    mailboxUid: string;
    calendarEventUid: string;
    attendeeAddress: string;
    url: string;
    label?: string;
}

export interface MeetingSchedulingLinkSuiteContext {
    job: () => any;
    transport: () => RecordingMailTransport;
    /** The mailbox that owns `organizer@example.com` - the organizer of every event this suite creates. */
    mailboxUid: () => string;
    createEvent: (data?: any) => Promise<any>;
    createLink: (link: AttendeeLinkSeed) => Promise<void>;
    /** Empties the attendee-link table, as this suite's own `beforeEach` needs between cases. */
    clearLinks: () => Promise<void>;
    reload: (uid: string) => Promise<any>;
}

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const ALICE_URL = "https://v.example/a";
const BOB_URL = "https://v.example/b";

const attendee = (address: string): any => ({
    address,
    role: AttendeeRole.REQUIRED,
    responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
    isOrganizer: false,
});

export function meetingSchedulingLinkSuite(ctx: MeetingSchedulingLinkSuiteContext): void {
    describe("Per-attendee personalized invite links (CalendarEvent.videoMeetingUid)", () => {
        /** The raw MIME of the one message sent to `address`. */
        const rawTo = (address: string): string => {
            const message = ctx.transport().sent.find((sent) => sent.envelopeTo.includes(address));
            expect(message).toBeDefined();
            return message!.raw.toString();
        };
        /** Spies on the job's own attendee-link repository, so a test can prove it was (or was not) consulted. */
        const linkFindSpy = () => vi.spyOn(ctx.job().attendeeLinkRepo, "find");

        beforeEach(async () => {
            await ctx.clearLinks();
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("Sends an event with no videoMeetingUid exactly as before: one shared message per attendee envelope, carrying the event's own stored location, and never even queries for attendee links.", async () => {
            const spy = linkFindSpy();
            const event = await ctx.createEvent({ location: "Room 101", attendees: [attendee(ALICE), attendee(BOB)] });

            await ctx.job().run();

            expect(spy).not.toHaveBeenCalled();
            expect(ctx.transport().sent.map((sent) => sent.envelopeTo).sort()).toEqual([[ALICE], [BOB]]);
            expect(rawTo(ALICE)).toContain("LOCATION:Room 101");
            expect(rawTo(BOB)).toContain("LOCATION:Room 101");
            expect(rawTo(ALICE)).not.toContain("Join the video call");
            expect((await ctx.reload(event.uid)).inviteSequenceSent).toBe(0);
        });

        it("Gives each attendee of an event with a linked video meeting their own url as LOCATION and names it in the body - genuinely different bytes per attendee, not one message sent twice.", async () => {
            const event = await ctx.createEvent({
                location: "Room 101",
                videoMeetingUid: "meeting-1",
                attendees: [attendee(ALICE), attendee(BOB)],
            });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: ALICE, url: ALICE_URL, label: "Join video call" });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: BOB, url: BOB_URL });

            await ctx.job().run();

            expect(ctx.transport().sent.map((sent) => sent.envelopeTo).sort()).toEqual([[ALICE], [BOB]]);
            const alice: string = rawTo(ALICE);
            const bob: string = rawTo(BOB);
            expect(alice).toContain(`LOCATION:${ALICE_URL}`);
            expect(alice).toContain(`Join the video call: ${ALICE_URL}`);
            expect(alice).not.toContain(BOB_URL);
            expect(alice).not.toContain("LOCATION:Room 101");
            expect(bob).toContain(`LOCATION:${BOB_URL}`);
            expect(bob).toContain(`Join the video call: ${BOB_URL}`);
            expect(bob).not.toContain(ALICE_URL);
            expect(alice).not.toBe(bob);
            // Both copies still carry the whole attendee list and the same organizer identity.
            expect(alice).toContain("METHOD:REQUEST");
            expect(alice).toContain(`mailto:${BOB}`);
            expect((await ctx.reload(event.uid)).inviteSequenceSent).toBe(0);
        });

        it("Matches an attendee's link case-insensitively, however the plugin stored the address.", async () => {
            const event = await ctx.createEvent({ videoMeetingUid: "meeting-1", attendees: [{ ...attendee("Alice@Example.com") }] });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: " ALICE@EXAMPLE.COM ", url: ALICE_URL });

            await ctx.job().run();

            expect(ctx.transport().sent).toHaveLength(1);
            expect(rawTo("Alice@Example.com")).toContain(`LOCATION:${ALICE_URL}`);
        });

        it("Falls back to the event's plain stored location for everyone when the linked meeting has no rows at all (deleted meeting, uninstalled plugin), still sending successfully.", async () => {
            const event = await ctx.createEvent({
                location: "Room 101",
                videoMeetingUid: "meeting-gone",
                attendees: [attendee(ALICE), attendee(BOB)],
            });

            await expect(ctx.job().run()).resolves.toBeUndefined();

            expect(ctx.transport().sent.map((sent) => sent.envelopeTo).sort()).toEqual([[ALICE], [BOB]]);
            expect(rawTo(ALICE)).toContain("LOCATION:Room 101");
            expect(rawTo(BOB)).toContain("LOCATION:Room 101");
            expect(rawTo(BOB)).not.toContain("Join the video call");
            expect((await ctx.reload(event.uid)).inviteSequenceSent).toBe(0);
        });

        it("Personalizes only the attendees that have a row, falling back individually for the rest.", async () => {
            const event = await ctx.createEvent({
                location: "Room 101",
                videoMeetingUid: "meeting-1",
                attendees: [attendee(ALICE), attendee(BOB)],
            });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: ALICE, url: ALICE_URL });

            await ctx.job().run();

            expect(ctx.transport().sent.map((sent) => sent.envelopeTo).sort()).toEqual([[ALICE], [BOB]]);
            expect(rawTo(ALICE)).toContain(`LOCATION:${ALICE_URL}`);
            expect(rawTo(BOB)).toContain("LOCATION:Room 101");
            expect(rawTo(BOB)).not.toContain("Join the video call");
        });

        it("Never matches a row belonging to another event, even one in the same mailbox.", async () => {
            const other = await ctx.createEvent({ videoMeetingUid: "meeting-other", attendees: [attendee(BOB)] });
            const event = await ctx.createEvent({ location: "Room 101", videoMeetingUid: "meeting-1", attendees: [attendee(ALICE)] });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: other.uid, attendeeAddress: ALICE, url: ALICE_URL });

            await ctx.job().run();

            expect(rawTo(ALICE)).toContain("LOCATION:Room 101");
            expect(rawTo(ALICE)).not.toContain(ALICE_URL);
            expect((await ctx.reload(event.uid)).inviteSequenceSent).toBe(0);
        });

        it("Logs a warning and still sends with the plain stored location for everyone when the attendee-link lookup itself throws.", async () => {
            const warnSpy = vi.spyOn(ctx.job().logger, "warn");
            vi.spyOn(ctx.job().attendeeLinkRepo, "find").mockRejectedValueOnce(new Error("simulated database failure"));
            const event = await ctx.createEvent({
                location: "Room 101",
                videoMeetingUid: "meeting-1",
                attendees: [attendee(ALICE), attendee(BOB)],
            });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: ALICE, url: ALICE_URL });

            await expect(ctx.job().run()).resolves.toBeUndefined();

            expect(ctx.transport().sent.map((sent) => sent.envelopeTo).sort()).toEqual([[ALICE], [BOB]]);
            expect(rawTo(ALICE)).toContain("LOCATION:Room 101");
            expect(rawTo(ALICE)).not.toContain(ALICE_URL);
            expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("failed to read personalized attendee links"))).toBe(true);
            expect((await ctx.reload(event.uid)).inviteSequenceSent).toBe(0);
        });

        it("Never mails the organizer on this path either, even with a (contrived) attendee-link row for the organizer's own address.", async () => {
            const event = await ctx.createEvent({
                videoMeetingUid: "meeting-1",
                attendees: [attendee(ALICE), { ...attendee("organizer@example.com"), isOrganizer: true }],
            });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: "organizer@example.com", url: "https://v.example/organizer" });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: ALICE, url: ALICE_URL });

            await ctx.job().run();

            expect(ctx.transport().sent.map((sent) => sent.envelopeTo)).toEqual([[ALICE]]);
            expect(rawTo(ALICE)).toContain(`LOCATION:${ALICE_URL}`);
            expect(rawTo(ALICE)).not.toContain("v.example/organizer");
        });

        it("Leaves cancellations completely unaffected by videoMeetingUid: one shared CANCEL carrying the event's own location, and no attendee-link query at all.", async () => {
            const spy = linkFindSpy();
            const event = await ctx.createEvent({
                location: "Room 101",
                videoMeetingUid: "meeting-1",
                status: CalendarEventStatus.CANCELLED,
                inviteSequenceSent: 0,
                attendees: [attendee(ALICE), attendee(BOB)],
            });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: ALICE, url: ALICE_URL });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: BOB, url: BOB_URL });

            await ctx.job().run();

            expect(spy).not.toHaveBeenCalled();
            expect(ctx.transport().sent.map((sent) => sent.envelopeTo).sort()).toEqual([[ALICE], [BOB]]);
            const alice: string = rawTo(ALICE);
            expect(alice).toContain("METHOD:CANCEL");
            expect(alice).toContain("LOCATION:Room 101");
            expect(alice).not.toContain(ALICE_URL);
            // The same bytes went to both attendees - the shared-compose path, untouched.
            expect(alice).toBe(rawTo(BOB));
            expect((await ctx.reload(event.uid)).cancelNoticeSentAt).toBeTruthy();
        });

        it("Logs a warning and keeps going when one attendee's own personalized send is refused, still delivering every other attendee's.", async () => {
            const warnSpy = vi.spyOn(ctx.job().logger, "warn");
            const event = await ctx.createEvent({
                videoMeetingUid: "meeting-1",
                attendees: [attendee("reject@example.com"), attendee(ALICE)],
            });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: "reject@example.com", url: "https://v.example/r" });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: ALICE, url: ALICE_URL });

            await expect(ctx.job().run()).resolves.toBeUndefined();

            expect(ctx.transport().sent.map((sent) => sent.envelopeTo)).toEqual([[ALICE]]);
            expect(rawTo(ALICE)).toContain(`LOCATION:${ALICE_URL}`);
            expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("failed to send invite for event") && String(call[0]).includes("reject@example.com"))).toBe(true);
            // Claimed, exactly as the shared path leaves it after a partial failure - see the job's "Known limitation".
            expect((await ctx.reload(event.uid)).inviteSequenceSent).toBe(0);
        });

        it("Fails only the attendee whose own personalized message the scan refuses, still delivering the rest.", async () => {
            const warnSpy = vi.spyOn(ctx.job().logger, "warn");
            const event = await ctx.createEvent({
                videoMeetingUid: "meeting-1",
                attendees: [attendee(ALICE), attendee(BOB)],
            });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: ALICE, url: ALICE_URL });
            await ctx.createLink({ mailboxUid: ctx.mailboxUid(), calendarEventUid: event.uid, attendeeAddress: BOB, url: BOB_URL });
            const real = ctx.job().scanPipeline.run.bind(ctx.job().scanPipeline);
            vi.spyOn(ctx.job().scanPipeline, "run").mockImplementation(async (raw: any, envelope: any, options: any) =>
                envelope?.to?.includes(ALICE) ? Promise.reject(new Error("simulated scan failure")) : real(raw, envelope, options),
            );

            await expect(ctx.job().run()).resolves.toBeUndefined();

            expect(ctx.transport().sent.map((sent) => sent.envelopeTo)).toEqual([[BOB]]);
            expect(warnSpy.mock.calls.some((call) => String(call[0]).includes("failed to send invite for event") && String(call[0]).includes(ALICE))).toBe(true);
        });
    });
}
