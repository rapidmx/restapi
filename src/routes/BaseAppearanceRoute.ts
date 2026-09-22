///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError, ObjectDecorators, type JWTUser } from "@rapidrest/core";
import {
    ApiErrorMessages,
    ApiErrors,
    HttpRequest,
    HttpResponse,
    NotificationUtils,
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import {
    APPEARANCE_IMAGE_TYPES,
    appearanceImageKey,
    appearanceUid,
    applyAppearancePatch,
    type AppearancePatch,
    type AppearanceState,
    defaultAppearance,
    sniffImageType,
    toPublicAppearance,
    validateAppearancePatch,
} from "../util/AppearanceUtils.js";
import type { AppearanceBackground, AppearancePreferences, PublicAppearancePreferences } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Auth, Delete, Get, Param, Post, Put, RateLimit, Request, Response, User: AuthUser } = RouteDecorators;

/** Generous per-user limits (per minute) - a slider being dragged sends many small saves, an upload is one big one. */
const SAVE_MAX_ATTEMPTS: number = 600;
const UPLOAD_MAX_ATTEMPTS: number = 30;
const DELETE_MAX_ATTEMPTS: number = 60;
const WINDOW_SECONDS: number = 60;

/** How often a write is retried when another write to the same row won the race. */
const MAX_WRITE_ATTEMPTS: number = 3;

function firstHeader(req: HttpRequest, name: string): string | undefined {
    const value: string | string[] | undefined = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/**
 * The signed-in user's saved appearance preferences for a server-rendered page (`wwwRoute`'s `fetchProps()`), so the theme
 * can be applied in the first byte of HTML instead of flashing the default: `undefined` when the user has saved none, or
 * has no `uid`. One read of one row, and it never fails the page - a datastore error is logged at debug level and
 * answered with `undefined`.
 */
export async function fetchAppearanceForSSR(
    objectFactory: ObjectFactory,
    appearanceClass: any,
    userUid: string | undefined,
    logger?: any,
): Promise<PublicAppearancePreferences | undefined> {
    if (!userUid) {
        return undefined;
    }
    try {
        const repo: RepoUtils<AppearancePreferences> = await objectFactory.newInstance(RepoUtils, {
            name: appearanceClass.name,
            args: [appearanceClass],
        });
        const row: AppearancePreferences | undefined = await repo.findOne(appearanceUid(userUid), { ignoreACL: true });
        return row ? toPublicAppearance(row) : undefined;
    } catch (err: any) {
        logger?.debug(`fetchAppearanceForSSR: could not read the appearance of user ${userUid}: ${err?.message}`);
        return undefined;
    }
}

/**
 * The web client's appearance settings (theme mode, colours, window background) for the signed-in user - one row per
 * user, not per mailbox. Every route touches only the caller's own row (the row's uid is derived from the JWT's `uid`;
 * there is no way to name another user's), and a trusted role gets no exception: this is personal data, not
 * administration.
 *
 * `GET /` the caller's preferences, or the defaults when none are saved (never a 404).
 * `PUT /` merges a partial body (see `validateAppearancePatch()` and `applyAppearancePatch()`), validating every field
 * strictly, and returns the saved preferences.
 * `POST /background` a raw image upload (`Content-Type` `image/png`, `image/jpeg`, `image/webp` or `image/avif`; the bytes
 * decide what it is, not the header - SVG is refused). Stored in the `BlobStore` under `appearance/<userUid>/<version>`
 * with a fresh random `version` per upload; the previous image's blob is deleted.
 * `GET /background/:version` the image, cacheable forever (the version changes with every upload), owner only: 404 for
 * anyone else, so the existence of another user's image is never revealed.
 * `DELETE /background` removes the image and sets the background's `kind` to `"none"`.
 *
 * After every successful write the preferences are published on the user's own uid channel (`{ type: <entity class>,
 * action: "update", data: <preferences> }`) so other tabs and devices update live. Best-effort: a publish failure never
 * fails the write.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseAppearanceRoute<T extends AppearancePreferences> {
    protected abstract appearanceClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private repo?: RepoUtils<T>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    @Inject(NotificationUtils)
    private notificationUtils?: NotificationUtils;

    /** The largest background image accepted, in bytes (413 beyond). The HTTP server's own `max_body_size` (10 MiB by
     * default) is a second, independent ceiling. */
    @Config("mail:preferences:background_max_bytes", 8 * 1024 * 1024)
    private backgroundMaxBytes: number = 8 * 1024 * 1024;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.repo) {
            this.repo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.appearanceClass.name,
                args: [this.appearanceClass],
            });
        }
    }

    /** The caller's own uid; a token without one has no preferences to touch. */
    private static userUidOf(user: JWTUser | undefined): string {
        if (!user?.uid) {
            throw new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        }
        return user.uid;
    }

    private async findRow(userUid: string, fresh: boolean = false): Promise<T | undefined> {
        return await this.repo!.findOne(appearanceUid(userUid), { ignoreACL: true, skipCache: fresh });
    }

    /**
     * Reads the caller's row, lets `change` decide what to write (a 400 thrown from it aborts; `undefined` means nothing
     * to write) and writes it - creating the row on first write - retrying from a fresh read when a concurrent write got
     * there first. Returns the row as saved, or as it was when there was nothing to write (`undefined` when there is
     * none).
     */
    private async modify(userUid: string, change: (row: T | undefined) => Partial<T> | undefined): Promise<T | undefined> {
        for (let attempt = 1; ; attempt++) {
            const row: T | undefined = await this.findRow(userUid, true);
            const fields: Partial<T> | undefined = change(row);
            if (!fields) {
                return row;
            }
            try {
                if (!row) {
                    return await this.repo!.create(new this.appearanceClass({ uid: appearanceUid(userUid), userUid, ...fields }), {
                        ignoreACL: true,
                        skipPush: true,
                    });
                }
                return await this.repo!.update({ uid: row.uid, version: (row as any).version, ...fields }, row, {
                    ignoreACL: true,
                    skipPush: true,
                });
            } catch (err: any) {
                if (attempt >= MAX_WRITE_ATTEMPTS) {
                    throw err;
                }
                this.logger?.debug(`AppearanceRoute: retrying the write for user ${userUid} (attempt ${attempt}): ${err?.message}`);
            }
        }
    }

    /** Publishes `preferences` to the user's own channel. Best-effort. */
    private publish(userUid: string, preferences: PublicAppearancePreferences): void {
        try {
            this.notificationUtils?.sendMessage(userUid, this.appearanceClass.name, "update", preferences);
            /* v8 ignore start -- only a notification transport that throws synchronously */
        } catch (err: any) {
            this.logger?.warn(`AppearanceRoute: failed to publish the preferences of user ${userUid}: ${err?.message}`);
        }
        /* v8 ignore stop */
    }

    private static stateOf(row: AppearancePreferences | undefined): AppearanceState {
        return {
            mode: row?.mode ?? "system",
            colors: row?.colors,
            background: row?.background,
        };
    }

    @Auth(["jwt"])
    @Get()
    public async get(@AuthUser user?: JWTUser): Promise<PublicAppearancePreferences> {
        const userUid: string = BaseAppearanceRoute.userUidOf(user);
        await this.init();
        const row: T | undefined = await this.findRow(userUid);
        return row ? toPublicAppearance(row) : defaultAppearance();
    }

    @Auth(["jwt"])
    @RateLimit({ perUser: true, maxAttempts: SAVE_MAX_ATTEMPTS, windowSeconds: WINDOW_SECONDS })
    @Put()
    public async update(obj: unknown, @AuthUser user?: JWTUser): Promise<PublicAppearancePreferences> {
        const userUid: string = BaseAppearanceRoute.userUidOf(user);
        const patch: AppearancePatch = validateAppearancePatch(obj);
        await this.init();
        const saved: T | undefined = await this.modify(userUid, (row) => {
            if (Object.keys(patch).length === 0) {
                return undefined;
            }
            const next: AppearanceState = applyAppearancePatch(BaseAppearanceRoute.stateOf(row), patch);
            return {
                mode: next.mode,
                colors: next.colors ?? null,
                background: next.background ?? null,
            } as Partial<T>;
        });
        // A body with nothing to change reads back what is there (the defaults for a user with no row) without writing one.
        if (!saved) {
            return defaultAppearance();
        }
        const preferences: PublicAppearancePreferences = toPublicAppearance(saved);
        if (Object.keys(patch).length > 0) {
            this.publish(userUid, preferences);
        }
        return preferences;
    }

    /**
     * Stores the request body as the caller's background image. 400 for an empty body, 415 when the header or the
     * bytes are not one of the supported image types (an SVG is neither), 413 above `background_max_bytes`. The bytes
     * are stored as sent - nothing is re-encoded - under a fresh random version, the background's `kind` becomes
     * `"image"` and its `dim`/`blur`/`fit` are kept (or take their defaults). The previous image's blob is deleted once
     * the new one is saved.
     */
    @Auth(["jwt"])
    @RateLimit({ perUser: true, maxAttempts: UPLOAD_MAX_ATTEMPTS, windowSeconds: WINDOW_SECONDS })
    @Post("/background")
    public async uploadBackground(@Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<PublicAppearancePreferences> {
        const userUid: string = BaseAppearanceRoute.userUidOf(user);
        const declared: string = (firstHeader(req, "content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!APPEARANCE_IMAGE_TYPES.includes(declared)) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                415,
                `Content-Type must be one of: ${APPEARANCE_IMAGE_TYPES.join(", ")}.`,
            );
        }
        const raw: Buffer | undefined = req.rawBody;
        if (!raw || raw.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The request body must be the image.");
        }
        if (raw.length > Number(this.backgroundMaxBytes)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 413, `The image is larger than the ${Number(this.backgroundMaxBytes)} bytes allowed.`);
        }
        const contentType: string | undefined = sniffImageType(raw);
        if (!contentType) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 415, "The file is not a PNG, JPEG, WebP or AVIF image.");
        }

        await this.init();
        const version: string = crypto.randomUUID();
        const key: string = appearanceImageKey(userUid, version);
        await this.blobStore!.put(key, raw, { contentType });
        let previous: string | undefined;
        let saved: T | undefined;
        try {
            saved = await this.modify(userUid, (row) => {
                previous = row?.background?.imageVersion;
                const background: AppearanceBackground = {
                    ...(row?.background ?? { dim: 0, blur: 0, fit: "cover" }),
                    kind: "image",
                    imageVersion: version,
                };
                return { background, backgroundContentType: contentType } as Partial<T>;
            });
            /* v8 ignore start -- only a database failure after the image was stored */
        } catch (err) {
            await this.deleteBlob(key);
            throw err;
        }
        /* v8 ignore stop */
        if (previous) {
            await this.deleteBlob(appearanceImageKey(userUid, previous));
        }
        const preferences: PublicAppearancePreferences = toPublicAppearance(saved!);
        this.publish(userUid, preferences);
        return preferences;
    }

    /** The caller's background image. 404 when there is none or `version` is not the current one. */
    @Auth(["jwt"])
    @Get("/background/:version")
    public async getBackground(@Param("version") version: string, @Response res: HttpResponse, @AuthUser user?: JWTUser): Promise<void> {
        const userUid: string = BaseAppearanceRoute.userUidOf(user);
        await this.init();
        const row: T | undefined = await this.findRow(userUid);
        const current: string | undefined = row?.background?.imageVersion;
        if (!row || !current || current !== version || !row.backgroundContentType) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        let content: Buffer;
        try {
            content = await this.blobStore!.get(appearanceImageKey(userUid, current));
            /* v8 ignore start -- only a row whose blob has gone missing */
        } catch {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        /* v8 ignore stop */
        res.setHeader("content-type", row.backgroundContentType);
        res.setHeader("content-length", content.length);
        // The version is different for every upload, so a cached copy is never stale; private because the image is the
        // user's own.
        res.setHeader("cache-control", "private, max-age=31536000, immutable");
        // Served from this API's own origin: never let a browser sniff it into something active, only ever show it
        // inline, and sandbox it if it is opened directly.
        res.setHeader("x-content-type-options", "nosniff");
        res.setHeader("content-disposition", "inline");
        res.setHeader("content-security-policy", "default-src 'none'; sandbox");
        res.send(content);
    }

    /** Removes the caller's background image and sets the background's `kind` to `"none"`. */
    @Auth(["jwt"])
    @RateLimit({ perUser: true, maxAttempts: DELETE_MAX_ATTEMPTS, windowSeconds: WINDOW_SECONDS })
    @Delete("/background")
    public async deleteBackground(@AuthUser user?: JWTUser): Promise<PublicAppearancePreferences> {
        const userUid: string = BaseAppearanceRoute.userUidOf(user);
        await this.init();
        let previous: string | undefined;
        const saved: T | undefined = await this.modify(userUid, (row) => {
            previous = row?.background?.imageVersion;
            if (!row?.background) {
                return undefined;
            }
            const { imageVersion: _removed, ...rest } = row.background;
            return { background: { ...rest, kind: "none" }, backgroundContentType: null } as Partial<T>;
        });
        if (previous) {
            await this.deleteBlob(appearanceImageKey(userUid, previous));
        }
        if (!saved) {
            return defaultAppearance();
        }
        const preferences: PublicAppearancePreferences = toPublicAppearance(saved);
        this.publish(userUid, preferences);
        return preferences;
    }

    /** Best-effort: an image blob that could not be removed is logged, and never fails the request that replaced it. */
    private async deleteBlob(key: string): Promise<void> {
        try {
            await this.blobStore!.delete(key);
            /* v8 ignore start -- only a blob store failure */
        } catch (err: any) {
            this.logger?.warn(`AppearanceRoute: failed to delete the background image ${key}: ${err?.message}`);
        }
        /* v8 ignore stop */
    }
}
