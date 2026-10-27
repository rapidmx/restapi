///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What `ConfigKeyRotationJob` needs of the Integrations settings row to count and re-encrypt its secrets (spec 5.5, step 3): the envelopes with the field
// path they are bound to, and the sections to save to replace some of them.
import type { ConfigEnvelope } from "../../src/models/types.js";
import { integrationSettingsEnvelopeSource } from "../../src/util/IntegrationSettingsEnvelopeSource.js";

const envelope = (kid: string): ConfigEnvelope => ({ $enc: 1, kid, iv: "aXY=", ct: "Y3Q=", tag: "dGFn" });

describe("integrationSettingsEnvelopeSource()", () => {
    class Model {}
    const source = integrationSettingsEnvelopeSource(Model);
    const row = () => ({
        uid: "integrations",
        version: 4,
        giphy: { enabled: true, apiKey: envelope("k1") },
        stun: { urls: ["stun:stun.example.com"] },
        pluginRegistry: {
            url: "https://registry.example.com",
            token: envelope("k2"),
            namespaces: [{ name: "@acme", registry: "https://npm.acme.example", token: envelope("k3") }, { name: "@open" }, { name: "@a.b", token: envelope("k4") }],
        },
    });

    it("is the source of IntegrationSettings envelopes, over the model class it is given", () => {
        expect(source.record).toBe("IntegrationSettings");
        expect(source.modelClass).toBe(Model);
    });

    it("lists the Giphy key, the registry token and each namespace's token under the path its associated data names", () => {
        expect(source.envelopes(row())).toEqual([
            { field: "giphy.apiKey", envelope: envelope("k1") },
            { field: "pluginRegistry.token", envelope: envelope("k2") },
            { field: "pluginRegistry.namespaces.@acme.token", envelope: envelope("k3") },
            { field: "pluginRegistry.namespaces.@a.b.token", envelope: envelope("k4") },
        ]);
    });

    it("lists nothing for a row without secrets, cleared sections, or a field that holds no envelope", () => {
        expect(source.envelopes({ uid: "integrations" })).toEqual([]);
        expect(source.envelopes({ uid: "integrations", giphy: null, pluginRegistry: null })).toEqual([]);
        expect(source.envelopes({ uid: "integrations", giphy: { enabled: false }, pluginRegistry: { namespaces: [{ name: "@open" }] } })).toEqual([]);
        // A value saved in plaintext by hand isn't an envelope: the layer reports it unreadable.
        expect(source.envelopes({ uid: "integrations", giphy: { apiKey: "plaintext" as any }, pluginRegistry: { token: null as any, namespaces: [{ name: "@a", token: "x" as any }] } })).toEqual([]);
    });

    it("replaces envelopes by path, keeping the rest of their sections, and saves only the sections it changed", () => {
        const before = row();
        const changed = source.replace(before, {
            "pluginRegistry.token": envelope("n2"),
            "pluginRegistry.namespaces.@a.b.token": envelope("n4"),
        });
        expect(changed).toEqual({
            pluginRegistry: {
                url: "https://registry.example.com",
                token: envelope("n2"),
                namespaces: [{ name: "@acme", registry: "https://npm.acme.example", token: envelope("k3") }, { name: "@open" }, { name: "@a.b", token: envelope("n4") }],
            },
        });
        expect(source.replace(before, { "giphy.apiKey": envelope("n1") })).toEqual({ giphy: { enabled: true, apiKey: envelope("n1") } });
        // A namespace's token alone leaves the registry's own as it is.
        expect(source.replace(before, { "pluginRegistry.namespaces.@acme.token": envelope("n3") }).pluginRegistry).toEqual({
            url: "https://registry.example.com",
            token: envelope("k2"),
            namespaces: [{ name: "@acme", registry: "https://npm.acme.example", token: envelope("n3") }, { name: "@open" }, { name: "@a.b", token: envelope("k4") }],
        });
        // The row it was given is not changed.
        expect(before).toEqual(row());
    });

    it("replaces a registry token on a row that has no namespaces, without adding any", () => {
        expect(source.replace({ uid: "integrations", pluginRegistry: { token: envelope("k2") } }, { "pluginRegistry.token": envelope("n2") })).toEqual({
            pluginRegistry: { token: envelope("n2") },
        });
    });

    it("ignores a replacement for a path that isn't an envelope of the row", () => {
        const before = row();
        expect(source.replace(before, { "credentials.apiToken": envelope("n"), "pluginRegistry.namespaces.@open.token": envelope("n"), "pluginRegistry.namespaces.@gone.token": envelope("n") })).toEqual({});
        expect(source.replace({ uid: "integrations" }, { "giphy.apiKey": envelope("n"), "pluginRegistry.token": envelope("n") })).toEqual({});
        expect(source.replace(before, {})).toEqual({});
        expect(source.replace({ uid: "integrations", pluginRegistry: { url: "https://registry.example.com" } }, { "pluginRegistry.token": envelope("n") })).toEqual({});
    });
});
