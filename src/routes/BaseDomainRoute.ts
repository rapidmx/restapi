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
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import type { DkimKeyProvider } from "../dkim/DkimKeyProvider.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { checkDnsSetup, type DnsRecordCheck } from "../util/DnsSetupUtils.js";
import { checkDomainVerification } from "../util/DomainVerificationUtils.js";
import { isReservedDomainName } from "../util/DomainUtils.js";
import { assertNoPathKeys, assertPlainPropertyName, stripClientCreateFields } from "../util/RequestBodyUtils.js";
import { AuditAction, Domain } from "../models/types.js";
const { Get, Param, Post, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;
const { Config, Inject } = ObjectDecorators;

const DMARC_POLICIES = new Set(["none", "quarantine", "reject"]);

/** The fields only this class (and `DomainVerificationJob`) ever set - see `update()`. */
const SERVER_MANAGED_DOMAIN_FIELDS: string[] = ["uid", "verified", "verificationToken", "verifiedAt", "lastCheckedAt"];

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
    /** Supplied by the Mongo/SQL concrete subclasses so `recordAuditLog()` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

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

    /** Normalizes `o.name`, derives `uid` from it, and rejects a 409 on collision against an existing
     * `Domain`. Mutates `o` in place - assigns `uid`, and starts a freshly created domain unverified with a
     * new token (DNS ownership has never been checked for it yet), unless `o.name` is under a reserved,
     * never-publicly-resolvable TLD (see `isReservedDomainName()`), in which case it starts already
     * verified instead. */
    private async assignUidAndCheckCollision(o: Partial<T>): Promise<void> {
        if (!o.name) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        validateDmarcPolicy(o.dmarcPolicy);
        const uid: string = normalizeAddress(o.name);
        (o as any).uid = uid;
        (o as any).verificationToken = this.newVerificationToken();
        await this.ensureDkimFields(o);
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
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                { action: AuditAction.DOMAIN_CREATE, targetType: "Domain", targetUid: domain.uid, details: { name: domain.name } },
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

        // `verified`/`verificationToken`/`verifiedAt`/`lastCheckedAt` are never client-settable - strip
        // whatever the caller sent so only `enabled` (and the required `uid`/`version`) can actually change.
        const patch: any = { ...obj };
        delete patch.verified;
        delete patch.verificationToken;
        delete patch.verifiedAt;
        delete patch.lastCheckedAt;

        // `RepoUtils.update()` requires `obj.uid === existing.uid` (it's an identity match, not a rename) -
        // `name` drives `uid` (see `assignUidAndCheckCollision()`), so changing it here isn't supported;
        // delete and re-create instead, the same as every other uid-derived-from-a-field entity in this
        // library (e.g. `DistributionList.primarySmtpAddress`).
        if (patch.name !== undefined && normalizeAddress(patch.name) !== existing.uid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "A domain's name cannot be changed - delete and re-create it instead.");
        }
        validateDmarcPolicy(patch.dmarcPolicy);

        const updated: T = await this.repoUtils!.update(patch, existing, { user, version: (obj as any).version, ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.DOMAIN_UPDATE, targetType: "Domain", targetUid: updated.uid, details: { name: updated.name } },
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
        await this.repoUtils!.delete(existing.uid, { user, version, purge: purge === "true", ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action: AuditAction.DOMAIN_DELETE, targetType: "Domain", targetUid: existing.uid, details: { name: existing.name } },
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
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                { action: AuditAction.DOMAIN_VERIFIED, targetType: "Domain", targetUid: updated.uid, details: { name: updated.name } },
            );
        }

        return updated;
    }

    /**
     * Read-only DNS setup status for `domain` - computes and live-checks every mail-related DNS record
     * this server recommends (ownership TXT, MX, SPF, DKIM, DMARC - see `checkDnsSetup()`'s own doc
     * comment for the exact per-type logic) so an admin console can show a single "here's what to add to
     * your DNS, and whether it's live yet" checklist. Unlike `verify()`, this never mutates the domain or
     * writes an `AuditLogEntry` - nothing here has ownership verification's security consequence, it's
     * purely diagnostic and always computed fresh.
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

        return await checkDnsSetup(this.dnsResolver!, domain, this.mxHostname);
    }
}
