///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import { ApiErrors, HttpRequest, RouteDecorators, type UpdateObject } from "@rapidrest/service-core";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { normalizeSlug, validateAvailability } from "../util/BookingUtils.js";
import { BookingType } from "../models/types.js";
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

    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        const objs: T[] = Array.isArray(obj) ? obj : [obj];
        const seenSlugs: Set<string> = new Set();
        for (const single of objs) {
            this.requireValidAvailability(single);
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
        return await super.update(id, obj, req, user);
    }
}
