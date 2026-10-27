///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { DeploymentIdentitySQL } from "../../../src/models/sql/DeploymentIdentitySQL.js";
import { DnsControllerStateSQL } from "../../../src/models/sql/DnsControllerStateSQL.js";
import { DnsOperationSQL } from "../../../src/models/sql/DnsOperationSQL.js";
import { DnsProviderSQL } from "../../../src/models/sql/DnsProviderSQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { DomainRouteSQL } from "../../../src/routes/sql/DomainRouteSQL.js";
import { InMemoryDnsPublisher, InMemorySecretStore, registerTestDoubles, StaticDnsResolver } from "../../testDoubles.js";
import { dnsPublishingSuite } from "../dnsPublishingSuite.js";

describe("Route:DnsPublishingSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const repos: Record<string, Repository<any>> = {};

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        for (const cls of [AuditLogEntrySQL, DeploymentIdentitySQL, DnsControllerStateSQL, DnsOperationSQL, DnsProviderSQL, DomainSQL]) {
            repos[cls.name] = conn.getRepository(cls);
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    dnsPublishingSuite({
        config,
        app: () => server.getApplication(),
        prefix: "/sql",
        store: () => objectFactory.getInstance<InMemorySecretStore>("SecretStore")!,
        publisher: () => objectFactory.getInstance<InMemoryDnsPublisher>("DnsPublisher")!,
        resolver: () => objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!,
        clear: async () => {
            for (const repo of Object.values(repos)) {
                await repo.clear();
            }
        },
        saveDomain: async (fields) => {
            const name = fields.name as string;
            await repos.DomainSQL.save(new DomainSQL({ uid: name, enabled: true, verified: false, verificationToken: "t", ...fields }));
        },
        domainRow: async (uid) => await repos.DomainSQL.findOneBy({ uid }),
        providerRow: async (uid) => await repos.DnsProviderSQL.findOneBy({ uid }),
        operationRows: async () => await repos.DnsOperationSQL.find({ order: { dateCreated: "ASC" } }),
        auditEntries: async () => await repos.AuditLogEntrySQL.find(),
        newDomainRoute: async (name) => await objectFactory.newInstance(DomainRouteSQL, { name }),
    });
});
