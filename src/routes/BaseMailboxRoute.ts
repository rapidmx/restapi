///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ApiErrorMessages,
    ApiErrors,
    CRUDRoute,
    HttpRequest,
    HttpResponse,
    RepoUtils,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import { AuditAction, DistributionList, EscrowScope, FolderType, Mailbox } from "../models/types.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { isNonOwnerAccess, recordAuditLog } from "../util/AuditLogUtils.js";
import { getVerifiedDomainNames } from "../util/DomainUtils.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { computeKeyDiscoveryHash } from "../util/KeyDiscoveryClient.js";
import { assertNotOnLegalHold } from "../util/LegalHoldUtils.js";
import { DEFAULT_MAILBOX_QUOTA_BYTES, findOrSeedMailboxPolicy } from "../util/MailboxPolicyUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { normalizeUserUid } from "../util/UserUidUtils.js";
import { coerceDateFields } from "../util/DateCoercionUtils.js";
import { assertNoPathKeys, assertPlainPropertyName, stripClientCreateFields, stripClientId } from "../util/RequestBodyUtils.js";
const { Auth, Delete, Get, Param, Post, Query, Request, Response, User: AuthUser } = RouteDecorators;

/** Every top-level `Date` field of `Mailbox` a client writes - coerced on create/update (see `util/DateCoercionUtils.ts`). */
const MAILBOX_DATE_FIELDS = ["oofStartTime", "oofEndTime"] as const;
const { Config } = ObjectDecorators;

/** `Mailbox` fields that only server-side code may set - the CA-issued `keys` (`BaseKeyVaultRoute.enrollKey()`/
 * `rekey()`) and the address-derived `keyDiscoveryHash` (this route's own `validateUpdate()`/`create()`). A
 * client setting either directly would let any mailbox owner publish an arbitrary certificate at the public
 * discovery endpoint - bypassing the CA entirely - or collide their mailbox's discovery hash with another
 * address's, impersonating it there. Mirrors `BaseContactRoute`'s `DISCOVERY_MANAGED_FIELDS` guard, applied
 * here for the same reason. `encryptPreference` is deliberately NOT included: unlike `Contact.
 * encryptPreference` (learned *about a third party* via Discovery, and so never self-asserted), a mailbox's
 * own `encryptPreference` is a genuine first-person setting ("I want to advertise mutual encryption") the
 * owner is meant to set directly. Rejected outright (400) rather than silently stripped - same rationale as
 * `BaseContactRoute`'s identical choice.
 *
 * Checked by *value*, not merely by key presence - unlike `BaseContactRoute`'s equivalent guard. A request
 * body built from a full `Mailbox`-shaped object (as opposed to a hand-built partial patch) legitimately
 * carries `keys: []` - the class field's own default, not a caller attempting to assert anything - and an
 * absent/empty value can't bypass the CA regardless; only a genuinely non-empty `keys` array or non-empty
 * `keyDiscoveryHash` string is ever worth rejecting. */
function rejectServerManagedFields(obj: Record<string, unknown>): void {
    if (Array.isArray(obj.keys) && obj.keys.length > 0) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'keys' is managed by the server and cannot be set directly.");
    }
    if (typeof obj.keyDiscoveryHash === "string" && obj.keyDiscoveryHash.length > 0) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'keyDiscoveryHash' is managed by the server and cannot be set directly.");
    }
}

/** `Mailbox` fields only a trusted caller may change: who owns the mailbox, and how much it may store and is counted as
 * storing. A delegate with plain update access could otherwise take the mailbox over or lift its quota. */
const TRUSTED_ONLY_FIELDS = ["ownerUserUid", "quotaBytes", "usedBytes"] as const;

/** Lowercases a patch's addresses in place, as `create()` does - mail delivery and every address comparison in this
 * codebase already work on lowercased addresses, and `uid` is the lowercased address too. */
function normalizeAddressFields(obj: Record<string, unknown>): void {
    if (typeof obj.primarySmtpAddress === "string") {
        obj.primarySmtpAddress = normalizeAddress(obj.primarySmtpAddress);
    }
    if (Array.isArray(obj.aliasAddresses)) {
        obj.aliasAddresses = obj.aliasAddresses.map((alias) => (typeof alias === "string" ? normalizeAddress(alias) : alias));
    }
}

/** A single plain `local@domain` address: no whitespace, and none of the characters the search-query parser treats as
 * syntax (`,()`) or that belong to a display-name form (`<>"`). A mailbox's uid is its address, so this also keeps
 * uids safe to use in a query. */
function isPlainAddress(address: unknown): address is string {
    return typeof address === "string" && /^[^\s@,()<>"]+@[^\s@,()<>"]+$/.test(address);
}

/** Refuses (400) any address in `addresses` that isn't `isPlainAddress()`. */
function assertPlainAddresses(addresses: unknown[]): void {
    if (addresses.some((address) => !isPlainAddress(address))) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Mailbox addresses must be single plain addresses.");
    }
}

/** See `stripUnsafeQueryKeys()` on `BaseScopedChildRoute.ts` - drops `$or`/`$and`/... (and `$` path segments), which on
 * SQL override the forced `uid` filter. */
function stripUnsafeQueryKeys(query: any): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(query ?? {})) {
        if (!key.split(".").some((segment) => segment.startsWith("$"))) {
            result[key] = value;
        }
    }
    return result;
}

/** Whether `address` is `<one of aliases>@<one of domains>` (aliases lowercased). */
function ownsAddress(aliases: string[], domains: string[], address: unknown): boolean {
    const [local, domain, ...rest] = typeof address === "string" ? normalizeAddress(address).split("@") : [];
    return rest.length === 0 && aliases.includes(local) && domains.includes(domain);
}

/** One (name alias, domain) combination the caller could register as their mailbox address — the full
 * cross product of their auth-server name aliases and this server's verified `Domain`s. */
export interface MailboxAutoProvisionAliasOption {
    alias: string;
    domain: string;
    primarySmtpAddress: string;
}

export type MailboxAutoProvisionResult<T> =
    | { status: "created"; mailbox: T }
    | { status: "existing"; mailbox: T }
    | { status: "needs_selection"; options: MailboxAutoProvisionAliasOption[] };

/**
 * Extends the standard `CRUDRoute` CRUD scaffolding for `Mailbox` with ACL-driven `find`/`count` overrides,
 * plus a `create` override that bypasses the ACL system entirely. `Mailbox` has a real per-record
 * `AccessControlList` (`@Protect(..., true)`; see the architecture note on `Message.mailboxUid`), whose
 * class-level ACL denies EVERY action to non-trusted callers, including `CREATE`.
 *
 * `create` is deliberately NOT gated by the class-level ACL at all (unlike every other action): provisioning a
 * brand-new mailbox is a pure self-service action (any authenticated user may create their own) with no parent
 * resource to check permission against — `RepoUtils.create()`'s own automatic owner-grant logic is what
 * actually scopes the new mailbox to its creator, not a class-level check. A class-level `CREATE` grant to
 * `.*` was tried first and found to leak: every mailbox's own ACL falls back to that SAME class ACL as its
 * parent whenever a caller has no mailbox-specific record, so *any* authenticated user calling
 * `ACLUtils.hasPermission(user, someOtherMailboxUid, CREATE)` (e.g. `BaseFolderRoute.create()` checking
 * permission to create a folder *in* that mailbox) would incorrectly pass too. Denying `CREATE` at the class
 * level entirely, and having this route check only `user` truthiness before bypassing ACL, closes that leak.
 *
 * A non-trusted caller's `ownerUserUid` is always forced to their own uid, discarding whatever the client
 * sent — self-service creation can only ever create a mailbox *for yourself*. Only a trusted caller may create
 * a mailbox with a different (or no) `ownerUserUid` — the latter is a true ownerless "shared mailbox" (the
 * Exchange concept, e.g. `support@example.com`) with no single owner, only delegates added afterward via
 * `BaseACLRoute` (`@rapidrest/service-core`). `RepoUtils.create()`'s automatic owner-grant is already
 * conditioned on the creator lacking a trusted role, so a trusted caller creating an ownerless mailbox does
 * not, on its own, leave behind a stray self-grant for the admin who happened to create it.
 *
 * `find`/`count` still need overriding despite the real per-record ACL: `RepoUtils.find()`/`count()` both
 * check the class-level ACL as an unconditional first gate *before* any per-record narrowing, and even that
 * later per-record narrowing falls back to the class grant for a record with no caller-specific entry —
 * verified by reading their source. Rather than the old ownership-only (`ownerUserUid: user.uid`) scoping,
 * these now query for every mailbox uid the caller has *any* ACL grant on — owned, shared-with-them as a
 * delegate, or (for a trusted caller) every mailbox unfiltered — via `findAccessibleMailboxUids()`, backed by
 * the exact same `AccessControlList` model `BaseACLRoute` exposes as CRUD (no new API surface). `exists`
 * doesn't need this treatment: it fetches the specific record first (bypassing ACL) and then checks
 * permission against *that record's own* uid via `ACLUtils.hasPermission`, which already resolves ownership,
 * delegate shares, and trusted-role access correctly on its own — see `exists()` below, unchanged.
 * `findById`/`update`/`delete` are unaffected for the same reason: `RepoUtils.findOne()`/`update()`/
 * `delete()` check the *record's own* resolved ACL chain directly (no class-level fast-fail), so once the
 * class-level grant is denied, that chain correctly resolves to "deny" for a caller with no grant and "allow"
 * for the owner or any delegate — `CRUDRoute`'s default behavior for those already works correctly and is
 * left untouched.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMailboxRoute<T extends Mailbox> extends CRUDRoute<T> {
    @Config("trusted_roles", ["admin"])
    protected trustedRoles: string[] = ["admin"];

    /**
     * Base URL of the auth-server whose `GET /api/aliases/me?type=name` `autoProvision()` below calls.
     * Falls back to `""` (rather than leaving this `@Config` field with no default at all) so
     * instantiating this route never throws in a deployment/test context that hasn't set this key —
     * `autoProvision()` already treats an empty value the same as "not configured" below, unless
     * `staticAliases` is set instead (see its own doc comment).
     */
    @Config("mail:auth_server_url", "")
    protected authServerUrl: string = "";

    /**
     * A fixed alias list to use instead of ever calling auth-server, bypassing `fetchNameAliases()`'s
     * real HTTP call entirely when non-empty. Exists for a deployment with no real auth-server to call
     * at all (e.g. local development against a synthetic single-identity session) — a genuine HTTP
     * round-trip back to *this same process* isn't just unnecessary there, it can outright fail
     * (confirmed directly: a Node `fetch()` to this server's own listening address, issued from inside
     * a request handler already running on it, was refused at the TCP level — the underlying HTTP
     * server apparently doesn't accept a new connection to itself while still mid-request). Not
     * specific to any notion of "dev mode" from this class's own point of view — just another config
     * override, same category as every other one here.
     */
    @Config("mail:auto_provision:static_aliases", [] as string[])
    protected staticAliases: string[] = [];

    /** Seeds `MailboxPolicy.autoProvisionEnabled`, the master switch for `autoProvision()` — off by default, since silently minting mailboxes is a real
     * behavior change a deployment must opt into, not something safe to default on. */
    @Config("mail:auto_provision:enabled", false)
    protected autoProvisionEnabled: boolean = false;

    @Config("mail:auto_provision:quota_bytes", 5_000_000_000)
    protected autoProvisionQuotaBytes: number = 5_000_000_000;

    /** Only seeds the `MailboxPolicy` row the first time it's read - see `findOrSeedMailboxPolicy()`. */
    @Config("mail:default_quota_bytes", DEFAULT_MAILBOX_QUOTA_BYTES)
    protected defaultQuotaBytes: number = DEFAULT_MAILBOX_QUOTA_BYTES;

    @Config("mail:auto_provision:timeout_ms", 10_000)
    protected autoProvisionTimeoutMs: number = 10_000;

    /**
     * Supplied by the Mongo/SQL concrete subclasses so `create()` can provision a new mailbox's Inbox/Drafts
     * folders (see below) without depending on either backend directly — same pattern as
     * `BaseMessageRoute.folderClass`.
     */
    protected abstract folderClass: any;

    /**
     * Supplied by the Mongo/SQL concrete subclasses so `create()` can check a candidate
     * `primarySmtpAddress` against `DistributionList` too - see the `uid` architecture note on
     * `DistributionList` and `BaseDistributionListRoute`'s symmetric check.
     */
    protected abstract distributionListClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `create()`/`autoProvision()`/`listDomains()` can
     * look up this server's verified domains without depending on either backend directly - see
     * `util/DomainUtils.ts`. */
    protected abstract domainClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `create()` can persist an `AuditLogEntry` for a
     * trusted-caller-created (shared/resource) mailbox without depending on either backend directly - see
     * `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `validateUpdate()` can check a caller-supplied
     * `escrowScopeId` actually refers to an existing `EscrowScope` without depending on either backend
     * directly - see `util/AuditLogUtils.ts`-style lazy-repo pattern used throughout this file. */
    protected abstract escrowScopeClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `delete()` can resolve an active `Matter` without
     * depending on either backend directly - see `util/LegalHoldUtils.ts`. */
    protected abstract matterClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `autoProvision()` can read the admin-editable
     * `MailboxPolicy`, whose saved values take precedence over the `mail:auto_provision:*` config. */
    protected abstract mailboxPolicyClass: any;

    private folderRepo?: RecoverableRepoUtils<any>;

    private distributionListRepo?: RepoUtils<DistributionList>;

    private escrowScopeRepo?: RepoUtils<EscrowScope>;

    /**
     * Returns the uids of every mailbox this user has any ACL grant on — as owner, as a shared delegate, or
     * (implicitly, via a wildcard/role record) as a trusted caller. Backend-specific because
     * `AccessControlList`'s storage shape differs (a natively queryable embedded array in Mongo vs. a
     * `simple-json` column in SQL) — implemented by the concrete `MailboxRouteMongo`/`MailboxRouteSQL`
     * subclass, each against the exact same `AccessControlList` collection/table `BaseACLRoute` exposes.
     */
    protected abstract findAccessibleMailboxUids(user: JWTUser): Promise<string[]>;

    /** The query value matching one element of an `aliasAddresses` column - a literal on Mongo (array-element
     * equality); `MailboxRouteSQL` overrides it for the serialized `simple-json` column, like `MailIngestRouteSQL`. */
    protected aliasQueryValue(address: string): any {
        return `eq(${address})`;
    }

    /**
     * Refuses (409) any of `addresses` already used by another mailbox or distribution list - as its uid, its primary
     * address or one of its aliases. `selfUid` (the mailbox being updated) is ignored, so a mailbox can rename onto its
     * own alias. Mail is delivered by exact primary/alias match, so a duplicate would hijack the other recipient's mail.
     */
    private async assertAddressesAvailable(selfUid: string | undefined, addresses: string[]): Promise<void> {
        const distributionListRepo: RepoUtils<DistributionList> = await this.getDistributionListRepo();
        for (const address of new Set(addresses)) {
            const [mailboxByUid, listByUid, mailboxesByPrimary, mailboxesByAlias, listsByPrimary, listsByAlias] = await Promise.all([
                this.repoUtils!.findOne(address, { ignoreACL: true }),
                distributionListRepo.findOne(address, { ignoreACL: true, includeDeleted: true }),
                this.repoUtils!.find({ primarySmtpAddress: `eq(${address})`, limit: 2 } as any, { ignoreACL: true, limit: 2 }),
                this.repoUtils!.find({ aliasAddresses: this.aliasQueryValue(address), limit: 2 } as any, { ignoreACL: true, limit: 2 }),
                distributionListRepo.find({ primarySmtpAddress: `eq(${address})`, limit: 1 } as any, { ignoreACL: true, limit: 1 }),
                distributionListRepo.find({ aliasAddresses: this.aliasQueryValue(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }),
            ]);
            const otherMailbox: boolean = [mailboxByUid, ...mailboxesByPrimary, ...mailboxesByAlias].some(
                (mailbox) => !!mailbox && mailbox.uid !== selfUid,
            );
            if (otherMailbox || listByUid || listsByPrimary.length > 0 || listsByAlias.length > 0) {
                throw new ApiError(
                    ApiErrors.IDENTIFIER_EXISTS,
                    409,
                    "This address is already in use by another mailbox or distribution list.",
                );
            }
        }
    }

    /**
     * Refuses (409) re-creating a mailbox at `uid` while data from a previously deleted mailbox with the same uid still
     * exists: any `Folder` (soft-deleted included) naming it, or an `AccessControlList` with that uid. Deleting a mailbox
     * removes only the mailbox row and its own ACL; its folders keep their ACLs (parented to the mailbox uid) and its
     * content keeps `mailboxUid`. A new mailbox at the same address would re-create the parent ACL - handing the new
     * owner every old folder and message - and `findOrCreateWellKnownFolder()` would reuse the old Inbox. An address is
     * freed for reuse by erasing the mailbox (`DataSubjectErasureRequest`, which purges its content and then the mailbox)
     * rather than deleting it outright.
     */
    private async assertNoLeftoverMailboxData(uid: string): Promise<void> {
        const folderRepo: RecoverableRepoUtils<any> = await this.getFolderRepo();
        const folderCount: number = await folderRepo.count({ mailboxUid: `eq(${uid})` } as any, { ignoreACL: true, includeDeleted: true });
        const acl = await this.aclUtils?.findACL(uid, [], { skipCache: true });
        if (folderCount > 0 || acl) {
            throw new ApiError(
                ApiErrors.IDENTIFIER_EXISTS,
                409,
                "This address still has data from a deleted mailbox. Erase that data before reusing the address.",
            );
        }
    }

    private async getFolderRepo(): Promise<RecoverableRepoUtils<any>> {
        if (!this.folderRepo) {
            this.folderRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                name: this.folderClass.name,
                args: [this.folderClass],
            });
        }
        return this.folderRepo;
    }

    private async getDistributionListRepo(): Promise<RepoUtils<DistributionList>> {
        if (!this.distributionListRepo) {
            this.distributionListRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.distributionListClass.name,
                args: [this.distributionListClass],
            });
        }
        return this.distributionListRepo;
    }

    private async getEscrowScopeRepo(): Promise<RepoUtils<EscrowScope>> {
        if (!this.escrowScopeRepo) {
            this.escrowScopeRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.escrowScopeClass.name,
                args: [this.escrowScopeClass],
            });
        }
        return this.escrowScopeRepo;
    }

    /**
     * Assigning a mailbox to an escrow scope is a trusted-administrator action (`specs/end-to-end_encryption.md`'s
     * "Separation of duties" - a mailbox's own owner never picks their own escrow scope). A patch that
     * doesn't touch `escrowScopeId` at all is left alone; `null`/`""` unassigns (allowed for a trusted
     * caller with no further check); any other value must resolve to a real `EscrowScope`.
     *
     * Only enforced on a genuine change from `existing.escrowScopeId` - same "only act on a real change"
     * guard `validateUpdate()` already applies to `primarySmtpAddress` above, needed for the identical
     * reason: a full-object PUT round-trips every field including this one, and on SQL a `nullable: true`
     * column with nothing set reads back as literal `null` (not `undefined`) - without this check, that
     * harmless round-trip of an already-unassigned mailbox would look identical to a non-trusted caller
     * newly attempting to assign one, and get rejected with a 403 it never asked for.
     */
    private async validateEscrowScopeAssignment(id: string, obj: Record<string, unknown>, isTrusted: boolean): Promise<void> {
        if (obj.escrowScopeId === undefined) {
            return;
        }
        const normalizedNew: string | undefined = (obj.escrowScopeId as string | null) || undefined;
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        const normalizedExisting: string | undefined = existing?.escrowScopeId || undefined;
        if (normalizedNew === normalizedExisting) {
            return;
        }
        if (!isTrusted) {
            throw new ApiError(
                ApiErrors.AUTH_PERMISSION_FAILURE,
                403,
                "Assigning a mailbox to an escrow scope is a trusted-administrator action.",
            );
        }
        if (normalizedNew !== undefined) {
            const repo: RepoUtils<EscrowScope> = await this.getEscrowScopeRepo();
            const scope: EscrowScope | undefined = await repo.findOne(normalizedNew, { ignoreACL: true });
            if (!scope) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, "The referenced escrow scope does not exist.");
            }
        }
    }

    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        if (objs.some((o) => !o || typeof o !== "object" || Array.isArray(o))) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }
        for (const o of objs) {
            // `_id` would replace another mailbox's document on Mongo - see `util/RequestBodyUtils.ts`.
            stripClientCreateFields(o);
            coerceDateFields(o, MAILBOX_DATE_FIELDS);
            rejectServerManagedFields(o as Record<string, unknown>);
            // A brand-new mailbox always starts unscoped - assignment only ever happens afterward via
            // `update()`/`validateEscrowScopeAssignment()`, which also checks the referenced scope actually
            // exists. Rejected for every caller, trusted or not, rather than silently ignored.
            if ((o as any).escrowScopeId !== undefined) {
                throw new ApiError(
                    ApiErrors.INVALID_REQUEST,
                    400,
                    "A new mailbox cannot be created with an escrow scope already assigned - set it via update() instead.",
                );
            }
        }
        if (!isTrusted) {
            for (const o of objs) {
                if ((o as any).isResource) {
                    throw new ApiError(
                        ApiErrors.AUTH_PERMISSION_FAILURE,
                        403,
                        "Resource mailboxes may only be created by a trusted administrator.",
                    );
                }
                (o as any).ownerUserUid = user.uid;
            }
            await this.assertSelfServiceCreate(objs, req);
        } else {
            for (const o of objs) {
                if ((o as any).ownerUserUid === null || (o as any).ownerUserUid === "") {
                    // No owner: a shared mailbox.
                    delete (o as any).ownerUserUid;
                } else if (o.ownerUserUid !== undefined) {
                    (o as any).ownerUserUid = this.parseOwnerUserUid(o.ownerUserUid, user);
                }
            }
        }
        return this.createMailboxes(obj, objs, req, user, isTrusted);
    }

    /**
     * The owner a trusted caller assigns: a user uid (UUID-shaped, stored lowercase), or the caller's own uid whatever
     * its shape. Anything else - a role name, `anonymous`, a wildcard, a typo - would leave the mailbox owned by nobody
     * who can sign in, or by far more than one person wherever the owner is matched against ACL records.
     */
    private parseOwnerUserUid(value: unknown, user: JWTUser | undefined): string {
        const uid: string | undefined = normalizeUserUid(value) ?? (value === user?.uid ? (value as string) : undefined);
        if (uid === undefined) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'ownerUserUid' must be a user uid.");
        }
        return uid;
    }

    /**
     * Holds a non-trusted caller's `POST /` to the same rules as `autoProvision()`, which it could otherwise sidestep:
     * the mailbox policy must allow self-service mailboxes (and is read fail-closed), every address - primary and
     * aliases - must be one of the caller's own auth-server name aliases on a verified domain, and the quota is the
     * policy's self-service quota with nothing yet used, whatever the request says.
     */
    private async assertSelfServiceCreate(objs: T[], req: HttpRequest): Promise<void> {
        const policy = await findOrSeedMailboxPolicy(this._objectFactory!, this.mailboxPolicyClass, {
            defaultQuotaBytes: this.defaultQuotaBytes,
            autoProvisionEnabled: this.autoProvisionEnabled,
            autoProvisionQuotaBytes: this.autoProvisionQuotaBytes,
        }, this.logger, true);
        const domains: string[] = await getVerifiedDomainNames(this._objectFactory!, this.domainClass);
        const hasAliasSource: boolean = this.staticAliases.length > 0 || !!this.authServerUrl;
        if (!policy.autoProvisionEnabled || domains.length === 0 || !hasAliasSource) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Creating your own mailbox is not enabled on this server.");
        }
        const aliases: string[] = (await this.fetchNameAliases(req)).map((alias) => alias.toLowerCase());
        const ownAddress = (address: unknown): boolean => ownsAddress(aliases, domains, address);
        for (const o of objs) {
            const addresses: unknown[] = [o.primarySmtpAddress, ...(Array.isArray(o.aliasAddresses) ? o.aliasAddresses : [])];
            // A missing primary address is left to the check below, which answers it with a 400.
            if (addresses.some((address, i) => (i > 0 || address) && !ownAddress(address))) {
                throw new ApiError(
                    ApiErrors.AUTH_PERMISSION_FAILURE,
                    403,
                    "You can only create a mailbox at one of your own usernames on this server's domains.",
                );
            }
            (o as any).quotaBytes = policy.autoProvisionQuotaBytes;
            (o as any).usedBytes = 0;
        }
    }

    /** Creates already-authorized mailboxes: the domain and address checks every caller gets, then the rows and their
     * well-known folders. */
    private async createMailboxes(obj: T | T[], objs: T[], req: HttpRequest, user: JWTUser, isTrusted: boolean): Promise<T | T[]> {
        for (const o of objs) {
            normalizeAddressFields(o as Record<string, unknown>);
            if (o.aliasAddresses !== undefined && !Array.isArray(o.aliasAddresses)) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'aliasAddresses' must be a list of addresses.");
            }
            // A missing primary address is answered with its own 400 below.
            assertPlainAddresses([...(o.primarySmtpAddress ? [o.primarySmtpAddress] : []), ...(o.aliasAddresses ?? [])]);
        }
        // Applies to every caller, trusted or not — this server's verified `Domain`s (once at least one
        // exists) are the one source of truth for which domains it accepts mail on at all, not just a
        // self-service guard.
        const domains: string[] = await getVerifiedDomainNames(this._objectFactory!, this.domainClass);
        if (domains.length > 0) {
            for (const o of objs) {
                const domain = o.primarySmtpAddress?.split("@")[1]?.toLowerCase();
                if (!domain || !domains.includes(domain)) {
                    throw new ApiError(
                        ApiErrors.INVALID_REQUEST,
                        400,
                        `Mailbox addresses must be on one of this server's verified domains: ${domains.join(", ")}.`,
                    );
                }
            }
        }

        // `uid` is derived from the mailbox's own address (e.g. `joe@domain.com`) rather than a random id, so
        // that address uniqueness across *every* addressable entity (a `Mailbox`, a `DistributionList`) is a
        // cheap `uid` lookup instead of a separate per-entity field-uniqueness check - see the architecture
        // note on `DistributionList`. Unconditionally overwrites any client-supplied `uid`, same override-style
        // already used above for `ownerUserUid`. Only newly-created mailboxes get this treatment; an
        // already-provisioned mailbox keeps whatever `uid` it already has.
        const distributionListRepo: RepoUtils<DistributionList> = await this.getDistributionListRepo();
        const seenUids: Set<string> = new Set();
        for (const o of objs) {
            if (!o.primarySmtpAddress) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
            }
            const candidateUid: string = normalizeAddress(o.primarySmtpAddress);
            (o as any).uid = candidateUid;
            // Precomputed alongside `uid` for the same reason `uid` itself is derived here rather than left to
            // the caller - the public discovery endpoint (Group E) needs an indexed lookup by this hash, not a
            // per-request hash-everything scan, so it must always reflect the mailbox's current address.
            (o as any).keyDiscoveryHash = computeKeyDiscoveryHash(o.primarySmtpAddress.split("@")[0]);
            if (seenUids.has(candidateUid)) {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "Duplicate address within the same request.");
            }
            seenUids.add(candidateUid);

            const [existingMailbox, existingList] = await Promise.all([
                this.repoUtils!.findOne(candidateUid, { ignoreACL: true, includeDeleted: true }),
                distributionListRepo.findOne(candidateUid, { ignoreACL: true, includeDeleted: true }),
            ]);
            if (existingMailbox || existingList) {
                throw new ApiError(
                    ApiErrors.IDENTIFIER_EXISTS,
                    409,
                    "This address is already in use by another mailbox or distribution list.",
                );
            }
            // Aliases are delivered to exactly like the primary address, so they get the same collision check; the
            // primary is also checked against other mailboxes' current addresses (a renamed mailbox keeps its old uid).
            await this.assertAddressesAvailable(undefined, [candidateUid, ...(o.aliasAddresses ?? [])]);
            await this.assertNoLeftoverMailboxData(candidateUid);
        }

        const created: T[] = Array.isArray(obj)
            ? await this.doBulkCreate(objs, { req, user, ignoreACL: true })
            : [await this.doCreateObject(objs[0], { req, user, ignoreACL: true })];

        // A brand-new mailbox with zero folders is unusable the moment its owner opens it: the webmail
        // client's `MailShell`/`CalendarShell`/`ContactsShell`/`TasksShell` each select a specific
        // well-known folder as their default view (with none found, they show an empty/broken state even
        // though the mailbox itself exists), and Compose needs a `drafts` folder uid in hand before it will
        // create a new draft. Every *other* well-known folder (Junk, Sent Items, Deleted Items, ...) stays
        // lazily provisioned on first actual use — see `findOrCreateWellKnownFolder`'s own doc comment —
        // only these five are load-bearing for the client to render anything at all, so only these five are
        // created eagerly here.
        // `RepoUtils.create()` grants only a non-trusted creator; a mailbox an administrator creates for someone else
        // would leave its owner with no access record at all.
        if (isTrusted) {
            for (const mailbox of created) {
                if (mailbox.ownerUserUid) {
                    await this.syncOwnerAcl(mailbox.uid, undefined, mailbox.ownerUserUid);
                }
            }
        }

        const folderRepo: RecoverableRepoUtils<any> = await this.getFolderRepo();
        for (const mailbox of created) {
            await findOrCreateWellKnownFolder(folderRepo, this.folderClass, mailbox.uid, FolderType.INBOX, user);
            await findOrCreateWellKnownFolder(folderRepo, this.folderClass, mailbox.uid, FolderType.DRAFTS, user);
            await findOrCreateWellKnownFolder(folderRepo, this.folderClass, mailbox.uid, FolderType.CALENDAR, user);
            await findOrCreateWellKnownFolder(folderRepo, this.folderClass, mailbox.uid, FolderType.CONTACTS, user);
            await findOrCreateWellKnownFolder(folderRepo, this.folderClass, mailbox.uid, FolderType.TASKS, user);
        }

        // Only a trusted caller's mailbox creation is audited - matches `AuditAction`'s own scope
        // (org-wide/admin actions), not routine self-service signup.
        if (isTrusted) {
            for (const mailbox of created) {
                await recordAuditLog(
                    this._objectFactory!,
                    this.auditLogClass,
                    { config: this.config, req, user, logger: this.logger },
                    {
                        action: AuditAction.MAILBOX_CREATE,
                        targetType: "Mailbox",
                        targetUid: mailbox.uid,
                        mailboxUid: mailbox.uid,
                        details: { primarySmtpAddress: mailbox.primarySmtpAddress, isResource: !!(mailbox as any).isResource },
                    },
                );
            }
        }

        return Array.isArray(obj) ? created : created[0];
    }

    /**
     * Single override point for every CRUD update path: `CRUDRoute.update()` runs this via its `@Validate
     * ("validateUpdate")` decorator, `updateBulk()` runs it once per element via `validateUpdateBulk()`, and
     * `updateProperty()` calls it explicitly before persisting - see `node_modules/@rapidrest/service-core`'s
     * `CRUDRoute.js`. Overriding `update()` alone (the previous approach here) missed `updateBulk()` entirely,
     * since it calls `super.doBulkUpdate()` directly rather than going through `update()` - `validateUpdate()`
     * is the one hook all three genuinely share.
     *
     * Does two things:
     * 1. Rejects a client-supplied `keys`/`keyDiscoveryHash` outright (`SERVER_MANAGED_FIELDS`, mirroring
     * `BaseContactRoute`'s identical guard for `Contact`'s own discovery-managed fields).
     * 2. Keeps `keyDiscoveryHash` in sync whenever a patch actually touches `primarySmtpAddress` -
     * `RepoUtils.update()`/`updateBulk()` are a genuine partial patch, so an absent `primarySmtpAddress`
     * means "leave it alone" and must leave the hash alone too, not recompute it from a value that was
     * never sent. This works for `update()`/`updateBulk()` because the framework validates the *actual*
     * update object by reference (mutating it here is what `update()`'s own former override relied on
     * too) - but NOT for `updateProperty()`, which validates a throwaway `{ [propertyName]: obj }` wrapper
     * `doUpdateProperty()` never actually persists; see this class's own `updateProperty()` override below
     * for how that path is handled instead.
     */
    //
    // `@Request` (argument 3) is added to what `CRUDRoute` already injects so `validateAliasChange()` can check a
    // self-service caller's usernames; the inherited `@Param("id")`/`@User` metadata is kept.
    protected async validateUpdate(id: string, obj: UpdateObject<T>, user?: JWTUser, @Request req?: HttpRequest): Promise<void> {
        // `aliasAddresses.3`/`keys.0` would be Mongo update paths past every check below - see `util/RequestBodyUtils.ts`.
        assertNoPathKeys(obj);
        stripClientId(obj);
        coerceDateFields(obj, MAILBOX_DATE_FIELDS);
        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        await this.validateEscrowScopeAssignment(id, obj, isTrusted);
        rejectServerManagedFields(obj);
        await this.validateTrustedOnlyFields(id, obj, user, isTrusted);
        normalizeAddressFields(obj);
        if (obj.aliasAddresses !== undefined) {
            await this.validateAliasChange(id, obj, isTrusted, req);
        }
        if (obj.primarySmtpAddress !== undefined) {
            // Only re-validate when the address is genuinely changing, not merely present in the patch (a
            // client round-tripping the full object back unchanged must not start failing because e.g. a
            // domain was un-verified after the fact - the same "only act on a real change" guard
            // `BaseDomainRoute.update()` applies to its own uid-derived `name` field).
            const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
            if (existing && normalizeAddress(existing.primarySmtpAddress) !== obj.primarySmtpAddress) {
                await this.validateAddressChange(id, obj.primarySmtpAddress);
            }
            (obj as any).keyDiscoveryHash = computeKeyDiscoveryHash(obj.primarySmtpAddress.split("@")[0]);
        }
        return super.validateUpdate(id, obj, user);
    }

    /**
     * Holds addresses an update ADDS to `aliasAddresses` to create's rules (removing aliases is always allowed): each
     * must be a plain address on a verified domain (400), a non-trusted caller may only add addresses at their own
     * auth-server usernames on a verified domain (403, as `assertSelfServiceCreate()`), and none may already belong to
     * another mailbox or distribution list (409). Without this, a mailbox owner could add any address - another
     * mailbox's, a distribution list's, an unverified domain's - as an alias and receive its mail.
     *
     * `req` (for the caller's `jwt` cookie) reaches here from `PUT /:id` and `PUT /:id/aliasAddresses`; `CRUDRoute`'s bulk
     * validator doesn't pass it, so a non-trusted bulk update adding an alias fails closed unless static aliases are
     * configured.
     */
    private async validateAliasChange(id: string, obj: Record<string, any>, isTrusted: boolean, req: HttpRequest | undefined): Promise<void> {
        if (!Array.isArray(obj.aliasAddresses)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'aliasAddresses' must be a list of addresses.");
        }
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        const current: Set<string> = new Set((existing?.aliasAddresses ?? []).map((alias) => normalizeAddress(alias)));
        obj.aliasAddresses = [...new Set(obj.aliasAddresses as unknown[])];
        const candidates: unknown[] = (obj.aliasAddresses as unknown[]).filter((alias) => typeof alias !== "string" || !current.has(alias));
        if (candidates.length === 0) {
            return;
        }
        assertPlainAddresses(candidates);
        const added: string[] = candidates as string[];
        const domains: string[] = await getVerifiedDomainNames(this._objectFactory!, this.domainClass);
        if (domains.length > 0 && added.some((alias) => !domains.includes(alias.split("@")[1]))) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `Mailbox addresses must be on one of this server's verified domains: ${domains.join(", ")}.`,
            );
        }
        if (!isTrusted) {
            const hasAliasSource: boolean = this.staticAliases.length > 0 || !!this.authServerUrl;
            const usernames: string[] = hasAliasSource && domains.length > 0 ? (await this.fetchNameAliases(req)).map((a) => a.toLowerCase()) : [];
            if (added.some((alias) => !ownsAddress(usernames, domains, alias))) {
                throw new ApiError(
                    ApiErrors.AUTH_PERMISSION_FAILURE,
                    403,
                    "You can only add an alias at one of your own usernames on this server's domains.",
                );
            }
        }
        await this.assertAddressesAvailable(id, added);
    }

    /**
     * Refuses a non-trusted caller's change to `TRUSTED_ONLY_FIELDS`, and checks a trusted caller's new `ownerUserUid`
     * (see `parseOwnerUserUid()`). Like the escrow scope check, only a real change counts, so a full-object `PUT`
     * round-tripping the current values - including an owner uid stored before this check existed - still works.
     */
    private async validateTrustedOnlyFields(id: string, obj: Record<string, any>, user: JWTUser | undefined, isTrusted: boolean): Promise<void> {
        const touched = TRUSTED_ONLY_FIELDS.filter((field) => obj[field] !== undefined);
        if (touched.length === 0) {
            return;
        }
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        for (const field of touched) {
            let changed: boolean;
            if (field === "ownerUserUid") {
                // `null` (SQL's unset) and `""` both mean no owner.
                const next: unknown = obj.ownerUserUid || undefined;
                const current: string | undefined = existing?.ownerUserUid || undefined;
                changed = typeof next === "string" && typeof current === "string" ? next.toLowerCase() !== current.toLowerCase() : next !== current;
                if (!changed) {
                    obj.ownerUserUid = existing?.ownerUserUid;
                } else if (isTrusted && next !== undefined) {
                    obj.ownerUserUid = this.parseOwnerUserUid(next, user);
                }
            } else {
                changed = obj[field] !== (existing as any)?.[field];
            }
            if (changed && !isTrusted) {
                throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, `'${field}' can only be changed by a trusted administrator.`);
            }
        }
    }

    /**
     * Re-runs `create()`'s own verified-domain and collision checks against a changed `primarySmtpAddress` -
     * without this, `validateUpdate()` recomputed `keyDiscoveryHash` for a changed address but never actually
     * validated it, so a self-service owner (via a raw `PUT` of the whole object, or `updateProperty()`'s
     * dedicated single-field rename endpoint - see its own doc comment: `uid` deliberately stays fixed across
     * an address change, so `primarySmtpAddress` and `uid` can legitimately diverge after a rename) could
     * point their own mailbox's `primarySmtpAddress` at ANY string, including an existing `DistributionList`'s
     * address. Since `BaseMailIngestRoute.findExactMailboxByAddress()` is always tried before
     * `findDistributionListByAddress()`, that would silently hijack the list's inbound mail to the caller's
     * own mailbox instead. Checked by `primarySmtpAddress` field value (matching that same mail-resolution
     * query), not `uid` - the whole point is that `uid` no longer reliably tracks the current address post-
     * rename, so a `uid`-keyed collision check alone wouldn't catch this.
     */
    private async validateAddressChange(id: string, newAddress: string): Promise<void> {
        assertPlainAddresses([newAddress]);
        const domains: string[] = await getVerifiedDomainNames(this._objectFactory!, this.domainClass);
        if (domains.length > 0) {
            const domain = newAddress.split("@")[1]?.toLowerCase();
            if (!domain || !domains.includes(domain)) {
                throw new ApiError(
                    ApiErrors.INVALID_REQUEST,
                    400,
                    `Mailbox addresses must be on one of this server's verified domains: ${domains.join(", ")}.`,
                );
            }
        }

        // Against other mailboxes' and lists' uids, primary addresses and aliases alike.
        await this.assertAddressesAvailable(id, [newAddress]);
    }

    /**
     * For every property except `primarySmtpAddress`, `super.updateProperty()` calls `this.validateUpdate()`
     * itself before persisting, so `keys`/`keyDiscoveryHash` rejection is already covered there. This override
     * exists only for `primarySmtpAddress`, which `validateUpdate()` *can't* keep `keyDiscoveryHash` in sync
     * for here (see its own doc comment) - redirected to the full `update()` path instead, which can.
     * `update()`'s underlying `doUpdate()` enforces optimistic-concurrency locking against `version`, which a
     * single-property PUT's caller never supplies (its own route contract has no such field) - the record is
     * re-fetched here specifically to supply it, not merely to validate existence.
     *
     * Calling `this.update()` here is a plain in-process method call, NOT an HTTP dispatch - so the
     * `@Validate("validateUpdate")` pipeline middleware that would normally run `validateUpdate()` (and, via
     * it, `validateAddressChange()`) for a real `PUT` never fires. This override calls `validateAddressChange()`
     * explicitly itself for exactly that reason - confirmed the hard way: an earlier version of this method
     * assumed `validateUpdate()` would run automatically here, and a regression test against this exact
     * endpoint (renaming to an address already claimed by a `DistributionList`) caught that it didn't.
     */
    public async updateProperty(id: string, propertyName: string, obj: any, user?: JWTUser, @Request req?: HttpRequest): Promise<T> {
        assertPlainPropertyName(propertyName);
        if (propertyName === "primarySmtpAddress") {
            const current: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
            if (!current) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            if (typeof obj !== "string") {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'primarySmtpAddress' must be an address.");
            }
            obj = normalizeAddress(obj);
            // This redirects straight to `this.update()` below rather than going through the framework's own
            // HTTP dispatch (there is none here - this is a plain in-process call), so the `@Validate
            // ("validateUpdate")` pipeline middleware that would normally run `validateUpdate()` for a real
            // PUT never fires for this path. `validateAddressChange()` must therefore be called explicitly
            // here too, the same "only on a genuine change" guard `validateUpdate()` itself applies.
            if (normalizeAddress(current.primarySmtpAddress) !== obj) {
                await this.validateAddressChange(id, obj);
            }
            return this.update(
                id,
                {
                    uid: id,
                    primarySmtpAddress: obj,
                    keyDiscoveryHash: computeKeyDiscoveryHash(String(obj).split("@")[0]),
                    version: (current as any).version,
                } as UpdateObject<T>,
                undefined as unknown as HttpRequest,
                user,
            );
        }
        // As `CRUDRoute.updateProperty()`, except that what's saved is the value `validateUpdate()` left in the patch -
        // a normalized alias list or owner uid, not the raw one.
        const patch: Record<string, any> = { [propertyName]: obj };
        await this.validateUpdate(id, patch as UpdateObject<T>, user, req);
        const previousOwner: string | undefined = propertyName === "ownerUserUid" ? await this.ownerOf(id) : undefined;
        const updated: T = await this.doUpdateProperty(id, propertyName, patch[propertyName], { user });
        if (propertyName === "ownerUserUid") {
            await this.syncOwnerAcl(updated.uid, previousOwner, updated.ownerUserUid);
        }
        return updated;
    }

    /** As `CRUDRoute.update()`, moving the owner's ACL record when the update changed `ownerUserUid`. */
    public async update(id: string, obj: UpdateObject<T>, req: HttpRequest, user?: JWTUser): Promise<T> {
        const ownerChange: boolean = Object.keys(Object(obj)).includes("ownerUserUid");
        const previousOwner: string | undefined = ownerChange ? await this.ownerOf(id) : undefined;
        const updated: T = await super.update(id, obj, req, user);
        if (ownerChange) {
            await this.syncOwnerAcl(updated.uid, previousOwner, updated.ownerUserUid);
        }
        return updated;
    }

    /** As `CRUDRoute.updateBulk()`, moving each changed owner's ACL record. */
    public async updateBulk(obj: UpdateObject<T>[], req: HttpRequest, user?: JWTUser): Promise<T[]> {
        const previousOwners: Map<string, string | undefined> = new Map();
        for (const single of obj) {
            if (Object.keys(Object(single)).includes("ownerUserUid")) {
                previousOwners.set(String(single.uid), await this.ownerOf(String(single.uid)));
            }
        }
        const updated: T[] = await super.updateBulk(obj, req, user);
        for (const mailbox of updated) {
            if (previousOwners.has(mailbox.uid)) {
                await this.syncOwnerAcl(mailbox.uid, previousOwners.get(mailbox.uid), mailbox.ownerUserUid);
            }
        }
        return updated;
    }

    private async ownerOf(id: string): Promise<string | undefined> {
        const mailbox: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true, skipCache: true });
        return mailbox?.ownerUserUid || undefined;
    }

    /**
     * Keeps the mailbox's owner grant on its `AccessControlList` in step with `ownerUserUid`: removes `previousOwner`'s
     * record and gives `newOwner` a `FULL` record (replacing any narrower one). A no-op when the owner didn't change
     * (case-insensitive) or the mailbox has no ACL. Retried on a concurrent ACL save.
     */
    private async syncOwnerAcl(mailboxUid: string, previousOwner: string | undefined, newOwner: string | undefined): Promise<void> {
        const previous: string | undefined = previousOwner?.toLowerCase();
        const next: string | undefined = newOwner?.toLowerCase();
        if (previous === next) {
            return;
        }
        for (let attempt = 1; ; attempt++) {
            const acl = await this.aclUtils!.findACL(mailboxUid, [], { skipCache: true });
            /* v8 ignore if -- every mailbox is created with an ACL */
            if (!acl) {
                return;
            }
            const records = acl.records.filter((record) => {
                const member: string = String(record.userOrRoleId).toLowerCase();
                return member !== previous && member !== next;
            });
            if (newOwner) {
                records.push({ userOrRoleId: newOwner, actions: [ACLAction.FULL] });
            }
            acl.records = records;
            try {
                await this.aclUtils!.saveACL(acl);
                return;
                /* v8 ignore start -- only a concurrent ACL write between the read and the save reaches here */
            } catch (err) {
                if (attempt >= 3) {
                    throw err;
                }
            }
            /* v8 ignore stop */
        }
    }

    /**
     * Self-service mailbox creation with no `Mailbox` object required from the caller — for a deployment
     * where users only ever come from an external auth-server and are never manually provisioned a
     * mailbox first. Disabled unless `mail:auto_provision:enabled` is on and at least one verified
     * `Domain` exists (see the `@Config` fields above and `util/DomainUtils.ts`).
     *
     * A mailbox needs a `primarySmtpAddress`, which this route has no way to know on its own — the caller
     * has no email registered anywhere in this system yet by definition. Instead, this derives candidates
     * from the identity auth-server already has for them: it calls auth-server's own `GET /api/aliases/me?
     * type=name` (forwarding the caller's own `jwt` cookie, so it only ever sees that user's own aliases)
     * and offers the caller the full cross product of those aliases against this server's verified
     * domains — a deployment can serve more than one domain, and the caller should get to pick which
     * (alias, domain) pair they want, not have one silently chosen for them even when there's only one
     * possible combination. So with no `body.alias`/`body.domain`, this *always* returns `needs_selection`
     * rather than creating anything; only a call that supplies both, validated fresh against the real
     * alias list and the verified domain list (never trusted blindly), actually creates the mailbox.
     *
     * Idempotent: a caller who already owns a mailbox gets it back (`status: "existing"`) rather than a
     * second one, since nothing prevents this being called more than once (e.g. two tabs racing on first
     * login) — checked before ever contacting auth-server.
     */
    @Auth(["jwt"])
    @Post("/auto-provision")
    public async autoProvision(
        @Request req: HttpRequest,
        body: { alias?: string; domain?: string } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<MailboxAutoProvisionResult<T>> {
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const hasAliasSource = this.staticAliases.length > 0 || !!this.authServerUrl;
        const domains: string[] = await getVerifiedDomainNames(this._objectFactory!, this.domainClass);
        const policy = await findOrSeedMailboxPolicy(this._objectFactory!, this.mailboxPolicyClass, {
            defaultQuotaBytes: this.defaultQuotaBytes,
            autoProvisionEnabled: this.autoProvisionEnabled,
            autoProvisionQuotaBytes: this.autoProvisionQuotaBytes,
        }, this.logger, true);
        if (!policy.autoProvisionEnabled || domains.length === 0 || !hasAliasSource) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "Automatic mailbox provisioning is not enabled.");
        }

        const existing: T[] = await this.repoUtils.find({ ownerUserUid: user.uid }, {
            ignoreACL: true,
            limit: 1,
        });
        if (existing.length > 0) {
            return { status: "existing", mailbox: existing[0] };
        }

        const aliases: string[] = await this.fetchNameAliases(req);
        if (aliases.length === 0) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "No username is registered for this account.");
        }

        if (!body?.alias || !body?.domain) {
            return {
                status: "needs_selection",
                options: aliases.flatMap((alias) =>
                    domains.map((domain) => ({ alias, domain, primarySmtpAddress: `${alias}@${domain}` })),
                ),
            };
        }
        if (!aliases.includes(body.alias) || !domains.includes(body.domain)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        // Everything `create()` would check for a self-service caller was checked above, against the same policy read.
        const requested = {
            primarySmtpAddress: `${body.alias}@${body.domain}`,
            displayName: body.alias,
            ownerUserUid: user.uid,
            timezone: "UTC",
            quotaBytes: policy.autoProvisionQuotaBytes,
        } as T;
        const mailbox = (await this.createMailboxes(requested, [requested], req, user, UserUtils.hasRoles(user, this.trustedRoles))) as T;
        return { status: "created", mailbox };
    }

    /** This server's verified domains — lets a client (e.g. the admin console's "New mailbox" form)
     * constrain the domain half of an address to what this server actually accepts, without hardcoding or
     * duplicating that list client-side. */
    @Auth(["jwt"])
    @Get("/domains")
    public async listDomains(): Promise<string[]> {
        return await getVerifiedDomainNames(this._objectFactory!, this.domainClass);
    }

    /** The caller's own auth-server "name" aliases (e.g. usernames), via `GET /api/aliases/me?type=name` —
     * forwarding their `jwt` cookie is what scopes the call to *their* aliases specifically. Skips that
     * call entirely (see `staticAliases`'s own doc comment for why) when a fixed list is configured. */
    private async fetchNameAliases(req: HttpRequest | undefined): Promise<string[]> {
        if (this.staticAliases.length > 0) {
            return this.staticAliases;
        }

        const jwtCookie = req?.cookies?.["jwt"];
        if (!jwtCookie) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "Could not verify your identity with the identity service.");
        }

        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), this.autoProvisionTimeoutMs);
        let response: Response;
        try {
            response = await fetch(`${this.authServerUrl}/api/aliases/me?type=name`, {
                headers: { Cookie: `jwt=${jwtCookie}` },
                signal: controller.signal,
            });
        } catch {
            throw new ApiError(
                ApiErrors.INTERNAL_ERROR,
                502,
                "Could not reach the identity service to determine your mailbox address.",
            );
        } finally {
            clearTimeout(timeoutHandle);
        }
        if (!response.ok) {
            throw new ApiError(
                ApiErrors.INTERNAL_ERROR,
                502,
                "Could not reach the identity service to determine your mailbox address.",
            );
        }

        const data = (await response.json()) as Array<{ value?: string; name?: string }>;
        return Array.isArray(data)
            ? data.map((entry) => entry.value ?? entry.name).filter((value): value is string => !!value)
            : [];
    }

    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<T[]> {
        if (!this.repoUtils || !user) {
            return [];
        }
        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        let scopedQuery: any = { ...query, ...params };
        if (!isTrusted) {
            // `$or` and friends would override the forced `uid` filter below on SQL - see `stripUnsafeQueryKeys()`.
            scopedQuery = { ...stripUnsafeQueryKeys(query), ...params };
            const accessibleUids: string[] = await this.findAccessibleMailboxUids(user);
            // An empty array must short-circuit rather than be passed through as a query filter value: the
            // underlying query builder "zips" an array filter value's *last* element onto any query branch
            // past its own length, so an empty array resolves to `undefined` for that field — which TypeORM
            // (and this builder) treats as "no filter on this field", not "match nothing". Passing it through
            // would incorrectly return every mailbox to a caller who is entitled to see none.
            if (accessibleUids.length === 0) {
                return [];
            }
            scopedQuery = { ...scopedQuery, uid: accessibleUids };
        }
        return await this.repoUtils.find(scopedQuery, {
            limit: query?.limit,
            page: query?.page,
            version: query?.version,
            user,
            ignoreACL: true,
        });
    }

    public async count(
        @Param() params: any,
        @Query() query: any,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<any> {
        if (!this.repoUtils || !user) {
            return res.status(200).setHeader("content-length", 0);
        }
        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        let scopedQuery: any = { ...query, ...params };
        if (!isTrusted) {
            scopedQuery = { ...stripUnsafeQueryKeys(query), ...params };
            const accessibleUids: string[] = await this.findAccessibleMailboxUids(user);
            // See the identical short-circuit (and its rationale) in `find()` above.
            if (accessibleUids.length === 0) {
                return res.status(200).setHeader("content-length", 0);
            }
            scopedQuery = { ...scopedQuery, uid: accessibleUids };
        }
        const result: number = await this.repoUtils.count(scopedQuery, {
            limit: query?.limit,
            page: query?.page,
            version: query?.version,
            user,
            ignoreACL: true,
        });
        return res.status(200).setHeader("content-length", result);
    }

    public async exists(
        @Param("id") id: string,
        @Query() query: any,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<any> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const existing: T | undefined = await this.repoUtils.findOne(id, {
            version: query?.version,
            includeDeleted: query?.deleted === true || query?.deleted === "true",
            ignoreACL: true,
        });
        const permitted: boolean = existing
            ? await this.aclUtils!.hasPermission(user, existing.uid, ACLAction.EXISTS)
            : false;
        return permitted
            ? res.status(200).setHeader("content-length", 1)
            : res.status(404).setHeader("content-length", 0);
    }

    /**
     * Wraps the inherited `CRUDRoute.findById()` (unchanged) with an `AuditLogEntry` when the caller
     * isn't this mailbox's own owner - an admin or a delegate viewing someone else's mailbox profile. See
     * `util/AuditLogUtils.ts`'s `isNonOwnerAccess()`.
     */
    @Get("/:id")
    public async findById(@Param("id") id: string, @Query() query: any, @AuthUser user?: JWTUser): Promise<T | null> {
        const result: T | null = await super.findById(id, query, user);
        if (result && isNonOwnerAccess(result, user)) {
            await recordAuditLog(
                this._objectFactory!,
                this.auditLogClass,
                { config: this.config, user, logger: this.logger },
                {
                    action: AuditAction.MAILBOX_ACCESSED,
                    targetType: "Mailbox",
                    targetUid: result.uid,
                    details: { primarySmtpAddress: result.primarySmtpAddress },
                },
            );
        }
        return result;
    }

    /**
     * Adds a legal-hold check ahead of the inherited `CRUDRoute.delete()` - `Mailbox` isn't a
     * `RecoverableBaseEntity` (no soft-delete option exists for it at all, unlike `Message`/`Contact`/
     * etc.), so every delete here is already an unconditional, irreversible removal; there is no
     * "ordinary soft-delete stays unaffected" carve-out for this one entity the way
     * `BaseScopedChildRoute.checkLegalHold()`'s own doc comment describes. Checked with no reference
     * date - a whole-mailbox delete removes everything in it regardless of date, so it must be blocked by
     * ANY open hold on the mailbox, not just one whose date range happens to be checked against a single
     * record.
     */
    @Delete("/:id")
    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const existing: T | undefined = await this.repoUtils.findOne(id, { version, ignoreACL: true });
        if (existing) {
            try {
                await assertNotOnLegalHold(this._objectFactory!, this.matterClass, existing.uid);
            } catch (err) {
                await recordAuditLog(
                    this._objectFactory!,
                    this.auditLogClass,
                    { config: this.config, req, user, logger: this.logger },
                    {
                        action: AuditAction.LEGAL_HOLD_BLOCKED_DELETE,
                        targetType: "Mailbox",
                        targetUid: existing.uid,
                        details: { primarySmtpAddress: existing.primarySmtpAddress },
                    },
                );
                throw err;
            }
        }
        await super.delete(id, version, purge, req, user);
    }

    /** Fetches every page of `repoUtils.find(criteria, ...)` results - `truncate()`'s legal-hold check
     * below must see every matched record, not a sample truncated at this framework's own default page
     * size - mirrors `ErasureExecutionJob.findAllPages()`'s identical rationale. */
    private async findAllForTruncate(params: any, query: any, user: JWTUser | undefined, pageSize: number = 500): Promise<T[]> {
        const all: T[] = [];
        for (let page = 0; ; page++) {
            const batch: T[] = await this.repoUtils!.find({ ...query, ...params, limit: pageSize, page }, { limit: pageSize, page, user });
            all.push(...batch);
            if (batch.length < pageSize) {
                break;
            }
        }
        return all;
    }

    /**
     * Adds the identical legal-hold check to the inherited `CRUDRoute.truncate()` that `delete()` above
     * adds to `CRUDRoute.delete()` - `truncate()` has no `purge` option at all (it is unconditionally a
     * hard, permanent delete for every mailbox it matches, the same as `delete()`'s own irreversibility
     * here), so leaving it unchecked would let a caller destroy a held mailbox simply by preferring this
     * bulk endpoint over the equivalent singular `delete()` call. The final delete is re-scoped to exactly
     * the uids just checked, never delegated to `super.truncate()` with the original `params`/`query` -
     * `RepoUtils.truncate()` re-executes that filter live at the moment it runs, independent of `matched`
     * above; passing it through unchanged would let a mailbox that starts matching in the gap between the
     * snapshot and this call be deleted having never been through `assertNotOnLegalHold()` at all. Safe to
     * pair with `ignoreACL: true` here specifically because this method is only ever reachable by a
     * trusted caller in the first place (`Mailbox`'s own deny-by-default class ACL fast-fails anyone else
     * before this method's body ever runs) - `matched` already reflects exactly what that trusted caller's
     * own unconditional bypass would return either way.
     */
    @Delete()
    public async truncate(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser): Promise<void> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const matched: T[] = await this.findAllForTruncate(params, query, user);
        if (matched.length === 0) {
            return;
        }
        for (const existing of matched) {
            try {
                await assertNotOnLegalHold(this._objectFactory!, this.matterClass, existing.uid);
            } catch (err) {
                await recordAuditLog(
                    this._objectFactory!,
                    this.auditLogClass,
                    { config: this.config, user, logger: this.logger },
                    {
                        action: AuditAction.LEGAL_HOLD_BLOCKED_DELETE,
                        targetType: "Mailbox",
                        targetUid: existing.uid,
                        details: { primarySmtpAddress: existing.primarySmtpAddress },
                    },
                );
                throw err;
            }
        }
        // One literal `eq(uid)` per mailbox: `in(a,b)` is split on commas by the query parser, so a uid containing one
        // would have widened the delete.
        for (const existing of matched) {
            await this.repoUtils.truncate({ uid: `eq(${existing.uid})` } as any, { user, ignoreACL: true });
        }
    }
}
