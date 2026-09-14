///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Runs the backend-neutral security-control suites (escrow dual control, admin write guards, key vault ownership,
// branding assets, date coercion, request lists) against the SQL test server. The Mongo twin runs the same suites.
import config from "../../config.sql.js";
import { Server, ObjectFactory } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { registerTestDoubles } from "../../testDoubles.js";
import type { EntityStore } from "../entityStore.js";
import { createSqlEntityStore } from "../sqlEntityStore.js";
import { datesAndListsSuite } from "../datesAndListsSuite.js";
import { escrowControlsSuite, type SecurityControlsSuiteContext } from "../escrowControlsSuite.js";
import { writeGuardsSuite } from "../writeGuardsSuite.js";

describe("Route:SecurityControlsSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let store: EntityStore;

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
        store = createSqlEntityStore(objectFactory);
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    const ctx: SecurityControlsSuiteContext = {
        app: () => server.getApplication(),
        prefix: "/sql",
        token: (user: any) => JWTUtils.createTokenSync(config.get("auth"), user),
        store: () => store,
    };

    escrowControlsSuite(ctx);
    writeGuardsSuite(ctx);
    datesAndListsSuite(ctx);
});
