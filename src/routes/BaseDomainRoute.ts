///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    CRUDRoute,
    HttpRequest,
    HttpResponse,
    RepoUtils,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import type { DkimKeyProvider } from "../dkim/DkimKeyProvider.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { isNameInZones } from "../dns/DnsProviderTypes.js";
import { PluginRegistry } from "../plugins/PluginRegistry.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { checkDnsSetup, type DnsRecordCheck } from "../util/DnsSetupUtils.js";
import { checkDomainVerification } from "../util/DomainVerificationUtils.js";
import { extractPublicHostname, isReservedDomainName } from "../util/DomainUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { assertAdminScope, DEFAULT_ELEVATION_MAX_AGE_SECONDS } from "../util/MailAccessUtils.js";
import { assertNoPathKeys, assertPlainPropertyName, stripClientCreateFields } from "../util/RequestBodyUtils.js";
import { AuditAction, DnsProvider, Domain } from "../models/types.js";
const { Get, Param, Post, Put, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;
/** A host name in lowercase: dot-separated labels of letters, digits and hyphens (a label neither starts nor ends with one, at most 63 characters), at most 253 in all. */
const DOMAIN_NAME_PATTERN: RegExp = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const { Config, Init, Inject } = ObjectDecorators;

const DMARC_POLICIES = new Set(["none", "quarantine", "reject"]);

/** The plugin package the Autodiscover DNS setup checklist entries (`autodiscover_cname`/`autodiscover_srv`)
 * are gated on - mirrors `BaseAutodiscoverRoute`'s own `ACTIVESYNC_PLUGIN`/`MAPI_PLUGIN` gating constants. */
const AUTODISCOVER_PLUGIN = "@rapidmx/autodiscover-plugin";

/** The fields only this class (and `DomainVerificationJob`, and the DNS controller's status reports) ever set: dropped from a plain `PUT` (so a
 * client round-tripping a domain still works), refused by `PUT /:id/:property`, and never taken from a create. `dnsProviderUid` changes only through
 * `PUT /:id/dns-provider`. */
const SERVER_MANAGED_DOMAIN_FIELDS: string[] = ["uid", "verified", "verificationToken", "verifiedAt", "lastCheckedAt", "dnsProviderUid", "dnsPublication"];

/** Rejects an explicitly-provided `dmarcPolicy` that isn't one of the three real DMARC policy values -
 * `undefined` (not provided at all) is left alone, matching every other optional field's semantics. */
function validateDmarcPolicy(dmarcPolicy: unknown): void {
    if (dmarcPolicy !== undefined && !DMARC_POLICIES.has(dmarcPolicy as string)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `dmarcPolicy must be one of: ${[...DMARC_POLICIES].join(", ")}.`);
    }
}

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `Domain` with trusted-role-only access to every
 * action - same admin-only pattern `BaseDistributionListRoute`/`BaseTransportRuleRoute` already
 * established (deny-all class ACL + `@RequiresTrustedRole()` + handler bodies that bypass the framework's
 * *default* ACL handling by calling `this.repoUtils` directly with `ignoreACL: true`, for the exact
 * reason documented on `BaseDistributionListRoute`).
 *
 * `create()`/`update()` own the entire lifecycle of `verified`/`verificationToken`/`verifiedAt` - none of
 * those three fields is ever taken from the caller's request body, only ever set by this class itself (see
 * `assignUidAndCheckCollision()`'s reserved-TLD carve-out) or by `verify()` below, so a `PUT` can never be
 * used to bypass DNS ownership proof.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseDomainRoute<T extends Domain> extends CRUDRoute<T> {
    /** Supplied by the Mongo/SQL concrete subclasses so `AuditLogUtils` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `PUT /:id/dns-provider` can check the provider config it assigns. */
    protected abstract dnsProviderClass: any;

    /** The `DnsProvider` repository, built once by `initDnsProviderRepo()`. */
    protected dnsProviderRepo?: RepoUtils<DnsProvider>;

    /** How old an elevated token may be before it has to be elevated again, in seconds (`mail:security:elevation_max_age_seconds`, 0 = no limit). */
    @Config("mail:security:elevation_max_age_seconds", DEFAULT_ELEVATION_MAX_AGE_SECONDS)
    protected elevationMaxAgeSeconds: number = DEFAULT_ELEVATION_MAX_AGE_SECONDS;

    /** The `AuditLogEntry` repository, built once by `initDomainRepos()`. */
    protected auditLogRepo?: RepoUtils<any>;

    /** Records the audit entries, built once by `initDomainRepos()` from `auditLogRepo`. */
    protected auditLogUtils?: AuditLogUtils;

    @Init
    protected async initDomainRepos(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
    }

    @Init
    protected async initDnsProviderRepo(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.dnsProviderRepo && this.dnsProviderClass) {
            try {
                this.dnsProviderRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.dnsProviderClass.name, args: [this.dnsProviderClass] });
            } catch (err: any) {
                // A server that doesn't register the model yet still boots and serves domains; only assigning a provider is unavailable (503).
                this.logger?.warn(`BaseDomainRoute: DNS provider configs are unavailable, so domains can't be assigned to one: ${err?.message}`);
            }
        }
    }

    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

    /** Optional - a deployment that hasn't registered a `DkimKeyProvider` keeps the original manual model
     * (an admin runs their own OpenDKIM keygen and fills in `dkimSelector`/`dkimPublicKey` by hand). See
     * `DkimKeyProvider`'s own doc comment for why this crosses a boundary this library previously drew
     * deliberately, and is therefore opt-in via DI registration rather than always-on. */
    @Inject("DkimKeyProvider")
    private dkimKeyProvider?: DkimKeyProvider;

    /** This server's own inbound mail-exchange hostname - every `Domain`'s recommended MX (and, by
     * extension, SPF `mx` mechanism) record points here. One global value, same single-value-config
     * pattern as `mail:auth_server_url`. */
    @Config("mail:dns:mx_hostname", "")
    private mxHostname: string = "";

    /** The same `mail:autodiscover:public_url` `@rapidmx/autodiscover-plugin` itself reads (see
     * `BaseAutodiscoverRoute`) - used only to derive the hostname `dnsSetup()` recommends for the
     * `autodiscover.<domain>` CNAME and `_autodiscover._tcp.<domain>` SRV records, and only while that
     * plugin is active. */
    @Config("mail:autodiscover:public_url", "")
    private autodiscoverPublicUrl: string = "";

    private newVerificationToken(): string {
        return crypto.randomBytes(32).toString("base64url");
    }

    /** Fills in `o.dkimSelector`/`o.dkimPublicKey` from `dkimKeyProvider` unless the caller already
     * supplied both fields itself (an explicit caller-supplied pair - an admin importing their own
     * externally-managed OpenDKIM key - always wins) or the registered provider doesn't manage key
     * material at all (`NullDkimKeyProvider`, the default - see `DkimKeyProvider`'s own doc comment). A
     * no-op (leaves whatever the caller sent, including nothing) in either of those cases. */
    private async ensureDkimFields(o: Partial<T>): Promise<void> {
        if (o.dkimSelector && o.dkimPublicKey) {
            return;
        }
        const keyPair = await this.dkimKeyProvider!.ensureKeyPair(o.name!);
        if (!keyPair) {
            return;
        }
        (o as any).dkimSelector = keyPair.selector;
        (o as any).dkimPublicKey = keyPair.publicKey;
    }

    /** Validates a candidate `aliasOf` (already normalized to lowercase): it must name an existing `Domain`
     * other than `uid` itself (no self-alias), and that `Domain` must not itself be an alias (no chains - see
     * `Domain.aliasOf`'s own doc comment: every alias resolves in exactly one hop). Called with `aliasOf`
     * already stripped to `undefined` for an empty string, so this only ever runs on a real candidate value. */
    private async validateAliasOf(aliasOf: string, uid: string): Promise<void> {
        if (aliasOf === uid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A domain cannot be an alias of itself.");
        }
        const target: T | undefined = await this.repoUtils!.findOne(aliasOf, { ignoreACL: true });
        if (!target) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${aliasOf}' is not a domain known to this server - add it first.`);
        }
        if (target.aliasOf) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${aliasOf}' is itself an alias of '${target.aliasOf}' - a domain cannot alias another alias.`);
        }
    }

    /** Refuses to leave a dangling alias: rejects a 409 if any other `Domain` currently names `uid` via its
     * own `aliasOf`. Checked by `delete()` before a primary domain (or a domain that has never been aliased)
     * can be removed - without this, deleting `powerlevel.gg` while `plc.gg` still names it as `aliasOf`
     * would leave `plc.gg` resolving to a primary domain that no longer exists. */
    private async assertNoDependentAliases(uid: string): Promise<void> {
        const dependents: T[] = await this.repoUtils!.find({ aliasOf: uid } as any, { ignoreACL: true, limit: 1 });
        if (dependents.length > 0) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                `Cannot delete '${uid}' while '${dependents[0].name}' is still configured as an alias of it - delete or repoint that domain first.`,
            );
        }
    }

    /** Normalizes `o.name`, derives `uid` from it, and rejects a 409 on collision against an existing
     * `Domain`. Mutates `o` in place - assigns `uid`, and starts a freshly created domain unverified with a
     * new token (DNS ownership has never been checked for it yet), unless `o.name` is under a reserved,
     * never-publicly-resolvable TLD (see `isReservedDomainName()`), in which case it starts already
     * verified instead. A caller-supplied `aliasOf` (see `Domain.aliasOf`'s own doc comment) is normalized
     * and validated the same way `validateAliasOf()` validates one on `update()`. */
    private async assignUidAndCheckCollision(o: Partial<T>): Promise<void> {
        if (!o.name) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        validateDmarcPolicy(o.dmarcPolicy);
        if (typeof o.name !== "string") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A domain's name must be text.");
        }
        const uid: string = normalizeAddress(o.name);
        // Everything below (the DKIM key file's name, every address-domain comparison) reads the name the way it is stored: the normalized one, a
        // valid host name - checked before a key is generated for it.
        if (!DOMAIN_NAME_PATTERN.test(uid)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A domain's name must be a host name: letters, digits and hyphens in dot-separated labels.");
        }
        (o as any).name = uid;
        (o as any).uid = uid;
        (o as any).verificationToken = this.newVerificationToken();
        await this.ensureDkimFields(o);
        if (typeof o.aliasOf === "string") {
            (o as any).aliasOf = normalizeAddress(o.aliasOf) || undefined;
        }
        if (o.aliasOf) {
            await this.validateAliasOf(o.aliasOf, uid);
        }
        if (isReservedDomainName(uid)) {
            // A reserved/special-use TLD (.local, .internal, etc. - see `isReservedDomainName()`'s own doc
            // comment) is never resolvable via public DNS, so ownership can't be proven that way. Adding
            // one here is itself the admin's assertion of control over their own internal namespace (this
            // is a legitimate, common setup for an internal-only mail system) - skip the DNS-proof workflow
            // entirely and start already verified, rather than leaving it permanently stuck unverified.
            (o as any).verified = true;
            (o as any).verifiedAt = new Date();
        } else {
            (o as any).verified = false;
            (o as any).verifiedAt = undefined;
        }

        const existing: T | undefined = await this.repoUtils!.findOne(uid, { ignoreACL: true });
        if (existing) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This domain has already been added.");
        }
    }

    @RequiresTrustedRole()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const objs: T[] = Array.isArray(obj) ? obj : [obj];

        const seenUids: Set<string> = new Set();
        for (const o of objs) {
            // `_id` (an upsert over another row on Mongo), bookkeeping fields and dotted/`$` keys are never the client's.
            stripClientCreateFields(o);
            // A provider is assigned only through `PUT /:id/dns-provider` (elevation, zone check, audit); publication status only the controller writes.
            delete (o as any).dnsProviderUid;
            delete (o as any).dnsPublication;
            await this.assignUidAndCheckCollision(o);
            if (seenUids.has((o as any).uid)) {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "Duplicate domain within the same request.");
            }
            seenUids.add((o as any).uid);
        }

        const created: T[] = Array.isArray(obj)
            ? await this.doBulkCreate(objs, { req, user, ignoreACL: true })
            : [await this.doCreateObject(objs[0], { req, user, ignoreACL: true })];

        for (const domain of created) {
            await this.auditLogUtils!.record(
                { action: AuditAction.DOMAIN_CREATE, targetType: "Domain", targetUid: domain.uid, details: { name: domain.name } },
                { req, user },
            );
        }

        return Array.isArray(obj) ? created : created[0];
    }

    @RequiresTrustedRole()
    public async update(
        @Param("id") id: string,
        obj: UpdateObject<T>,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        // A dotted/`$` key (`dkim.selector`, `dmarcPolicy.p`) is a Mongo update path past the stripping and checks below.
        assertNoPathKeys(obj);
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        // The server-managed fields (`verified`, the DNS provider assignment, ...) are never client-settable here - strip whatever the caller sent,
        // keeping the required `uid`/`version`.
        const patch: any = { ...obj };
        for (const field of SERVER_MANAGED_DOMAIN_FIELDS) {
            if (field !== "uid") {
                delete patch[field];
            }
        }

        // `RepoUtils.update()` requires `obj.uid === existing.uid` (it's an identity match, not a rename) -
        // `name` drives `uid` (see `assignUidAndCheckCollision()`), so changing it here isn't supported;
        // delete and re-create instead, the same as every other uid-derived-from-a-field entity in this
        // library (e.g. `DistributionList.primarySmtpAddress`).
        if (patch.name !== undefined && normalizeAddress(patch.name) !== existing.uid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A domain's name cannot be changed - delete and re-create it instead.");
        }
        validateDmarcPolicy(patch.dmarcPolicy);
        if (patch.aliasOf !== undefined) {
            patch.aliasOf = normalizeAddress(String(patch.aliasOf)) || undefined;
            if (patch.aliasOf && patch.aliasOf !== existing.aliasOf) {
                // Only checked on a genuine new alias assignment, not a no-op round-trip of the existing value -
                // matches every other "only act on a real change" guard in this class. Refuses turning a domain
                // that other domains already alias INTO an alias itself, which is the same one-hop-only rule
                // `validateAliasOf()` enforces from the other direction (a fresh alias can't target an alias).
                await this.assertNoDependentAliases(existing.uid);
                await this.validateAliasOf(patch.aliasOf, existing.uid);
            }
        }

        const updated: T = await this.repoUtils!.update(patch, existing, { user, version: (obj as any).version, ignoreACL: true });

        await this.auditLogUtils!.record(
            { action: AuditAction.DOMAIN_UPDATE, targetType: "Domain", targetUid: updated.uid, details: { name: updated.name } },
            { req, user },
        );

        return updated;
    }

    /** `CRUDRoute`'s own `PUT /` goes straight to `doBulkUpdate()`, which never strips `verified` & co. and writes
     * no audit entry - each entry goes through the guarded `update()` above instead. One failing entry aborts the
     * rest (same trade-off as `BaseMatterRoute.updateBulk()`). */
    @RequiresTrustedRole()
    public async updateBulk(objs: UpdateObject<T>[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T[]> {
        if (!Array.isArray(objs)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        assertNoPathKeys(objs);
        const updated: T[] = [];
        for (const obj of objs) {
            updated.push(await this.update((obj as any)?.uid, obj, req, user));
        }
        return updated;
    }

    /** `CRUDRoute`'s own `PUT /:id/:property` would write any property, `verified` included, with no audit entry.
     * Routed through `update()`; the fields only this class sets are refused outright rather than silently
     * dropped, so a client can't mistake the call for having worked. */
    @RequiresTrustedRole()
    public async updateProperty(
        @Param("id") id: string,
        @Param("property") propertyName: string,
        obj: any,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        assertPlainPropertyName(propertyName);
        if (SERVER_MANAGED_DOMAIN_FIELDS.includes(propertyName)) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, `'${propertyName}' cannot be set through this API.`);
        }
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return await this.update(id, { uid: existing.uid, version: existing.version, [propertyName]: obj } as any, undefined as any, user);
    }

    /** `CRUDRoute`'s own `DELETE /` deletes every matching domain with no audit entry per domain - refused; delete
     * domains one at a time (`DELETE /:id`). */
    @RequiresTrustedRole()
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Domains must be deleted one at a time.");
    }

    @RequiresTrustedRole()
    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        const existing: T | undefined = await this.repoUtils!.findOne(id, { version, ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        await this.assertNoDependentAliases(existing.uid);
        await this.repoUtils!.delete(existing.uid, { user, version, purge: purge === "true", ignoreACL: true });

        await this.auditLogUtils!.record(
            { action: AuditAction.DOMAIN_DELETE, targetType: "Domain", targetUid: existing.uid, details: { name: existing.name } },
            { req, user },
        );
    }

    @RequiresTrustedRole()
    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<T[]> {
        return await this.repoUtils!.find(
            { ...query, ...params },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
    }

    @RequiresTrustedRole()
    public async count(
        @Param() params: any,
        @Query() query: any,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<any> {
        const result: number = await this.repoUtils!.count(
            { ...query, ...params },
            { limit: query?.limit, page: query?.page, version: query?.version, user, ignoreACL: true },
        );
        return res.status(200).setHeader("content-length", result);
    }

    @RequiresTrustedRole()
    public async findById(@Param("id") id: string, @Query() query: any, @AuthUser user?: JWTUser): Promise<T | null> {
        const result: T | undefined = await this.repoUtils!.findOne(id, {
            version: query?.version,
            includeDeleted: query?.deleted === true || query?.deleted === "true",
            user,
            ignoreACL: true,
        });
        if (!result) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return result;
    }

    /**
     * Assigns the domain to a DNS provider config (`{ dnsProviderUid: "<uid>" }`), whose external-dns instance then publishes its records, or sets it
     * back to manual (`{ dnsProviderUid: null }`): the admin publishes them by hand. A trusted role AND an elevated token (`assertAdminScope()`) - this
     * decides who can change the domain's public DNS records - and audited (`DOMAIN_DNS_PROVIDER_ASSIGN`, from and to). The provider must exist and its
     * `zones` must cover the domain's name (400 otherwise). Assigning the provider it already has changes nothing.
     *
     * A provider deleted, or its zones narrowed, at the same moment can leave an assignment the provider no longer covers; that is harmless, since
     * external-dns publishes only inside its zones, and the desired state treats such an assignment as manual.
     */
    @RequiresTrustedRole()
    @Put("/:id/dns-provider")
    public async assignDnsProvider(@Param("id") id: string, obj: any, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const to: unknown = obj && typeof obj === "object" && !Array.isArray(obj) ? obj.dnsProviderUid : undefined;
        if (to !== null && typeof to !== "string") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'dnsProviderUid' must be a DNS provider's uid, or null for manual.");
        }
        const domain: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!domain) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const from: string | null = domain.dnsProviderUid ?? null;
        if (to === from) {
            return domain;
        }
        if (to !== null) {
            if (!this.dnsProviderRepo) {
                throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "DNS provider configs aren't available on this server.");
            }
            const provider: DnsProvider | undefined = await this.dnsProviderRepo.findOne(to, { ignoreACL: true });
            if (!provider) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "There is no DNS provider with that uid.");
            }
            if (!isNameInZones(domain.name, provider.zones)) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${domain.name}' is not in the zones of DNS provider '${provider.name}' (${provider.zones.join(", ")}).`);
            }
        }
        const updated: T = await this.repoUtils!.update({ uid: domain.uid, version: domain.version, dnsProviderUid: to } as any, asEntity(this.repoUtils!, domain), {
            user,
            version: domain.version,
            ignoreACL: true,
        });
        await this.auditLogUtils!.record(
            { action: AuditAction.DOMAIN_DNS_PROVIDER_ASSIGN, targetType: "Domain", targetUid: updated.uid, details: { name: updated.name, from, to } },
            { req, user },
        );
        return updated;
    }

    /**
     * Triggers an immediate DNS ownership check rather than waiting for `DomainVerificationJob`'s next
     * scheduled pass - looks up `domain.name`'s TXT records for the expected `verificationToken` value
     * (`checkDomainVerification()`, shared with that job) and, on a match, flips `verified: true`. A
     * no-op on an already-verified domain (idempotent); on a still-unverified result, only `lastCheckedAt`
     * is updated - "checked, not found yet" isn't an error, so this always returns `200` with the current
     * (possibly still unverified) domain either way.
     */
    @RequiresTrustedRole()
    @Post("/:id/verify")
    public async verify(@Param("id") id: string, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T> {
        const domain: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!domain) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (domain.verified) {
            return domain;
        }

        const nowVerified: boolean = await checkDomainVerification(this.dnsResolver!, domain);
        const patch: any = { uid: domain.uid, version: domain.version, lastCheckedAt: new Date() };
        if (nowVerified) {
            patch.verified = true;
            patch.verifiedAt = new Date();
        }
        const updated: T = await this.repoUtils!.update(patch, domain, { user, version: domain.version, ignoreACL: true });

        if (nowVerified) {
            await this.auditLogUtils!.record(
                { action: AuditAction.DOMAIN_VERIFIED, targetType: "Domain", targetUid: updated.uid, details: { name: updated.name } },
                { req, user },
            );
        }

        return updated;
    }

    /**
     * Read-only DNS setup status for `domain` - computes and live-checks every mail-related DNS record
     * this server recommends (ownership TXT, MX, SPF, DKIM, DMARC, and, only while
     * `@rapidmx/autodiscover-plugin` is active, the `autodiscover.<domain>` CNAME and
     * `_autodiscover._tcp.<domain>` SRV records - see `checkDnsSetup()`'s own doc comment for the exact
     * per-type logic) so an admin console can show a single "here's what to add to your DNS, and whether
     * it's live yet" checklist. Unlike `verify()`, this never mutates the domain or writes an
     * `AuditLogEntry` - nothing here has ownership verification's security consequence, it's purely
     * diagnostic and always computed fresh.
     */
    @RequiresTrustedRole()
    @Get("/:id/dns-setup")
    public async dnsSetup(@Param("id") id: string): Promise<DnsRecordCheck[]> {
        let domain: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!domain) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }

        // Backfill for a domain added before a key-generating `DkimKeyProvider` was registered (or one
        // that predates this feature entirely) - a no-op once both fields are already set, or when the
        // registered provider doesn't manage key material at all (`NullDkimKeyProvider`, the default), so
        // this only ever does real work once per domain in a deployment that has opted into auto-
        // generation. Best-effort: a key-generation failure here shouldn't break the rest of this otherwise
        // read-only diagnostic endpoint.
        if (!(domain.dkimSelector && domain.dkimPublicKey)) {
            try {
                const keyPair = await this.dkimKeyProvider!.ensureKeyPair(domain.name);
                if (keyPair) {
                    const patch: any = { uid: domain.uid, version: domain.version, dkimSelector: keyPair.selector, dkimPublicKey: keyPair.publicKey };
                    domain = await this.repoUtils!.update(patch, domain, { version: domain.version, ignoreACL: true });
                }
            } catch (err: any) {
                this.logger?.warn(`BaseDomainRoute: failed to backfill DKIM key pair for '${domain.name}': ${err.message}`);
            }
        }

        const autodiscoverHostname: string | undefined = PluginRegistry.isActive(AUTODISCOVER_PLUGIN)
            ? extractPublicHostname(this.autodiscoverPublicUrl)
            : undefined;
        return await checkDnsSetup(this.dnsResolver!, domain, this.mxHostname, autodiscoverHostname);
    }
}
