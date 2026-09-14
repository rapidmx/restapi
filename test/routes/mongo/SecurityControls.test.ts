///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Runs the backend-neutral security-control suites (escrow dual control, admin write guards, key vault ownership,
// branding assets, date coercion, request lists) against the MongoDB test server. The SQL twin runs the same suites.
import config from "../../config.js";
import { Server, ObjectFactory } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";
import type { EntityStore } from "../entityStore.js";
import { createMongoEntityStore } from "../mongoEntityStore.js";
import { datesAndListsSuite } from "../datesAndListsSuite.js";
import { escrowControlsSuite, type SecurityControlsSuiteContext } from "../escrowControlsSuite.js";
import { writeGuardsSuite } from "../writeGuardsSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:SecurityControlsMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let store: EntityStore;

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        store = createMongoEntityStore(objectFactory);
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    const ctx: SecurityControlsSuiteContext = {
        app: () => server.getApplication(),
        prefix: "/mongo",
        token: (user: any) => JWTUtils.createTokenSync(config.get("auth"), user),
        store: () => store,
    };

    escrowControlsSuite(ctx);
    writeGuardsSuite(ctx);
    datesAndListsSuite(ctx);
});
