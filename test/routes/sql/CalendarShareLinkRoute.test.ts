///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import {
    ACLRecord,
    ACLUtils,
    Server,
    ObjectFactory,
    ConnectionManager,
    ACLAction,
    AccessControlListSQL,
    isSqlDataSource,
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { CalendarShareLinkSQL } from "../../../src/models/sql/CalendarShareLinkSQL.js";
import { FolderType } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:CalendarShareLinkSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/calendar-share-links";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let shareLinkRepo: Repository<CalendarShareLinkSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

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

    const createFolder = async function (mailboxUid: string, data?: any): Promise<FolderSQL> {
        const obj: FolderSQL = new FolderSQL({
            mailboxUid,
            name: "Calendar",
            type: FolderType.CALENDAR,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
            ...data,
        });
        const result: FolderSQL = await folderRepo.save(obj);
        // No explicit records — inherits from the mailbox's ACL via parentUid, same as
        // `BaseFolderRoute.create()`'s own seeding.
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [],
            parentUid: mailboxUid,
        });
        return result;
    };

    const createShareLink = async function (
        folderUid: string,
        createdByUserUid: string,
        data?: any,
    ): Promise<CalendarShareLinkSQL> {
        const obj: CalendarShareLinkSQL = new CalendarShareLinkSQL({
            token: uuid.v4(),
            folderUid,
            permittedActions: ["read"],
            createdByUserUid,
            ...data,
        });
        return await shareLinkRepo.save(obj);
        // Deliberately no ACL document created — CalendarShareLink has `recordACL: false`; permission is
        // checked against the containing folder's ACL instead.
    };

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
            folderRepo = conn.getRepository(FolderSQL);
            shareLinkRepo = conn.getRepository(CalendarShareLinkSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await shareLinkRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
    });

    it("Requires an explicit folderUid query parameter to list calendar share links.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list calendar share links in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createShareLink(folder.uid, owner.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].permittedActions).toEqual(["read"]);
    });

    it("A different user cannot list calendar share links in a folder they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createShareLink(folder.uid, owner.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a calendar share link in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                token: uuid.v4(),
                folderUid: folder.uid,
                permittedActions: ["read"],
                createdByUserUid: owner.uid,
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.permittedActions).toEqual(["read"]);

        // No per-record ACL should have been created for this share link (recordACL: false).
        const acl = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl).toBeNull();
    });

    it("A different user cannot create a calendar share link in a folder they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                token: uuid.v4(),
                folderUid: folder.uid,
                permittedActions: ["read"],
                createdByUserUid: otherUser.uid,
            });

        expect(result.status).toBe(403);
    });

    it("Owner can read a calendar share link by id.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const shareLink = await createShareLink(folder.uid, owner.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${shareLink.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(shareLink.uid);
    });

    it("A different user cannot read a calendar share link by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const shareLink = await createShareLink(folder.uid, owner.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${shareLink.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("A different user gets 404 (not 200/1) checking existence of a calendar share link they can't access.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const shareLink = await createShareLink(folder.uid, owner.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}/${shareLink.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a calendar share link they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const shareLink = await createShareLink(folder.uid, owner.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${shareLink.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: shareLink.uid, version: shareLink.version, permittedActions: ["read", "freebusy"] });

        expect(result.status).toBe(200);
        expect(result.body.permittedActions).toEqual(["read", "freebusy"]);
    });

    it("A different user cannot update a calendar share link they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const shareLink = await createShareLink(folder.uid, owner.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${shareLink.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: shareLink.uid, version: shareLink.version, permittedActions: ["freebusy"] });

        expect(result.status).toBe(403);
    });

    it("Owner can delete a calendar share link they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const shareLink = await createShareLink(folder.uid, owner.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${shareLink.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const existing = await shareLinkRepo.findOne({ where: { uid: shareLink.uid } });
        expect(existing).toBeNull();
    });

    it("Can make a count request scoped to a folder the caller has access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createShareLink(folder.uid, owner.uid);
        await createShareLink(folder.uid, owner.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A different user's count request for a folder they can't access returns 0.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createShareLink(folder.uid, owner.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("0");
    });

    // See the identical describe block in test/routes/mongo/CalendarShareLinkRoute.test.ts for the full
    // rationale behind each of these - this verifies the same ACL-sync bookkeeping on the SQL-backed variant.
    describe("ACL synchronization", () => {
        it("Creating a share link grants an ACLRecord for its token on the shared folder.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ folderUid: folder.uid, permittedActions: ["read", "freebusy"], createdByUserUid: owner.uid });
            expect(result.status).toBeLessThan(300);

            const acl = await aclRepo.findOne({ where: { uid: folder.uid } });
            const record = acl!.records.find((r: ACLRecord) => r.userOrRoleId === result.body.token);
            expect(record).toBeDefined();
            expect(record!.actions).toEqual(["read", "freebusy"]);
        });

        it("Deleting a share link revokes the ACLRecord for its token from the shared folder.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ folderUid: folder.uid, permittedActions: ["read"], createdByUserUid: owner.uid });

            await request(server.getApplication())
                .delete(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + ownerToken);

            const acl = await aclRepo.findOne({ where: { uid: folder.uid } });
            expect(acl!.records.find((r: ACLRecord) => r.userOrRoleId === created.body.token)).toBeUndefined();
        });

        it("Updating a share link's folderUid revokes the ACLRecord from the old folder and grants it on the new one.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder1 = await createFolder(mailbox.uid);
            const folder2 = await createFolder(mailbox.uid);
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ folderUid: folder1.uid, permittedActions: ["read"], createdByUserUid: owner.uid });

            const updated = await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: created.body.uid, version: created.body.version, folderUid: folder2.uid });
            expect(updated.status).toBe(200);

            const acl1 = await aclRepo.findOne({ where: { uid: folder1.uid } });
            const acl2 = await aclRepo.findOne({ where: { uid: folder2.uid } });
            expect(acl1!.records.find((r: ACLRecord) => r.userOrRoleId === created.body.token)).toBeUndefined();
            expect(acl2!.records.find((r: ACLRecord) => r.userOrRoleId === created.body.token)).toBeDefined();
        });

        it("Updating a share link's permittedActions re-grants (upserts) the ACLRecord to match.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ folderUid: folder.uid, permittedActions: ["read"], createdByUserUid: owner.uid });

            await request(server.getApplication())
                .put(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: created.body.uid, version: created.body.version, permittedActions: ["read", "freebusy"] });

            const acl = await aclRepo.findOne({ where: { uid: folder.uid } });
            const record = acl!.records.find((r: ACLRecord) => r.userOrRoleId === created.body.token);
            expect(record!.actions).toEqual(["read", "freebusy"]);
        });

        it("Creating a share link still succeeds (fails open) even if the target folder's ACL document is missing.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            // Simulates a corrupt/missing folder ACL document - a trusted (`admin`) role is required to still
            // pass the underlying `requirePermission()` check without a real ACL record to match against.
            await aclRepo.delete({ uid: folder.uid });

            const result = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + adminToken)
                .send({ folderUid: folder.uid, permittedActions: ["read"], createdByUserUid: admin.uid });

            expect(result.status).toBeLessThan(300);
            const acl = await aclRepo.findOne({ where: { uid: folder.uid } });
            expect(acl).toBeNull();
        });

        it("Deleting a share link still succeeds (fails open) even if the target folder's ACL document is already missing.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const created = await request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ folderUid: folder.uid, permittedActions: ["read"], createdByUserUid: owner.uid });
            // Simulates the folder's ACL document disappearing (e.g. the folder was purged) between the share
            // link's creation and its deletion - a trusted (`admin`) role is required to still pass the
            // underlying `requirePermission()` check without a real ACL record to match against. Goes through
            // `ACLUtils.removeACL()` (rather than deleting the row directly) so its cache entry - populated by
            // the `findACL()` call the creation above already made - is invalidated too; a raw row delete would
            // leave that stale cached copy readable by the very `findACL()` call this test means to make miss.
            const aclUtils: ACLUtils = objectFactory.getInstance(ACLUtils)!;
            await aclUtils.removeACL(folder.uid);

            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${created.body.uid}`)
                .set("Authorization", "jwt " + adminToken);

            expect(result.status).toBeGreaterThanOrEqual(200);
            expect(result.status).toBeLessThan(300);
        });
    });
});
