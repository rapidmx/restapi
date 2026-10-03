///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    CRUDRoute,
    HttpRequest,
    HttpResponse,
    ModelUtils,
    RepoUtils,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import { normalizeAddress } from "../util/AddressUtils.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import { assertNoPathKeys, assertPlainPropertyName, stripClientCreateFields, stripClientId } from "../util/RequestBodyUtils.js";
import { DomainUtils } from "../util/DomainUtils.js";
import { AuditAction, DistributionList, Mailbox } from "../models/types.js";
const { Init } = ObjectDecorators;
const { Param, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/** Lowercases and trims `primarySmtpAddress` and every `aliasAddresses` entry in place, as `BaseMailboxRoute` does: mail is delivered by exact match on
 * the lowercased recipient (`BaseMailIngestRoute`), so a list stored as `Sales@x.com` could never be reached - and its collision checks would miss
 * a mailbox at `sales@x.com`. */
function normalizeListAddresses(obj: Record<string, unknown>): void {
    if (typeof obj.primarySmtpAddress === "string") {
        obj.primarySmtpAddress = normalizeAddress(obj.primarySmtpAddress);
    }
    if (Array.isArray(obj.aliasAddresses)) {
        obj.aliasAddresses = obj.aliasAddresses.map((alias) => (typeof alias === "string" ? normalizeAddress(alias) : alias));
    }
}

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `DistributionList` with trusted-role-only access to
 * every action - there is no self-service creation, per-list delegated ownership, or real per-record ACL (the
 * class ACL, like `ContactList`'s, denies every action to everyone; see `DistributionListMongo`/`SQL`'s own
 * `@Protect` config). Each method below is decorated with `@RequiresTrustedRole()`, which installs a
 * dispatch-time middleware (`RouteUtils.checkTrusedRoles()`) that rejects a non-trusted caller with `403`
 * before the handler body ever runs - so by the time any method body executes, the caller is already known
 * to be trusted, and no manual role check is needed there.
 *
 * Every method below still bypasses the framework's *default* ACL handling (calling `this.repoUtils` directly
 * with `ignoreACL: true`) rather than delegating to `super.*()`/`this.do*()`: those helpers either
 * unconditionally deny via the class ACL (`doCreate()` checks its `CREATE` grant directly, which is always
 * empty here) or never forward `ignoreACL` to the underlying `RepoUtils` call at all (`doFind()`/`doCount()`/
 * `doFindById()`/`doUpdate()`/`doDelete()` each hardcode their own fixed option set) - confirmed by reading
 * `ModelRoute.js`. This mirrors `BaseMailboxRoute.create()`'s own reason for bypassing the class ACL, just
 * applied to every action instead of only `create()`, since a `Mailbox` has real per-record ACLs (owner/
 * delegate) to fall back on and a `DistributionList` does not.
 *
 * `mailboxClass` is supplied by the Mongo/SQL concrete subclasses so `create()` can check a candidate address
 * against `Mailbox` too (see `normalizeAddress`/the `uid` architecture note on `DistributionList`).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseDistributionListRoute<T extends DistributionList> extends CRUDRoute<T> {
    protected abstract mailboxClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `create()` can look up this server's verified
     * domains without depending on either backend directly - see `util/DomainUtils.ts`. */
    protected abstract domainClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `AuditLogUtils` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    protected mailboxRepo?: RepoUtils<Mailbox>;
    protected auditLogRepo?: RepoUtils<any>;
    protected auditLogUtils?: AuditLogUtils;
    protected domainRepo?: RepoUtils<any>;
    protected domainUtils?: DomainUtils;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.mailboxRepo && this.mailboxClass) {
            this.mailboxRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.auditLogClass.name,
                args: [this.auditLogClass],
            });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, {
                name: this.auditLogClass.name,
                args: [this.auditLogRepo],
            });
        }
        if (!this.domainRepo && this.domainClass) {
            this.domainRepo = await this._objectFactory.newInstance(RepoUtils, {
                name: this.domainClass.name,
                args: [this.domainClass],
            });
        }
        if (!this.domainUtils && this.domainClass) {
            this.domainUtils = await this._objectFactory.newInstance(DomainUtils, {
                name: this.domainClass.name,
                args: [this.domainRepo],
            });
        }
    }

    /**
     * Validates a candidate list's `primarySmtpAddress` (its domain must be one of this server's verified,
     * non-alias `Domain`s, once at least one exists - same rule `BaseMailboxRoute.create()` applies, and
     * for the same reason: a pure alias `Domain` has no addressable entities of its own, list or mailbox -
     * see `getPrimaryDomainNames()`'s own doc comment), derives its `uid` from that address, and rejects a
     * collision against either an existing `DistributionList` (including a soft-deleted one, which still
     * occupies its uid) or an existing `Mailbox`. Mutates `o.uid` in place.
     */
    private async assignUidAndCheckCollision(o: Partial<T>, domains: string[]): Promise<void> {
        if (!o.primarySmtpAddress) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        const domain: string | undefined = o.primarySmtpAddress.split("@")[1]?.toLowerCase();
        if (domains.length > 0 && (!domain || !domains.includes(domain))) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `Distribution list addresses must be on one of this server's configured domains: ${domains.join(", ")}.`,
            );
        }

        const uid: string = normalizeAddress(o.primarySmtpAddress);
        (o as any).uid = uid;

        const mailboxRepo: RepoUtils<Mailbox> = this.mailboxRepo!;
        const [existingList, existingMailbox] = await Promise.all([
            this.repoUtils!.findOne(uid, { ignoreACL: true, includeDeleted: true }),
            mailboxRepo.findOne(uid, { ignoreACL: true, includeDeleted: true }),
        ]);
        if (existingList || existingMailbox) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "This address is already in use by another mailbox or distribution list.",
            );
        }
    }

    /** The query value matching one element of an `aliasAddresses` column - a literal on Mongo (array-element
     * equality); the SQL subclass overrides it for the serialized `simple-json` column
     * (`DistributionListSQL.aliasAddresses`), exactly like `BaseMailboxRoute.aliasQueryValue()`. */
    protected aliasQueryValue(address: string): any {
        return ModelUtils.literal(address);
    }

    /**
     * Refuses (409) any of `addresses` already used by another mailbox or distribution list - as its uid, its
     * primary address, or one of its aliases. Mirrors `BaseMailboxRoute.assertAddressesAvailable()` exactly:
     * mail is delivered by exact primary/alias match (`BaseMailIngestRoute.findDistributionListByAddressRaw()`/
     * `findMailboxByAddressRaw()`), so a duplicate anywhere would hijack the other recipient's mail.
     */
    private async assertAliasAddressesAvailable(addresses: string[], exceptListUid?: string): Promise<void> {
        const mailboxRepo: RepoUtils<Mailbox> = this.mailboxRepo!;
        for (const address of new Set(addresses)) {
            const [listByUid, mailboxByUid, listsByPrimary, listsByAlias, mailboxesByPrimary, mailboxesByAlias] = await Promise.all([
                this.repoUtils!.findOne(address, { ignoreACL: true, includeDeleted: true }),
                mailboxRepo.findOne(address, { ignoreACL: true }),
                this.repoUtils!.find({ primarySmtpAddress: ModelUtils.literal(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }),
                this.repoUtils!.find({ aliasAddresses: this.aliasQueryValue(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }),
                mailboxRepo.find({ primarySmtpAddress: ModelUtils.literal(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }),
                mailboxRepo.find({ aliasAddresses: this.aliasQueryValue(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }),
            ]);
            // `exceptListUid` is the list being changed: an address it already holds (its uid is its first address) isn't a collision.
            const others = (lists: any[]): number => lists.filter((list) => list.uid !== exceptListUid).length;
            if (
                (listByUid && listByUid.uid !== exceptListUid) ||
                mailboxByUid ||
                others(listsByPrimary) > 0 ||
                others(listsByAlias) > 0 ||
                mailboxesByPrimary.length > 0 ||
                mailboxesByAlias.length > 0
            ) {
                throw new ApiError(
                    ApiErrors.IDENTIFIER_EXISTS,
                    409,
                    "This address is already in use by another mailbox or distribution list.",
                );
            }
        }
    }

    /**
     * Validates a candidate list's `aliasAddresses` - previously not validated AT ALL (not the alias-domain
     * check `primarySmtpAddress` gets via `assignUidAndCheckCollision()`/`validateAddressChange()`, not even a
     * collision check), even though `DistributionList.aliasAddresses` is consumed identically to `Mailbox.
     * aliasAddresses` by `BaseMailIngestRoute`'s address resolution (exact-literal match, then the
     * alias-domain-rewrite retry) - the same mail-hijack-via-alias-domain class of bug just fixed on
     * `BaseMailboxRoute.validateAliasChange()`/`createMailboxes()`, left open on this sibling route. Each
     * address's domain must be one of this server's verified, non-alias `Domain`s (once at least one exists -
     * same rule as `primarySmtpAddress`), and each must not collide with any other mailbox/list's uid, primary
     * address, or alias.
     */
    private async validateAliasAddresses(domains: string[], aliasAddresses: unknown): Promise<void> {
        if (aliasAddresses === undefined) {
            return;
        }
        if (!Array.isArray(aliasAddresses) || aliasAddresses.some((alias) => typeof alias !== "string" || !alias.includes("@"))) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'aliasAddresses' must be a list of addresses.");
        }
        for (const alias of aliasAddresses as string[]) {
            const domain: string | undefined = alias.split("@")[1]?.toLowerCase();
            if (domains.length > 0 && (!domain || !domains.includes(domain))) {
                throw new ApiError(
                    ApiErrors.INVALID_REQUEST,
                    400,
                    `Distribution list addresses must be on one of this server's configured domains: ${domains.join(", ")}.`,
                );
            }
        }
        if (aliasAddresses.length > 0) {
            await this.assertAliasAddressesAvailable(aliasAddresses as string[]);
        }
    }

    @RequiresTrustedRole()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        const domains: string[] = await this.domainUtils!.getPrimaryDomainNames();

        const seenUids: Set<string> = new Set();
        for (const o of objs) {
            // `_id` would replace another document on Mongo - see `util/RequestBodyUtils.ts`.
            stripClientCreateFields(o);
            normalizeListAddresses(o as Record<string, unknown>);
            await this.assignUidAndCheckCollision(o, domains);
            await this.validateAliasAddresses(domains, o.aliasAddresses);
            if (seenUids.has((o as any).uid)) {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "Duplicate address within the same request.");
            }
            seenUids.add((o as any).uid);
        }

        const created: T[] = Array.isArray(obj)
            ? await this.doBulkCreate(objs, { req, user, ignoreACL: true })
            : [await this.doCreateObject(objs[0], { req, user, ignoreACL: true })];

        for (const list of created) {
            await this.auditLogUtils!.record(
                {
                    action: AuditAction.DISTRIBUTION_LIST_CREATE,
                    targetType: "DistributionList",
                    targetUid: list.uid,
                    details: { primarySmtpAddress: list.primarySmtpAddress, name: list.name },
                },
                { req, user },
            );
        }

        return Array.isArray(obj) ? created : created[0];
    }

    /**
     * Re-runs `create()`'s own verified-domain and collision checks (`assignUidAndCheckCollision()`) against
     * a changed `primarySmtpAddress` on `update()` - without this, a trusted admin could `PUT` an existing
     * list with `primarySmtpAddress` set to an existing `Mailbox`'s address (its `uid` stays unchanged, since
     * `RepoUtils.update()` only requires `obj.uid === existing.uid`, not that the address matches it), which
     * `BaseMailIngestRoute`'s address-resolution logic would then treat as a real collision at delivery time -
     * exactly the same class of gap fixed on `BaseMailboxRoute.validateAddressChange()`, just for the trusted-
     * admin-only side of the same `uid`-derived-from-`primarySmtpAddress` convention. Checked by
     * `primarySmtpAddress` field value (matching `BaseMailIngestRoute.findDistributionListByAddress()`'s own
     * query), not `uid` - a list that has itself already been through one address change would otherwise not
     * be caught by a `uid`-keyed check alone.
     */
    private async validateAddressChange(existing: T, newAddress: string): Promise<void> {
        const domains: string[] = await this.domainUtils!.getPrimaryDomainNames();
        const domain: string | undefined = newAddress.split("@")[1]?.toLowerCase();
        if (domains.length > 0 && (!domain || !domains.includes(domain))) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `Distribution list addresses must be on one of this server's configured domains: ${domains.join(", ")}.`,
            );
        }

        // The same check a new alias gets (and a mailbox's): the address as a literal - never a query operator - against every list's and
        // mailbox's uid, primary address and aliases.
        await this.assertAliasAddressesAvailable([newAddress], existing.uid);
    }

    /**
     * Re-validates only the NEWLY ADDED entries of an `aliasAddresses` update against `validateAliasAddresses()`'s
     * domain/collision rules - removing an alias needs no validation, and an alias already on the list was
     * already checked when it was first added. Mirrors `BaseMailboxRoute.validateAliasChange()`'s identical
     * current-vs-incoming diffing.
     */
    private async validateAliasAddressChange(existing: T, newAliasAddresses: unknown): Promise<void> {
        if (!Array.isArray(newAliasAddresses)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'aliasAddresses' must be a list of addresses.");
        }
        const current: Set<string> = new Set((existing.aliasAddresses ?? []).map((alias) => normalizeAddress(alias)));
        const added: unknown[] = newAliasAddresses.filter((alias) => typeof alias !== "string" || !current.has(normalizeAddress(alias)));
        if (added.length === 0) {
            return;
        }
        const domains: string[] = await this.domainUtils!.getPrimaryDomainNames();
        await this.validateAliasAddresses(domains, added);
    }

    /** Runs for the inherited `updateBulk()` (per element) and `updateProperty()` - refuses path keys there too. */
    protected async validateUpdate(id: string, obj: UpdateObject<T>, user?: JWTUser): Promise<void> {
        assertNoPathKeys(obj);
        stripClientId(obj);
        normalizeListAddresses(obj);
        return super.validateUpdate(id, obj, user);
    }

    /** `CRUDRoute`'s own `PUT /:id/:property` would write any property - `primarySmtpAddress` onto a mailbox's address included - with none of
     * `update()`'s address checks and no audit entry: routed through `update()`. */
    @RequiresTrustedRole()
    public async updateProperty(
        @Param("id") id: string,
        @Param("property") propertyName: string,
        obj: any,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        assertPlainPropertyName(propertyName);
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return await this.update(
            id,
            { uid: existing.uid, version: (existing as any).version, [propertyName]: obj } as any,
            undefined as unknown as HttpRequest,
            user,
        );
    }

    /** `CRUDRoute`'s own `PUT /` goes straight to `doBulkUpdate()`: no address checks, no audit entry. Each entry goes through the guarded
     * `update()` instead; one failing entry aborts the rest. */
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

    /** `CRUDRoute`'s own `DELETE /` would remove every list matching a query with no audit entry: lists are deleted one at a time (`DELETE /:id`). */
    @RequiresTrustedRole()
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Distribution lists must be deleted one at a time.");
    }

    @RequiresTrustedRole()
    public async update(
        @Param("id") id: string,
        obj: UpdateObject<T>,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        assertNoPathKeys(obj);
        stripClientId(obj);
        normalizeListAddresses(obj);
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        // Only re-validate on a genuine change - a caller round-tripping the full object back unchanged must
        // not start failing because e.g. a domain was un-verified after the fact.
        if (obj.primarySmtpAddress !== undefined && obj.primarySmtpAddress !== normalizeAddress(existing.primarySmtpAddress)) {
            await this.validateAddressChange(existing, obj.primarySmtpAddress);
        }
        if (obj.aliasAddresses !== undefined) {
            await this.validateAliasAddressChange(existing, obj.aliasAddresses);
        }
        const updated: T = await this.repoUtils!.update(obj, existing, { user, version: (obj as any).version, ignoreACL: true });

        await this.auditLogUtils!.record(
            {
                action: AuditAction.DISTRIBUTION_LIST_UPDATE,
                targetType: "DistributionList",
                targetUid: updated.uid,
                details: { primarySmtpAddress: updated.primarySmtpAddress, name: updated.name },
            },
            { req, user },
        );

        return updated;
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

        await this.auditLogUtils!.record(
            {
                action: AuditAction.DISTRIBUTION_LIST_DELETE,
                targetType: "DistributionList",
                targetUid: existing.uid,
                details: { primarySmtpAddress: existing.primarySmtpAddress, name: existing.name },
            },
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
}
