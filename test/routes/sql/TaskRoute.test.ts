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
import { TaskSQL } from "../../../src/models/sql/TaskSQL.js";
import { FolderType, TaskPriority } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { openSealedField, testZeroAccessKey } from "../../zeroAccessTestKeys.js";

describe("Route:TaskSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/tasks";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let taskRepo: Repository<TaskSQL>;
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

    const createFolder = async function (mailboxUid: string, data?: any): Promise<FolderSQL> {
        const obj: FolderSQL = new FolderSQL({
            mailboxUid,
            name: "Tasks",
            type: FolderType.TASKS,
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

    const createTask = async function (mailboxUid: string, folderUid: string, data?: any): Promise<TaskSQL> {
        const obj: TaskSQL = new TaskSQL({
            mailboxUid,
            folderUid,
            title: "Buy groceries",
            completed: false,
            priority: TaskPriority.NORMAL,
            ...data,
        });
        return await taskRepo.save(obj);
        // Deliberately no ACL document created — Task has `recordACL: false`; permission is checked
        // against the containing folder's ACL instead.
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
            taskRepo = conn.getRepository(TaskSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await taskRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
    });

    it("Requires an explicit folderUid query parameter to list tasks.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list tasks in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createTask(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].title).toBe("Buy groceries");
    });

    it("A different user cannot list tasks in a folder they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createTask(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a task in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                title: "New Task",
                completed: false,
                priority: TaskPriority.NORMAL,
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.title).toBe("New Task");

        // No per-record ACL should have been created for this task (recordACL: false).
        const acl = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl).toBeNull();
    });

    it("Rejects creating a task with an explicit empty title (400) - proves model validation actually runs on create().", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({ mailboxUid: mailbox.uid, folderUid: folder.uid, title: "", completed: false, priority: TaskPriority.NORMAL });

        expect(result.status).toBe(400);
    });

    it("A different user cannot create a task in a folder they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                title: "Intruder Task",
                completed: false,
                priority: TaskPriority.NORMAL,
            });

        expect(result.status).toBe(403);
    });

    it("Owner can read a task by id.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const task = await createTask(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${task.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(task.uid);
    });

    it("A different user cannot read a task by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const task = await createTask(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${task.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("A different user gets 404 (not 200/1) checking existence of a task they can't access.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const task = await createTask(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}/${task.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a task they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const task = await createTask(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${task.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: task.uid, version: task.version, title: "Renamed" });

        expect(result.status).toBe(200);
        expect(result.body.title).toBe("Renamed");
    });

    it("A different user cannot update a task they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const task = await createTask(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${task.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: task.uid, version: task.version, title: "Hijacked" });

        expect(result.status).toBe(403);
    });

    // `ErasureExecutionJob` purges `Task` by `mailboxUid` directly - see
    // `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment for why an independently
    // client-writable `mailboxUid` would let a task silently escape a GDPR erasure scoped to a mailbox it
    // was never really in.
    it("Silently corrects a client-supplied mailboxUid on update() to the task's real folder's mailbox, rather than trusting it.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const task = await createTask(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${task.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: task.uid, version: task.version, mailboxUid: "attacker-supplied-uid" });

        expect(result.status).toBe(200);
        expect(result.body.mailboxUid).toBe(mailbox.uid);
        const persisted = await taskRepo.findOne({ where: { uid: task.uid } });
        expect(persisted!.mailboxUid).toBe(mailbox.uid);
    });

    it("Owner can delete a task they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const task = await createTask(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${task.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        // See the identical note in test/routes/mongo/TaskRoute.test.ts - `Task` is now a
        // `RecoverableBaseEntity` (soft delete), so the raw row stays present with `deleted: true`.
        const existing = await taskRepo.findOne({ where: { uid: task.uid } });
        expect(existing?.deleted).toBe(true);
    });

    it("Can make a count request scoped to a folder the caller has access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createTask(mailbox.uid, folder.uid);
        await createTask(mailbox.uid, folder.uid);

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
        await createTask(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("0");
    });

    describe("zero-access encryption of tasks", () => {
        const protect = async (types: any) => {
            const mailbox: any = await createMailbox(owner.uid);
            const za = await testZeroAccessKey();
            mailbox.zeroAccessKeys = [za.key];
            mailbox.zeroAccessTypes = types;
            await mailboxRepo.save(mailbox);
            const folder = await createFolder(mailbox.uid);
            return { mailbox, folder, za };
        };
        const create = (mailbox: any, folder: any, fields: any) =>
            request(server.getApplication())
                .post(baseUrl)
                .set("Authorization", "jwt " + ownerToken)
                .send({ mailboxUid: mailbox.uid, folderUid: folder.uid, completed: false, priority: TaskPriority.NORMAL, ...fields });
        const stored = async (uid: string): Promise<any> => await taskRepo.findOne({ where: { uid } });

        it("Seals a protected task's title and notes on create, storing a placeholder, and nothing readable", async () => {
            const { mailbox, folder, za } = await protect({ tasks: true });

            const result = await create(mailbox, folder, { title: "CANARY-TITLE pay the lawyer", body: "CANARY-BODY retainer", sealedFields: { title: "forged" } });

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body.title).toBe("Protected task");
            const row = await stored(result.body.uid);
            expect(row.title).toBe("Protected task");
            expect(row.body ?? null).toBeNull();
            expect(await openSealedField(row.sealedFields.title, za)).toBe("CANARY-TITLE pay the lawyer");
            expect(await openSealedField(row.sealedFields.body, za)).toBe("CANARY-BODY retainer");
            expect(JSON.stringify(await taskRepo.find())).not.toContain("CANARY");
        });

        it("Replaces only what an update sends, ignores the placeholder sent back, and stores readable when tasks aren't protected", async () => {
            const { mailbox, folder, za } = await protect({ tasks: true });
            const created = (await create(mailbox, folder, { title: "Secret", body: "Notes" })).body;

            const done = await request(server.getApplication())
                .put(`${baseUrl}/${created.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ uid: created.uid, version: created.version, title: "Protected task", completed: true });
            expect(done.status, JSON.stringify(done.body)).toBe(200);
            const row = await stored(created.uid);
            expect(row.completed).toBe(true);
            expect(await openSealedField(row.sealedFields.title, za)).toBe("Secret");
            expect(await openSealedField(row.sealedFields.body, za)).toBe("Notes");

            const plain = await protect({ tasks: false });
            const readable = (await create(plain.mailbox, plain.folder, { title: "Readable", body: "Plain" })).body;
            expect(readable.title).toBe("Readable");
            expect((await stored(readable.uid)).sealedFields ?? null).toBeNull();
        });

        it("Refuses filtering or sorting tasks by title or notes", async () => {
            const { folder } = await protect({ tasks: true });
            for (const query of [`title=Secret`, `body=x`, `sort=${encodeURIComponent(JSON.stringify({ title: "ASC" }))}`]) {
                const result = await request(server.getApplication())
                    .get(`${baseUrl}?folderUid=${folder.uid}&${query}`)
                    .set("Authorization", "jwt " + ownerToken);
                expect(result.status, query).toBe(400);
            }
        });
    });
});
