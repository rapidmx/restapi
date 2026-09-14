///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A booking type's calendarFolderUid must be a calendar folder of its own mailbox that the caller can read -
// identical on both backends. Run from the BookingTypeRoute test files, which supply the fixtures.
import { request } from "@rapidrest/service-core/test";
import { FolderType } from "../../src/models/types.js";

export interface BookingTypeFolderSuiteContext {
    app: () => any;
    baseUrl: string;
    ownerUid: string;
    ownerToken: string;
    otherUserUid: string;
    createMailbox: (ownerUid: string) => Promise<{ uid: string }>;
    createCalendarFolder: (mailboxUid: string, type?: FolderType) => Promise<{ uid: string }>;
    body: (mailboxUid: string, overrides?: any) => any;
}

export function bookingTypeFolderSuite(ctx: BookingTypeFolderSuiteContext): void {
    const post = (body: any) => request(ctx.app()).post(ctx.baseUrl).set("Authorization", "jwt " + ctx.ownerToken).send(body);

    describe("calendarFolderUid", () => {
        it("rejects a folder that doesn't exist, or none at all (400)", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const body = ctx.body(mailbox.uid);
            delete body.calendarFolderUid;
            expect((await post(body)).status).toBe(400);

            const result = await post(ctx.body(mailbox.uid, { calendarFolderUid: "no-such-folder" }));

            expect(result.status).toBe(400);
        });

        it("rejects a calendar folder of another mailbox the caller also owns (400)", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const otherMailbox = await ctx.createMailbox(ctx.ownerUid);
            const otherFolder = await ctx.createCalendarFolder(otherMailbox.uid);

            const result = await post(ctx.body(mailbox.uid, { calendarFolderUid: otherFolder.uid }));

            expect(result.status).toBe(400);
        });

        it("rejects a calendar folder of someone else's mailbox the caller can't read (403)", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const victimMailbox = await ctx.createMailbox(ctx.otherUserUid);
            const victimFolder = await ctx.createCalendarFolder(victimMailbox.uid);

            const result = await post(ctx.body(mailbox.uid, { calendarFolderUid: victimFolder.uid }));

            expect(result.status).toBe(403);
        });

        it("rejects a folder of the right mailbox that isn't a calendar (400)", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const inbox = await ctx.createCalendarFolder(mailbox.uid, FolderType.INBOX);

            const result = await post(ctx.body(mailbox.uid, { calendarFolderUid: inbox.uid }));

            expect(result.status).toBe(400);
        });

        it("accepts a second calendar folder of the same mailbox, and re-checks the folder on update", async () => {
            const mailbox = await ctx.createMailbox(ctx.ownerUid);
            const secondCalendar = await ctx.createCalendarFolder(mailbox.uid);
            const created = await post(ctx.body(mailbox.uid, { calendarFolderUid: secondCalendar.uid }));
            expect(created.status).toBe(200);
            expect(created.body.calendarFolderUid).toBe(secondCalendar.uid);

            const victimMailbox = await ctx.createMailbox(ctx.otherUserUid);
            const victimFolder = await ctx.createCalendarFolder(victimMailbox.uid);
            const put = (patch: any) =>
                request(ctx.app())
                    .put(`${ctx.baseUrl}/${created.body.uid}`)
                    .set("Authorization", "jwt " + ctx.ownerToken)
                    .send({ uid: created.body.uid, version: created.body.version, ...patch });
            expect((await put({ calendarFolderUid: victimFolder.uid })).status).toBe(403);

            const ownOtherMailbox = await ctx.createMailbox(ctx.ownerUid);
            const ownOtherFolder = await ctx.createCalendarFolder(ownOtherMailbox.uid);
            expect((await put({ calendarFolderUid: ownOtherFolder.uid })).status).toBe(400);
            // Moving the booking type to another mailbox without moving its folder is the same mismatch.
            expect((await put({ mailboxUid: ownOtherMailbox.uid })).status).toBe(400);

            const updateProperty = await request(ctx.app())
                .put(`${ctx.baseUrl}/${created.body.uid}/calendarFolderUid`)
                .set("Authorization", "jwt " + ctx.ownerToken)
                .send(victimFolder.uid);
            expect(updateProperty.status).toBe(403);
        });
    });
}
