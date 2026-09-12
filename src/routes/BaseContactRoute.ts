///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError, type JWTUser } from "@rapidrest/core";
import { ApiErrors, type HttpRequest, RouteDecorators, type UpdateObject } from "@rapidrest/service-core";
import { getMailboxUidForFolder } from "../util/FolderUtils.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { Contact } from "../models/types.js";
const { Param, Post, Put, Request, User: AuthUser } = RouteDecorators;

/** `Contact` fields the federation Discovery protocol (`util/KeyringUtils.ts`) alone is responsible for
 * writing - trust-on-first-use pinning, anti-downgrade, and key-conflict detection all depend on these never
 * being set by an ordinary client-facing edit, the same way `Message.encrypted`/`bodyBlobKey` are populated
 * only by server-side pipeline code, never by a caller's own request body. Rejected outright (400) rather
 * than silently stripped - a caller whose request appeared to succeed but silently dropped part of it is a
 * worse outcome than a loud, immediate error. */
const DISCOVERY_MANAGED_FIELDS = ["keys", "encryptPreference", "keysFirstSeen", "lastMessageSeen", "keyConflict"] as const;

function rejectDiscoveryManagedFields(obj: Partial<Contact>): void {
    for (const field of DISCOVERY_MANAGED_FIELDS) {
        if (field in obj) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `'${field}' is managed by key discovery and cannot be set directly.`,
            );
        }
    }
}

/**
 * Extends `BaseScopedChildRoute` for `Contact` with one addition: `create()`/`update()` (and, transitively,
 * `updateBulk()`/`updateProperty()`, which both call through `update()`) reject any attempt to set the
 * key-discovery-managed fields added to `Contact` by `specs/end-to-end_encryption.md`'s Keyring section.
 * `BaseScopedChildRoute` fully reimplements `create()`/`update()` rather than delegating to `CRUDRoute`'s own
 * `validateCreate()`/`validateUpdate()` extension points, so overriding here - not there - is the only place
 * this check actually runs.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseContactRoute<T extends Contact> extends BaseScopedChildRoute<T> {
    /** The concrete `Folder` entity class, supplied by the Mongo/SQL concrete subclass - used only by
     * `resolveMailboxUidFor()` below. */
    protected abstract folderClass: any;

    /** See `BaseScopedChildRoute.resolveMailboxUidFor()`'s own doc comment - `Contact` carries its own
     * denormalized `mailboxUid` that must never diverge from its actual folder's mailbox. */
    protected async resolveMailboxUidFor(scopeUid: string): Promise<string | undefined> {
        return getMailboxUidForFolder(this._objectFactory!, this.folderClass, scopeUid);
    }

    @Post()
    public async create(obj: T | T[], @Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<T | T[]> {
        for (const single of Array.isArray(obj) ? obj : [obj]) {
            rejectDiscoveryManagedFields(single);
        }
        return super.create(obj, req, user);
    }

    @Put("/:id")
    public async update(
        @Param("id") id: string,
        obj: UpdateObject<T>,
        @Request req?: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        rejectDiscoveryManagedFields(obj);
        return super.update(id, obj, req, user);
    }
}
