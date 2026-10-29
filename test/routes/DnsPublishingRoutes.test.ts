///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for what HTTP can't reach in DNS publishing: the `@Init` hooks on a server that registers no model, publisher or token verifier,
// the best-effort writes of the controller's reports when they fail, and the status writes skipped because nothing changed. The routes themselves are
// tested over HTTP on both backends in test/routes/dnsPublishingSuite.ts.
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { NullDnsPublisher } from "../../src/dns/NullDnsPublisher.js";
import { ConfigSecretUnavailableError } from "../../src/secrets/ConfigCipher.js";
import { BaseDnsDesiredStateRoute } from "../../src/routes/BaseDnsDesiredStateRoute.js";
import { BaseDnsProviderRoute } from "../../src/routes/BaseDnsProviderRoute.js";
import { BaseDomainRoute } from "../../src/routes/BaseDomainRoute.js";
import { findDnsOwnerId, liveRecordValues, queueDnsOperation } from "../../src/util/DnsPublishingUtils.js";
import { StaticDnsResolver } from "../testDoubles.js";

function model(name: string): any {
    return { [name]: class {} }[name];
}

class TestDesiredStateRoute extends (BaseDnsDesiredStateRoute as any) {
    protected dnsProviderClass: any = model("ProviderModel");
    protected domainClass: any = model("DomainModel");
    protected dnsOperationClass: any = model("OperationModel");
    protected deploymentIdentityClass: any = model("IdentityModel");
    protected dnsControllerStateClass: any = model("StateModel");
}

class TestDomainRoute extends (BaseDomainRoute as any) {
    protected auditLogClass: any = model("AuditModel");
    protected dnsProviderClass: any = model("ProviderModel");
}

class TestDnsProviderRoute extends (BaseDnsProviderRoute as any) {
    protected dnsProviderClass: any = model("ProviderModel");
    protected domainClass: any = model("DomainModel");
    protected auditLogClass: any = model("AuditModel");
}

function withFactory(route: any, newInstance: (type: any, opts: any) => any = async (type, opts) => ({ type, opts })): any {
    const factory: any = { newInstance: vi.fn(newInstance) };
    Object.defineProperty(route, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

function withLogger(route: any): any {
    const logger = { warn: vi.fn(), error: vi.fn() };
    Object.defineProperty(route, "logger", { value: logger, configurable: true, writable: true });
    return logger;
}

const admin: any = { uid: "admin", roles: ["admin"], elevated: Date.now() };

describe("BaseDnsDesiredStateRoute", () => {
    it("throws on initialize() without an objectFactory", async () => {
        await expect((new TestDesiredStateRoute() as any).initialize()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds its repos, the token verifier and the publisher once", async () => {
        const route: any = new TestDesiredStateRoute();
        const factory = withFactory(route);
        await route.initialize();
        expect(factory.newInstance.mock.calls.map(([type, opts]: any) => [type === RepoUtils ? "RepoUtils" : type, opts.name])).toEqual([
            ["RepoUtils", "ProviderModel"],
            ["RepoUtils", "DomainModel"],
            ["RepoUtils", "OperationModel"],
            ["RepoUtils", "IdentityModel"],
            ["RepoUtils", "StateModel"],
            ["DnsControllerTokenVerifier", "default"],
            ["DnsPublisher", "default"],
        ]);
        await route.initialize();
        expect(factory.newInstance).toHaveBeenCalledTimes(7);

        const bare: any = new TestDesiredStateRoute();
        Object.assign(bare, { dnsProviderClass: undefined, domainClass: undefined, dnsOperationClass: undefined, deploymentIdentityClass: undefined, dnsControllerStateClass: undefined });
        const bareFactory = withFactory(bare);
        await bare.initialize();
        expect(bareFactory.newInstance).toHaveBeenCalledTimes(2);
    });

    it("refuses every call, with a warning, on a server that registers no token verifier", async () => {
        const route: any = new TestDesiredStateRoute();
        const logger = withLogger(route);
        withFactory(route, async (type: any) => {
            if (typeof type === "string") {
                throw new Error(`No class found with name: ${type}`);
            }
            return {};
        });
        await route.initialize();
        expect(route.tokenVerifier).toBeUndefined();
        expect(route.dnsPublisher).toBeInstanceOf(NullDnsPublisher);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("DnsControllerTokenVerifier"));
        route.controllerSubject = "system:serviceaccount:mail:mail-dns-controller";
        await expect(route.authorize({ headers: { authorization: "Bearer t" } })).rejects.toMatchObject({ status: 403 });
    });

    it("records what the controller said only where it can, logging a failed write", async () => {
        const route: any = new TestDesiredStateRoute();
        const logger = withLogger(route);
        await expect(route.recordControllerState({ handshake: null })).resolves.toBeUndefined();

        route.controllerStateRepo = { findOne: vi.fn(async () => ({ uid: "dns-controller", version: 1 })), update: vi.fn(async () => Promise.reject(new Error("version conflict"))) };
        await expect(route.recordControllerState({ handshake: null })).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("version conflict"));
    });

    it("logs the invalid hosts and refused addresses of its configuration once", () => {
        const route: any = new TestDesiredStateRoute();
        const logger = withLogger(route);
        route.publishHosts = [{ name: "bad name", type: "address" }, { name: "ok.example.com", type: "cname" }, { name: "x", type: "mx" }];
        route.publicAddresses = ["10.0.0.1"];
        expect(route.publishConfig()).toEqual({ hosts: [{ name: "ok.example.com", type: "cname" }], addresses: [] });
        route.publishConfig();
        expect(logger.warn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("2 entries of mail:dns:publish:hosts"));

        const one: any = new TestDesiredStateRoute();
        const oneLogger = withLogger(one);
        one.publishHosts = [{ name: "bad name", type: "address" }];
        one.publicAddresses = [];
        one.publishConfig();
        expect(oneLogger.warn).toHaveBeenCalledWith(expect.stringContaining("1 entry of"));
    });

    it("logs, without failing the report, a status it could not write", async () => {
        const route: any = new TestDesiredStateRoute();
        const logger = withLogger(route);
        await route.bestEffort("domain 'x'", async () => Promise.reject(new Error("row is gone")));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("row is gone"));
    });

    it("skips writes that would change nothing: a provider status reported again soon, an endpoint not reported, an operation already so", async () => {
        const route: any = new TestDesiredStateRoute();
        const now = new Date();
        const status = { reportedAt: new Date(now.getTime() - 60_000), readyReplicas: 1 };
        route.providerRepo = { findOne: vi.fn(async () => ({ uid: "p", version: 1, status })), update: vi.fn() };
        await route.applyProviderStatus({ providers: [{ providerUid: "p", readyReplicas: 1 }] }, now);
        expect(route.providerRepo.update).not.toHaveBeenCalled();
        // The same status five minutes on is written again, so the console sees the controller is alive.
        await route.applyProviderStatus({ providers: [{ providerUid: "p", readyReplicas: 1 }] }, new Date(now.getTime() + 5 * 60_000));
        expect(route.providerRepo.update).toHaveBeenCalledTimes(1);

        route.domainRepo = { find: vi.fn(async () => [{ uid: "a.com", dnsProviderUid: "p", version: 1 }, { uid: "b.com", version: 1 }]), update: vi.fn() };
        await route.applyEndpointStatus({ endpoints: [{ endpointSetId: "domain-c-com", generation: 1 }, { endpointSetId: "domain-b-com", generation: 1 }] }, now);
        expect(route.domainRepo.update).not.toHaveBeenCalled();

        route.operationRepo = { findOne: vi.fn(async () => ({ uid: "o", version: 1, state: "running", startedAt: now })), update: vi.fn() };
        await route.applyOperationStatus({ operations: [{ id: "o", state: "running" }] }, now);
        expect(route.operationRepo.update).not.toHaveBeenCalled();
        await route.applyOperationStatus({ operations: [{ id: "o", state: "running", message: "pulling the image" }] }, now);
        expect(route.operationRepo.update).toHaveBeenCalledWith(expect.objectContaining({ uid: "o", message: "pulling the image" }), expect.anything(), expect.anything());
    });
});

describe("BaseDomainRoute DNS publishing", () => {
    it("throws on initDnsPublishing() without an objectFactory", async () => {
        await expect((new TestDomainRoute() as any).initDnsPublishing()).rejects.toThrow("objectFactory is not set.");
    });

    it("still serves domains when the operation and identity models aren't registered", async () => {
        const route: any = new TestDomainRoute();
        route.dnsOperationClass = model("OperationModel");
        route.deploymentIdentityClass = model("IdentityModel");
        const logger = withLogger(route);
        withFactory(route, async (type: any, opts: any) => {
            if (type === RepoUtils) {
                throw new Error(`No metadata for ${opts.name}`);
            }
            return new NullDnsPublisher();
        });
        await route.initDnsPublishing();
        expect(route.dnsOperationRepo).toBeUndefined();
        expect(route.deploymentIdentityRepo).toBeUndefined();
        expect(route.dnsPublisher).toBeInstanceOf(NullDnsPublisher);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("No metadata for OperationModel"));

        // Opting into apex TXT management needs the operations queue.
        route.trustedRoles = ["admin"];
        route.repoUtils = { findOne: vi.fn(async () => ({ uid: "example.com", name: "example.com", version: 1, dnsProviderUid: "p" })) };
        route.dnsProviderRepo = { findOne: vi.fn(async () => ({ uid: "p", type: "cloudflare", zones: ["example.com"] })) };
        await expect(route.updateApexTxt("example.com", { managed: true, keep: [] }, {}, admin)).rejects.toMatchObject({ status: 503 });
    });

    /** A domain route over mocked repositories, holding one managed domain, whose row writes fail. */
    function managedDomainRoute(): any {
        const route: any = new TestDomainRoute();
        route.trustedRoles = ["admin"];
        route.elevationMaxAgeSeconds = 0;
        route.publishTtlSeconds = 300;
        const domain = { uid: "example.com", name: "example.com", version: 1, dnsProviderUid: "p", apexTxt: { managed: true, keep: ["ms=1"], spf: "v=spf1 mx ~all" } };
        route.repoUtils = {
            findOne: vi.fn(async () => domain),
            find: vi.fn(async () => []),
            delete: vi.fn(async () => Promise.reject(new Error("datastore down"))),
            update: vi.fn(async () => Promise.reject(new Error("datastore down"))),
        };
        route.dnsProviderRepo = { findOne: vi.fn(async () => ({ uid: "p", type: "cloudflare", zones: ["example.com"] })) };
        route.dnsOperationRepo = { create: vi.fn(async (row: any) => ({ ...row, version: 1 })), update: vi.fn(async () => ({})) };
        route.dnsOperationClass = class {
            constructor(other: any) {
                Object.assign(this, other);
            }
        };
        route.auditLogUtils = { record: vi.fn() };
        return route;
    }

    it("queues the restore before a managed domain is deleted, and cancels it when the delete then fails", async () => {
        const route = managedDomainRoute();
        await expect(route.delete("example.com", undefined, undefined, {}, admin)).rejects.toThrow("datastore down");
        const [queued] = route.dnsOperationRepo.create.mock.calls[0];
        expect(queued).toMatchObject({ type: "restore", records: [{ dnsName: "example.com", recordType: "TXT", targets: ["v=spf1 mx ~all", "ms=1"], ttl: 300 }] });
        expect(route.dnsOperationRepo.update).toHaveBeenCalledWith(
            expect.objectContaining({ uid: queued.uid, state: "failed", message: "Cancelled: the domain's deletion that queued it failed." }),
            expect.anything(),
            expect.anything(),
        );
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("cancels the restore an opt-out queued when its save fails, logging a cancellation that fails too", async () => {
        const route = managedDomainRoute();
        const logger = withLogger(route);
        route.dnsOperationRepo.update = vi.fn(async () => Promise.reject(new Error("still down")));
        await expect(route.updateApexTxt("example.com", { managed: false }, {}, admin)).rejects.toThrow("datastore down");
        expect(route.dnsOperationRepo.create).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("could not be cancelled after the opt-out that queued it failed: still down"));
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("fails a delete of a domain without a managed apex TXT set with its own error, nothing queued", async () => {
        const route = managedDomainRoute();
        route.repoUtils.findOne = vi.fn(async () => ({ uid: "plain.com", name: "plain.com", version: 1 }));
        await expect(route.delete("plain.com", undefined, undefined, {}, admin)).rejects.toThrow("datastore down");
        expect(route.dnsOperationRepo.create).not.toHaveBeenCalled();
        expect(route.dnsOperationRepo.update).not.toHaveBeenCalled();
    });

    it("restores nothing without a value or a provider, and with the configured TTL when the provider is gone", async () => {
        const route = managedDomainRoute();
        expect(await route.queueApexTxtRestore({ uid: "a.com", name: "a.com", dnsProviderUid: "p", apexTxt: { managed: true, keep: [] } })).toBeUndefined();
        expect(await route.queueApexTxtRestore({ uid: "a.com", name: "a.com", apexTxt: { managed: true, keep: ["ms=1"], spf: "v=spf1 mx ~all" } })).toBeUndefined();
        route.publishTtlSeconds = 60;
        route.dnsProviderRepo.findOne = vi.fn(async () => undefined);
        const restore = await route.queueApexTxtRestore({ uid: "a.com", name: "a.com", dnsProviderUid: "gone", apexTxt: { managed: true, keep: ["ms=1"] } });
        expect(restore.records).toEqual([{ dnsName: "a.com", recordType: "TXT", targets: ["ms=1"], ttl: 60 }]);
    });

    it("refuses to release a managed apex TXT set on a server without the operations model, rather than lose its values", async () => {
        const route = managedDomainRoute();
        route.dnsOperationRepo = undefined;
        await expect(route.updateApexTxt("example.com", { managed: false }, {}, admin)).rejects.toMatchObject({ status: 503 });
        await expect(route.delete("example.com", undefined, undefined, {}, admin)).rejects.toMatchObject({ status: 503 });
        expect(route.repoUtils.update).not.toHaveBeenCalled();
        expect(route.repoUtils.delete).not.toHaveBeenCalled();
    });

    it("still answers the checklist when the provider config can't be read", async () => {
        const route: any = new TestDomainRoute();
        route.repoUtils = { findOne: vi.fn(async () => ({ uid: "example.com", name: "example.com", verificationToken: "t", dkimSelector: "s", dkimPublicKey: "k", dnsProviderUid: "p" })) };
        route.dnsProviderRepo = { findOne: vi.fn(async () => Promise.reject(new Error("datastore down"))) };
        route.dnsResolver = { resolveTxt: vi.fn(async () => Promise.reject(new Error("NXDOMAIN"))), resolveMx: vi.fn(async () => []), resolveCname: vi.fn(async () => []) };
        route.mxHostname = "";
        route.autodiscoverPublicUrl = "";
        const checks = await route.dnsSetup("example.com");
        expect(checks.find((c: any) => c.type === "dmarc")).toMatchObject({ publication: "manual", manualReason: "no_provider" });
    });
});

describe("BaseDnsProviderRoute operations", () => {
    it("answers 503 for an operation on a server that doesn't register the model", async () => {
        const route: any = new TestDnsProviderRoute();
        route.trustedRoles = ["admin"];
        route.repo = { findOne: vi.fn(async () => ({ uid: "p", name: "P" })) };
        await expect(route.test("p", {}, admin)).rejects.toMatchObject({ status: 503 });
    });

    it("has no pending operations without the model, and logs an operation it could not cancel", async () => {
        const route: any = new TestDnsProviderRoute();
        expect(await route.pendingOperations("p")).toEqual([]);
        const logger = withLogger(route);
        route.operationRepo = { update: vi.fn(async () => Promise.reject(new Error("row is gone"))) };
        await route.cancelOperation({ uid: "o", version: 1 }, "the DNS provider config was deleted");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Could not cancel the DNS operation 'o' after the DNS provider config was deleted: row is gone"));
    });

    it("reads the live values of every record kind for the audit entry, none when the lookup fails", async () => {
        const resolver: any = {
            resolveSrv: vi.fn(async () => [{ priority: 0, weight: 5, port: 443, target: "old.example.net" }]),
            resolveMx: vi.fn(async () => [{ priority: 5, exchange: "mx.old.example.net" }]),
            resolveTxt: vi.fn(async () => [["v=DMARC1; ", "p=none;"]]),
            resolveCname: vi.fn(async () => Promise.reject(new Error("NXDOMAIN"))),
        };
        expect(await liveRecordValues(resolver, { dnsName: "_autodiscover._tcp.example.com", recordType: "SRV" })).toEqual(["0 5 443 old.example.net"]);
        expect(await liveRecordValues(resolver, { dnsName: "example.com", recordType: "MX" })).toEqual(["5 mx.old.example.net"]);
        expect(await liveRecordValues(resolver, { dnsName: "_dmarc.example.com", recordType: "TXT" })).toEqual(["v=DMARC1; p=none;"]);
        expect(await liveRecordValues(resolver, { dnsName: "openpgpkey.example.com", recordType: "CNAME" })).toEqual([]);
        // A resolver that can't look addresses up knows none; one that can gives each family its own.
        expect(await liveRecordValues(resolver, { dnsName: "mail.example.com", recordType: "NS" as any })).toEqual([]);
        expect(await liveRecordValues(resolver, { dnsName: "mail.example.com", recordType: "A" })).toEqual([]);
        resolver.resolveAddresses = vi.fn(async () => ["198.51.100.9", "2001:db8::9"]);
        expect(await liveRecordValues(resolver, { dnsName: "mail.example.com", recordType: "A" })).toEqual(["198.51.100.9"]);
        expect(await liveRecordValues(resolver, { dnsName: "mail.example.com", recordType: "AAAA" })).toEqual(["2001:db8::9"]);
        resolver.resolveAddresses = vi.fn(async () => Promise.reject(new Error("NXDOMAIN")));
        expect(await liveRecordValues(resolver, { dnsName: "mail.example.com", recordType: "A" })).toEqual([]);
    });
});

describe("DnsPublishingUtils", () => {
    it("has no owner id without an identity repository or when the identity can't be read", async () => {
        expect(await findDnsOwnerId(undefined)).toBeUndefined();
        const logger = { error: vi.fn() };
        expect(await findDnsOwnerId({ findOne: vi.fn(async () => ({ uid: "deployment-identity", installationId: "BAD" })) } as any, logger)).toBeUndefined();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("malformed"));
        expect(await findDnsOwnerId({ findOne: vi.fn(async () => ({ uid: "deployment-identity", installationId: "abcdefghijklmnop" })) } as any)).toBe("rapidmx-abcdefghijklmnop");
    });

    it("queues an operation without the fields left unset", async () => {
        const repo = { create: vi.fn(async (row: any) => row) };
        const Operation = class {
            constructor(other: any) {
                Object.assign(this, other);
            }
        };
        const queued: any = await queueDnsOperation(repo as any, Operation, { type: "test", providerUid: "p", domainUid: undefined, requestedBy: undefined });
        expect(queued).toEqual({ uid: expect.any(String), state: "queued", type: "test", providerUid: "p" });
        expect("domainUid" in queued).toBe(false);
    });
});

describe("BaseDnsDesiredStateRoute providerCredentials()", () => {
    const envelope = (ct: string) => ({ $enc: 1 as const, kid: "k1", iv: "aXY=", ct, tag: "dGFn" });
    const subject = "system:serviceaccount:mail:mail-dns-controller";
    const req: any = { headers: { authorization: "Bearer controller-token" } };

    /** A route that accepts the controller's token, over a provider repo answering `provider`, with a cipher that opens `ct` as `plain-<ct>` except for "bad". */
    function routeFor(provider: any): { route: any; res: any; logger: any } {
        const route: any = new TestDesiredStateRoute();
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        Object.defineProperty(route, "logger", { value: logger, configurable: true, writable: true });
        route.controllerSubject = subject;
        route.tokenVerifier = { verify: vi.fn(async () => ({ subject })) };
        route.providerRepo = { findOne: vi.fn(async () => provider) };
        route.cipher = {
            decryptString: vi.fn((e: any) => {
                if (e.ct === "bad") {
                    throw new ConfigSecretUnavailableError("DnsProvider", "aws-x", "credentials.x", "failed", "the value was changed");
                }
                return `plain-${e.ct}`;
            }),
        };
        return { route, res: { setHeader: vi.fn() }, logger };
    }
    const aws = (credentials: any, credentialsGeneration: number = 2) => ({ uid: "aws-x", credentials, credentialsGeneration });

    it("reads the row afresh, answers the decrypted values uncached, and logs only the provider and generation", async () => {
        const { route, res, logger } = routeFor(aws({ accessKeyId: envelope("a"), secretAccessKey: envelope("b") }));
        const answer = await route.providerCredentials("aws-x", req, res);
        expect(answer).toEqual({
            apiVersion: "dns.rapidmx.io/v1",
            kind: "DnsProviderCredentials",
            providerUid: "aws-x",
            generation: 2,
            values: { accessKeyId: "plain-a", secretAccessKey: "plain-b" },
        });
        expect(route.providerRepo.findOne).toHaveBeenCalledWith("aws-x", { ignoreACL: true, skipCache: true });
        expect(res.setHeader).toHaveBeenCalledWith("cache-control", "no-store");
        expect(logger.info).toHaveBeenCalledTimes(1);
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("'aws-x' at generation 2"));
        expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls])).not.toContain("plain-");
    });

    it("refuses a caller that isn't the controller, before reading anything", async () => {
        const { route, res } = routeFor(aws({}));
        route.tokenVerifier = { verify: vi.fn(async () => Promise.reject(new Error("bad signature"))) };
        await expect(route.providerCredentials("aws-x", req, res)).rejects.toMatchObject({ status: 403 });
        expect(route.providerRepo.findOne).not.toHaveBeenCalled();
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    it("answers 404 for a config that is gone", async () => {
        const { route, res } = routeFor(undefined);
        await expect(route.providerCredentials("gone", req, res)).rejects.toMatchObject({ status: 404 });
    });

    it("answers empty values at generation 0 for a row that never had credentials, without needing a cipher", async () => {
        const { route, res } = routeFor({ uid: "irsa" });
        route.cipher = undefined;
        expect(await route.providerCredentials("irsa", req, res)).toEqual({ apiVersion: "dns.rapidmx.io/v1", kind: "DnsProviderCredentials", providerUid: "irsa", generation: 0, values: {} });
        const cleared = routeFor(aws(null, 3));
        cleared.route.cipher = undefined;
        expect((await cleared.route.providerCredentials("aws-x", req, cleared.res)).generation).toBe(3);
    });

    it("answers 503 for credentials it has no cipher to read", async () => {
        const { route, res } = routeFor(aws({ accessKeyId: envelope("a") }));
        route.cipher = undefined;
        await expect(route.providerCredentials("aws-x", req, res)).rejects.toMatchObject({ status: 503 });
        expect(res.setHeader).not.toHaveBeenCalled();
    });

    it("names a credential it can't read, warning once per field however often it is asked, and never says what was in it", async () => {
        const { route, res, logger } = routeFor(aws({ accessKeyId: envelope("a"), secretAccessKey: envelope("bad") }));
        const first = await route.providerCredentials("aws-x", req, res);
        expect(first.values).toEqual({ accessKeyId: "plain-a" });
        expect(first.unreadable).toEqual(["secretAccessKey"]);
        await route.providerCredentials("aws-x", req, res);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("'secretAccessKey' of DNS provider 'aws-x'"));
        // Another field of it is another warning.
        const other = routeFor(aws({ accessKeyId: envelope("bad"), secretAccessKey: envelope("bad") }));
        await other.route.providerCredentials("aws-x", req, other.res);
        expect(other.logger.warn).toHaveBeenCalledTimes(2);
    });

    it("doesn't hide a failure that isn't an unreadable credential", async () => {
        const { route, res } = routeFor(aws({ accessKeyId: envelope("a") }));
        route.cipher.decryptString = vi.fn(() => {
            throw new TypeError("cipher is broken");
        });
        await expect(route.providerCredentials("aws-x", req, res)).rejects.toThrow("cipher is broken");
    });
});

describe("BaseDnsDesiredStateRoute automatic takeover scheduling", () => {
    /** A route that can audit and look things up, with its looking replaced by `look`. */
    function scanRoute(look: (observed: ReadonlySet<string>) => Promise<void> = async () => undefined) {
        const route: any = new TestDesiredStateRoute();
        const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
        Object.defineProperty(route, "logger", { value: logger, configurable: true, writable: true });
        route.auditLogUtils = { record: vi.fn() };
        route.dnsResolver = {};
        route.takeoverMinIntervalSeconds = 60;
        route.queueAutomaticTakeovers = vi.fn(look);
        return { route, logger };
    }
    const reportOf = (...endpoints: [string, number, number | undefined][]): any => ({
        endpoints: endpoints.map(([endpointSetId, generation, observedGeneration]) => ({ endpointSetId, generation, observedGeneration })),
    });

    it("looks at nothing on a server that registers no audit log or resolver, since an unaudited takeover is never queued", async () => {
        const { route } = scanRoute();
        route.auditLogUtils = undefined;
        route.requestTakeoverScan(reportOf(["domain-a-com", 1, 1]));
        route.auditLogUtils = { record: vi.fn() };
        route.dnsResolver = undefined;
        route.requestTakeoverScan(reportOf(["domain-a-com", 1, 1]));

        expect(route.queueAutomaticTakeovers).not.toHaveBeenCalled();
        expect(route.takeoverScan).toBeUndefined();
    });

    it("hands the look the endpoints external-dns has observed at their current generation, and no more than one look within the interval", async () => {
        const { route } = scanRoute();

        route.requestTakeoverScan(reportOf(["domain-a-com", 2, 2], ["domain-b-com", 2, 1], ["domain-c-com", 1, undefined], ["hosts-p", 3, 4]));
        await route.takeoverScan;
        route.requestTakeoverScan(reportOf(["domain-a-com", 2, 2]));

        expect(route.queueAutomaticTakeovers).toHaveBeenCalledTimes(1);
        expect([...route.queueAutomaticTakeovers.mock.calls[0][0]].sort()).toEqual(["domain-a-com", "hosts-p"]);
        expect(route.takeoverScan).toBeUndefined();
    });

    it("looks again, at the latest report, when reports arrive while a look runs", async () => {
        let release: () => void = () => undefined;
        const { route } = scanRoute((observed) => (observed.has("first") ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()));

        route.takeoverMinIntervalSeconds = 0;
        route.requestTakeoverScan(reportOf(["first", 1, 1]));
        route.requestTakeoverScan(reportOf(["second", 1, 1]));
        route.requestTakeoverScan(reportOf(["third", 1, 1]));
        expect(route.queueAutomaticTakeovers).toHaveBeenCalledTimes(1);
        release();
        await route.takeoverScan;

        expect(route.queueAutomaticTakeovers).toHaveBeenCalledTimes(2);
        expect([...route.queueAutomaticTakeovers.mock.calls[1][0]]).toEqual(["third"]);
        expect(route.takeoverScan).toBeUndefined();
    });

    it("doesn't look again for a report that arrived while a look ran before the minimum interval since it started has passed: the next report asks again", async () => {
        let release: () => void = () => undefined;
        const { route } = scanRoute((observed) => (observed.has("first") ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()));

        route.requestTakeoverScan(reportOf(["first", 1, 1]));
        route.requestTakeoverScan(reportOf(["second", 1, 1]));
        release();
        await route.takeoverScan;

        expect(route.queueAutomaticTakeovers).toHaveBeenCalledTimes(1);
        expect(route.pendingTakeoverScan).toBeUndefined();
        expect(route.takeoverScan).toBeUndefined();
    });

    it("logs a look that failed and goes on to the next, without failing the report", async () => {
        const { route, logger } = scanRoute(async (observed) => {
            if (observed.has("first")) {
                throw new Error("resolver is down");
            }
        });
        route.takeoverMinIntervalSeconds = 0;

        route.requestTakeoverScan(reportOf(["first", 1, 1]));
        await route.takeoverScan;
        route.requestTakeoverScan(reportOf(["second", 1, 1]));
        await route.takeoverScan;

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("resolver is down"));
        expect(route.queueAutomaticTakeovers).toHaveBeenCalledTimes(2);
    });

    describe("queueAutomaticTakeovers()", () => {
        function lookRoute(providers: any[], identity: any = { uid: "deployment-identity", installationId: "abcdefghijklmnop" }) {
            const route: any = new TestDesiredStateRoute();
            const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
            Object.defineProperty(route, "logger", { value: logger, configurable: true, writable: true });
            route.auditLogUtils = { record: vi.fn() };
            route.dnsResolver = {};
            route.providerRepo = { find: vi.fn(async () => providers) };
            route.domainRepo = { find: vi.fn(async () => []) };
            route.operationRepo = { find: vi.fn(async () => []), create: vi.fn(async (row: any) => row) };
            route.identityRepo = { findOne: vi.fn(async () => identity) };
            return { route, logger };
        }

        it("reads nothing more while no enabled provider config allows takeover, nor without an owner id to judge ownership by", async () => {
            const none = lookRoute([{ uid: "a", allowTakeover: false, enabled: true }, { uid: "b", allowTakeover: true, enabled: false }]);
            await none.route.queueAutomaticTakeovers(new Set());
            expect(none.route.identityRepo.findOne).not.toHaveBeenCalled();

            const noOwner = lookRoute([{ uid: "a", allowTakeover: true, enabled: true }], { uid: "deployment-identity", installationId: "BAD" });
            await noOwner.route.queueAutomaticTakeovers(new Set());
            expect(noOwner.route.domainRepo.find).not.toHaveBeenCalled();
        });

        const planned = (): any => ({
            uid: "11111111-2222-5333-8444-555555555555",
            provider: { uid: "a" },
            domain: { uid: "example.com", name: "example.com" },
            endpointSetId: "domain-example-com",
            records: [{ dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"] }],
        });

        describe("what it looks up again", () => {
            const ENVELOPE = { $enc: 1, kid: "k1", iv: "iv", ct: "ct", tag: "tag" };
            const cloudflare: any = {
                uid: "cloudflare-main",
                name: "Cloudflare",
                type: "cloudflare",
                zones: ["example.com"],
                credentials: { apiToken: ENVELOPE },
                enabled: true,
                allowTakeover: true,
            };
            const example: any = { uid: "example.com", name: "example.com", enabled: true, verified: false, verificationToken: "3f9c1d", dnsProviderUid: "cloudflare-main" };
            const registry = [["heritage=external-dns,external-dns/owner=rapidmx-abcdefghijklmnop,external-dns/resource=crd/mail/x"]];

            /** A route with one domain on a provider that allows takeover, a counting resolver, and a mailbox host at `mail.example.com`. */
            function scanning(operations: any[] = []) {
                const { route } = lookRoute([cloudflare]);
                const resolver = new StaticDnsResolver();
                const lookups = { count: 0 };
                for (const method of ["resolveTxt", "resolveMx", "resolveCname", "resolveSrv", "resolveAddresses"] as const) {
                    const original = resolver[method].bind(resolver) as (name: string) => Promise<any>;
                    (resolver as any)[method] = async (name: string) => {
                        lookups.count++;
                        return await original(name);
                    };
                }
                route.dnsResolver = resolver;
                route.mxHostname = "mail.example.com";
                route.takeoverMinIntervalSeconds = 0;
                route.takeoverRecheckSeconds = 3600;
                route.domainRepo.find = vi.fn(async () => [example]);
                route.operationRepo.find = vi.fn(async (query: any) => operations.filter((operation) => !query.type || operation.type === query.type));
                const scan = async (generation: number): Promise<number> => {
                    lookups.count = 0;
                    route.requestTakeoverScan({ endpoints: [{ endpointSetId: "domain-example-com", generation, observedGeneration: generation }] });
                    await route.takeoverScan;
                    return lookups.count;
                };
                return { route, resolver, scan, lookups };
            }

            it("doesn't look a domain found clean up again until its endpoint changes or the time to look again has passed", async () => {
                const { route, resolver, scan } = scanning();
                resolver.mxRecords.set("example.com", [{ priority: 10, exchange: "mail.example.com" }]);
                resolver.records.set("rmx-mx.example.com", registry);

                expect(await scan(1)).toBeGreaterThan(0);
                expect(await scan(1)).toBe(0);
                expect(await scan(1)).toBe(0);
                // The endpoint changed: its records may be too.
                expect(await scan(2)).toBeGreaterThan(0);
                expect(await scan(2)).toBe(0);
                // Long enough since the look, though nothing in the endpoint changed.
                route.takeoverRecheckSeconds = 0;
                expect(await scan(2)).toBeGreaterThan(0);
                expect(route.operationRepo.create).not.toHaveBeenCalled();
            });

            it("keeps looking at a domain with a record in conflict, until a takeover has cleared it, and queues it once", async () => {
                const { route, resolver, scan } = scanning();
                resolver.mxRecords.set("example.com", [{ priority: 5, exchange: "mx.oldhost.net" }]);

                expect(await scan(1)).toBeGreaterThan(0);
                expect(route.operationRepo.create).toHaveBeenCalledTimes(1);
                expect(await scan(1)).toBeGreaterThan(0);
                // The takeover ran: the record is the deployment's.
                resolver.mxRecords.set("example.com", [{ priority: 10, exchange: "mail.example.com" }]);
                resolver.records.set("rmx-mx.example.com", registry);
                expect(await scan(1)).toBeGreaterThan(0);
                expect(await scan(1)).toBe(0);
            });

            it("forgets what it saw of an endpoint set that is no longer reported, and of a domain moved to another provider config", async () => {
                const { route, resolver, scan } = scanning();
                resolver.mxRecords.set("example.com", [{ priority: 10, exchange: "mail.example.com" }]);
                resolver.records.set("rmx-mx.example.com", registry);
                await scan(1);
                expect(await scan(1)).toBe(0);

                route.requestTakeoverScan({ endpoints: [] });
                await route.takeoverScan;
                expect(await scan(1)).toBeGreaterThan(0);

                const other = { ...cloudflare, uid: "cloudflare-other" };
                route.providerRepo.find = vi.fn(async () => [other]);
                route.domainRepo.find = vi.fn(async () => [{ ...example, dnsProviderUid: "cloudflare-other" }]);
                expect(await scan(1)).toBeGreaterThan(0);
            });

            it("records a look under the generation of the report its scan was made for, not one a report brought while it ran", async () => {
                const { route, resolver, scan } = scanning();
                resolver.mxRecords.set("example.com", [{ priority: 10, exchange: "mail.example.com" }]);
                resolver.records.set("rmx-mx.example.com", registry);
                let release: () => void = () => undefined;
                const gate = new Promise<void>((resolve) => (release = resolve));
                route.domainRepo.find = vi.fn(async () => {
                    await gate;
                    return [example];
                });

                route.requestTakeoverScan({ endpoints: [{ endpointSetId: "domain-example-com", generation: 1, observedGeneration: 1 }] });
                // The endpoint changed meanwhile; external-dns has not read the new generation.
                route.requestTakeoverScan({ endpoints: [{ endpointSetId: "domain-example-com", generation: 2, observedGeneration: 1 }] });
                release();
                await route.takeoverScan;

                // Observed at generation 2 now: what was seen at generation 1 does not stand for it.
                expect(await scan(2)).toBeGreaterThan(0);
                expect(await scan(2)).toBe(0);
            });

            it("looks at a domain again when a lookup of it could not be answered, however clean it looked", async () => {
                const { resolver, scan } = scanning();
                resolver.failing.add("_dmarc.example.com");

                expect(await scan(1)).toBeGreaterThan(0);
                expect(await scan(1)).toBeGreaterThan(0);
                resolver.failing.clear();
                expect(await scan(1)).toBeGreaterThan(0);
                expect(await scan(1)).toBe(0);
            });

            it("reads only the takeovers and restores among the operations, not the whole history", async () => {
                const { route, scan } = scanning([{ uid: "t", type: "test", providerUid: "cloudflare-main", state: "succeeded" }]);

                await scan(1);

                const queries = route.operationRepo.find.mock.calls.map(([query]: any) => query.type).sort();
                expect(queries).toEqual(["restore", "takeover"]);
            });
        });

        it("skips a takeover another server queued at the same moment, and says nothing of it", async () => {
            const { route } = lookRoute([]);
            const refusal = Object.assign(new Error("exists"), { code: ApiErrors.IDENTIFIER_EXISTS, status: 400 });
            route.operationRepo.create = vi.fn(async () => Promise.reject(refusal));
            route.dnsResolver = { resolveMx: vi.fn(async () => []) };

            await route.queueTakeover(planned());

            expect(route.auditLogUtils.record).not.toHaveBeenCalled();
        });

        it("doesn't hide a failure to queue that isn't a duplicate", async () => {
            const { route } = lookRoute([]);
            route.operationRepo.create = vi.fn(async () => Promise.reject(new Error("database is down")));

            await expect(route.queueTakeover(planned())).rejects.toThrow("database is down");
        });
    });
});
