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
import { DEFAULT_PUBLISH_TTL, domainEndpointSetId, publishTtl } from "../dns/DnsDesiredState.js";
import { notifyDnsPublisher, resolveDnsPublisher, type DnsPublisher } from "../dns/DnsPublisher.js";
import { isDnsNoRecordsError, type DnsResolver } from "../dns/DnsResolver.js";
import { isNameInZones } from "../dns/DnsProviderTypes.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { chooseApexSpf, normalizeApexTxtKeep, suggestApexTxtKeep } from "../util/ApexTxtUtils.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { autodiscoverHostnameFor, findDnsOwnerId, isDomainEndpointObserved, queueDnsOperation } from "../util/DnsPublishingUtils.js";
import { checkDnsSetup, type DnsRecordCheck } from "../util/DnsSetupUtils.js";
import { DEFAULT_ACCEPT_LEGACY_APEX, findDomainVerification, type DomainVerificationResult } from "../util/DomainVerificationUtils.js";
import { isReservedDomainName } from "../util/DomainUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { assertAdminScope, DEFAULT_ELEVATION_MAX_AGE_SECONDS } from "../util/MailAccessUtils.js";
import { assertNoPathKeys, assertPlainPropertyName, stripClientCreateFields } from "../util/RequestBodyUtils.js";
import { ApexTxtSettings, AuditAction, DeploymentIdentity, DnsOperation, DnsProvider, Domain } from "../models/types.js";
const { Get, Param, Post, Put, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;
/** A host name in lowercase: dot-separated labels of letters, digits and hyphens (a label neither starts nor ends with one, at most 63 characters), at most 253 in all. */
const DOMAIN_NAME_PATTERN: RegExp = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const { Config, Init, Inject } = ObjectDecorators;

const DMARC_POLICIES = new Set(["none", "quarantine", "reject"]);

/** The fields only this class (and `DomainVerificationJob`, the DNS controller's status reports and the DKIM rotation job) ever set: dropped from a plain
 * `PUT` (so a client round-tripping a domain still works), refused by `PUT /:id/:property`, and never taken from a create. `dnsProviderUid` changes only
 * through `PUT /:id/dns-provider`, `apexTxt` only through `PUT /:id/apex-txt`. */
const SERVER_MANAGED_DOMAIN_FIELDS: string[] = [
    "uid",
    "verified",
    "verificationToken",
    "verifiedAt",
    "lastCheckedAt",
    "dnsProviderUid",
    "dnsPublication",
    "apexTxt",
    "dkimRotation",
];

/** The fields whose change moves a domain's published records: an update touching any of them is announced to the DNS controller. */
const PUBLISHED_DOMAIN_FIELDS: string[] = ["enabled", "dmarcPolicy", "dmarcReportEmail", "aliasOf", "dkimSelector", "dkimPublicKey"];

/** What `GET /:id/apex-txt` answers: the managed state, and what the console's opt-in form starts from. */
export interface ApexTxtView {
    managed: boolean;
    keep: string[];
    spf?: string;
    /** The values at the domain's apex now, as the live lookup sees them. */
    current: string[];
    /** `current` without SPF records and RapidMX ownership tokens: what the "values to keep" list is pre-filled with. */
    suggestedKeep: string[];
    /** The lookup of the apex couldn't be answered (a timeout, SERVFAIL), so `current` and `suggestedKeep` say nothing about what is there: the console
     * must not offer the opt-in on them (`PUT /:id/apex-txt` refuses it with a 503 meanwhile). */
    lookupFailed?: true;
}

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

    /** Supplied by the Mongo/SQL concrete subclasses: the operations queued for the DNS controller (a takeover on opting into apex TXT management, a
     * restore of the kept values on opting out or deleting the domain). */
    protected dnsOperationClass?: any;

    /** Supplied by the Mongo/SQL concrete subclasses: this deployment's identity, whose installation id is the external-dns owner id the checklist's
     * conflict state is judged by. */
    protected deploymentIdentityClass?: any;

    protected dnsOperationRepo?: RepoUtils<DnsOperation>;

    protected deploymentIdentityRepo?: RepoUtils<DeploymentIdentity>;

    /** Announces changes to the DNS desired state; `NullDnsPublisher` on a server that registers none. */
    protected dnsPublisher?: DnsPublisher;

    /** Whether a verification token at the domain's root, its old location, still verifies it (`mail:domain_verification:accept_legacy_apex`). */
    @Config("mail:domain_verification:accept_legacy_apex", DEFAULT_ACCEPT_LEGACY_APEX)
    protected acceptLegacyApex: boolean = DEFAULT_ACCEPT_LEGACY_APEX;

    /** The TTL of published records (`mail:dns:publish:ttl`): what a queued takeover or restore writes them with. */
    @Config("mail:dns:publish:ttl", DEFAULT_PUBLISH_TTL)
    protected publishTtlSeconds: number = DEFAULT_PUBLISH_TTL;

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

    /** Like `initDnsProviderRepo()`, tolerant of a server that doesn't register the models or a publisher yet: domains are still served, only DNS
     * publishing is unavailable. */
    @Init
    protected async initDnsPublishing(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        for (const [field, cls] of [
            ["dnsOperationRepo", this.dnsOperationClass],
            ["deploymentIdentityRepo", this.deploymentIdentityClass],
        ] as const) {
            if (!(this as any)[field] && cls) {
                try {
                    (this as any)[field] = await this._objectFactory.newInstance(RepoUtils, { name: cls.name, args: [cls] });
                } catch (err: any) {
                    this.logger?.warn(`BaseDomainRoute: ${cls.name} is unavailable, so DNS publishing is limited: ${err?.message}`);
                }
            }
        }
        if (!this.dnsPublisher) {
            this.dnsPublisher = await resolveDnsPublisher(this._objectFactory, this.logger);
        }
    }

    /** Announces that `uid`'s published records may have changed. Never throws. */
    private async announce(uid: string): Promise<void> {
        await notifyDnsPublisher(this.dnsPublisher, { scope: "domain", domainUid: uid }, this.logger);
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
            // The apex TXT set is managed only through `PUT /:id/apex-txt`; a rotation only the rotation job starts.
            delete (o as any).apexTxt;
            delete (o as any).dkimRotation;
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
            await this.announce(domain.uid);
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
        if (PUBLISHED_DOMAIN_FIELDS.some((field) => JSON.stringify((existing as any)[field] ?? null) !== JSON.stringify((updated as any)[field] ?? null))) {
            await this.announce(updated.uid);
        }

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
        // A domain published through a provider config takes its public DNS records with it, as an opt-out of apex TXT management or an assignment
        // to manual would: the same elevated token.
        if (existing.dnsProviderUid || existing.apexTxt?.managed) {
            assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        }
        await this.assertNoDependentAliases(existing.uid);
        // Deleting the domain's endpoint makes external-dns delete every value of the apex TXT set it owns, so its values are put back as they were.
        // Queued before the row goes, so a domain is never gone without its restore; a delete that then fails cancels it.
        const restore: DnsOperation | undefined = existing.apexTxt?.managed ? await this.queueApexTxtRestore(existing, user) : undefined;
        try {
            await this.repoUtils!.delete(existing.uid, { user, version, purge: purge === "true", ignoreACL: true });
        } catch (err) {
            await this.cancelDnsOperation(restore, "the domain's deletion that queued it failed");
            throw err;
        }

        await this.auditLogUtils!.record(
            {
                action: AuditAction.DOMAIN_DELETE,
                targetType: "Domain",
                targetUid: existing.uid,
                details: { name: existing.name, ...(restore ? { restoreOperation: restore.uid } : {}) },
            },
            { req, user },
        );
        await this.announce(existing.uid);
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
        if (domain.apexTxt?.managed) {
            // The provider owning the apex TXT set has to restore the kept values before another can take the set over.
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This domain's apex TXT records are managed by RapidMX. Stop managing them first (PUT /apex-txt with managed false).");
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
        // What the old provider's controller reported no longer says anything about the records of the new assignment.
        const updated: T = await this.repoUtils!.update(
            { uid: domain.uid, version: domain.version, dnsProviderUid: to, dnsPublication: null } as any,
            asEntity(this.repoUtils!, domain),
            { user, version: domain.version, ignoreACL: true },
        );
        await this.auditLogUtils!.record(
            { action: AuditAction.DOMAIN_DNS_PROVIDER_ASSIGN, targetType: "Domain", targetUid: updated.uid, details: { name: updated.name, from, to } },
            { req, user },
        );
        await this.announce(updated.uid);
        return updated;
    }

    /** The provider config `domain` is assigned to, if it still exists. */
    private async findAssignedProvider(domain: T): Promise<DnsProvider | undefined> {
        if (!domain.dnsProviderUid || !this.dnsProviderRepo) {
            return undefined;
        }
        return await this.dnsProviderRepo.findOne(domain.dnsProviderUid, { ignoreACL: true });
    }

    /** The values at `name`'s apex now, each TXT record's strings rejoined: none when the name has no TXT records (NXDOMAIN, NODATA), `undefined` when
     * the lookup couldn't be answered (a timeout, SERVFAIL), after which nothing is known about what is there. */
    private async apexTxtValues(name: string): Promise<string[] | undefined> {
        try {
            return (await this.dnsResolver!.resolveTxt(name)).map((chunks) => chunks.join(""));
        } catch (err: any) {
            if (isDnsNoRecordsError(err)) {
                return [];
            }
            this.logger?.warn(`BaseDomainRoute: the TXT records at '${name}' could not be looked up: ${err?.message}`);
            return undefined;
        }
    }

    /** The operations repository, or a 503 on a server that doesn't register the model. */
    private dnsOperations(): RepoUtils<DnsOperation> {
        if (!this.dnsOperationRepo) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "DNS operations aren't available on this server.");
        }
        return this.dnsOperationRepo;
    }

    /**
     * Queues the restore of `domain`'s apex TXT set, as unowned records, through the provider that owned it (spec 9.5): the SPF value RapidMX published
     * there and every kept value. Releasing the set makes external-dns delete all of it, and a domain left without its SPF record fails SPF (and, with a
     * strict DMARC policy, DMARC) at every receiver; the admin edits the restored values by hand from then on. Nothing is queued for a domain without a
     * provider or a value to restore.
     */
    private async queueApexTxtRestore(domain: T, user?: JWTUser): Promise<DnsOperation | undefined> {
        const targets: string[] = [...(domain.apexTxt?.spf ? [domain.apexTxt.spf] : []), ...(domain.apexTxt?.keep ?? [])];
        if (targets.length === 0 || !domain.dnsProviderUid) {
            return undefined;
        }
        const repo: RepoUtils<DnsOperation> = this.dnsOperations();
        const provider: DnsProvider | undefined = await this.findAssignedProvider(domain);
        const ttl: number = provider ? publishTtl(provider.type, this.publishTtlSeconds) : this.publishTtlSeconds;
        return await queueDnsOperation(repo, this.dnsOperationClass, {
            type: "restore",
            providerUid: domain.dnsProviderUid,
            domainUid: domain.uid,
            endpointSetId: domainEndpointSetId(domain.uid),
            records: [{ dnsName: domain.name, recordType: "TXT", targets, ttl }],
            requestedBy: user?.uid,
        });
    }

    /** Marks `operation`, queued for a change that then failed, as failed with `reason`, so the controller never runs it. Logged, never thrown: the
     * caller is already failing with the change's own error. */
    private async cancelDnsOperation(operation: DnsOperation | undefined, reason: string): Promise<void> {
        if (!operation) {
            return;
        }
        try {
            await this.dnsOperationRepo!.update(
                { uid: operation.uid, version: operation.version, state: "failed", message: `Cancelled: ${reason}.`, finishedAt: new Date() } as any,
                asEntity(this.dnsOperationRepo!, operation),
                { version: operation.version, ignoreACL: true },
            );
        } catch (err: any) {
            this.logger?.error(`BaseDomainRoute: the DNS operation '${operation.uid}' could not be cancelled after ${reason}: ${err?.message}`);
        }
    }

    /**
     * The domain's apex TXT set: whether RapidMX manages it, the values it keeps, and, for the console's opt-in form, the values at the apex now and the
     * ones to keep it suggests (all but SPF records and RapidMX ownership tokens). A trusted role.
     */
    @RequiresTrustedRole()
    @Get("/:id/apex-txt")
    public async getApexTxt(@Param("id") id: string): Promise<ApexTxtView> {
        const domain: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!domain) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const current: string[] | undefined = await this.apexTxtValues(domain.name);
        const view: ApexTxtView = {
            managed: !!domain.apexTxt?.managed,
            keep: [...(domain.apexTxt?.keep ?? [])],
            current: current ?? [],
            suggestedKeep: suggestApexTxtKeep(current ?? []),
        };
        if (domain.apexTxt?.spf) {
            view.spf = domain.apexTxt.spf;
        }
        if (!current) {
            view.lookupFailed = true;
        }
        return view;
    }

    /**
     * Opts the domain's apex TXT set into RapidMX's management (`{ managed: true, keep: [...] }`), edits the values kept while it is managed, or opts out
     * (`{ managed: false }`). A trusted role and an elevated token: owning the set means owning every value in it, so values added at the DNS host are
     * removed while it is managed.
     *
     * - **Opting in** needs the domain assigned to a provider config covering it, and the values at the apex looked up (a 503 when the lookup can't be
     * answered: opting in on an apex wrongly taken for empty would delete what is there). The SPF value published is the existing SPF record verbatim
     * when it already authorizes the MX hosts (`mx`), else `v=spf1 mx ~all`; with it, every value of `keep` (SPF refused, ownership tokens dropped). A
     * takeover of the set is queued for the controller (the set isn't owned yet), and the opt-in is audited as `DNS_TAKEOVER` with the values that were
     * there.
     * - **Editing** `keep` while managed bumps the desired state; audited as `DOMAIN_APEX_TXT_UPDATE`.
     * - **Opting out** releases the set and queues the restore of the SPF value and the kept values as unowned records, so the domain keeps its SPF
     * record; audited as `DOMAIN_APEX_TXT_UPDATE`. The kept values stay on the row so the console can show what was restored.
     */
    @RequiresTrustedRole()
    @Put("/:id/apex-txt")
    public async updateApexTxt(@Param("id") id: string, obj: any, @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T> {
        assertAdminScope(user, this.trustedRoles, this.elevationMaxAgeSeconds);
        const body: Record<string, unknown> = obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
        if (typeof body.managed !== "boolean") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'managed' must be true or false.");
        }
        const domain: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!domain) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const wasManaged: boolean = !!domain.apexTxt?.managed;
        if (!body.managed) {
            if (!wasManaged) {
                return domain;
            }
            const apexTxt: ApexTxtSettings = { ...domain.apexTxt!, managed: false };
            // Queued before the set is released, so it is never released without its restore; a save that then fails cancels it.
            const restore: DnsOperation | undefined = await this.queueApexTxtRestore(domain, user);
            let updated: T;
            try {
                updated = await this.saveApexTxt(domain, apexTxt, user);
            } catch (err) {
                await this.cancelDnsOperation(restore, "the opt-out that queued it failed");
                throw err;
            }
            await this.auditLogUtils!.record(
                {
                    action: AuditAction.DOMAIN_APEX_TXT_UPDATE,
                    targetType: "Domain",
                    targetUid: updated.uid,
                    details: { name: updated.name, managed: false, keep: apexTxt.keep, ...(restore ? { restoreOperation: restore.uid } : {}) },
                },
                { req, user },
            );
            await this.announce(updated.uid);
            return updated;
        }

        const keep: string[] = body.keep === undefined && wasManaged ? [...domain.apexTxt!.keep] : normalizeApexTxtKeep(body.keep);
        const provider: DnsProvider | undefined = await this.findAssignedProvider(domain);
        if (!provider || !isNameInZones(domain.name, provider.zones)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Assign this domain to a DNS provider covering it before RapidMX manages its apex TXT records.");
        }
        if (wasManaged) {
            const updated: T = await this.saveApexTxt(domain, { ...domain.apexTxt!, keep }, user);
            await this.auditLogUtils!.record(
                { action: AuditAction.DOMAIN_APEX_TXT_UPDATE, targetType: "Domain", targetUid: updated.uid, details: { name: updated.name, managed: true, keep } },
                { req, user },
            );
            await this.announce(updated.uid);
            return updated;
        }

        const operations: RepoUtils<DnsOperation> = this.dnsOperations();
        const current: string[] | undefined = await this.apexTxtValues(domain.name);
        if (!current) {
            throw new ApiError(
                ApiErrors.INTERNAL_ERROR,
                503,
                "The TXT records at the domain's root could not be looked up, and owning the set would delete whatever is there. Try again in a moment.",
            );
        }
        const spf: string = chooseApexSpf(current);
        const updated: T = await this.saveApexTxt(domain, { managed: true, keep, spf }, user);
        const operation: DnsOperation = await queueDnsOperation(operations, this.dnsOperationClass, {
            type: "takeover",
            providerUid: provider.uid,
            domainUid: domain.uid,
            endpointSetId: domainEndpointSetId(domain.uid),
            records: [{ dnsName: domain.name, recordType: "TXT", targets: [spf, ...keep], ttl: publishTtl(provider.type, this.publishTtlSeconds) }],
            requestedBy: user?.uid,
        });
        await this.auditLogUtils!.record(
            {
                action: AuditAction.DNS_TAKEOVER,
                targetType: "Domain",
                targetUid: updated.uid,
                details: { provider: provider.uid, domain: updated.name, recordNames: [updated.name], oldValues: current, keep, spf, operation: operation.uid },
            },
            { req, user },
        );
        await this.announce(updated.uid);
        return updated;
    }

    private async saveApexTxt(domain: T, apexTxt: ApexTxtSettings, user?: JWTUser): Promise<T> {
        return await this.repoUtils!.update({ uid: domain.uid, version: domain.version, apexTxt } as any, asEntity(this.repoUtils!, domain), {
            user,
            version: domain.version,
            ignoreACL: true,
        });
    }

    /**
     * Triggers an immediate DNS ownership check rather than waiting for `DomainVerificationJob`'s next
     * scheduled pass - looks for the `verificationToken` at `_rapidmx-verify.<domain>`, and at the apex while
     * the legacy location is accepted (`findDomainVerification()`, shared with that job), and on a match flips
     * `verified: true`, auditing where it was found. A no-op on an already-verified domain (idempotent); on a
     * still-unverified result, only `lastCheckedAt` is updated - "checked, not found yet" isn't an error, so
     * this always returns `200` with the current (possibly still unverified) domain either way.
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

        const result: DomainVerificationResult = await findDomainVerification(this.dnsResolver!, domain, this.acceptLegacyApex);
        const nowVerified: boolean = result.verified;
        const patch: any = { uid: domain.uid, version: domain.version, lastCheckedAt: new Date() };
        if (nowVerified) {
            patch.verified = true;
            patch.verifiedAt = new Date();
        }
        const updated: T = await this.repoUtils!.update(patch, domain, { user, version: domain.version, ignoreACL: true });

        if (nowVerified) {
            await this.auditLogUtils!.record(
                { action: AuditAction.DOMAIN_VERIFIED, targetType: "Domain", targetUid: updated.uid, details: { name: updated.name, location: result.location } },
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
     * diagnostic and always computed fresh. Each configured record also says whether it is published
     * automatically through the domain's provider config (published, pending, conflict) or by hand, and why.
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
                    await this.announce(domain.uid);
                }
            } catch (err: any) {
                this.logger?.warn(`BaseDomainRoute: failed to backfill DKIM key pair for '${domain.name}': ${err.message}`);
            }
        }

        const provider: DnsProvider | undefined = await this.findAssignedProvider(domain).catch(() => undefined);
        const ownerId: string | undefined = provider ? await findDnsOwnerId(this.deploymentIdentityRepo, this.logger) : undefined;
        return await checkDnsSetup(this.dnsResolver!, domain, this.mxHostname, autodiscoverHostnameFor(this.autodiscoverPublicUrl), {
            acceptLegacyApex: this.acceptLegacyApex,
            publication: { provider: provider ?? null, observed: isDomainEndpointObserved(domain), ownerId },
        });
    }
}
