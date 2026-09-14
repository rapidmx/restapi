///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { resolveActiveOof } from "../../src/util/OofUtils.js";
import { CalendarEvent, Mailbox } from "../../src/models/types.js";

function makeMailbox(overrides: Partial<Mailbox> = {}): Mailbox {
    return {
        uid: "mbx-1",
        version: 0,
        dateCreated: new Date(),
        dateModified: new Date(),
        primarySmtpAddress: "mailbox@example.com",
        aliasAddresses: [],
        displayName: "Mailbox",
        timezone: "UTC",
        quotaBytes: 0,
        usedBytes: 0,
        oofEnabled: false,
        oofMessage: "",
        ...overrides,
    };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
        uid: "event-1",
        version: 0,
        dateCreated: new Date(),
        dateModified: new Date(),
        deleted: false,
        folderUid: "folder-1",
        mailboxUid: "mbx-1",
        title: "Vacation",
        startDate: new Date(),
        endDate: new Date(),
        allDay: true,
        timezone: "UTC",
        organizer: { address: "mailbox@example.com", type: "to" as any },
        attendees: [],
        status: "confirmed" as any,
        busyStatus: "oof" as any,
        icalUid: "ical-1",
        sequence: 0,
        ...overrides,
    };
}

describe("resolveActiveOof() Tests", () => {
    it("Returns undefined when neither the mailbox toggle nor a linked event is active.", () => {
        expect(resolveActiveOof(makeMailbox())).toBeUndefined();
    });

    it("Returns active with the mailbox's oofMessage when oofEnabled is true and there is no window.", () => {
        const mailbox = makeMailbox({ oofEnabled: true, oofMessage: "I'm out." });
        expect(resolveActiveOof(mailbox)).toEqual({ active: true, message: "I'm out." });
    });

    it("Returns undefined when oofEnabled is true but now falls outside the configured window.", () => {
        const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        const alsoPast = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const mailbox = makeMailbox({ oofEnabled: true, oofMessage: "I'm out.", oofStartTime: past, oofEndTime: alsoPast });
        expect(resolveActiveOof(mailbox)).toBeUndefined();
    });

    it("Returns active when oofEnabled is true and now falls within the configured window.", () => {
        const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
        const mailbox = makeMailbox({ oofEnabled: true, oofMessage: "I'm out.", oofStartTime: past, oofEndTime: future });
        expect(resolveActiveOof(mailbox)).toEqual({ active: true, message: "I'm out." });
    });

    it("Honors a window whose bounds come back from storage as ISO strings (Mongo), not Date objects.", () => {
        const day = 24 * 60 * 60 * 1000;
        const inside = makeMailbox({
            oofEnabled: true,
            oofMessage: "I'm out.",
            oofStartTime: new Date(Date.now() - day).toISOString() as unknown as Date,
            oofEndTime: new Date(Date.now() + day).toISOString() as unknown as Date,
        });
        expect(resolveActiveOof(inside)).toEqual({ active: true, message: "I'm out." });

        const expired = makeMailbox({
            oofEnabled: true,
            oofMessage: "I'm out.",
            oofStartTime: new Date(Date.now() - 2 * day).toISOString() as unknown as Date,
            oofEndTime: new Date(Date.now() - day).toISOString() as unknown as Date,
        });
        expect(resolveActiveOof(expired)).toBeUndefined();

        const notYetStarted = makeMailbox({
            oofEnabled: true,
            oofMessage: "I'm out.",
            oofStartTime: new Date(Date.now() + day).toISOString() as unknown as Date,
            oofEndTime: new Date(Date.now() + 2 * day).toISOString() as unknown as Date,
        });
        expect(resolveActiveOof(notYetStarted)).toBeUndefined();
    });

    it("Fails closed (no automatic reply) when a window bound is an unparseable date.", () => {
        const mailbox = makeMailbox({
            oofEnabled: true,
            oofMessage: "I'm out.",
            oofStartTime: "not-a-date" as unknown as Date,
            oofEndTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        expect(resolveActiveOof(mailbox)).toBeUndefined();
        expect(resolveActiveOof(makeMailbox({ ...mailbox, oofStartTime: new Date(0), oofEndTime: new Date(NaN) }))).toBeUndefined();
    });

    it("Returns active with the linked calendar event's message when the event is active, mailbox toggle off.", () => {
        const mailbox = makeMailbox({ oofEnabled: false });
        const event = makeEvent({ autoReplyEnabled: true, autoReplyMessage: "On vacation." });
        expect(resolveActiveOof(mailbox, event)).toEqual({ active: true, message: "On vacation." });
    });

    it("The linked calendar event's message takes precedence when both the event and the mailbox toggle are active.", () => {
        const mailbox = makeMailbox({ oofEnabled: true, oofMessage: "Standing OOF message." });
        const event = makeEvent({ autoReplyEnabled: true, autoReplyMessage: "Vacation-specific message." });
        expect(resolveActiveOof(mailbox, event)).toEqual({ active: true, message: "Vacation-specific message." });
    });

    it("Falls back to the mailbox toggle when the passed event has autoReplyEnabled false.", () => {
        const mailbox = makeMailbox({ oofEnabled: true, oofMessage: "Standing OOF message." });
        const event = makeEvent({ autoReplyEnabled: false });
        expect(resolveActiveOof(mailbox, event)).toEqual({ active: true, message: "Standing OOF message." });
    });

    it("Defaults an active event's message to an empty string when autoReplyMessage is unset.", () => {
        const mailbox = makeMailbox();
        const event = makeEvent({ autoReplyEnabled: true, autoReplyMessage: undefined });
        expect(resolveActiveOof(mailbox, event)).toEqual({ active: true, message: "" });
    });
});
