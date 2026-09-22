///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import type {
    AppearanceBackground,
    AppearanceBackgroundFit,
    AppearanceColors,
    AppearanceMode,
    AppearancePreferences,
    PublicAppearancePreferences,
} from "../models/types.js";
import { nameBasedUuid } from "./UuidUtils.js";

export const APPEARANCE_MODES: readonly AppearanceMode[] = ["system", "light", "dark"];
export const APPEARANCE_FITS: readonly AppearanceBackgroundFit[] = ["cover", "contain", "tile"];
export const APPEARANCE_BACKGROUND_KINDS: readonly AppearanceBackground["kind"][] = ["none", "color", "image"];
export const APPEARANCE_COLOR_KEYS: readonly (keyof AppearanceColors)[] = ["primary", "accent", "surface", "text"];
export const APPEARANCE_MAX_DIM: number = 0.8;
export const APPEARANCE_MAX_BLUR: number = 20;

/** What a background looks like before a user has changed anything. */
const DEFAULT_BACKGROUND: AppearanceBackground = { kind: "none", dim: 0, blur: 0, fit: "cover" };

/** The `updatedAt` of preferences nobody has saved: the epoch, so any real save is newer. */
const UNSAVED_UPDATED_AT: string = new Date(0).toISOString();

/** The preferences a user who has saved none has. */
export function defaultAppearance(): PublicAppearancePreferences {
    return { version: 1, mode: "system", updatedAt: UNSAVED_UPDATED_AT };
}

/** The uid of `userUid`'s one row - name-based, so two first writes at once collide on the unique uid instead of making two rows. */
export function appearanceUid(userUid: string): string {
    return nameBasedUuid(`appearance-preferences:${userUid}`);
}

/** The blob key an uploaded background image is stored under. */
export function appearanceImageKey(userUid: string, version: string): string {
    return `appearance/${userUid}/${version}`;
}

/** A partial update, validated: only the keys the caller sent. `null` clears a colour, or all colours. */
export interface AppearancePatch {
    mode?: AppearanceMode;
    colors?: Partial<Record<keyof AppearanceColors, string | null>> | null;
    background?: Partial<Omit<AppearanceBackground, "color">> & { color?: string | null };
}

/** The parts of a user's preferences a patch is applied to. */
export interface AppearanceState {
    mode: AppearanceMode;
    colors?: AppearanceColors | null;
    background?: AppearanceBackground | null;
}

function invalid(message: string): ApiError {
    return new ApiError(ApiErrors.INVALID_REQUEST, 400, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` as a lowercase `#rrggbb`, or a 400 naming `field`. */
function hexColor(value: unknown, field: string): string {
    if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) {
        throw invalid(`'${field}' must be a colour written as #rrggbb.`);
    }
    return value.toLowerCase();
}

function rangedNumber(value: unknown, field: string, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
        throw invalid(`'${field}' must be a number from 0 to ${max}.`);
    }
    return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
        throw invalid(`'${field}' must be one of ${allowed.map((option) => `"${option}"`).join(", ")}.`);
    }
    return value as T;
}

/** Refuses (400) any key of `obj` outside `known`, naming it as `prefix` + key. */
function assertKnownKeys(obj: Record<string, unknown>, known: readonly string[], prefix: string): void {
    for (const key of Object.keys(obj)) {
        if (!known.includes(key)) {
            throw invalid(`'${prefix}${key}' is not a known field.`);
        }
    }
}

/**
 * Validates the body of `PUT /mail/preferences/appearance` strictly: every field's type, range and value, and any
 * key that is not one of ours - a 400 naming the field. `version` (which must be 1) and `updatedAt` are accepted so a
 * client can send back what it read; both are otherwise ignored, as is `background.imageVersion` matching the stored one
 * (see `applyAppearancePatch()`).
 */
export function validateAppearancePatch(body: unknown): AppearancePatch {
    if (!isPlainObject(body)) {
        throw invalid("The request body must be a JSON object.");
    }
    assertKnownKeys(body, ["version", "updatedAt", "mode", "colors", "background"], "");
    if (body.version !== undefined && body.version !== 1) {
        throw invalid("'version' must be 1.");
    }
    const patch: AppearancePatch = {};
    if (body.mode !== undefined) {
        patch.mode = oneOf(body.mode, APPEARANCE_MODES, "mode");
    }
    if (body.colors !== undefined) {
        if (body.colors === null) {
            patch.colors = null;
        } else if (isPlainObject(body.colors)) {
            assertKnownKeys(body.colors, APPEARANCE_COLOR_KEYS, "colors.");
            patch.colors = {};
            for (const key of APPEARANCE_COLOR_KEYS) {
                const value: unknown = body.colors[key];
                if (value !== undefined) {
                    patch.colors[key] = value === null ? null : hexColor(value, `colors.${key}`);
                }
            }
        } else {
            throw invalid("'colors' must be an object.");
        }
    }
    if (body.background !== undefined) {
        if (!isPlainObject(body.background)) {
            throw invalid("'background' must be an object.");
        }
        const source: Record<string, unknown> = body.background;
        assertKnownKeys(source, ["kind", "color", "imageVersion", "dim", "blur", "fit"], "background.");
        const background: NonNullable<AppearancePatch["background"]> = {};
        if (source.kind !== undefined) {
            background.kind = oneOf(source.kind, APPEARANCE_BACKGROUND_KINDS, "background.kind");
        }
        if (source.color !== undefined) {
            background.color = source.color === null ? null : hexColor(source.color, "background.color");
        }
        if (source.imageVersion !== undefined) {
            if (typeof source.imageVersion !== "string") {
                throw invalid("'background.imageVersion' must be a string.");
            }
            background.imageVersion = source.imageVersion;
        }
        if (source.dim !== undefined) {
            background.dim = rangedNumber(source.dim, "background.dim", APPEARANCE_MAX_DIM);
        }
        if (source.blur !== undefined) {
            background.blur = rangedNumber(source.blur, "background.blur", APPEARANCE_MAX_BLUR);
        }
        if (source.fit !== undefined) {
            background.fit = oneOf(source.fit, APPEARANCE_FITS, "background.fit");
        }
        patch.background = background;
    }
    return patch;
}

/**
 * The preferences after `patch` is merged into `current`: `colors` key by key (a `null` colour, or `null` for all of
 * them, goes back to the default), `background` key by key over the current one (or the default), the rest replaced.
 * Refuses (400) a background that could not be shown: `kind: "color"` with no colour, `kind: "image"` with nothing
 * uploaded, and an `imageVersion` that is not the uploaded one - a client cannot name an image, only upload one.
 */
export function applyAppearancePatch(current: AppearanceState, patch: AppearancePatch): AppearanceState {
    const next: AppearanceState = { ...current };
    if (patch.mode !== undefined) {
        next.mode = patch.mode;
    }
    if (patch.colors !== undefined) {
        const merged: Record<string, string> = patch.colors === null ? {} : { ...(current.colors ?? {}) };
        for (const [key, value] of Object.entries(patch.colors ?? {})) {
            if (value === null) {
                delete merged[key];
            } else {
                merged[key] = value;
            }
        }
        next.colors = Object.keys(merged).length > 0 ? merged : null;
    }
    if (patch.background !== undefined) {
        const base: AppearanceBackground = current.background ?? { ...DEFAULT_BACKGROUND };
        if (patch.background.imageVersion !== undefined && patch.background.imageVersion !== base.imageVersion) {
            throw invalid("'background.imageVersion' is set by uploading an image (POST /background), not by a client.");
        }
        const { color, imageVersion: _ignored, ...rest } = patch.background;
        const merged: AppearanceBackground = { ...base, ...rest };
        if (color === null) {
            delete merged.color;
        } else if (color !== undefined) {
            merged.color = color;
        }
        if (merged.kind === "color" && !merged.color) {
            throw invalid("'background.color' is required when 'background.kind' is \"color\".");
        }
        if (merged.kind === "image" && !merged.imageVersion) {
            throw invalid("'background.kind' can only be \"image\" once an image has been uploaded (POST /background).");
        }
        next.background = merged;
    }
    return next;
}

/** The wire shape of a saved row: empty `colors` and a missing `background` are left out. */
export function toPublicAppearance(row: AppearancePreferences): PublicAppearancePreferences {
    const updated: Date = new Date((row as any).dateModified ?? (row as any).dateCreated ?? 0);
    const result: PublicAppearancePreferences = {
        version: 1,
        mode: APPEARANCE_MODES.includes(row.mode) ? row.mode : "system",
        updatedAt: (Number.isNaN(updated.getTime()) ? new Date(0) : updated).toISOString(),
    };
    if (row.colors && Object.keys(row.colors).length > 0) {
        result.colors = { ...row.colors };
    }
    if (row.background) {
        result.background = { ...row.background };
    }
    return result;
}

/** The image types a background may be, keyed by the type each one's bytes are sniffed as. */
export const APPEARANCE_IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/avif"];

/**
 * The image type `bytes` really is, from its magic number - PNG, JPEG, WebP (a RIFF container) or AVIF (an ISO base media
 * file whose `ftyp` box names an `avif`/`avis` brand) - or `undefined` for anything else, SVG and GIF included. What a
 * client says in `Content-Type` decides nothing.
 */
export function sniffImageType(bytes: Buffer): string | undefined {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }
    if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") {
        return "image/webp";
    }
    if (bytes.length >= 16 && bytes.toString("latin1", 4, 8) === "ftyp") {
        const boxEnd: number = Math.min(bytes.readUInt32BE(0), bytes.length, 64);
        const brands: string[] = [bytes.toString("latin1", 8, 12)];
        for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
            brands.push(bytes.toString("latin1", offset, offset + 4));
        }
        if (brands.some((brand) => brand === "avif" || brand === "avis")) {
            return "image/avif";
        }
    }
    return undefined;
}
