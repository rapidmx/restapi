///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("system/integrations")` to its own concrete subclass (see `BaseKeyVaultRoute`'s identical note) - every
// method here is defined relative to that.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { NullSecretStore } from "../secrets/NullSecretStore.js";
import { toSecretPatch } from "../secrets/SecretMask.js";
import type { SecretStore } from "../secrets/SecretStore.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import {
    GIPHY_SECRET_PATH,
    INTEGRATION_CONFIG_KEYS,
    INTEGRATION_SECTION_FIELDS,
    INTEGRATION_SETTINGS_UID,
    integrationDefaults,
    integrationSecretPath,
    integrationSettingsView,
    isIntegrationSection,
    normalizeIntegrationField,
    normalizeIntegrationNamespaces,
    pluginNamespaceTokenKey,
    PLUGIN_NAMESPACES_SECRET_PATH,
    PLUGIN_REGISTRY_SECRET_PATH,
    type IntegrationNamespacesInput,
    type IntegrationSettingsResponse,
} from "../util/IntegrationSettingsUtils.js";
import { assertAdminScope, DEFAULT_ELEVATION_MAX_AGE_SECONDS } from "../util/MailAccessUtils.js";
import { findOrCreateSingleton } from "../util/MailboxPolicyUtils.js";
import { assertNoPathKeys } from "../util/RequestBodyUtils.js";
import { AuditAction, IntegrationSectionName, IntegrationSettings, SecretRef } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Put, Request, RequiresTrustedRole, User: AuthUser } = RouteDecorators;

/** How often a write that lost a race to another write of the settings is applied again to the newer row before it gives up with the 409. */
const MAX_SAVE_ATTEMPTS = 3;

/** A section's secret field kept as one key of one secret: the row field holding its reference, the path its writes go under, and its key there. */
interface SecretField {
    refField: string;
    base: string;
    key: string;
}

/** The single-value secrets (the plugin namespaces' tokens are handled with the namespaces). */
const SECRET_FIELDS: Partial<Record<IntegrationSectionName, Record<string, SecretField>>> = {
    giphy: { apiKey: { refField: "apiKeyRef", base: GIPHY_SECRET_PATH, key: "apiKey" } },
    pluginRegistry: { token: { refField: "tokenRef", base: PLUGIN_REGISTRY_SECRET_PATH, key: "token" } },
};

/** What a request asked of a section's fields: a validated value, `null` for back to the deployment's (the secret removed), or a secret's new value. */
interface SectionInput {
    plain: Record<string, unknown>;
    secrets: Record<string, string | null>;
    /** `undefined` when not sent, `null` to reset. */
    namespaces?: IntegrationNamespacesInput | null;
}

/**
 * One change to a field of the stored section. A store write becomes a `setRef` of the reference the store returns, once it has run. A write goes to a
 * path of its own (`integrationSecretPath()` under `base`), never over the secret in use; `keep` names the keys it carries over from the secret it
 * replaces (read from the store when it runs).
 */
type FieldChange =
    | { kind: "set"; value: unknown }
    | { kind: "unset" }
    | { kind: "setRef"; ref: SecretRef }
    | { kind: "unsetRef"; seen: SecretRef }
    | { kind: "write"; base: string; values: Record<string, string>; keep?: { ref: SecretRef; keys: string[] } };

/** What a request changes in one section, worked out against the row as read. */
interface SectionPlan {
    changes: Record<string, FieldChange>;
    /** The request's fields that change, for the audit entry. */
    keys: Set<string>;
    secretChanged: boolean;
    /** A secret replaced or cleared was in a backend this deployment doesn't use, so it was left there. */
    secretLeftBehind: boolean;
    /** Set when the request changes the plugin namespaces: the tokens' reference it saw (`null` for none). The list and its tokens are one unit, so a
     * row whose tokens another write changed meanwhile is a 409 rather than one request's list saved with the other's tokens. */
    namespacesSeen?: SecretRef | null;
}

/** Whether the references `a` and `b` (either may be none) are the same secret. */
function sameRef(a: SecretRef | null | undefined, b: SecretRef | null | undefined): boolean {
    return !a || !b ? !a && !b : a.backend === b.backend && a.path === b.path && a.generation === b.generation;
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
 * mask is kept. Secrets (the Giphy key, the registry token, the namespaces' tokens) are written to the `SecretStore` before the row, under `server/...`,
 * so the row holds references only; with no store (`NullSecretStore`) saving one is a 400. Each write goes to a new path, and the secret the row named
 * before is removed once the row is saved: a row that can't be saved leaves the secret in use as it was.
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

    /** Where secrets go. The server registers OpenBao or Kubernetes Secrets; `NullSecretStore` refuses to save any. */
    @Inject("SecretStore")
    private secretStore?: SecretStore;

    /** What stands in for a store on a server that registers none: saving a secret is the same 400 as with `NullSecretStore`. */
    private readonly noSecretStore: SecretStore = new NullSecretStore();

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

    private store(): SecretStore {
        return this.secretStore ?? this.noSecretStore;
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
        const plan: SectionPlan = this.plan(section, input, current);
        if (plan.keys.size === 0) {
            return this.view(existing);
        }

        // The secrets first, so the row never names one that wasn't saved. The request was validated (URL lookups included) before the row was read and
        // its version checked, so nothing slow runs between that check and the store; a write racing in during the store call is merged by `save()`.
        const written: SecretRef[] = [];
        let saved: { settings: T; removed: SecretRef[] };
        try {
            for (const [field, change] of Object.entries(plan.changes)) {
                if (change.kind === "write") {
                    // The kept keys are carried over from the secret in use (a key it no longer holds is dropped), then the new values.
                    const previous: Record<string, string> = change.keep ? await this.store().read(change.keep.ref) : {};
                    const carried: [string, string][] = (change.keep?.keys ?? []).filter((key) => key in previous).map((key) => [key, previous[key]]);
                    const ref: SecretRef = await this.store().write(integrationSecretPath(change.base), { ...Object.fromEntries(carried), ...change.values });
                    written.push(ref);
                    plan.changes[field] = { kind: "setRef", ref };
                }
            }
            saved = await this.save(section, plan, existing, user);
        } catch (err) {
            // A store write that failed after another succeeded, or the row: the secrets this request wrote are at paths of their own, so removing
            // them leaves the store as it was.
            await this.discardWritten(section, written);
            throw err;
        }

        let secretLeftBehind: boolean = plan.secretLeftBehind;
        // After the row: a failure leaves a secret nothing refers to, never a row whose secret is gone.
        for (const ref of saved.removed) {
            try {
                await this.store().delete(ref);
            } catch (err: any) {
                this.logger?.warn(`Could not remove the integration secret at '${ref.path}' from the secret store: ${err?.message}`);
                secretLeftBehind = true;
            }
        }

        const details: Record<string, unknown> = { section, keys: [...plan.keys].sort() };
        if (action === AuditAction.INTEGRATION_UPDATE) {
            details.secretChanged = plan.secretChanged;
        }
        if (secretLeftBehind) {
            details.secretLeftBehind = true;
        }
        await this.auditLogUtils!.record({ action, targetType: "IntegrationSettings", targetUid: INTEGRATION_SETTINGS_UID, details }, { req, user });
        try {
            await this.integrationsChanged(saved.settings);
        } catch (err: any) {
            this.logger?.warn(`The integrations changed, but the change could not be announced: ${err?.message}`);
        }
        return this.view(saved.settings);
    }

    /** What `input` changes in the stored section `current`: only what really differs, so a request that changes nothing writes nothing. */
    private plan(section: IntegrationSectionName, input: SectionInput, current: Record<string, any>): SectionPlan {
        const plan: SectionPlan = { changes: {}, keys: new Set(), secretChanged: false, secretLeftBehind: false };
        const backend: string = this.store().backend;
        /** The change that removes the reference `ref` from the row (deleting the secret after the row unless it's in another backend). */
        const removeRef = (refField: string, ref: SecretRef): void => {
            plan.changes[refField] = { kind: "unsetRef", seen: ref };
            if (ref.backend !== backend) {
                plan.secretLeftBehind = true;
            }
        };

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
            const secret: SecretField = SECRET_FIELDS[section]![field];
            const ref: SecretRef | undefined = current[secret.refField] ?? undefined;
            if (value === null) {
                if (!ref) {
                    continue;
                }
                removeRef(secret.refField, ref);
            } else {
                // The whole secret is this one value, so it is written afresh, also over one in a backend this deployment doesn't use (left there).
                plan.changes[secret.refField] = { kind: "write", base: secret.base, values: { [secret.key]: value } };
                plan.secretLeftBehind ||= !!ref && ref.backend !== backend;
            }
            plan.keys.add(field);
            plan.secretChanged = true;
        }

        if (input.namespaces !== undefined) {
            this.planNamespaces(plan, input.namespaces, current, removeRef);
        }
        return plan;
    }

    /** The plugin namespaces' part of `plan`: the list on the row, and their tokens in one secret, one key per namespace. */
    private planNamespaces(
        plan: SectionPlan,
        input: IntegrationNamespacesInput | null,
        current: Record<string, any>,
        removeRef: (refField: string, ref: SecretRef) => void,
    ): void {
        const ref: SecretRef | undefined = current.namespaceTokensRef ?? undefined;
        this.planNamespaceChanges(plan, input, current, ref, removeRef);
        if (plan.keys.has("namespaces")) {
            plan.namespacesSeen = ref ?? null;
        }
    }

    /** `planNamespaces()`'s changes: the list, and the secret holding the tokens (`ref`, the one the row names). */
    private planNamespaceChanges(
        plan: SectionPlan,
        input: IntegrationNamespacesInput | null,
        current: Record<string, any>,
        ref: SecretRef | undefined,
        removeRef: (refField: string, ref: SecretRef) => void,
    ): void {
        if (input === null) {
            if (current.namespaces !== undefined && current.namespaces !== null) {
                plan.changes.namespaces = { kind: "unset" };
                plan.keys.add("namespaces");
            }
            if (ref) {
                removeRef("namespaceTokensRef", ref);
                plan.keys.add("namespaces");
                plan.secretChanged = true;
            }
            return;
        }

        if (JSON.stringify(current.namespaces ?? null) !== JSON.stringify(input.namespaces)) {
            plan.changes.namespaces = { kind: "set", value: input.namespaces };
            plan.keys.add("namespaces");
        }
        const saved: string[] = ref?.keys ?? [];
        const foreign: boolean = !!ref && ref.backend !== this.store().backend;
        const kept: string[] = input.kept.map(pluginNamespaceTokenKey).filter((key) => saved.includes(key));
        if (foreign && kept.length > 0) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                `The plugin namespaces' tokens are in the ${ref!.backend} secret store, which this deployment doesn't use - enter every token again.`,
            );
        }
        const values: Record<string, string> = {};
        for (const [name, token] of Object.entries(input.tokens)) {
            values[pluginNamespaceTokenKey(name)] = token;
        }
        const removed: string[] = saved.filter((key) => !kept.includes(key) && !(key in values));
        if (Object.keys(values).length === 0 && removed.length === 0) {
            return;
        }
        plan.keys.add("namespaces");
        plan.secretChanged = true;
        if (Object.keys(values).length === 0 && kept.length === 0) {
            removeRef("namespaceTokensRef", ref!);
        } else {
            // A new secret with the kept tokens and the new ones; the one the row named is removed once the row is saved (left, when foreign).
            plan.changes.namespaceTokensRef = { kind: "write", base: PLUGIN_NAMESPACES_SECRET_PATH, values, ...(kept.length > 0 ? { keep: { ref: ref!, keys: kept } } : {}) };
            plan.secretLeftBehind ||= foreign;
        }
    }

    /**
     * `plan` applied to the stored section `current`: the section to save (`null` once nothing is left in it), and the secrets to remove from the store
     * once it is saved. A reference the store gave this request replaces whatever the row names now (the last write saved wins), and that secret is
     * removed; a reference this request clears is only cleared (and its secret removed) while the row still holds the one it saw. A change to the plugin
     * namespaces whose tokens another write changed meanwhile is a 409.
     */
    private applyPlan(plan: SectionPlan, current: Record<string, any> | null | undefined): { section: Record<string, any> | null; removed: SecretRef[] } {
        const next: Record<string, any> = { ...(current ?? {}) };
        if (plan.namespacesSeen !== undefined && !sameRef(next.namespaceTokensRef, plan.namespacesSeen)) {
            throw staleVersion();
        }
        const removed: SecretRef[] = [];
        const backend: string = this.store().backend;
        for (const [field, change] of Object.entries(plan.changes)) {
            const now: SecretRef | undefined = next[field] ?? undefined;
            if (change.kind === "set") {
                next[field] = change.value;
            } else if (change.kind === "unset") {
                delete next[field];
            } else if (change.kind === "setRef") {
                next[field] = change.ref;
                // The secret replaced: the one this request saw, or one another write saved meanwhile. One in another backend is left there.
                if (now && now.backend === backend) {
                    removed.push(now);
                }
            } else if (change.kind === "unsetRef" && sameRef(now, change.seen)) {
                delete next[field];
                if (change.seen.backend === backend) {
                    removed.push(change.seen);
                }
            }
        }
        return { section: Object.keys(next).length > 0 ? next : null, removed };
    }

    /**
     * Saves `plan` on the settings row (created empty the first time). When another write saved the row first, the plan is applied again to the newer row,
     * field by field, up to `MAX_SAVE_ATTEMPTS` times: by then any secret is already in the store, and the request's version was checked before it.
     */
    private async save(section: IntegrationSectionName, plan: SectionPlan, existing: T | undefined, user: JWTUser | undefined): Promise<{ settings: T; removed: SecretRef[] }> {
        let row: T | undefined = existing;
        for (let attempt = 1; ; attempt++) {
            row ??= await findOrCreateSingleton(this.repo!, INTEGRATION_SETTINGS_UID);
            const { section: next, removed } = this.applyPlan(plan, row[section] as Record<string, any> | null | undefined);
            try {
                const settings: T = await this.repo!.update({ uid: row.uid, version: row.version, [section]: next } as any, asEntity(this.repo!, row), {
                    user,
                    version: row.version,
                    ignoreACL: true,
                });
                return { settings, removed };
            } catch (err) {
                if (!isStaleVersionError(err) || attempt >= MAX_SAVE_ATTEMPTS) {
                    throw err;
                }
                row = await this.findSettings();
            }
        }
    }

    /**
     * After the row couldn't be saved: removes each secret this request wrote (each at a path of its own, so the secrets in use are untouched), unless the
     * row names it after all (a save that failed after it was applied), which is logged. While the row can't be read back, they are left in the store
     * and logged: a secret nothing refers to does no harm, a row naming one that is gone would. Never throws.
     */
    private async discardWritten(section: IntegrationSectionName, written: SecretRef[]): Promise<void> {
        if (written.length === 0) {
            return;
        }
        let saved: Record<string, any>;
        try {
            saved = ((await this.findSettings())?.[section] as Record<string, any> | null | undefined) ?? {};
        } catch (err: any) {
            this.logger?.warn(`The integration secrets at ${written.map((ref) => `'${ref.path}'`).join(", ")} were left in the secret store: ${err?.message}`);
            return;
        }
        for (const ref of written) {
            // Any other value of the section (a switch, the namespaces list) is never the same as a reference.
            if (Object.values(saved).some((value) => sameRef(value, ref))) {
                this.logger?.error(`The integration secret at '${ref.path}' was saved with the settings, although saving them failed.`);
                continue;
            }
            try {
                await this.store().delete(ref);
            } catch (err: any) {
                this.logger?.warn(`Could not remove the integration secret at '${ref.path}' from the secret store: ${err?.message}`);
            }
        }
    }
}
