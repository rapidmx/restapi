///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The routes that aren't `CRUDRoute`s read the deployment's `trusted_roles` like every other route does, not a literal `["admin"]`.
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import config from "../config.sql.js";
import { registerTestDoubles } from "../testDoubles.js";
import { DataExportRequestRouteSQL } from "../../src/routes/sql/DataExportRequestRouteSQL.js";
import { DataSubjectErasureRequestRouteSQL } from "../../src/routes/sql/DataSubjectErasureRequestRouteSQL.js";
import { MailboxImportRequestRouteSQL } from "../../src/routes/sql/MailboxImportRequestRouteSQL.js";
import { PluginRouteSQL } from "../../src/routes/sql/PluginRouteSQL.js";

describe("trusted_roles of the routes that aren't CRUD routes (R2-07)", () => {
    const previous: unknown = config.get("trusted_roles");

    beforeAll(() => {
        config.set("trusted_roles", ["privacy-officer"]);
    });

    afterAll(() => {
        config.set("trusted_roles", previous);
    });

    it.each([
        ["DataExportRequestRoute", DataExportRequestRouteSQL],
        ["DataSubjectErasureRequestRoute", DataSubjectErasureRequestRouteSQL],
        ["MailboxImportRequestRoute", MailboxImportRequestRouteSQL],
        ["PluginRoute", PluginRouteSQL],
    ])("%s uses the configured roles", async (_name, routeClass: any) => {
        const objectFactory = new ObjectFactory(config, Logger());
        registerTestDoubles(objectFactory);
        const route: any = await objectFactory.newInstance(routeClass, { name: "default" });
        expect(route.trustedRoles).toEqual(["privacy-officer"]);
    });
});
