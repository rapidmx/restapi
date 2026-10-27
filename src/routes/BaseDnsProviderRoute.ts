///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("system/dns-providers")` to its own concrete subclass (see `BaseKeyVaultRoute`'s identical note) - every
// method here is defined relative to that.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { DEFAULT_PUBLISH_TTL, domainDnsRecordsV1, domainEndpointSetId, domainProvider, zoneCoverage } from "../dns/DnsDesiredState.js";
import type { DnsRecordV1 } from "../dns/DnsDesiredStateApiV1.js";
import { noConfigCipher, savedCredentialKeys, sealDnsCredentials } from "../dns/DnsProviderCredentials.js";
import { notifyDnsPublisher, resolveDnsPublisher, type DnsPublisher } from "../dns/DnsPublisher.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import {
    assertDnsProviderCredentials,
    assertDnsProviderSecretValues,
    dnsProviderSecretKeys,
    getDnsProviderType,
    isNameInZones,
    listDnsProviderTypes,
    newDnsProviderUid,
    normalizeDnsProviderOptions,
    normalizeDnsZones,
    type DnsProviderTypeInfo,
    type DnsProviderTypeSpec,
} from "../dns/DnsProviderTypes.js";
import type { ConfigCipher } from "../secrets/ConfigCipher.js";
import { maskCredentials, toSecretPatch, type SecretMask } from "../secrets/SecretMask.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import {
    autodiscoverHostnameFor,
    DNS_CONTROLLER_STATE_UID,
    findAllRows,
    queueDnsOperation,
    toPublicDnsOperation,
    type PublicDnsOperation,
} from "../util/DnsPublishingUtils.js";
import { buildDesiredDnsRecords, dnsManualReason } from "../util/DnsSetupUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { assertAdminScope, DEFAULT_ELEVATION_MAX_AGE_SECONDS } from "../util/MailAccessUtils.js";
import { assertNoPathKeys, isDuplicateKeyError } from "../util/RequestBodyUtils.js";
import {
    AuditAction,
    ConfigEnvelope,
    DnsControllerState,
    DnsOperation,
    DnsProvider,
    DnsProviderOptionValue,
    DnsProviderStatus,
    DnsProviderType,
    DnsRecordType,
    Domain,
} from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Delete, Get, Param, Post, Put, Request, RequiresTrustedRole, User: AuthUser } = RouteDecorators;

/** The longest display name a provider config takes. */
export const MAX_DNS_PROVIDER_NAME_LENGTH = 100;

/** The most operations `GET /:id/operations` lists: the latest. */
const OPERATIONS_LISTED = 50;

/** What `GET /controller` answers: what the DNS controller last said about itself, `null` for what it never said. */
export interface PublicDnsControllerState {
    handshake: DnsControllerState["handshake"] | null;
    lastReport: DnsControllerState["lastReport"] | null;
    lastStandbyReport: DnsControllerState["lastStandbyReport"] | null;
}

/** What a name another config already has is refused with: by the check before anything is written, and by the unique index when two writes race. */
const NAME_TAKEN_MESSAGE: string = "A DNS provider with this name already exists.";

/** What a change made against an older version of the config is refused with, the same as `RepoUtils.update()`'s own optimistic-lock failure. */
function staleVersion(): ApiError {
    return new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "This DNS provider was changed by someone else. Reload it and try again.");
}

/** `err` with a unique-index violation (only the name's can happen here) turned into the same 409 as the name check before the write. */
function mapNameTaken(err: any): any {
    return isDuplicateKeyError(err) ? new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, NAME_TAKEN_MESSAGE) : err;
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER: RegExp = /[\u0000-\u001f\u007f-\u009f]/;

/** The wire shape of a `DnsProvider`: its credentials only as masks (one per key saved), never an envelope, plus how many domains it publishes. */
export interface PublicDnsProvider {
    uid: string;
    name: string;
    type: DnsProviderType;
    zones: string[];
    options: Record<string, DnsProviderOptionValue>;
    credentials: Record<string, SecretMask>;
    origin?: "installer" | "console";
    enabled: boolean;
    allowTakeover: boolean;
    status?: DnsProviderStatus;
    /** The domains assigned to this config (`Domain.dnsProviderUid`). */
    domainCount: number;
    version: number;
    dateCreated?: Date;
    dateModified?: Date;
}

/** What `POST /` and `PUT /:id` take. `credentials` is write-only: a string sets a field, `null` clears it, the mask or leaving it out keeps it. */
export interface DnsProviderRequest {
    name?: unknown;
    type?: unknown;
    zones?: unknown;
    options?: unknown;
    credentials?: unknown;
    enabled?: unknown;
    allowTakeover?: unknown;
    /** `PUT` only: the version the change was made against; a newer row is a 409. */
    version?: unknown;
}

/** `body` as an object of fields, or a 400. Dotted and `$` keys are refused like everywhere else. */
function asRequest(body: unknown): DnsProviderRequest {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
    }
    assertNoPathKeys(body);
    return body;
}

/** A display name: text of 1 to `MAX_DNS_PROVIDER_NAME_LENGTH` characters after trimming, with no control characters. */
function validateName(value: unknown): string {
    const name: string | undefined = typeof value === "string" ? value.trim() : undefined;
    if (!name || name.length > MAX_DNS_PROVIDER_NAME_LENGTH || CONTROL_CHARACTER.test(name)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'name' must be text of 1 to ${MAX_DNS_PROVIDER_NAME_LENGTH} characters.`);
    }
    return name;
}

/** `value` when it is a boolean, `fallback` when it was left out, else a 400 naming `key`. */
function optionalBoolean(value: unknown, key: string, fallback: boolean): boolean {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "boolean") {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${key}' must be true or false.`);
    }
    return value;
}

/** The keys set after `patch` (from `toSecretPatch()`) is applied to the keys saved now. */
function keysAfterPatch(saved: readonly string[], patch: Record<string, string | null>): string[] {
    const keys: Set<string> = new Set(saved);
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) {
            keys.delete(key);
        } else {
            keys.add(key);
        }
    }
    return [...keys].sort();
}

/** The option keys whose value differs between `before` and `after`. */
function changedOptionKeys(before: Record<string, DnsProviderOptionValue>, after: Record<string, DnsProviderOptionValue>): string[] {
    const keys: Set<string> = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).sort();
}

/**
 * The DNS provider configs (`DnsProvider`) the server publishes domain records through, mounted by the server at `system/dns-providers`:
 *
 * - `GET /types` the provider types, their options, credential fields and whether they are live-tested: what the console's form is built from.
 * - `GET /` and `GET /:id` the configs, credentials shown only as masks (one per key saved), with the number of domains assigned to each.
 * - `POST /` creates one. Credentials are encrypted (`ConfigCipher`, bound to the row and the field) and saved in the row's own write, with
 * `credentialsGeneration` 1; without a keyring, saving credentials is a 503. A zone another config has is a 409.
 * - `PUT /:id` changes one, in one versioned write of the row: a write that loses a race is a 409 and changes nothing. Credentials are write-only: a field
 * sent as the mask, or not sent, is kept; `null` clears it (`credentials` is `null` once none is left); any change bumps `credentialsGeneration`. `type`
 * never changes, the zones can't be narrowed while a domain assigned to the config would fall outside them, and can't take one another config has or cover a domain assigned to another config more specifically (409).
 * - `DELETE /:id` removes one: 409 while any domain is assigned to it; its credentials go with the row.
 *
 * **Access:** reads need a trusted role, every write a trusted role AND an elevated token (`assertAdminScope()`): credentials that can edit a zone can
 * redirect its mail. Every write is audited with the keys that changed, never a credential's value.
 *
 * - `POST /:id/test` and `POST /:id/takeover` queue an operation the DNS controller runs (a credentials test, the takeover of records this deployment
 * doesn't own yet); `GET /:id/operations` lists a config's latest ones with their results.
 * - `GET /controller` says what the DNS controller last reported about itself: its handshake (API versions) and its last status report.
 *
 * Every change that moves what is published is announced to the controller (`DnsPublisher`).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseDnsProviderRoute<T extends DnsProvider> {
    protected abstract dnsProviderClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so a config's assigned domains can be counted and checked. */
    protected abstract domainClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so this route can persist an `AuditLogEntry` without depending on either backend directly. */
    protected abstract auditLogClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses: the operations queued for the DNS controller. */
    protected dnsOperationClass?: any;

    /** Supplied by the Mongo/SQL concrete subclasses: what the DNS controller last said about itself. */
    protected dnsControllerStateClass?: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    /** How old an elevated token may be before it has to be elevated again, in seconds (`mail:security:elevation_max_age_seconds`, 0 = no limit). */
    @Config("mail:security:elevation_max_age_seconds", DEFAULT_ELEVATION_MAX_AGE_SECONDS)
    protected elevationMaxAgeSeconds: number = DEFAULT_ELEVATION_MAX_AGE_SECONDS;

    /** Encrypts the credentials the row holds. Unset on a server that registers none: saving a credential is then a 503. */
    @Inject("ConfigCipher")
    protected cipher?: ConfigCipher;

    @Logger
    private logger: any;

    /** What a takeover's audit entry records the old values with. */
    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

    /** The deployment's mail host, the Autodiscover URL and the TTL: what a takeover's records are built with, exactly as the desired state builds them. */
    @Config("mail:dns:mx_hostname", "")
    private mxHostname: string = "";

    @Config("mail:autodiscover:public_url", "")
    private autodiscoverPublicUrl: string = "";

    @Config("mail:dns:publish:ttl", DEFAULT_PUBLISH_TTL)
    private publishTtlSeconds: number = DEFAULT_PUBLISH_TTL;

    /** Announces changes to the DNS desired state; `NullDnsPublisher` on a server that registers none. */
    protected dnsPublisher?: DnsPublisher;

    protected operationRepo?: RepoUtils<DnsOperation>;

    protected controllerStateRepo?: RepoUtils<DnsControllerState>;

    protected repo?: RepoUtils<T>;

    protected domainRepo?: RepoUtils<Domain>;

    /** The `AuditLogEntry` repository, built once by `initialize()`. */
    protected auditLogRepo?: RepoUtils<any>;

    /** Records the audit entries, built once by `initialize()` from `auditLogRepo`. */
    protected auditLogUtils?: AuditLogUtils;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.repo && this.dnsProviderClass) {
            this.repo = await this._objectFactory.newInstance(RepoUtils, { name: this.dnsProviderClass.name, args: [this.dnsProviderClass] });
        }
        if (!this.domainRepo && this.domainClass) {
            this.domainRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.domainClass.name, args: [this.domainClass] });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogRepo) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
        if (!this.operationRepo && this.dnsOperationClass) {
            this.operationRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.dnsOperationClass.name, args: [this.dnsOperationClass] });
        }
        if (!this.controllerStateRepo && this.dnsControllerStateClass) {
            this.controllerStateRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.dnsControllerStateClass.name, args: [this.dnsControllerStateClass] });
        }
        if (!this.dnsPublisher) {
            this.dnsPublisher = await resolveDnsPublisher(this._objectFactory, this.logger);
        }
    }

    /** Announces that the config `uid`'s part of the desired state changed. Never throws. */
    private async announce(uid: string): Promise<void> {
        await notifyDnsPublisher(this.dnsPublisher, { scope: "provider", providerUid: uid }, this.logger);
    }

    private async audit(req: HttpRequest, user: JWTUser | undefined, action: AuditAction, provider: DnsProvider, details: Record<string, unknown>): Promise<void> {
        await this.auditLogUtils!.record({ action, targetType: "DnsProvider", targetUid: provider.uid, details }, { req, user });
    }

    private async findProvider(id: string, skipCache: boolean = false): Promise<T> {
        const provider: T | undefined = await this.repo!.findOne(id, { ignoreACL: true, skipCache });
        if (!provider) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return provider;
    }

    /** How many domains are assigned to the config `uid`. */
    private async domainCount(uid: string): Promise<number> {
        return await this.domainRepo!.count({ dnsProviderUid: uid } as any, { ignoreACL: true });
    }

    /** A 409 when another config (not `exceptUid`) already has `name`, compared case-insensitively. Two writes racing past this are caught by the unique
     * index on `nameKey`. Compared here rather than in a query, where a name such as `eq(x)` would be read as a search operator. */
    private async assertNameFree(name: string, exceptUid?: string): Promise<void> {
        const nameKey: string = name.toLowerCase();
        const all: T[] = await findAllRows<T>(this.repo!, {});
        if (all.some((provider) => provider.uid !== exceptUid && provider.name.toLowerCase() === nameKey)) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, NAME_TAKEN_MESSAGE);
        }
    }

    /**
     * A 409 when another config (not `exceptUid`) already has one of `zones`. The DNS controller refuses a desired state in which two configs list one zone
     * (two external-dns instances could not be told apart there), which would stall every config's publishing, so the admin learns it here. Zones that
     * nest (`mail.example.com` under `example.com`) are different zones and fine.
     */
    private async assertZonesFree(zones: readonly string[], exceptUid?: string): Promise<void> {
        const all: T[] = await findAllRows<T>(this.repo!, {});
        for (const other of all) {
            const shared: string | undefined = other.uid === exceptUid ? undefined : zones.find((zone) => other.zones.includes(zone));
            if (shared) {
                throw new ApiError(
                    ApiErrors.IDENTIFIER_EXISTS,
                    409,
                    `The zone '${shared}' is already used by the DNS provider '${other.name}' - a zone belongs to one DNS provider only.`,
                );
            }
        }
    }

    /**
     * A 409 when `zones` (the zones a create or update adds) would cover a domain assigned to another config more specifically than that config's own zones:
     * the new config's instance would take the zone over, and the other's leaves it out (7.4), so the domain's records would be deleted and nothing would
     * publish them again until it is assigned to this config, which the assignment route accepts only once the config has the zone. Assigned domains whose
     * config no longer covers them are manual already and left alone.
     */
    private async assertNoAssignedDomainTaken(zones: readonly string[], uid?: string): Promise<void> {
        if (zones.length === 0) {
            return;
        }
        for (const other of await findAllRows<T>(this.repo!, {})) {
            if (other.uid === uid) {
                continue;
            }
            const assigned: Domain[] = await findAllRows<Domain>(this.domainRepo!, { dnsProviderUid: other.uid });
            const taken: Domain | undefined = assigned.find((domain) => {
                const current: number = zoneCoverage(domain.name, other.zones);
                return current >= 0 && zoneCoverage(domain.name, zones) > current;
            });
            if (taken) {
                throw new ApiError(
                    ApiErrors.IDENTIFIER_EXISTS,
                    409,
                    `'${taken.name}' is assigned to the DNS provider '${other.name}' but the zones to add cover it more specifically - set it to manual first, then assign it to this DNS provider.`,
                );
            }
        }
    }

    /** The cipher, or a 503 on a server that has none. */
    private requireCipher(): ConfigCipher {
        if (!this.cipher) {
            throw noConfigCipher();
        }
        return this.cipher;
    }

    private toPublic(provider: T, domainCount: number): PublicDnsProvider {
        return {
            uid: provider.uid,
            name: provider.name,
            type: provider.type,
            zones: [...provider.zones],
            options: { ...provider.options },
            credentials: maskCredentials(provider.credentials),
            ...(provider.origin ? { origin: provider.origin } : {}),
            enabled: provider.enabled,
            allowTakeover: provider.allowTakeover,
            ...(provider.status ? { status: provider.status } : {}),
            domainCount,
            version: provider.version,
            dateCreated: provider.dateCreated,
            dateModified: provider.dateModified,
        };
    }

    /** Validates `body.credentials` for `spec`: the `toSecretPatch()` of it, each value in its field's format. */
    private secretPatch(spec: DnsProviderTypeSpec, credentials: unknown): Record<string, string | null> {
        const { fields, multiLineFields } = dnsProviderSecretKeys(spec);
        const patch: Record<string, string | null> = toSecretPatch(credentials, fields, multiLineFields);
        assertDnsProviderSecretValues(spec, patch);
        return patch;
    }

    @RequiresTrustedRole()
    @Get("/types")
    public types(): DnsProviderTypeInfo[] {
        return listDnsProviderTypes();
    }

    /** What the DNS controller last said about itself: its handshake (so the console can say "the controller speaks another API version"), the Lease
     * holder's last status report, and the last report of a pod that didn't hold the Lease. A trusted role. */
    @RequiresTrustedRole()
    @Get("/controller")
    public async controller(): Promise<PublicDnsControllerState> {
        const state: DnsControllerState | undefined = this.controllerStateRepo ? await this.controllerStateRepo.findOne(DNS_CONTROLLER_STATE_UID, { ignoreACL: true, skipCache: true }) : undefined;
        return { handshake: state?.handshake ?? null, lastReport: state?.lastReport ?? null, lastStandbyReport: state?.lastStandbyReport ?? null };
    }

    @RequiresTrustedRole()
    @Get()
    public async list(): Promise<PublicDnsProvider[]> {
        const providers: T[] = await findAllRows<T>(this.repo!, {});
        const result: PublicDnsProvider[] = [];
        for (const provider of providers) {
            result.push(this.toPublic(provider, await this.domainCount(provider.uid)));
        }
        return result.sort((a, b) => a.name.localeCompare(b.name));
    }

    @RequiresTrustedRole()
    @Get("/:id")
    public async get(@Param("id") id: string): Promise<PublicDnsProvider> {
        const provider: T = await this.findProvider(id);
        return this.toPublic(provider, await this.domainCount(provider.uid));
    }

    @RequiresTrustedRole()
    @Post()
    public async create(obj: DnsProviderRequest | undefined, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<PublicDnsProvider> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const body: DnsProviderRequest = asRequest(obj);
        const name: string = validateName(body.name);
        const spec: DnsProviderTypeSpec = getDnsProviderType(body.type);
        const zones: string[] = normalizeDnsZones(body.zones);
        const options: Record<string, DnsProviderOptionValue> = normalizeDnsProviderOptions(spec, body.options, zones);
        const enabled: boolean = optionalBoolean(body.enabled, "enabled", true);
        const allowTakeover: boolean = optionalBoolean(body.allowTakeover, "allowTakeover", false);
        // Nothing is saved yet, so clearing a field (`null`) means the same as leaving it out.
        const values: Record<string, string> = {};
        for (const [key, value] of Object.entries(this.secretPatch(spec, body.credentials))) {
            if (value !== null) {
                values[key] = value;
            }
        }
        assertDnsProviderCredentials(spec, options, Object.keys(values));
        await this.assertNameFree(name);
        await this.assertZonesFree(zones);
        await this.assertNoAssignedDomainTaken(zones);

        const uid: string = newDnsProviderUid(name);
        // Encrypted before anything is written, so a server without a keyring (503) changes nothing. The credentials go into the row's own write.
        const hasCredentials: boolean = Object.keys(values).length > 0;
        const credentials: Record<string, ConfigEnvelope> | undefined = hasCredentials ? sealDnsCredentials(this.requireCipher(), uid, values) : undefined;
        let created: T;
        try {
            created = await this.repo!.create(
                new this.dnsProviderClass({
                    uid,
                    name,
                    nameKey: name.toLowerCase(),
                    type: spec.type,
                    zones,
                    options,
                    ...(credentials ? { credentials, credentialsGeneration: 1 } : {}),
                    origin: "console",
                    enabled,
                    allowTakeover,
                }),
                { user, ignoreACL: true },
            );
        } catch (err) {
            throw mapNameTaken(err);
        }

        await this.audit(req, user, AuditAction.DNS_PROVIDER_CREATE, created, {
            name,
            type: spec.type,
            zones,
            optionKeys: Object.keys(options).sort(),
            credentialsChanged: hasCredentials,
        });
        await this.announce(created.uid);
        return this.toPublic(created, 0);
    }

    @RequiresTrustedRole()
    @Put("/:id")
    public async update(
        @Param("id") id: string,
        obj: DnsProviderRequest | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<PublicDnsProvider> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const body: DnsProviderRequest = asRequest(obj);
        const existing: T = await this.findProvider(id, true);
        // Checked before anything is encrypted or written, so a change made against an older version saves nothing.
        if (body.version !== undefined && Number(body.version) !== existing.version) {
            throw staleVersion();
        }
        if (body.type !== undefined && body.type !== existing.type) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A DNS provider's type can't be changed - add a new one instead.");
        }
        const spec: DnsProviderTypeSpec = getDnsProviderType(existing.type);
        const patch: Partial<DnsProvider> = {};
        const fields: string[] = [];

        if (body.name !== undefined) {
            const name: string = validateName(body.name);
            if (name !== existing.name) {
                await this.assertNameFree(name, existing.uid);
                patch.name = name;
                patch.nameKey = name.toLowerCase();
                fields.push("name");
            }
        }
        const zones: string[] = body.zones !== undefined ? normalizeDnsZones(body.zones) : existing.zones;
        const options: Record<string, DnsProviderOptionValue> = normalizeDnsProviderOptions(spec, body.options !== undefined ? body.options : existing.options, zones);
        if (JSON.stringify(zones) !== JSON.stringify(existing.zones)) {
            // Every assigned domain, however many: one past the first page falling outside would otherwise silently stop being published.
            const assigned: Domain[] = await findAllRows<Domain>(this.domainRepo!, { dnsProviderUid: existing.uid });
            const outside: Domain | undefined = assigned.find((domain) => !isNameInZones(domain.name, zones));
            if (outside) {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, `'${outside.name}' is assigned to this DNS provider and would fall outside its zones - assign it elsewhere first.`);
            }
            // Only the zones this change adds: a config that already shares one (a row from before this check) can still be edited otherwise.
            const added: string[] = zones.filter((zone) => !existing.zones.includes(zone));
            await this.assertZonesFree(added, existing.uid);
            await this.assertNoAssignedDomainTaken(added, existing.uid);
            patch.zones = zones;
            fields.push("zones");
        }
        const optionKeys: string[] = changedOptionKeys(existing.options, options);
        if (optionKeys.length > 0) {
            patch.options = options;
            fields.push("options");
        }
        for (const key of ["enabled", "allowTakeover"] as const) {
            const value: boolean = optionalBoolean(body[key], key, existing[key]);
            if (value !== existing[key]) {
                patch[key] = value;
                fields.push(key);
            }
        }

        // Only what really changes: a field cleared that was never saved is no change.
        const savedKeys: string[] = savedCredentialKeys(existing.credentials);
        const secretPatch: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(this.secretPatch(spec, body.credentials))) {
            if (value !== null || savedKeys.includes(key)) {
                secretPatch[key] = value;
            }
        }
        const keys: string[] = keysAfterPatch(savedKeys, secretPatch);
        assertDnsProviderCredentials(spec, options, keys);
        const credentialsChanged: boolean = Object.keys(secretPatch).length > 0;
        if (fields.length === 0 && !credentialsChanged) {
            return this.toPublic(existing, await this.domainCount(existing.uid));
        }

        if (credentialsChanged) {
            patch.credentials = keys.length === 0 ? null : this.patchCredentials(existing, secretPatch);
            patch.credentialsGeneration = (existing.credentialsGeneration ?? 0) + 1;
            fields.push("credentials");
        }

        // One versioned write of the row, credentials and generation with the rest of the change: a write that loses a race is a 409 and changes nothing.
        let updated: T;
        try {
            updated = await this.repo!.update({ uid: existing.uid, version: existing.version, ...patch } as any, asEntity(this.repo!, existing), {
                user,
                version: existing.version,
                ignoreACL: true,
            });
        } catch (err) {
            throw mapNameTaken(err);
        }
        await this.audit(req, user, AuditAction.DNS_PROVIDER_UPDATE, updated, { name: updated.name, fields, optionKeys, credentialsChanged });
        await this.announce(updated.uid);
        return this.toPublic(updated, await this.domainCount(updated.uid));
    }

    /** The credentials of `existing` with `secretPatch` applied: a new value encrypted for this row and field, `null` removed, the others kept as saved. */
    private patchCredentials(existing: T, secretPatch: Record<string, string | null>): Record<string, ConfigEnvelope> {
        const credentials: Record<string, ConfigEnvelope> = {};
        for (const key of savedCredentialKeys(existing.credentials)) {
            credentials[key] = existing.credentials![key];
        }
        const values: Record<string, string> = {};
        for (const [key, value] of Object.entries(secretPatch)) {
            if (value === null) {
                delete credentials[key];
            } else {
                values[key] = value;
            }
        }
        return { ...credentials, ...(Object.keys(values).length > 0 ? sealDnsCredentials(this.requireCipher(), existing.uid, values) : {}) };
    }

    @RequiresTrustedRole()
    @Delete("/:id")
    public async remove(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<void> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const existing: T = await this.findProvider(id, true);
        const count: number = await this.domainCount(existing.uid);
        if (count > 0) {
            const [first] = await this.domainRepo!.find({ dnsProviderUid: existing.uid, sort: "uid", limit: 1 } as any, { ignoreACL: true, limit: 1, skipCache: true });
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                `${count} domain(s), such as '${first?.name}', are assigned to this DNS provider - assign them elsewhere first.`,
            );
        }
        // A restore puts a domain's apex TXT values back after RapidMX released the set (an opt-out, a deleted domain): it runs only through this
        // config's credentials, so the config stays until the controller has run it.
        const pending: DnsOperation[] = await this.pendingOperations(existing.uid);
        const restore: DnsOperation | undefined = pending.find((operation) => operation.type === "restore");
        if (restore) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                `The DNS controller still has to restore the apex TXT records of '${restore.domainUid ?? "a domain"}' through this DNS provider - delete it once that has run.`,
            );
        }
        await this.repo!.delete(existing.uid, { user, ignoreACL: true });
        // Nothing can run a test or takeover through a config that is gone: they end here instead of being handed to the controller forever.
        for (const operation of pending) {
            await this.cancelOperation(operation, "the DNS provider config was deleted");
        }
        await this.audit(req, user, AuditAction.DNS_PROVIDER_DELETE, existing, { name: existing.name, type: existing.type });
        await this.announce(existing.uid);
    }

    /** The config `uid`'s operations still queued or running; none on a server that doesn't register the model. */
    private async pendingOperations(uid: string): Promise<DnsOperation[]> {
        if (!this.operationRepo) {
            return [];
        }
        const [queued, running] = await Promise.all([
            findAllRows<DnsOperation>(this.operationRepo, { providerUid: uid, state: "queued" }),
            findAllRows<DnsOperation>(this.operationRepo, { providerUid: uid, state: "running" }),
        ]);
        return [...queued, ...running];
    }

    /** Marks `operation` failed with `reason`, so the controller is no longer handed it. Logged, never thrown: what made it pointless already happened. */
    private async cancelOperation(operation: DnsOperation, reason: string): Promise<void> {
        try {
            await this.operationRepo!.update(
                { uid: operation.uid, version: operation.version, state: "failed", message: `Cancelled: ${reason}.`, finishedAt: new Date() } as any,
                asEntity(this.operationRepo!, operation),
                { version: operation.version, ignoreACL: true },
            );
        } catch (err: any) {
            this.logger?.warn(`Could not cancel the DNS operation '${operation.uid}' after ${reason}: ${err?.message}`);
        }
    }

    /** The operations repository, or a 503 on a server that doesn't register the model. */
    private operations(): RepoUtils<DnsOperation> {
        if (!this.operationRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "DNS operations aren't available on this server.");
        }
        return this.operationRepo;
    }

    /**
     * Queues a credentials test: the DNS controller runs external-dns once with the config's credentials and arguments (`--dry-run --once`) and reports
     * whether it authenticated and found the zones, which `GET /:id/operations` then shows. A trusted role and an elevated token; audited
     * (`DNS_PROVIDER_TEST`).
     */
    @RequiresTrustedRole()
    @Post("/:id/test")
    public async test(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<PublicDnsOperation> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const provider: T = await this.findProvider(id);
        const operation: DnsOperation = await queueDnsOperation(this.operations(), this.dnsOperationClass, { type: "test", providerUid: provider.uid, requestedBy: user?.uid });
        await this.audit(req, user, AuditAction.DNS_PROVIDER_TEST, provider, { name: provider.name, operation: operation.uid });
        await notifyDnsPublisher(this.dnsPublisher, { scope: "operation", operationUid: operation.uid }, this.logger);
        return toPublicDnsOperation(operation);
    }

    /** The live values of `record`, as text, for the audit entry of a takeover; none when the lookup fails. */
    private async liveValues(record: DnsRecordV1): Promise<string[]> {
        try {
            switch (record.recordType) {
                case "MX":
                    return (await this.dnsResolver!.resolveMx(record.dnsName)).map((r) => `${r.priority} ${r.exchange}`);
                case "SRV":
                    return (await this.dnsResolver!.resolveSrv(record.dnsName)).map((r) => `${r.priority} ${r.weight} ${r.port} ${r.target}`);
                case "CNAME":
                    return await this.dnsResolver!.resolveCname(record.dnsName);
                case "TXT":
                    return (await this.dnsResolver!.resolveTxt(record.dnsName)).map((chunks) => chunks.join(""));
                default:
                    return [];
            }
        } catch {
            return [];
        }
    }

    /**
     * Queues the takeover of a domain's records this deployment doesn't own yet (spec 9.3): the controller's one-shot Job overwrites them with the wanted
     * values and this deployment's ownership records, after which the regular instance manages them. Body: `domainUid`, and optionally `records`, the
     * record types to take over (all the domain publishes through this config when left out). The domain must be assigned to this config, and every
     * type asked for must be one it publishes through it (a 400 naming the others, such as MX on rfc2136, which can't hold it). The apex TXT set is never
     * taken over here: `PUT mail/domains/:id/apex-txt` alone manages it. A trusted role and an elevated token; audited (`DNS_TAKEOVER`) with the values
     * the live lookup sees now.
     */
    @RequiresTrustedRole()
    @Post("/:id/takeover")
    public async takeover(@Param("id") id: string, obj: any, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<PublicDnsOperation> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const body: Record<string, unknown> = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
        if (typeof body.domainUid !== "string" || !body.domainUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'domainUid' must name the domain whose records to take over.");
        }
        const provider: T = await this.findProvider(id);
        const domain: Domain | undefined = await this.domainRepo!.findOne(body.domainUid.toLowerCase(), { ignoreACL: true });
        if (!domain || domainProvider(domain, [provider]) !== provider) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "That domain isn't published through this DNS provider.");
        }
        const ctx = { mxHostname: this.mxHostname, autodiscoverHostname: autodiscoverHostnameFor(this.autodiscoverPublicUrl), ttl: this.publishTtlSeconds };
        const takeable: DnsRecordType[] = buildDesiredDnsRecords(domain, ctx)
            .map((record) => record.type)
            .filter((type) => type !== "spf");
        let types: DnsRecordType[] = takeable;
        if (body.records !== undefined) {
            if (!Array.isArray(body.records) || body.records.length === 0 || !body.records.every((type) => typeof type === "string" && takeable.includes(type as DnsRecordType))) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'records' must list record types of this domain: ${takeable.join(", ")}. The apex TXT set (SPF) is managed through the domain's apex-txt setting.`);
            }
            types = body.records as DnsRecordType[];
        }
        // A record type the domain lists but doesn't publish through this config (not configured yet, or a kind the provider can't hold) can't be taken
        // over: asked for by name, it is refused rather than left out unnoticed.
        const publishable: DnsRecordType[] = buildDesiredDnsRecords(domain, ctx)
            .filter((record) => record.configured && !dnsManualReason(record, domain, provider))
            .map((record) => record.type);
        const unpublishable: DnsRecordType[] = body.records === undefined ? [] : types.filter((type) => !publishable.includes(type));
        if (unpublishable.length > 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `Not published through this DNS provider, so not taken over: ${unpublishable.join(", ")}.`);
        }
        // Never empty: the ownership record at `_rapidmx-verify.<domain>` is always published through the config covering the domain.
        const records: DnsRecordV1[] = domainDnsRecordsV1(domain, provider, ctx, types);
        const operation: DnsOperation = await queueDnsOperation(this.operations(), this.dnsOperationClass, {
            type: "takeover",
            providerUid: provider.uid,
            domainUid: domain.uid,
            endpointSetId: domainEndpointSetId(domain.uid),
            records,
            requestedBy: user?.uid,
        });
        const oldValues: string[] = (await Promise.all(records.map((record) => this.liveValues(record)))).flat();
        await this.audit(req, user, AuditAction.DNS_TAKEOVER, provider, {
            provider: provider.uid,
            domain: domain.name,
            recordNames: [...new Set(records.map((record) => record.dnsName))],
            oldValues,
            operation: operation.uid,
        });
        await notifyDnsPublisher(this.dnsPublisher, { scope: "operation", operationUid: operation.uid }, this.logger);
        return toPublicDnsOperation(operation);
    }

    /** The config's latest operations (at most `OPERATIONS_LISTED`), newest first, with their state and the controller's result. A trusted role. */
    @RequiresTrustedRole()
    @Get("/:id/operations")
    public async listOperations(@Param("id") id: string): Promise<PublicDnsOperation[]> {
        const provider: T = await this.findProvider(id);
        const operations: DnsOperation[] = await findAllRows<DnsOperation>(this.operations(), { providerUid: provider.uid });
        return operations
            .sort((a, b) => new Date(b.dateCreated ?? 0).getTime() - new Date(a.dateCreated ?? 0).getTime())
            .slice(0, OPERATIONS_LISTED)
            .map(toPublicDnsOperation);
    }
}
