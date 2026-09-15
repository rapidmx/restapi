///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@ApiRoute("mail/mailboxes")` to its own concrete subclass (see
// `BaseKeyLookupRoute`'s identical note) - `@Get("/:id/access")` etc. below then resolve to
// `GET /mail/mailboxes/:id/access`, sharing MailboxRoute's own base path.
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import {
    type AccessControlList,
    ACLAction,
    type ACLRecord,
    ACLUtils,
    ApiErrorMessages,
    ApiErrors,
    HttpRequest,
    ModelUtils,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import { AuditAction, Mailbox } from "../models/types.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { normalizeUserUid } from "../util/UserUidUtils.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Auth, Delete, Get, Param, Put, Query, RateLimit, Request, User: AuthUser } = RouteDecorators;

/** This route's own simplified 2-tier vocabulary, layered on top of the richer, arbitrary-string
 * `ACLRecord.actions` the underlying ACL system actually supports (see `MAILBOX_ACCESS_ROLE_ACTIONS`
 * below for the mapping) - a mailbox owner/manager choosing who else can see or run a shared mailbox
 * doesn't need (or want) to think in terms of raw CRUD action strings. `"custom"` is display-only: a record
 * granted some other action set (through another path) is reported as such, and can't be set here. */
export type MailboxAccessRole = "viewer" | "manager" | "custom";

export interface MailboxAccessMember {
    userOrRoleId: string;
    role: MailboxAccessRole;
    /** The record's raw actions - what a `"custom"` member can actually do. */
    actions: string[];
}

/** `"viewer"` mirrors `ShareAccessCard`'s existing `DEFAULT_DELEGATE_ACTIONS` exactly (no regression for
 * that admin card's own grants). `"manager"` is full, owner-equivalent control (`ACLAction.FULL`) -
 * deliberately including the ability to delete the mailbox itself (`BaseMailboxRoute.delete()`'s own ACL
 * check is the standard `DELETE` action, which `FULL` already supersedes) or manage other members' access
 * in turn, matching how a real co-owner/full-access delegate is expected to behave. */
const MAILBOX_ACCESS_ROLE_ACTIONS: Record<Exclude<MailboxAccessRole, "custom">, string[]> = {
    viewer: [ACLAction.READ, ACLAction.LIST, ACLAction.COUNT, ACLAction.EXISTS],
    manager: [ACLAction.FULL],
};

/** What the caller may do with a mailbox, as `GET /:id/access/me` reports it. `canManage` is what managing its members
 * (`GET`/`PUT`/`DELETE /:id/access...`) requires. */
export interface MailboxMyAccess {
    canRead: boolean;
    canCreate: boolean;
    canUpdate: boolean;
    canDelete: boolean;
    canManage: boolean;
}

/** The action managing a mailbox's members requires - see this class's doc comment. */
const MANAGE_ACTION: string = ACLAction.UPDATE;

/** One plain address: a single `@`, no whitespace, and nothing the search query syntax could read as an operator. */
const PLAIN_ADDRESS_PATTERN = /^[^\s()@,]+@[^\s()@,]+$/;

/** The longest address worth looking up (RFC 5321's path limit). */
const MAX_ADDRESS_LENGTH = 320;

/** How many `lookup-by-email` requests one caller may make per `LOOKUP_WINDOW_SECONDS` - enough to add members by
 * hand, far too few to walk the directory. */
export const LOOKUP_MAX_ATTEMPTS = 30;
export const LOOKUP_WINDOW_SECONDS = 60;

/** Maps an arbitrary `ACLRecord.actions` array back onto this route's vocabulary for display - `"manager"` for
 * anything carrying the `FULL` wildcard, `"viewer"` for exactly the viewer action set, and `"custom"` for anything
 * else (e.g. a record granted update or delete through another path), so a member's real access is never shown as
 * less than it is. Total and safe for any pre-existing record, never throws on an unrecognized shape. */
function roleFromActions(actions: string[]): MailboxAccessRole {
    if (actions.includes(ACLAction.FULL)) {
        return "manager";
    }
    const viewer: string[] = MAILBOX_ACCESS_ROLE_ACTIONS.viewer;
    return actions.length === viewer.length && viewer.every((action) => actions.includes(action)) ? "viewer" : "custom";
}

/** Whether an ACL record id names `memberId`: the same string, or the same user uid in another case. */
function sameMember(recordId: string, memberId: string): boolean {
    const uid: string | undefined = normalizeUserUid(recordId);
    return recordId === memberId || (uid !== undefined && uid === normalizeUserUid(memberId));
}

/**
 * A thin, purpose-built wrapper around mutating a *mailbox's own* `AccessControlList` - unlike
 * `BaseCalendarShareLinkRoute` (which owns a persisted `CalendarShareLink` model and grants ACL access on
 * a *folder* as a side effect of CRUD on it), this route persists nothing of its own; it only ever
 * reads/writes the mailbox's already-existing ACL document via `ACLUtils.findACL()`/`saveACL()` - the
 * exact primitives `BaseCalendarShareLinkRoute.grantShareTokenAccess()`/`revokeShareTokenAccess()`
 * already use for the identical read-modify-write shape.
 *
 * A single grant here already cascades to everything under the mailbox (every well-known folder's ACL is
 * seeded with `parentUid: mailboxUid` at creation - see `util/FolderUtils.ts#findOrCreateWellKnownFolder()`
 * - and `CalendarEvent`/`Contact`/`Task`/`Message` have no independent ACL of their own at all, resolving
 * permission through their parent folder's chain) - so, unlike `BaseCalendarShareLinkRoute`, this route
 * never needs to touch any ACL besides the mailbox's own.
 *
 * Gated at plain `ACLAction.UPDATE`, not the literal `ACLAction.FULL` the fully generic `BaseACLRoute`
 * requires (see `checkPerms()` there) - that stricter gate is why today only a mailbox's literal owner (or
 * a trusted admin) can use the generic ACL CRUD endpoint at all. A delegate granted plain `"update"` access
 * can manage viewers through here without needing `"*"`, but granting, changing or removing a `"manager"`
 * (full access) needs full access itself, so update access can't be escalated to full. Nobody but a trusted
 * role can change their own record.
 *
 * Every grant and revocation is audited (`MAILBOX_ACCESS_GRANT`/`MAILBOX_ACCESS_REVOKE`) when the concrete
 * subclass supplies `auditLogClass`.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMailboxAccessRoute<M extends Mailbox> {
    protected abstract mailboxClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses to audit membership changes - see `util/AuditLogUtils.ts`.
     * A subclass without one changes membership unaudited. */
    protected auditLogClass?: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;
    private mailboxRepo?: RepoUtils<M>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

    @Config()
    private config: any;

    @Config("trusted_roles", ["admin"])
    private trustedRoles: string[] = ["admin"];

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.mailboxRepo) {
            this.mailboxRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.mailboxClass.name,
                args: [this.mailboxClass],
            });
        }
    }

    /** Builds the query value used to match `Mailbox.aliasAddresses` against a given address - mirrors
     * `BaseMailIngestRoute.aliasQueryValue()`'s identical mongo/SQL split (MongoDB's implicit array-element
     * equality matches a plain value directly; the SQL backend stores `aliasAddresses` as a serialized
     * `simple-json` column, so `MailboxAccessRouteSQL` overrides this the same way `MailIngestRouteSQL`
     * does). A `ModelUtils.literal()`, so the search query parser takes it as a value, never an operator.
     * Not shared code with `BaseMailIngestRoute` - that class's own resolution also handles
     * `DistributionList`s and a plus-tag fallback tier, neither of which applies to "does this exact
     * address belong to a real person's mailbox," so duplicating this one small helper here is simpler and
     * lower-risk than threading a shared utility through mail delivery's own resolution path for this. */
    protected aliasQueryValue(address: string): any {
        return ModelUtils.literal(address);
    }

    private async requireMailbox(mailboxId: string): Promise<M> {
        await this.init();
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxId, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return mailbox;
    }

    /** Checks `action` against `acl` - the same uncached ACL (parents included) a change then saves, so a permission
     * revoked a moment ago can't still authorize the change through a cached copy. */
    private async requirePermission(acl: AccessControlList, user: JWTUser | undefined, action: string): Promise<void> {
        if (!(await this.aclUtils!.hasPermission(user, acl, action))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
    }

    /** The mailbox and its uncached ACL, once the caller is known to be allowed to manage its members. */
    private async requireManagePermission(mailboxId: string, user?: JWTUser): Promise<{ mailbox: M; acl: AccessControlList }> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        const acl: AccessControlList = await this.requireAcl(mailbox.uid);
        await this.requirePermission(acl, user, MANAGE_ACTION);
        return { mailbox, acl };
    }

    /** Refuses a change to the owner's implicit access, or to the caller's own record unless they're trusted. */
    private assertManageableMember(mailbox: M, userOrRoleId: string, user?: JWTUser): void {
        if (mailbox.ownerUserUid && sameMember(mailbox.ownerUserUid, userOrRoleId)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The mailbox owner's access cannot be managed here.");
        }
        if (user?.uid && sameMember(user.uid, userOrRoleId) && !UserUtils.hasRoles(user, this.trustedRoles)) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "You can't change your own access to this mailbox.");
        }
    }

    /**
     * Whether a record other than `memberId`'s own record on this mailbox grants `FULL` and may apply to that user: a
     * record for the same uid on a parent ACL, a `.*`/`*` wildcard, or a role (the member's roles aren't known here, so
     * any role might be one of theirs). Trusted roles are left out - they have full access regardless of records.
     * Adding, changing or removing the member's own record decides whether that other grant applies (the most specific
     * record wins), so doing so takes full access, the same as for a record that grants `FULL` itself.
     */
    private hasFullAccessElsewhere(acl: AccessControlList, memberId: string): boolean {
        const mayApply = (id: string): boolean =>
            id === ".*" || id === "*" || (id !== "anonymous" && normalizeUserUid(id) === undefined && !this.trustedRoles.includes(id));
        for (let level: AccessControlList | undefined = acl, depth = 0; level; level = level.parent, depth++) {
            const found: boolean = level.records.some(
                (record) =>
                    record.actions.includes(ACLAction.FULL) && (sameMember(record.userOrRoleId, memberId) ? depth > 0 : mayApply(record.userOrRoleId)),
            );
            if (found) {
                return true;
            }
        }
        return false;
    }

    /** Reads the mailbox's ACL (and its parents) straight from the database - a cached copy could be missing a recent
     * revocation, which this read-modify-write would then put back. */
    private async requireAcl(mailboxUid: string): Promise<AccessControlList> {
        const acl: AccessControlList | undefined = await this.aclUtils!.findACL(mailboxUid, [], { skipCache: true });
        if (!acl) {
            // Every Mailbox is seeded with an ACL document on creation - should never happen in practice.
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        return acl;
    }

    /** Saves the ACL, reporting a concurrent change to it as a `409` rather than a `500`. `saveACL()` refreshes its
     * cache entry itself, without exposing a way to wait for it. */
    private async saveAcl(acl: AccessControlList): Promise<void> {
        try {
            await this.aclUtils!.saveACL(acl);
        } catch (err: any) {
            if (/must be of the same version/.test(err?.message)) {
                throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, ApiErrorMessages.INVALID_OBJECT_VERSION);
            }
            throw err;
        }
    }

    private async audit(
        req: HttpRequest | undefined,
        user: JWTUser | undefined,
        action: AuditAction,
        mailbox: M,
        details: { userOrRoleId: string; previousRole?: MailboxAccessRole; role?: MailboxAccessRole },
    ): Promise<void> {
        if (!this.auditLogClass) {
            return;
        }
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, req, user, logger: this.logger },
            { action, targetType: "Mailbox", targetUid: mailbox.uid, mailboxUid: mailbox.uid, details },
        );
    }

    /** Lists this mailbox's delegate members - excludes the record matching `mailbox.ownerUserUid`, since
     * the owner's own access is implicit, not "a member" someone else granted, and records granting nothing. */
    @Get("/:id/access")
    public async listMembers(@Param("id") mailboxId: string, @AuthUser user?: JWTUser): Promise<MailboxAccessMember[]> {
        const { mailbox, acl } = await this.requireManagePermission(mailboxId, user);
        return acl.records
            .filter((record) => record.userOrRoleId !== mailbox.ownerUserUid && record.actions.length > 0)
            .map((record) => ({ userOrRoleId: record.userOrRoleId, role: roleFromActions(record.actions), actions: record.actions }));
    }

    /** Grants (or, if already a member, updates the role of) a user's access to this mailbox - a plain
     * upsert on the mailbox's own ACL record list, matching `grantShareTokenAccess()`'s identical
     * read-modify-write shape. */
    @Put("/:id/access/:userOrRoleId")
    public async setMember(
        @Param("id") mailboxId: string,
        @Param("userOrRoleId") userOrRoleId: string,
        body: { role: MailboxAccessRole },
        @AuthUser user?: JWTUser,
        @Request req?: HttpRequest,
    ): Promise<Omit<MailboxAccessMember, "actions">> {
        const { mailbox, acl } = await this.requireManagePermission(mailboxId, user);
        this.assertManageableMember(mailbox, userOrRoleId, user);
        // Stored lowercase, so the owner and self checks above and the ACL's own exact matching agree on who it is.
        const memberId: string | undefined = normalizeUserUid(userOrRoleId);
        if (memberId === undefined || this.trustedRoles.includes(memberId)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Access can only be granted to a user.");
        }
        const role: MailboxAccessRole = body?.role;
        if (role !== "viewer" && role !== "manager") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'role' must be 'viewer' or 'manager'.");
        }
        const previous: ACLRecord | undefined = acl.records.find((record) => sameMember(record.userOrRoleId, memberId));
        if (role === "manager" || previous?.actions.includes(ACLAction.FULL) || this.hasFullAccessElsewhere(acl, memberId)) {
            // Granting, taking away or overriding full access takes full access.
            await this.requirePermission(acl, user, ACLAction.FULL);
        }
        acl.records = [
            ...acl.records.filter((record) => !sameMember(record.userOrRoleId, memberId)),
            { userOrRoleId: memberId, actions: MAILBOX_ACCESS_ROLE_ACTIONS[role] },
        ];
        await this.saveAcl(acl);
        await this.audit(req, user, AuditAction.MAILBOX_ACCESS_GRANT, mailbox, {
            userOrRoleId: memberId,
            ...(previous ? { previousRole: roleFromActions(previous.actions) } : {}),
            role,
        });
        return { userOrRoleId: memberId, role };
    }

    /** Revokes a delegate's access to this mailbox - idempotent (a no-op, not a 404, if the given
     * `userOrRoleId` was never a member), matching `revokeShareTokenAccess()`'s identical fail-open
     * convention for "nothing to remove." Any existing record can be removed, including one this route
     * wouldn't grant. */
    @Delete("/:id/access/:userOrRoleId")
    public async removeMember(
        @Param("id") mailboxId: string,
        @Param("userOrRoleId") userOrRoleId: string,
        @AuthUser user?: JWTUser,
        @Request req?: HttpRequest,
    ): Promise<void> {
        const { mailbox, acl } = await this.requireManagePermission(mailboxId, user);
        this.assertManageableMember(mailbox, userOrRoleId, user);
        const previous: ACLRecord | undefined = acl.records.find((record) => sameMember(record.userOrRoleId, userOrRoleId));
        if (!previous) {
            return;
        }
        if (previous.actions.includes(ACLAction.FULL) || this.hasFullAccessElsewhere(acl, previous.userOrRoleId)) {
            // Removing a record that narrows a full-access grant from elsewhere hands that full access back.
            await this.requirePermission(acl, user, ACLAction.FULL);
        }
        acl.records = acl.records.filter((record) => record !== previous);
        await this.saveAcl(acl);
        await this.audit(req, user, AuditAction.MAILBOX_ACCESS_REVOKE, mailbox, {
            userOrRoleId: previous.userOrRoleId,
            previousRole: roleFromActions(previous.actions),
        });
    }

    /**
     * What the caller may do with this mailbox, evaluated from their effective access: ownership, delegate records,
     * role and wildcard records, parent ACLs, and trusted roles (which may do everything). A caller with no access gets
     * every flag `false` rather than a `403`, so a client can use one call to decide what to offer. Registered as a
     * static segment, so `me` never reaches `/:id/access/:userOrRoleId` (which has no `GET` anyway).
     */
    @Auth(["jwt"])
    @Get("/:id/access/me")
    public async myAccess(@Param("id") mailboxId: string, @AuthUser user?: JWTUser): Promise<MailboxMyAccess> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        // A plain (possibly cached) read, like every other permission check - this changes nothing.
        const acl: AccessControlList | string = (await this.aclUtils!.findACL(mailbox.uid)) ?? mailbox.uid;
        const can = (action: string): Promise<boolean> => this.aclUtils!.hasPermission(user, acl, action);
        const [canRead, canCreate, canUpdate, canDelete, canManage] = await Promise.all([
            can(ACLAction.READ),
            can(ACLAction.CREATE),
            can(ACLAction.UPDATE),
            can(ACLAction.DELETE),
            can(MANAGE_ACTION),
        ]);
        return { canRead, canCreate, canUpdate, canDelete, canManage };
    }

    /**
     * Resolves an email address to the person who owns the mailbox at that address - there is no
     * separate `User`/identity directory anywhere in this platform (identity is issued entirely by an
     * external auth service this codebase never queries), so "look up a person by email" is implemented
     * as "find the `Mailbox` whose `primarySmtpAddress`/`aliasAddresses` matches, and use its own
     * `ownerUserUid`" - since every real user on this platform already owns a mailbox. Deliberately an
     * exact match only (no plus-tag fallback, unlike mail delivery's own address resolution) - this is
     * "does this address identify a real person," not "where should this message be delivered."
     *
     * Only mailboxes with `ownerUserUid` set are eligible - a shared/ownerless mailbox's own address must
     * never resolve here, since the membership-granting flow this backs is scoped to "add a person," not
     * "add another shared mailbox as a member of this one." Returns `null` (not a 404) for no match - "not
     * found" is an expected, common outcome of a lookup, not an error.
     *
     * Requires a signed-in caller (no elevated permission) and is rate limited per caller, so the directory can't be
     * enumerated anonymously or in bulk. `email` must be one plain address, queried as a literal value - never as a
     * search operator such as `like(...)` or `in(...)`, which would turn this into a directory dump.
     *
     * Registered as a static path alongside `MailboxRoute`'s `/:id`: both routers this framework runs on match a
     * static segment before a parameter regardless of registration order, so `lookup-by-email` never reaches `/:id`.
     */
    @Auth(["jwt"])
    // An explicit limit, so a deployment's (much higher) default for signed-in callers doesn't apply to a directory lookup.
    @RateLimit({ perUser: true, maxAttempts: LOOKUP_MAX_ATTEMPTS, windowSeconds: LOOKUP_WINDOW_SECONDS })
    @Get("/lookup-by-email")
    public async lookupOwnerByEmail(@Query("email") email: unknown): Promise<{ userUid: string; displayName: string } | null> {
        if (typeof email !== "string" || !email) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The 'email' query parameter is required.");
        }
        const address = normalizeAddress(email);
        if (address.length > MAX_ADDRESS_LENGTH || !PLAIN_ADDRESS_PATTERN.test(address)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The 'email' query parameter must be a single email address.");
        }
        await this.init();
        // A mailbox's uid is its lowercased address when it was created, which matches regardless of the case its
        // address was stored in. It's only used while the mailbox still has that address - `uid` stays put when the
        // address changes - otherwise the stored addresses are queried.
        const byUid: M | undefined = await this.mailboxRepo!.findOne(address, { ignoreACL: true });
        const hasAddress = (candidate: M): boolean =>
            normalizeAddress(candidate.primarySmtpAddress) === address || candidate.aliasAddresses.some((alias) => normalizeAddress(alias) === address);
        const mailbox: M | undefined =
            (byUid && hasAddress(byUid) ? byUid : undefined) ??
            (await this.mailboxRepo!.find({ primarySmtpAddress: ModelUtils.literal(address), limit: 1 } as any, { ignoreACL: true, limit: 1 }))[0] ??
            (await this.mailboxRepo!.find({ aliasAddresses: this.aliasQueryValue(address), limit: 1 }, { ignoreACL: true, limit: 1 }))[0];
        if (!mailbox || !mailbox.ownerUserUid) {
            return null;
        }
        return { userUid: mailbox.ownerUserUid, displayName: mailbox.displayName };
    }
}
