///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { AppearancePreferencesSQL } from "../../../src/models/sql/AppearancePreferencesSQL.js";
import { fetchAppearanceForSSR } from "../../../src/routes/BaseAppearanceRoute.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";
import { appearanceSuite } from "../appearanceSuite.js";

describe("Route:AppearanceSQL Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let repo: Repository<AppearancePreferencesSQL>;

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            repo = conn.getRepository(AppearancePreferencesSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await repo.clear();
    });

    appearanceSuite({
        app: () => server.getApplication(),
        baseUrl: "/sql/appearance",
        entityName: "AppearancePreferencesSQL",
        authConfig: () => config.get("auth"),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        rows: async () => await repo.find(),
        ssr: async (userUid) => await fetchAppearanceForSSR(objectFactory, AppearancePreferencesSQL, userUid, logger),
    });
});
