///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `MeetingInviteSender`'s save-time sending of protected events and keyed meetings, isolated - the routes reach only the paths they gate to.
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { CalendarEventStatus } from "../../src/models/types.js";
import { invitationsPending, MeetingInviteSender, meetingLinkSecretsOf, protectedInvitationsPending } from "../../src/scheduling/MeetingInviteSender.js";

const KEY = "k=" + "A".repeat(20);

function event(fields: any = {}): any {
    return {
        uid: "e1",
        version: 1,
        sequence: 1,
        inviteSequenceSent: 0,
        status: CalendarEventStatus.CONFIRMED,
        organizer: { address: "owner@example.com" },
        attendees: [{ address: "bob@example.org" }],
        ...fields,
    };
}

function sender(options: { keyed?: boolean; links?: any[] } = {}) {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const linkRepo = {
        count: vi.fn().mockResolvedValue(options.keyed ? 1 : 0),
        find: vi.fn().mockResolvedValue(options.links ?? []),
    };
    const instance = new MeetingInviteSender(undefined, linkRepo as any, { logger, maxAttendees: 500 });
    return { instance, logger, linkRepo };
}

describe("MeetingInviteSender (isolated)", () => {
    it("tells which revisions still need their invitations sent", () => {
        expect(invitationsPending(event())).toBe(true);
        expect(invitationsPending(event({ inviteSequenceSent: null }))).toBe(true);
        expect(invitationsPending(event({ inviteSequenceSent: 1 }))).toBe(false);
        expect(invitationsPending(event({ attendees: [] }))).toBe(false);
        expect(invitationsPending(event({ status: CalendarEventStatus.CANCELLED }))).toBe(false);
        expect(protectedInvitationsPending(event({ sealedFields: { title: "x" } }))).toBe(true);
        expect(protectedInvitationsPending(event())).toBe(false);
    });

    it("reads a request's link keys: well-formed ones for plain addresses only, at most the cap", () => {
        expect(meetingLinkSecretsOf(undefined)).toBeUndefined();
        expect(meetingLinkSecretsOf([KEY])).toBeUndefined();
        expect(meetingLinkSecretsOf({ "Bob@Example.org": KEY, "not an address": KEY, "eve@example.org": "k=short", "x@example.org": 7 })).toEqual({ "bob@example.org": KEY });
        expect(meetingLinkSecretsOf({ "eve@example.org": "nope" })).toBeUndefined();
        expect(Object.keys(meetingLinkSecretsOf({ "a@example.org": KEY, "b@example.org": KEY }, 1)!)).toEqual(["a@example.org"]);
    });

    it("sends nothing for a revision already sent, or an event neither sealed nor keyed", async () => {
        const { instance } = sender();
        const repo = { update: vi.fn() };
        await instance.sendProtectedInvitations(event({ inviteSequenceSent: 1 }), undefined, repo as any, "test");
        await instance.sendProtectedInvitations(event({ videoMeetingUid: "vm" }), undefined, repo as any, "test");
        expect(repo.update).not.toHaveBeenCalled();
    });

    it("holds a sealed event without its content, and a keyed meeting without its link keys, saying which", async () => {
        const repo = { update: vi.fn() };
        const sealed = sender();
        await sealed.instance.sendProtectedInvitations(event({ sealedFields: { title: "x" } }), undefined, repo as any, "test");
        expect(sealed.logger.warn).toHaveBeenCalledWith(expect.stringContaining("no invitation content"));
        const keyed = sender({ keyed: true });
        await keyed.instance.sendProtectedInvitations(event({ videoMeetingUid: "vm" }), { title: "Board" }, repo as any, "test");
        expect(keyed.logger.warn).toHaveBeenCalledWith(expect.stringContaining("no meeting link keys"));
        expect(repo.update).not.toHaveBeenCalled();
    });

    it("leaves a copy that isn't the organizer's alone, and logs a failure to claim or send", async () => {
        const { instance, logger } = sender({ keyed: true });
        const organizer = vi.spyOn(instance, "organizerIdentity").mockResolvedValueOnce(undefined);
        const repo = { update: vi.fn().mockRejectedValue(new Error("version")) };
        await instance.sendProtectedInvitations(event({ videoMeetingUid: "vm" }), undefined, repo as any, "test", { "bob@example.org": KEY });
        expect(repo.update).not.toHaveBeenCalled();
        organizer.mockResolvedValueOnce({ addresses: new Set(["owner@example.com"]) });
        await instance.sendProtectedInvitations(event({ videoMeetingUid: "vm" }), undefined, repo as any, "test", { "bob@example.org": KEY });
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("failed to send the invitations for protected event e1: version"));
    });

    it("claims an event its organizer sends encrypted without sending it, returning the row the claim wrote", async () => {
        const { instance } = sender({ keyed: true });
        vi.spyOn(instance, "organizerIdentity").mockResolvedValue({ addresses: new Set(["owner@example.com"]) });
        const send = vi.spyOn(instance, "sendToAttendees");
        const repo = { update: vi.fn(async (patch: any) => ({ ...event(), ...patch, version: 2 })) };
        const claimed = await instance.sendProtectedInvitations(event({ videoMeetingUid: "vm", encryptionOrigin: "originated" }), undefined, repo as any, "test");
        expect(claimed).toMatchObject({ uid: "e1", version: 2, inviteSequenceSent: 1 });
        expect(send).not.toHaveBeenCalled();
    });

    it("sends no keyed link to an attendee whose copy may not carry its key", async () => {
        const logger = { warn: vi.fn(), error: vi.fn() };
        const linkRepo = { count: vi.fn(), find: vi.fn().mockResolvedValue([{ attendeeAddress: "bob@example.org", url: "https://meet.example/j/1", keyed: true }]) };
        const mayCarryMeetingKey = vi.fn().mockResolvedValue(false);
        const instance = new MeetingInviteSender(undefined, linkRepo as any, { logger, mayCarryMeetingKey });
        const transport = { name: "test", send: vi.fn() };
        (instance as any).mailTransport = transport;
        await instance.sendToAttendees(event({ videoMeetingUid: "vm" }), { addresses: new Set(["owner@example.com"]) }, "request", { "bob@example.org": KEY });
        expect(mayCarryMeetingKey).toHaveBeenCalledWith("bob@example.org");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("would be stored here readable"));
        expect(transport.send).not.toHaveBeenCalled();
    });

    it("never sends an attendee a keyed link without their key", async () => {
        const { instance, logger } = sender({ links: [{ attendeeAddress: "bob@example.org", url: "https://meet.example/j/1", keyed: true }] });
        const transport = { name: "test", send: vi.fn() };
        (instance as any).mailTransport = transport;
        await instance.sendToAttendees(event({ videoMeetingUid: "vm" }), { addresses: new Set(["owner@example.com"]) }, "request", { "other@example.org": KEY });
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no key for their meeting link"));
        expect(transport.send).not.toHaveBeenCalled();
    });
});
