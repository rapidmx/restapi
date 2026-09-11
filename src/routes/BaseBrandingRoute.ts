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
    ObjectFactory,
    RepoUtils,
    RouteDecorators,
} from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { recordAuditLog } from "../util/AuditLogUtils.js";
import { AuditAction, Branding } from "../models/types.js";
const { Config, Inject, Logger } = ObjectDecorators;
const { Delete, Get, Post, Put, Request, RequiresTrustedRole, Response, User: AuthUser } = RouteDecorators;

/** The fixed, well-known identifier of the one `Branding` row this route ever reads/writes - there is no
 * list/collection semantics here, exactly one row, created lazily on the first admin write. */
const BRANDING_UID = "branding";

/** The public projection of `Branding` - omits the upload bookkeeping fields (`*BlobKey`/`*ContentType`),
 * which are this route's own internal implementation detail, never something a client needs. Mirrors
 * `BaseBookingRoute.toPublicBookingType()`'s exact pattern. */
export interface PublicBranding {
    companyName: string;
    title: string;
    logoUrl?: string;
    /** The compact nav-header icon, independently configurable from `logoUrl`'s full logo/watermark - no
     * fallback between the two is applied here, consumers decide how to fall back. */
    iconUrl?: string;
    stylesheetUrl?: string;
    headerHtml?: string;
    footerHtml?: string;
}

/** All-empty defaults `GET /branding` returns when nothing has been configured yet - never a `404`, so a
 * client's boot sequence never has to special-case "no branding". */
const EMPTY_BRANDING: PublicBranding = { companyName: "", title: "" };

/** `?? undefined` on every optional field: an unset optional column comes back as `null` on the SQL backend
 * but is simply omitted (`undefined`) on Mongo - see the identical note elsewhere in this codebase on
 * `Mailbox.maxDurationMinutes` et al. Normalized here so `GET /branding`'s response shape is identical
 * regardless of which backend a deployment runs. Shared by `BaseBrandingRoute.toPublicBranding()` and
 * `readPublicBranding()` below (the latter for an SSR caller with no route instance of its own). */
function brandingToPublicDTO(branding: Branding): PublicBranding {
    return {
        companyName: branding.companyName,
        title: branding.title,
        logoUrl: branding.logoUrl ?? undefined,
        iconUrl: branding.iconUrl ?? undefined,
        stylesheetUrl: branding.stylesheetUrl ?? undefined,
        headerHtml: branding.headerHtml ?? undefined,
        footerHtml: branding.footerHtml ?? undefined,
    };
}

/**
 * Reads the current deployment-wide branding in-process, without an HTTP round-trip - for a consumer
 * that isn't itself a `BaseBrandingRoute` (e.g. a downstream server's `wwwRoute`/`AdminConsoleRoute`,
 * which need `PublicBranding` server-side to render branding on the very first byte of the response, not
 * just after a client-side fetch resolves). Constructs its own short-lived `RepoUtils` and replicates
 * `BaseBrandingRoute.get()`'s read-only lookup - deliberately not `findOrCreate()`, since a read-only SSR
 * caller has no reason to ever create the singleton row.
 */
export async function readPublicBranding(objectFactory: ObjectFactory, brandingClass: any): Promise<PublicBranding> {
    const repo: RepoUtils<Branding> = await objectFactory.newInstance(RepoUtils, {
        name: brandingClass.name,
        args: [brandingClass],
    });
    const existing = await repo.findOne(BRANDING_UID, { ignoreACL: true });
    return existing ? brandingToPublicDTO(existing) : EMPTY_BRANDING;
}

/**
 * Convenience wrapper around `readPublicBranding()` for a downstream server's own `wwwRoute`/
 * `AdminConsoleRoute`-style `fetchProps()` overrides: never lets a branding-read failure break the whole
 * page render - falls back to `EMPTY_BRANDING` instead, the same safe default every other branding
 * consumer already falls back to.
 */
export async function fetchBrandingPropsForSSR(
    objectFactory: ObjectFactory,
    brandingClass: any,
): Promise<{ branding: PublicBranding }> {
    try {
        return { branding: await readPublicBranding(objectFactory, brandingClass) };
    } catch {
        return { branding: EMPTY_BRANDING };
    }
}

function firstHeader(req: HttpRequest, name: string): string | undefined {
    const value: string | string[] | undefined = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

/**
 * Admin-managed, publicly-readable custom branding for downstream servers/web clients - logo, product
 * title/company name, stylesheet, and web-client UI chrome (`headerHtml`/`footerHtml`). A bespoke class, not
 * a `CRUDRoute`/`BaseScopedChildRoute` subclass - same shape as `BaseMailIngestRoute`/`BaseBookingRoute` (its
 * own `init()`-built `RepoUtils<Branding>`, no `@Model` needed since nothing here uses `@Transactional()`) -
 * because there is exactly one row, never a real collection, and its read/write halves need entirely
 * different authorization (public read, trusted-role-only write) that no generic CRUD base class expresses.
 *
 * Mixes two patterns this library already has fully worked out: `BaseBookingRoute`'s unauthenticated public
 * reads, and `BaseDomainRoute`'s `@RequiresTrustedRole()` admin writes plus its `recordAuditLog()` usage.
 *
 * `logoUrl`/`iconUrl`/`stylesheetUrl` each support two independent ways for an admin to set them - see
 * `Branding`'s own doc comment (`models/types.ts`) for the full rationale. Uploading
 * (`POST /branding/logo`/`/icon`/`/stylesheet`) reads the raw request body directly (`req.rawBody`,
 * matching `BaseMailIngestRoute.deliver()`'s own raw-body convention) rather than parsing multipart form
 * data - simpler, and this library has no other use for a multipart parser.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseBrandingRoute<T extends Branding> {
    protected abstract brandingClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so `update()`/the upload endpoints can persist an
     * `AuditLogEntry` without depending on either backend directly - see `util/AuditLogUtils.ts`. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    private brandingRepo?: RepoUtils<T>;

    @Inject("BlobStore")
    private blobStore?: BlobStore;

    /** The externally reachable base URL this route is mounted at, used to build the logo/stylesheet URL
     * handed back after an upload. Same single-value-config pattern as `mail:booking:public_url`. */
    @Config("mail:branding:public_url", "")
    private publicUrl: string = "";

    /** The whole application config, needed only to pass through to `recordAuditLog()` (`caller.config`,
     * used for `trusted_proxies`/`Event` construction) - `@Config()` with no arguments injects the whole
     * object, the same way `ModelRoute.config` does for every `CRUDRoute`-based route. This class isn't one
     * of those, so it needs its own. */
    @Config()
    private config: any;

    @Logger
    private logger: any;

    private async init(): Promise<void> {
        if (!this.brandingRepo) {
            this.brandingRepo = await this._objectFactory!.newInstance(RepoUtils, {
                name: this.brandingClass.name,
                args: [this.brandingClass],
            });
        }
    }

    /**
     * `RepoUtils.create()`'s duplicate-uid guard is a `count()` pre-check, not an atomic constraint check - two
     * concurrent first-ever callers can both observe `existing === undefined` below and both reach `create()`,
     * so the loser's `create()` throws a raw driver duplicate-key error rather than a clean conflict. Since
     * this is a singleton keyed on the fixed `BRANDING_UID`, the loser attempted nothing different from the
     * winner - re-fetching and returning the now-existing row is the correct outcome for a caller who only
     * ever wanted "the one branding row, created if necessary", not a real failure to surface.
     */
    private async findOrCreate(): Promise<T> {
        const existing: T | undefined = await this.brandingRepo!.findOne(BRANDING_UID, { ignoreACL: true });
        if (existing) {
            return existing;
        }
        try {
            return await this.brandingRepo!.create(
                new this.brandingClass({ uid: BRANDING_UID, companyName: "", title: "" }),
                { ignoreACL: true },
            );
        } catch (err) {
            const winner: T | undefined = await this.brandingRepo!.findOne(BRANDING_UID, { ignoreACL: true });
            if (winner) {
                return winner;
            }
            throw err;
        }
    }

    /** `?? undefined` on every optional field: an unset optional column comes back as `null` on the SQL
     * backend but is simply omitted (`undefined`) on Mongo - see the identical note elsewhere in this
     * codebase on `Mailbox.maxDurationMinutes` et al. Normalized here so `GET /branding`'s response shape
     * is identical regardless of which backend a deployment runs - a real public API contract downstream
     * clients depend on, unlike an internal field where either representation is equally fine. */
    private toPublicBranding(branding: T): PublicBranding {
        return brandingToPublicDTO(branding);
    }

    private assetUrl(path: string): string {
        return this.publicUrl ? `${this.publicUrl.replace(/\/+$/, "")}${path}` : path;
    }

    /** Best-effort - deletes `key` if set, swallowing any failure (a missing/already-gone blob must never
     * turn an otherwise-successful admin action into a `500`). */
    private async deleteBlobIfSet(key: string | undefined): Promise<void> {
        if (!key) {
            return;
        }
        try {
            await this.blobStore!.delete(key);
        } catch (err: any) {
            this.logger?.warn(`BrandingRoute: failed to delete orphaned blob '${key}': ${err.message}`);
        }
    }

    private async recordUpdate(user: JWTUser | undefined, details: Record<string, any>): Promise<void> {
        await recordAuditLog(
            this._objectFactory!,
            this.auditLogClass,
            { config: this.config, user, logger: this.logger },
            { action: AuditAction.BRANDING_UPDATE, targetType: "Branding", targetUid: BRANDING_UID, details },
        );
    }

    @Get()
    public async get(): Promise<PublicBranding> {
        await this.init();
        const existing: T | undefined = await this.brandingRepo!.findOne(BRANDING_UID, { ignoreACL: true });
        return existing ? this.toPublicBranding(existing) : EMPTY_BRANDING;
    }

    @RequiresTrustedRole()
    @Put()
    public async update(obj: Partial<T> | undefined, @AuthUser user?: JWTUser): Promise<PublicBranding> {
        await this.init();
        const existing: T = await this.findOrCreate();

        // `*BlobKey`/`*ContentType` are never client-settable - strip whatever the caller sent so only the
        // upload endpoints below can ever set them.
        const patch: any = { ...obj };
        delete patch.logoBlobKey;
        delete patch.logoContentType;
        delete patch.iconBlobKey;
        delete patch.iconContentType;
        delete patch.stylesheetBlobKey;
        delete patch.stylesheetContentType;

        // Setting a URL directly means "use this external asset instead" - clear and best-effort delete
        // whichever self-hosted blob it's replacing, so switching back and forth doesn't orphan storage.
        // `null`, not `undefined`: TypeORM's `Repository.update()` silently drops any key whose value is
        // `undefined` from the generated SQL `UPDATE` (confirmed against a real SQLite datastore) - the
        // column would otherwise keep its stale value forever on the SQL backend. `null` is the only value
        // that actually clears a column on both backends.
        if (patch.logoUrl !== undefined && existing.logoBlobKey) {
            await this.deleteBlobIfSet(existing.logoBlobKey);
            patch.logoBlobKey = null;
            patch.logoContentType = null;
        }
        if (patch.iconUrl !== undefined && existing.iconBlobKey) {
            await this.deleteBlobIfSet(existing.iconBlobKey);
            patch.iconBlobKey = null;
            patch.iconContentType = null;
        }
        if (patch.stylesheetUrl !== undefined && existing.stylesheetBlobKey) {
            await this.deleteBlobIfSet(existing.stylesheetBlobKey);
            patch.stylesheetBlobKey = null;
            patch.stylesheetContentType = null;
        }

        const updated: T = await this.brandingRepo!.update(
            { uid: existing.uid, version: existing.version, ...patch },
            existing,
            { user, ignoreACL: true },
        );
        await this.recordUpdate(user, { companyName: updated.companyName, title: updated.title });
        return this.toPublicBranding(updated);
    }

    @RequiresTrustedRole()
    @Post("/logo")
    public async uploadLogo(@Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<PublicBranding> {
        return await this.uploadAsset(req, user, "image/", {
            urlField: "logoUrl",
            blobKeyField: "logoBlobKey",
            contentTypeField: "logoContentType",
            keyPrefix: "branding/logo",
            path: "/branding/logo",
        });
    }

    @Get("/logo")
    public async getLogo(@Response res: HttpResponse): Promise<void> {
        await this.serveAsset(res, "logoBlobKey", "logoContentType");
    }

    @RequiresTrustedRole()
    @Delete("/logo")
    public async deleteLogo(@AuthUser user?: JWTUser): Promise<void> {
        await this.deleteAsset(user, "logoUrl", "logoBlobKey", "logoContentType", "logo");
    }

    @RequiresTrustedRole()
    @Post("/icon")
    public async uploadIcon(@Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<PublicBranding> {
        return await this.uploadAsset(req, user, "image/", {
            urlField: "iconUrl",
            blobKeyField: "iconBlobKey",
            contentTypeField: "iconContentType",
            keyPrefix: "branding/icon",
            path: "/branding/icon",
        });
    }

    @Get("/icon")
    public async getIcon(@Response res: HttpResponse): Promise<void> {
        await this.serveAsset(res, "iconBlobKey", "iconContentType");
    }

    @RequiresTrustedRole()
    @Delete("/icon")
    public async deleteIcon(@AuthUser user?: JWTUser): Promise<void> {
        await this.deleteAsset(user, "iconUrl", "iconBlobKey", "iconContentType", "icon");
    }

    @RequiresTrustedRole()
    @Post("/stylesheet")
    public async uploadStylesheet(@Request req: HttpRequest, @AuthUser user?: JWTUser): Promise<PublicBranding> {
        return await this.uploadAsset(req, user, "text/css", {
            urlField: "stylesheetUrl",
            blobKeyField: "stylesheetBlobKey",
            contentTypeField: "stylesheetContentType",
            keyPrefix: "branding/stylesheet",
            path: "/branding/stylesheet",
        });
    }

    @Get("/stylesheet")
    public async getStylesheet(@Response res: HttpResponse): Promise<void> {
        await this.serveAsset(res, "stylesheetBlobKey", "stylesheetContentType");
    }

    @RequiresTrustedRole()
    @Delete("/stylesheet")
    public async deleteStylesheet(@AuthUser user?: JWTUser): Promise<void> {
        await this.deleteAsset(user, "stylesheetUrl", "stylesheetBlobKey", "stylesheetContentType", "stylesheet");
    }

    /**
     * Shared upload logic for both `POST /branding/logo` and `POST /branding/stylesheet`. `requiredContentTypePrefix`
     * is checked with `startsWith()` so `"image/"` accepts any `image/*` and `"text/css"` requires an exact
     * match (there is no meaningful `text/css/*` subtype family the way there is for images).
     */
    private async uploadAsset(
        req: HttpRequest,
        user: JWTUser | undefined,
        requiredContentTypePrefix: string,
        fields: {
            urlField: "logoUrl" | "iconUrl" | "stylesheetUrl";
            blobKeyField: "logoBlobKey" | "iconBlobKey" | "stylesheetBlobKey";
            contentTypeField: "logoContentType" | "iconContentType" | "stylesheetContentType";
            keyPrefix: string;
            path: string;
        },
    ): Promise<PublicBranding> {
        await this.init();
        const contentType: string = firstHeader(req, "content-type") ?? "";
        if (!contentType.startsWith(requiredContentTypePrefix)) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                `Content-Type must be '${requiredContentTypePrefix}${requiredContentTypePrefix.endsWith("/") ? "*" : ""}'.`,
            );
        }
        const raw: Buffer | undefined = req.rawBody;
        if (!raw || raw.length === 0) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, ApiErrorMessages.INVALID_REQUEST);
        }

        const existing: T = await this.findOrCreate();
        await this.deleteBlobIfSet((existing as any)[fields.blobKeyField]);

        const blobKey: string = `${fields.keyPrefix}/${crypto.randomUUID()}`;
        await this.blobStore!.put(blobKey, raw, { contentType });

        const updated: T = await this.brandingRepo!.update(
            {
                uid: existing.uid,
                version: (existing as any).version,
                [fields.urlField]: this.assetUrl(fields.path),
                [fields.blobKeyField]: blobKey,
                [fields.contentTypeField]: contentType,
            } as any,
            existing,
            { user, ignoreACL: true },
        );
        await this.recordUpdate(user, { asset: fields.keyPrefix, uploaded: true });
        return this.toPublicBranding(updated);
    }

    private async serveAsset(
        res: HttpResponse,
        blobKeyField: "logoBlobKey" | "iconBlobKey" | "stylesheetBlobKey",
        contentTypeField: "logoContentType" | "iconContentType" | "stylesheetContentType",
    ): Promise<void> {
        await this.init();
        const existing: T | undefined = await this.brandingRepo!.findOne(BRANDING_UID, { ignoreACL: true });
        const blobKey: string | undefined = existing ? (existing as any)[blobKeyField] : undefined;
        if (!existing || !blobKey) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        const content: Buffer = await this.blobStore!.get(blobKey);
        res.setHeader("content-type", (existing as any)[contentTypeField] ?? "application/octet-stream");
        res.setHeader("cache-control", "no-cache");
        res.send(content);
    }

    private async deleteAsset(
        user: JWTUser | undefined,
        urlField: "logoUrl" | "iconUrl" | "stylesheetUrl",
        blobKeyField: "logoBlobKey" | "iconBlobKey" | "stylesheetBlobKey",
        contentTypeField: "logoContentType" | "iconContentType" | "stylesheetContentType",
        assetName: string,
    ): Promise<void> {
        await this.init();
        const existing: T = await this.findOrCreate();
        await this.deleteBlobIfSet((existing as any)[blobKeyField]);
        // `null`, not `undefined` - see the identical note in `update()` above.
        await this.brandingRepo!.update(
            {
                uid: existing.uid,
                version: (existing as any).version,
                [urlField]: null,
                [blobKeyField]: null,
                [contentTypeField]: null,
            } as any,
            existing,
            { user, ignoreACL: true },
        );
        await this.recordUpdate(user, { asset: assetName, deleted: true });
    }
}
