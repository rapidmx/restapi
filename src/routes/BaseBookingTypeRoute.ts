///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import { ACLAction, ApiErrorMessages, ApiErrors, HttpRequest, RepoUtils, RouteDecorators, type UpdateObject } from "@rapidrest/service-core";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { normalizeSlug, validateAvailability } from "../util/BookingUtils.js";
import { BookingType, Folder, FolderType } from "../models/types.js";
const { Param, Request, User: AuthUser } = RouteDecorators;

/**
 * Extends `BaseScopedChildRoute` (scoped by `mailboxUid`, the `ContactList`/`MailFilterRule` shape) for
 * `BookingType`, so all ordinary CRUD is permission-checked against the owning mailbox's `AccessControlList`
 * for free. This is the HOST's view of their bookable offerings; the anonymous booker's view is
 * `BaseBookingRoute`, a deliberately separate class exposing no CRUD at all.
 *
 * `create()`/`update()` add exactly two things on top of the inherited behavior: `slug` is normalized and
 * collision-checked (a `409`, mirroring `BaseDomainRoute.assignUidAndCheckCollision()`), and the availability
 * configuration is validated (a `400`) so an unbookable or non-expandable configuration can't be persisted and
 * then silently produce zero slots forever.
 *
 * Unlike `Domain`, whose `uid` *is* its normalized name, `slug` here is an ordinary mutable indexed field. That
 * is deliberate: `RepoUtils.update()` requires `obj.uid === existing.uid` (an identity match, not a rename), so
 * a uid-derived slug could never be changed without deleting and re-creating the booking type - and unlike a
 * mail domain, renaming a public booking link is an ordinary thing to want to do.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseBookingTypeRoute<T extends BookingType> extends BaseScopedChildRoute<T> {
    protected readonly scopeProperty: string = "mailboxUid";

    /** The concrete `Folder` entity class, supplied by the Mongo/SQL concrete subclass - used to check
     * `calendarFolderUid` (see `requireBookableFolder()`). */
    protected abstract folderClass: any;

    private folderRepo?: RepoUtils<Folder>;

    /**
     * Normalizes `o.slug` in place and rejects a `409` if another `BookingType` already holds it. `excludeUid`
     * is the row being updated, if any - a booking type never collides with itself.
     */
    private async normalizeAndCheckSlug(o: Partial<T>, excludeUid?: string): Promise<void> {
        const slug: string = normalizeSlug(o.slug ?? "");
        if (!slug) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "slug is required and must contain at least one letter or digit.");
        }
        (o as any).slug = slug;

        const existing: T[] = await this.repoUtils!.find({ slug } as any, { ignoreACL: true, limit: 1 });
        if (existing.length > 0 && existing[0].uid !== excludeUid) {
            throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "This booking slug is already in use.");
        }
    }

    /** Turns `validateAvailability()`'s message-or-`undefined` result into a `400`. */
    private requireValidAvailability(o: Partial<T>): void {
        const problem: string | undefined = validateAvailability(o);
        if (problem) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, problem);
        }
    }

    /**
     * `calendarFolderUid` is where anonymous bookings are written and whose events block slots, so it must be a
     * calendar folder of the booking type's own mailbox that the caller can read - otherwise a caller managing
     * their own mailbox's booking types could point one at somebody else's calendar, publishing its free/busy
     * through the public slots endpoint and planting booking events in it. `400` for a folder of the wrong
     * mailbox or type (or no such folder), `403` when the caller can't read it.
     */
    private async requireBookableFolder(mailboxUid: unknown, calendarFolderUid: unknown, user: JWTUser | undefined): Promise<void> {
        if (typeof calendarFolderUid !== "string" || !calendarFolderUid) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "calendarFolderUid is required.");
        }
        if (!this.folderRepo) {
            this.folderRepo = await this._objectFactory!.newInstance(RepoUtils, { name: this.folderClass.name, args: [this.folderClass] });
        }
        const folder: Folder | undefined = await this.folderRepo.findOne(calendarFolderUid, { ignoreACL: true });
        // Permission first, so a caller who can't read the folder learns nothing about which mailbox it belongs to.
        if (folder && !(await this.aclUtils!.hasPermission(user, folder.uid, ACLAction.READ))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        if (!folder || (folder as any).deleted || folder.mailboxUid !== mailboxUid || folder.type !== FolderType.CALENDAR) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "calendarFolderUid must name a calendar folder of the booking type's own mailbox.");
        }
    }

    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        const seenSlugs: Set<string> = new Set();
        for (const single of objs) {
            this.requireValidAvailability(single);
            await this.requireBookableFolder(single?.mailboxUid, single?.calendarFolderUid, user);
            await this.normalizeAndCheckSlug(single);
            if (seenSlugs.has(single.slug)) {
                throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "Duplicate booking slug within the same request.");
            }
            seenSlugs.add(single.slug);
        }
        return await super.create(obj, req, user);
    }

    public async update(
        @Param("id") id: string,
        obj: UpdateObject<T>,
        @Request req?: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        // Validate/normalize only what the caller actually sent - `RepoUtils.update()` is a genuine partial
        // patch on both backends, so an absent `slug`/`availability` means "leave it alone", not "clear it".
        this.requireValidAvailability(obj);
        if ((obj as any).slug !== undefined) {
            await this.normalizeAndCheckSlug(obj, id);
        }
        // Re-checked whenever either half of the folder/mailbox pairing changes. `super.update()` still does its
        // own permission checks (UPDATE on the current mailbox, CREATE on a new one) afterwards, and a missing row
        // is its 404 to report.
        if ((obj as any).calendarFolderUid !== undefined || (obj as any).mailboxUid !== undefined) {
            const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
            if (existing) {
                await this.requireBookableFolder(
                    (obj as any).mailboxUid ?? existing.mailboxUid,
                    (obj as any).calendarFolderUid ?? existing.calendarFolderUid,
                    user,
                );
            }
        }
        return await super.update(id, obj, req, user);
    }
}
