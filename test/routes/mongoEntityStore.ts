///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The MongoDB `EntityStore` - a backend-neutral way for a shared route suite to seed and inspect rows directly, bypassing the routes under test.
// `kind` is an entity name without its backend suffix ("Matter" for MatterSQL/MatterMongo).
import { ConnectionManager, MongoConnection, ObjectFactory } from "@rapidrest/service-core";
import * as mongoModels from "../../src/models/mongo.js";
import type { EntityStore } from "./entityStore.js";

export function createMongoEntityStore(objectFactory: ObjectFactory): EntityStore {
    const connMgr: ConnectionManager = objectFactory.getInstance(ConnectionManager)!;
    const conn: any = connMgr.connections.get("mongo");
    const aclConn: any = connMgr.connections.get("acl");
    if (!(conn instanceof MongoConnection) || !(aclConn instanceof MongoConnection)) {
        throw new Error("Could not find mongo connections");
    }
    const repo = (kind: string): any => conn.getMongoRepository(`${kind}Mongo`);
    return {
        backend: "mongo",
        save: async (kind, data) => await repo(kind).save(new (mongoModels as any)[`${kind}Mongo`](data)),
        find: async (kind, where) => await repo(kind).find(where ?? {}).toArray(),
        update: async (kind, uid, patch) => {
            await repo(kind).updateOne({ uid }, { $set: patch });
        },
        clear: async (...kinds) => {
            for (const kind of kinds) {
                try {
                    await repo(kind).clear();
                } catch (err: any) {
                    if (err.message !== "ns not found") {
                        throw err;
                    }
                }
            }
        },
        saveAcl: async (uid, parentUid, records) => {
            await aclConn
                .getMongoRepository("AccessControlListMongo")
                .save({ uid, dateCreated: new Date(), dateModified: new Date(), version: 0, records, parentUid });
        },
    };
}
