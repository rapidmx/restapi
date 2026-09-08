///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated from DistributionListRoute.test.ts because this needs verified `Domain` rows seeded - kept in
// its own file so that file's own unrestricted-domain assertions (asserted against a mailbox/list repo
// with zero `Domain` rows) can't be affected by this file's seeded data.
import config from "../../config.sql.js";
import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:DistributionListSQL domain-restriction Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/distribution-lists";
    let domainRepo: Repository<DomainSQL>;

    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            domainRepo = conn.getRepository(DomainSQL);
        } else {
            throw new Error("Could not find sql connection");
        }

        // `save()` upserts on the primary key (`uid`), so re-running against the shared on-disk SQLite
        // file used by every SQL test (see restapi's own testing-conventions note) just refreshes these
        // rows rather than conflicting with a prior run's.
        for (const name of ["example.com", "example.org"]) {
            await domainRepo.save(
                new DomainSQL({ name, enabled: true, verified: true, verificationToken: uuid.v4(), uid: name } as any),
            );
        }
    });

    afterAll(async () => {
        // Unlike the config-mutation isolation this file's own header comment describes (naturally scoped
        // to this file's module load), these seeded `Domain` rows live in the shared on-disk SQLite file
        // every SQL test file uses - clean them up so they can't leak into an unrelated later test file's
        // own unrestricted-domain assumptions within the same `vitest run` process.
        await domainRepo.delete({ uid: "example.com" });
        await domainRepo.delete({ uid: "example.org" });
        await server.stop();
        await objectFactory.destroy();
    });

    it("Rejects an address on a domain that isn't one of this server's verified domains.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: "sales@not-allowed.com", name: "Sales", memberAddresses: [] });

        expect(result.status).toBe(400);
    });

    it("Accepts an address on one of this server's verified domains.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [] });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
    });
});
