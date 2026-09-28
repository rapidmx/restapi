///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real HTTP integration test for BaseServerInfoRoute, matching KeyDiscoveryRoute.test.ts's own real-server
// convention - unlike that route, this one touches no database, so there is no repo setup/teardown here.
// The "no auth-server configured" case is exercised for real, over HTTP, against this file's shared `config`
// (nothing here ever calls `config.set("mail:auth_server_url", ...)`); the "configured" case is covered as an
// isolated unit test below (a fresh ObjectFactory bound to a throwaway config object), rather than mutating
// the shared config singleton - which would also change what the HTTP case above sees, since both would then
// run against the same already-started server (see MailboxAutoProvision.test.ts's own comment on why such a
// mutation must happen at module load, before anything reads it, when it's needed at all).
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ServerInfoRouteSQL } from "../../../src/routes/sql/ServerInfoRouteSQL.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:ServerInfoSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/.well-known/rapidmx/server-info";

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
    });

    afterAll(async () => {
        await server.stop();
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
        const route: ServerInfoRouteSQL = await factory.newInstance(ServerInfoRouteSQL);

        expect(await route.get()).toEqual({ authServerUrl: "https://auth.example.com" });
    });
});
