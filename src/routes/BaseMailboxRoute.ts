///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    type ACLRecord,
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
import { AuditAction, DistributionList, EscrowScope, Mailbox } from "../models/types.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { isNonOwnerAccess, recordAuditLog } from "../util/AuditLogUtils.js";
import { assertAdminScope, hasMailAccess, isAdminScope, isTrustedUser, stripTrustedRoles } from "../util/MailAccessUtils.js";
import { getPrimaryDomainNames } from "../util/DomainUtils.js";
import { ensureWellKnownFolders } from "../util/FolderUtils.js";
import { assertFreeBusyVisibility, effectiveFreeBusyVisibility } from "../util/FreeBusyLookupUtils.js";
import { DEFAULT_TIME_ZONE, isValidTimeZone } from "../util/TimeZoneUtils.js";
import { computeKeyDiscoveryHash } from "../util/KeyDiscoveryClient.js";
import { hasAddressLikeDisplayName } from "../util/MimeHeaderUtils.js";
import { assertNotOnLegalHold } from "../util/LegalHoldUtils.js";
import {
    fileLeftoverErasure,
    findLeftoverEvidence,
    findRunningErasure,
    leftoverConflict,
    listLeftoverMailboxes,
    parseLeftoverLimit,
    type LeftoverListContext,
    type LeftoverMailboxPage,
} from "../util/LeftoverMailboxUtils.js";
import { DEFAULT_MAILBOX_QUOTA_BYTES, findOrSeedMailboxPolicy } from "../util/MailboxPolicyUtils.js";
import {
    LOOKUP_MAX_ATTEMPTS,
    LOOKUP_WINDOW_SECONDS,
    MAX_PRINCIPAL_LENGTH,
    principalNotFoundMessage,
    resolvePrincipal,
    type PrincipalResolutionContext,
    type ResolvedPrincipal,
} from "../util/PrincipalResolutionUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
import { normalizeUserUid } from "../util/UserUidUtils.js";
import { coerceDateFields } from "../util/DateCoercionUtils.js";
import { assertNoPathKeys, assertPlainPropertyName, stripClientCreateFields, stripClientId } from "../util/RequestBodyUtils.js";
const { Auth, Delete, Get, Param, Post, Query, RateLimit, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/** One mailbox's owner change: `ownerUserUid` before (`previous`) and after (`next`) the update; `undefined` for none. */
interface OwnerChange {
    mailboxUid: string;
    previous: string | undefined;
    next: string | undefined;
}

/** An order-independent key of `records` (lowercased members, sorted actions), for comparing two record sets. */
function recordsKey(records: ACLRecord[]): string {
    return JSON.stringify(
        records.map((record) => `${String(record.userOrRoleId).toLowerCase()}:${[...record.actions].sort().join(",")}`).sort(),
    );
}

/** Whether two owner uids name the same owner (case-insensitively; `undefined` for none). */
function sameOwner(a: string | undefined, b: string | undefined): boolean {
    return a?.toLowerCase() === b?.toLowerCase();
}

/** Every top-level `Date` field of `Mailbox` a client writes - coerced on create/update (see `util/DateCoercionUtils.ts`). */
const MAILBOX_DATE_FIELDS = ["oofStartTime", "oofEndTime"] as const;
/** How many uids `truncate()` deletes per `RepoUtils.truncate()` call, keeping each SQL `IN` list bounded. */
const TRUNCATE_BATCH_SIZE = 500;
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

/** The `Mailbox` fields an administrator may change on a mailbox they neither own nor hold a grant on (and the only ones
 * `?scope=admin` shows): how the mailbox is addressed, who owns it, how much it may store, and the resource/policy
 * flags. Anything else on the row - the out-of-office text, the receipt and encryption preferences, the keys - is the
 * owner's, and is neither shown to nor writable by an administrator without impersonating the owner. */
const ADMIN_MANAGED_FIELDS = [
    "ownerUserUid",
    "primarySmtpAddress",
    "aliasAddresses",
    "displayName",
    "timezone",
    "quotaBytes",
    "usedBytes",
    "isResource",
    "resourceType",
    "resourceCapacity",
    "autoAcceptBookings",
    "allowConflicts",
    "bookingWindowDays",
    "maxDurationMinutes",
    "escrowScopeId",
] as const;

/** What an administration-scope (`?scope=admin`) read of a mailbox returns: `ADMIN_MANAGED_FIELDS` plus the entity's own
 * bookkeeping and the mailbox's encryption preference (a policy input). Never keys, rules, signatures, the out-of-office
 * text or anything counted per folder. */
const ADMIN_METADATA_FIELDS = ["uid", "version", "dateCreated", "dateModified", ...ADMIN_MANAGED_FIELDS, "encryptPreference"] as const;

/** Query keys an administration-scope list may filter or sort by - the metadata only, so a filter can't be used to probe
 * a field the projection hides (`oofMessage=like(...)`). Paging keys pass too. */
const ADMIN_QUERY_KEYS: ReadonlySet<string> = new Set([...ADMIN_METADATA_FIELDS, "limit", "page", "sort"]);

/** `mailbox` reduced to what an administrator may see without owning or being granted it (`ADMIN_METADATA_FIELDS`), with
 * `shared` (no single owner) added. */
function toAdminMetadata<T extends Mailbox>(mailbox: T): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const field of ADMIN_METADATA_FIELDS) {
        const value: unknown = (mailbox as any)[field];
        if (value !== undefined) {
            result[field] = value;
        }
    }
    result.shared = !mailbox.ownerUserUid;
    return result;
}

/** `query` restricted to `ADMIN_QUERY_KEYS` (no `$` keys, no paths, no `scope`), for an administration-scope list. */
function sanitizeAdminQuery(query: any): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(query ?? {})) {
        const allowed: boolean =
            key === "sort"
                ? typeof value === "string" && value.split(",").every((part) => ADMIN_QUERY_KEYS.has(part.replace(/^-/, "")))
                : ADMIN_QUERY_KEYS.has(key);
        if (allowed) {
            result[key] = value;
        }
    }
    return result;
}

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

/** An `@` or a look-alike (fullwidth, small form), or a line break - the same `@` class as `MimeHeaderUtils`' own
 * (module-private) `AT_SIGN_LIKE`. */
const DISPLAY_NAME_REFUSED = /[@＠﹫\r\n]/;

/** Whether `name`, put in a `From` display name as its UTF-8 bytes, would read as address-like to the send path's
 * `hasAddressLikeDisplayName()` - which also decodes RFC 2047 encoded words (`=?utf-8?q?a=40b?=`). */
function looksAddressLikeInFrom(name: string): boolean {
    const quoted: string = Buffer.from(name.replace(/[\\"]/g, "\\$&"), "utf8").toString("binary");
    return hasAddressLikeDisplayName(`"${quoted}" <sender@example.invalid>`);
}

/**
 * Refuses (400) a `displayName` that isn't a string, or that contains `@` (or a fullwidth/small look-alike, or an RFC
 * 2047 encoded word decoding to one) or a line break. It becomes the display name of the `From` header on every message
 * the mailbox sends (server compose and the web client both build it from here), and the send path rejects a `From`
 * whose display name looks like an address (`hasAddressLikeDisplayName()`) - so a mailbox named `support@example.com`
 * or `support＠example.com` could never send anything. `null`/`undefined` (no display name) is allowed.
 */
function assertValidDisplayName(value: unknown): void {
    if (value === undefined || value === null) {
        return;
    }
    if (typeof value !== "string" || DISPLAY_NAME_REFUSED.test(value) || looksAddressLikeInFrom(value)) {
        throw new ApiError(
            ApiErrors.INVALID_REQUEST,
            400,
            "'displayName' must be text without '@' or line breaks - it is shown as the sender name on mail from this mailbox.",
        );
    }
}

/** See `stripUnsafeQueryKeys()` on `BaseScopedChildRoute.ts` - drops `$or`/`$and`/... (and `$` path segments), which on
 * SQL override the forced `uid` filter. */
function stripUnsafeQueryKeys(query: any): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(query ?? {})) {
        if (key !== "scope" && !key.split(".").some((segment) => segment.startsWith("$"))) {
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
 * **Nobody sees a mailbox they neither own nor were granted - an administrator included.** `find`/`count` answer with
 * the owned and ACL-granted mailboxes for EVERY caller, `findById`/`exists`/`update`/`delete` resolve the caller through
 * `hasMailAccess()`/`mailUser()` (`util/MailAccessUtils.ts`), and a trusted role is never a grant. An administrator who
 * needs to see who else has a mailbox asks `?scope=admin` (`GET /` and `GET /:id`; trusted AND elevated, else 403
 * `api-103`/`api-104`), which answers `ADMIN_METADATA_FIELDS` for every mailbox and is audited (`MAILBOX_ADMIN_LIST`/
 * `MAILBOX_ADMIN_READ`); an administrator manages a mailbox they hold no grant on through the same `PUT`/`DELETE`s, but
 * only `ADMIN_MANAGED_FIELDS` are writable that way, the answer is that same metadata, and the change is audited
 * (`MAILBOX_ADMIN_UPDATE`/`MAILBOX_ADMIN_DELETE`). A mailbox an administrator creates without an owner (a shared/org
 * mailbox) gets an explicit `FULL` grant for the creating administrator, so it is one of "their" shared mailboxes; an
 * existing ownerless mailbox reaches an administrator only through the mailbox Sharing action
 * (`BaseMailboxAccessRoute`), an explicit and audited act.
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
     * Base URL of the auth-server whose `GET /api/aliases?type=name` (the caller's own name aliases) `autoProvision()` below calls.
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

    /** Supplied by the Mongo/SQL concrete subclasses so the leftover-data endpoints (`GET /leftover`, `DELETE ?erase=true`) can
     * count a deleted mailbox's messages without depending on either backend directly - see `util/LeftoverMailboxUtils.ts`. */
    protected abstract messageClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so a deleted mailbox's data can be erased through the erasure request
     * `ErasureExecutionJob` runs, and so `create()` can see one in flight - see `util/LeftoverMailboxUtils.ts`. */
    protected abstract dataSubjectErasureRequestClass: any;

    private folderRepo?: RecoverableRepoUtils<any>;

    private messageRepo?: RecoverableRepoUtils<any>;

    private erasureRequestRepo?: RepoUtils<any>;

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

    /** Whether `user` holds `action` on `uid` (a mailbox uid) by ownership or an ACL record - never by a trusted role. */
    protected hasMailAccess(user: JWTUser | undefined, uid: string, action: string): Promise<boolean> {
        return hasMailAccess(this.aclUtils, this.trustedRoles, user, uid, action);
    }

    /** `user` without its trusted roles, for the inherited `CRUDRoute` handlers (`RepoUtils` treats a trusted caller as a
     * superuser). */
    protected mailUser(user: JWTUser | undefined): JWTUser | undefined {
        return stripTrustedRoles(user, this.trustedRoles);
    }

    /** Whether `user` is acting as an administrator on mailbox `id`: trusted, and holding no grant of their own for
     * `action` on it. Only `ADMIN_MANAGED_FIELDS` may then be written and only their metadata is answered. */
    private async isAdminOnly(id: string, user: JWTUser | undefined, action: string): Promise<boolean> {
        return isTrustedUser(user, this.trustedRoles) && !(await this.hasMailAccess(user, id, action));
    }

    /** Drops everything but `ADMIN_MANAGED_FIELDS` (and the record's `uid`/`version`, and the `keyDiscoveryHash` this route
     * derives from a changed address - a client's own is refused by `rejectServerManagedFields()`) from a patch, silently - so
     * a full-object round trip of what an administrator was shown still saves. */
    private restrictToAdminFields(obj: Record<string, unknown>): void {
        for (const key of Object.keys(obj)) {
            if (key !== "uid" && key !== "version" && key !== "keyDiscoveryHash" && !(ADMIN_MANAGED_FIELDS as readonly string[]).includes(key)) {
                delete obj[key];
            }
        }
    }

    /** The uids of the mailboxes `user` may see in a list of their mailboxes: the ones they hold READ on, by ownership or
     * an ACL record for their uid (or one of their non-trusted roles) - the same for every caller. */
    private async accessibleMailboxUids(user: JWTUser): Promise<string[]> {
        const candidates: string[] = await this.findAccessibleMailboxUids(this.mailUser(user)!);
        const readable: boolean[] = await Promise.all(candidates.map((uid) => this.hasMailAccess(user, uid, ACLAction.READ)));
        return candidates.filter((_uid, i) => readable[i]);
    }

    /** Records one administration-scope action on a mailbox (or, for a list, `targetUid: "*"`). */
    private async auditAdmin(
        req: HttpRequest | undefined,
        user: JWTUser | undefined,
        action: AuditAction,
        targetUid: string,
        details: Record<string, any>,
    ): Promise<void> {
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action, targetType: "Mailbox", targetUid, ...(targetUid === "*" ? {} : { mailboxUid: targetUid }), details },
        );
    }

    /** The query value matching one element of an `aliasAddresses` column - a literal on Mongo (array-element
     * equality); `MailboxRouteSQL` overrides it for the serialized `simple-json` column, like `MailIngestRouteSQL`. */
    protected aliasQueryValue(address: string): any {
        return ModelUtils.literal(address);
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
                this.repoUtils!.find({ primarySmtpAddress: ModelUtils.literal(address), limit: 2 } as any, { ignoreACL: true, limit: 2 }),
                this.repoUtils!.find({ aliasAddresses: this.aliasQueryValue(address), limit: 2 } as any, { ignoreACL: true, limit: 2 }),
                distributionListRepo.find({ primarySmtpAddress: ModelUtils.literal(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }),
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

    /** Adds a `FULL` record for `userUid` to the (new, ownerless) mailbox's ACL. Retried on a concurrent ACL save. */
    private async grantCreator(mailboxUid: string, userUid: string): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            const acl = await this.aclUtils!.findACL(mailboxUid, [], { skipCache: true });
            /* v8 ignore if -- every mailbox is created with an ACL */
            if (!acl) {
                return;
            }
            // A brand-new mailbox's ACL holds no record yet (a trusted creator gets none from `RepoUtils.create()`).
            acl.records = [...acl.records, { userOrRoleId: userUid, actions: [ACLAction.FULL] }];
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
     * Refuses (409) re-creating a mailbox at `uid` while data from a previously deleted mailbox with the same uid still
     * exists: any `Folder` (soft-deleted included) naming it, or an `AccessControlList` with that uid. Deleting a mailbox
     * removes only the mailbox row and its own ACL; its folders keep their ACLs (parented to the mailbox uid) and its
     * content keeps `mailboxUid`. A new mailbox at the same address would re-create the parent ACL - handing the new
     * owner every old folder and message - and `findOrCreateWellKnownFolder()` would reuse the old Inbox. An address is
     * freed for reuse by erasing what the mailbox left: an administrator files the erasure (`GET /mailboxes/leftover` lists
     * what is waiting, `POST /erasure-requests/leftover` or `DELETE /mailboxes/:id?erase=true` files it), and
     * `ErasureExecutionJob` purges the content, the folders with their ACLs and the mailbox's own ACL. Also refused while such an
     * erasure is still running for the address, even once its folders are gone, so the job's last steps can't meet a mailbox
     * created meanwhile.
     *
     * The 409 carries a machine-readable `reason` - `mailbox-data-remaining` (offer the erasure), or `mailbox-data-erasing` with
     * the running request's `erasure: { uid, status }` (wait for it) - besides `mailboxUid`.
     */
    private async assertNoLeftoverMailboxData(uid: string): Promise<void> {
        const { folderCount, hasAcl } = await findLeftoverEvidence(await this.getFolderRepo(), this.aclUtils, uid);
        const running = await findRunningErasure(await this.getErasureRequestRepo(), uid);
        if (running) {
            throw leftoverConflict("mailbox-data-erasing", "The data at this address is being erased. Try again once that has finished.", {
                mailboxUid: uid,
                erasure: { uid: running.uid, status: running.status },
            });
        }
        if (folderCount > 0 || hasAcl) {
            throw leftoverConflict(
                "mailbox-data-remaining",
                "This address still has data from a deleted mailbox. Erase that data before reusing the address.",
                { mailboxUid: uid },
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

    private async getMessageRepo(): Promise<RecoverableRepoUtils<any>> {
        if (!this.messageRepo) {
            this.messageRepo = await this._objectFactory!.newInstance(RecoverableRepoUtils, {
                name: this.messageClass.name,
                args: [this.messageClass],
            });
        }
        return this.messageRepo;
    }

    private async getErasureRequestRepo(): Promise<RepoUtils<any>> {
        if (!this.erasureRequestRepo) {
            this.erasureRequestRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.dataSubjectErasureRequestClass.name,
                args: [this.dataSubjectErasureRequestClass],
            });
        }
        return this.erasureRequestRepo;
    }

    /** What the leftover-data helpers (`util/LeftoverMailboxUtils.ts`) work through. */
    private async leftoverContext(): Promise<LeftoverListContext> {
        return {
            objectFactory: this._objectFactory!,
            mailboxRepo: this.repoUtils!,
            folderRepo: await this.getFolderRepo(),
            messageRepo: await this.getMessageRepo(),
            requestRepo: await this.getErasureRequestRepo(),
            requestClass: this.dataSubjectErasureRequestClass,
            matterClass: this.matterClass,
            auditLogClass: this.auditLogClass,
            aclUtils: this.aclUtils,
            config: this.config,
            logger: this.logger,
        };
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
            delete (o as any).accessRole;
            coerceDateFields(o, MAILBOX_DATE_FIELDS);
            rejectServerManagedFields(o as Record<string, unknown>);
            // Anybody may create a mailbox that shares its free/busy however they like; only a value that is no choice is refused.
            if ((o as any).freeBusyVisibility === null) {
                delete (o as any).freeBusyVisibility;
            } else if ((o as any).freeBusyVisibility !== undefined) {
                assertFreeBusyVisibility((o as any).freeBusyVisibility);
            }
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
            await this.assertSelfServiceCreate(objs, req, user);
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

    /** This route's own `PrincipalResolutionContext` (see `resolveOwner()`) - `this.repoUtils` IS the mailbox repo
     * here (unlike `BaseMailboxAccessRoute`, which builds one lazily), so no `init()` step is needed first. */
    private principalResolutionContext(): PrincipalResolutionContext {
        return {
            mailboxRepo: this.repoUtils!,
            aliasQueryValue: (address) => this.aliasQueryValue(address),
            authServerUrl: this.authServerUrl,
            staticAliases: this.staticAliases,
            authTimeoutMs: this.autoProvisionTimeoutMs,
        };
    }

    /**
     * Who `principal` - a mailbox address, an auth-server username or e-mail alias, or a user uid - is, without
     * assigning anything: `{ userUid, displayName?, address? }`, for an administrator naming a mailbox's owner (at
     * creation, or a future reassignment) to confirm before saving. 404 for nobody.
     *
     * Trusted-role-only, matching `TRUSTED_ONLY_FIELDS`'s own gate on `ownerUserUid` (`validateTrustedOnlyFields()`
     * refuses a non-trusted caller's change to it outright) - a non-trusted caller can only ever be the owner of their
     * own newly self-created mailbox anyway (`create()` forces it), so has no legitimate use for resolving anyone.
     * Mirrors `BaseMailboxAccessRoute.resolve()`'s exact contract (exact-match, same rate limit, same 404 wording) -
     * see `util/PrincipalResolutionUtils.ts` for the shared resolution logic both routes call.
     */
    @RequiresTrustedRole()
    @RateLimit({ perUser: true, maxAttempts: LOOKUP_MAX_ATTEMPTS, windowSeconds: LOOKUP_WINDOW_SECONDS })
    @Get("/resolve-owner")
    public async resolveOwner(@Query("principal") principal: unknown, @AuthUser user?: JWTUser, @Request req?: HttpRequest): Promise<ResolvedPrincipal> {
        if (typeof principal !== "string" || principal.trim().length === 0 || principal.length > MAX_PRINCIPAL_LENGTH) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The 'principal' query parameter must be an address, username or user uid.");
        }
        const resolved: ResolvedPrincipal | undefined = await resolvePrincipal(this.principalResolutionContext(), principal, user, req);
        if (!resolved) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, principalNotFoundMessage(principal.trim()));
        }
        return resolved;
    }

    /**
     * Holds a non-trusted caller's `POST /` to the same rules as `autoProvision()`, which it could otherwise sidestep:
     * the mailbox policy must allow self-service mailboxes (and is read fail-closed), every address - primary and
     * aliases - must be one of the caller's own auth-server name aliases on a verified domain, and the quota is the
     * policy's self-service quota with nothing yet used, whatever the request says.
     */
    private async assertSelfServiceCreate(objs: T[], req: HttpRequest, user: JWTUser): Promise<void> {
        const policy = await findOrSeedMailboxPolicy(this._objectFactory!, this.mailboxPolicyClass, {
            defaultQuotaBytes: this.defaultQuotaBytes,
            autoProvisionEnabled: this.autoProvisionEnabled,
            autoProvisionQuotaBytes: this.autoProvisionQuotaBytes,
        }, this.logger, true);
        // A pure alias `Domain` (`Domain.aliasOf`) has no mailboxes of its own by design - a self-service
        // caller must not be able to claim an address on one any more than a trusted caller can (see
        // `createMailboxes()`'s own `getPrimaryDomainNames()` check below, which this mirrors).
        const domains: string[] = await getPrimaryDomainNames(this._objectFactory!, this.domainClass);
        const hasAliasSource: boolean = this.staticAliases.length > 0 || !!this.authServerUrl;
        if (!policy.autoProvisionEnabled || domains.length === 0 || !hasAliasSource) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Creating your own mailbox is not enabled on this server.");
        }
        const aliases: string[] = (await this.fetchNameAliases(req, user)).map((alias) => alias.toLowerCase());
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
            assertValidDisplayName((o as any).displayName);
            normalizeAddressFields(o as Record<string, unknown>);
            if (o.aliasAddresses !== undefined && !Array.isArray(o.aliasAddresses)) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'aliasAddresses' must be a list of addresses.");
            }
            // A missing primary address is answered with its own 400 below.
            assertPlainAddresses([...(o.primarySmtpAddress ? [o.primarySmtpAddress] : []), ...(o.aliasAddresses ?? [])]);
        }
        // Applies to every caller, trusted or not — this server's verified, non-alias `Domain`s (once at
        // least one exists) are the one source of truth for which domains a mailbox may actually live on -
        // not just a self-service guard. A pure alias `Domain` (`Domain.aliasOf`) is deliberately excluded:
        // it has no mailboxes of its own by design (mail addressed to it is delivered via
        // `resolveDomainAlias()` to a mailbox on the domain it aliases instead - see `BaseMailIngestRoute`).
        const domains: string[] = await getPrimaryDomainNames(this._objectFactory!, this.domainClass);
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
                // `aliasAddresses` supplied at create time must be held to the same non-alias-domain rule as
                // the primary address - otherwise a caller could sidestep `validateAliasChange()`'s equivalent
                // check entirely by supplying the alias-domain address at creation instead of via a later
                // `PUT .../aliasAddresses`.
                const aliasDomains: string[] = (o.aliasAddresses ?? []).map((alias) => alias.split("@")[1]?.toLowerCase());
                if (aliasDomains.some((aliasDomain) => !aliasDomain || !domains.includes(aliasDomain))) {
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
        // create a new draft. So EVERY well-known folder (Inbox, Drafts, Outbox, Sent Items, Deleted Items, Junk Email,
        // Archive, Calendar, Contacts, Tasks, Notes - `WELL_KNOWN_FOLDER_TYPES`) is created here, in one idempotent step
        // (`ensureWellKnownFolders()`): folders that only appeared at first use (Outbox/Sent Items at the first send)
        // were never announced to a client that was already open, and a shared mailbox never had them at all.
        // `RepoUtils.create()` grants only a non-trusted creator; a mailbox an administrator creates for someone else
        // would leave its owner with no access record at all.
        //
        // An ownerless (shared/org) mailbox an administrator creates is granted to that administrator explicitly - an
        // administrator has no implicit access to any mailbox, so without it the creator could not open what they just made.
        if (isTrusted) {
            for (const mailbox of created) {
                if (mailbox.ownerUserUid) {
                    await this.moveOwnerAcl({ mailboxUid: mailbox.uid, previous: undefined, next: mailbox.ownerUserUid });
                } else {
                    await this.grantCreator(mailbox.uid, user.uid);
                }
            }
        }

        const folderRepo: RecoverableRepoUtils<any> = await this.getFolderRepo();
        for (const mailbox of created) {
            await ensureWellKnownFolders(folderRepo, this.folderClass, mailbox.uid, user);
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
                        details: {
                            primarySmtpAddress: mailbox.primarySmtpAddress,
                            isResource: !!(mailbox as any).isResource,
                            ...(mailbox.ownerUserUid ? {} : { sharedWithCreator: user.uid }),
                        },
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
        // Computed on read (`withAccessRole()`), so a full object round-tripped back doesn't store it.
        delete (obj as any).accessRole;
        coerceDateFields(obj, MAILBOX_DATE_FIELDS);
        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        // An administrator with no grant of their own on this mailbox may change its administrative settings only.
        if (isTrusted && !(await this.hasMailAccess(user, id, ACLAction.UPDATE))) {
            this.restrictToAdminFields(obj);
        }
        await this.validateEscrowScopeAssignment(id, obj, isTrusted);
        await this.validateFreeBusyVisibilityChange(id, obj, user);
        rejectServerManagedFields(obj);
        await this.validateTrustedOnlyFields(id, obj, user, isTrusted);
        await this.validateDisplayNameChange(id, obj);
        normalizeAddressFields(obj);
        if (obj.aliasAddresses !== undefined) {
            await this.validateAliasChange(id, obj, isTrusted, req, user);
        }
        if (obj.primarySmtpAddress !== undefined) {
            // Only re-validate when the address is genuinely changing, not merely present in the patch (a
            // client round-tripping the full object back unchanged must not start failing because e.g. a
            // domain was un-verified after the fact - the same "only act on a real change" guard
            // `BaseDomainRoute.update()` applies to its own uid-derived `name` field).
            const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
            if (existing && normalizeAddress(existing.primarySmtpAddress) !== obj.primarySmtpAddress) {
                await this.validateAddressChange(id, obj.primarySmtpAddress, isTrusted, req, user);
            }
            (obj as any).keyDiscoveryHash = computeKeyDiscoveryHash(obj.primarySmtpAddress.split("@")[0]);
        }
        return super.validateUpdate(id, obj, user);
    }

    /**
     * Who may see this mailbox's free/busy (`Mailbox.freeBusyVisibility`) is the owner's decision: a value that is not one of
     * `FREE_BUSY_VISIBILITIES` is a 400, and a real change needs full access to the mailbox - the owner's own record or a
     * "manager" delegate's - so a delegate with plain update access can't widen it (403). An unchanged value passes for
     * everyone, so a full-object `PUT` round-tripping the current one still works, as does `null` (SQL's unset for a row
     * from before the field existed; dropped from the patch). An administrator with no grant of their own never gets here
     * with the field (`restrictToAdminFields()` drops it).
     */
    private async validateFreeBusyVisibilityChange(id: string, obj: Record<string, any>, user: JWTUser | undefined): Promise<void> {
        if (obj.freeBusyVisibility === undefined) {
            return;
        }
        if (obj.freeBusyVisibility === null) {
            delete obj.freeBusyVisibility;
            return;
        }
        assertFreeBusyVisibility(obj.freeBusyVisibility);
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (existing && effectiveFreeBusyVisibility(existing) !== obj.freeBusyVisibility && !(await this.hasMailAccess(user, id, ACLAction.FULL))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "Only the mailbox's owner can change who sees its free/busy.");
        }
    }

    /** `assertValidDisplayName()` on a `displayName` the patch actually changes - a full-object `PUT` round-tripping a
     * name stored before this check existed still works, so the mailbox's other settings can be edited while the owner
     * is asked to fix the name. */
    private async validateDisplayNameChange(id: string, obj: Record<string, any>): Promise<void> {
        if (obj.displayName === undefined) {
            return;
        }
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        if (existing?.displayName === obj.displayName) {
            return;
        }
        assertValidDisplayName(obj.displayName);
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
    private async validateAliasChange(
        id: string,
        obj: Record<string, any>,
        isTrusted: boolean,
        req: HttpRequest | undefined,
        user: JWTUser | undefined,
    ): Promise<void> {
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
        // Must exclude alias `Domain`s the same way `createMailboxes()` does - a pure alias domain has no
        // mailboxes of its own, so letting one through here would let a caller add e.g. `boss@plc.gg` (a pure
        // alias of `powerlevel.gg`) directly to their OWN mailbox's `aliasAddresses`, hijacking mail/send-as/
        // key-discovery for whatever mailbox `boss@powerlevel.gg` actually resolves to via `resolveDomainAlias()`.
        const domains: string[] = await getPrimaryDomainNames(this._objectFactory!, this.domainClass);
        if (domains.length > 0 && added.some((alias) => !domains.includes(alias.split("@")[1]))) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `Mailbox addresses must be on one of this server's verified domains: ${domains.join(", ")}.`,
            );
        }
        if (!isTrusted) {
            const hasAliasSource: boolean = this.staticAliases.length > 0 || !!this.authServerUrl;
            const usernames: string[] = hasAliasSource && domains.length > 0 ? (await this.fetchNameAliases(req, user)).map((a) => a.toLowerCase()) : [];
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
    //
    // A non-trusted caller may only rename onto one of their own auth-server usernames on a verified domain - the same
    // rule `validateAliasChange()` applies to an added alias and `assertSelfServiceCreate()` to a new mailbox. The
    // primary address is what mail is delivered to, what the mailbox sends as, what the internal CA and ACME issue
    // S/MIME certificates for and what key discovery publishes keys under, so without it an owner could rename their
    // mailbox to any unused address (`ceo@corp.com`) and become it. Fails closed (403) when no alias source or verified
    // domain is configured, and for a bulk update (which gets no `req` to forward) unless static aliases are configured.
    private async validateAddressChange(
        id: string,
        newAddress: string,
        isTrusted: boolean,
        req: HttpRequest | undefined,
        user: JWTUser | undefined,
    ): Promise<void> {
        assertPlainAddresses([newAddress]);
        // Same non-alias restriction `createMailboxes()` applies to a brand-new mailbox's address - a rename
        // can't land a mailbox on a pure alias domain any more than creating one there could.
        const domains: string[] = await getPrimaryDomainNames(this._objectFactory!, this.domainClass);
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
        if (!isTrusted) {
            const hasAliasSource: boolean = this.staticAliases.length > 0 || !!this.authServerUrl;
            const usernames: string[] = hasAliasSource && domains.length > 0 ? (await this.fetchNameAliases(req, user)).map((a) => a.toLowerCase()) : [];
            if (!ownsAddress(usernames, domains, newAddress)) {
                throw new ApiError(
                    ApiErrors.AUTH_PERMISSION_FAILURE,
                    403,
                    "You can only change your mailbox's address to one of your own usernames on this server's domains.",
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
        if (propertyName === "accessRole") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'accessRole' is computed from who is asking and cannot be set.");
        }
        const adminOnly: boolean = await this.isAdminOnly(id, user, ACLAction.UPDATE);
        if (adminOnly && !(ADMIN_MANAGED_FIELDS as readonly string[]).includes(propertyName)) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, `'${propertyName}' belongs to the mailbox's owner.`);
        }
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
                await this.validateAddressChange(id, obj, UserUtils.hasRoles(user, this.trustedRoles), req, user);
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
        // An administrator with no grant is the trusted caller `RepoUtils` lets through; anybody else is checked against the
        // mailbox's ACL as themselves.
        const caller: JWTUser | undefined = adminOnly ? user : this.mailUser(user);
        let updated: T;
        if (propertyName !== "ownerUserUid") {
            updated = await this.doUpdateProperty(id, propertyName, patch[propertyName], { user: caller });
        } else {
            const change: OwnerChange = { mailboxUid: id, previous: await this.ownerOf(id), next: patch.ownerUserUid || undefined };
            updated = await this.withOwnerAclMoved([change], () => this.doUpdateProperty(id, propertyName, patch[propertyName], { user: caller }));
        }
        return adminOnly ? await this.adminUpdated(updated, [propertyName], req, user) : updated;
    }

    /** What an administrator who changed a mailbox they hold no grant on is answered with and leaves behind: the mailbox's
     * administrative metadata (never the row) and a `MAILBOX_ADMIN_UPDATE` audit entry naming the fields. */
    private async adminUpdated(updated: T, fields: string[], req: HttpRequest | undefined, user: JWTUser | undefined): Promise<T> {
        await this.auditAdmin(req, user, AuditAction.MAILBOX_ADMIN_UPDATE, updated.uid, {
            primarySmtpAddress: updated.primarySmtpAddress,
            fields,
        });
        return toAdminMetadata(updated) as unknown as T;
    }

    /** As `CRUDRoute.update()`, moving the owner's ACL record when the update changes `ownerUserUid` (see
     * `withOwnerAclMoved()`). */
    public async update(id: string, obj: UpdateObject<T>, req: HttpRequest, user?: JWTUser): Promise<T> {
        const adminOnly: boolean = await this.isAdminOnly(id, user, ACLAction.UPDATE);
        if (adminOnly) {
            this.restrictToAdminFields(obj);
        }
        // An administrator with no grant is the trusted caller `RepoUtils` lets through (only `ADMIN_MANAGED_FIELDS` remain
        // in the patch); anybody else is checked against the mailbox's ACL as themselves.
        const caller: JWTUser | undefined = adminOnly ? user : this.mailUser(user);
        const fields: string[] = Object.keys(Object(obj)).filter((key) => key !== "uid" && key !== "version");
        let updated: T;
        if (!fields.includes("ownerUserUid")) {
            updated = await super.update(id, obj, req, caller);
        } else {
            const change: OwnerChange = { mailboxUid: id, previous: await this.ownerOf(id), next: (obj as any).ownerUserUid || undefined };
            updated = await this.withOwnerAclMoved([change], () => super.update(id, obj, req, caller));
        }
        return adminOnly ? await this.adminUpdated(updated, fields, req, user) : updated;
    }

    /** As `CRUDRoute.updateBulk()`, moving each changed owner's ACL record (see `withOwnerAclMoved()`). */
    public async updateBulk(obj: UpdateObject<T>[], req: HttpRequest, user?: JWTUser): Promise<T[]> {
        const changes: OwnerChange[] = [];
        for (const single of obj) {
            if (Object.keys(Object(single)).includes("ownerUserUid")) {
                const mailboxUid: string = String(single.uid);
                changes.push({ mailboxUid, previous: await this.ownerOf(mailboxUid), next: (single as any).ownerUserUid || undefined });
            }
        }
        // A trusted caller is passed through as themselves: each element was already reduced to `ADMIN_MANAGED_FIELDS` by
        // `validateUpdate()` unless they hold a grant on that mailbox. Anybody else is checked as themselves.
        const caller: JWTUser | undefined = isTrustedUser(user, this.trustedRoles) ? user : this.mailUser(user);
        const updated: T[] = await this.withOwnerAclMoved(changes, () => super.updateBulk(obj, req, caller));
        const result: T[] = [];
        for (const mailbox of updated) {
            if (await this.isAdminOnly(mailbox.uid, user, ACLAction.UPDATE)) {
                const single: Record<string, unknown> = obj.find((candidate) => candidate.uid === mailbox.uid)!;
                result.push(await this.adminUpdated(mailbox, Object.keys(single).filter((key) => key !== "uid" && key !== "version"), req, user));
            } else {
                result.push(mailbox);
            }
        }
        return result;
    }

    private async ownerOf(id: string): Promise<string | undefined> {
        const mailbox: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true, skipCache: true });
        return mailbox?.ownerUserUid || undefined;
    }

    /**
     * Runs `write` - an update that changes the owner of each of `changes`' mailboxes - with each mailbox's owner grant
     * already moved on its `AccessControlList` (`moveOwnerAcl()`). The ACL is changed FIRST so a failure can always be
     * repaired by retrying: the stored `ownerUserUid` still names the old owner until `write` commits, so a retry
     * recomputes the same move (which is idempotent). The earlier order - commit the owner, then move the grant - left
     * a failed ACL save unrepairable: the retry saw the new owner as the "previous" one, did nothing, and the ex-owner
     * kept `FULL` access.
     *
     * If `write` (or a later move) fails, each moved mailbox whose stored owner is still not the new one gets back the
     * two members' records it had before (`restoreOwnerAcl()`); one whose `write` already committed (a partial bulk
     * update) keeps its move. A failed restore is logged, never thrown over the original error - retrying the update
     * repairs it.
     *
     * Owner grants can't be told apart from delegate grants on the ACL itself (a `manager` delegate is also a `FULL`
     * record, and `ACLRecord` carries no other field), so "remove every owner-granted record of anyone but the current
     * owner" isn't possible against stored state alone - hence moving the grant before the owner changes instead.
     */
    private async withOwnerAclMoved<R>(changes: OwnerChange[], write: () => Promise<R>): Promise<R> {
        const moved: { change: OwnerChange; snapshot: ACLRecord[] }[] = [];
        try {
            for (const change of changes) {
                if (sameOwner(change.previous, change.next)) {
                    continue;
                }
                const snapshot: ACLRecord[] | undefined = await this.moveOwnerAcl(change);
                /* v8 ignore else -- every mailbox is created with an ACL */
                if (snapshot) {
                    moved.push({ change, snapshot });
                }
            }
            return await write();
        } catch (err) {
            // Newest move first: a later move's snapshot was taken on top of the earlier ones (e.g. a bulk update naming
            // the same mailbox twice), so undoing them oldest first would put back records a later move had replaced.
            for (const { change, snapshot } of [...moved].reverse()) {
                try {
                    if (!sameOwner(await this.ownerOf(change.mailboxUid), change.next)) {
                        await this.restoreOwnerAcl(change, snapshot);
                    }
                    /* v8 ignore start -- only a failing ACL store reaches here */
                } catch (restoreErr: any) {
                    this.logger?.error(
                        `BaseMailboxRoute: failed to restore the owner ACL of mailbox ${change.mailboxUid} after a failed update: ${restoreErr?.message}`,
                    );
                }
                /* v8 ignore stop */
            }
            throw err;
        }
    }

    /**
     * Removes `change.previous`'s records from the mailbox's `AccessControlList` and gives `change.next` a single `FULL`
     * record (replacing any narrower one), returning both members' records as they were beforehand (`undefined` when
     * the mailbox has no ACL). Idempotent. Retried on a concurrent ACL save.
     */
    private async moveOwnerAcl(change: OwnerChange): Promise<ACLRecord[] | undefined> {
        return this.rewriteOwnerAcl(change, (others) =>
            change.next ? [...others, { userOrRoleId: change.next, actions: [ACLAction.FULL] }] : others,
        );
    }

    /** Puts back the records `moveOwnerAcl()` returned for `change`'s two members - only while those members' records are
     * still exactly what the move wrote. Anything else means another owner change (a concurrent request) has rewritten
     * them since, and replaying this older snapshot over it would hand the mailbox to the wrong owner; that ACL is left
     * as it is (logged). */
    private async restoreOwnerAcl(change: OwnerChange, snapshot: ACLRecord[]): Promise<void> {
        const written: ACLRecord[] = change.next ? [{ userOrRoleId: change.next, actions: [ACLAction.FULL] }] : [];
        const replaced: ACLRecord[] | undefined = await this.rewriteOwnerAcl(change, (others) => [...others, ...snapshot], written);
        if (!replaced) {
            this.logger?.warn(
                `BaseMailboxRoute: not restoring the owner ACL of mailbox ${change.mailboxUid} - another owner change rewrote it after this one.`,
            );
        }
    }

    /** Replaces the records of `change`'s previous and next owner with `rebuild(everyone else's records)`, returning the
     * records it replaced. With `expected`, does nothing (and returns `undefined`) unless those members' current records
     * are exactly `expected` (compared by lowercased member and set of actions). */
    private async rewriteOwnerAcl(
        change: OwnerChange,
        rebuild: (others: ACLRecord[]) => ACLRecord[],
        expected?: ACLRecord[],
    ): Promise<ACLRecord[] | undefined> {
        const members: Set<string> = new Set(
            [change.previous, change.next].filter((member): member is string => !!member).map((member) => member.toLowerCase()),
        );
        const isMember = (record: ACLRecord): boolean => members.has(String(record.userOrRoleId).toLowerCase());
        for (let attempt = 1; ; attempt++) {
            const acl = await this.aclUtils!.findACL(change.mailboxUid, [], { skipCache: true });
            /* v8 ignore if -- every mailbox is created with an ACL */
            if (!acl) {
                return undefined;
            }
            const replaced: ACLRecord[] = acl.records
                .filter(isMember)
                .map((record) => ({ userOrRoleId: record.userOrRoleId, actions: [...record.actions] }));
            if (expected && recordsKey(replaced) !== recordsKey(expected)) {
                return undefined;
            }
            acl.records = rebuild(acl.records.filter((record) => !isMember(record)));
            try {
                await this.aclUtils!.saveACL(acl);
                return replaced;
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
     * from the identity auth-server already has for them: it calls auth-server's own `GET /api/aliases?
     * type=name` (forwarding the caller's own `jwt` cookie, so it only ever sees that user's own aliases)
     * and offers the caller the full cross product of those aliases against this server's verified
     * domains — a deployment can serve more than one domain, and the caller should get to pick which
     * (alias, domain) pair they want, not have one silently chosen for them even when there's only one
     * possible combination. A `body.timezone` (an IANA name, from the caller's device) becomes the mailbox's time zone,
     * else UTC. So with no `body.alias`/`body.domain`, this *always* returns `needs_selection`
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
        body: { alias?: string; domain?: string; timezone?: string } | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<MailboxAutoProvisionResult<T>> {
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const hasAliasSource = this.staticAliases.length > 0 || !!this.authServerUrl;
        // Non-alias domains only - auto-provisioning creates a real `Mailbox`, so it's bound by the same
        // domain restriction `createMailboxes()` enforces (see `getPrimaryDomainNames()`'s own doc comment).
        const domains: string[] = await getPrimaryDomainNames(this._objectFactory!, this.domainClass);
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

        const aliases: string[] = await this.fetchNameAliases(req, user);
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
            // The time zone the caller's device reports, when it is one (its owner can change it in their settings); UTC otherwise.
            timezone: isValidTimeZone(body?.timezone) ? body.timezone : DEFAULT_TIME_ZONE,
            quotaBytes: policy.autoProvisionQuotaBytes,
        } as T;
        const mailbox = (await this.createMailboxes(requested, [requested], req, user, UserUtils.hasRoles(user, this.trustedRoles))) as T;
        return { status: "created", mailbox };
    }

    /** This server's verified, non-alias domains — lets a client (e.g. the admin console's "New mailbox"
     * form) constrain the domain half of an address to what a mailbox may actually be created on, without
     * hardcoding or duplicating that list client-side. A pure alias domain is deliberately left out - see
     * `getPrimaryDomainNames()`'s own doc comment. */
    @Auth(["jwt"])
    @Get("/domains")
    public async listDomains(): Promise<string[]> {
        return await getPrimaryDomainNames(this._objectFactory!, this.domainClass);
    }

    /**
     * Lists the deleted mailboxes that still have data: `{ items, next? }`, each item `{ mailboxUid, folderCount,
     * messageCount, erasure? }` (`erasure` is the newest erasure request filed for the address: `{ uid, status, dateCreated }`),
     * sorted by uid. `?limit=` (default 50, at most 100) and `?after=<mailboxUid>` (the previous page's `next`) page through
     * it; `next` says there may be more. Reads are bounded (see `listLeftoverMailboxes()`), and only what the folders show is
     * listed - an address whose remains are an access list alone is still refused on create and erasable by naming it.
     *
     * **Who.** A trusted role AND an elevated token (`assertAdminScope()`: 403 `api-103`/`api-104`), audited as
     * `MAILBOX_ADMIN_LIST` with `details.leftover`. Metadata only: uids and counts, never a folder name, a subject or an
     * address other than the mailbox's own. The mailbox no longer exists, so there is no grant to hold - an administrator
     * needs none to delete a mailbox, and needs none to see what that delete left or to erase it.
     */
    @Auth(["jwt"])
    @Get("/leftover")
    public async findLeftover(
        @Query("limit") limit: unknown,
        @Query("after") after: unknown,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<LeftoverMailboxPage> {
        assertAdminScope(user, this.trustedRoles);
        const cursor: string | undefined = typeof after === "string" && after.length > 0 && after.length <= 320 ? after : undefined;
        const page: LeftoverMailboxPage = await listLeftoverMailboxes(await this.leftoverContext(), cursor, parseLeftoverLimit(limit));
        await this.auditAdmin(req, user, AuditAction.MAILBOX_ADMIN_LIST, "*", { leftover: true, count: page.items.length });
        return page;
    }

    /** The caller's own auth-server "name" aliases (e.g. usernames), via `GET /api/aliases?type=name&userUid=me` —
     * forwarding their `jwt` cookie is what scopes the call to *their* aliases specifically (auth-server lists only
     * the caller's own aliases to a non-administrator; `userUid=me` - a plain query value `ModelUtils.coerceOperand()`
     * resolves to the requesting user's uid - does the same for a caller with a trusted role, who is otherwise listed
     * every alias). The answer is also filtered here to entries whose `userUid` is the caller's (`user`): the guard that
     * does not depend on auth-server honouring the query, and never applied to `staticAliases`. Only verified `name`
     * entries count, read from each record's `alias` field. Skips that call entirely (see `staticAliases`'s own doc
     * comment for why) when a fixed list is configured.
     *
     * This once called `GET /api/aliases/me?type=name`, which is not a list endpoint: auth-server reads `me` there as
     * an alias id, finds none, and answers 404 - so it failed (502) for every caller, and its response was read from
     * the wrong field (`value`/`name`) besides. */
    private async fetchNameAliases(req: HttpRequest | undefined, user: JWTUser | undefined): Promise<string[]> {
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
            response = await fetch(`${this.authServerUrl}/api/aliases?type=name&userUid=me`, {
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

        // An auth-server `Alias` record names itself in `alias` (`{ uid, alias, type, userUid, verified, ... }`). Only the
        // caller's own are kept, whatever auth-server answered with: `userUid=me` should already have scoped the list, but
        // an administrator's elevated token is listed unscoped by a request without it, and offering (or accepting) another
        // user's username here would let a mailbox be created at it. An entry with no `userUid`, or another's, is dropped.
        const data = (await response.json()) as Array<{ alias?: string; type?: string; verified?: boolean; userUid?: string }>;
        const callerUid: string | undefined = user?.uid?.toLowerCase();
        return Array.isArray(data)
            ? data
                  .filter((entry) => callerUid !== undefined && typeof entry.userUid === "string" && entry.userUid.toLowerCase() === callerUid)
                  .filter((entry) => entry.type === "name" && entry.verified !== false)
                  .map((entry) => entry.alias)
                  .filter((value): value is string => !!value)
            : [];
    }

    /**
     * The caller's own mailboxes and the ones shared with them - the same for EVERY caller, an administrator included.
     * `?scope=admin` (trusted AND elevated, else 403) instead answers the administrative metadata of every mailbox
     * (`ADMIN_METADATA_FIELDS`), filterable and sortable by those fields only, and writes a `MAILBOX_ADMIN_LIST` audit
     * entry per call.
     */
    public async find(@Param() params: any, @Query() query: any, @AuthUser user?: JWTUser, @Request req?: HttpRequest): Promise<T[]> {
        if (!this.repoUtils || !user) {
            return [];
        }
        if (isAdminScope(query)) {
            return (await this.findAdminScope(params, query, user, req)) as unknown as T[];
        }
        // `$or` and friends would override the forced `uid` filter below on SQL - see `stripUnsafeQueryKeys()`.
        const scopedQuery: any = { ...stripUnsafeQueryKeys(query), ...params };
        const accessibleUids: string[] = await this.accessibleMailboxUids(user);
        // An empty array must short-circuit rather than be passed through as a query filter value: the
        // underlying query builder "zips" an array filter value's *last* element onto any query branch
        // past its own length, so an empty array resolves to `undefined` for that field — which TypeORM
        // (and this builder) treats as "no filter on this field", not "match nothing". Passing it through
        // would incorrectly return every mailbox to a caller who is entitled to see none.
        if (accessibleUids.length === 0) {
            return [];
        }
        const rows: T[] = await this.repoUtils.find({ ...scopedQuery, uid: accessibleUids }, {
            limit: query?.limit,
            page: query?.page,
            version: query?.version,
            user: this.mailUser(user),
            ignoreACL: true,
        });
        return rows.map((row) => this.withAccessRole(row, user));
    }

    /** `mailbox` with `accessRole` for `user`: `"owner"` for their own mailbox, `"delegate"` for one shared with them - so a
     * client can label the shared ones. Computed on the way out, never stored (and dropped from a body that echoes it). */
    private withAccessRole(mailbox: T, user: JWTUser): T {
        // A row from before `freeBusyVisibility` existed reads as its default (`null` on SQL, absent on Mongo).
        return {
            ...mailbox,
            freeBusyVisibility: effectiveFreeBusyVisibility(mailbox),
            accessRole: sameOwner(mailbox.ownerUserUid, user.uid) ? "owner" : "delegate",
        };
    }

    /** `find()` for `?scope=admin`: every mailbox's metadata, audited. */
    private async findAdminScope(params: any, query: any, user: JWTUser, req: HttpRequest | undefined): Promise<Record<string, unknown>[]> {
        assertAdminScope(user, this.trustedRoles);
        const filter: Record<string, any> = { ...sanitizeAdminQuery(query), ...sanitizeAdminQuery(params) };
        const rows: T[] = await this.repoUtils!.find(filter, {
            limit: query?.limit,
            page: query?.page,
            version: query?.version,
            user,
            ignoreACL: true,
        });
        await this.auditAdmin(req, user, AuditAction.MAILBOX_ADMIN_LIST, "*", { count: rows.length, query: filter });
        return rows.map((row) => toAdminMetadata(row));
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
        const admin: boolean = isAdminScope(query);
        let scopedQuery: any;
        if (admin) {
            assertAdminScope(user, this.trustedRoles);
            scopedQuery = { ...sanitizeAdminQuery(query), ...sanitizeAdminQuery(params) };
        } else {
            scopedQuery = { ...stripUnsafeQueryKeys(query), ...params };
            const accessibleUids: string[] = await this.accessibleMailboxUids(user);
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
            user: admin ? user : this.mailUser(user),
            ignoreACL: true,
        });
        if (admin) {
            await this.auditAdmin(undefined, user, AuditAction.MAILBOX_ADMIN_LIST, "*", { count: result, query: scopedQuery, head: true });
        }
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
        const admin: boolean = isAdminScope(query);
        if (admin) {
            assertAdminScope(user, this.trustedRoles);
        }
        const permitted: boolean = existing ? admin || (await this.hasMailAccess(user, existing.uid, ACLAction.EXISTS)) : false;
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
    public async findById(@Param("id") id: string, @Query() query: any, @AuthUser user?: JWTUser, @Request req?: HttpRequest): Promise<T | null> {
        if (isAdminScope(query)) {
            // Administrative metadata only, audited - see `find()`.
            assertAdminScope(user, this.trustedRoles);
            const existing: T | undefined = await this.repoUtils!.findOne(id, { version: query?.version, ignoreACL: true });
            if (!existing) {
                throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
            }
            await this.auditAdmin(req, user, AuditAction.MAILBOX_ADMIN_READ, existing.uid, { primarySmtpAddress: existing.primarySmtpAddress });
            return toAdminMetadata(existing) as unknown as T;
        }
        // A mailbox the caller holds no READ on answers exactly like one that doesn't exist (404) - the framework's own 403
        // would reveal which addresses have a mailbox. `RepoUtils` then resolves the mailbox's ACL for `mailUser()`, the
        // caller without a trusted role.
        if (!(await this.hasMailAccess(user, id, ACLAction.READ))) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const found: T | null = await super.findById(id, query, this.mailUser(user));
        const result: T | null = found && user ? this.withAccessRole(found, user) : found;
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
     *
     * **The mailbox's data stays.** Only the mailbox row and its own access list go; its folders and content keep its
     * `mailboxUid` and the address can't be reused until they are erased (see `assertNoLeftoverMailboxData()`). A response says
     * so in `X-Mailbox-Data: kept` (nothing more was done - list it with `GET /mailboxes/leftover`, erase it with
     * `POST /erasure-requests/leftover`) or, when `?erase=true` asked for it, `X-Mailbox-Data: erasing` with
     * `X-Erasure-Request: <request uid>`. `?erase=true` is for an administrator only (trusted AND elevated, else 403 before
     * anything is deleted): after the delete it files the same approved, audited erasure `POST /erasure-requests/leftover`
     * does, which `ErasureExecutionJob` runs. If filing it fails the mailbox stays deleted and the answer is `kept`.
     */
    @Delete("/:id")
    public async delete(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Query("purge") purge: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
        @Query("erase") erase?: string,
        @Response res?: HttpResponse,
    ): Promise<void> {
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        const eraseData: boolean = erase === "true";
        if (eraseData) {
            assertAdminScope(user, this.trustedRoles);
        }
        const existing: T | undefined = await this.repoUtils.findOne(id, { version, ignoreACL: true });
        // An administrator with no grant on the mailbox deletes it as the trusted caller `RepoUtils` lets through, audited;
        // anybody else needs DELETE on it as themselves.
        const adminOnly: boolean = await this.isAdminOnly(id, user, ACLAction.DELETE);
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
        await super.delete(id, version, purge, req, adminOnly ? user : this.mailUser(user));
        if (adminOnly && existing) {
            await this.auditAdmin(req, user, AuditAction.MAILBOX_ADMIN_DELETE, existing.uid, { primarySmtpAddress: existing.primarySmtpAddress });
        }
        await this.reportRemainingData(existing?.uid ?? id, eraseData, req, user, res);
    }

    /** Tells a `delete()` caller (in `X-Mailbox-Data`) what became of the deleted mailbox's data - and files its erasure when
     * `erase` asked for it (the caller is an administrator: `delete()` checked). Says nothing when nothing was left. */
    private async reportRemainingData(
        uid: string,
        erase: boolean,
        req: HttpRequest,
        user: JWTUser | undefined,
        res: HttpResponse | undefined,
    ): Promise<void> {
        const context: LeftoverListContext = await this.leftoverContext();
        const { folderCount, hasAcl } = await findLeftoverEvidence(context.folderRepo, this.aclUtils, uid);
        if (folderCount === 0 && !hasAcl) {
            return;
        }
        if (erase) {
            try {
                const { request } = await fileLeftoverErasure(context, { user: user!, req }, uid);
                res?.setHeader("X-Mailbox-Data", "erasing");
                res?.setHeader("X-Erasure-Request", request.uid);
                return;
            } catch (err: any) {
                this.logger?.warn(`Mailbox ${uid} was deleted but the erasure of its data could not be filed: ${err.message}`);
            }
        }
        res?.setHeader("X-Mailbox-Data", "kept");
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
        // A literal `in` list matches each uid exactly (a parsed `in(a,b)` splits on commas, so a uid containing one would
        // widen the delete). Batched to keep each SQL `IN` bounded.
        for (let i = 0; i < matched.length; i += TRUNCATE_BATCH_SIZE) {
            const uids: string[] = matched.slice(i, i + TRUNCATE_BATCH_SIZE).map((existing) => existing.uid);
            await this.repoUtils.truncate({ uid: ModelUtils.literal(uids, "in") } as any, { user, ignoreACL: true });
        }
        for (const existing of matched) {
            await this.auditAdmin(undefined, user, AuditAction.MAILBOX_ADMIN_DELETE, existing.uid, {
                primarySmtpAddress: existing.primarySmtpAddress,
                bulk: true,
            });
        }
    }
}
