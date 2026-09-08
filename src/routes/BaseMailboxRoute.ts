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
} from "@rapidrest/service-core";
import { DistributionList, FolderType, Mailbox } from "../models/types.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { findOrCreateWellKnownFolder } from "../util/FolderUtils.js";
import { RecoverableRepoUtils } from "../util/RecoverableRepoUtils.js";
const { Auth, Get, Param, Post, Query, Request, Response, User: AuthUser } = RouteDecorators;
const { Config } = ObjectDecorators;

/** One (name alias, domain) combination the caller could register as their mailbox address — the full
 * cross product of their auth-server name aliases and this server's configured `mail:domains` list. */
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

    /** Master switch for `autoProvision()` — off by default, since silently minting mailboxes is a real
     * behavior change a deployment must opt into, not something safe to default on. */
    @Config("mail:auto_provision:enabled", false)
    protected autoProvisionEnabled: boolean = false;

    /**
     * The single source of truth for every domain this mail server accepts mail for — a deployment
     * serving more than one domain lists all of them here. Governs *every* mailbox this route creates,
     * not just auto-provisioned ones: `create()` below rejects a `primarySmtpAddress` on any other
     * domain once this is non-empty (an empty list is the "unconfigured, no restriction" default, for
     * backward compatibility with a deployment that hasn't set this up). `autoProvision()` offers the
     * caller the cross product of their name aliases and this list to choose their own address from.
     */
    @Config("mail:domains", [] as string[])
    protected domains: string[] = [];

    @Config("mail:auto_provision:quota_bytes", 5_000_000_000)
    protected autoProvisionQuotaBytes: number = 5_000_000_000;

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

    private folderRepo?: RecoverableRepoUtils<any>;

    private distributionListRepo?: RepoUtils<DistributionList>;

    /**
     * Returns the uids of every mailbox this user has any ACL grant on — as owner, as a shared delegate, or
     * (implicitly, via a wildcard/role record) as a trusted caller. Backend-specific because
     * `AccessControlList`'s storage shape differs (a natively queryable embedded array in Mongo vs. a
     * `simple-json` column in SQL) — implemented by the concrete `MailboxRouteMongo`/`MailboxRouteSQL`
     * subclass, each against the exact same `AccessControlList` collection/table `BaseACLRoute` exposes.
     */
    protected abstract findAccessibleMailboxUids(user: JWTUser): Promise<string[]>;

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

    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        if (!user) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        const isTrusted: boolean = UserUtils.hasRoles(user, this.trustedRoles);
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        if (!isTrusted) {
            for (const o of objs) {
                (o as any).ownerUserUid = user.uid;
            }
        }
        // Applies to every caller, trusted or not — `mail:domains` (once configured) is this server's
        // one source of truth for which domains it accepts mail on at all, not just a self-service guard.
        if (this.domains.length > 0) {
            for (const o of objs) {
                const domain = o.primarySmtpAddress?.split("@")[1];
                if (!domain || !this.domains.includes(domain)) {
                    throw new ApiError(
                        ApiErrors.INVALID_REQUEST,
                        400,
                        `Mailbox addresses must be on one of this server's configured domains: ${this.domains.join(", ")}.`,
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
        const folderRepo: RecoverableRepoUtils<any> = await this.getFolderRepo();
        for (const mailbox of created) {
            await findOrCreateWellKnownFolder(folderRepo, this.folderClass, mailbox.uid, FolderType.INBOX, user);
            await findOrCreateWellKnownFolder(folderRepo, this.folderClass, mailbox.uid, FolderType.DRAFTS, user);
            await findOrCreateWellKnownFolder(folderRepo, this.folderClass, mailbox.uid, FolderType.CALENDAR, user);
            await findOrCreateWellKnownFolder(folderRepo, this.folderClass, mailbox.uid, FolderType.CONTACTS, user);
            await findOrCreateWellKnownFolder(folderRepo, this.folderClass, mailbox.uid, FolderType.TASKS, user);
        }

        return Array.isArray(obj) ? created : created[0];
    }

    /**
     * Self-service mailbox creation with no `Mailbox` object required from the caller — for a deployment
     * where users only ever come from an external auth-server and are never manually provisioned a
     * mailbox first. Disabled unless `mail:auto_provision:enabled` is on and `mail:domains` is non-empty
     * (see the `@Config` fields above).
     *
     * A mailbox needs a `primarySmtpAddress`, which this route has no way to know on its own — the caller
     * has no email registered anywhere in this system yet by definition. Instead, this derives candidates
     * from the identity auth-server already has for them: it calls auth-server's own `GET /api/aliases/me?
     * type=name` (forwarding the caller's own `jwt` cookie, so it only ever sees that user's own aliases)
     * and offers the caller the full cross product of those aliases against `mail:domains` — a deployment
     * can serve more than one domain, and the caller should get to pick which (alias, domain) pair they
     * want, not have one silently chosen for them even when there's only one possible combination. So
     * with no `body.alias`/`body.domain`, this *always* returns `needs_selection` rather than creating
     * anything; only a call that supplies both, validated fresh against the real alias list and the
     * configured domain list (never trusted blindly), actually creates the mailbox.
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
        const hasAliasSource = this.staticAliases.length > 0 || !!this.authServerUrl;
        if (!this.autoProvisionEnabled || this.domains.length === 0 || !hasAliasSource) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, "Automatic mailbox provisioning is not enabled.");
        }
        if (!this.repoUtils) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
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
                    this.domains.map((domain) => ({ alias, domain, primarySmtpAddress: `${alias}@${domain}` })),
                ),
            };
        }
        if (!aliases.includes(body.alias) || !this.domains.includes(body.domain)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const mailbox = (await this.create(
            {
                primarySmtpAddress: `${body.alias}@${body.domain}`,
                displayName: body.alias,
                ownerUserUid: user.uid,
                timezone: "UTC",
                quotaBytes: this.autoProvisionQuotaBytes,
            } as T,
            req,
            user,
        )) as T;
        return { status: "created", mailbox };
    }

    /** This server's configured domain list (`mail:domains`) — lets a client (e.g. the admin console's
     * "New mailbox" form) constrain the domain half of an address to what this server actually accepts,
     * without hardcoding or duplicating that list client-side. */
    @Auth(["jwt"])
    @Get("/domains")
    public async listDomains(): Promise<string[]> {
        return this.domains;
    }

    /** The caller's own auth-server "name" aliases (e.g. usernames), via `GET /api/aliases/me?type=name` —
     * forwarding their `jwt` cookie is what scopes the call to *their* aliases specifically. Skips that
     * call entirely (see `staticAliases`'s own doc comment for why) when a fixed list is configured. */
    private async fetchNameAliases(req: HttpRequest): Promise<string[]> {
        if (this.staticAliases.length > 0) {
            return this.staticAliases;
        }

        const jwtCookie = req.cookies?.["jwt"];
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
}
