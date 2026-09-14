///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@ApiRoute("mail/mailboxes")` to its own concrete subclass (see
// `BaseKeyLookupRoute`'s identical note) - `@Get("/:id/access")` etc. below then resolve to
// `GET /mail/mailboxes/:id/access`, sharing MailboxRoute's own base path.
import { ApiError, ObjectDecorators, UserUtils, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ACLUtils,
    ApiErrorMessages,
    ApiErrors,
    HttpRequest,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
    type AccessControlList,
    type ACLRecord,
} from "@rapidrest/service-core";
import { AuditAction, Mailbox } from "../models/types.js";
import { normalizeAddress } from "../util/AddressUtils.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
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

/** A user uid as this platform issues them (a UUID). A grant is only ever made to one user - never to a role name,
 * `anonymous`, or the `.*`/`*` wildcards the ACL system also understands, any of which would hand this mailbox to
 * far more than the one person the caller picked. */
const USER_UID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One plain address: a single `@`, no whitespace, and nothing the search query syntax could read as an operator. */
const PLAIN_ADDRESS_PATTERN = /^[^\s()@,]+@[^\s()@,]+$/;

/** The longest address worth looking up (RFC 5321's path limit). */
const MAX_ADDRESS_LENGTH = 320;

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
     * does). Wrapped in `eq(...)` so the search query parser takes it as a literal value, never an operator.
     * Not shared code with `BaseMailIngestRoute` - that class's own resolution also handles
     * `DistributionList`s and a plus-tag fallback tier, neither of which applies to "does this exact
     * address belong to a real person's mailbox," so duplicating this one small helper here is simpler and
     * lower-risk than threading a shared utility through mail delivery's own resolution path for this. */
    protected aliasQueryValue(address: string): any {
        return `eq(${address})`;
    }

    private async requireMailbox(mailboxId: string): Promise<M> {
        await this.init();
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxId, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return mailbox;
    }

    private async requirePermission(mailbox: M, user: JWTUser | undefined, action: string): Promise<void> {
        if (!(await this.aclUtils!.hasPermission(user, mailbox.uid, action))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
    }

    private async requireManagePermission(mailboxId: string, user?: JWTUser): Promise<M> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        await this.requirePermission(mailbox, user, ACLAction.UPDATE);
        return mailbox;
    }

    /** Refuses a change to the owner's implicit access, or to the caller's own record unless they're trusted. */
    private assertManageableMember(mailbox: M, userOrRoleId: string, user?: JWTUser): void {
        if (userOrRoleId === mailbox.ownerUserUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The mailbox owner's access cannot be managed here.");
        }
        if (userOrRoleId === user?.uid && !UserUtils.hasRoles(user, this.trustedRoles)) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "You can't change your own access to this mailbox.");
        }
    }

    /** Reads the mailbox's ACL straight from the database - a cached copy could be missing a recent revocation,
     * which this read-modify-write would then put back. */
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
        const mailbox: M = await this.requireManagePermission(mailboxId, user);
        const acl: AccessControlList = await this.requireAcl(mailbox.uid);
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
        const mailbox: M = await this.requireManagePermission(mailboxId, user);
        this.assertManageableMember(mailbox, userOrRoleId, user);
        if (!USER_UID_PATTERN.test(userOrRoleId) || this.trustedRoles.includes(userOrRoleId)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Access can only be granted to a user.");
        }
        const role: MailboxAccessRole = body?.role;
        if (role !== "viewer" && role !== "manager") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'role' must be 'viewer' or 'manager'.");
        }
        const acl: AccessControlList = await this.requireAcl(mailbox.uid);
        const previous: ACLRecord | undefined = acl.records.find((record) => record.userOrRoleId === userOrRoleId);
        if (role === "manager" || previous?.actions.includes(ACLAction.FULL)) {
            // Granting or taking away full access takes full access.
            await this.requirePermission(mailbox, user, ACLAction.FULL);
        }
        acl.records = [
            ...acl.records.filter((record) => record.userOrRoleId !== userOrRoleId),
            { userOrRoleId, actions: MAILBOX_ACCESS_ROLE_ACTIONS[role] },
        ];
        await this.saveAcl(acl);
        await this.audit(req, user, AuditAction.MAILBOX_ACCESS_GRANT, mailbox, {
            userOrRoleId,
            ...(previous ? { previousRole: roleFromActions(previous.actions) } : {}),
            role,
        });
        return { userOrRoleId, role };
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
        const mailbox: M = await this.requireManagePermission(mailboxId, user);
        this.assertManageableMember(mailbox, userOrRoleId, user);
        const acl: AccessControlList = await this.requireAcl(mailbox.uid);
        const previous: ACLRecord | undefined = acl.records.find((record) => record.userOrRoleId === userOrRoleId);
        if (!previous) {
            return;
        }
        if (previous.actions.includes(ACLAction.FULL)) {
            await this.requirePermission(mailbox, user, ACLAction.FULL);
        }
        acl.records = acl.records.filter((record) => record.userOrRoleId !== userOrRoleId);
        await this.saveAcl(acl);
        await this.audit(req, user, AuditAction.MAILBOX_ACCESS_REVOKE, mailbox, { userOrRoleId, previousRole: roleFromActions(previous.actions) });
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
    @RateLimit({ perUser: true })
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
        const primaryMatches: M[] = await this.mailboxRepo!.find({ primarySmtpAddress: `eq(${address})`, limit: 1 }, { ignoreACL: true, limit: 1 });
        const mailbox: M | undefined =
            primaryMatches[0] ??
            (await this.mailboxRepo!.find({ aliasAddresses: this.aliasQueryValue(address), limit: 1 }, { ignoreACL: true, limit: 1 }))[0];
        if (!mailbox || !mailbox.ownerUserUid) {
            return null;
        }
        return { userUid: mailbox.ownerUserUid, displayName: mailbox.displayName };
    }
}
