///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `ConfigEnvelopeSourceRegistry` (spec 5.5, step 3): the record types whose rows hold configuration envelopes, which `ConfigKeyRotationJob` re-encrypts
// and counts. restapi's steps R2 to R4 register `DnsProvider`, `IntegrationSettings` and `Plugin`.
import { ConfigEnvelopeSourceRegistry, type ConfigEnvelopeSource } from "../../src/secrets/ConfigEnvelopeSource.js";

const source = (record: string): ConfigEnvelopeSource => ({ record, modelClass: class {}, envelopes: () => [], replace: () => ({}) });

describe("ConfigEnvelopeSourceRegistry", () => {
    it("lists the sources in the order they were registered", () => {
        const registry = new ConfigEnvelopeSourceRegistry();
        const plugin = source("Plugin");
        const dns = source("DnsProvider");
        registry.register(plugin);
        registry.register(dns);
        expect(registry.list()).toEqual([plugin, dns]);
        expect(registry.get("DnsProvider")).toBe(dns);
        expect(registry.get("Nothing")).toBeUndefined();
    });

    it("is empty to begin with", () => {
        expect(new ConfigEnvelopeSourceRegistry().list()).toEqual([]);
    });

    it("takes one source per record type, since the type is part of every envelope's associated data", () => {
        const registry = new ConfigEnvelopeSourceRegistry();
        registry.register(source("Plugin"));
        expect(() => registry.register(source("Plugin"))).toThrow("Plugin");
        expect(registry.list()).toHaveLength(1);
    });

    it("hands out a copy of the list, so a caller can't change the registry through it", () => {
        const registry = new ConfigEnvelopeSourceRegistry();
        registry.register(source("Plugin"));
        registry.list().pop();
        expect(registry.list()).toHaveLength(1);
    });
});
