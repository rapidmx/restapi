///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for what HTTP can't reach: the `@Init` hooks that build the DNS provider repositories (on `BaseDnsProviderRoute` and
// `BaseDomainRoute`), and the credentials' encryption and the one row write of a create or update around concurrent writes. The routes themselves are
// tested over HTTP on both backends in test/routes/dnsProviderSuite.ts.
import { ApiError } from "@rapidrest/core";
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { BaseDnsProviderRoute } from "../../src/routes/BaseDnsProviderRoute.js";
import { BaseDomainRoute } from "../../src/routes/BaseDomainRoute.js";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";

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

/** A stand-in for `ConfigCipher` that seals a value as an envelope naming where it belongs, so a test can read both back without a keyring. */
function fakeCipher(): any {
    return {
        encrypt: vi.fn((value: string, context: any) => ({ $enc: 1, kid: "k1", iv: "iv", ct: `${context.record}/${context.uid}/${context.field}=${value}`, tag: "tag" })),
    };
}

describe("BaseDnsProviderRoute create() and its one row write", () => {
    const admin: any = { uid: "admin", roles: ["admin"], elevated: Date.now() };
    const cloudflare = { name: "CF", type: "cloudflare", zones: ["example.com"], options: { zoneIds: ["0123456789abcdef0123456789abcdef"] }, credentials: { apiToken: "t" } };

    function routeWith(createRow: (row: any) => Promise<any>): any {
        const route: any = new TestDnsProviderRoute();
        route.dnsProviderClass = class {
            constructor(other: any) {
                Object.assign(this, other);
            }
        };
        route.cipher = fakeCipher();
        route.repo = { find: vi.fn(async () => []), create: vi.fn(async (row: any) => createRow(row)) };
        route.auditLogUtils = { record: vi.fn() };
        route.dnsPublisher = { changed: vi.fn() };
        return route;
    }

    it("encrypts each credential for this row and field and saves them with the row in its one write, at generation 1", async () => {
        const route = routeWith(async (row) => ({ ...row, version: 1 }));
        const created = await route.create(cloudflare, {}, admin);
        expect(route.repo.create).toHaveBeenCalledTimes(1);
        const row = route.repo.create.mock.calls[0][0];
        expect(row.credentialsGeneration).toBe(1);
        expect(row.credentials).toEqual({ apiToken: expect.objectContaining({ $enc: 1, ct: `DnsProvider/${row.uid}/credentials.apiToken=t` }) });
        expect(row.secretRef).toBeUndefined();
        expect(created.credentials).toEqual({ apiToken: { secret: true } });
        expect(JSON.stringify(route.auditLogUtils.record.mock.calls)).not.toContain('"t"');
        expect(route.dnsPublisher.changed).toHaveBeenCalledWith({ scope: "provider", providerUid: row.uid });
    });

    it("saves no credentials and no generation for a config that needs none", async () => {
        const route = routeWith(async (row) => ({ ...row, version: 1 }));
        await route.create({ name: "AWS", type: "route53", zones: ["example.com"], options: { region: "us-east-1" } }, {}, admin);
        const row = route.repo.create.mock.calls[0][0];
        expect(row.credentials).toBeUndefined();
        expect(row.credentialsGeneration).toBeUndefined();
        expect(route.cipher.encrypt).not.toHaveBeenCalled();
    });

    it("refuses (503) without a keyring, before anything is saved, and says nothing of the value", async () => {
        const route = routeWith(async (row) => row);
        route.cipher.encrypt = vi.fn(() => {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "No configuration keyring is loaded, so secrets can't be saved.");
        });
        await expect(route.create(cloudflare, {}, admin)).rejects.toMatchObject({ status: 503 });
        expect(route.repo.create).not.toHaveBeenCalled();
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("passes a failed write on with nothing to clean up: no audit, no notice", async () => {
        const route = routeWith(async () => Promise.reject(new Error("datastore down")));
        await expect(route.create(cloudflare, {}, admin)).rejects.toThrow("datastore down");
        expect(route.repo.create).toHaveBeenCalledTimes(1);
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
        expect(route.dnsPublisher.changed).not.toHaveBeenCalled();
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

    it("shows each saved credential as the mask and nothing of the envelope, whether the row has none, cleared them or holds some", () => {
        const route: any = new TestDnsProviderRoute();
        const envelope = { $enc: 1, kid: "k1", iv: "iv", ct: "SECRET-CIPHERTEXT", tag: "tag" };
        const row = (credentials: any) => ({ uid: "aws-x", name: "AWS", type: "route53", zones: ["example.com"], options: {}, enabled: true, allowTakeover: false, credentials, credentialsGeneration: 2, version: 2 });
        expect(route.toPublic(row({ accessKeyId: envelope, secretAccessKey: envelope }), 0).credentials).toEqual({ accessKeyId: { secret: true }, secretAccessKey: { secret: true } });
        expect(route.toPublic(row(null), 0).credentials).toEqual({});
        expect(route.toPublic(row(undefined), 0).credentials).toEqual({});
        const shown = route.toPublic(row({ accessKeyId: envelope }), 0);
        expect(JSON.stringify(shown)).not.toContain("SECRET-CIPHERTEXT");
        expect(shown).not.toHaveProperty("credentialsGeneration");
    });
});

describe("BaseDnsProviderRoute update() and remove() around concurrent writes", () => {
    const admin: any = { uid: "admin", roles: ["admin"], elevated: Date.now() };
    const ZONE_ID = "0123456789abcdef0123456789abcdef";

    /**
     * A route over in-memory stand-ins for a Cloudflare config whose token is saved (generation 1). `updates` stand in for the provider repo's `update()`
     * calls in turn, after which a write succeeds.
     */
    function setup(updates: ((obj: any) => Promise<any>)[] = []): any {
        const row: any = {
            uid: "cf-x",
            name: "CF",
            nameKey: "cf",
            type: "cloudflare",
            zones: ["example.com"],
            options: { zoneIds: [ZONE_ID] },
            credentials: { apiToken: { $enc: 1, kid: "k1", iv: "iv", ct: "old", tag: "tag" } },
            credentialsGeneration: 1,
            enabled: true,
            allowTakeover: false,
            version: 1,
        };
        const route: any = new TestDnsProviderRoute();
        const logger = { warn: vi.fn(), error: vi.fn() };
        Object.defineProperty(route, "logger", { value: logger, configurable: true });
        route.cipher = fakeCipher();
        route.repo = {
            findOne: vi.fn(async () => row),
            find: vi.fn(async () => []),
            update: vi.fn(async (obj: any) => (updates.length > 0 ? await updates.shift()!(obj) : { ...row, ...obj, version: obj.version + 1 })),
        };
        route.domainRepo = { count: vi.fn(async () => 0), find: vi.fn(async () => []) };
        route.auditLogUtils = { record: vi.fn() };
        route.dnsPublisher = { changed: vi.fn() };
        return { route, row, logger };
    }

    const lostRace = async (): Promise<never> => Promise.reject(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "lost"));
    const newToken = { credentials: { apiToken: "new-token-VALUE" } };

    it("saves the new credentials, their generation and the rest of the change in one write against the version it read", async () => {
        const { route, row } = setup();
        await route.update("cf-x", { ...newToken, name: "Renamed" }, {}, admin);
        expect(route.repo.update).toHaveBeenCalledTimes(1);
        const [saved, existing, options] = route.repo.update.mock.calls[0];
        expect(saved).toEqual(
            expect.objectContaining({
                uid: "cf-x",
                version: 1,
                name: "Renamed",
                credentialsGeneration: 2,
                credentials: { apiToken: expect.objectContaining({ ct: "DnsProvider/cf-x/credentials.apiToken=new-token-VALUE" }) },
            }),
        );
        expect(existing).toBe(row);
        expect(options).toEqual(expect.objectContaining({ version: 1 }));
        expect(route.dnsPublisher.changed).toHaveBeenCalledTimes(1);
    });

    it("saves null once every credential was cleared", async () => {
        const { route, row } = setup();
        const envelope = row.credentials.apiToken;
        Object.assign(row, { type: "route53", options: { region: "us-east-1", zoneType: "public" }, credentials: { accessKeyId: envelope, secretAccessKey: envelope } });
        await route.update("cf-x", { credentials: { accessKeyId: null, secretAccessKey: null } }, {}, admin);
        expect(route.repo.update.mock.calls[0][0]).toEqual(expect.objectContaining({ credentials: null, credentialsGeneration: 2 }));
    });

    it("starts at generation 1 for a row that never had credentials", async () => {
        const { route, row } = setup();
        delete row.credentialsGeneration;
        delete row.credentials;
        await route.update("cf-x", newToken, {}, admin);
        expect(route.repo.update.mock.calls[0][0].credentialsGeneration).toBe(1);
    });

    it("refuses (409) with nothing audited or announced when the row changed since it was read, the credentials included", async () => {
        const { route } = setup([lostRace]);
        await expect(route.update("cf-x", newToken, {}, admin)).rejects.toMatchObject({ status: 409, code: ApiErrors.INVALID_OBJECT_VERSION });
        // One write, no second attempt to make the row match anything, nothing to undo.
        expect(route.repo.update).toHaveBeenCalledTimes(1);
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
        expect(route.dnsPublisher.changed).not.toHaveBeenCalled();
    });

    it("refuses (409) before encrypting anything when the request names an older version", async () => {
        const { route } = setup();
        await expect(route.update("cf-x", { ...newToken, version: 0 }, {}, admin)).rejects.toMatchObject({ status: 409, code: ApiErrors.INVALID_OBJECT_VERSION });
        expect(route.cipher.encrypt).not.toHaveBeenCalled();
        expect(route.repo.update).not.toHaveBeenCalled();
    });

    it("refuses (503) without a keyring, before anything is written", async () => {
        const { route } = setup();
        route.cipher.encrypt = vi.fn(() => {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "No configuration keyring is loaded, so secrets can't be saved.");
        });
        await expect(route.update("cf-x", newToken, {}, admin)).rejects.toMatchObject({ status: 503 });
        expect(route.repo.update).not.toHaveBeenCalled();
    });

    it("passes any other failed write on without an audit", async () => {
        const { route } = setup([async () => Promise.reject(new Error("datastore down"))]);
        await expect(route.update("cf-x", { enabled: false }, {}, admin)).rejects.toThrow("datastore down");
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("maps a name another config took meanwhile, caught by the unique index, to the same 409 as the name check", async () => {
        const { route } = setup([async () => Promise.reject(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }))]);
        await expect(route.update("cf-x", { name: "Taken" }, {}, admin)).rejects.toMatchObject({ status: 409, code: ApiErrors.IDENTIFIER_EXISTS });
    });

    it("still refuses a delete (409) when the assigned domains were reassigned between the count and the read", async () => {
        const { route } = setup();
        route.domainRepo.count = vi.fn(async () => 2);
        await expect(route.remove("cf-x", {}, admin)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("2 domain(s)") });
    });

    it("deletes the row alone: its credentials are in it", async () => {
        const { route } = setup();
        route.repo.delete = vi.fn(async () => undefined);
        await route.remove("cf-x", {}, admin);
        expect(route.repo.delete).toHaveBeenCalledTimes(1);
        expect(route.auditLogUtils.record.mock.calls[0][0].details).toEqual({ name: "CF", type: "cloudflare" });
    });
});

describe("BaseDnsProviderRoute without a ConfigCipher, and patchCredentials()", () => {
    const admin: any = { uid: "admin", roles: ["admin"], elevated: Date.now() };
    const envelope = (ct: string) => ({ $enc: 1 as const, kid: "k1", iv: "aXY=", ct, tag: "dGFn" });

    function routeWithRow(row: any): any {
        const route: any = new TestDnsProviderRoute();
        route.repo = { findOne: vi.fn(async () => row), find: vi.fn(async () => []), create: vi.fn(), update: vi.fn() };
        route.domainRepo = { count: vi.fn(async () => 0), find: vi.fn(async () => []) };
        route.auditLogUtils = { record: vi.fn() };
        route.cipher = undefined;
        return route;
    }
    const cloudflare = { name: "CF", type: "cloudflare", zones: ["example.com"], options: { zoneIds: ["0123456789abcdef0123456789abcdef"] } };
    const row = { uid: "cf-x", name: "CF", nameKey: "cf", type: "cloudflare", zones: ["example.com"], options: { zoneIds: ["0123456789abcdef0123456789abcdef"] }, credentials: { apiToken: envelope("old") }, enabled: true, allowTakeover: false, version: 1 };

    it("refuses (503) to save a credential, changing nothing, but needs no cipher for a config without or a change of anything else", async () => {
        const route = routeWithRow(row);
        await expect(route.create({ ...cloudflare, credentials: { apiToken: "t" } }, {}, admin)).rejects.toMatchObject({ status: 503 });
        await expect(route.update("cf-x", { credentials: { apiToken: "new" } }, {}, admin)).rejects.toMatchObject({ status: 503 });
        expect(route.repo.create).not.toHaveBeenCalled();
        expect(route.repo.update).not.toHaveBeenCalled();

        const bare = routeWithRow(row);
        bare.repo.create = vi.fn(async (created: any) => created);
        bare.dnsProviderClass = class {
            constructor(other: any) {
                Object.assign(this, other);
            }
        };
        bare.dnsPublisher = { changed: vi.fn() };
        await bare.create({ name: "AWS", type: "route53", zones: ["example.org"], options: { region: "us-east-1" } }, {}, admin);
        expect(bare.repo.create).toHaveBeenCalledTimes(1);
        // Renaming, or clearing the last credential, encrypts nothing.
        bare.repo.update = vi.fn(async (obj: any) => ({ ...row, ...obj, version: 2 }));
        bare.dnsPublisher = { changed: vi.fn() };
        await bare.update("cf-x", { enabled: false }, {}, admin);
        expect(bare.repo.update).toHaveBeenCalledTimes(1);
    });

    it("keeps the credentials not mentioned, removes those sent as null and encrypts the new ones", () => {
        const route = routeWithRow(row);
        route.cipher = { encrypt: vi.fn((value: string) => envelope(`new-${value}`)) };
        const existing = { uid: "x", credentials: { a: envelope("a"), b: envelope("b"), c: envelope("c") } };
        expect(route.patchCredentials(existing, { b: null, c: "C2", d: "D" })).toEqual({ a: envelope("a"), c: envelope("new-C2"), d: envelope("new-D") });
        // Only removals: nothing is encrypted, so no cipher is needed.
        route.cipher = undefined;
        expect(route.patchCredentials(existing, { a: null })).toEqual({ b: envelope("b"), c: envelope("c") });
    });
});
