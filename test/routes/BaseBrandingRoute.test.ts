///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseBrandingRoute's private findOrCreate(), reserved for the TOCTOU race its own
// doc comment describes: RepoUtils.create()'s duplicate-uid guard is a count() pre-check, not an atomic
// constraint check, so two concurrent first-ever callers can both observe "no row yet" and both reach
// create() - the loser's create() throws a raw driver duplicate-key error rather than a clean conflict.
// Exercising the real race deterministically through the HTTP+DB test suite (test/routes/mongo/
// BrandingRoute.test.ts) would require actually winning a timing race against a second concurrent request,
// which isn't reliable - a mocked repo lets both the "a concurrent winner already committed" recovery path
// and the "still nothing there, a real failure" rethrow path be exercised directly and deterministically.
// Every other reachable behavior of this class is exercised via real HTTP+DB requests in
// test/routes/{mongo,sql}/BrandingRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseBrandingRoute, fetchBrandingPropsForSSR, readPublicBranding } from "../../src/routes/BaseBrandingRoute.js";

class TestBrandingRoute extends BaseBrandingRoute<any> {
    protected brandingClass: any = class {
        constructor(props: any) {
            Object.assign(this, props);
        }
    };
    protected auditLogClass: any = class {};
}

describe("BaseBrandingRoute Tests (findOrCreate() TOCTOU race only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("Returns the concurrent winner's row when create() throws a duplicate-key error but a row now exists.", async () => {
        const route = objectFactory.newInstance<TestBrandingRoute>(TestBrandingRoute, { initialize: false });
        const winner = { uid: "branding", companyName: "Acme", title: "Acme Mail" };
        (route as any).brandingRepo = {
            findOne: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner),
            create: vi.fn().mockRejectedValue(new Error("duplicate key")),
        };

        const result = await (route as any).findOrCreate();

        expect(result).toBe(winner);
    });

    it("Rethrows create()'s error when no row exists even after the race-recovery re-fetch (a real failure).", async () => {
        const route = objectFactory.newInstance<TestBrandingRoute>(TestBrandingRoute, { initialize: false });
        const error = new Error("connection reset");
        (route as any).brandingRepo = {
            findOne: vi.fn().mockResolvedValue(undefined),
            create: vi.fn().mockRejectedValue(error),
        };

        await expect((route as any).findOrCreate()).rejects.toThrow("connection reset");
    });
});

class TestBranding {}

describe("readPublicBranding() / fetchBrandingPropsForSSR() Tests (no route instance of their own - see doc comments)", () => {
    it("readPublicBranding() returns the all-empty defaults when no row exists yet.", async () => {
        const objectFactory: any = { newInstance: vi.fn().mockResolvedValue({ findOne: vi.fn().mockResolvedValue(undefined) }) };

        const result = await readPublicBranding(objectFactory, TestBranding);

        expect(result).toEqual({ companyName: "", title: "" });
    });

    it("readPublicBranding() maps an existing row into the public DTO, normalizing null to undefined.", async () => {
        const existing: any = {
            companyName: "Acme",
            title: "Acme Mail",
            logoUrl: "https://example.com/logo.png",
            iconUrl: null,
            stylesheetUrl: undefined,
            headerHtml: "<div>header</div>",
            footerHtml: null,
        };
        const objectFactory: any = { newInstance: vi.fn().mockResolvedValue({ findOne: vi.fn().mockResolvedValue(existing) }) };

        const result = await readPublicBranding(objectFactory, TestBranding);

        expect(result).toEqual({
            companyName: "Acme",
            title: "Acme Mail",
            logoUrl: "https://example.com/logo.png",
            iconUrl: undefined,
            stylesheetUrl: undefined,
            headerHtml: "<div>header</div>",
            footerHtml: undefined,
        });
    });

    it("fetchBrandingPropsForSSR() wraps a successful read in { branding }.", async () => {
        const objectFactory: any = { newInstance: vi.fn().mockResolvedValue({ findOne: vi.fn().mockResolvedValue(undefined) }) };

        const result = await fetchBrandingPropsForSSR(objectFactory, TestBranding);

        expect(result).toEqual({ branding: { companyName: "", title: "" } });
    });

    it("fetchBrandingPropsForSSR() falls back to empty branding instead of throwing when the read fails.", async () => {
        const objectFactory: any = { newInstance: vi.fn().mockRejectedValue(new Error("connection reset")) };

        const result = await fetchBrandingPropsForSSR(objectFactory, TestBranding);

        expect(result).toEqual({ branding: { companyName: "", title: "" } });
    });
});

describe("BaseBrandingRoute Tests (an asset's old blob is deleted only after the row stops naming it)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    const setup = (update: any) => {
        const route = objectFactory.newInstance<TestBrandingRoute>(TestBrandingRoute, { initialize: false });
        const existing = { uid: "branding", version: 3, logoUrl: "/branding/logo", logoBlobKey: "branding/logo/old", logoContentType: "image/png" };
        const blobStore = { put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) };
        (route as any).brandingRepo = { findOne: vi.fn().mockResolvedValue(existing), update };
        (route as any).blobStore = blobStore;
        (route as any).recordUpdate = vi.fn().mockResolvedValue(undefined);
        return { route: route as any, blobStore };
    };

    it("keeps the old blob when the update that would drop it fails, and deletes it once it succeeds.", async () => {
        const failing = setup(vi.fn().mockRejectedValue(new Error("conflict")));
        await expect(failing.route.update({ logoUrl: "https://example.com/logo.png" })).rejects.toThrow("conflict");
        expect(failing.blobStore.delete).not.toHaveBeenCalled();

        const working = setup(vi.fn().mockResolvedValue({ companyName: "", title: "" }));
        await working.route.update({ logoUrl: "https://example.com/logo.png" });
        expect(working.blobStore.delete).toHaveBeenCalledWith("branding/logo/old");
    });

    it("keeps the old blob and drops the new one when an upload's update fails, and deletes the old one once it succeeds.", async () => {
        const upload = (route: any) => route.uploadAsset(
            { headers: { "content-type": "image/png" }, rawBody: Buffer.from("png") },
            undefined,
            ["image/png"],
            { urlField: "logoUrl", blobKeyField: "logoBlobKey", contentTypeField: "logoContentType", keyPrefix: "branding/logo", path: "/branding/logo" },
        );
        const failing = setup(vi.fn().mockRejectedValue(new Error("conflict")));
        await expect(upload(failing.route)).rejects.toThrow("conflict");
        const newKey: string = failing.blobStore.put.mock.calls[0][0];
        expect(failing.blobStore.delete).toHaveBeenCalledTimes(1);
        expect(failing.blobStore.delete).toHaveBeenCalledWith(newKey);

        const working = setup(vi.fn().mockResolvedValue({ companyName: "", title: "" }));
        await upload(working.route);
        expect(working.blobStore.delete).toHaveBeenCalledTimes(1);
        expect(working.blobStore.delete).toHaveBeenCalledWith("branding/logo/old");
    });

    it("keeps the blob when the update that clears an asset fails, and deletes it once it succeeds.", async () => {
        const failing = setup(vi.fn().mockRejectedValue(new Error("conflict")));
        await expect(failing.route.deleteLogo(undefined)).rejects.toThrow("conflict");
        expect(failing.blobStore.delete).not.toHaveBeenCalled();

        const working = setup(vi.fn().mockResolvedValue({}));
        await working.route.deleteLogo(undefined);
        expect(working.blobStore.delete).toHaveBeenCalledWith("branding/logo/old");
    });
});

describe("BaseBrandingRoute update() URL validation", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("Refuses an asset URL that does not parse as a URL.", async () => {
        const route: any = objectFactory.newInstance<TestBrandingRoute>(TestBrandingRoute, { initialize: false });
        route.init = vi.fn().mockResolvedValue(undefined);
        route.findOrCreate = vi.fn().mockResolvedValue({ uid: "branding" });

        await expect(route.update({ logoUrl: "https://" }, { uid: "u1" })).rejects.toMatchObject({ status: 400 });
    });
});
