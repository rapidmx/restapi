///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Covers `BaseMailboxRoute`'s `staticAliases` bypass — a separate file from
// `MailboxAutoProvision.test.ts` because that one deliberately exercises the *real*
// `authServerUrl`+`fetch()` path (mocked at the network layer), while this one configures
// `mail:auto_provision:static_aliases` instead and asserts `fetch` is never even called.
import config from "../../config.js";

config.set("mail:auto_provision:enabled", true);
config.set("mail:auto_provision:static_aliases", ["dev-user"]);

import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:MailboxMongo auto-provision (static aliases) Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/mailboxes";

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);

    let mockFetch: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        const domainRepo: MongoRepository<DomainMongo> = conn.getMongoRepository("DomainMongo");
        // The mailbox policy is seeded from config on first use; drop any row another suite seeded so this file's
        // config (auto-provisioning on) is what gets seeded here.
        await conn.getMongoRepository("MailboxPolicyMongo").clear().catch(() => undefined);
        await domainRepo.save(
            new DomainMongo({
                name: "example.com",
                enabled: true,
                verified: true,
                verificationToken: uuid.v4(),
                uid: "example.com",
            }),
        );
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(() => {
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("uses the configured static alias list instead of ever calling out to auth-server.", async () => {
        const result = await request(server.getApplication())
            .post(`${baseUrl}/auto-provision`)
            .set("Authorization", "jwt " + userToken)
            .set("Cookie", `jwt=${userToken}`);

        expect(result.status).toBe(200);
        expect(result.body.status).toBe("needs_selection");
        expect(result.body.options).toEqual([
            { alias: "dev-user", domain: "example.com", primarySmtpAddress: "dev-user@example.com" },
        ]);
        expect(mockFetch).not.toHaveBeenCalled();
    });
});
