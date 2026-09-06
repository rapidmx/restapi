///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import {
    ACLRecord,
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
import { FolderType } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:FolderSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/folders";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let aclRepo: Repository<AccessControlListSQL>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    /** Creates a Mailbox directly (bypassing HTTP) and seeds its ACL, mirroring what `RepoUtils.create()` does. */
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
        const records: ACLRecord[] = [
            { userOrRoleId: ownerUid, actions: [ACLAction.FULL] },
        ];
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records,
            parentUid: "Mailbox",
        });
        return result;
    };

    /** Creates a Folder directly (bypassing HTTP) with its ACL parented to the given mailbox, matching
     * `BaseFolderRoute.create()`'s own seeding. */
    const createFolder = async function (mailboxUid: string, data?: any): Promise<FolderSQL> {
        const obj: FolderSQL = new FolderSQL({
            mailboxUid,
            name: "Test Folder",
            type: FolderType.USER,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
            ...data,
        });
        const result: FolderSQL = await folderRepo.save(obj);
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
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await folderRepo.clear();
        await mailboxRepo.clear();
    });

    it("Requires an explicit mailboxUid query parameter to list folders.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list folders in their own mailbox.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createFolder(mailbox.uid, { name: "Inbox" });

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].name).toBe("Inbox");
    });

    it("A different user cannot list folders in a mailbox they don't own (silently empty, not an error).", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a folder in their own mailbox, and it inherits the mailbox's ACL.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "Archive",
                type: FolderType.USER,
                unreadCount: 0,
                totalCount: 0,
                syncKeyVersion: 0,
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.name).toBe("Archive");

        const acl = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl?.parentUid).toBe(mailbox.uid);
    });

    it("A different user cannot create a folder in a mailbox they don't own.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                name: "Intrusion",
                type: FolderType.USER,
                unreadCount: 0,
                totalCount: 0,
                syncKeyVersion: 0,
            });

        expect(result.status).toBe(403);
    });

    it("Owner can read a folder by id (inherited via the mailbox's ACL).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(folder.uid);
    });

    it("A different user cannot read a folder by id in a mailbox they don't own.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(403);
    });

    it("A different user cannot check existence of a folder in a mailbox they don't own (404, not 403).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}/${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a folder they own.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: folder.uid, version: folder.version, name: "Renamed" });

        expect(result.status).toBe(200);
        expect(result.body.name).toBe("Renamed");
    });

    it("Owner can delete a folder they own.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        // See the identical note in test/routes/mongo/FolderRoute.test.ts - `Folder` is now a
        // `RecoverableBaseEntity` (soft delete), so the raw row stays present with `deleted: true`.
        const existing = await folderRepo.findOne({ where: { uid: folder.uid } });
        expect(existing?.deleted).toBe(true);
    });

    // See the identical describe block in test/routes/mongo/FolderRoute.test.ts for the full rationale - this
    // verifies the same `?shareToken=` resolution on the SQL-backed variant.
    describe("Anonymous access via a share token", () => {
        it("An anonymous caller with a token granted `exists` on the folder's own ACL can confirm it exists.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const token = uuid.v4();
            const acl = await aclRepo.findOne({ where: { uid: folder.uid } });
            acl!.records = [{ userOrRoleId: token, actions: [ACLAction.EXISTS] }];
            await aclRepo.save(acl!);

            const result = await request(server.getApplication()).head(`${baseUrl}/${folder.uid}?shareToken=${token}`);

            expect(result.status).toBe(200);
            expect(result.headers["content-length"]).toBe("1");
        });

        it("An anonymous caller with an unknown share token cannot confirm the folder exists (404).", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);

            const result = await request(server.getApplication()).head(
                `${baseUrl}/${folder.uid}?shareToken=not-a-real-token`,
            );

            expect(result.status).toBe(404);
        });

        it("A folder-scoped share token does not grant list/count access to the owning mailbox's folders.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const token = uuid.v4();
            const acl = await aclRepo.findOne({ where: { uid: folder.uid } });
            acl!.records = [{ userOrRoleId: token, actions: [ACLAction.FULL] }];
            await aclRepo.save(acl!);

            const result = await request(server.getApplication()).get(
                `${baseUrl}?mailboxUid=${mailbox.uid}&shareToken=${token}`,
            );

            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });
    });
});
