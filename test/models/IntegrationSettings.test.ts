///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Default and copy construction of the Integrations settings row on both backends.
import { IntegrationSettingsMongo } from "../../src/models/mongo/IntegrationSettingsMongo.js";
import { IntegrationSettingsSQL } from "../../src/models/sql/IntegrationSettingsSQL.js";

describe.each([
    ["Mongo", IntegrationSettingsMongo],
    ["SQL", IntegrationSettingsSQL],
])("IntegrationSettings (%s)", (_backend, Settings: any) => {
    it("starts with every section unset, so the deployment's values apply", () => {
        for (const settings of [new Settings(), new Settings({})]) {
            for (const section of ["giphy", "stun", "signingCa", "dnsResolver", "pluginRegistry"]) {
                expect(settings[section]).toBeUndefined();
            }
        }
    });

    it("copies every section, including one cleared to null", () => {
        const fields = {
            giphy: { enabled: false, apiKeyRef: { backend: "openbao", path: "server/giphy", keys: ["apiKey"], generation: 2 } },
            stun: { urls: ["stun:stun.example.com"] },
            signingCa: { backend: "rfc8823", directoryUrl: "https://acme.example.com/dir", contactEmail: "pki@example.com" },
            dnsResolver: { mode: "doh-dnssec" },
            pluginRegistry: { url: "https://registry.example.com", namespaces: [{ name: "@acme" }] },
        };
        expect(new Settings(fields)).toEqual(expect.objectContaining(fields));
        expect(new Settings({ giphy: null, pluginRegistry: null })).toEqual(expect.objectContaining({ giphy: null, pluginRegistry: null }));
    });
});
