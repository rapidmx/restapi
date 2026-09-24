///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The event dialog's fields on the iCalendar side: description (DESCRIPTION + X-ALT-DESC), visibility (CLASS), guest permissions
// (X-RAPIDMX-GUESTS-*), guests asked for by a change request, and the folding of long lines.
import { buildEventIcs, parseIcsEvent } from "../../src/util/IcsUtils.js";
import { AttendeeResponseStatus, AttendeeRole, BusyStatus, CalendarEvent, CalendarEventStatus, RecipientType } from "../../src/models/types.js";

const attendee = (address: string, extra: any = {}): any => ({
    address,
    displayName: undefined,
    role: AttendeeRole.REQUIRED,
    responseStatus: AttendeeResponseStatus.NEEDS_ACTION,
    isOrganizer: false,
    ...extra,
});

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        uid: "event-1",
        version: 0,
        dateCreated: new Date(),
        dateModified: new Date(),
        deleted: false,
        folderUid: "folder-1",
        mailboxUid: "mailbox-1",
        title: "Planning",
        startDate: new Date("2026-10-01T10:00:00Z"),
        endDate: new Date("2026-10-01T11:00:00Z"),
        allDay: false,
        timezone: "UTC",
        organizer: { address: "organizer@example.com", type: RecipientType.TO },
        attendees: [attendee("alice@example.com")],
        status: CalendarEventStatus.CONFIRMED,
        busyStatus: BusyStatus.BUSY,
        icalUid: "ical-1",
        sequence: 1,
        encryptionOrigin: "none",
        visibility: "default",
        guestsCanModify: false,
        guestsCanInviteOthers: true,
        guestsCanSeeGuestList: true,
        ...overrides,
    };
}

/** The unfolded content lines of `ics`. */
const linesOf = (ics: string): string[] => ics.replace(/\r\n /g, "").split("\r\n");

describe("buildEventIcs() and the event dialog's fields", () => {
    it("Emits none of the new properties for an event with the defaults, exactly as before.", () => {
        const ics = buildEventIcs(makeEvent(), "REQUEST");
        for (const property of ["DESCRIPTION", "X-ALT-DESC", "CLASS", "X-RAPIDMX-GUESTS", "X-RAPIDMX-CHANGE-REQUEST"]) {
            expect(ics).not.toContain(property);
        }
        // A row from before these fields existed reads the same.
        const legacy: any = makeEvent();
        delete legacy.visibility;
        legacy.guestsCanModify = null;
        const withoutStamp = (text: string): string => text.replace(/DTSTAMP:\w+/, "DTSTAMP:x");
        expect(withoutStamp(buildEventIcs(legacy, "REQUEST"))).toBe(withoutStamp(ics));
    });

    it("Writes the description as an escaped DESCRIPTION and the HTML as X-ALT-DESC;FMTTYPE=text/html.", () => {
        const ics = buildEventIcs(
            makeEvent({ description: "Line one\nLine two, with; punctuation \\ and a backslash", descriptionHtml: "<p>Line one</p><p>Line <b>two</b>, with; punctuation</p>" }),
            "REQUEST",
        );
        const lines = linesOf(ics);
        expect(lines).toContain("DESCRIPTION:Line one\\nLine two\\, with\\; punctuation \\\\ and a backslash");
        expect(lines).toContain("X-ALT-DESC;FMTTYPE=text/html:<p>Line one</p><p>Line <b>two</b>\\, with\\; punctuation</p>");
    });

    it("Sanitizes the HTML again on the way out and derives DESCRIPTION when an event has only HTML.", () => {
        const ics = buildEventIcs(makeEvent({ descriptionHtml: '<p onclick="x()">Hi <a href="javascript:x()">there</a></p><script>alert(1)</script>' }), "REQUEST");
        const lines = linesOf(ics);
        expect(lines).toContain("DESCRIPTION:Hi there");
        expect(lines).toContain("X-ALT-DESC;FMTTYPE=text/html:<p>Hi there</p>");
        expect(ics).not.toMatch(/script|onclick|javascript/);
    });

    it("Treats a null description (a SQL row) as none.", () => {
        const ics = buildEventIcs(makeEvent({ description: null as any, descriptionHtml: null as any }), "REQUEST");
        expect(ics).not.toContain("DESCRIPTION");
    });

    it("Writes CLASS for public, private and confidential, and none for default.", () => {
        expect(linesOf(buildEventIcs(makeEvent({ visibility: "public" }), "REQUEST"))).toContain("CLASS:PUBLIC");
        expect(linesOf(buildEventIcs(makeEvent({ visibility: "private" }), "REQUEST"))).toContain("CLASS:PRIVATE");
        expect(linesOf(buildEventIcs(makeEvent({ visibility: "confidential" }), "CANCEL"))).toContain("CLASS:CONFIDENTIAL");
        expect(buildEventIcs(makeEvent({ visibility: "default" }), "REQUEST")).not.toContain("CLASS");
    });

    it("Writes the guest permissions that differ from their defaults, TRUE or FALSE.", () => {
        const lines = linesOf(buildEventIcs(makeEvent({ guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: false }), "REQUEST"));
        expect(lines).toContain("X-RAPIDMX-GUESTS-CAN-MODIFY:TRUE");
        expect(lines).toContain("X-RAPIDMX-GUESTS-CAN-INVITE:FALSE");
        expect(lines).toContain("X-RAPIDMX-GUESTS-CAN-SEE-GUEST-LIST:FALSE");
        const onlyOne = linesOf(buildEventIcs(makeEvent({ guestsCanModify: true }), "REQUEST"));
        expect(onlyOne).toContain("X-RAPIDMX-GUESTS-CAN-MODIFY:TRUE");
        expect(onlyOne.some((line) => line.startsWith("X-RAPIDMX-GUESTS-CAN-INVITE") || line.startsWith("X-RAPIDMX-GUESTS-CAN-SEE"))).toBe(false);
    });

    it("Leaves a REPLY and an ordinary COUNTER without any of them.", () => {
        const event = makeEvent({ description: "Text", descriptionHtml: "<p>Text</p>", visibility: "private", guestsCanModify: true, guestsCanSeeGuestList: false });
        for (const method of ["REPLY", "COUNTER"] as const) {
            const ics = buildEventIcs(event, method, { onlyAttendee: attendee("alice@example.com") });
            for (const property of ["DESCRIPTION", "X-ALT-DESC", "CLASS", "X-RAPIDMX-GUESTS", "X-RAPIDMX-CHANGE-REQUEST"]) {
                expect(ics).not.toContain(property);
            }
        }
    });

    it("Writes a change request: the COUNTER carries the proposed values, the marker and the extra guests after the requester.", () => {
        const ics = buildEventIcs(makeEvent({ description: "New text", descriptionHtml: "<p>New text</p>" }), "COUNTER", {
            onlyAttendee: attendee("alice@example.com", { responseStatus: AttendeeResponseStatus.TENTATIVE }),
            changeRequest: true,
            extraAttendees: [attendee("dave@example.com", { displayName: "Dave" })],
        });
        const lines = linesOf(ics);
        expect(lines).toContain("METHOD:COUNTER");
        expect(lines).toContain("X-RAPIDMX-CHANGE-REQUEST:TRUE");
        expect(lines).toContain("DESCRIPTION:New text");
        expect(lines.filter((line) => line.startsWith("ATTENDEE"))).toEqual([
            "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=TENTATIVE:mailto:alice@example.com",
            'ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN="Dave":mailto:dave@example.com',
        ]);
        const parsed = parseIcsEvent(ics)!;
        expect(parsed.changeRequest).toBe(true);
        expect(parsed.attendees.map((entry) => entry.address)).toEqual(["alice@example.com", "dave@example.com"]);
    });

    it("Lists no extra attendee on an ordinary COUNTER or a REPLY without one.", () => {
        const ics = buildEventIcs(makeEvent(), "COUNTER", { onlyAttendee: attendee("alice@example.com") });
        expect(parseIcsEvent(ics)!.attendees).toHaveLength(1);
        expect(parseIcsEvent(buildEventIcs(makeEvent(), "COUNTER"))!.attendees).toHaveLength(0);
    });
});

describe("Line folding", () => {
    it("Folds every content line longer than 75 octets and no other, and unfolding gives the original back.", () => {
        const description = "word ".repeat(400).trim();
        const ics = buildEventIcs(makeEvent({ description, descriptionHtml: `<p>${description}</p>`, title: "T".repeat(200) }), "REQUEST");
        for (const line of ics.split("\r\n")) {
            expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
        }
        expect(ics.split("\r\n").filter((line) => line.startsWith(" ")).length).toBeGreaterThan(20);
        const parsed = parseIcsEvent(ics)!;
        expect(parsed.summary).toBe("T".repeat(200));
        expect(parsed.description).toBe(description);
        expect(parsed.descriptionHtml).toBe(`<p>${description}</p>`);
    });

    it("Leaves a line of exactly 75 octets in one piece and folds one octet more.", () => {
        // `SUMMARY:` is 8 octets.
        const at75 = buildEventIcs(makeEvent({ title: "s".repeat(67) }), "REQUEST");
        expect(at75).toContain(`SUMMARY:${"s".repeat(67)}\r\n`);
        const at76 = buildEventIcs(makeEvent({ title: "s".repeat(68) }), "REQUEST");
        expect(at76).toContain(`SUMMARY:${"s".repeat(67)}\r\n s\r\n`);
    });

    it("Never splits a multi-byte character or a surrogate pair across lines.", () => {
        const title = "\u00e9\u4e2d\u{1f600}".repeat(60);
        const ics = buildEventIcs(makeEvent({ title }), "REQUEST");
        const lines = ics.split("\r\n");
        for (const line of lines) {
            expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
            expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
        }
        expect(parseIcsEvent(ics)!.summary).toBe(title);
    });
});

describe("parseIcsEvent() and the event dialog's fields", () => {
    const wrap = (...properties: string[]): string =>
        ["BEGIN:VCALENDAR", "VERSION:2.0", "METHOD:REQUEST", "BEGIN:VEVENT", "UID:u1", "DTSTART:20261001T100000Z", "DTEND:20261001T110000Z", ...properties, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

    it("Reads nothing extra from a file that has none of the properties.", () => {
        const parsed = parseIcsEvent(wrap())!;
        for (const key of ["description", "descriptionHtml", "visibility", "guestsCanModify", "guestsCanInviteOthers", "guestsCanSeeGuestList", "changeRequest"]) {
            expect(key in parsed).toBe(false);
        }
    });

    it("Reads DESCRIPTION unescaped, and only an X-ALT-DESC that says it is HTML - sanitized.", () => {
        const parsed = parseIcsEvent(wrap("DESCRIPTION:a\\nb\\, c\\; d\\\\e", 'X-ALT-DESC;FMTTYPE=text/html:<p onclick=\\"x()\\">hi</p><script>alert(1)</script>'))!;
        expect(parsed.description).toBe("a\nb, c; d\\e");
        expect(parsed.descriptionHtml).toBe("<p>hi</p>");
        expect(parseIcsEvent(wrap("X-ALT-DESC;FMTTYPE=text/plain:not html"))!.descriptionHtml).toBeUndefined();
        expect(parseIcsEvent(wrap("X-ALT-DESC:no type"))!.descriptionHtml).toBeUndefined();
    });

    it("Never trusts an inbound X-ALT-DESC: hostile markup is sanitized and the plain text is derived from what is left.", () => {
        const parsed = parseIcsEvent(
            wrap(
                'X-ALT-DESC;FMTTYPE=text/html:<html><body><p style=\\"x\\">Agenda</p><a href=\\"javascript:alert(1)\\">link</a><img src=x onerror=alert(1)><iframe src=\\"https://evil.example\\"></iframe></body></html>',
            ),
        )!;
        expect(parsed.descriptionHtml).toBe("<p>Agenda</p>link");
        expect(parsed.description).toBe("Agenda\nlink");
    });

    it("Reads CLASS as public, private or confidential in any case, and nothing for anything else.", () => {
        expect(parseIcsEvent(wrap("CLASS:PRIVATE"))!.visibility).toBe("private");
        expect(parseIcsEvent(wrap("CLASS:confidential"))!.visibility).toBe("confidential");
        expect(parseIcsEvent(wrap("CLASS:Public"))!.visibility).toBe("public");
        expect(parseIcsEvent(wrap("CLASS:X-SOMETHING"))!.visibility).toBeUndefined();
    });

    it("Reads the guest permissions and the change-request marker, and ignores a value that isn't a boolean.", () => {
        const parsed = parseIcsEvent(
            wrap("X-RAPIDMX-GUESTS-CAN-MODIFY:TRUE", "X-RAPIDMX-GUESTS-CAN-INVITE:false", "X-RAPIDMX-GUESTS-CAN-SEE-GUEST-LIST: False", "X-RAPIDMX-CHANGE-REQUEST:TRUE"),
        )!;
        expect(parsed.guestsCanModify).toBe(true);
        expect(parsed.guestsCanInviteOthers).toBe(false);
        expect(parsed.guestsCanSeeGuestList).toBe(false);
        expect(parsed.changeRequest).toBe(true);
        const odd = parseIcsEvent(wrap("X-RAPIDMX-GUESTS-CAN-MODIFY:maybe", "X-RAPIDMX-GUESTS-CAN-INVITE:", "X-RAPIDMX-CHANGE-REQUEST:FALSE"))!;
        expect("guestsCanModify" in odd).toBe(false);
        expect("guestsCanInviteOthers" in odd).toBe(false);
        expect("changeRequest" in odd).toBe(false);
    });

    it("Reads the new properties of an override VEVENT too, and not from a nested component.", () => {
        const ics = [
            "BEGIN:VCALENDAR",
            "METHOD:REQUEST",
            "BEGIN:VEVENT",
            "UID:u1",
            "DTSTART:20261001T100000Z",
            "RRULE:FREQ=WEEKLY",
            "DESCRIPTION:master",
            "BEGIN:VALARM",
            "DESCRIPTION:alarm text",
            "CLASS:PRIVATE",
            "END:VALARM",
            "END:VEVENT",
            "BEGIN:VEVENT",
            "UID:u1",
            "RECURRENCE-ID:20261008T100000Z",
            "DTSTART:20261008T120000Z",
            "DESCRIPTION:override",
            "CLASS:CONFIDENTIAL",
            "END:VEVENT",
            "END:VCALENDAR",
        ].join("\r\n");
        const parsed = parseIcsEvent(ics)!;
        expect(parsed.description).toBe("master");
        expect(parsed.visibility).toBeUndefined();
        expect(parsed.overrides![0].description).toBe("override");
        expect(parsed.overrides![0].visibility).toBe("confidential");
    });

    it("Round-trips everything buildEventIcs() writes.", () => {
        const event = makeEvent({
            description: "Plain, with; specials\nand a second line",
            descriptionHtml: '<p>Plain, with; specials</p><ul><li>and a <a href="https://example.com/?a=1&amp;b=2">link</a></li></ul>',
            visibility: "private",
            guestsCanModify: true,
            guestsCanInviteOthers: false,
            guestsCanSeeGuestList: false,
        });
        const parsed = parseIcsEvent(buildEventIcs(event, "REQUEST"))!;
        expect(parsed.description).toBe(event.description);
        expect(parsed.descriptionHtml).toBe('<p>Plain, with; specials</p><ul><li>and a <a href="https://example.com/?a=1&amp;b=2" rel="noopener noreferrer">link</a></li></ul>');
        expect(parsed.visibility).toBe("private");
        expect(parsed.guestsCanModify).toBe(true);
        expect(parsed.guestsCanInviteOthers).toBe(false);
        expect(parsed.guestsCanSeeGuestList).toBe(false);
    });
});
