///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `MeetingInviteSender`'s save-time sending of protected events and keyed meetings, isolated - the routes reach only the paths they gate to.
import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { CalendarEventStatus } from "../../src/models/types.js";
import { invitationsPending, MeetingInviteSender, meetingLinkSecretsOf, protectedInvitationsPending } from "../../src/scheduling/MeetingInviteSender.js";

// No scan here: a copy goes straight to the relay `sendPerAttendee()` hands over, which is what these tests look at.
vi.mock("../../src/util/MailSendUtils.js", async (importOriginal) => ({
    ...(await importOriginal<any>()),
    scanAndRelay: vi.fn(async (raw: Buffer, envelopeFrom: string, envelopeTo: string[], _scan: unknown, relay: any) => await relay.send({ raw, envelopeFrom, envelopeTo })),
}));

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
        expect(protectedInvitationsPending(event({ sealedContent: { keyFingerprint: "fp", sealed: "x" } }))).toBe(true);
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

    it("sends no keyed link at all from a sender that can't tell whose copy may carry its key", async () => {
        const { instance, logger } = sender({ links: [{ attendeeAddress: "bob@example.org", url: "https://meet.example/j/1", keyed: true }] });
        const transport = { name: "test", send: vi.fn() };
        (instance as any).mailTransport = transport;
        await instance.sendToAttendees(event({ videoMeetingUid: "vm" }), { addresses: new Set(["owner@example.com"]) }, "request", { "bob@example.org": KEY });
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

    it("asks for a headers-only bounce of a keyed copy, and without a transport that can, sends one only when the organizer's mail would seal it (round 7, #705)", async () => {
        const link = { attendeeAddress: "bob@example.org", url: "https://meet.example/j/1", keyed: true };
        const build = (headersOnlyDsn: boolean | undefined, organizerSeals: boolean) => {
            const logger = { warn: vi.fn(), error: vi.fn() };
            const linkRepo = { count: vi.fn(), find: vi.fn().mockResolvedValue([link]) };
            const mayCarryMeetingKey = vi.fn(async (address: string) => address === "bob@example.org" || organizerSeals);
            const instance = new MeetingInviteSender(undefined, linkRepo as any, { logger, mayCarryMeetingKey });
            const transport = { name: "test", headersOnlyDsn, send: vi.fn(async (outbound: any) => ({ accepted: outbound.envelopeTo, rejected: [] })) };
            Object.assign(instance as any, { mailTransport: transport, scanPipeline: {}, blobStore: {} });
            return { instance, logger, transport, mayCarryMeetingKey };
        };
        const send = async (built: ReturnType<typeof build>) =>
            await built.instance.sendToAttendees(event({ videoMeetingUid: "vm" }), { addresses: new Set(["owner@example.com"]) }, "request", { "bob@example.org": KEY });

        // Postfix: `-R hdrs`, whatever the organizer's mailbox stores.
        const postfix = build(true, false);
        await send(postfix);
        expect(postfix.transport.send).toHaveBeenCalledTimes(1);
        expect(postfix.transport.send.mock.calls[0][0]).toMatchObject({ envelopeFrom: "owner@example.com", envelopeTo: ["bob@example.org"], dsnReturn: "headers" });
        expect(postfix.mayCarryMeetingKey).not.toHaveBeenCalledWith("owner@example.com");

        // A transport that can't ask for it: not sent to an organizer whose mail is stored readable...
        const readable = build(undefined, false);
        await send(readable);
        expect(readable.mayCarryMeetingKey).toHaveBeenCalledWith("owner@example.com");
        expect(readable.logger.warn).toHaveBeenCalledWith(expect.stringContaining("a bounce of it would store their meeting link's key"));
        expect(readable.transport.send).not.toHaveBeenCalled();

        // ...and sent to one whose mail is sealed, still asking.
        const sealed = build(undefined, true);
        await send(sealed);
        expect(sealed.transport.send).toHaveBeenCalledTimes(1);
        expect(sealed.transport.send.mock.calls[0][0].dsnReturn).toBe("headers");

        // An unkeyed link asks for nothing.
        const plain = build(undefined, false);
        (plain.instance as any).attendeeLinkRepo.find.mockResolvedValue([{ ...link, keyed: false }]);
        await send(plain);
        expect(plain.transport.send).toHaveBeenCalledTimes(1);
        expect(plain.transport.send.mock.calls[0][0]).not.toHaveProperty("dsnReturn");
        expect(plain.mayCarryMeetingKey).not.toHaveBeenCalled();
    });
});
