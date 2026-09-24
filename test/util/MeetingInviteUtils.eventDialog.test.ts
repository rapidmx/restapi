///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What the invitation card learns from the event dialog's fields: description, visibility, guest permissions, the buttons a guest may
// be offered and a guest's change request.
import { AttendeeResponseStatus } from "../../src/models/types.js";
import { describeInvite, parseInviteIcs } from "../../src/util/MeetingInviteUtils.js";

const ICS = (extra: string[] = [], method = "REQUEST", attendees: string[] = ["ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@x.com"]): string =>
    [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        `METHOD:${method}`,
        "BEGIN:VEVENT",
        "UID:abc@x",
        "DTSTART:20260930T200000Z",
        "DTEND:20260930T210000Z",
        "SUMMARY:Sync",
        "SEQUENCE:1",
        "ORGANIZER:mailto:boss@x.com",
        ...attendees,
        ...extra,
        "END:VEVENT",
        "END:VCALENDAR",
    ].join("\r\n");

const me = new Set(["me@x.com"]);
const boss = new Set(["boss@x.com"]);
const onCalendar: any = { uid: "cal-1", sequence: 1, attendees: [{ address: "me@x.com", responseStatus: AttendeeResponseStatus.NEEDS_ACTION }] };

describe("describeInvite() and the event dialog's fields", () => {
    it("Reports the defaults for an invitation that names none of them.", () => {
        const view = describeInvite(parseInviteIcs(ICS())!, me, onCalendar, {} as any);
        expect(view.visibility).toBe("default");
        expect(view.guestPermissions).toEqual({ guestsCanModify: false, guestsCanInviteOthers: true, guestsCanSeeGuestList: true });
        expect(view.description).toBeUndefined();
        expect(view.descriptionHtml).toBeUndefined();
        expect(view.changeRequest).toBeUndefined();
        expect(view).toMatchObject({ canRequestChange: false, canRequestInvite: true });
    });

    it("Carries the description (HTML already sanitized), the visibility and the guest permissions.", () => {
        const view = describeInvite(
            parseInviteIcs(
                ICS([
                    "DESCRIPTION:Agenda",
                    'X-ALT-DESC;FMTTYPE=text/html:<p onclick=\\"x()\\">Agenda</p><script>1</script>',
                    "CLASS:CONFIDENTIAL",
                    "X-RAPIDMX-GUESTS-CAN-MODIFY:TRUE",
                    "X-RAPIDMX-GUESTS-CAN-INVITE:FALSE",
                    "X-RAPIDMX-GUESTS-CAN-SEE-GUEST-LIST:FALSE",
                ]),
            )!,
            me,
            onCalendar,
            {} as any,
        );
        expect(view.description).toBe("Agenda");
        expect(view.descriptionHtml).toBe("<p>Agenda</p>");
        expect(view.visibility).toBe("confidential");
        expect(view.guestPermissions).toEqual({ guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: false });
    });

    it("Offers a guest the change and invite buttons the organizer's permissions allow, once the meeting is on their calendar.", () => {
        const allowed = parseInviteIcs(ICS(["X-RAPIDMX-GUESTS-CAN-MODIFY:TRUE"]))!;
        expect(describeInvite(allowed, me, onCalendar, {} as any)).toMatchObject({ canRequestChange: true, canRequestInvite: true });
        const onlyChange = parseInviteIcs(ICS(["X-RAPIDMX-GUESTS-CAN-MODIFY:TRUE", "X-RAPIDMX-GUESTS-CAN-INVITE:FALSE"]))!;
        expect(describeInvite(onlyChange, me, onCalendar, {} as any)).toMatchObject({ canRequestChange: true, canRequestInvite: false });
        expect(describeInvite(parseInviteIcs(ICS())!, me, onCalendar, {} as any)).toMatchObject({ canRequestChange: false, canRequestInvite: true });
        // Not on the calendar yet (nothing to ask a change of), the organizer's own meeting, a cancellation and a reply.
        expect(describeInvite(allowed, me, undefined, {} as any)).toMatchObject({ canRequestChange: false, canRequestInvite: false });
        expect(describeInvite(allowed, boss, onCalendar, {} as any)).toMatchObject({ canRequestChange: false, canRequestInvite: false });
        expect(describeInvite(parseInviteIcs(ICS(["X-RAPIDMX-GUESTS-CAN-MODIFY:TRUE", "STATUS:CANCELLED"]))!, me, onCalendar, {} as any).canRequestChange).toBe(false);
        expect(describeInvite(parseInviteIcs(ICS(["X-RAPIDMX-GUESTS-CAN-MODIFY:TRUE"], "REPLY"))!, me, onCalendar, {} as any).canRequestChange).toBe(false);
    });

    describe("a hidden guest list", () => {
        const everyone = ["ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@x.com", "ATTENDEE;PARTSTAT=ACCEPTED:mailto:other@x.com", "ATTENDEE;PARTSTAT=DECLINED:mailto:third@x.com"];

        it("Lists only the reader to a guest, whatever the file names.", () => {
            const parsed = parseInviteIcs(ICS(["X-RAPIDMX-GUESTS-CAN-SEE-GUEST-LIST:FALSE"], "REQUEST", everyone))!;
            expect(describeInvite(parsed, me, onCalendar, {} as any).attendees.map((entry) => entry.address)).toEqual(["me@x.com"]);
            expect(describeInvite(parsed, new Set(["nobody@x.com"]), undefined, {} as any).attendees).toEqual([]);
        });

        it("Still lists everyone to the organizer, and to every reader when the list is visible.", () => {
            const hidden = parseInviteIcs(ICS(["X-RAPIDMX-GUESTS-CAN-SEE-GUEST-LIST:FALSE"], "REQUEST", everyone))!;
            expect(describeInvite(hidden, boss, undefined, {} as any).attendees).toHaveLength(3);
            const visible = parseInviteIcs(ICS([], "REQUEST", everyone))!;
            expect(describeInvite(visible, me, onCalendar, {} as any).attendees).toHaveLength(3);
        });
    });

    describe("a guest's change request (a COUNTER carrying X-RAPIDMX-CHANGE-REQUEST)", () => {
        const counter = (): any =>
            parseInviteIcs(
                ICS(["X-RAPIDMX-CHANGE-REQUEST:TRUE"], "COUNTER", ["ATTENDEE;PARTSTAT=TENTATIVE:mailto:guest@x.com", "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:added@x.com"]),
            )!;
        const organized: any = { uid: "cal-2", sequence: 1, attendees: [{ address: "guest@x.com", responseStatus: AttendeeResponseStatus.TENTATIVE }] };
        const fromGuest: any = { from: { address: "guest@x.com" } };

        it("Says it is a change request that has not been applied, and still lets the organizer accept the proposal.", () => {
            const view = describeInvite(counter(), boss, organized, fromGuest);
            expect(view.changeRequest).toEqual({ applied: false });
            expect(view.canAcceptProposal).toBe(true);
            expect(view.attendees.map((entry) => entry.address)).toEqual(["guest@x.com", "added@x.com"]);
        });

        it("Says it was applied once the message records the organizer's answer, and then offers no acceptance.", () => {
            const view = describeInvite(counter(), boss, organized, { ...fromGuest, meetingResponse: "accepted" });
            expect(view.changeRequest).toEqual({ applied: true });
            expect(view.response).toBe("accepted");
            expect(view.canAcceptProposal).toBe(false);
        });

        it("Says nothing about a change request of an ordinary proposal or any other method.", () => {
            const proposal = parseInviteIcs(ICS([], "COUNTER", ["ATTENDEE;PARTSTAT=TENTATIVE:mailto:guest@x.com"]))!;
            expect(describeInvite(proposal, boss, organized, fromGuest).changeRequest).toBeUndefined();
            const request = parseInviteIcs(ICS(["X-RAPIDMX-CHANGE-REQUEST:TRUE"]))!;
            expect(describeInvite(request, me, onCalendar, {} as any).changeRequest).toBeUndefined();
            expect(describeInvite(proposal, boss, organized, { ...fromGuest, meetingResponse: "accepted" }).canAcceptProposal).toBe(true);
        });
    });
});
