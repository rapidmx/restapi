///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The SQL `EntityStore` - a backend-neutral way for a shared route suite to seed and inspect rows directly, bypassing the routes under test.
// `kind` is an entity name without its backend suffix ("Matter" for MatterSQL/MatterMongo).
import { AccessControlListSQL, ConnectionManager, isSqlDataSource, ObjectFactory } from "@rapidrest/service-core";
import * as sqlModels from "../../src/models/sql.js";
import type { EntityStore } from "./entityStore.js";

export function createSqlEntityStore(objectFactory: ObjectFactory): EntityStore {
    const connMgr: ConnectionManager = objectFactory.getInstance(ConnectionManager)!;
    const conn: any = connMgr.connections.get("sql");
    const aclConn: any = connMgr.connections.get("acl");
    if (!isSqlDataSource(conn) || !isSqlDataSource(aclConn)) {
        throw new Error("Could not find sql connections");
    }
    const entityClass = (kind: string): any => (sqlModels as any)[`${kind}SQL`];
    return {
        backend: "sql",
        save: async (kind, data) => await conn.getRepository(entityClass(kind)).save(new (entityClass(kind))(data)),
        find: async (kind, where) => await conn.getRepository(entityClass(kind)).find(where ? { where } : {}),
        update: async (kind, uid, patch) => {
            await conn.getRepository(entityClass(kind)).update({ uid }, patch);
        },
        clear: async (...kinds) => {
            for (const kind of kinds) {
                await conn.getRepository(entityClass(kind)).clear();
            }
        },
        saveAcl: async (uid, parentUid, records) => {
            await aclConn
                .getRepository(AccessControlListSQL)
                .save({ uid, dateCreated: new Date(), dateModified: new Date(), version: 0, records, parentUid } as any);
        },
    };
}
