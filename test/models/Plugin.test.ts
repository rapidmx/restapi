///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PluginMongo } from "../../src/models/mongo/PluginMongo.js";
import { PluginSQL } from "../../src/models/sql/PluginSQL.js";

describe.each([
    ["PluginMongo", PluginMongo],
    ["PluginSQL", PluginSQL],
])("%s", (_name, PluginClass: any) => {
    it("falls back to class defaults when constructed with no data or a partial object", () => {
        for (const obj of [new PluginClass(), new PluginClass({})]) {
            expect(obj.name).toBe("");
            expect(obj.packageVersion).toBe("");
            expect(obj.integrity).toBeUndefined();
            expect(obj.enabled).toBe(true);
            expect(obj.removed).toBeUndefined();
            expect(obj.settings).toEqual({});
            expect(obj.manifest).toEqual({ apiVersion: 0, displayName: "" });
        }
    });

    it("applies provided overrides", () => {
        const manifest = { apiVersion: 1, displayName: "EAS" };
        const obj = new PluginClass({
            name: "@rapidmx/activesync",
            packageVersion: "1.0.0",
            integrity: "sha512-x",
            enabled: false,
            removed: true,
            settings: { a: 1 },
            manifest,
        });
        expect(obj).toEqual(
            expect.objectContaining({
                name: "@rapidmx/activesync",
                packageVersion: "1.0.0",
                integrity: "sha512-x",
                enabled: false,
                removed: true,
                settings: { a: 1 },
                manifest,
            }),
        );
    });
});
