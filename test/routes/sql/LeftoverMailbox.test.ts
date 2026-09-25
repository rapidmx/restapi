///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Runs the leftover-mailbox-data suite (listing, erasing and freeing the address of a deleted mailbox) against the SQL test
// server. The Mongo twin runs the same suite.
import config from "../../config.sql.js";
import { AccessControlListSQL, ConnectionManager, ObjectFactory, Server, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { ErasureExecutionJobSQL } from "../../../src/jobs/sql/ErasureExecutionJobSQL.js";
import { registerTestDoubles } from "../../testDoubles.js";
import type { EntityStore } from "../entityStore.js";
import { createSqlEntityStore } from "../sqlEntityStore.js";
import { leftoverMailboxSuite } from "../leftoverMailboxSuite.js";

describe("Route:LeftoverMailboxSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let store: EntityStore;
    let job: ErasureExecutionJobSQL;
    let aclConn: any;

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
        store = createSqlEntityStore(objectFactory);
        const connMgr: ConnectionManager = objectFactory.getInstance(ConnectionManager)!;
        aclConn = connMgr.connections.get("acl");
        if (!isSqlDataSource(aclConn)) {
            throw new Error("Could not find the acl connection");
        }
        job = await objectFactory.newInstance(ErasureExecutionJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    leftoverMailboxSuite({
        app: () => server.getApplication(),
        prefix: "/sql",
        token: (user: any) => JWTUtils.createTokenSync(config.get("auth"), user),
        store: () => store,
        runJob: async () => await job.run(),
        findAcl: async (uid) => (await aclConn.getRepository(AccessControlListSQL).findOne({ where: { uid } })) ?? undefined,
    });
});
