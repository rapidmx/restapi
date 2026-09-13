///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { ACLRecord, MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager, ACLAction } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:MailboxAccessMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/mailboxes";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let aclRepo: MongoRepository<any>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);
    const strangerUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const strangerToken = JWTUtils.createTokenSync(config.get("auth"), strangerUser);

    const createMailbox = async function (overrides: Partial<MailboxMongo> = {}): Promise<MailboxMongo> {
        const obj = new MailboxMongo({
            ownerUserUid: owner.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            ...overrides,
        });
        const result: MailboxMongo = await mailboxRepo.save(obj);
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [{ userOrRoleId: owner.uid, actions: [ACLAction.FULL] }] as ACLRecord[],
            parentUid: "Mailbox",
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
        for (const r of [mailboxRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        try {
            await aclRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
    });

    describe("listMembers", () => {
        it("Returns an empty list for a mailbox with no delegates yet.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/access`)
                .set("Authorization", "jwt " + ownerToken);
            expect(result.status).toBe(200);
            expect(result.body).toEqual([]);
        });

        it("Excludes the owner's own implicit grant and includes a real delegate, mapped to its role.", async () => {
            const mailbox = await createMailbox();
            await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/access/${otherUser.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ role: "viewer" });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/access`)
                .set("Authorization", "jwt " + ownerToken);
            expect(result.status).toBe(200);
            expect(result.body).toEqual([{ userOrRoleId: otherUser.uid, role: "viewer" }]);
        });

        it("403s for a caller with no access to the mailbox at all.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/access`)
                .set("Authorization", "jwt " + strangerToken);
            expect(result.status).toBe(403);
        });

        it("403s for a 'viewer'-role delegate (granted 'update' is required, not just read/list).", async () => {
            const mailbox = await createMailbox();
            await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/access/${otherUser.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ role: "viewer" });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/access`)
                .set("Authorization", "jwt " + otherUserToken);
            expect(result.status).toBe(403);
        });
    });

    describe("setMember", () => {
        it("Grants a new delegate 'manager' access, sufficient to manage further membership itself.", async () => {
            const mailbox = await createMailbox();
            const grant = await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/access/${otherUser.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ role: "manager" });
            expect(grant.status).toBe(200);
            expect(grant.body).toEqual({ userOrRoleId: otherUser.uid, role: "manager" });

            // The new manager can now themselves grant access to a third party.
            const secondGrant = await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/access/${strangerUser.uid}`)
                .set("Authorization", "jwt " + otherUserToken)
                .send({ role: "viewer" });
            expect(secondGrant.status).toBe(200);
        });

        it("Upserts - setting a role for an already-existing member replaces, not duplicates, their record.", async () => {
            const mailbox = await createMailbox();
            await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/access/${otherUser.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ role: "viewer" });
            await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/access/${otherUser.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ role: "manager" });

            const result = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/access`)
                .set("Authorization", "jwt " + ownerToken);
            expect(result.body).toEqual([{ userOrRoleId: otherUser.uid, role: "manager" }]);
        });

        it("Rejects targeting the mailbox owner's own record.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/access/${owner.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ role: "viewer" });
            expect(result.status).toBe(400);
        });

        it("Rejects an unrecognized role.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/access/${otherUser.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ role: "superuser" });
            expect(result.status).toBe(400);
        });

        it("403s for a caller with no 'update' permission on the mailbox.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/access/${otherUser.uid}`)
                .set("Authorization", "jwt " + strangerToken)
                .send({ role: "viewer" });
            expect(result.status).toBe(403);
        });
    });

    describe("removeMember", () => {
        it("Revokes an existing delegate's access.", async () => {
            const mailbox = await createMailbox();
            await request(server.getApplication())
                .put(`${baseUrl}/${mailbox.uid}/access/${otherUser.uid}`)
                .set("Authorization", "jwt " + ownerToken)
                .send({ role: "viewer" });

            const remove = await request(server.getApplication())
                .delete(`${baseUrl}/${mailbox.uid}/access/${otherUser.uid}`)
                .set("Authorization", "jwt " + ownerToken);
            expect(remove.status).toBe(204);

            const list = await request(server.getApplication())
                .get(`${baseUrl}/${mailbox.uid}/access`)
                .set("Authorization", "jwt " + ownerToken);
            expect(list.body).toEqual([]);
        });

        it("Is idempotent - removing a uid that was never a member still succeeds.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${mailbox.uid}/access/${otherUser.uid}`)
                .set("Authorization", "jwt " + ownerToken);
            expect(result.status).toBe(204);
        });

        it("Rejects targeting the mailbox owner's own record.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .delete(`${baseUrl}/${mailbox.uid}/access/${owner.uid}`)
                .set("Authorization", "jwt " + ownerToken);
            expect(result.status).toBe(400);
        });
    });

    describe("lookupOwnerByEmail", () => {
        it("Resolves a mailbox's primarySmtpAddress to its owner.", async () => {
            const mailbox = await createMailbox();
            const result = await request(server.getApplication())
                .get(`${baseUrl}/lookup-by-email?email=${encodeURIComponent(mailbox.primarySmtpAddress.toUpperCase())}`)
                .set("Authorization", "jwt " + strangerToken);
            expect(result.status).toBe(200);
            expect(result.body).toEqual({ userUid: owner.uid, displayName: "Test Mailbox" });
        });

        it("Resolves a mailbox's alias address to its owner.", async () => {
            const alias = `alias-${uuid.v4()}@example.com`;
            const mailbox = await createMailbox({ aliasAddresses: [alias] });
            const result = await request(server.getApplication())
                .get(`${baseUrl}/lookup-by-email?email=${encodeURIComponent(alias)}`)
                .set("Authorization", "jwt " + strangerToken);
            expect(result.status).toBe(200);
            expect(result.body).toEqual({ userUid: mailbox.ownerUserUid, displayName: "Test Mailbox" });
        });

        it("Returns null for an address with no matching mailbox.", async () => {
            const result = await request(server.getApplication())
                .get(`${baseUrl}/lookup-by-email?email=${encodeURIComponent("nobody@example.com")}`)
                .set("Authorization", "jwt " + strangerToken);
            expect(result.status).toBe(200);
            expect(result.body).toBeNull();
        });

        it("Returns null for a shared (ownerless) mailbox's own address - it never resolves to 'a person'.", async () => {
            const mailbox = await createMailbox({ ownerUserUid: undefined });
            const result = await request(server.getApplication())
                .get(`${baseUrl}/lookup-by-email?email=${encodeURIComponent(mailbox.primarySmtpAddress)}`)
                .set("Authorization", "jwt " + strangerToken);
            expect(result.status).toBe(200);
            expect(result.body).toBeNull();
        });
    });
});
