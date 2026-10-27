///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// DKIM rotation over HTTP on the SQL backend - see ../dkimRotationRouteSuite.ts. A separate server from DomainRoute.test.ts, registering the real
// `FsDkimKeyProvider` over a temporary directory (before `registerTestDoubles()`, whose `NullDkimKeyProvider` would otherwise win the name).
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import config from "../../config.sql.js";
import { ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { FsDkimKeyProvider } from "../../../src/dkim/FsDkimKeyProvider.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { DomainRouteSQL } from "../../../src/routes/sql/DomainRouteSQL.js";
import { InMemoryDnsPublisher, registerTestDoubles, StaticDnsResolver } from "../../testDoubles.js";
import { dkimRotationRouteSuite } from "../dkimRotationRouteSuite.js";

describe("Route:DomainSQL DKIM rotation Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const repos: Record<string, Repository<any>> = {};
    let keyDir: string;

    beforeAll(async () => {
        keyDir = await fs.mkdtemp(path.join(os.tmpdir(), "domainroute-dkim-rotation-sql-"));
        objectFactory.register(FsDkimKeyProvider, "DkimKeyProvider");
        registerTestDoubles(objectFactory);
        await server.start();
        (objectFactory.getInstance<FsDkimKeyProvider>("DkimKeyProvider") as any).keyDir = keyDir;
        const conn: any = objectFactory.getInstance<ConnectionManager>(ConnectionManager)?.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        for (const cls of [AuditLogEntrySQL, DomainSQL]) {
            repos[cls.name] = conn.getRepository(cls);
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
        await fs.rm(keyDir, { recursive: true, force: true });
    });

    dkimRotationRouteSuite({
        config,
        app: () => server.getApplication(),
        baseUrl: "/sql/domains",
        keyDir: () => keyDir,
        provider: () => objectFactory.getInstance<FsDkimKeyProvider>("DkimKeyProvider")!,
        route: () => [...(objectFactory as any).instances.values()].find((instance: any) => instance instanceof DomainRouteSQL),
        publisher: () => objectFactory.getInstance<InMemoryDnsPublisher>("DnsPublisher")!,
        resolver: () => objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!,
        clear: async () => {
            for (const repo of Object.values(repos)) {
                await repo.clear();
            }
        },
        saveDomain: async (fields) => {
            const name = fields.name as string;
            await repos.DomainSQL.save(new DomainSQL({ uid: name, enabled: true, verified: true, verificationToken: "t", ...fields }));
        },
        domainRow: async (uid) => await repos.DomainSQL.findOneBy({ uid }),
        auditEntries: async () => await repos.AuditLogEntrySQL.find(),
    });
});
