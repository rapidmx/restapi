///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for what HTTP can't reach: the `@Init` hooks that build the DNS provider repositories (on `BaseDnsProviderRoute` and
// `BaseDomainRoute`), and a create whose row fails to save after its credentials were written. The routes themselves are tested over HTTP on both
// backends in test/routes/dnsProviderSuite.ts.
import { ApiError } from "@rapidrest/core";
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { BaseDnsProviderRoute } from "../../src/routes/BaseDnsProviderRoute.js";
import { BaseDomainRoute } from "../../src/routes/BaseDomainRoute.js";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { InMemorySecretStore } from "../testDoubles.js";

/** A uniquely named stand-in model class. */
function model(name: string): any {
    return { [name]: class {} }[name];
}

class TestDnsProviderRoute extends (BaseDnsProviderRoute as any) {
    protected dnsProviderClass: any = model("ProviderModel");
    protected domainClass: any = model("DomainModel");
    protected auditLogClass: any = model("AuditModel");
}

class TestDomainRoute extends (BaseDomainRoute as any) {
    protected auditLogClass: any = model("AuditModel");
    protected dnsProviderClass: any = model("ProviderModel");
}

function withFactory(route: any): any {
    const factory: any = { newInstance: vi.fn(async (type: any, opts: any) => ({ type, opts })) };
    Object.defineProperty(route, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

describe("BaseDnsProviderRoute initialize()", () => {
    it("throws when the objectFactory is not set", async () => {
        await expect((new TestDnsProviderRoute() as any).initialize()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds the provider, domain and audit repos, the audit service and the operation and controller-state repos once, and finds the publisher", async () => {
        const route: any = new TestDnsProviderRoute();
        route.dnsOperationClass = { name: "OperationModel" };
        route.dnsControllerStateClass = { name: "StateModel" };
        const factory = withFactory(route);
        await route.initialize();
        expect(factory.newInstance.mock.calls.map(([type, opts]: any) => [type, opts.name])).toEqual([
            [RepoUtils, "ProviderModel"],
            [RepoUtils, "DomainModel"],
            [RepoUtils, "AuditModel"],
            [AuditLogUtils, "AuditModel"],
            [RepoUtils, "OperationModel"],
            [RepoUtils, "StateModel"],
            ["DnsPublisher", "default"],
        ]);
        expect(factory.newInstance).toHaveBeenCalledWith(AuditLogUtils, { name: "AuditModel", args: [route.auditLogRepo] });
    });

    it("rebuilds nothing already set, and skips what has no model class", async () => {
        const preset: any = new TestDnsProviderRoute();
        const presetFactory = withFactory(preset);
        Object.assign(preset, { repo: {}, domainRepo: {}, auditLogRepo: {}, auditLogUtils: {}, dnsPublisher: {} });
        await preset.initialize();
        expect(presetFactory.newInstance).not.toHaveBeenCalled();

        const bare: any = new TestDnsProviderRoute();
        const bareFactory = withFactory(bare);
        Object.assign(bare, { dnsProviderClass: undefined, domainClass: undefined, auditLogClass: undefined, dnsPublisher: {} });
        await bare.initialize();
        expect(bareFactory.newInstance).not.toHaveBeenCalled();
    });
});

describe("BaseDomainRoute initDnsProviderRepo()", () => {
    it("throws when the objectFactory is not set", async () => {
        await expect((new TestDomainRoute() as any).initDnsProviderRepo()).rejects.toThrow("objectFactory is not set.");
    });

    it("leaves the domain route working when the provider model isn't registered, refusing only an assignment (503)", async () => {
        const route: any = new TestDomainRoute();
        Object.defineProperty(route, "_objectFactory", { value: { newInstance: vi.fn(async () => Promise.reject(new Error("No metadata for ProviderModel"))) } });
        const logger = { warn: vi.fn() };
        Object.defineProperty(route, "logger", { value: logger, configurable: true });
        await route.initDnsProviderRepo();
        expect(route.dnsProviderRepo).toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("No metadata for ProviderModel"));

        route.trustedRoles = ["admin"];
        route.repoUtils = { findOne: vi.fn(async () => ({ uid: "example.com", name: "example.com", version: 1 })) };
        const admin = { uid: "admin", roles: ["admin"], elevated: Date.now() };
        await expect(route.assignDnsProvider("example.com", { dnsProviderUid: "cf-x" }, {}, admin)).rejects.toMatchObject({ status: 503 });
    });

    it("builds the provider repo once, and skips it when set or without a model class", async () => {
        const route: any = new TestDomainRoute();
        const factory = withFactory(route);
        await route.initDnsProviderRepo();
        expect(factory.newInstance).toHaveBeenCalledWith(RepoUtils, { name: "ProviderModel", args: [route.dnsProviderClass] });
        await route.initDnsProviderRepo();
        expect(factory.newInstance).toHaveBeenCalledTimes(1);

        const bare: any = new TestDomainRoute();
        const bareFactory = withFactory(bare);
        bare.dnsProviderClass = undefined;
        await bare.initDnsProviderRepo();
        expect(bareFactory.newInstance).not.toHaveBeenCalled();
    });
});

describe("BaseDnsProviderRoute create() when the row can't be saved", () => {
    const admin: any = { uid: "admin", roles: ["admin"], elevated: Date.now() };

    function routeWith(store: InMemorySecretStore): any {
        const route: any = new TestDnsProviderRoute();
        route.dnsProviderClass = class {
            constructor(other: any) {
                Object.assign(this, other);
            }
        };
        route.secretStore = store;
        route.repo = { find: vi.fn(async () => []), create: vi.fn(async () => Promise.reject(new Error("datastore down"))) };
        route.auditLogUtils = { record: vi.fn() };
        return route;
    }

    it("removes the credentials it just wrote, so nothing is left that no row refers to", async () => {
        const store = new InMemorySecretStore();
        const route = routeWith(store);
        const body = { name: "CF", type: "cloudflare", zones: ["example.com"], options: { zoneIds: ["0123456789abcdef0123456789abcdef"] }, credentials: { apiToken: "t" } };
        await expect(route.create(body, {}, admin)).rejects.toThrow("datastore down");
        expect(store.secrets.size).toBe(0);
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("passes the failure on when it wrote no credentials", async () => {
        const store = new InMemorySecretStore();
        const route = routeWith(store);
        await expect(route.create({ name: "AWS", type: "route53", zones: ["example.com"], options: { region: "us-east-1" } }, {}, admin)).rejects.toThrow("datastore down");
        expect(route.repo.create).toHaveBeenCalledTimes(1);
    });
});

describe("BaseDnsProviderRoute toPublic()", () => {
    it("shows the controller's status when there is one, and no origin for a row that has none", () => {
        const route: any = new TestDnsProviderRoute();
        const row = { uid: "cf-x", name: "CF", type: "cloudflare", zones: ["example.com"], options: {}, enabled: true, allowTakeover: false, status: { readyReplicas: 1 }, version: 2 };
        const shown = route.toPublic(row, 3);
        expect(shown).toEqual(expect.objectContaining({ status: { readyReplicas: 1 }, domainCount: 3, credentials: {} }));
        expect(shown).not.toHaveProperty("origin");
    });
});

describe("BaseDnsProviderRoute update() and remove() around concurrent writes", () => {
    const admin: any = { uid: "admin", roles: ["admin"], elevated: Date.now() };
    const ZONE_ID = "0123456789abcdef0123456789abcdef";

    /**
     * A route over in-memory stand-ins for a Cloudflare config whose token is saved (generation 1). `reads(row)` are what the provider repo's `findOne()`
     * returns, call by call (the last one repeats); `updates` stand in for its `update()` calls in turn, after which a write succeeds.
     */
    async function setup(reads: (row: any) => any[], updates: ((obj: any) => Promise<any>)[] = []): Promise<any> {
        const store = new InMemorySecretStore();
        const secretRef = await store.write("dns/cf-x", { apiToken: "old-token" });
        const row: any = {
            uid: "cf-x",
            name: "CF",
            nameKey: "cf",
            type: "cloudflare",
            zones: ["example.com"],
            options: { zoneIds: [ZONE_ID] },
            secretRef,
            enabled: true,
            allowTakeover: false,
            version: 1,
        };
        const sequence: any[] = reads(row);
        const route: any = new TestDnsProviderRoute();
        const logger = { warn: vi.fn(), error: vi.fn() };
        Object.defineProperty(route, "logger", { value: logger, configurable: true });
        route.secretStore = store;
        route.repo = {
            findOne: vi.fn(async () => (sequence.length > 1 ? sequence.shift() : sequence[0])),
            find: vi.fn(async () => []),
            update: vi.fn(async (obj: any) => (updates.length > 0 ? await updates.shift()!(obj) : { ...row, ...obj, version: obj.version + 1 })),
        };
        route.domainRepo = { count: vi.fn(async () => 0), find: vi.fn(async () => []) };
        route.auditLogUtils = { record: vi.fn() };
        return { route, store, row, logger };
    }

    const lostRace = async (): Promise<never> => Promise.reject(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "lost"));
    const auditDetails = (route: any) => route.auditLogUtils.record.mock.calls.map(([entry]: any) => entry.details);
    const newToken = { credentials: { apiToken: "new-token-VALUE" } };

    it("refuses (409) with the store untouched when the row changed between its read and the store write", async () => {
        const { route, store } = await setup((row) => [row, { ...row, version: 2 }]);
        await expect(route.update("cf-x", newToken, {}, admin)).rejects.toMatchObject({ status: 409, code: ApiErrors.INVALID_OBJECT_VERSION });
        expect(store.secrets.get("dns/cf-x")).toEqual({ apiToken: "old-token" });
        expect(route.repo.update).not.toHaveBeenCalled();
    });

    it("passes a failed write on without an audit when no credentials changed", async () => {
        const { route } = await setup((row) => [row], [lostRace]);
        await expect(route.update("cf-x", { enabled: false }, {}, admin)).rejects.toMatchObject({ code: ApiErrors.INVALID_OBJECT_VERSION });
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("removes the credentials it just wrote when the row was deleted meanwhile", async () => {
        const { route, store } = await setup((row) => [row, row, undefined], [lostRace]);
        await expect(route.update("cf-x", newToken, {}, admin)).rejects.toMatchObject({ status: 409 });
        expect(store.secrets.has("dns/cf-x")).toBe(false);
        expect(auditDetails(route)[0]).toEqual(expect.objectContaining({ rowWriteFailed: true, rowMatchesStore: true }));
    });

    it("needs nothing more when the row was deleted meanwhile after every credential was cleared", async () => {
        const store = new InMemorySecretStore();
        const secretRef = await store.write("dns/aws-x", { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "s" });
        const row: any = { uid: "aws-x", name: "AWS", type: "route53", zones: ["example.com"], options: { region: "us-east-1", zoneType: "public" }, secretRef, enabled: true, allowTakeover: false, version: 1 };
        const reads: any[] = [row, row, undefined];
        const route: any = new TestDnsProviderRoute();
        route.secretStore = store;
        route.repo = { findOne: vi.fn(async () => reads.shift()), update: vi.fn(lostRace) };
        route.auditLogUtils = { record: vi.fn() };
        await expect(route.update("aws-x", { credentials: { accessKeyId: null, secretAccessKey: null } }, {}, admin)).rejects.toMatchObject({ status: 409 });
        expect(store.secrets.has("dns/aws-x")).toBe(false);
        expect(auditDetails(route)[0]).toEqual(expect.objectContaining({ rowMatchesStore: true }));
    });

    it("leaves a row that already points at the new credentials alone", async () => {
        const { route } = await setup((row) => [row, row, { ...row, version: 2, secretRef: { ...row.secretRef, generation: 2 } }], [lostRace]);
        await expect(route.update("cf-x", newToken, {}, admin)).rejects.toMatchObject({ status: 409 });
        expect(route.repo.update).toHaveBeenCalledTimes(1);
        expect(auditDetails(route)[0]).toEqual(expect.objectContaining({ rowMatchesStore: true }));
    });

    it("keeps a newer reference another credentials write saved meanwhile, and says the row may not match the store", async () => {
        const { route, logger, row } = await setup((row) => [row, row, { ...row, version: 2, secretRef: { ...row.secretRef, generation: 9 } }], [lostRace]);
        await expect(route.update("cf-x", newToken, {}, admin)).rejects.toMatchObject({ status: 409 });
        expect(route.repo.update).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(row.uid));
        expect(auditDetails(route)[0]).toEqual(expect.objectContaining({ rowWriteFailed: true, rowMatchesStore: false }));
    });

    it("saves its reference over an older generation another write saved before its own store write", async () => {
        const { route, store } = await setup((row) => [row, row, { ...row, version: 2, secretRef: { ...row.secretRef, generation: 2 } }], [lostRace]);
        // Another request patched the store first (generation 2) and saved that on the row; this one's patch is generation 3.
        store.duringChange = async () => {
            await store.write("dns/cf-x", { apiToken: "other-token" });
        };
        await expect(route.update("cf-x", newToken, {}, admin)).rejects.toMatchObject({ status: 409 });
        expect(route.repo.update).toHaveBeenCalledTimes(2);
        expect(route.repo.update.mock.calls[1][0]).toEqual(expect.objectContaining({ version: 2, secretRef: expect.objectContaining({ generation: 3 }) }));
        expect(auditDetails(route)[0]).toEqual(expect.objectContaining({ rowMatchesStore: true }));
    });

    it("logs, without the value, when the row can't be pointed at the new credentials either", async () => {
        const { route, logger } = await setup((row) => [row], [lostRace, async () => Promise.reject(new Error("datastore down"))]);
        await expect(route.update("cf-x", newToken, {}, admin)).rejects.toMatchObject({ code: ApiErrors.INVALID_OBJECT_VERSION });
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("datastore down"));
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain("new-token-VALUE");
        expect(auditDetails(route)[0]).toEqual(expect.objectContaining({ rowMatchesStore: false }));
    });

    it("still refuses a delete (409) when the assigned domains were reassigned between the count and the read", async () => {
        const { route } = await setup((row) => [row]);
        route.domainRepo.count = vi.fn(async () => 2);
        await expect(route.remove("cf-x", {}, admin)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("2 domain(s)") });
    });
});
