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
