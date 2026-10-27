///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("system/integrations")` to its own concrete subclass (see `BaseKeyVaultRoute`'s identical note) - every
// method here is defined relative to that.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { noConfigCipher } from "../dns/DnsProviderCredentials.js";
import type { ConfigCipher } from "../secrets/ConfigCipher.js";
import { toSecretPatch } from "../secrets/SecretMask.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import {
    GIPHY_API_KEY_FIELD,
    INTEGRATION_CONFIG_KEYS,
    INTEGRATION_SECTION_FIELDS,
    INTEGRATION_SETTINGS_UID,
    integrationDefaults,
    integrationSecretContext,
    integrationSettingsView,
    isIntegrationSection,
    normalizeIntegrationField,
    normalizeIntegrationNamespaces,
    pluginNamespaceTokenField,
    PLUGIN_REGISTRY_TOKEN_FIELD,
    type IntegrationNamespacesInput,
    type IntegrationSettingsResponse,
} from "../util/IntegrationSettingsUtils.js";
import { assertAdminScope, DEFAULT_ELEVATION_MAX_AGE_SECONDS } from "../util/MailAccessUtils.js";
import { findOrCreateSingleton } from "../util/MailboxPolicyUtils.js";
import { assertNoPathKeys } from "../util/RequestBodyUtils.js";
import { AuditAction, ConfigEnvelope, IntegrationPluginNamespace, IntegrationSectionName, IntegrationSettings } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Put, Request, RequiresTrustedRole, User: AuthUser } = RouteDecorators;

/** How often a write that lost a race to another write of the settings is applied again to the newer row before it gives up with the 409. */
const MAX_SAVE_ATTEMPTS = 3;

/** The single-value secrets, by section and field: the field path their envelope is bound to (the plugin namespaces' tokens are handled with the
 * namespaces). */
const SECRET_FIELDS: Partial<Record<IntegrationSectionName, Record<string, string>>> = {
    giphy: { apiKey: GIPHY_API_KEY_FIELD },
    pluginRegistry: { token: PLUGIN_REGISTRY_TOKEN_FIELD },
};

/** What a request asked of a section's fields: a validated value, `null` for back to the deployment's (the secret removed), or a secret's new value. */
interface SectionInput {
    plain: Record<string, unknown>;
    secrets: Record<string, string | null>;
    /** `undefined` when not sent, `null` to reset. */
    namespaces?: IntegrationNamespacesInput | null;
}

/** One change to a field of the stored section: a value to set (a secret already sealed) or the field to remove. */
type FieldChange = { kind: "set"; value: unknown } | { kind: "unset" };

/** What a request changes in one section, worked out against the row as read. */
interface SectionPlan {
    changes: Record<string, FieldChange>;
    /** The request's fields that change, for the audit entry. */
    keys: Set<string>;
    secretChanged: boolean;
    /** Set when the request changes the plugin namespaces: the tokens (as saved, by scope) of the row it saw. The list and its tokens are one unit, so a
     * row whose tokens another write changed meanwhile is a 409 rather than one request's list saved with the other's tokens. */
    namespacesSeen?: Record<string, string>;
}

/** The tokens of `namespaces` by scope, each as the text of its envelope: what tells whether two lists carry the same tokens. */
function namespaceTokens(namespaces: IntegrationPluginNamespace[] | null | undefined): Record<string, string> {
    return Object.fromEntries((namespaces ?? []).filter((namespace) => namespace.token).map((namespace) => [namespace.name, JSON.stringify(namespace.token)]));
}

/** Whether `err` is a write refused because the row's version moved on (`RepoUtils.update()`'s optimistic lock). */
function isStaleVersionError(err: any): boolean {
    return err instanceof ApiError && (err as any).code === ApiErrors.INVALID_OBJECT_VERSION;
}

function staleVersion(): ApiError {
    return new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "The integrations were changed by someone else. Reload them and try again.");
}

/** `body` as an object of fields, or a 400. Dotted and `$` keys are refused like everywhere else. */
function asRequest(body: unknown): Record<string, unknown> {
    if (body === undefined || body === null) {
        return {};
    }
    if (typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
    }
    assertNoPathKeys(body);
    return body as Record<string, unknown>;
}

/** The request's `version` (the one the change was made against), or `undefined` when it sent none. */
function requestVersion(body: Record<string, unknown>): number | undefined {
    if (body.version === undefined) {
        return undefined;
    }
    if (typeof body.version !== "number" || !Number.isSafeInteger(body.version) || body.version < 0) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'version' must be the version the settings were read at.");
    }
    return body.version;
}

/**
 * The admin console's Integrations (spec `specs/dns_publishing_and_integrations.md`, 10.2), mounted by the server at `system/integrations`: the
 * third-party services this deployment uses, each section overriding some of the deployment's config keys (`INTEGRATION_CONFIG_KEYS`).
 *
 * - `GET /` every section's values in effect, the deployment's own values (`defaults`, read from config on every request) and where each value comes from
 * (`source`: `"admin"` or `"deployment"`), secrets only as masks.
 * - `PUT /:section` changes a section's fields. A field left out is unchanged, `null` puts it back to the deployment's value, a secret sent back as the
 * mask is kept. Secrets (the Giphy key, the registry token, the namespaces' tokens) are encrypted (`ConfigCipher`, bound to the row and the field) and
 * saved in the row's own write with the rest of the change, so a write that fails changes nothing; without a keyring saving one is a 503.
 * - `POST /:section/reset` (body: optional `keys`, every field when left out) puts fields back to the deployment's values, removing their secrets.
 *
 * Both writes take an optional `version`: a change made against an older one is a 409 before anything is written. A write that changes nothing writes and
 * audits nothing; any other is audited (`INTEGRATION_UPDATE`, `INTEGRATION_RESET`) with the section and the fields, never a value, and announced through
 * `integrationsChanged()`, which the server overrides to rebuild its config layer on every replica.
 *
 * **Access:** reads need a trusted role, writes a trusted role AND an elevated token (`assertAdminScope()`): the plugin registry decides what code the server
 * runs, the DNS resolver what every DNS check believes.
 *
 * The row is created empty by the first change and never copies config into itself (unlike `MailboxPolicy`), so a field the administrator hasn't set keeps
 * following the deployment's configuration.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseIntegrationsRoute<T extends IntegrationSettings> {
    protected abstract integrationSettingsClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so this route can persist an `AuditLogEntry` without depending on either backend directly. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    /** How old an elevated token may be before it has to be elevated again, in seconds (`mail:security:elevation_max_age_seconds`, 0 = no limit). */
    @Config("mail:security:elevation_max_age_seconds", DEFAULT_ELEVATION_MAX_AGE_SECONDS)
    protected elevationMaxAgeSeconds: number = DEFAULT_ELEVATION_MAX_AGE_SECONDS;

    /** Encrypts the secrets the row holds. Unset on a server that registers none: saving a secret is then a 503. */
    @Inject("ConfigCipher")
    protected cipher?: ConfigCipher;

    @Logger
    private logger: any;

    // The deployment's own values of the keys the sections override (`deploymentConfig()`); `null` where config sets none (a `@Config` without a default
    // refuses to build the route over an unset key).
    @Config("giphy:enabled", null)
    private configGiphyEnabled: unknown = null;

    @Config("giphy:api_key", null)
    private configGiphyApiKey: unknown = null;

    @Config("integrations:stun:urls", null)
    private configStunUrls: unknown = null;

    @Config("mail:pki:signing_enrollment:backend", null)
    private configSigningBackend: unknown = null;

    @Config("mail:pki:rfc8823:directory_url", null)
    private configDirectoryUrl: unknown = null;

    @Config("mail:pki:rfc8823:contact_email", null)
    private configContactEmail: unknown = null;

    @Config("mail:dns:resolver", null)
    private configDnsResolver: unknown = null;

    @Config("mail:dns:doh:endpoint", null)
    private configDohEndpoint: unknown = null;

    @Config("system:plugins:registry", null)
    private configRegistry: unknown = null;

    @Config("system:plugins:registry_token", null)
    private configRegistryToken: unknown = null;

    @Config("system:plugins:namespaces", null)
    private configNamespaces: unknown = null;

    protected repo?: RepoUtils<T>;

    /** The `AuditLogEntry` repository, built once by `initialize()`. */
    protected auditLogRepo?: RepoUtils<any>;

    /** Records the audit entries, built once by `initialize()` from `auditLogRepo`. */
    protected auditLogUtils?: AuditLogUtils;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.repo && this.integrationSettingsClass) {
            this.repo = await this._objectFactory.newInstance(RepoUtils, { name: this.integrationSettingsClass.name, args: [this.integrationSettingsClass] });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogRepo) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
    }

    /**
     * The deployment's values of the overridden config keys, flat (`INTEGRATION_CONFIG_KEYS`): the `@Config` values this route was built with. They must
     * not include the server's integrations layer, or the administrator's values would be shown as the deployment's: a server that installs the layer
     * before building this route overrides this to read its configuration without that layer.
     */
    protected deploymentConfig(): Record<string, unknown> {
        const keys = INTEGRATION_CONFIG_KEYS;
        return {
            [keys.giphy.enabled]: this.configGiphyEnabled,
            [keys.giphy.apiKey]: this.configGiphyApiKey,
            [keys.stun.urls]: this.configStunUrls,
            [keys.signingCa.backend]: this.configSigningBackend,
            [keys.signingCa.directoryUrl]: this.configDirectoryUrl,
            [keys.signingCa.contactEmail]: this.configContactEmail,
            [keys.dnsResolver.mode]: this.configDnsResolver,
            [keys.dnsResolver.dohEndpoint]: this.configDohEndpoint,
            [keys.pluginRegistry.url]: this.configRegistry,
            [keys.pluginRegistry.token]: this.configRegistryToken,
            [keys.pluginRegistry.namespaces]: this.configNamespaces,
        };
    }

    /**
     * Called after every saved change with the row as saved. Does nothing here; the server overrides it to tell every replica to rebuild its integrations
     * config layer (spec 11.2). A failure is logged, never the request's: the change is saved, and the replicas catch up on their timer.
     */
    protected async integrationsChanged(_settings: T): Promise<void> {
        // Nothing to tell without a server.
    }

    /** The cipher, or a 503 on a server that has none. */
    private requireCipher(): ConfigCipher {
        if (!this.cipher) {
            throw noConfigCipher("integration secrets");
        }
        return this.cipher;
    }

    private view(settings: T | undefined): IntegrationSettingsResponse {
        return integrationSettingsView(settings, integrationDefaults(this.deploymentConfig()));
    }

    private async findSettings(): Promise<T | undefined> {
        return (await this.repo!.findOne(INTEGRATION_SETTINGS_UID, { ignoreACL: true, skipCache: true })) ?? undefined;
    }

    /** `name` as a section, or a 404. */
    private sectionOf(name: string): IntegrationSectionName {
        if (!isIntegrationSection(name)) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return name;
    }

    /** A 409 when the request was made against a version other than the row's (0 before there is one). */
    private assertVersion(settings: T | undefined, version: number | undefined): void {
        if (version !== undefined && version !== (settings?.version ?? 0)) {
            throw staleVersion();
        }
    }

    @RequiresTrustedRole()
    @Get()
    public async get(): Promise<IntegrationSettingsResponse> {
        return this.view((await this.repo!.findOne(INTEGRATION_SETTINGS_UID, { ignoreACL: true })) ?? undefined);
    }

    @RequiresTrustedRole()
    @Put("/:section")
    public async update(
        @Param("section") name: string,
        obj: unknown,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<IntegrationSettingsResponse> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const section: IntegrationSectionName = this.sectionOf(name);
        const body: Record<string, unknown> = asRequest(obj);
        const version: number | undefined = requestVersion(body);
        const fields: readonly string[] = INTEGRATION_SECTION_FIELDS[section];
        if (Object.keys(body).some((key) => key !== "version" && !fields.includes(key))) {
            // The allowed fields, never the unknown key: a secret sent by mistake as a key would otherwise come back in the response.
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `Unknown field. The fields of '${section}' are: ${fields.join(", ")}.`);
        }

        const input: SectionInput = { plain: {}, secrets: {} };
        for (const field of fields) {
            const value: unknown = body[field];
            if (value === undefined) {
                continue;
            }
            if (SECRET_FIELDS[section]?.[field]) {
                const patch: Record<string, string | null> = toSecretPatch({ [field]: value }, [field]);
                if (field in patch) {
                    input.secrets[field] = patch[field];
                }
            } else if (field === "namespaces") {
                input.namespaces = value === null ? null : await normalizeIntegrationNamespaces(value);
            } else {
                input.plain[field] = value === null ? null : await normalizeIntegrationField(section, field, value);
            }
        }
        return await this.change(section, input, version, AuditAction.INTEGRATION_UPDATE, req, user);
    }

    @RequiresTrustedRole()
    @Post("/:section/reset")
    public async reset(
        @Param("section") name: string,
        obj: unknown,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<IntegrationSettingsResponse> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const section: IntegrationSectionName = this.sectionOf(name);
        const body: Record<string, unknown> = asRequest(obj);
        const version: number | undefined = requestVersion(body);
        const fields: readonly string[] = INTEGRATION_SECTION_FIELDS[section];
        const keys: unknown = body.keys ?? [...fields];
        if (
            Object.keys(body).some((key) => key !== "version" && key !== "keys") ||
            !Array.isArray(keys) ||
            !keys.every((key) => typeof key === "string" && fields.includes(key))
        ) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'keys' must list fields of '${section}': ${fields.join(", ")}.`);
        }

        const input: SectionInput = { plain: {}, secrets: {} };
        for (const key of keys as string[]) {
            if (SECRET_FIELDS[section]?.[key]) {
                input.secrets[key] = null;
            } else if (key === "namespaces") {
                input.namespaces = null;
            } else {
                input.plain[key] = null;
            }
        }
        return await this.change(section, input, version, AuditAction.INTEGRATION_RESET, req, user);
    }

    /** Works out, saves, audits and announces what `input` changes in `section`; answers the view of the settings as they then are. */
    private async change(
        section: IntegrationSectionName,
        input: SectionInput,
        version: number | undefined,
        action: AuditAction,
        req: HttpRequest,
        user: JWTUser | undefined,
    ): Promise<IntegrationSettingsResponse> {
        const existing: T | undefined = await this.findSettings();
        this.assertVersion(existing, version);
        const current: Record<string, any> = ((existing?.[section] as Record<string, any> | null | undefined) ?? {});
        // The request was validated (URL lookups included) before the row was read and its version checked, so nothing slow runs between that check and the
        // write; the new secrets are encrypted here, once, whatever the write has to retry. A request that changes nothing encrypts nothing.
        const plan: SectionPlan = this.plan(section, input, current);
        if (plan.keys.size === 0) {
            return this.view(existing);
        }

        const settings: T = await this.save(section, plan, existing, user);

        const details: Record<string, unknown> = { section, keys: [...plan.keys].sort() };
        if (action === AuditAction.INTEGRATION_UPDATE) {
            details.secretChanged = plan.secretChanged;
        }
        await this.auditLogUtils!.record({ action, targetType: "IntegrationSettings", targetUid: INTEGRATION_SETTINGS_UID, details }, { req, user });
        try {
            await this.integrationsChanged(settings);
        } catch (err: any) {
            this.logger?.warn(`The integrations changed, but the change could not be announced: ${err?.message}`);
        }
        return this.view(settings);
    }

    /**
     * What `input` changes in the stored section `current`: only what really differs, so a request that changes nothing writes nothing. A new secret
     * always counts (a saved one can't be compared with it without decrypting), and is sealed here for its row and field; a 503 without a keyring.
     */
    private plan(section: IntegrationSectionName, input: SectionInput, current: Record<string, any>): SectionPlan {
        const plan: SectionPlan = { changes: {}, keys: new Set(), secretChanged: false };

        for (const [field, value] of Object.entries(input.plain)) {
            if (value === null) {
                if (current[field] !== undefined && current[field] !== null) {
                    plan.changes[field] = { kind: "unset" };
                    plan.keys.add(field);
                }
            } else if (JSON.stringify(current[field] ?? null) !== JSON.stringify(value)) {
                plan.changes[field] = { kind: "set", value };
                plan.keys.add(field);
            }
        }

        for (const [field, value] of Object.entries(input.secrets)) {
            if (value === null) {
                if (current[field] === undefined || current[field] === null) {
                    continue;
                }
                plan.changes[field] = { kind: "unset" };
            } else {
                plan.changes[field] = { kind: "set", value: this.requireCipher().encrypt(value, integrationSecretContext(SECRET_FIELDS[section]![field])) };
            }
            plan.keys.add(field);
            plan.secretChanged = true;
        }

        if (input.namespaces !== undefined) {
            this.planNamespaces(plan, input.namespaces, current);
        }
        return plan;
    }

    /**
     * The plugin namespaces' part of `plan`: the list with each namespace's token inside it. A token sent is sealed for its scope, the mask keeps the token
     * the namespace has now, and any other namespace is saved without one, so a namespace taken off the list loses its token.
     */
    private planNamespaces(plan: SectionPlan, input: IntegrationNamespacesInput | null, current: Record<string, any>): void {
        const saved: IntegrationPluginNamespace[] = current.namespaces ?? [];
        let namespaces: IntegrationPluginNamespace[] | null = null;
        let sealed: number = 0;
        if (input !== null) {
            namespaces = input.namespaces.map((namespace) => {
                const token: string | undefined = input.tokens[namespace.name];
                if (token !== undefined) {
                    sealed++;
                    return { ...namespace, token: this.requireCipher().encrypt(token, integrationSecretContext(pluginNamespaceTokenField(namespace.name))) };
                }
                const kept: ConfigEnvelope | undefined = input.kept.includes(namespace.name) ? saved.find((entry) => entry.name === namespace.name)?.token : undefined;
                return kept ? { ...namespace, token: kept } : namespace;
            });
        }

        if (JSON.stringify(current.namespaces ?? null) === JSON.stringify(namespaces)) {
            return;
        }
        plan.changes.namespaces = namespaces === null ? { kind: "unset" } : { kind: "set", value: namespaces };
        plan.keys.add("namespaces");
        plan.namespacesSeen = namespaceTokens(saved);
        const dropped: boolean = saved.some((entry) => entry.token && !namespaces?.find((namespace) => namespace.name === entry.name)?.token);
        plan.secretChanged ||= sealed > 0 || dropped;
    }

    /** `plan` applied to the stored section `current`: the section to save, `null` once nothing is left in it. A change to the plugin namespaces whose tokens
     * another write changed meanwhile is a 409. Any other field is the plan's: the write saved last wins a field both set. */
    private applyPlan(plan: SectionPlan, current: Record<string, any> | null | undefined): Record<string, any> | null {
        const next: Record<string, any> = { ...(current ?? {}) };
        if (plan.namespacesSeen !== undefined) {
            const now: Record<string, string> = namespaceTokens(next.namespaces);
            const seen: Record<string, string> = plan.namespacesSeen;
            if (Object.keys(now).length !== Object.keys(seen).length || Object.entries(now).some(([name, token]) => seen[name] !== token)) {
                throw staleVersion();
            }
        }
        for (const [field, change] of Object.entries(plan.changes)) {
            if (change.kind === "set") {
                next[field] = change.value;
            } else {
                delete next[field];
            }
        }
        return Object.keys(next).length > 0 ? next : null;
    }

    /**
     * Saves `plan` on the settings row (created empty the first time), with the secrets it carries, in one version-checked write. When another write saved the
     * row first, the plan is applied again to the newer row, field by field, up to `MAX_SAVE_ATTEMPTS` times: the request's version was checked before it.
     */
    private async save(section: IntegrationSectionName, plan: SectionPlan, existing: T | undefined, user: JWTUser | undefined): Promise<T> {
        let row: T | undefined = existing;
        for (let attempt = 1; ; attempt++) {
            row ??= await findOrCreateSingleton(this.repo!, INTEGRATION_SETTINGS_UID);
            const next: Record<string, any> | null = this.applyPlan(plan, row[section] as Record<string, any> | null | undefined);
            try {
                return await this.repo!.update({ uid: row.uid, version: row.version, [section]: next } as any, asEntity(this.repo!, row), {
                    user,
                    version: row.version,
                    ignoreACL: true,
                });
            } catch (err) {
                if (!isStaleVersionError(err) || attempt >= MAX_SAVE_ATTEMPTS) {
                    throw err;
                }
                row = await this.findSettings();
            }
        }
    }
}
