///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@ApiRoute("mail/mailboxes")` to its own concrete subclass (see
// `BaseKeyLookupRoute`'s identical note) - `@Get("/:id/access")` etc. below then resolve to
// `GET /mail/mailboxes/:id/access`, sharing MailboxRoute's own base path.
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import { ACLAction, ACLUtils, ApiErrorMessages, ApiErrors, ObjectFactory, RepoUtils, RouteDecorators, type AccessControlList } from "@rapidrest/service-core";
import { Mailbox } from "../models/types.js";
import { normalizeAddress } from "../util/AddressUtils.js";
const { Inject } = ObjectDecorators;
const { Delete, Get, Param, Put, Query, User: AuthUser } = RouteDecorators;

/** This route's own simplified 2-tier vocabulary, layered on top of the richer, arbitrary-string
 * `ACLRecord.actions` the underlying ACL system actually supports (see `MAILBOX_ACCESS_ROLE_ACTIONS`
 * below for the mapping) - a mailbox owner/manager choosing who else can see or run a shared mailbox
 * doesn't need (or want) to think in terms of raw CRUD action strings. */
export type MailboxAccessRole = "viewer" | "manager";

export interface MailboxAccessMember {
    userOrRoleId: string;
    role: MailboxAccessRole;
}

/** `"viewer"` mirrors `ShareAccessCard`'s existing `DEFAULT_DELEGATE_ACTIONS` exactly (no regression for
 * that admin card's own grants). `"manager"` is full, owner-equivalent control (`ACLAction.FULL`) -
 * deliberately including the ability to delete the mailbox itself (`BaseMailboxRoute.delete()`'s own ACL
 * check is the standard `DELETE` action, which `FULL` already supersedes) or manage other members' access
 * in turn, matching how a real co-owner/full-access delegate is expected to behave. */
const MAILBOX_ACCESS_ROLE_ACTIONS: Record<MailboxAccessRole, string[]> = {
    viewer: [ACLAction.READ, ACLAction.LIST, ACLAction.COUNT, ACLAction.EXISTS],
    manager: [ACLAction.FULL],
};

/** Maps an arbitrary `ACLRecord.actions` array back onto this route's 2-tier vocabulary for display -
 * `"manager"` for anything carrying the `FULL` wildcard, `"viewer"` for anything else (including a record
 * granted through some other path entirely, e.g. `ShareAccessCard`'s own raw grants, or a future custom
 * action set) - total and safe for any pre-existing record, never throws on an unrecognized shape. */
function roleFromActions(actions: string[]): MailboxAccessRole {
    return actions.includes(ACLAction.FULL) ? "manager" : "viewer";
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
 * (or a `"manager"` role via this very route) can manage membership through here without needing `"*"`.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseMailboxAccessRoute<M extends Mailbox> {
    protected abstract mailboxClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;
    private mailboxRepo?: RepoUtils<M>;

    @Inject(ACLUtils)
    private aclUtils?: ACLUtils;

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
     * does). Not shared code with `BaseMailIngestRoute` - that class's own resolution also handles
     * `DistributionList`s and a plus-tag fallback tier, neither of which applies to "does this exact
     * address belong to a real person's mailbox," so duplicating this one small helper here is simpler and
     * lower-risk than threading a shared utility through mail delivery's own resolution path for this. */
    protected aliasQueryValue(address: string): any {
        return address;
    }

    private async requireMailbox(mailboxId: string): Promise<M> {
        await this.init();
        const mailbox: M | undefined = await this.mailboxRepo!.findOne(mailboxId, { ignoreACL: true });
        if (!mailbox) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        return mailbox;
    }

    private async requireManagePermission(mailboxId: string, user?: JWTUser): Promise<M> {
        const mailbox: M = await this.requireMailbox(mailboxId);
        if (!(await this.aclUtils!.hasPermission(user, mailbox.uid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        return mailbox;
    }

    private async requireAcl(mailboxUid: string): Promise<AccessControlList> {
        const acl: AccessControlList | undefined = await this.aclUtils!.findACL(mailboxUid);
        if (!acl) {
            // Every Mailbox is seeded with an ACL document on creation - should never happen in practice.
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR);
        }
        return acl;
    }

    /** Lists this mailbox's delegate members - excludes the record matching `mailbox.ownerUserUid`, since
     * the owner's own access is implicit, not "a member" someone else granted. */
    @Get("/:id/access")
    public async listMembers(@Param("id") mailboxId: string, @AuthUser user?: JWTUser): Promise<MailboxAccessMember[]> {
        const mailbox: M = await this.requireManagePermission(mailboxId, user);
        const acl: AccessControlList = await this.requireAcl(mailbox.uid);
        return acl.records
            .filter((record) => record.userOrRoleId !== mailbox.ownerUserUid)
            .map((record) => ({ userOrRoleId: record.userOrRoleId, role: roleFromActions(record.actions) }));
    }

    /** Grants (or, if already a member, updates the role of) a delegate's access to this mailbox - a plain
     * upsert on the mailbox's own ACL record list, matching `grantShareTokenAccess()`'s identical
     * read-modify-write shape. */
    @Put("/:id/access/:userOrRoleId")
    public async setMember(
        @Param("id") mailboxId: string,
        @Param("userOrRoleId") userOrRoleId: string,
        body: { role: MailboxAccessRole },
        @AuthUser user?: JWTUser,
    ): Promise<MailboxAccessMember> {
        const mailbox: M = await this.requireManagePermission(mailboxId, user);
        if (userOrRoleId === mailbox.ownerUserUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The mailbox owner's access cannot be managed here.");
        }
        const role: MailboxAccessRole = body?.role;
        if (role !== "viewer" && role !== "manager") {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'role' must be 'viewer' or 'manager'.");
        }
        const acl: AccessControlList = await this.requireAcl(mailbox.uid);
        acl.records = [
            ...acl.records.filter((record) => record.userOrRoleId !== userOrRoleId),
            { userOrRoleId, actions: MAILBOX_ACCESS_ROLE_ACTIONS[role] },
        ];
        await this.aclUtils!.saveACL(acl);
        return { userOrRoleId, role };
    }

    /** Revokes a delegate's access to this mailbox - idempotent (a no-op, not a 404, if the given
     * `userOrRoleId` was never a member), matching `revokeShareTokenAccess()`'s identical fail-open
     * convention for "nothing to remove." */
    @Delete("/:id/access/:userOrRoleId")
    public async removeMember(
        @Param("id") mailboxId: string,
        @Param("userOrRoleId") userOrRoleId: string,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        const mailbox: M = await this.requireManagePermission(mailboxId, user);
        if (userOrRoleId === mailbox.ownerUserUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The mailbox owner's access cannot be managed here.");
        }
        const acl: AccessControlList = await this.requireAcl(mailbox.uid);
        const records = acl.records.filter((record) => record.userOrRoleId !== userOrRoleId);
        if (records.length === acl.records.length) {
            return;
        }
        acl.records = records;
        await this.aclUtils!.saveACL(acl);
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
     * Requires only that the caller is authenticated (no elevated permission) - the same trust level as
     * any other internal address-book-style lookup already in this codebase (e.g. `BaseKeyLookupRoute`'s
     * own discovery endpoint), and it never reveals anything beyond "does a person with this address exist
     * here," not any mailbox's contents.
     */
    @Get("/lookup-by-email")
    public async lookupOwnerByEmail(@Query("email") email: string | undefined): Promise<{ userUid: string; displayName: string } | null> {
        if (!email) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The 'email' query parameter is required.");
        }
        await this.init();
        const address = normalizeAddress(email);
        const primaryMatches: M[] = await this.mailboxRepo!.find({ primarySmtpAddress: address, limit: 1 }, { ignoreACL: true, limit: 1 });
        const mailbox: M | undefined =
            primaryMatches[0] ??
            (await this.mailboxRepo!.find({ aliasAddresses: this.aliasQueryValue(address), limit: 1 }, { ignoreACL: true, limit: 1 }))[0];
        if (!mailbox || !mailbox.ownerUserUid) {
            return null;
        }
        return { userUid: mailbox.ownerUserUid, displayName: mailbox.displayName };
    }
}
