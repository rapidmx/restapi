///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the single `@Init` hook (`initialize()`) of the escrow, key, mail, matter and search routes, which
// builds each model repository, and then the services that sit on top of them (audit log, domains, escrow audit chain),
// once through the ObjectFactory instead of lazily inside the handlers.
import { RepoUtils } from "@rapidrest/service-core";
import { BaseDistributionListRoute } from "../../src/routes/BaseDistributionListRoute.js";
import { BaseEscrowAccessRequestRoute } from "../../src/routes/BaseEscrowAccessRequestRoute.js";
import { BaseEscrowAuditLogRoute } from "../../src/routes/BaseEscrowAuditLogRoute.js";
import { BaseEscrowScopeRoute } from "../../src/routes/BaseEscrowScopeRoute.js";
import { BaseKeyDiscoveryRoute } from "../../src/routes/BaseKeyDiscoveryRoute.js";
import { BaseKeyLookupRoute } from "../../src/routes/BaseKeyLookupRoute.js";
import { BaseKeyVaultRoute } from "../../src/routes/BaseKeyVaultRoute.js";
import { BaseMailboxAccessRoute } from "../../src/routes/BaseMailboxAccessRoute.js";
import { BaseMailboxImportRoute } from "../../src/routes/BaseMailboxImportRoute.js";
import { BaseMailIngestRoute } from "../../src/routes/BaseMailIngestRoute.js";
import { BaseMatterExportRequestRoute } from "../../src/routes/BaseMatterExportRequestRoute.js";
import { BaseMatterRoute } from "../../src/routes/BaseMatterRoute.js";
import { BaseMatterSearchRoute } from "../../src/routes/BaseMatterSearchRoute.js";
import { BaseSearchRoute } from "../../src/routes/BaseSearchRoute.js";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { DomainUtils } from "../../src/util/DomainUtils.js";
import { EscrowAuditUtils } from "../../src/util/EscrowAuditUtils.js";
import { RecoverableRepoUtils } from "../../src/util/RecoverableRepoUtils.js";

/** A uniquely named stand-in model class. */
function model(name: string): any {
    return { [name]: class {} }[name];
}

/** The class a dotted `path` names - `modelClass` is the static the `@Model` decorator sets, `a.b` is the static `b` of class `a`. */
function getClass(target: any, path: string): any {
    const [top, sub] = path.split(".");
    const cls: any = top === "modelClass" ? target.constructor.modelClass : target[top];
    return sub ? cls?.[sub] : cls;
}

/** Unsets the class a `path` names (the top-level class of a dotted one). */
function unsetClass(target: any, path: string): void {
    const top: string = path.split(".")[0];
    if (top === "modelClass") {
        target.constructor.modelClass = undefined;
    } else {
        target[top] = undefined;
    }
}

/** Subclasses `base`, giving it a uniquely named stand-in model class for every one of `classPaths`. */
function subclass(base: any, classPaths: string[]): new () => any {
    class Test extends base {
        constructor() {
            super();
            for (const path of classPaths) {
                const [top, sub] = path.split(".");
                if (top !== "modelClass" && !(this as any)[top]) {
                    (this as any)[top] = model(`${top}Model`);
                }
                if (sub) {
                    (top === "modelClass" ? (Test as any).modelClass : (this as any)[top])[sub] = model(`${sub}Model`);
                }
            }
        }
    }
    if (classPaths.some((path) => path.split(".")[0] === "modelClass")) {
        (Test as any).modelClass = model("modelClassModel");
    }
    return Test;
}

/** [repo field, class path, repo type] */
type RepoSpec = [string, string, any];
/** [service field, service type, class path (names the service), repo fields passed as its arguments] */
type ServiceSpec = [string, any, string, string[]];

interface Case {
    name: string;
    make: () => any;
    repos: RepoSpec[];
    services: ServiceSpec[];
}

function route(name: string, base: any, repos: RepoSpec[], services: ServiceSpec[] = []): Case {
    const paths: string[] = [...repos.map(([, path]) => path), ...services.map(([, , path]) => path)];
    return { name, make: () => new (subclass(base, paths))(), repos, services };
}

const AUDIT_LOG: [RepoSpec[], ServiceSpec[]] = [
    [["auditLogRepo", "auditLogClass", RepoUtils]],
    [["auditLogUtils", AuditLogUtils, "auditLogClass", ["auditLogRepo"]]],
];
const DOMAINS: [RepoSpec[], ServiceSpec[]] = [
    [["domainRepo", "domainClass", RepoUtils]],
    [["domainUtils", DomainUtils, "domainClass", ["domainRepo"]]],
];
const ESCROW_SCOPE: RepoSpec = ["escrowScopeRepo", "escrowScopeClass", RepoUtils];

/** The escrow audit chain's repositories and service, given the path of the entry class (the head class is its static `escrowAuditHeadClass`). */
function escrowAudit(entryPath: string): [RepoSpec[], ServiceSpec[]] {
    return [
        [
            ["escrowAuditEntryRepo", entryPath, RepoUtils],
            ["escrowAuditHeadRepo", `${entryPath}.escrowAuditHeadClass`, RepoUtils],
        ],
        [["escrowAuditUtils", EscrowAuditUtils, entryPath, ["escrowAuditEntryRepo", "escrowAuditHeadRepo"]]],
    ];
}

const cases: Case[] = [
    route(
        "BaseEscrowAccessRequestRoute",
        BaseEscrowAccessRequestRoute,
        [
            ["requestRepo", "escrowAccessRequestClass", RepoUtils],
            ["matterRepo", "matterClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["keyVaultRepo", "keyVaultClass", RepoUtils],
            ESCROW_SCOPE,
            ...AUDIT_LOG[0],
            ...escrowAudit("escrowAuditLogClass")[0],
        ],
        [...AUDIT_LOG[1], ...escrowAudit("escrowAuditLogClass")[1]],
    ),
    route(
        "BaseKeyDiscoveryRoute",
        BaseKeyDiscoveryRoute,
        [
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["keyVaultRepo", "keyVaultClass", RepoUtils],
            ...DOMAINS[0],
        ],
        DOMAINS[1],
    ),
    route(
        "BaseKeyLookupRoute",
        BaseKeyLookupRoute,
        [
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["keyVaultRepo", "keyVaultClass", RepoUtils],
            ["contactRepo", "contactClass", RecoverableRepoUtils],
            ["folderRepo", "folderClass", RecoverableRepoUtils],
            ...AUDIT_LOG[0],
            ...DOMAINS[0],
        ],
        [...AUDIT_LOG[1], ...DOMAINS[1]],
    ),
    route(
        "BaseKeyVaultRoute",
        BaseKeyVaultRoute,
        [
            ["keyVaultRepo", "keyVaultClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["escrowScopeRepo", "escrowScopeClass", RepoUtils],
            ...AUDIT_LOG[0],
        ],
        AUDIT_LOG[1],
    ),
    route(
        "BaseMailIngestRoute",
        BaseMailIngestRoute,
        [
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["ingestQueueRepo", "ingestQueueClass", RepoUtils],
            ["distributionListRepo", "distributionListClass", RepoUtils],
            ["transportRuleRepo", "transportRuleClass", RepoUtils],
            ...DOMAINS[0],
        ],
        DOMAINS[1],
    ),
    route("BaseMailboxAccessRoute", BaseMailboxAccessRoute, [["mailboxRepo", "mailboxClass", RepoUtils], ...AUDIT_LOG[0]], AUDIT_LOG[1]),
    route(
        "BaseMailboxImportRoute",
        BaseMailboxImportRoute,
        [
            ["requestRepo", "mailboxImportRequestClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["folderRepo", "folderClass", RepoUtils],
            ...AUDIT_LOG[0],
        ],
        AUDIT_LOG[1],
    ),
    route(
        "BaseMatterExportRequestRoute",
        BaseMatterExportRequestRoute,
        [
            ["requestRepo", "matterExportRequestClass", RepoUtils],
            ["matterRepo", "matterClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ESCROW_SCOPE,
            ...AUDIT_LOG[0],
            ...escrowAudit("escrowAuditLogClass")[0],
        ],
        [...AUDIT_LOG[1], ...escrowAudit("escrowAuditLogClass")[1]],
    ),
    route(
        "BaseMatterSearchRoute",
        BaseMatterSearchRoute,
        [
            ["matterRepo", "matterClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ESCROW_SCOPE,
            ...AUDIT_LOG[0],
        ],
        AUDIT_LOG[1],
    ),
    route("BaseSearchRoute", BaseSearchRoute, [
        ["mailboxRepo", "mailboxClass", RepoUtils],
        ["messageRepo", "messageClass", RecoverableRepoUtils],
    ]),
    route(
        "BaseEscrowAuditLogRoute",
        BaseEscrowAuditLogRoute,
        [["matterRepo", "matterClass", RepoUtils], ESCROW_SCOPE, ...escrowAudit("modelClass")[0]],
        escrowAudit("modelClass")[1],
    ),
    route(
        "BaseEscrowScopeRoute",
        BaseEscrowScopeRoute,
        [
            ["matterRepo", "matterClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["accessRequestRepo", "escrowAccessRequestClass", RepoUtils],
            ...AUDIT_LOG[0],
        ],
        AUDIT_LOG[1],
    ),
    route(
        "BaseMatterRoute",
        BaseMatterRoute,
        [
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["accessRequestRepo", "escrowAccessRequestClass", RepoUtils],
            ESCROW_SCOPE,
            ...AUDIT_LOG[0],
        ],
        AUDIT_LOG[1],
    ),
    route(
        "BaseDistributionListRoute",
        BaseDistributionListRoute,
        [["mailboxRepo", "mailboxClass", RepoUtils], ...AUDIT_LOG[0], ...DOMAINS[0]],
        [...AUDIT_LOG[1], ...DOMAINS[1]],
    ),
];

/** Gives `target` a factory whose `newInstance()` answers `{ type, opts }`; `built` lists the answers in the order they were made. */
function withFactory(target: any): any {
    const built: any[] = [];
    const factory: any = {
        built,
        newInstance: vi.fn(async (type: any, opts: any) => {
            const instance: any = { type, opts };
            built.push(instance);
            return instance;
        }),
    };
    Object.defineProperty(target, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

describe.each(cases)("$name initialize()", ({ make, repos, services }) => {
    it("throws when the objectFactory is not set", async () => {
        const target: any = make();
        await expect(target.initialize()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds each repo, then each service on top of them, once through the factory", async () => {
        const target: any = make();
        const factory = withFactory(target);
        await target.initialize();
        expect(factory.newInstance).toHaveBeenCalledTimes(repos.length + services.length);
        for (const [field, path, type] of repos) {
            const cls = getClass(target, path);
            expect(factory.newInstance).toHaveBeenCalledWith(type, { name: cls.name, args: [cls] });
            expect(target[field]).toEqual({ type, opts: { name: cls.name, args: [cls] } });
        }
        for (const [field, type, path, argFields] of services) {
            const opts = { name: getClass(target, path).name, args: argFields.map((f) => target[f]) };
            expect(factory.newInstance).toHaveBeenCalledWith(type, opts);
            expect(target[field]).toEqual({ type, opts });
        }
    });

    it("builds each service after the repositories it is made from", async () => {
        const target: any = make();
        const factory = withFactory(target);
        await target.initialize();
        for (const [field, , , argFields] of services) {
            for (const argField of argFields) {
                expect(target[argField]).toBeDefined();
                expect(factory.built.indexOf(target[argField])).toBeGreaterThanOrEqual(0);
                expect(factory.built.indexOf(target[argField])).toBeLessThan(factory.built.indexOf(target[field]));
            }
        }
    });

    it("does not rebuild a repo or a service that is already set", async () => {
        const target: any = make();
        const factory = withFactory(target);
        const fields: string[] = [...repos.map(([field]) => field), ...services.map(([field]) => field)];
        const preset: any[] = fields.map((field) => (target[field] = { preset: field }));
        await target.initialize();
        expect(factory.newInstance).not.toHaveBeenCalled();
        fields.forEach((field, i) => expect(target[field]).toBe(preset[i]));
    });

    it("skips a repo or a service whose class is unset", async () => {
        const target: any = make();
        const factory = withFactory(target);
        for (const [, path] of repos) {
            unsetClass(target, path);
        }
        await target.initialize();
        expect(factory.newInstance).not.toHaveBeenCalled();
        for (const [field] of [...repos, ...services]) {
            expect(target[field]).toBeUndefined();
        }
    });
});

describe.each([
    ["BaseEscrowAccessRequestRoute", BaseEscrowAccessRequestRoute, "escrowAuditLogClass"],
    ["BaseMatterExportRequestRoute", BaseMatterExportRequestRoute, "escrowAuditLogClass"],
    ["BaseEscrowAuditLogRoute", BaseEscrowAuditLogRoute, "modelClass"],
])("%s without an escrow audit head class", (_name, base, entryPath) => {
    it("builds the escrow audit service without a head repo", async () => {
        const target: any = new (subclass(base, [entryPath]))();
        const factory = withFactory(target);
        await target.initialize();
        expect(target.escrowAuditHeadRepo).toBeUndefined();
        expect(factory.newInstance).toHaveBeenCalledWith(EscrowAuditUtils, {
            name: getClass(target, entryPath).name,
            args: [target.escrowAuditEntryRepo, undefined],
        });
    });
});
