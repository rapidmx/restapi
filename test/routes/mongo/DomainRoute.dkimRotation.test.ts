///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// DKIM rotation over HTTP on the Mongo backend - see ../dkimRotationRouteSuite.ts. A separate server from DomainRoute.test.ts, registering the real
// `FsDkimKeyProvider` over a temporary directory (before `registerTestDoubles()`, whose `NullDkimKeyProvider` would otherwise win the name).
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import config from "../../config.js";
import { ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { FsDkimKeyProvider } from "../../../src/dkim/FsDkimKeyProvider.js";
import { AuditLogEntryMongo } from "../../../src/models/mongo/AuditLogEntryMongo.js";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { DomainRouteMongo } from "../../../src/routes/mongo/DomainRouteMongo.js";
import { InMemoryDnsPublisher, registerTestDoubles, StaticDnsResolver } from "../../testDoubles.js";
import { dkimRotationRouteSuite } from "../dkimRotationRouteSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { port: 9999, dbName: "rrst-test" } });

describe("Route:DomainMongo DKIM rotation Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const repos: Record<string, MongoRepository<any>> = {};
    let keyDir: string;

    beforeAll(async () => {
        keyDir = await fs.mkdtemp(path.join(os.tmpdir(), "domainroute-dkim-rotation-"));
        await mongod.start();
        objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
        registerTestDoubles(objectFactory);
        await server.start();
        (objectFactory.getInstance<FsDkimKeyProvider>("DkimKeyProvider") as any).keyDir = keyDir;
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        for (const cls of [AuditLogEntryMongo, DomainMongo]) {
            repos[cls.name] = conn.getMongoRepository(cls.name);
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
        await fs.rm(keyDir, { recursive: true, force: true });
    });

    dkimRotationRouteSuite({
        config,
        app: () => server.getApplication(),
        baseUrl: "/mongo/domains",
        keyDir: () => keyDir,
        provider: () => objectFactory.getInstance<FsDkimKeyProvider>("DkimKeyProvider")!,
        route: () => [...(objectFactory as any).instances.values()].find((instance: any) => instance instanceof DomainRouteMongo),
        publisher: () => objectFactory.getInstance<InMemoryDnsPublisher>("DnsPublisher")!,
        resolver: () => objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!,
        clear: async () => {
            for (const repo of Object.values(repos)) {
                await repo.clear().catch(() => undefined);
            }
        },
        saveDomain: async (fields) => {
            const name = fields.name as string;
            await repos.DomainMongo.save(new DomainMongo({ uid: name, enabled: true, verified: true, verificationToken: "t", ...fields }));
        },
        domainRow: async (uid) => await repos.DomainMongo.findOne({ uid } as any),
        auditEntries: async () => await repos.AuditLogEntryMongo.find({}).toArray(),
    });
});
