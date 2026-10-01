///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ACLAction,
    ApiErrorMessages,
    ApiErrors,
    DocDecorators,
    type HttpRequest,
    type HttpResponse,
    RouteDecorators,
    type UpdateObject,
} from "@rapidrest/service-core";
import type { BlobStore } from "../blob/BlobStore.js";
import { sniffImageType } from "../util/AppearanceUtils.js";
import { deleteBlobsIfUnreferenced } from "../util/BlobReferenceUtils.js";
import { getMailboxUidForFolder } from "../util/FolderUtils.js";
import { BaseScopedChildRoute } from "./BaseScopedChildRoute.js";
import { Contact } from "../models/types.js";
const { Inject } = ObjectDecorators;
const { Description, Returns, Summary } = DocDecorators;
const { Delete, Get, Param, Post, Put, Query, RateLimit, Request, Response, User: AuthUser } = RouteDecorators;

/** The largest contact photo `PUT /:id/photo` accepts, in bytes (1 MiB; 413 beyond). A contact photo is shown as a small
 * avatar, so this is generous; the HTTP server's own `max_body_size` is a second, coarser ceiling. */
export const CONTACT_PHOTO_MAX_BYTES: number = 1024 * 1024;

/** The only image types a contact photo may be (the `Content-Type` of the upload, and what its bytes must really be). SVG
 * is deliberately not one: it can carry script, and the photo is served from the API's own origin. */
export const CONTACT_PHOTO_CONTENT_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/** The `BlobStore` key prefix of every contact photo this route stores (`contact-photos/<contactUid>/<random>`). This
 * route only ever deletes keys under it, whatever a contact's `photoBlobKey` says. */
export const CONTACT_PHOTO_KEY_PREFIX: string = "contact-photos/";

/** Generous per-user limits (per minute) on the photo writes; the read is not limited (a contact list shows many avatars). */
const PHOTO_UPLOAD_MAX_ATTEMPTS: number = 60;
const PHOTO_DELETE_MAX_ATTEMPTS: number = 120;
const PHOTO_WINDOW_SECONDS: number = 60;

/** How often a photo write is retried when another write to the same contact won the race (only without a client `?version=`). */
const MAX_PHOTO_WRITE_ATTEMPTS: number = 3;

/** The type of image `bytes` really is, from its magic number, when it is one of `CONTACT_PHOTO_CONTENT_TYPES`; `undefined`
 * for anything else. What a client declares decides nothing. */
export function sniffContactPhotoType(bytes: Buffer): string | undefined {
    if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("latin1", 0, 6))) {
        return "image/gif";
    }
    const sniffed: string | undefined = sniffImageType(bytes);
    return sniffed !== undefined && CONTACT_PHOTO_CONTENT_TYPES.includes(sniffed) ? sniffed : undefined;
}

function firstHeader(req: HttpRequest, name: string): string | undefined {
    const value: string | string[] | undefined = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/** `Contact` fields the federation Discovery protocol (`util/KeyringUtils.ts`) alone is responsible for
 * writing - trust-on-first-use pinning, anti-downgrade, and key-conflict detection all depend on these never
 * being set by an ordinary client-facing edit, the same way `Message.encrypted`/`bodyBlobKey` are populated
 * only by server-side pipeline code, never by a caller's own request body. Rejected outright (400) rather
 * than silently stripped - a caller whose request appeared to succeed but silently dropped part of it is a
 * worse outcome than a loud, immediate error. */
const DISCOVERY_MANAGED_FIELDS = [
    "keys",
    "encryptPreference",
    "keysFirstSeen",
    "lastMessageSeen",
    "keyConflict",
    "keyConflicts",
    "previousKeys",
    "rejectedKeys",
] as const;

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
 * Extends `BaseScopedChildRoute` for `Contact` with two additions. First: `create()`/`update()` (and, transitively,
 * `updateBulk()`/`updateProperty()`, which both call through `update()`) reject any attempt to set the
 * key-discovery-managed fields added to `Contact` by `specs/end-to-end_encryption.md`'s Keyring section.
 * `BaseScopedChildRoute` fully reimplements `create()`/`update()` rather than delegating to `CRUDRoute`'s own
 * `validateCreate()`/`validateUpdate()` extension points, so overriding here - not there - is the only place
 * this check actually runs.
 *
 * Second, the contact's photo (`photoBlobKey`, a server-managed field no request body can set):
 *
 * `PUT /:id/photo` - the body is the raw image, `Content-Type` one of `CONTACT_PHOTO_CONTENT_TYPES` (415 otherwise) and
 * really that type by its magic bytes (400 otherwise), at most `CONTACT_PHOTO_MAX_BYTES` (413). Needs UPDATE on the
 * contact's folder, as `PUT /:id` does (403; 404 for a missing or soft-deleted contact). An optional `?version=` must be
 * the contact's current version (409 otherwise); without it the write applies to whatever is current. The bytes are
 * stored in the `BlobStore` under a fresh unguessable `contact-photos/<contactUid>/<random>` key, the contact's version
 * is bumped like any update, the same live-update notification is published, and the updated contact is returned. The
 * previous photo's blob is deleted afterwards.
 * `GET /:id/photo` - the stored bytes with their image type, `Cache-Control: private, max-age=86400` and an `ETag` (the
 * key's random part; a matching `If-None-Match` gives 304). 404 when there is no photo or the caller cannot read the
 * contact.
 * `DELETE /:id/photo` - clears the photo and deletes its blob; the same access, version and notification rules as the
 * upload. Idempotent: a contact with no photo is returned unchanged.
 *
 * A soft-deleted contact keeps its photo (it is recoverable); a permanent delete (`?purge=true`, `truncate()`) deletes
 * it, and so does `ErasureExecutionJob`.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseContactRoute<T extends Contact> extends BaseScopedChildRoute<T> {
    /** `photoBlobKey` names a stored object; a client-chosen key would point this contact's photo at any blob (another
     * mailbox's message body or attachment). Only `setPhoto()`/`deletePhoto()` (below) set it. */
    protected readonly serverManagedFields: readonly string[] = ["photoBlobKey"];

    /** `photoBlobKey` is dropped from every caller's body, a trusted one's included (the base class leaves those alone): a stored
     * key is deleted with the contact (`afterPurge()`, the erasure job), so no body may be able to name another object's blob. */
    protected stripServerManagedFields(obj: any, user: JWTUser | undefined): void {
        delete obj.photoBlobKey;
        super.stripServerManagedFields(obj, user);
    }

    @Inject("BlobStore")
    private blobStore?: BlobStore;

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

    /** The key of `existing`'s photo blob when it is one this route may serve: under its own `contact-photos/<uid>/`
     * prefix. Anything else a trusted caller may have stored in `photoBlobKey` is neither served nor deleted here. */
    private photoKeyOf(existing: T): string | undefined {
        const key: unknown = existing.photoBlobKey;
        return typeof key === "string" && key.startsWith(`${CONTACT_PHOTO_KEY_PREFIX}${existing.uid}/`) ? key : undefined;
    }

    /** Deletes each of `keys` that is a contact photo blob no contact row (soft-deleted ones included) still names.
     * Best-effort: a blob that cannot be deleted is logged and left, never failing the request that already succeeded. */
    private async deletePhotoBlobs(keys: (string | undefined | null)[]): Promise<void> {
        const photoKeys: string[] = keys.filter((key): key is string => !!key && key.startsWith(CONTACT_PHOTO_KEY_PREFIX));
        if (photoKeys.length === 0) {
            return;
        }
        try {
            await deleteBlobsIfUnreferenced(
                this._objectFactory!,
                this.blobStore!,
                [{ entityClass: this.modelClass, fields: ["photoBlobKey"] }],
                photoKeys,
            );
            /* v8 ignore start -- only a blob store or database failure */
        } catch (err: any) {
            this.logger?.warn(`BaseContactRoute: failed to delete contact photo blob(s) ${photoKeys.join(", ")}: ${err?.message}`);
        }
        /* v8 ignore stop */
    }

    /** After a permanent delete (`?purge=true`, `truncate()`), removes the deleted contacts' photos. */
    protected async afterPurge(records: T[], prepared: unknown): Promise<void> {
        await this.deletePhotoBlobs(records.map((record) => record.photoBlobKey));
    }

    /** `?version=` as the contact version it names; 400 unless a non-negative integer. */
    private static requestedVersion(version: string | undefined): number | undefined {
        if (version === undefined) {
            return undefined;
        }
        if (!/^\d{1,15}$/.test(version)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "version must be a non-negative integer.");
        }
        return Number(version);
    }

    /** The contact `id` names, for a caller who may UPDATE it: 404 for none (or a soft-deleted one), 403 without access. */
    private async findWritable(id: string, user: JWTUser | undefined): Promise<T> {
        const existing: T | undefined = await this.repoUtils!.findOne(id, { skipCache: true, ignoreACL: true });
        if (!existing) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        if (!(await this.hasMailAccess(user, existing.folderUid, ACLAction.UPDATE))) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        return existing;
    }

    /**
     * Points contact `id`'s `photoBlobKey` at `key` (`null` clears it) as an ordinary version-bumping update and publishes
     * it. `version` is the client's `?version=` (409 unless current); without one a lost race is retried from a fresh
     * read. Returns the saved contact and the photo key it replaced. Clearing a contact that has no photo writes nothing.
     */
    private async savePhotoKey(
        id: string,
        user: JWTUser | undefined,
        version: number | undefined,
        key: string | null,
    ): Promise<{ saved: T; previous: string | undefined }> {
        for (let attempt = 1; ; attempt++) {
            const existing: T = await this.findWritable(id, user);
            if (version !== undefined && version !== (existing as any).version) {
                throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, ApiErrorMessages.INVALID_OBJECT_VERSION);
            }
            const previous: string | undefined = existing.photoBlobKey ?? undefined;
            if (key === null && !previous) {
                return { saved: existing, previous: undefined };
            }
            try {
                const saved: T = await this.repoUtils!.update(
                    { uid: existing.uid, version: (existing as any).version, photoBlobKey: key } as any,
                    existing,
                    { user, ignoreACL: true },
                );
                this.notify(existing.folderUid, "update", saved);
                return { saved, previous };
                /* v8 ignore start -- only a concurrent write to the same contact reaches here */
            } catch (err: any) {
                if (version !== undefined || attempt >= MAX_PHOTO_WRITE_ATTEMPTS || err?.status !== 409) {
                    throw err;
                }
            }
            /* v8 ignore stop */
        }
    }

    @Summary("Set a contact's photo")
    @Description(
        `Stores the request body (the raw image: Content-Type image/jpeg, image/png, image/gif or image/webp, at most ${CONTACT_PHOTO_MAX_BYTES} bytes) as the contact's photo.`,
    )
    @Returns([Object])
    @RateLimit({ perUser: true, maxAttempts: PHOTO_UPLOAD_MAX_ATTEMPTS, windowSeconds: PHOTO_WINDOW_SECONDS })
    @Put("/:id/photo")
    public async setPhoto(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @Request req: HttpRequest,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        const declared: string = (firstHeader(req, "content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!CONTACT_PHOTO_CONTENT_TYPES.includes(declared)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 415, `Content-Type must be one of: ${CONTACT_PHOTO_CONTENT_TYPES.join(", ")}.`);
        }
        const requested: number | undefined = BaseContactRoute.requestedVersion(version);
        const raw: Buffer | undefined = req.rawBody;
        if (!raw || raw.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The request body must be the image.");
        }
        if (raw.length > CONTACT_PHOTO_MAX_BYTES) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 413, `The photo is larger than the ${CONTACT_PHOTO_MAX_BYTES} bytes allowed.`);
        }
        // Permission before the content is looked at, so a caller with no access learns nothing else from the response.
        const existing: T = await this.findWritable(id, user);
        if (sniffContactPhotoType(raw) !== declared) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `The body is not a valid ${declared} image.`);
        }

        const key: string = `${CONTACT_PHOTO_KEY_PREFIX}${existing.uid}/${crypto.randomUUID()}`;
        await this.blobStore!.put(key, raw, { contentType: declared });
        try {
            const { saved, previous } = await this.savePhotoKey(id, user, requested, key);
            await this.deletePhotoBlobs([previous]);
            return saved;
        } catch (err) {
            // Nothing points at the new blob; it must not be left behind.
            await this.deletePhotoBlobs([key]);
            throw err;
        }
    }

    @Summary("Get a contact's photo")
    @Description("Returns the contact's photo image. 404 when there is none or the caller cannot read the contact.")
    @Get("/:id/photo")
    public async getPhoto(
        @Param("id") id: string,
        @Request req: HttpRequest,
        @Response res: HttpResponse,
        @AuthUser user?: JWTUser,
    ): Promise<void> {
        const existing: T | undefined = await this.repoUtils!.findOne(id, { ignoreACL: true });
        const key: string | undefined = existing ? this.photoKeyOf(existing) : undefined;
        if (!existing || !key || !(await this.hasMailAccess(user, existing.folderUid, ACLAction.READ))) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        // The random part of the key changes with every upload, so it identifies exactly these bytes.
        const etag: string = `"${key.substring(key.lastIndexOf("/") + 1)}"`;
        const matches: boolean = (firstHeader(req, "if-none-match") ?? "")
            .split(",")
            .map((candidate) => candidate.trim().replace(/^W\//, ""))
            .some((candidate) => candidate === "*" || candidate === etag);
        res.setHeader("etag", etag);
        // Revalidated on every use (the ETag makes that a cheap 304): a stored max-age would keep showing the photo for a day after
        // the contact was deleted or the caller lost access, and the access check above only runs when the browser asks.
        res.setHeader("cache-control", "private, no-cache");
        if (matches) {
            res.status(304).send();
            return;
        }
        let content: Buffer;
        try {
            content = await this.blobStore!.get(key);
            /* v8 ignore start -- only a contact whose blob has gone missing */
        } catch {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        /* v8 ignore stop */
        // The type is what the bytes are (the upload was checked against them), never a client-supplied string.
        const contentType: string | undefined = sniffContactPhotoType(content);
        /* v8 ignore start -- only a blob replaced behind this route's back */
        if (!contentType) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        /* v8 ignore stop */
        res.setHeader("content-type", contentType);
        res.setHeader("content-length", content.length);
        // Served from this API's own origin: never let a browser sniff it into something active, only ever show it inline,
        // and sandbox it if it is opened directly.
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("content-disposition", "inline");
        res.setHeader("content-security-policy", "default-src 'none'; sandbox");
        res.send(content);
    }

    @Summary("Remove a contact's photo")
    @Description("Clears the contact's photo and deletes its stored image. A contact with no photo is returned unchanged.")
    @Returns([Object])
    @RateLimit({ perUser: true, maxAttempts: PHOTO_DELETE_MAX_ATTEMPTS, windowSeconds: PHOTO_WINDOW_SECONDS })
    @Delete("/:id/photo")
    public async deletePhoto(
        @Param("id") id: string,
        @Query("version") version: string | undefined,
        @AuthUser user?: JWTUser,
    ): Promise<T> {
        const { saved, previous } = await this.savePhotoKey(id, user, BaseContactRoute.requestedVersion(version), null);
        await this.deletePhotoBlobs([previous]);
        return saved;
    }
}
