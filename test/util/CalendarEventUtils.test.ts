///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RecipientType } from "../../src/models/types.js";
import {
    BUSY_TITLE,
    DEFAULT_GUEST_PERMISSIONS,
    effectiveVisibility,
    eventDetailQueryError,
    guestPermissionsOf,
    hidesDetailsFromReaders,
    queryNamesEventDetails,
    redactEventForReader,
    validateEventPolicyFields,
} from "../../src/util/CalendarEventUtils.js";

const refusal = (fn: () => void): any => {
    try {
        fn();
    } catch (err: any) {
        return err;
    }
    return undefined;
};

describe("effectiveVisibility()", () => {
    it("Reads a missing, null or unrecognized visibility as default and keeps a real one.", () => {
        expect(effectiveVisibility(undefined)).toBe("default");
        expect(effectiveVisibility({})).toBe("default");
        expect(effectiveVisibility({ visibility: null })).toBe("default");
        expect(effectiveVisibility({ visibility: "secret" })).toBe("default");
        for (const visibility of ["default", "public", "private", "confidential"]) {
            expect(effectiveVisibility({ visibility })).toBe(visibility);
        }
    });

    it("Hides details from readers for private and confidential only.", () => {
        expect(hidesDetailsFromReaders({ visibility: "private" })).toBe(true);
        expect(hidesDetailsFromReaders({ visibility: "confidential" })).toBe(true);
        expect(hidesDetailsFromReaders({ visibility: "public" })).toBe(false);
        expect(hidesDetailsFromReaders({ visibility: "default" })).toBe(false);
        expect(hidesDetailsFromReaders({})).toBe(false);
        expect(hidesDetailsFromReaders(undefined)).toBe(false);
    });
});

describe("guestPermissionsOf()", () => {
    it("Falls back to the defaults for a missing, null or non-boolean value.", () => {
        expect(guestPermissionsOf(undefined)).toEqual(DEFAULT_GUEST_PERMISSIONS);
        expect(guestPermissionsOf({})).toEqual({ guestsCanModify: false, guestsCanInviteOthers: true, guestsCanSeeGuestList: true });
        expect(guestPermissionsOf({ guestsCanModify: null, guestsCanInviteOthers: "no", guestsCanSeeGuestList: 0 })).toEqual(DEFAULT_GUEST_PERMISSIONS);
    });

    it("Keeps a stored boolean, each on its own.", () => {
        expect(guestPermissionsOf({ guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: false })).toEqual({
            guestsCanModify: true,
            guestsCanInviteOthers: false,
            guestsCanSeeGuestList: false,
        });
        expect(guestPermissionsOf({ guestsCanSeeGuestList: false })).toEqual({ guestsCanModify: false, guestsCanInviteOthers: true, guestsCanSeeGuestList: false });
    });
});

describe("redactEventForReader()", () => {
    class Row {
        constructor(data: any) {
            Object.assign(this, data);
        }
    }
    const full = (visibility: string): any =>
        new Row({
            uid: "e1",
            icalUid: "ical-1",
            folderUid: "f1",
            mailboxUid: "m1",
            title: "Salary review",
            location: "CEO office",
            description: "Confidential numbers",
            descriptionHtml: "<p>Confidential numbers</p>",
            startDate: new Date("2026-10-01T10:00:00Z"),
            endDate: new Date("2026-10-01T11:00:00Z"),
            allDay: false,
            timezone: "UTC",
            organizer: { address: "ceo@example.com", displayName: "CEO", type: RecipientType.TO },
            attendees: [{ address: "hr@example.com", role: "required", responseStatus: "accepted", isOrganizer: false }],
            status: "confirmed",
            busyStatus: "busy",
            sequence: 3,
            recurrenceRule: { freq: "weekly", interval: 1, exceptions: [] },
            reminderMinutesBeforeStart: 15,
            autoReplyEnabled: true,
            autoReplyMessage: "Away",
            videoMeetingUid: "meeting-1",
            inviteSequenceSent: 3,
            cancelNoticeSentAt: new Date(),
            reminderSentFor: new Date(),
            guestsCanModify: true,
            guestsCanInviteOthers: false,
            guestsCanSeeGuestList: false,
            visibility,
        });

    it("Returns an event that doesn't hide its details as it is.", () => {
        for (const visibility of ["default", "public"]) {
            const event = full(visibility);
            expect(redactEventForReader(event)).toBe(event);
        }
        const bare = { title: "x" };
        expect(redactEventForReader(bare)).toBe(bare);
    });

    it("Turns a private or confidential event into a busy block: same time and series, nothing of its details.", () => {
        for (const visibility of ["private", "confidential"]) {
            const event = full(visibility);
            const redacted = redactEventForReader(event);
            expect(redacted).not.toBe(event);
            expect(redacted).toBeInstanceOf(Row);
            expect(redacted.title).toBe(BUSY_TITLE);
            expect(redacted.redacted).toBe(true);
            expect(redacted.attendees).toEqual([]);
            expect(redacted.organizer).toEqual({ address: "", type: RecipientType.TO });
            for (const field of [
                "location",
                "description",
                "descriptionHtml",
                "videoMeetingUid",
                "reminderMinutesBeforeStart",
                "autoReplyEnabled",
                "autoReplyMessage",
                "inviteSequenceSent",
                "cancelNoticeSentAt",
                "reminderSentFor",
                "guestsCanModify",
                "guestsCanInviteOthers",
                "guestsCanSeeGuestList",
            ]) {
                expect(field in redacted).toBe(false);
            }
            // What makes it a block in the right place is kept.
            expect(redacted.uid).toBe("e1");
            expect(redacted.icalUid).toBe("ical-1");
            expect(redacted.startDate).toEqual(event.startDate);
            expect(redacted.endDate).toEqual(event.endDate);
            expect(redacted.recurrenceRule).toEqual(event.recurrenceRule);
            expect(redacted.busyStatus).toBe("busy");
            expect(redacted.status).toBe("confirmed");
            expect(redacted.visibility).toBe(visibility);
            // The event it was made from is untouched (it may be a cached entity).
            expect(event.title).toBe("Salary review");
            expect(event.attendees).toHaveLength(1);
            expect(event.redacted).toBeUndefined();
            expect(event.location).toBe("CEO office");
        }
    });
});

describe("queryNamesEventDetails()", () => {
    it("Is true for a filter or a sort on a field holding an event's details, however the query names it.", () => {
        expect(queryNamesEventDetails({ folderUid: "f", title: "like(salary)" })).toBe(true);
        expect(queryNamesEventDetails({ folderUid: "f", location: "x" })).toBe(true);
        expect(queryNamesEventDetails({ folderUid: "f", description: "x" })).toBe(true);
        expect(queryNamesEventDetails({ folderUid: "f", "attendees.address": "x@example.com" })).toBe(true);
        expect(queryNamesEventDetails({ folderUid: "f", sort: "title:ASC" })).toBe(true);
        expect(queryNamesEventDetails({ folderUid: "f", sort: { location: "ASC" } })).toBe(true);
    });

    it("Is false for a query by time, status, folder or a sort by start.", () => {
        expect(queryNamesEventDetails(undefined)).toBe(false);
        expect(queryNamesEventDetails({})).toBe(false);
        expect(queryNamesEventDetails({ folderUid: "f", startDate: "gt(2026-01-01)", status: "confirmed", visibility: "private", limit: 10 })).toBe(false);
        expect(queryNamesEventDetails({ folderUid: "f", sort: { startDate: "ASC" } })).toBe(false);
        expect(queryNamesEventDetails({ folderUid: "f", sort: "startDate:DESC" })).toBe(false);
    });

    it("Comes with a 400 to refuse it with.", () => {
        expect(eventDetailQueryError().status).toBe(400);
    });
});

describe("validateEventPolicyFields()", () => {
    it("Accepts every visibility and boolean, and leaves them alone.", () => {
        for (const visibility of ["default", "public", "private", "confidential"]) {
            const body: any = { visibility, guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: true };
            expect(refusal(() => validateEventPolicyFields(body))).toBeUndefined();
            expect(body).toEqual({ visibility, guestsCanModify: true, guestsCanInviteOthers: false, guestsCanSeeGuestList: true });
        }
    });

    it("Removes a null or undefined value, so it neither clears nor changes what is stored.", () => {
        const body: any = { title: "x", visibility: null, guestsCanModify: null, guestsCanInviteOthers: undefined, guestsCanSeeGuestList: null };
        validateEventPolicyFields(body);
        expect(body).toEqual({ title: "x" });
        const withUndefinedVisibility: any = { visibility: undefined };
        validateEventPolicyFields(withUndefinedVisibility);
        expect("visibility" in withUndefinedVisibility).toBe(false);
    });

    it("Refuses nonsense with a 400: an unknown visibility, a non-boolean flag.", () => {
        expect(refusal(() => validateEventPolicyFields({ visibility: "secret" }))?.status).toBe(400);
        expect(refusal(() => validateEventPolicyFields({ visibility: 3 }))?.status).toBe(400);
        for (const field of ["guestsCanModify", "guestsCanInviteOthers", "guestsCanSeeGuestList"]) {
            expect(refusal(() => validateEventPolicyFields({ [field]: "true" }))?.status).toBe(400);
            expect(refusal(() => validateEventPolicyFields({ [field]: 1 }))?.status).toBe(400);
        }
    });

    it("Leaves a body with none of these fields alone.", () => {
        const body: any = { title: "x" };
        validateEventPolicyFields(body);
        expect(body).toEqual({ title: "x" });
    });
});
