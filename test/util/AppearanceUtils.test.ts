///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { BaseAppearanceRoute, fetchAppearanceForSSR } from "../../src/routes/BaseAppearanceRoute.js";
import {
    appearanceImageKey,
    appearanceUid,
    applyAppearancePatch,
    defaultAppearance,
    sniffImageType,
    toPublicAppearance,
    validateAppearancePatch,
} from "../../src/util/AppearanceUtils.js";
import { AVIF, GIF, JPEG, PNG, SVG, WEBP } from "../routes/appearanceSuite.js";

describe("AppearanceUtils", () => {
    describe("sniffImageType()", () => {
        it("recognises PNG, JPEG, WebP and AVIF by their bytes", () => {
            expect(sniffImageType(PNG)).toBe("image/png");
            expect(sniffImageType(JPEG)).toBe("image/jpeg");
            expect(sniffImageType(WEBP)).toBe("image/webp");
            expect(sniffImageType(AVIF)).toBe("image/avif");
        });

        it("recognises an AVIF sequence and an AVIF named only as a compatible brand", () => {
            const sequence = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypavis"), Buffer.alloc(4), Buffer.from("avis")]);
            const compatible = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmif1"), Buffer.alloc(4), Buffer.from("avif")]);

            expect(sniffImageType(sequence)).toBe("image/avif");
            expect(sniffImageType(compatible)).toBe("image/avif");
        });

        it("refuses SVG, GIF, HEIC, other ISO media, a RIFF that is not WebP, and text", () => {
            const heic = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(4), Buffer.from("mif1")]);
            const wave = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEfmt ")]);

            for (const bytes of [SVG, GIF, heic, wave, Buffer.from("plain text"), Buffer.alloc(0), Buffer.from([0x89, 0x50])]) {
                expect(sniffImageType(bytes)).toBeUndefined();
            }
        });

        it("does not read a brand past the end of the ftyp box", () => {
            const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0x10]), Buffer.from("ftypmif1"), Buffer.alloc(4), Buffer.from("avif")]);

            expect(sniffImageType(bytes)).toBeUndefined();
        });
    });

    describe("validateAppearancePatch()", () => {
        it("keeps only what was sent, colours lowercased", () => {
            expect(validateAppearancePatch({ mode: "dark", colors: { primary: "#ABCDEF", text: null } })).toEqual({
                mode: "dark",
                colors: { primary: "#abcdef", text: null },
            });
            expect(validateAppearancePatch({ version: 1, updatedAt: "whenever" })).toEqual({});
        });

        it("accepts the ends of the dim and blur ranges", () => {
            expect(validateAppearancePatch({ background: { dim: 0, blur: 0 } }).background).toEqual({ dim: 0, blur: 0 });
            expect(validateAppearancePatch({ background: { dim: 0.8, blur: 20 } }).background).toEqual({ dim: 0.8, blur: 20 });
        });

        it("refuses infinities and NaN as out of range", () => {
            expect(() => validateAppearancePatch({ background: { dim: Number.POSITIVE_INFINITY } })).toThrow("'background.dim'");
            expect(() => validateAppearancePatch({ background: { blur: Number.NaN } })).toThrow("'background.blur'");
        });
    });

    describe("applyAppearancePatch()", () => {
        it("keeps a colour background's colour until it is set to null", () => {
            const current = { mode: "system" as const, background: { kind: "color" as const, color: "#112233", dim: 0, blur: 0, fit: "cover" as const } };

            expect(applyAppearancePatch(current, { background: { dim: 0.2 } }).background).toEqual({ ...current.background, dim: 0.2 });
            expect(applyAppearancePatch(current, { background: { kind: "none", color: null } }).background).toEqual({
                kind: "none",
                dim: 0,
                blur: 0,
                fit: "cover",
            });
        });

        it("leaves the current values alone for an empty patch", () => {
            const current = { mode: "dark" as const, colors: { primary: "#112233" } };

            expect(applyAppearancePatch(current, {})).toEqual(current);
        });
    });

    describe("toPublicAppearance()", () => {
        it("uses the entity's modification time, drops empty colours", () => {
            const modified = new Date("2026-09-21T10:00:00.000Z");

            expect(toPublicAppearance({ userUid: "u", mode: "dark", colors: {}, background: null, dateModified: modified } as any)).toEqual({
                version: 1,
                mode: "dark",
                updatedAt: "2026-09-21T10:00:00.000Z",
            });
        });

        it("falls back to the creation time, then the epoch, and to system for a mode it does not know", () => {
            const created = new Date("2026-09-20T10:00:00.000Z");

            expect(toPublicAppearance({ mode: "sepia", dateCreated: created } as any)).toMatchObject({ mode: "system", updatedAt: created.toISOString() });
            expect(toPublicAppearance({ mode: "light" } as any).updatedAt).toBe(new Date(0).toISOString());
            expect(toPublicAppearance({ mode: "light", dateModified: "not a date" } as any).updatedAt).toBe(new Date(0).toISOString());
        });

        it("returns copies, so a caller cannot change the row", () => {
            const row: any = { mode: "light", colors: { primary: "#112233" }, background: { kind: "none", dim: 0, blur: 0, fit: "cover" } };

            const result = toPublicAppearance(row);
            result.colors!.primary = "#000000";
            result.background!.dim = 0.5;

            expect(row.colors.primary).toBe("#112233");
            expect(row.background.dim).toBe(0);
        });
    });

    describe("keys and defaults", () => {
        it("derives one stable uid per user and a blob key from it", () => {
            expect(appearanceUid("alice")).toBe(appearanceUid("alice"));
            expect(appearanceUid("alice")).not.toBe(appearanceUid("bob"));
            expect(appearanceImageKey("alice", "v1")).toBe("appearance/alice/v1");
        });

        it("has defaults with the epoch as updatedAt", () => {
            expect(defaultAppearance()).toEqual({ version: 1, mode: "system", updatedAt: "1970-01-01T00:00:00.000Z" });
        });
    });

    describe("BaseAppearanceRoute", () => {
        it("refuses a caller whose token names no user, on every route, before touching anything", async () => {
            class Row {}
            class Route extends BaseAppearanceRoute<any> {
                protected appearanceClass: any = Row;
            }
            const route = new Route();
            const noUser: any = { roles: [] };

            await expect(route.get(noUser)).rejects.toMatchObject({ status: 403 });
            await expect(route.get(undefined)).rejects.toMatchObject({ status: 403 });
            await expect(route.update({ mode: "dark" }, noUser)).rejects.toMatchObject({ status: 403 });
            await expect(route.uploadBackground({ headers: {} } as any, noUser)).rejects.toMatchObject({ status: 403 });
            await expect(route.getBackground("v", {} as any, noUser)).rejects.toMatchObject({ status: 403 });
            await expect(route.deleteBackground(noUser)).rejects.toMatchObject({ status: 403 });
        });
    });

    describe("BaseAppearanceRoute writes", () => {
        it("retries a failed write from a fresh read, twice, then gives up and says why", async () => {
            class Route extends BaseAppearanceRoute<any> {
                protected appearanceClass: any = class Row {
                    constructor(public fields: any) {}
                };
            }
            const route: any = new Route();
            const debug = vi.fn();
            route.logger = { debug };
            route.repo = { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockRejectedValue(new Error("db down")) };

            await expect(route.update({ mode: "dark" }, { uid: "alice", roles: [] })).rejects.toThrow("db down");

            expect(route.repo.findOne).toHaveBeenCalledTimes(3);
            expect(route.repo.create).toHaveBeenCalledTimes(3);
            expect(debug).toHaveBeenCalledTimes(2);
        });
    });

    describe("fetchAppearanceForSSR()", () => {
        it("answers undefined without reading anything for a caller with no uid", async () => {
            const newInstance = vi.fn();

            expect(await fetchAppearanceForSSR({ newInstance } as any, class Row {}, undefined)).toBeUndefined();
            expect(newInstance).not.toHaveBeenCalled();
        });

        it("never fails the page: a failed read is logged at debug level and answers undefined", async () => {
            const debug = vi.fn();
            const objectFactory: any = { newInstance: vi.fn().mockRejectedValue(new Error("datastore is down")) };

            expect(await fetchAppearanceForSSR(objectFactory, class Row {}, "alice", { debug })).toBeUndefined();
            expect(debug).toHaveBeenCalledWith(expect.stringContaining("datastore is down"));
            expect(await fetchAppearanceForSSR(objectFactory, class Row {}, "alice")).toBeUndefined();
        });
    });
});
