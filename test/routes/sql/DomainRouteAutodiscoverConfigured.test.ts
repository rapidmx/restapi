///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A dedicated server for the one dns-setup() scenario DomainRoute.test.ts can't cover: `mail:autodiscover:public_url`
// actually set to a real host. That value is read via `@Config` at route construction (like `mxHostname`), not live,
// so it needs its own server with the value set before `server.start()` - the same pattern `KeyVaultRoute.
// SignEnrollmentProgress.test.ts` uses for `mail:pki:rfc8823:store_dir`. `PluginRegistry.isActive()` is still checked
// live on every request, so the plugin-active/inactive split is still exercised in the shared server
// (`DomainRoute.test.ts`'s own "autodiscover" describe block) - only this one "public_url is a real host" case needs
// a server of its own.
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { PluginRegistry } from "../../../src/plugins/PluginRegistry.js";
import { registerTestDoubles, StaticDnsResolver } from "../../testDoubles.js";

describe("Route:DomainSQL Tests - dns-setup() with mail:autodiscover:public_url configured", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/domains";
    let repo: Repository<DomainSQL>;

    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    beforeAll(async () => {
        config.set("mail:autodiscover:public_url", "https://mail.rapidmx-test.example.com");
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            repo = conn.getRepository(DomainSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    afterEach(() => {
        PluginRegistry.setLoaded([]);
    });

    it("Recommends the CNAME and SRV records derived from mail:autodiscover:public_url once the plugin is active.", async () => {
        PluginRegistry.setLoaded([{ name: "@rapidmx/autodiscover-plugin", version: "1.0.0" }]);
        const domain = await repo.save(
            new DomainSQL({
                uid: "autodiscover-configured.com",
                name: "autodiscover-configured.com",
                enabled: true,
                verified: false,
                verificationToken: uuid.v4(),
            }),
        );
        const resolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
        resolver.cnameRecords.set("autodiscover.autodiscover-configured.com", ["mail.rapidmx-test.example.com"]);
        resolver.srvRecords.set("_autodiscover._tcp.autodiscover-configured.com", [
            { priority: 0, weight: 0, port: 443, target: "mail.rapidmx-test.example.com" },
        ]);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${domain.uid}/dns-setup`)
            .set("Authorization", "jwt " + adminToken);

        expect(result.status).toBe(200);
        const cname = result.body.find((c: any) => c.type === "autodiscover_cname");
        const srv = result.body.find((c: any) => c.type === "autodiscover_srv");
        expect(cname.configured).toBe(true);
        expect(cname.recommendedValue).toBe("mail.rapidmx-test.example.com");
        expect(cname.matches).toBe(true);
        expect(srv.configured).toBe(true);
        expect(srv.recommendedValue).toBe("0 0 443 mail.rapidmx-test.example.com");
        expect(srv.matches).toBe(true);
    });
});
