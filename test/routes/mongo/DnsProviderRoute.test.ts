///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, RepoUtils, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { DeploymentIdentityMongo } from "../../../src/models/mongo/DeploymentIdentityMongo.js";
import { DnsProviderMongo } from "../../../src/models/mongo/DnsProviderMongo.js";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { DEPLOYMENT_IDENTITY_UID } from "../../../src/util/DeploymentIdentityUtils.js";
import { registerTestDoubles } from "../../testDoubles.js";
import type { ConfigCipher } from "../../../src/secrets/ConfigCipher.js";
import { dnsProviderSuite } from "../dnsProviderSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { port: 9999, dbName: "rrst-test" } });

describe("Route:DnsProviderMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const repos: Record<string, MongoRepository<any>> = {};
    let identityRepo: RepoUtils<DeploymentIdentityMongo>;

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        for (const cls of [AuditLogEntryMongo, DeploymentIdentityMongo, DnsProviderMongo, DomainMongo]) {
            repos[cls.name] = conn.getMongoRepository(cls.name);
        }
        identityRepo = await objectFactory.newInstance(RepoUtils, { name: DeploymentIdentityMongo.name, args: [DeploymentIdentityMongo] });
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    dnsProviderSuite({
        config,
        app: () => server.getApplication(),
        prefix: "/mongo",
        cipher: () => objectFactory.getInstance<ConfigCipher>("ConfigCipher")!,
        clear: async () => {
            for (const repo of Object.values(repos)) {
                await repo.clear().catch(() => undefined);
            }
        },
        saveDomain: async (fields) => {
            const name = fields.name as string;
            await repos.DomainMongo.save(new DomainMongo({ uid: name, enabled: true, verified: false, verificationToken: "t", ...fields }));
        },
        saveDomains: async (rows) => {
            for (let i = 0; i < rows.length; i += 100) {
                await Promise.all(
                    rows
                        .slice(i, i + 100)
                        .map((fields) => repos.DomainMongo.save(new DomainMongo({ uid: fields.name as string, enabled: true, verified: false, verificationToken: "t", ...fields }))),
                );
            }
        },
        domainRow: async (uid) => await repos.DomainMongo.findOne({ uid } as any),
        providerRow: async (uid) => await repos.DnsProviderMongo.findOne({ uid } as any),
        auditEntries: async () => await repos.AuditLogEntryMongo.find({}).toArray(),
        identityRepo: () => identityRepo,
        saveIdentity: async (installationId) => {
            await repos.DeploymentIdentityMongo.save(new DeploymentIdentityMongo({ uid: DEPLOYMENT_IDENTITY_UID, installationId }));
        },
    });
});
