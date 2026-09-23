///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
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
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { assertNoPathKeys, assertPlainPropertyName, stripClientCreateFields, stripClientId } from "../util/RequestBodyUtils.js";
import { getPrimaryDomainNames } from "../util/DomainUtils.js";
import { AuditAction, DistributionList, Mailbox } from "../models/types.js";
const { Param, Query, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

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

    /** Supplied by the Mongo/SQL concrete subclasses so `recordAuditLog()` can persist an `AuditLogEntry`
     * without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    private mailboxRepo?: RepoUtils<Mailbox>;

    private async getMailboxRepo(): Promise<RepoUtils<Mailbox>> {
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
        return this.mailboxRepo;
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

        const mailboxRepo: RepoUtils<Mailbox> = await this.getMailboxRepo();
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
    private async assertAliasAddressesAvailable(addresses: string[]): Promise<void> {
        const mailboxRepo: RepoUtils<Mailbox> = await this.getMailboxRepo();
        for (const address of new Set(addresses)) {
            const [listByUid, mailboxByUid, listsByPrimary, listsByAlias, mailboxesByPrimary, mailboxesByAlias] = await Promise.all([
                this.repoUtils!.findOne(address, { ignoreACL: true, includeDeleted: true }),
                mailboxRepo.findOne(address, { ignoreACL: true }),
                this.repoUtils!.find({ primarySmtpAddress: ModelUtils.literal(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }),
                this.repoUtils!.find({ aliasAddresses: this.aliasQueryValue(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }),
                mailboxRepo.find({ primarySmtpAddress: ModelUtils.literal(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }),
                mailboxRepo.find({ aliasAddresses: this.aliasQueryValue(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }),
            ]);
            if (
                listByUid ||
                mailboxByUid ||
                listsByPrimary.length > 0 ||
                listsByAlias.length > 0 ||
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
        const domains: string[] = await getPrimaryDomainNames(this._objectFactory!, this.domainClass);

        const seenUids: Set<string> = new Set();
        for (const o of objs) {
            // `_id` would replace another document on Mongo - see `util/RequestBodyUtils.ts`.
            stripClientCreateFields(o);
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
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, req, user, logger: this.logger },
                {
                    action: AuditAction.DISTRIBUTION_LIST_CREATE,
                    targetType: "DistributionList",
                    targetUid: list.uid,
                    details: { primarySmtpAddress: list.primarySmtpAddress, name: list.name },
                },
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
        const domains: string[] = await getPrimaryDomainNames(this._objectFactory!, this.domainClass);
        const domain: string | undefined = newAddress.split("@")[1]?.toLowerCase();
        if (domains.length > 0 && (!domain || !domains.includes(domain))) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `Distribution list addresses must be on one of this server's configured domains: ${domains.join(", ")}.`,
            );
        }

        const mailboxRepo: RepoUtils<Mailbox> = await this.getMailboxRepo();
        const [collidingLists, collidingMailboxes] = await Promise.all([
            this.repoUtils!.find({ primarySmtpAddress: newAddress } as any, { ignoreACL: true, limit: 1 }),
            mailboxRepo.find({ primarySmtpAddress: newAddress } as any, { ignoreACL: true, limit: 1 }),
        ]);
        if (collidingLists.length > 0 || collidingMailboxes.length > 0) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "This address is already in use by another mailbox or distribution list.",
            );
        }
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
        const domains: string[] = await getPrimaryDomainNames(this._objectFactory!, this.domainClass);
        await this.validateAliasAddresses(domains, added);
    }

    /** Runs for the inherited `updateBulk()` (per element) and `updateProperty()` - refuses path keys there too. */
    protected async validateUpdate(id: string, obj: UpdateObject<T>, user?: JWTUser): Promise<void> {
        assertNoPathKeys(obj);
        stripClientId(obj);
        return super.validateUpdate(id, obj, user);
    }

    public async updateProperty(id: string, propertyName: string, obj: any, user?: JWTUser): Promise<T> {
        assertPlainPropertyName(propertyName);
        return super.updateProperty(id, propertyName, obj, user);
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
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        // Only re-validate on a genuine change - a caller round-tripping the full object back unchanged must
        // not start failing because e.g. a domain was un-verified after the fact.
        if (obj.primarySmtpAddress !== undefined && obj.primarySmtpAddress !== existing.primarySmtpAddress) {
            await this.validateAddressChange(existing, obj.primarySmtpAddress);
        }
        if (obj.aliasAddresses !== undefined) {
            await this.validateAliasAddressChange(existing, obj.aliasAddresses);
        }
        const updated: T = await this.repoUtils!.update(obj, existing, { user, version: (obj as any).version, ignoreACL: true });

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            {
                action: AuditAction.DISTRIBUTION_LIST_UPDATE,
                targetType: "DistributionList",
                targetUid: updated.uid,
                details: { primarySmtpAddress: updated.primarySmtpAddress, name: updated.name },
            },
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

        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            {
                action: AuditAction.DISTRIBUTION_LIST_DELETE,
                targetType: "DistributionList",
                targetUid: existing.uid,
                details: { primarySmtpAddress: existing.primarySmtpAddress, name: existing.name },
            },
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
