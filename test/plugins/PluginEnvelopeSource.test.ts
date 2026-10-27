///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What `ConfigKeyRotationJob` needs of a plugin row to count and re-encrypt its secret settings (spec 5.5, step 3): the envelopes with the field path they are
// bound to (`settings.<key>`), and the `settings` to save to replace some of them.
import type { ConfigEnvelope } from "../../src/models/types.js";
import { pluginEnvelopeSource } from "../../src/plugins/PluginEnvelopeSource.js";

const envelope = (kid: string): ConfigEnvelope => ({ $enc: 1, kid, iv: "aXY=", ct: "Y3Q=", tag: "dGFn" });

describe("pluginEnvelopeSource()", () => {
    class Model {}
    const source = pluginEnvelopeSource(Model);
    const row = () => ({
        uid: "p1",
        version: 3,
        name: "@rapidmx/vault",
        settings: { "mail:v:api_key": envelope("k1"), "mail:v:pin": envelope("k2"), "mail:v:note": "hi", "mail:v:legacy_token": "plaintext" },
    });

    it("is the source of Plugin envelopes, over the model class it is given", () => {
        expect(source.record).toBe("Plugin");
        expect(source.modelClass).toBe(Model);
    });

    it("lists each setting that holds an envelope under the path its associated data names, and nothing else", () => {
        expect(source.envelopes(row() as any)).toEqual([
            { field: "settings.mail:v:api_key", envelope: envelope("k1") },
            { field: "settings.mail:v:pin", envelope: envelope("k2") },
        ]);
        // A value saved in plaintext (before the encryption run) is no envelope: the encryption run finds it, not the rotation.
        expect(source.envelopes({ uid: "p1", settings: { "mail:v:legacy_token": "plaintext" } } as any)).toEqual([]);
        expect(source.envelopes({ uid: "p1" } as any)).toEqual([]);
        expect(source.envelopes({ uid: "p1", settings: null } as any)).toEqual([]);
    });

    it("replaces envelopes by path, saving the whole settings with every other setting as it is", () => {
        const before = row();
        const changed = source.replace(before as any, { "settings.mail:v:pin": envelope("n2") });
        expect(changed).toEqual({ settings: { "mail:v:api_key": envelope("k1"), "mail:v:pin": envelope("n2"), "mail:v:note": "hi", "mail:v:legacy_token": "plaintext" } });
        expect(source.replace(before as any, { "settings.mail:v:api_key": envelope("n1"), "settings.mail:v:pin": envelope("n2") })).toEqual({
            settings: { "mail:v:api_key": envelope("n1"), "mail:v:pin": envelope("n2"), "mail:v:note": "hi", "mail:v:legacy_token": "plaintext" },
        });
        // The row it was given is not changed.
        expect(before).toEqual(row());
    });

    it("saves nothing for a replacement of a path that isn't an envelope of the row", () => {
        const before = row();
        expect(source.replace(before as any, {})).toEqual({});
        expect(source.replace(before as any, { "settings.mail:v:note": envelope("n") })).toEqual({});
        expect(source.replace(before as any, { "settings.mail:v:legacy_token": envelope("n") })).toEqual({});
        expect(source.replace(before as any, { "settings.mail:v:gone": envelope("n") })).toEqual({});
        expect(source.replace({ uid: "p1" } as any, { "settings.mail:v:api_key": envelope("n") })).toEqual({});
    });
});
