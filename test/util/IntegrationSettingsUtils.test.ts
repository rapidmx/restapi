///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The Integrations helpers: field validation (STUN URIs, https URLs that must not point inside the network, the contact address, plugin namespaces),
// the deployment defaults read from config, the view the route answers with, and the config layer the server builds from the row.
import { DEFAULT_PLUGIN_REGISTRY } from "../../src/plugins/NpmRegistryClient.js";
import { DEFAULT_RFC8823_DIRECTORY_URL } from "../../src/pki/Rfc8823AcmeSigningCertificateEnrollment.js";
import { setDiscoveryAddressLookup } from "../../src/util/KeyDiscoveryClient.js";
import {
    buildIntegrationsConfigLayer,
    DEFAULT_DOH_ENDPOINT,
    GIPHY_API_KEY_FIELD,
    integrationDefaults,
    integrationSecretContext,
    integrationSettingsView,
    INTEGRATION_CONFIG_KEYS,
    INTEGRATION_SECTION_FIELDS,
    INTEGRATION_SECTIONS,
    INTEGRATION_SETTINGS_RECORD,
    INTEGRATION_SETTINGS_UID,
    isIntegrationSection,
    MAX_INTEGRATION_PLUGIN_NAMESPACES,
    MAX_STUN_URLS,
    normalizeContactEmail,
    normalizeIntegrationField,
    normalizeIntegrationNamespaces,
    normalizeIntegrationUrl,
    normalizeStunUrls,
    pluginNamespaceTokenField,
    PLUGIN_REGISTRY_TOKEN_FIELD,
    sameRegistryUrl,
    withoutUrlCredentials,
} from "../../src/util/IntegrationSettingsUtils.js";
import { ConfigSecretUnavailableError, type ConfigCipherContext } from "../../src/secrets/ConfigCipher.js";
import type { ConfigEnvelope, IntegrationSettings } from "../../src/models/types.js";

const MASK = { secret: true };
/** A stand-in envelope; its `ct` says what the fake cipher below reads out of it. */
const envelope = (ct: string): ConfigEnvelope => ({ $enc: 1, kid: "k1", iv: "aXY=", ct, tag: "dGFn" });

/** Answers each host from `addresses`; a host not listed doesn't resolve. */
function lookupFrom(addresses: Record<string, string[]>): (hostname: string) => Promise<string[]> {
    return async (hostname) => {
        const found = addresses[hostname];
        if (!found) {
            throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
        }
        return found;
    };
}

describe("IntegrationSettingsUtils", () => {
    beforeEach(() => {
        setDiscoveryAddressLookup(
            lookupFrom({
                "registry.example.com": ["93.184.216.34"],
                "acme.example.com": ["2606:2800:220:1::1"],
                "internal.example.com": ["10.0.0.5"],
                "metadata.example.com": ["169.254.169.254"],
                "mixed.example.com": ["93.184.216.34", "127.0.0.1"],
                localhost: ["127.0.0.1"],
            }),
        );
    });

    afterEach(() => {
        setDiscoveryAddressLookup();
    });

    describe("sections", () => {
        it("lists the five sections and their fields, and maps every field to the config key it overrides", () => {
            expect([...INTEGRATION_SECTIONS]).toEqual(["giphy", "stun", "signingCa", "dnsResolver", "pluginRegistry"]);
            expect(INTEGRATION_SECTION_FIELDS).toEqual({
                giphy: ["enabled", "apiKey"],
                stun: ["urls"],
                signingCa: ["backend", "directoryUrl", "contactEmail"],
                dnsResolver: ["mode", "dohEndpoint"],
                pluginRegistry: ["url", "token", "namespaces"],
            });
            expect(INTEGRATION_CONFIG_KEYS).toEqual({
                giphy: { enabled: "giphy:enabled", apiKey: "giphy:api_key" },
                stun: { urls: "integrations:stun:urls" },
                signingCa: { backend: "mail:pki:signing_enrollment:backend", directoryUrl: "mail:pki:rfc8823:directory_url", contactEmail: "mail:pki:rfc8823:contact_email" },
                dnsResolver: { mode: "mail:dns:resolver", dohEndpoint: "mail:dns:doh:endpoint" },
                pluginRegistry: { url: "system:plugins:registry", token: "system:plugins:registry_token", namespaces: "system:plugins:namespaces" },
            });
        });

        it.each([
            ["giphy", true],
            ["pluginRegistry", true],
            ["turn", false],
            ["constructor", false],
            ["__proto__", false],
            [undefined, false],
        ])("tells whether %s is a section: %s", (name, expected) => {
            expect(isIntegrationSection(name)).toBe(expected);
        });
    });

    describe("normalizeStunUrls()", () => {
        it("accepts stun: and stuns: URIs with a host name, an IPv4 or a bracketed IPv6 address and an optional port, lowercased and each once", () => {
            expect(
                normalizeStunUrls(["STUN:Stun.Example.com", " stuns:stun.example.com:5349 ", "stun:192.0.2.1:3478", "stun:[2001:db8::1]:3478", "stun:stun.example.com"]),
            ).toEqual(["stun:stun.example.com", "stuns:stun.example.com:5349", "stun:192.0.2.1:3478", "stun:[2001:db8::1]:3478"]);
        });

        it.each([
            ["not a list", "stun:stun.example.com"],
            // The meet plugin takes an empty list as "use the built-in one": saved, it would claim no STUN servers while meetings used the public ones.
            ["an empty list", []],
            ["a value that isn't text", [42]],
            ["a TURN URI", ["turn:turn.example.com"]],
            ["an http URL", ["https://stun.example.com"]],
            ["no host", ["stun:"]],
            ["a host with a path", ["stun:stun.example.com/x"]],
            ["a URI with a query", ["stun:stun.example.com?transport=udp"]],
            ["a URI with user info", ["stun:user@stun.example.com"]],
            ["a URL-style authority", ["stun://stun.example.com"]],
            ["port 0", ["stun:stun.example.com:0"]],
            ["a port over 65535", ["stun:stun.example.com:65536"]],
            ["an unbracketed IPv6 address", ["stun:2001:db8::1"]],
            ["a bracketed value that isn't IPv6", ["stun:[stun.example.com]"]],
            ["a label starting with a hyphen", ["stun:-stun.example.com"]],
            ["a control character", ["stun:stun.exa\u0007mple.com"]],
            ["more than the limit", Array.from({ length: MAX_STUN_URLS + 1 }, (_, i) => `stun:s${i}.example.com`)],
        ])("refuses %s (400)", (_label, value) => {
            expect(() => normalizeStunUrls(value)).toThrow(expect.objectContaining({ status: 400 }));
        });
    });

    describe("normalizeIntegrationUrl()", () => {
        it("accepts an https URL whose host is public, as sent (trimmed)", async () => {
            await expect(normalizeIntegrationUrl(" https://registry.example.com/npm ", "url")).resolves.toBe("https://registry.example.com/npm");
            await expect(normalizeIntegrationUrl("https://acme.example.com/directory", "directoryUrl")).resolves.toBe("https://acme.example.com/directory");
            await expect(normalizeIntegrationUrl("https://93.184.216.34/", "url")).resolves.toBe("https://93.184.216.34/");
            // A name that doesn't resolve can't be connected to either.
            await expect(normalizeIntegrationUrl("https://not-yet.example.com/", "url")).resolves.toBe("https://not-yet.example.com/");
        });

        it.each([
            ["not text", 42],
            ["empty", "  "],
            ["not a URL", "registry.example.com"],
            ["plain http", "http://registry.example.com/"],
            ["another scheme", "ftp://registry.example.com/"],
            ["user info", "https://user:secret@registry.example.com/"],
            ["a control character", "https://registry.example.com/\u0007"],
            ["too long", `https://registry.example.com/${"a".repeat(2048)}`],
            ["a private address", "https://10.1.2.3/"],
            ["a loopback address", "https://127.0.0.1:8443/"],
            ["the cloud metadata address, encoded as a number", "https://2852039166/"],
            ["a private IPv6 address", "https://[fd00::1]/"],
            ["an IPv4-mapped loopback address", "https://[::ffff:127.0.0.1]/"],
            ["a name resolving to a private address", "https://internal.example.com/"],
            ["a name resolving to a link-local address", "https://metadata.example.com/"],
            ["a name with one private address among public ones", "https://mixed.example.com/"],
            ["localhost", "https://localhost/"],
        ])("refuses %s (400), naming the field and never the value", async (_label, value) => {
            const err: any = await normalizeIntegrationUrl(value, "dohEndpoint").catch((e) => e);
            expect(err).toEqual(expect.objectContaining({ status: 400 }));
            expect(err.message).toContain("'dohEndpoint'");
            if (typeof value === "string" && value.trim()) {
                expect(err.message).not.toContain(value.trim());
            }
        });
    });

    describe("normalizeContactEmail()", () => {
        it("accepts an address, trimmed", () => {
            expect(normalizeContactEmail(" pki@example.com ", "contactEmail")).toBe("pki@example.com");
        });

        it.each([42, "", "pki", "pki@", "@example.com", "pki@example", "a b@example.com", "pki@example.com\r\nBcc: x@example.com", `${"a".repeat(250)}@example.com`])(
            "refuses %s (400)",
            (value) => {
                expect(() => normalizeContactEmail(value, "contactEmail")).toThrow(expect.objectContaining({ status: 400 }));
            },
        );
    });

    describe("normalizeIntegrationNamespaces()", () => {
        it("takes scopes as text or objects, with a public https registry and a write-only token", async () => {
            const result = await normalizeIntegrationNamespaces([
                "rapidmx",
                { name: "@acme", registry: "https://registry.example.com/", token: " npm_TOKEN " },
                { name: "@kept", token: MASK },
                { name: "@cleared", token: null },
            ]);
            expect(result.namespaces).toEqual([{ name: "@rapidmx" }, { name: "@acme", registry: "https://registry.example.com/" }, { name: "@kept" }, { name: "@cleared" }]);
            expect(result.tokens).toEqual({ "@acme": "npm_TOKEN" });
            expect(result.kept).toEqual(["@kept"]);
        });

        it.each([
            ["not a list", "@acme"],
            ["more than the limit", Array.from({ length: MAX_INTEGRATION_PLUGIN_NAMESPACES + 1 }, (_, i) => `@s${i}`)],
            ["an entry that is neither text nor an object", [42]],
            ["a scope that isn't one", ["@Not Valid"]],
            ["an unknown field", [{ name: "@acme", password: "x" }]],
            ["a scope listed twice", ["@acme", { name: "acme" }]],
            ["a registry over plain http", [{ name: "@acme", registry: "http://registry.example.com/" }]],
            ["a registry inside the network", [{ name: "@acme", registry: "https://internal.example.com/" }]],
            ["an empty token", [{ name: "@acme", token: " " }]],
            ["a token with a line break", [{ name: "@acme", token: "a\nb" }]],
        ])("refuses %s (400)", async (_label, value) => {
            await expect(normalizeIntegrationNamespaces(value)).rejects.toEqual(expect.objectContaining({ status: 400 }));
        });

        it("never repeats a token in its error", async () => {
            const err: any = await normalizeIntegrationNamespaces([{ name: "@acme", token: "sec\u0001ret" }]).catch((e) => e);
            expect(err.status).toBe(400);
            expect(err.message).not.toContain("sec");
        });

        it("binds each secret to the IntegrationSettings row and its field, a namespace's token by its scope", () => {
            expect(INTEGRATION_SETTINGS_RECORD).toBe("IntegrationSettings");
            expect(GIPHY_API_KEY_FIELD).toBe("giphy.apiKey");
            expect(PLUGIN_REGISTRY_TOKEN_FIELD).toBe("pluginRegistry.token");
            expect(pluginNamespaceTokenField("@acme")).toBe("pluginRegistry.namespaces.@acme.token");
            expect(pluginNamespaceTokenField("@a")).not.toBe(pluginNamespaceTokenField("@b"));
            expect(integrationSecretContext(GIPHY_API_KEY_FIELD)).toEqual({ record: "IntegrationSettings", uid: INTEGRATION_SETTINGS_UID, field: "giphy.apiKey" });
            expect(integrationSecretContext(pluginNamespaceTokenField("@acme"))).toEqual({
                record: "IntegrationSettings",
                uid: "integrations",
                field: "pluginRegistry.namespaces.@acme.token",
            });
        });
    });

    describe("normalizeIntegrationField()", () => {
        it("validates each plain field of each section", async () => {
            await expect(normalizeIntegrationField("giphy", "enabled", false)).resolves.toBe(false);
            await expect(normalizeIntegrationField("stun", "urls", ["stun:stun.example.com"])).resolves.toEqual(["stun:stun.example.com"]);
            await expect(normalizeIntegrationField("signingCa", "backend", "rfc8823")).resolves.toBe("rfc8823");
            await expect(normalizeIntegrationField("signingCa", "directoryUrl", "https://acme.example.com/dir")).resolves.toBe("https://acme.example.com/dir");
            await expect(normalizeIntegrationField("signingCa", "contactEmail", "pki@example.com")).resolves.toBe("pki@example.com");
            await expect(normalizeIntegrationField("dnsResolver", "mode", "doh-dnssec")).resolves.toBe("doh-dnssec");
            await expect(normalizeIntegrationField("dnsResolver", "dohEndpoint", "https://registry.example.com/dns-query")).resolves.toBe("https://registry.example.com/dns-query");
            await expect(normalizeIntegrationField("pluginRegistry", "url", "https://registry.example.com")).resolves.toBe("https://registry.example.com");
        });

        it.each([
            ["giphy", "enabled", "yes"],
            ["signingCa", "backend", "acme"],
            ["signingCa", "directoryUrl", "http://acme.example.com/"],
            ["dnsResolver", "mode", "doh"],
            ["dnsResolver", "dohEndpoint", "https://10.0.0.1/dns-query"],
        ])("refuses %s.%s = %s (400)", async (section, field, value) => {
            await expect(normalizeIntegrationField(section, field, value)).rejects.toEqual(expect.objectContaining({ status: 400 }));
        });

        it("has no plain field for a secret or the namespaces, which the route handles itself", async () => {
            await expect(normalizeIntegrationField("giphy", "apiKey", "x")).rejects.toThrow("not a plain field");
            await expect(normalizeIntegrationField("pluginRegistry", "namespaces", [])).rejects.toThrow("not a plain field");
        });
    });

    describe("integrationDefaults()", () => {
        it("reads the deployment's values, with the built-in defaults where config sets none, and secrets only as the mask", () => {
            expect(integrationDefaults({})).toEqual({
                giphy: { enabled: true, apiKey: null },
                stun: { urls: null },
                signingCa: { backend: "manual", directoryUrl: DEFAULT_RFC8823_DIRECTORY_URL, contactEmail: null },
                dnsResolver: { mode: "node", dohEndpoint: DEFAULT_DOH_ENDPOINT },
                pluginRegistry: { url: DEFAULT_PLUGIN_REGISTRY, token: null, namespaces: [{ name: "@rapidmx" }] },
            });
        });

        it("takes what config sets, from lists or their text, and never a secret's value", () => {
            const defaults = integrationDefaults({
                "giphy:enabled": "off",
                "giphy:api_key": "GIPHY-KEY",
                "integrations:stun:urls": '["stun:a.example.com", "stun:b.example.com:3478"]',
                "mail:pki:signing_enrollment:backend": "rfc8823",
                "mail:pki:rfc8823:directory_url": "https://acme.example.com/dir",
                "mail:pki:rfc8823:contact_email": "pki@example.com",
                "mail:dns:resolver": "doh-dnssec",
                "mail:dns:doh:endpoint": "https://dns.example.com/dns-query",
                "system:plugins:registry": "https://registry.example.com",
                "system:plugins:registry_token": "REGISTRY-TOKEN",
                "system:plugins:namespaces": [{ name: "@acme", registry: "https://npm.acme.example", token: "NS-TOKEN" }, "@rapidmx"],
            });
            expect(defaults).toEqual({
                giphy: { enabled: false, apiKey: MASK },
                stun: { urls: ["stun:a.example.com", "stun:b.example.com:3478"] },
                signingCa: { backend: "rfc8823", directoryUrl: "https://acme.example.com/dir", contactEmail: "pki@example.com" },
                dnsResolver: { mode: "doh-dnssec", dohEndpoint: "https://dns.example.com/dns-query" },
                pluginRegistry: {
                    url: "https://registry.example.com",
                    token: MASK,
                    namespaces: [{ name: "@acme", registry: "https://npm.acme.example", token: MASK }, { name: "@rapidmx" }],
                },
            });
            expect(JSON.stringify(defaults)).not.toMatch(/GIPHY-KEY|REGISTRY-TOKEN|NS-TOKEN/);
            expect(integrationDefaults({ "integrations:stun:urls": "stun:a.example.com, stun:b.example.com" }).stun.urls).toEqual(["stun:a.example.com", "stun:b.example.com"]);
            expect(integrationDefaults({ "mail:pki:signing_enrollment:backend": "none" }).signingCa.backend).toBe("none");
            expect(integrationDefaults({ "mail:pki:signing_enrollment:backend": "auto" }).signingCa.backend).toBe("manual");
            expect(integrationDefaults({ "giphy:api_key": "" }).giphy.apiKey).toBeNull();
            expect(integrationDefaults({ "integrations:stun:urls": ["stun:a.example.com", 42] }).stun.urls).toEqual(["stun:a.example.com"]);
            expect(integrationDefaults({ "integrations:stun:urls": 42 }).stun.urls).toBeNull();
            expect(integrationDefaults({ "integrations:stun:urls": "[not json" }).stun.urls).toBeNull();
            // An empty list is the meet plugin's built-in list, the same as none.
            expect(integrationDefaults({ "integrations:stun:urls": [] }).stun.urls).toBeNull();
            expect(integrationDefaults({ "integrations:stun:urls": "" }).stun.urls).toBeNull();
        });

        it("never shows a user name or password a configured URL carries", () => {
            const defaults = integrationDefaults({
                "mail:pki:rfc8823:directory_url": "https://acme:pw1@acme.example.com/dir",
                "mail:dns:doh:endpoint": "https://doh:pw2@dns.example.com/dns-query",
                "system:plugins:registry": "https://ci:s3cret@npm.internal.example.com",
                "system:plugins:namespaces": [{ name: "@acme", registry: "https://ns:pw3@npm.acme.example" }],
            });
            expect(defaults.signingCa.directoryUrl).toBe("https://acme.example.com/dir");
            expect(defaults.dnsResolver.dohEndpoint).toBe("https://dns.example.com/dns-query");
            expect(defaults.pluginRegistry.url).toBe("https://npm.internal.example.com");
            expect(defaults.pluginRegistry.namespaces).toEqual([{ name: "@acme", registry: "https://npm.acme.example" }]);
            expect(JSON.stringify(defaults)).not.toMatch(/pw1|pw2|s3cret|pw3/);
        });
    });

    describe("integrationSettingsView()", () => {
        const defaults = integrationDefaults({ "giphy:api_key": "GIPHY-KEY" });

        it("shows the deployment's values everywhere before anything is saved", () => {
            const view = integrationSettingsView(undefined, defaults);
            expect(view.version).toBe(0);
            expect(view.giphy).toEqual({ values: { enabled: true, apiKey: MASK }, defaults: { enabled: true, apiKey: MASK }, source: { enabled: "deployment", apiKey: "deployment" } });
            expect(view.pluginRegistry.source).toEqual({ url: "deployment", token: "deployment", namespaces: "deployment" });
        });

        it("shows the administrator's values where set, secrets as the mask, and the deployment's for the rest", () => {
            const settings: IntegrationSettings = {
                uid: "integrations",
                version: 4,
                giphy: { enabled: false, apiKey: envelope("giphy") },
                stun: { urls: ["stun:stun.example.com"] },
                signingCa: null,
                dnsResolver: { mode: "doh-dnssec" },
                pluginRegistry: {
                    token: envelope("registry"),
                    namespaces: [{ name: "@acme", registry: "https://registry.example.com/", token: envelope("acme") }, { name: "@open" }],
                },
            } as any;
            const view = integrationSettingsView(settings, defaults);
            expect(view.version).toBe(4);
            expect(view.giphy).toEqual({ values: { enabled: false, apiKey: MASK }, defaults: { enabled: true, apiKey: MASK }, source: { enabled: "admin", apiKey: "admin" } });
            expect(view.stun.values).toEqual({ urls: ["stun:stun.example.com"] });
            expect(view.stun.source).toEqual({ urls: "admin" });
            expect(view.signingCa.source).toEqual({ backend: "deployment", directoryUrl: "deployment", contactEmail: "deployment" });
            expect(view.dnsResolver.values).toEqual({ mode: "doh-dnssec", dohEndpoint: DEFAULT_DOH_ENDPOINT });
            expect(view.dnsResolver.source).toEqual({ mode: "admin", dohEndpoint: "deployment" });
            expect(view.pluginRegistry.values).toEqual({
                url: DEFAULT_PLUGIN_REGISTRY,
                token: MASK,
                namespaces: [{ name: "@acme", registry: "https://registry.example.com/", token: MASK }, { name: "@open" }],
            });
            expect(view.pluginRegistry.source).toEqual({ url: "deployment", token: "admin", namespaces: "admin" });
            // The view carries the mask, never an envelope.
            expect(JSON.stringify(view)).not.toMatch(/$enc|aXY=|"ct"/);
        });

        it("shows no token, and the deployment's namespaces without their default-registry tokens, for an administrator's registry elsewhere", () => {
            const deployment = integrationDefaults({
                "system:plugins:registry": "https://ci:s3cret@npm.internal.example.com",
                "system:plugins:registry_token": "DEPLOYMENT-TOKEN",
                "system:plugins:namespaces": [{ name: "@corp", token: "CORP" }, { name: "@acme", registry: "https://npm.acme.example", token: "ACME" }],
            });
            const elsewhere = integrationSettingsView({ uid: "integrations", version: 2, pluginRegistry: { url: "https://registry.example.com" } } as any, deployment);
            expect(elsewhere.pluginRegistry.values).toEqual({
                url: "https://registry.example.com",
                token: null,
                namespaces: [{ name: "@corp" }, { name: "@acme", registry: "https://npm.acme.example", token: MASK }],
            });
            expect(elsewhere.pluginRegistry.source).toEqual({ url: "admin", token: "admin", namespaces: "deployment" });
            expect(elsewhere.pluginRegistry.defaults.token).toEqual(MASK);

            // The administrator's own token and namespaces are shown as they are; the deployment's registry keeps the deployment's token.
            const own = integrationSettingsView(
                {
                    uid: "integrations",
                    version: 3,
                    pluginRegistry: { url: "https://registry.example.com", token: envelope("registry"), namespaces: [{ name: "@own" }] },
                } as any,
                deployment,
            );
            expect(own.pluginRegistry.values).toEqual({ url: "https://registry.example.com", token: MASK, namespaces: [{ name: "@own" }] });
            const same = integrationSettingsView({ uid: "integrations", version: 4, pluginRegistry: { url: "https://npm.internal.example.com/" } } as any, deployment);
            expect(same.pluginRegistry.values.token).toEqual(MASK);
            expect(same.pluginRegistry.source.token).toBe("deployment");
        });

        it("counts a null or missing secret, or a null field, as not set", () => {
            const view = integrationSettingsView({ uid: "integrations", version: 1, giphy: { enabled: null as any, apiKey: null } } as any, integrationDefaults({}));
            expect(view.giphy.source).toEqual({ enabled: "deployment", apiKey: "deployment" });
            expect(view.giphy.values).toEqual({ enabled: true, apiKey: null });
        });
    });

    describe("buildIntegrationsConfigLayer()", () => {
        /** Reads the plain text out of a stand-in envelope's `ct`, recording the context each was opened for; an envelope whose `ct` starts with `bad` can't be read. */
        function cipher() {
            const contexts: ConfigCipherContext[] = [];
            return {
                contexts,
                decryptString: vi.fn((sealed: ConfigEnvelope, context: ConfigCipherContext): string => {
                    contexts.push(context);
                    if (sealed.ct.startsWith("bad")) {
                        throw new ConfigSecretUnavailableError(context.record, context.uid, context.field, "unknown_key", "its key 'k9' isn't in the keyring");
                    }
                    return sealed.ct;
                }),
            };
        }

        it("is empty before anything is saved", () => {
            const read = cipher();
            expect(buildIntegrationsConfigLayer(undefined, read, {})).toEqual({ values: {}, unreadable: [] });
            expect(read.decryptString).not.toHaveBeenCalled();
        });

        it("sets exactly the config keys the administrator chose, with the secrets decrypted for the row and field they are on", () => {
            const settings: any = {
                giphy: { enabled: true, apiKey: envelope("GIPHY") },
                stun: { urls: ["stun:stun.example.com"] },
                signingCa: { backend: "rfc8823", directoryUrl: "https://acme.example.com/dir", contactEmail: "pki@example.com" },
                dnsResolver: { mode: "doh-dnssec", dohEndpoint: "https://dns.example.com/dns-query" },
                pluginRegistry: {
                    url: "https://registry.example.com",
                    token: envelope("REG"),
                    namespaces: [{ name: "@acme", registry: "https://npm.acme.example", token: envelope("NS") }, { name: "@open" }],
                },
            };
            const read = cipher();
            const layer = buildIntegrationsConfigLayer(settings, read, {});
            expect(layer).toEqual({
                values: {
                    "giphy:enabled": true,
                    "giphy:api_key": "GIPHY",
                    "integrations:stun:urls": ["stun:stun.example.com"],
                    "mail:pki:signing_enrollment:backend": "rfc8823",
                    "mail:pki:rfc8823:directory_url": "https://acme.example.com/dir",
                    "mail:pki:rfc8823:contact_email": "pki@example.com",
                    "mail:dns:resolver": "doh-dnssec",
                    "mail:dns:doh:endpoint": "https://dns.example.com/dns-query",
                    "system:plugins:registry": "https://registry.example.com",
                    "system:plugins:registry_token": "REG",
                    "system:plugins:namespaces": [{ name: "@acme", registry: "https://npm.acme.example", token: "NS" }, { name: "@open" }],
                },
                unreadable: [],
            });
            expect(read.contexts).toEqual([
                { record: "IntegrationSettings", uid: "integrations", field: "giphy.apiKey" },
                { record: "IntegrationSettings", uid: "integrations", field: "pluginRegistry.token" },
                { record: "IntegrationSettings", uid: "integrations", field: "pluginRegistry.namespaces.@acme.token" },
            ]);
            // The row's envelopes never reach the layer, only what they decrypt to.
            expect(JSON.stringify(layer)).not.toMatch(/\$enc|aXY=/);
        });

        it("passes namespaces without tokens on as they are, decrypting nothing", () => {
            const read = cipher();
            const layer = buildIntegrationsConfigLayer({ pluginRegistry: { namespaces: [{ name: "@acme" }, { name: "@b", registry: "https://npm.b.example", token: null }] } } as any, read, {});
            expect(layer).toEqual({ values: { "system:plugins:namespaces": [{ name: "@acme" }, { name: "@b", registry: "https://npm.b.example" }] }, unreadable: [] });
            expect(buildIntegrationsConfigLayer({ pluginRegistry: { namespaces: [] } } as any, read, {}).values).toEqual({ "system:plugins:namespaces": [] });
            expect(read.decryptString).not.toHaveBeenCalled();
        });

        it("turns Giphy off by emptying its key too, without decrypting it", () => {
            const read = cipher();
            const layer = buildIntegrationsConfigLayer({ giphy: { enabled: false, apiKey: envelope("GIPHY") } } as any, read, {});
            expect(layer.values).toEqual({ "giphy:enabled": false, "giphy:api_key": "" });
            expect(read.decryptString).not.toHaveBeenCalled();
        });

        it("leaves out, and reports by field, a secret that can't be read, so the deployment's value applies; the namespace it was on is kept without it", () => {
            const layer = buildIntegrationsConfigLayer(
                {
                    giphy: { apiKey: envelope("bad-giphy") },
                    pluginRegistry: {
                        token: envelope("REG"),
                        namespaces: [{ name: "@acme", token: envelope("bad-acme") }, { name: "@other", token: envelope("OTHER") }],
                    },
                } as any,
                cipher(),
                {},
            );
            expect(layer.values).toEqual({
                "system:plugins:registry_token": "REG",
                "system:plugins:namespaces": [{ name: "@acme" }, { name: "@other", token: "OTHER" }],
            });
            expect(layer.unreadable).toEqual(["giphy.apiKey", "pluginRegistry.namespaces.@acme.token"]);
            // The report names fields, never why or what.
            expect(JSON.stringify(layer)).not.toMatch(/k9|keyring|bad-/);
        });

        it("reports a value that isn't an envelope (saved by hand, in plaintext) as unreadable rather than using it", () => {
            const strict: any = {
                decryptString: vi.fn((_value: unknown, context: ConfigCipherContext) => {
                    throw new ConfigSecretUnavailableError(context.record, context.uid, context.field, "invalid", "it isn't an envelope");
                }),
            };
            const layer = buildIntegrationsConfigLayer({ giphy: { apiKey: "plaintext" }, pluginRegistry: { token: "plaintext" } } as any, strict, {});
            expect(layer).toEqual({ values: {}, unreadable: ["giphy.apiKey", "pluginRegistry.token"] });
        });

        it("doesn't hide any other failure: that is a bug, not a secret to enter again", () => {
            const broken: any = {
                decryptString: vi.fn(() => {
                    throw new TypeError("cipher is broken");
                }),
            };
            expect(() => buildIntegrationsConfigLayer({ giphy: { apiKey: envelope("GIPHY") } } as any, broken, {})).toThrow("cipher is broken");
        });

        describe("an administrator's registry elsewhere than the deployment's", () => {
            const deployment = {
                "system:plugins:registry": "https://ci:s3cret@npm.internal.example.com",
                "system:plugins:registry_token": "DEPLOYMENT-TOKEN",
                "system:plugins:namespaces": [{ name: "@corp", token: "CORP-TOKEN" }, { name: "@acme", registry: "https://npm.acme.example", token: "ACME-TOKEN" }, "@rapidmx"],
            };

            it("never takes the deployment's token or its default-registry namespaces' tokens with it", () => {
                const layer = buildIntegrationsConfigLayer({ pluginRegistry: { url: "https://registry.npmmirror.com" } } as any, cipher(), deployment);
                expect(layer.values).toEqual({
                    "system:plugins:registry": "https://registry.npmmirror.com",
                    "system:plugins:registry_token": "",
                    // A namespace on its own registry keeps its token: it never goes to the default registry.
                    "system:plugins:namespaces": [{ name: "@corp" }, { name: "@acme", registry: "https://npm.acme.example", token: "ACME-TOKEN" }, { name: "@rapidmx" }],
                });
                expect(JSON.stringify(layer)).not.toMatch(/DEPLOYMENT-TOKEN|CORP-TOKEN/);
            });

            it("sets none when the administrator's own token can't be read either", () => {
                const layer = buildIntegrationsConfigLayer({ pluginRegistry: { url: "https://registry.example.com", token: envelope("bad-token") } } as any, cipher(), {});
                expect(layer).toEqual({
                    values: { "system:plugins:registry": "https://registry.example.com", "system:plugins:registry_token": "" },
                    unreadable: ["pluginRegistry.token"],
                });
            });

            it("keeps the administrator's own token and namespaces, and leaves namespaces without default-registry tokens to the deployment", () => {
                const layer = buildIntegrationsConfigLayer(
                    { pluginRegistry: { url: "https://registry.example.com", token: envelope("ADMIN"), namespaces: [{ name: "@own" }] } } as any,
                    cipher(),
                    deployment,
                );
                expect(layer.values).toEqual({ "system:plugins:registry": "https://registry.example.com", "system:plugins:registry_token": "ADMIN", "system:plugins:namespaces": [{ name: "@own" }] });
                const plain = buildIntegrationsConfigLayer({ pluginRegistry: { url: "https://registry.example.com" } } as any, cipher(), {});
                expect(plain.values).toEqual({ "system:plugins:registry": "https://registry.example.com", "system:plugins:registry_token": "" });
            });

            it("leaves the deployment's credentials in place for the deployment's own registry, however its URL is written", () => {
                // The administrator's URL can't carry credentials, so the deployment's user name and password (basic auth, when it has no token) go with it.
                for (const url of ["https://npm.internal.example.com/", "https://NPM.internal.example.com"]) {
                    const layer = buildIntegrationsConfigLayer({ pluginRegistry: { url } } as any, cipher(), deployment);
                    expect(layer.values).toEqual({ "system:plugins:registry": "https://ci:s3cret@npm.internal.example.com/" });
                }
                const paths = buildIntegrationsConfigLayer({ pluginRegistry: { url: "https://npm.internal.example.com/" } } as any, cipher(), {
                    "system:plugins:registry": "https://ci%40corp:p%3Aw@npm.internal.example.com/",
                });
                expect(paths.values).toEqual({ "system:plugins:registry": "https://ci%40corp:p%3Aw@npm.internal.example.com/" });
                expect(buildIntegrationsConfigLayer({ pluginRegistry: { url: DEFAULT_PLUGIN_REGISTRY } } as any, cipher(), {}).values).toEqual({
                    "system:plugins:registry": DEFAULT_PLUGIN_REGISTRY,
                });
            });
        });
    });

    describe("registry URLs", () => {
        it("removes a user name and password from a URL, and nothing else", () => {
            expect(withoutUrlCredentials("https://ci:s3cret@npm.internal.example.com/path?q=1")).toBe("https://npm.internal.example.com/path?q=1");
            expect(withoutUrlCredentials("https://user:p@ss@host.example.com")).toBe("https://host.example.com");
            expect(withoutUrlCredentials("https://host.example.com/a@b")).toBe("https://host.example.com/a@b");
            expect(withoutUrlCredentials("not a url")).toBe("not a url");
        });

        it("tells the same registry by its parsed URL, credentials aside", () => {
            expect(sameRegistryUrl("https://registry.example.com", "https://user:pw@REGISTRY.example.com/")).toBe(true);
            expect(sameRegistryUrl("https://registry.example.com", "https://registry.example.com/other")).toBe(false);
            expect(sameRegistryUrl("https://registry.example.com", "http://registry.example.com")).toBe(false);
            expect(sameRegistryUrl("not a url", "not a url")).toBe(false);
            expect(sameRegistryUrl(undefined, undefined)).toBe(false);
        });
    });
});
