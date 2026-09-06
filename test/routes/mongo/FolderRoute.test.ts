///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import {
    ACLRecord,
    MongoConnection,
    MongoRepository,
    Server,
    ObjectFactory,
    ConnectionManager,
    ACLAction,
    NotificationUtils,
} from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { FolderType } from "../../../src/models/types.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:FolderMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/folders";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let folderRepo: MongoRepository<FolderMongo>;
    let aclRepo: MongoRepository<any>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    /** Creates a Mailbox directly (bypassing HTTP) and seeds its ACL, mirroring what `RepoUtils.create()` does. */
    const createMailbox = async function (ownerUid: string): Promise<MailboxMongo> {
        const obj: MailboxMongo = new MailboxMongo({
            ownerUserUid: ownerUid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxMongo = await mailboxRepo.save(obj);
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
    const createFolder = async function (mailboxUid: string, data?: any): Promise<FolderMongo> {
        const obj: FolderMongo = new FolderMongo({
            mailboxUid,
            name: "Test Folder",
            type: FolderType.USER,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
            ...data,
        });
        const result: FolderMongo = await folderRepo.save(obj);
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
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (conn instanceof MongoConnection) {
            aclRepo = conn.getMongoRepository("AccessControlListMongo");
        }
        conn = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            folderRepo = conn.getMongoRepository("FolderMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, folderRepo]) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
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

    it("Requires an explicit mailboxUid query parameter to count folders.", async () => {
        const result = await request(server.getApplication())
            .head(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can make a count request scoped to their own mailbox.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createFolder(mailbox.uid, { name: "Inbox" });
        await createFolder(mailbox.uid, { name: "Archive" });

        const result = await request(server.getApplication())
            .head(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.headers["content-length"]).toBe("2");
    });

    it("A different user's count request for a mailbox they don't own returns 0.", async () => {
        const mailbox = await createMailbox(owner.uid);
        await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?mailboxUid=${mailbox.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("0");
    });

    it("Owner can create multiple folders in their own mailbox in a single bulk (array-body) request.", async () => {
        const mailbox = await createMailbox(owner.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send([
                {
                    mailboxUid: mailbox.uid,
                    name: "Bulk One",
                    type: FolderType.USER,
                    unreadCount: 0,
                    totalCount: 0,
                    syncKeyVersion: 0,
                },
                {
                    mailboxUid: mailbox.uid,
                    name: "Bulk Two",
                    type: FolderType.USER,
                    unreadCount: 0,
                    totalCount: 0,
                    syncKeyVersion: 0,
                },
            ]);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(Array.isArray(result.body)).toBe(true);
        expect(result.body.length).toBe(2);
        expect(result.body.map((f: any) => f.name).sort()).toEqual(["Bulk One", "Bulk Two"]);
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

        const acl = await aclRepo.findOne({ uid: result.body.uid } as any);
        expect(acl?.parentUid).toBe(mailbox.uid);
    });

    it("Publishes a live-update notification to the owning mailbox's channel on create.", async () => {
        const sendMessageSpy = vi.spyOn(NotificationUtils.prototype, "sendMessage");
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

        expect(sendMessageSpy).toHaveBeenCalledWith(
            mailbox.uid,
            "FolderMongo",
            "create",
            expect.objectContaining({ uid: result.body.uid }),
        );
        sendMessageSpy.mockRestore();
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

    it("Owner sees a folder they own exists (200, content-length 1).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}/${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("1");
    });

    it("Checking existence of a nonexistent folder returns 404.", async () => {
        const result = await request(server.getApplication())
            .head(`${baseUrl}/${uuid.v4()}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
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

        // `Folder` extends `RecoverableBaseEntity` (soft delete) so EAS `FolderSync` can later report the
        // removal to an already-synced device - the row stays present with `deleted: true` rather than being
        // physically removed. See the identical note on `CalendarEventRoute.test.ts`.
        const existing = await folderRepo.findOne({ uid: folder.uid } as any);
        expect(existing?.deleted).toBe(true);
    });

    // `exists()` checks permission against the folder's OWN resolved ACL (unlike `find`/`count`, which check
    // the owning mailbox's) - so it's the one operation here a `CalendarShareLink`-style token grant (an
    // `ACLRecord` added directly to the folder's own ACL, same shape `BaseCalendarShareLinkRoute` produces)
    // actually satisfies. Granting the record directly here (rather than via the full share-link route) keeps
    // this focused on `BaseFolderRoute`'s own `?shareToken=` resolution, already covered end-to-end together
    // with `BaseCalendarShareLinkRoute` in `CalendarEventRoute.test.ts`'s "Anonymous access" tests.
    describe("Anonymous access via a share token", () => {
        it("An anonymous caller with a token granted `exists` on the folder's own ACL can confirm it exists.", async () => {
            const mailbox = await createMailbox(owner.uid);
            const folder = await createFolder(mailbox.uid);
            const token = uuid.v4();
            const acl = await aclRepo.findOne({ uid: folder.uid } as any);
            acl.records = [{ userOrRoleId: token, actions: [ACLAction.EXISTS] }];
            await aclRepo.save(acl);

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
            const acl = await aclRepo.findOne({ uid: folder.uid } as any);
            acl.records = [{ userOrRoleId: token, actions: [ACLAction.FULL] }];
            await aclRepo.save(acl);

            const result = await request(server.getApplication()).get(
                `${baseUrl}?mailboxUid=${mailbox.uid}&shareToken=${token}`,
            );

            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });
    });
});
