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
import { NoteSQL } from "../../../src/models/sql/NoteSQL.js";
import { FolderType } from "../../../src/models/types.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:NoteSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/notes";
    let mailboxRepo: Repository<MailboxSQL>;
    let folderRepo: Repository<FolderSQL>;
    let noteRepo: Repository<NoteSQL>;
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
            name: "Notes",
            type: FolderType.NOTES,
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

    const createNote = async function (mailboxUid: string, folderUid: string, data?: any): Promise<NoteSQL> {
        const obj: NoteSQL = new NoteSQL({
            mailboxUid,
            folderUid,
            title: "Shopping List",
            body: "Milk, eggs, bread",
            ...data,
        });
        return await noteRepo.save(obj);
        // Deliberately no ACL document created — Note has `recordACL: false`; permission is checked
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
            noteRepo = conn.getRepository(NoteSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await noteRepo.clear();
        await folderRepo.clear();
        await mailboxRepo.clear();
    });

    it("Requires an explicit folderUid query parameter to list notes.", async () => {
        const result = await request(server.getApplication())
            .get(baseUrl)
            .set("Authorization", "jwt " + ownerToken);
        expect(result.status).toBe(400);
    });

    it("Owner can list notes in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createNote(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.length).toBe(1);
        expect(result.body[0].title).toBe("Shopping List");
    });

    it("A different user cannot list notes in a folder they don't have access to (silently empty).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createNote(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual([]);
    });

    it("Owner can create a note in a folder they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + ownerToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                title: "New Note",
                body: "Some content",
            });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(result.body.title).toBe("New Note");

        // No per-record ACL should have been created for this note (recordACL: false).
        const acl = await aclRepo.findOne({ where: { uid: result.body.uid } });
        expect(acl).toBeNull();
    });

    it("A different user cannot create a note in a folder they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);

        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + otherUserToken)
            .send({
                mailboxUid: mailbox.uid,
                folderUid: folder.uid,
                title: "Intruder Note",
                body: "Some content",
            });

        expect(result.status).toBe(403);
    });

    it("Owner can read a note by id.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const note = await createNote(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${note.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.uid).toBe(note.uid);
    });

    it("A different user cannot read a note by id (404, not 403 — avoids existence leakage).", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const note = await createNote(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${note.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("A different user gets 404 (not 200/1) checking existence of a note they can't access.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const note = await createNote(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}/${note.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(404);
    });

    it("Owner can update a note they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const note = await createNote(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${note.uid}`)
            .set("Authorization", "jwt " + ownerToken)
            .send({ uid: note.uid, version: note.version, title: "Renamed" });

        expect(result.status).toBe(200);
        expect(result.body.title).toBe("Renamed");
    });

    it("A different user cannot update a note they don't have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const note = await createNote(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .put(`${baseUrl}/${note.uid}`)
            .set("Authorization", "jwt " + otherUserToken)
            .send({ uid: note.uid, version: note.version, title: "Hijacked" });

        expect(result.status).toBe(403);
    });

    it("Owner can delete a note they have access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        const note = await createNote(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .delete(`${baseUrl}/${note.uid}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);

        const existing = await noteRepo.findOne({ where: { uid: note.uid } });
        expect(existing).toBeNull();
    });

    it("Can make a count request scoped to a folder the caller has access to.", async () => {
        const mailbox = await createMailbox(owner.uid);
        const folder = await createFolder(mailbox.uid);
        await createNote(mailbox.uid, folder.uid);
        await createNote(mailbox.uid, folder.uid);

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
        await createNote(mailbox.uid, folder.uid);

        const result = await request(server.getApplication())
            .head(`${baseUrl}?folderUid=${folder.uid}`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(200);
        expect(result.headers["content-length"]).toBe("0");
    });
});
