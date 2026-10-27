///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { ConnectionManager, isSqlDataSource, ObjectFactory, RepoUtils, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { DeploymentIdentitySQL } from "../../../src/models/sql/DeploymentIdentitySQL.js";
import { DnsProviderSQL } from "../../../src/models/sql/DnsProviderSQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { DEPLOYMENT_IDENTITY_UID } from "../../../src/util/DeploymentIdentityUtils.js";
import { registerTestDoubles } from "../../testDoubles.js";
import type { ConfigCipher } from "../../../src/secrets/ConfigCipher.js";
import { dnsProviderSuite } from "../dnsProviderSuite.js";

describe("Route:DnsProviderSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const repos: Record<string, Repository<any>> = {};
    let identityRepo: RepoUtils<DeploymentIdentitySQL>;

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        for (const cls of [AuditLogEntrySQL, DeploymentIdentitySQL, DnsProviderSQL, DomainSQL]) {
            repos[cls.name] = conn.getRepository(cls);
        }
        identityRepo = await objectFactory.newInstance(RepoUtils, { name: DeploymentIdentitySQL.name, args: [DeploymentIdentitySQL] });
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    dnsProviderSuite({
        config,
        app: () => server.getApplication(),
        prefix: "/sql",
        cipher: () => objectFactory.getInstance<ConfigCipher>("ConfigCipher")!,
        clear: async () => {
            for (const repo of Object.values(repos)) {
                await repo.clear();
            }
        },
        saveDomain: async (fields) => {
            const name = fields.name as string;
            await repos.DomainSQL.save(new DomainSQL({ uid: name, enabled: true, verified: false, verificationToken: "t", ...fields }));
        },
        saveDomains: async (rows) => {
            await repos.DomainSQL.save(rows.map((fields) => new DomainSQL({ uid: fields.name as string, enabled: true, verified: false, verificationToken: "t", ...fields })), { chunk: 100 });
        },
        domainRow: async (uid) => await repos.DomainSQL.findOneBy({ uid }),
        providerRow: async (uid) => await repos.DnsProviderSQL.findOneBy({ uid }),
        auditEntries: async () => await repos.AuditLogEntrySQL.find(),
        identityRepo: () => identityRepo,
        saveIdentity: async (installationId) => {
            await repos.DeploymentIdentitySQL.save(new DeploymentIdentitySQL({ uid: DEPLOYMENT_IDENTITY_UID, installationId }));
        },
    });
});
