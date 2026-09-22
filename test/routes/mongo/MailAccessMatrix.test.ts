///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The mailbox-access matrix (see `mailAccessMatrixSuite.ts`) against the MongoDB test server; the SQL twin runs the same.
import config from "../../config.js";
import { ConnectionManager, MongoConnection, Server, ObjectFactory } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";
import type { EntityStore } from "../entityStore.js";
import { createMongoEntityStore } from "../mongoEntityStore.js";
import { mailAccessMatrixSuite, type MailAccessMatrixContext } from "../mailAccessMatrixSuite.js";
import { mailAdminScopeSuite } from "../mailAdminScopeSuite.js";
import { FAKE_AUTH_URL, FAKE_STATIC_ALIAS, mailPrincipalSuite } from "../mailPrincipalSuite.js";

// The identity service sharing resolves usernames and e-mail aliases against (answered by `mailPrincipalSuite`).
config.set("mail:auth_server_url", FAKE_AUTH_URL);
// The caller's own usernames for a deployment with no identity service (local development).
config.set("mail:auto_provision:static_aliases", [FAKE_STATIC_ALIAS]);
// Short, so the test of an identity service that never answers doesn't wait the production ten seconds.
config.set("mail:auto_provision:timeout_ms", 300);

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:MailAccessMatrixMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let store: EntityStore;
    let aclConn: MongoConnection;

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        store = createMongoEntityStore(objectFactory);
        aclConn = objectFactory.getInstance(ConnectionManager)!.connections.get("acl") as MongoConnection;
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    const ctx: MailAccessMatrixContext = {
        app: () => server.getApplication(),
        prefix: "/mongo",
        token: (user: any) => JWTUtils.createTokenSync(config.get("auth"), user),
        store: () => store,
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        findAcl: async (uid) => (await aclConn.getMongoRepository("AccessControlListMongo").findOne({ uid } as any)) ?? undefined,
    };

    mailAccessMatrixSuite(ctx);
    mailAdminScopeSuite(ctx);
    mailPrincipalSuite(ctx);
});
