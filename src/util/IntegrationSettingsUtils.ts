///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The admin console's Integrations (spec: specs/dns_publishing_and_integrations.md, 4.5, 10.2, 10.3, 11.1): which config key each field overrides,
// how each field is validated, what the deployment's own values are, the view `BaseIntegrationsRoute` answers with, and the config layer the server
// builds from the row. One table (`INTEGRATION_CONFIG_KEYS`) drives all of them, so the route's defaults and the layer can't name different keys.
import * as net from "net";
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { DEFAULT_RFC8823_DIRECTORY_URL } from "../pki/Rfc8823AcmeSigningCertificateEnrollment.js";
import { DEFAULT_PLUGIN_REGISTRY } from "../plugins/NpmRegistryClient.js";
import { DEFAULT_PLUGIN_NAMESPACES, normalizePluginNamespaces, PluginNamespace } from "../plugins/PluginUtils.js";
import { ConfigSecretUnavailableError, type ConfigCipher, type ConfigCipherContext } from "../secrets/ConfigCipher.js";
import { isSecretMask, secretMask, toSecretPatch, type SecretMask } from "../secrets/SecretMask.js";
import { isPublicDiscoveryAddress, resolvesToPublicAddresses } from "./KeyDiscoveryClient.js";
import { isConfigFlagOn } from "./DkimRotationUtils.js";
import { ConfigEnvelope, DnsResolverMode, IntegrationPluginNamespace, IntegrationSectionName, IntegrationSettings, SigningCaBackend } from "../models/types.js";

/** The fixed identifier of the one `IntegrationSettings` row - same singleton convention as `MAILBOX_POLICY_UID`. */
export const INTEGRATION_SETTINGS_UID = "integrations";

/** The sections, in the order the console shows them. */
export const INTEGRATION_SECTIONS: readonly IntegrationSectionName[] = ["giphy", "stun", "signingCa", "dnsResolver", "pluginRegistry"];

/** Each section's fields, as the request and the response name them. */
export const INTEGRATION_SECTION_FIELDS: Readonly<Record<IntegrationSectionName, readonly string[]>> = {
    giphy: ["enabled", "apiKey"],
    stun: ["urls"],
    signingCa: ["backend", "directoryUrl", "contactEmail"],
    dnsResolver: ["mode", "dohEndpoint"],
    pluginRegistry: ["url", "token", "namespaces"],
};

/** The config key each field overrides: what the deployment's value is read from, and what the server's integrations layer sets. `giphy:enabled` is new
 * (the Giphy route only reads its key today; the layer empties the key too when Giphy is off), and so is `integrations:stun:urls`. */
export const INTEGRATION_CONFIG_KEYS: Readonly<Record<IntegrationSectionName, Readonly<Record<string, string>>>> = {
    giphy: { enabled: "giphy:enabled", apiKey: "giphy:api_key" },
    stun: { urls: "integrations:stun:urls" },
    signingCa: { backend: "mail:pki:signing_enrollment:backend", directoryUrl: "mail:pki:rfc8823:directory_url", contactEmail: "mail:pki:rfc8823:contact_email" },
    dnsResolver: { mode: "mail:dns:resolver", dohEndpoint: "mail:dns:doh:endpoint" },
    pluginRegistry: { url: "system:plugins:registry", token: "system:plugins:registry_token", namespaces: "system:plugins:namespaces" },
};

/** The record type every envelope of the settings row names in its associated data (spec 5.2). */
export const INTEGRATION_SETTINGS_RECORD = "IntegrationSettings";

/** The field path the Giphy key's envelope is bound to. */
export const GIPHY_API_KEY_FIELD = "giphy.apiKey";

/** The field path the plugin registry token's envelope is bound to. */
export const PLUGIN_REGISTRY_TOKEN_FIELD = "pluginRegistry.token";

/** The field path the envelope of the plugin namespace `name`'s token is bound to, so a token copied to another namespace doesn't decrypt. */
export function pluginNamespaceTokenField(name: string): string {
    return `pluginRegistry.namespaces.${name}.token`;
}

/** What an envelope of the settings row's secret `field` (one of the paths above) is bound to. */
export function integrationSecretContext(field: string): ConfigCipherContext {
    return { record: INTEGRATION_SETTINGS_RECORD, uid: INTEGRATION_SETTINGS_UID, field };
}

/** The fewest and the most STUN servers the section takes. */
export const MIN_STUN_URLS = 1;
export const MAX_STUN_URLS = 10;

/** The most plugin namespaces the section takes. */
export const MAX_INTEGRATION_PLUGIN_NAMESPACES = 20;

/** The longest URL a field takes. */
const MAX_URL_LENGTH = 2048;

/** The DoH resolver the server uses when `mail:dns:doh:endpoint` isn't configured (the server's `DohDnssecDnsResolver` default). */
export const DEFAULT_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

const SIGNING_CA_BACKENDS: readonly SigningCaBackend[] = ["rfc8823", "manual", "none"];
const DNS_RESOLVER_MODES: readonly DnsResolverMode[] = ["node", "doh-dnssec"];

// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER: RegExp = /[\u0000-\u001f\u007f-\u009f]/;

/** One DNS label: letters, digits and hyphens, not starting or ending with a hyphen. */
const HOST_NAME: RegExp = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/;

/** `stun:`/`stuns:` URI (RFC 7064): a host (name, IPv4, or bracketed IPv6) and an optional port, nothing else. */
const STUN_URI: RegExp = /^(stuns?):(\[[^\]]*\]|[^:[\]]+)(?::(\d{1,5}))?$/i;

/** A plain address: no spaces, quotes, angle brackets or other header syntax, and a dot in the domain. */
const CONTACT_ADDRESS: RegExp = /^[^\s@<>",;:\\()[\]]+@[^\s@<>",;:\\()[\]]+\.[^\s@<>",;:\\()[\]]+$/;

/** The view of one section: the values in effect, the deployment's own values (what a reset puts a field back to), and where each value comes from. A
 * secret is the mask when set, else `null`; never its value. */
export interface IntegrationSectionView {
    values: Record<string, unknown>;
    defaults: Record<string, unknown>;
    source: Record<string, "admin" | "deployment">;
}

/** What `GET /system/integrations` and every write answer: each section's view, and the row's version (0 before anything was saved), which a write may
 * send back to be refused (409) when someone else changed the settings since. */
export type IntegrationSettingsResponse = Record<IntegrationSectionName, IntegrationSectionView> & { version: number };

/** Each section's deployment values, as the view shows them. */
export type IntegrationDefaults = Record<IntegrationSectionName, Record<string, unknown>>;

function invalid(message: string): ApiError {
    return new ApiError(ApiErrors.INVALID_REQUEST, 400, message);
}

/** Whether `value` names a section. */
export function isIntegrationSection(value: unknown): value is IntegrationSectionName {
    return typeof value === "string" && (INTEGRATION_SECTIONS as readonly string[]).includes(value);
}

/** The host of a STUN URI, lowercased, or `undefined` when it is neither a host name, an IPv4 address nor a bracketed IPv6 address. */
function stunHost(host: string): string | undefined {
    const lower: string = host.toLowerCase();
    if (lower.startsWith("[")) {
        return net.isIPv6(lower.slice(1, -1)) ? lower : undefined;
    }
    return net.isIPv4(lower) || HOST_NAME.test(lower) ? lower : undefined;
}

/**
 * The STUN servers meetings use (`integrations:stun:urls`): `MIN_STUN_URLS` to `MAX_STUN_URLS` `stun:`/`stuns:` URIs with a host and an optional port
 * (1 to 65535), lowercased and each once. They are handed to browsers, never fetched by the server, so a private host isn't refused here. An empty list
 * is refused: the meet plugin takes one as "use the built-in list" (spec 11.3), so saving it would claim "no STUN servers" while meetings still used
 * the public ones; the way back to the built-in list is a reset. A 400 for anything else.
 */
export function normalizeStunUrls(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < MIN_STUN_URLS || value.length > MAX_STUN_URLS) {
        throw invalid(
            `'urls' must be a list of ${MIN_STUN_URLS} to ${MAX_STUN_URLS} STUN servers, such as "stun:stun.example.com:3478"; reset the field for the built-in list.`,
        );
    }
    const result: string[] = [];
    for (const entry of value) {
        const text: string = typeof entry === "string" ? entry.trim() : "";
        const match: RegExpExecArray | null = CONTROL_CHARACTER.test(text) ? null : STUN_URI.exec(text);
        const host: string | undefined = match ? stunHost(match[2]) : undefined;
        const port: number | undefined = match?.[3] !== undefined ? Number(match[3]) : undefined;
        if (!match || !host || (port !== undefined && (port < 1 || port > 65535))) {
            throw invalid(`Each of 'urls' must be a "stun:" or "stuns:" URI with a host and an optional port, such as "stun:stun.example.com:3478".`);
        }
        const url: string = `${match[1].toLowerCase()}:${host}${port !== undefined ? `:${port}` : ""}`;
        if (!result.includes(url)) {
            result.push(url);
        }
    }
    return result;
}

/**
 * A URL the server itself will connect to (an ACME directory, a DoH endpoint, a plugin registry), as sent (trimmed): spec 10.3. It must be `https:`, have
 * a host, carry no user name or password (a credential in a URL would be saved in the database), and its host must not be, or resolve to, a private,
 * loopback, link-local or other non-public address at save time (`isPublicDiscoveryAddress()`, the ranges key discovery refuses too). A name that doesn't
 * resolve passes: nothing can be connected to through it either. The check is on the URL parser's host, so a number-encoded IPv4 address is judged as
 * the address it is. A 400 names `field` and never repeats the value, which could carry a token in its query.
 */
export async function normalizeIntegrationUrl(value: unknown, field: string): Promise<string> {
    const text: string = typeof value === "string" ? value.trim() : "";
    let url: URL | undefined;
    if (text && text.length <= MAX_URL_LENGTH && !CONTROL_CHARACTER.test(text)) {
        try {
            url = new URL(text);
        } catch {
            url = undefined;
        }
    }
    if (!url || url.protocol !== "https:" || !url.hostname) {
        throw invalid(`'${field}' must be an https:// URL of at most ${MAX_URL_LENGTH} characters.`);
    }
    if (url.username || url.password) {
        throw invalid(`'${field}' must not carry a user name or password; set the token in its own field.`);
    }
    const host: string = url.hostname.replace(/^\[|\]$/g, "");
    const isPublic: boolean = net.isIP(host) !== 0 ? isPublicDiscoveryAddress(host) : await resolvesToPublicAddresses(host);
    if (!isPublic) {
        throw invalid(`'${field}' points at a private, loopback or link-local address; it must be reachable on the internet.`);
    }
    return text;
}

/** The signing CA's contact address (`mail:pki:rfc8823:contact_email`): one plain address, trimmed, of at most 254 characters. A 400 naming `field`. */
export function normalizeContactEmail(value: unknown, field: string): string {
    const text: string = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > 254 || !CONTACT_ADDRESS.test(text)) {
        throw invalid(`'${field}' must be an email address.`);
    }
    return text;
}

/** The namespaces of a request, and what it said of their tokens. */
export interface IntegrationNamespacesInput {
    /** The namespaces, without tokens: the route adds each one's envelope. */
    namespaces: Omit<IntegrationPluginNamespace, "token">[];
    /** The new token of each namespace that was sent one. */
    tokens: Record<string, string>;
    /** The namespaces whose saved token was sent back as the mask, so is kept. */
    kept: string[];
}

/**
 * The plugin namespaces of a request (`system:plugins:namespaces`): at most `MAX_INTEGRATION_PLUGIN_NAMESPACES` entries, each a scope as text (`"@acme"`,
 * `"acme"`) or an object `{ name, registry?, token? }`. The scope must be one `normalizePluginNamespaces()` accepts and appear once; `registry` is a URL the
 * server connects to (`normalizeIntegrationUrl()`); `token` is write-only like every secret: a string sets it, the mask keeps the one saved, `null` or
 * leaving it out means none. Unknown fields are a 400 that doesn't repeat them.
 */
export async function normalizeIntegrationNamespaces(value: unknown): Promise<IntegrationNamespacesInput> {
    if (!Array.isArray(value) || value.length > MAX_INTEGRATION_PLUGIN_NAMESPACES) {
        throw invalid(`'namespaces' must be a list of at most ${MAX_INTEGRATION_PLUGIN_NAMESPACES} npm scopes, such as "@acme".`);
    }
    const result: IntegrationNamespacesInput = { namespaces: [], tokens: {}, kept: [] };
    for (const [index, entry] of value.entries()) {
        const raw: Record<string, unknown> | undefined = typeof entry === "string" ? { name: entry } : entry && typeof entry === "object" && !Array.isArray(entry) ? entry : undefined;
        if (!raw || Object.keys(raw).some((key) => !["name", "registry", "token"].includes(key))) {
            throw invalid(`Each of 'namespaces' must be an npm scope, or an object with 'name' and, optionally, 'registry' and 'token'.`);
        }
        let rejected: boolean = false;
        const [normalized]: PluginNamespace[] = normalizePluginNamespaces([{ name: raw.name }], { warn: () => (rejected = true) });
        if (rejected || !normalized) {
            throw invalid(`'namespaces[${index}]' must name an npm scope, such as "@acme".`);
        }
        if (result.namespaces.some((namespace) => namespace.name === normalized.name)) {
            throw invalid(`'namespaces[${index}]' names a scope already on the list.`);
        }
        const namespace: Omit<IntegrationPluginNamespace, "token"> = { name: normalized.name };
        if (raw.registry !== undefined && raw.registry !== null) {
            namespace.registry = await normalizeIntegrationUrl(raw.registry, `namespaces[${index}].registry`);
        }
        result.namespaces.push(namespace);
        const field: string = `namespaces[${index}].token`;
        if (isSecretMask(raw.token)) {
            result.kept.push(namespace.name);
        } else {
            const token: string | null | undefined = toSecretPatch({ [field]: raw.token }, [field])[field];
            if (typeof token === "string") {
                result.tokens[namespace.name] = token;
            }
        }
    }
    return result;
}

/**
 * Validates one field of a section that isn't a secret or the plugin namespaces, which the route seals itself: a 400 naming the field
 * for a wrong value, the normalized value otherwise.
 */
export async function normalizeIntegrationField(section: IntegrationSectionName, field: string, value: unknown): Promise<unknown> {
    switch (`${section}.${field}`) {
        case "giphy.enabled":
            if (typeof value !== "boolean") {
                throw invalid("'enabled' must be true or false.");
            }
            return value;
        case "stun.urls":
            return normalizeStunUrls(value);
        case "signingCa.backend":
            if (!SIGNING_CA_BACKENDS.includes(value as SigningCaBackend)) {
                throw invalid(`'backend' must be one of ${SIGNING_CA_BACKENDS.map((backend) => `"${backend}"`).join(", ")}.`);
            }
            return value;
        case "signingCa.contactEmail":
            return normalizeContactEmail(value, field);
        case "dnsResolver.mode":
            if (!DNS_RESOLVER_MODES.includes(value as DnsResolverMode)) {
                throw invalid(`'mode' must be one of ${DNS_RESOLVER_MODES.map((mode) => `"${mode}"`).join(", ")}.`);
            }
            return value;
        case "signingCa.directoryUrl":
        case "dnsResolver.dohEndpoint":
        case "pluginRegistry.url":
            return await normalizeIntegrationUrl(value, field);
        default:
            throw new Error(`'${section}.${field}' is not a plain field.`);
    }
}

/** A list from config: a list, its JSON text, or comma-separated text (an environment variable); `undefined` for anything else. */
function configList(value: unknown): unknown[] | undefined {
    if (Array.isArray(value)) {
        return value;
    }
    if (typeof value !== "string") {
        return undefined;
    }
    const text: string = value.trim();
    if (text.startsWith("[")) {
        try {
            // JSON text that starts with `[` is a list.
            return JSON.parse(text) as unknown[];
        } catch {
            return undefined;
        }
    }
    return text
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
}

/** Text from config, or `undefined` when unset or empty. */
function configText(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The mask for a secret config sets, else `null`: the view never carries a secret's value. */
function configSecret(value: unknown): SecretMask | null {
    return configText(value) !== undefined ? secretMask() : null;
}

/** `url` without a user name or password in it (`https://user:pass@host/` is `https://host/`), otherwise exactly as written. A deployment may configure
 * a registry with its credentials in the URL (`NpmRegistryClient` sends them as Basic auth); the view never shows them. */
export function withoutUrlCredentials(url: string): string {
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i, "$1");
}

/** `url` with the user name and password of `from`, when it has any. Both are known to parse (`sameRegistryUrl()` said they are the same registry). */
function withUrlCredentialsOf(url: string, from: string): string {
    const credentials: URL = new URL(from.trim());
    if (!credentials.username && !credentials.password) {
        return url;
    }
    const result: URL = new URL(url.trim());
    result.username = credentials.username;
    result.password = credentials.password;
    return result.href;
}

/** A URL from config as the view shows it: without credentials. */
function configUrl(value: unknown): string | undefined {
    const text: string | undefined = configText(value);
    return text !== undefined ? withoutUrlCredentials(text) : undefined;
}

/** Whether `a` and `b` are the same registry: the same URL once parsed, whatever user name or password either carries. Unparsable is never the same. */
export function sameRegistryUrl(a: unknown, b: unknown): boolean {
    const href = (value: unknown): string | undefined => {
        try {
            const url: URL = new URL(typeof value === "string" ? value.trim() : "");
            url.username = "";
            url.password = "";
            return url.href;
        } catch {
            return undefined;
        }
    };
    const left: string | undefined = href(a);
    return left !== undefined && left === href(b);
}

/** `namespaces` without the tokens of those on the default registry (no `registry` of their own): what goes with the deployment's registry stays there. */
function withoutDefaultRegistryTokens<N extends { registry?: string; token?: unknown }>(namespaces: N[]): N[] {
    return namespaces.map((namespace) => {
        if (namespace.registry) {
            return namespace;
        }
        const { token: _token, ...rest } = namespace;
        return rest as N;
    });
}

/**
 * Each section's values as the deployment configures them, read from `config` (flat config keys, as `INTEGRATION_CONFIG_KEYS` names them), with the
 * server's own built-in default where config sets none - what the console's "Reset to deployment default" shows, and what a field the administrator
 * hasn't set takes. Secrets only as the mask, and URLs without the user name or password config may carry. `config` must be the deployment's
 * configuration without the integrations layer, or the administrator's values would be shown as the deployment's.
 */
export function integrationDefaults(config: Record<string, unknown>): IntegrationDefaults {
    const keys = INTEGRATION_CONFIG_KEYS;
    const backend: unknown = config[keys.signingCa.backend];
    const stunUrls: string[] | undefined = configList(config[keys.stun.urls])?.filter((url): url is string => typeof url === "string");
    return {
        giphy: { enabled: isConfigFlagOn(config[keys.giphy.enabled], true), apiKey: configSecret(config[keys.giphy.apiKey]) },
        // An empty list is the meet plugin's built-in list, like none.
        stun: { urls: stunUrls && stunUrls.length > 0 ? stunUrls : null },
        signingCa: {
            // As the server picks its backend: "rfc8823" opts in, anything else is the manual flow ("none" from server step 6 on).
            backend: SIGNING_CA_BACKENDS.includes(backend as SigningCaBackend) ? backend : "manual",
            directoryUrl: configUrl(config[keys.signingCa.directoryUrl]) ?? DEFAULT_RFC8823_DIRECTORY_URL,
            contactEmail: configText(config[keys.signingCa.contactEmail]) ?? null,
        },
        dnsResolver: {
            mode: config[keys.dnsResolver.mode] === "doh-dnssec" ? "doh-dnssec" : "node",
            dohEndpoint: configUrl(config[keys.dnsResolver.dohEndpoint]) ?? DEFAULT_DOH_ENDPOINT,
        },
        pluginRegistry: {
            url: configUrl(config[keys.pluginRegistry.url]) ?? DEFAULT_PLUGIN_REGISTRY,
            token: configSecret(config[keys.pluginRegistry.token]),
            namespaces: normalizePluginNamespaces(config[keys.pluginRegistry.namespaces] ?? DEFAULT_PLUGIN_NAMESPACES).map((namespace) => ({
                name: namespace.name,
                ...(namespace.registry ? { registry: withoutUrlCredentials(namespace.registry) } : {}),
                ...(namespace.token ? { token: secretMask() } : {}),
            })),
        },
    };
}

/** The administrator's value of each field of `section` that is set (`undefined` for one that isn't), in the view's form: secrets as the mask. */
function adminValues(settings: IntegrationSettings | undefined, section: IntegrationSectionName): Record<string, unknown> {
    switch (section) {
        case "giphy":
            return {
                enabled: settings?.giphy?.enabled ?? undefined,
                apiKey: settings?.giphy?.apiKey ? secretMask() : undefined,
            };
        case "pluginRegistry": {
            const registry = settings?.pluginRegistry;
            return {
                url: registry?.url ?? undefined,
                token: registry?.token ? secretMask() : undefined,
                namespaces: registry?.namespaces?.map((namespace) => ({
                    name: namespace.name,
                    ...(namespace.registry ? { registry: namespace.registry } : {}),
                    ...(namespace.token ? { token: secretMask() } : {}),
                })),
            };
        }
        default: {
            const stored: Record<string, unknown> = (settings?.[section]) ?? {};
            return Object.fromEntries(INTEGRATION_SECTION_FIELDS[section].map((field) => [field, stored[field] ?? undefined]));
        }
    }
}

/** The view of `settings` (none before anything was saved) over the deployment's `defaults`: what the route answers with. A registry URL of the
 * administrator's elsewhere than the deployment's shows what `buildIntegrationsConfigLayer()` does with it: no token unless the administrator set one,
 * and the deployment's namespaces without the tokens of those on the default registry. */
export function integrationSettingsView(settings: IntegrationSettings | undefined, defaults: IntegrationDefaults): IntegrationSettingsResponse {
    const response: Partial<IntegrationSettingsResponse> = {};
    for (const section of INTEGRATION_SECTIONS) {
        const admin: Record<string, unknown> = adminValues(settings, section);
        const view: IntegrationSectionView = { values: {}, defaults: { ...defaults[section] }, source: {} };
        for (const field of INTEGRATION_SECTION_FIELDS[section]) {
            const set: boolean = admin[field] !== undefined;
            view.values[field] = set ? admin[field] : defaults[section][field];
            view.source[field] = set ? "admin" : "deployment";
        }
        response[section] = view;
    }
    const registry: IntegrationSectionView = response.pluginRegistry!;
    if (registry.source.url === "admin" && !sameRegistryUrl(registry.values.url, registry.defaults.url)) {
        if (registry.source.token === "deployment") {
            registry.values.token = null;
            registry.source.token = "admin";
        }
        if (registry.source.namespaces === "deployment") {
            registry.values.namespaces = withoutDefaultRegistryTokens(registry.values.namespaces as IntegrationPluginNamespace[]);
        }
    }
    return { ...(response as Record<IntegrationSectionName, IntegrationSectionView>), version: settings?.version ?? 0 };
}

/** The server's integrations config layer, as `buildIntegrationsConfigLayer()` builds it. */
export interface IntegrationsConfigLayer {
    /** The config keys the administrator set, flat (`"giphy:api_key"`), with the secrets' values: never persisted, logged or answered. */
    values: Record<string, unknown>;
    /** The row fields (`giphy.apiKey`, `pluginRegistry.namespaces.@acme.token`) whose secret couldn't be decrypted: left out, so the deployment's value
     * applies, for the caller to warn about (the field only, never why or what). */
    unreadable: string[];
}

/**
 * The config layer the server puts directly below its plugin settings (spec 11.1): exactly the keys the administrator set in `settings`, each overriding
 * the deployment's value, with the secrets decrypted by `cipher` (spec 5.4: the server keeps the layer, and so the plaintext, for the life of the process).
 * Giphy turned off also empties `giphy:api_key`, so a consumer that only reads the key stops using it. A secret that can't be decrypted (a key that isn't in the
 * ring, an envelope from another field, a value that isn't an envelope) is left out and named in `unreadable`; a namespace whose token can't be read is kept
 * without it. Any other failure of the cipher is a bug and is thrown.
 *
 * The deployment's registry credentials stay with the deployment's registry: when the administrator's registry URL is another than the deployment's
 * (`deployment`, its configuration without this layer, flat keys as `integrationDefaults()` takes it), `system:plugins:registry_token` is the
 * administrator's token or `""` (none, also when the administrator's can't be read), and, unless the administrator set the namespaces, the deployment's
 * namespaces are set without the tokens of those on the default registry. Otherwise a token meant for a private registry would go to whatever host the
 * URL names.
 */
export function buildIntegrationsConfigLayer(
    settings: IntegrationSettings | undefined,
    cipher: Pick<ConfigCipher, "decryptString">,
    deployment: Record<string, unknown>,
): IntegrationsConfigLayer {
    const keys = INTEGRATION_CONFIG_KEYS;
    const layer: IntegrationsConfigLayer = { values: {}, unreadable: [] };
    const set = (key: string, value: unknown): void => {
        if (value !== undefined && value !== null) {
            layer.values[key] = value;
        }
    };
    /** The plaintext of the secret `envelope` saved in `field`; `undefined` when there is none or it can't be read (then named in `unreadable`). */
    const secret = (envelope: ConfigEnvelope | null | undefined, field: string): string | undefined => {
        if (envelope === undefined || envelope === null) {
            return undefined;
        }
        try {
            return cipher.decryptString(envelope, integrationSecretContext(field));
        } catch (err) {
            if (!(err instanceof ConfigSecretUnavailableError)) {
                throw err;
            }
            layer.unreadable.push(field);
            return undefined;
        }
    };

    set(keys.giphy.enabled, settings?.giphy?.enabled);
    if (settings?.giphy?.enabled === false) {
        layer.values[keys.giphy.apiKey] = "";
    } else {
        set(keys.giphy.apiKey, secret(settings?.giphy?.apiKey, GIPHY_API_KEY_FIELD));
    }
    set(keys.stun.urls, settings?.stun?.urls);
    for (const field of INTEGRATION_SECTION_FIELDS.signingCa) {
        set(keys.signingCa[field], (settings?.signingCa)?.[field]);
    }
    for (const field of INTEGRATION_SECTION_FIELDS.dnsResolver) {
        set(keys.dnsResolver[field], (settings?.dnsResolver)?.[field]);
    }
    const registry = settings?.pluginRegistry;
    const deploymentRegistry: string = configText(deployment[keys.pluginRegistry.url]) ?? DEFAULT_PLUGIN_REGISTRY;
    const registryUrl: string | undefined = registry?.url;
    const sameRegistry: boolean = registryUrl !== undefined && sameRegistryUrl(registryUrl, deploymentRegistry);
    // The administrator's URL never carries credentials, so for the deployment's own registry the deployment's go with it: they are how a
    // deployment without a registry token authenticates (`NpmRegistryClient` sends them as basic auth).
    set(keys.pluginRegistry.url, registryUrl !== undefined && sameRegistry ? withUrlCredentialsOf(registryUrl, deploymentRegistry) : registryUrl);
    set(keys.pluginRegistry.token, secret(registry?.token, PLUGIN_REGISTRY_TOKEN_FIELD));
    if (registry?.namespaces) {
        layer.values[keys.pluginRegistry.namespaces] = registry.namespaces.map(({ token: envelope, ...namespace }) => {
            const token: string | undefined = secret(envelope, pluginNamespaceTokenField(namespace.name));
            return { ...namespace, ...(token !== undefined ? { token } : {}) };
        });
    }
    if (registry?.url && !sameRegistry) {
        layer.values[keys.pluginRegistry.token] ??= "";
        if (!registry.namespaces) {
            const namespaces: PluginNamespace[] = normalizePluginNamespaces(deployment[keys.pluginRegistry.namespaces] ?? DEFAULT_PLUGIN_NAMESPACES);
            if (namespaces.some((namespace) => namespace.token !== undefined && !namespace.registry)) {
                layer.values[keys.pluginRegistry.namespaces] = withoutDefaultRegistryTokens(namespaces);
            }
        }
    }
    return layer;
}
