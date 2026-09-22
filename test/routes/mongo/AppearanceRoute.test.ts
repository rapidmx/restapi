///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AppearancePreferencesMongo } from "../../../src/models/mongo/AppearancePreferencesMongo.js";
import { fetchAppearanceForSSR } from "../../../src/routes/BaseAppearanceRoute.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";
import { appearanceSuite } from "../appearanceSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:AppearanceMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let repo: MongoRepository<AppearancePreferencesMongo>;

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            repo = conn.getMongoRepository("AppearancePreferencesMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        try {
            await repo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
    });

    appearanceSuite({
        app: () => server.getApplication(),
        baseUrl: "/mongo/appearance",
        entityName: "AppearancePreferencesMongo",
        authConfig: () => config.get("auth"),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        rows: async () => await repo.find({}).toArray(),
        ssr: async (userUid) => await fetchAppearanceForSSR(objectFactory, AppearancePreferencesMongo, userUid, logger),
    });
});
