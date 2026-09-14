///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Date fields coerced on write (and legacy string dates tolerated on read), and the paged, newest-first request
// lists - identical on both backends. Run from the SecurityControls test files.
import { request } from "@rapidrest/service-core/test";
import { ACLAction } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { BusyStatus, CalendarEventStatus, RecipientType, RecurrenceFrequency } from "../../src/models/types.js";
import type { SecurityControlsSuiteContext } from "./escrowControlsSuite.js";

const HOUR_MS = 60 * 60 * 1000;

export function datesAndListsSuite(ctx: SecurityControlsSuiteContext): void {
    const newUser = (roles: string[] = []): any => ({ uid: uuid.v4(), roles, elevated: Date.now() });
    const authed = (method: "get" | "put" | "post" | "delete", user: any, path: string) =>
        (request(ctx.app()) as any)[method](`${ctx.prefix}${path}`).set("Authorization", "jwt " + ctx.token(user));
    const createMailbox = async (ownerUserUid: string) => {
        const mailbox = await ctx.store().save("Mailbox", {
            ownerUserUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        await ctx.store().saveAcl(mailbox.uid, "Mailbox", [{ userOrRoleId: ownerUserUid, actions: [ACLAction.FULL] }]);
        return mailbox;
    };
    /** The stored value as epoch millis - SQL hydrates a real `Date`, MongoDB whatever was saved. */
    const millis = (value: any): number => new Date(value).getTime();

    describe("calendar event dates", () => {
        const owner = newUser();

        beforeEach(async () => {
            await ctx.store().clear("CalendarEvent", "Folder", "Mailbox");
        });

        const setup = async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await ctx.store().save("Folder", { mailboxUid: mailbox.uid, name: "Calendar", type: "calendar", unreadCount: 0, totalCount: 0, syncKeyVersion: 0 });
            await ctx.store().saveAcl(folder.uid, mailbox.uid, []);
            return { mailbox, folder };
        };
        const eventBody = (mailbox: any, folder: any, overrides?: any) => ({
            mailboxUid: mailbox.uid,
            folderUid: folder.uid,
            title: "Planning",
            startDate: "2099-06-01T13:00:00.000Z",
            endDate: "2099-06-01T14:00:00.000Z",
            allDay: false,
            timezone: "UTC",
            organizer: { address: "organizer@example.com", type: RecipientType.TO },
            attendees: [],
            status: CalendarEventStatus.CONFIRMED,
            busyStatus: BusyStatus.BUSY,
            icalUid: uuid.v4(),
            sequence: 0,
            recurrenceRule: {
                freq: RecurrenceFrequency.WEEKLY,
                interval: 1,
                until: "2099-12-01T00:00:00.000Z",
                exceptions: ["2099-06-08T13:00:00.000Z"],
            },
            ...overrides,
        });

        it("stores ISO string dates sent by a client as real dates, on create, update and updateProperty", async () => {
            const { mailbox, folder } = await setup();

            const created = await authed("post", owner, "/calendar-events").send(eventBody(mailbox, folder));
            expect(created.status).toBe(200);
            let stored = (await ctx.store().find("CalendarEvent", { uid: created.body.uid }))[0];
            expect(stored.startDate).toBeInstanceOf(Date);
            expect(stored.endDate).toBeInstanceOf(Date);
            if (ctx.store().backend === "mongo") {
                expect(stored.recurrenceRule.until).toBeInstanceOf(Date);
                expect(stored.recurrenceRule.exceptions[0]).toBeInstanceOf(Date);
            }
            expect(millis(stored.recurrenceRule.until)).toBe(Date.parse("2099-12-01T00:00:00.000Z"));

            const updated = await authed("put", owner, `/calendar-events/${created.body.uid}`).send({
                uid: created.body.uid,
                version: created.body.version,
                startDate: "2099-06-01T15:00:00.000Z",
                endDate: "2099-06-01T16:00:00.000Z",
            });
            expect(updated.status).toBe(200);
            expect(updated.body.sequence).toBe(1);
            stored = (await ctx.store().find("CalendarEvent", { uid: created.body.uid }))[0];
            expect(stored.startDate).toBeInstanceOf(Date);
            expect(millis(stored.startDate)).toBe(Date.parse("2099-06-01T15:00:00.000Z"));

            const property = await authed("put", owner, `/calendar-events/${created.body.uid}/endDate`).send("2099-06-01T17:00:00.000Z");
            expect(property.status).toBe(200);
            stored = (await ctx.store().find("CalendarEvent", { uid: created.body.uid }))[0];
            expect(stored.endDate).toBeInstanceOf(Date);
            expect(millis(stored.endDate)).toBe(Date.parse("2099-06-01T17:00:00.000Z"));
        });

        it("rejects an unparseable date (400)", async () => {
            const { mailbox, folder } = await setup();

            for (const overrides of [
                { startDate: "not-a-date" },
                { endDate: "" },
                { startDate: { $gt: 1 } },
                { recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, until: "someday", exceptions: [] } },
                { recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: ["nope"] } },
                { recurrenceRule: { freq: RecurrenceFrequency.DAILY, interval: 1, exceptions: "2099-01-01" } },
            ]) {
                expect((await authed("post", owner, "/calendar-events").send(eventBody(mailbox, folder, overrides))).status).toBe(400);
            }
            const created = await authed("post", owner, "/calendar-events").send(eventBody(mailbox, folder));
            expect(
                (await authed("put", owner, `/calendar-events/${created.body.uid}`).send({ uid: created.body.uid, version: created.body.version, startDate: "soon" }))
                    .status,
            ).toBe(400);
        });

        it("updates an event whose stored dates are still strings (a row written before dates were coerced)", async () => {
            if (ctx.store().backend !== "mongo") {
                return; // a SQL datetime column can't hold a string
            }
            const { mailbox, folder } = await setup();
            const created = await authed("post", owner, "/calendar-events").send(eventBody(mailbox, folder));
            await ctx.store().update("CalendarEvent", created.body.uid, { startDate: "2099-06-01T13:00:00.000Z", endDate: "2099-06-01T14:00:00.000Z" });

            const result = await authed("put", owner, `/calendar-events/${created.body.uid}`).send({
                uid: created.body.uid,
                version: created.body.version,
                startDate: "2099-06-01T13:00:00.000Z",
                endDate: "2099-06-01T18:00:00.000Z",
            });

            expect(result.status).toBe(200);
            // Only the end moved.
            expect(result.body.sequence).toBe(1);
        });
    });

    describe("matter dates", () => {
        const holder = newUser();

        beforeEach(async () => {
            await ctx.store().clear("Matter", "EscrowScope", "Mailbox", "AuditLogEntry");
        });

        it("stores ISO string date ranges as real dates, rejects unparseable ones, and searches a matter with legacy string dates", async () => {
            const scope = await ctx.store().save("EscrowScope", {
                name: "legal",
                publicKey: { publicKey: "cert", type: "x509", fingerprint: "fp", notBefore: 1, notAfter: 2 },
                holderUserUids: [holder.uid],
                requiredHolders: 1,
                notifySubjectOnAccess: false,
            });
            const body = {
                name: "Matter",
                escrowScopeId: scope.uid,
                custodianMailboxUids: [uuid.v4()],
                dateRangeStart: "2026-01-01T00:00:00.000Z",
                dateRangeEnd: "2026-06-01T00:00:00.000Z",
            };

            expect((await authed("post", holder, "/matters").send({ ...body, dateRangeStart: "whenever" })).status).toBe(400);
            const created = await authed("post", holder, "/matters").send(body);
            expect(created.status).toBe(200);
            let stored = (await ctx.store().find("Matter", { uid: created.body.uid }))[0];
            expect(stored.dateRangeStart).toBeInstanceOf(Date);

            const property = await authed("put", holder, `/matters/${created.body.uid}/dateRangeEnd`).send("2026-07-01T00:00:00.000Z");
            expect(property.status).toBe(200);
            stored = (await ctx.store().find("Matter", { uid: created.body.uid }))[0];
            expect(stored.dateRangeEnd).toBeInstanceOf(Date);
            expect(millis(stored.dateRangeEnd)).toBe(Date.parse("2026-07-01T00:00:00.000Z"));
            expect((await authed("put", holder, `/matters/${created.body.uid}/dateRangeEnd`).send("later")).status).toBe(400);

            if (ctx.store().backend === "mongo") {
                await ctx.store().update("Matter", created.body.uid, { dateRangeStart: "2026-01-01T00:00:00.000Z", dateRangeEnd: "2026-06-01T00:00:00.000Z" });
            }
            expect((await authed("get", holder, `/matter-search?matterId=${created.body.uid}&q=hello`)).status).toBe(200);
        });
    });

    describe("request lists", () => {
        const admin = newUser(["admin"]);
        const user = newUser();

        beforeEach(async () => {
            await ctx.store().clear("DataExportRequest", "DataSubjectErasureRequest", "MailboxImportRequest", "Mailbox");
        });

        /** Saves `count` rows an hour apart, oldest first, returning their uids in that order. */
        const saveStaggered = async (kind: string, count: number, data: (i: number) => any): Promise<string[]> => {
            const base = Date.now() - 100 * HOUR_MS;
            const uids: string[] = [];
            for (let i = 0; i < count; i++) {
                uids.push((await ctx.store().save(kind, { ...data(i), dateCreated: new Date(base + i * HOUR_MS) })).uid);
            }
            return uids;
        };
        const kinds: [string, string, (mailboxUid: string, requestedByUserUid: string) => any][] = [
            ["/data-export-requests", "DataExportRequest", (mailboxUid, requestedByUserUid) => ({ mailboxUid, requestedByUserUid, format: "json", status: "pending" })],
            ["/erasure-requests", "DataSubjectErasureRequest", (mailboxUid, requestedByUserUid) => ({ mailboxUid, requestedByUserUid, status: "pending" })],
            [
                "/mailbox-import-requests",
                "MailboxImportRequest",
                (mailboxUid, requestedByUserUid) => ({ mailboxUid, requestedByUserUid, targetFolderUid: uuid.v4(), format: "mbox", sourceBlobKey: "k", status: "pending" }),
            ],
        ];

        it("lists newest first with limit/page, and rejects bad paging (400)", async () => {
            for (const [path, kind, row] of kinds) {
                const uids = await saveStaggered(kind, 3, () => row(uuid.v4(), user.uid));

                expect((await authed("get", admin, path)).body.map((r: any) => r.uid)).toEqual([...uids].reverse());
                expect((await authed("get", admin, `${path}?limit=2`)).body.map((r: any) => r.uid)).toEqual([uids[2], uids[1]]);
                expect((await authed("get", admin, `${path}?limit=2&page=1`)).body.map((r: any) => r.uid)).toEqual([uids[0]]);
                expect((await authed("get", user, `${path}?limit=1`)).body.map((r: any) => r.uid)).toEqual([uids[2]]);
                for (const query of ["limit=0", "limit=ten", "page=-1", "limit=1&limit=2"]) {
                    expect((await authed("get", admin, `${path}?${query}`)).status).toBe(400);
                }
                // Larger limits are capped rather than refused.
                expect((await authed("get", admin, `${path}?limit=100000`)).status).toBe(200);
            }
        });

        it("pages a non-admin's own requests together with requests for mailboxes they own", async () => {
            const owned = await createMailbox(user.uid);
            for (const [path, kind, row] of kinds.filter(([, k]) => k !== "DataSubjectErasureRequest")) {
                const uids = await saveStaggered(kind, 4, (i) =>
                    i === 0 ? row(uuid.v4(), user.uid) : i === 1 ? row(owned.uid, admin.uid) : i === 2 ? row(uuid.v4(), admin.uid) : row(uuid.v4(), user.uid),
                );

                const visible = await authed("get", user, path);
                expect(visible.body.map((r: any) => r.uid)).toEqual([uids[3], uids[1], uids[0]]);
                expect((await authed("get", user, `${path}?limit=2&page=1`)).body.map((r: any) => r.uid)).toEqual([uids[0]]);
            }
        });
    });
}
