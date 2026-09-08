///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, ACLAction, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { BookingTypeSQL } from "../../../src/models/sql/BookingTypeSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:BookingTypeSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/booking-types";
    let mailboxRepo: Repository<MailboxSQL>;
    let bookingTypeRepo: Repository<BookingTypeSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    const createMailbox = async function (ownerUid: string): Promise<MailboxSQL> {
        const obj: MailboxSQL = new MailboxSQL({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxSQL = await mailboxRepo.save(obj);
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [{ userOrRoleId: ownerUid, actions: [ACLAction.FULL] }],
            parentUid: "Mailbox",
        });
        return result;
    };

    /** A valid create body - every test varies one field of it. */
    const body = (mailboxUid: string, overrides?: any) => ({
        mailboxUid,
        calendarFolderUid: uuid.v4(),
        slug: `intro-${uuid.v4()}`,
        name: "Intro Call",
        hostDisplayName: "Ada Lovelace",
        durationMinutes: 30,
        timezone: "America/New_York",
        availability: [{ dayOfWeek: 1, startMinute: 540, endMinute: 660 }],
        dateOverrides: [],
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minimumNoticeMinutes: 0,
        bookingWindowDays: 30,
        requiresApproval: false,
        enabled: true,
        ...overrides,
    });

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (isSqlDataSource(conn)) {
            aclRepo = conn.getRepository(AccessControlListSQL);
        } else {
            throw new Error("Could not find sql acl connection");
        }
        conn = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            bookingTypeRepo = conn.getRepository(BookingTypeSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await bookingTypeRepo.clear();
        await mailboxRepo.clear();
    });

    it("Owner can create a booking type, with the slug normalized.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(body(mailbox.uid, { slug: "  30 Minute // Intro Call!  " }));

        expect(result.status).toBe(200);
        expect(result.body.slug).toBe("30-minute-intro-call");
    });

    it("A user with no access to the mailbox cannot create a booking type (403).", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send(body(mailbox.uid));

        expect(result.status).toBe(403);
    });

    it("Rejects a slug that normalizes to nothing (400).", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(body(mailbox.uid, { slug: "!!!" }));

        expect(result.status).toBe(400);
    });

    it("Rejects a slug already in use by another booking type (409).", async () => {
        const mailbox = await createMailbox(owner.uid);
        await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(body(mailbox.uid, { slug: "taken" }));

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(body(mailbox.uid, { slug: "Taken" }));

        expect(result.status).toBe(409);
    });

    it("Rejects two identical slugs within a single bulk create (409).", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send([body(mailbox.uid, { slug: "dupe" }), body(mailbox.uid, { slug: "dupe" })]);

        expect(result.status).toBe(409);
    });

    it("Accepts a bulk create of distinct booking types.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send([body(mailbox.uid, { slug: "first" }), body(mailbox.uid, { slug: "second" })]);

        expect(result.status).toBe(200);
        expect(result.body.map((row: any) => row.slug).sort()).toEqual(["first", "second"]);
    });

    it("Rejects an unrecognized timezone (400).", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(body(mailbox.uid, { timezone: "Mars/Olympus_Mons" }));

        expect(result.status).toBe(400);
    });

    it("Rejects an availability window that ends before it starts (400).", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(body(mailbox.uid, { availability: [{ dayOfWeek: 1, startMinute: 660, endMinute: 540 }] }));

        expect(result.status).toBe(400);
    });

    it("Owner can list their booking types.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send(body(mailbox.uid));

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body).toHaveLength(1);
    });

    describe("update()", () => {
        it("Owner can rename the slug, which is normalized on the way in.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send(body(mailbox.uid, { slug: "before" }));

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: created.body.uid, version: created.body.version, slug: "After Rename" });

            expect(result.status).toBe(200);
            expect(result.body.slug).toBe("after-rename");
        });

        it("A booking type keeping its own slug does not collide with itself.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send(body(mailbox.uid, { slug: "stable" }));

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: created.body.uid, version: created.body.version, slug: "stable", name: "Renamed" });

            expect(result.status).toBe(200);
            expect(result.body.name).toBe("Renamed");
        });

        it("Rejects renaming onto a slug another booking type already holds (409).", async () => {
            const mailbox = await createMailbox(owner.uid);
            await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send(body(mailbox.uid, { slug: "occupied" }));
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send(body(mailbox.uid, { slug: "mine" }));

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: created.body.uid, version: created.body.version, slug: "occupied" });

            expect(result.status).toBe(409);
        });

        it("A patch that does not mention the slug leaves it alone.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send(body(mailbox.uid, { slug: "untouched" }));

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: created.body.uid, version: created.body.version, enabled: false });

            expect(result.status).toBe(200);
            expect(result.body.slug).toBe("untouched");
            expect(result.body.enabled).toBe(false);
        });

        it("Rejects an update carrying an invalid availability window (400).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send(body(mailbox.uid));

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({
                    uid: created.body.uid,
                    version: created.body.version,
                    availability: [{ dayOfWeek: 9, startMinute: 540, endMinute: 660 }],
                });

            expect(result.status).toBe(400);
        });

        it("A user with no access to the mailbox cannot update a booking type (403).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send(body(mailbox.uid));

            const result = await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + otherUserToken)
                .send({ uid: created.body.uid, version: created.body.version, name: "Hijacked" });

            expect(result.status).toBe(403);
        });
    });
});
