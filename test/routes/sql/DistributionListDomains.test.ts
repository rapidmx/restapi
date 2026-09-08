///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated from DistributionListRoute.test.ts because this needs `mail:domains` turned on - vitest's
// per-file module isolation (see MailboxAutoProvision.test.ts's identical rationale) means mutating the
// shared `config` singleton here can't leak into that file's unrestricted-domain assertions.
import config from "../../config.sql.js";
config.set("mail:domains", ["example.com", "example.org"]);

import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:DistributionListSQL domain-restriction Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/distribution-lists";

    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    it("Rejects an address on a domain not in mail:domains.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: "sales@not-allowed.com", name: "Sales", memberAddresses: [] });

        expect(result.status).toBe(400);
    });

    it("Accepts an address on a domain in mail:domains.", async () => {
        const result = await request(server.getApplication())
            .post(baseUrl)
            .set("Authorization", "jwt " + adminToken)
            .send({ primarySmtpAddress: `${uuid.v4()}@example.com`, name: "Sales", memberAddresses: [] });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
    });
});
