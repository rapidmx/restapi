///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real HTTP integration test for BaseServerInfoRoute, matching KeyDiscoveryRoute.test.ts's own real-server
// convention - unlike that route, this one touches no database, so there is no repo setup/teardown here; a
// `MongoMemoryServer` is still required because `server.start()` registers every route under `test/server-mongo`,
// including the DB-backed ones. The "no auth-server configured" case is exercised for real, over HTTP, against
// this file's shared `config` (nothing here ever calls `config.set("mail:auth_server_url", ...)`); the
// "configured" case is covered as an isolated unit test below (a fresh ObjectFactory bound to a throwaway
// config object), rather than mutating the shared config singleton and risking it leaking into the HTTP case
// above, which runs against the same already-started server.
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ServerInfoRouteMongo } from "../../../src/routes/mongo/ServerInfoRouteMongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:ServerInfoMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/.well-known/rapidmx/server-info";

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    it("Returns authServerUrl: '' (never a 404) when mail:auth_server_url is not configured for this deployment.", async () => {
        const result = await request(server.getApplication()).get(baseUrl);

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ authServerUrl: "" });
    });
});

describe("BaseServerInfoRoute Tests (configured, isolated)", () => {
    it("Returns the deployment's configured mail:auth_server_url - the same config key BaseMailboxRoute/BaseMailboxAccessRoute/BaseEscrowScopeRoute already read.", async () => {
        const fakeConfig = { get: (path: string) => (path === "mail:auth_server_url" ? "https://auth.example.com" : undefined) };
        const factory = new ObjectFactory(fakeConfig as any, Logger());
        const route: ServerInfoRouteMongo = await factory.newInstance(ServerInfoRouteMongo);

        expect(await route.get()).toEqual({ authServerUrl: "https://auth.example.com" });
    });
});
