///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Who is granted which live-update channel. A channel is a mailbox or folder uid (or the caller's own uid); a subscription
// to it delivers that mailbox's new-mail payloads (`bodyPreview`, subject, sender), so it is mail data like any other: only
// the owner and ACL holders get it, an administrator (trusted role) and an unrelated user don't, and an impersonation
// token (the target's own identity) does like the target. The protocol runs against the real ACL store with a fake Redis.
import { EventEmitter } from "events";
import config from "../config.js";
import { ACLUtils, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import * as uuid from "uuid";
import { registerTestDoubles } from "../testDoubles.js";
import type { EntityStore } from "../routes/entityStore.js";
import { createMongoEntityStore } from "../routes/mongoEntityStore.js";

const redis = vi.hoisted(() => ({
    createClient: vi.fn(),
}));
vi.mock("redis", () => ({ createClient: redis.createClient }));

import { MailPushRoute } from "../../src/push/MailPushRoute.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { port: 9999, dbName: "rrst-test" } });

describe("MailPushRoute access (Mongo ACLs, fake Redis)", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let store: EntityStore;

    const owner: any = { uid: uuid.v4(), roles: [], scopes: [], elevated: Date.now() };
    const delegate: any = { uid: uuid.v4(), roles: [], scopes: [], elevated: Date.now() };
    const stranger: any = { uid: uuid.v4(), roles: [], scopes: [], elevated: Date.now() };
    const admin: any = { uid: uuid.v4(), roles: ["admin"], scopes: [], elevated: Date.now() };
    const impersonated: any = { uid: owner.uid, roles: [], scopes: [], elevated: -1 };

    let mailboxUid: string;
    let folderUid: string;

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        store = createMongoEntityStore(objectFactory);
        mailboxUid = `${uuid.v4()}@example.com`;
        folderUid = uuid.v4();
        await store.saveAcl(mailboxUid, "Mailbox", [
            { userOrRoleId: owner.uid, actions: ["*"] },
            { userOrRoleId: delegate.uid, actions: ["read", "list", "count", "exists"] },
        ]);
        await store.saveAcl(folderUid, mailboxUid, []);
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(() => {
        redis.createClient.mockReset().mockImplementation(() => ({
            on: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            subscribe: vi.fn().mockResolvedValue(undefined),
            unsubscribe: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn().mockResolvedValue(undefined),
            isOpen: true,
        }));
    });

    /** A route wired to the real ACL store, a fake socket for `user`, and what it sent back. */
    async function connect(user: any): Promise<{ route: any; sock: any; granted: (channels: string[]) => Promise<string[]> }> {
        const route: any = new MailPushRoute();
        route.aclUtils = objectFactory.getInstance(ACLUtils);
        route.redisConfig = { url: "redis://fake" };
        route.logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
        route.redisPub = { publish: vi.fn().mockResolvedValue(1) };
        const sock: any = new EventEmitter();
        sock.readyState = 1;
        sock.send = vi.fn();
        sock.close = vi.fn();
        await route.connect(sock, user);
        let id = 1;
        const granted = async (channels: string[]): Promise<string[]> => {
            const requestId: number = id++;
            sock.emit("message", JSON.stringify({ id: requestId, type: "SUBSCRIBE", data: channels }), false);
            for (let i = 0; i < 200; i++) {
                const reply = sock.send.mock.calls.map((c: any[]) => JSON.parse(c[0])).find((m: any) => m.id === requestId);
                if (reply) {
                    return reply.data;
                }
                await new Promise((resolve) => setTimeout(resolve, 5));
            }
            throw new Error("no SUBSCRIBED reply");
        };
        return { route, sock, granted };
    }

    it("Grants the owner the mailbox and each of its folders.", async () => {
        expect(await (await connect(owner)).granted([folderUid, mailboxUid])).toEqual([folderUid, mailboxUid]);
    });

    it("Grants a read-only delegate the mailbox and its folders.", async () => {
        expect(await (await connect(delegate)).granted([folderUid, mailboxUid])).toEqual([folderUid, mailboxUid]);
    });

    it("Grants an impersonation token - the owner's own identity, no trusted role - exactly what the owner gets.", async () => {
        expect(await (await connect(impersonated)).granted([folderUid, mailboxUid])).toEqual([folderUid, mailboxUid]);
    });

    it("Grants a trusted+elevated administrator with no grant nothing: not the mailbox, not its folder, not another user's uid, not a class ACL.", async () => {
        const { granted } = await connect(admin);
        expect(await granted([folderUid, mailboxUid, owner.uid, "Mailbox", uuid.v4()])).toEqual([]);
    });

    it("Grants an unrelated user nothing.", async () => {
        expect(await (await connect(stranger)).granted([folderUid, mailboxUid, owner.uid])).toEqual([]);
    });

    it("Lets an administrator with an explicit delegate grant subscribe like any delegate.", async () => {
        const granted = uuid.v4();
        await store.saveAcl(granted, "Mailbox", [{ userOrRoleId: admin.uid, actions: ["read"] }]);
        expect(await (await connect(admin)).granted([granted])).toEqual([granted]);
    });

    it("Doesn't let an administrator publish to a mailbox's channel, and lets the owner (CREATE on it).", async () => {
        const forAdmin = await connect(admin);
        await expect(forAdmin.route.send(mailboxUid, { type: "x" }, admin)).rejects.toMatchObject({ status: 403 });
        expect(forAdmin.route.redisPub.publish).not.toHaveBeenCalled();
        const forOwner = await connect(owner);
        await forOwner.route.send(mailboxUid, { type: "x" }, owner);
        expect(forOwner.route.redisPub.publish).toHaveBeenCalledTimes(1);
    });
});
