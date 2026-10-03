///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the single `@Init` hook (`initialize()`) of the escrow, key, mail, matter and search routes, which
// builds each model repository once through the ObjectFactory instead of lazily inside the handlers.
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
import { RecoverableRepoUtils } from "../../src/util/RecoverableRepoUtils.js";

/** A uniquely named stand-in model class. */
function model(name: string): any {
    return { [name]: class {} }[name];
}

/** Subclasses `base`, giving it a uniquely named stand-in model class for every one of `classFields`. */
function subclass(base: any, classFields: string[]): new () => any {
    class Test extends base {
        constructor() {
            super();
            for (const field of classFields) {
                (this as any)[field] = model(`${field}Model`);
            }
        }
    }
    return Test;
}

interface Case {
    name: string;
    make: () => any;
    /** [repo field, class field, repo type] */
    repos: [string, string, any][];
}

function route(name: string, base: any, repos: [string, string, any][]): Case {
    const Test = subclass(
        base,
        repos.map(([, classField]) => classField),
    );
    return { name, make: () => new Test(), repos };
}

const cases: Case[] = [
    route("BaseEscrowAccessRequestRoute", BaseEscrowAccessRequestRoute, [
        ["requestRepo", "escrowAccessRequestClass", RepoUtils],
        ["matterRepo", "matterClass", RepoUtils],
        ["mailboxRepo", "mailboxClass", RepoUtils],
        ["keyVaultRepo", "keyVaultClass", RepoUtils],
    ]),
    route("BaseKeyDiscoveryRoute", BaseKeyDiscoveryRoute, [
        ["mailboxRepo", "mailboxClass", RepoUtils],
        ["keyVaultRepo", "keyVaultClass", RepoUtils],
    ]),
    route("BaseKeyLookupRoute", BaseKeyLookupRoute, [
        ["mailboxRepo", "mailboxClass", RepoUtils],
        ["keyVaultRepo", "keyVaultClass", RepoUtils],
        ["contactRepo", "contactClass", RecoverableRepoUtils],
        ["folderRepo", "folderClass", RecoverableRepoUtils],
    ]),
    route("BaseKeyVaultRoute", BaseKeyVaultRoute, [
        ["keyVaultRepo", "keyVaultClass", RepoUtils],
        ["mailboxRepo", "mailboxClass", RepoUtils],
        ["escrowScopeRepo", "escrowScopeClass", RepoUtils],
    ]),
    route("BaseMailIngestRoute", BaseMailIngestRoute, [
        ["mailboxRepo", "mailboxClass", RepoUtils],
        ["ingestQueueRepo", "ingestQueueClass", RepoUtils],
        ["distributionListRepo", "distributionListClass", RepoUtils],
        ["transportRuleRepo", "transportRuleClass", RepoUtils],
    ]),
    route("BaseMailboxAccessRoute", BaseMailboxAccessRoute, [["mailboxRepo", "mailboxClass", RepoUtils]]),
    route("BaseMailboxImportRoute", BaseMailboxImportRoute, [
        ["requestRepo", "mailboxImportRequestClass", RepoUtils],
        ["mailboxRepo", "mailboxClass", RepoUtils],
        ["folderRepo", "folderClass", RepoUtils],
    ]),
    route("BaseMatterExportRequestRoute", BaseMatterExportRequestRoute, [
        ["requestRepo", "matterExportRequestClass", RepoUtils],
        ["matterRepo", "matterClass", RepoUtils],
        ["mailboxRepo", "mailboxClass", RepoUtils],
    ]),
    route("BaseMatterSearchRoute", BaseMatterSearchRoute, [
        ["matterRepo", "matterClass", RepoUtils],
        ["mailboxRepo", "mailboxClass", RepoUtils],
    ]),
    route("BaseSearchRoute", BaseSearchRoute, [
        ["mailboxRepo", "mailboxClass", RepoUtils],
        ["messageRepo", "messageClass", RecoverableRepoUtils],
    ]),
    route("BaseEscrowAuditLogRoute", BaseEscrowAuditLogRoute, [["matterRepo", "matterClass", RepoUtils]]),
    route("BaseEscrowScopeRoute", BaseEscrowScopeRoute, [
        ["matterRepo", "matterClass", RepoUtils],
        ["mailboxRepo", "mailboxClass", RepoUtils],
        ["accessRequestRepo", "escrowAccessRequestClass", RepoUtils],
    ]),
    route("BaseMatterRoute", BaseMatterRoute, [
        ["mailboxRepo", "mailboxClass", RepoUtils],
        ["accessRequestRepo", "escrowAccessRequestClass", RepoUtils],
    ]),
    route("BaseDistributionListRoute", BaseDistributionListRoute, [["mailboxRepo", "mailboxClass", RepoUtils]]),
];

function withFactory(target: any): any {
    const factory: any = { newInstance: vi.fn(async (type: any, opts: any) => ({ type, opts })) };
    Object.defineProperty(target, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

describe.each(cases)("$name initialize()", ({ make, repos }) => {
    it("throws when the objectFactory is not set", async () => {
        const target: any = make();
        await expect(target.initialize()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds each repo once through the factory with the model class", async () => {
        const target: any = make();
        const factory = withFactory(target);
        await target.initialize();
        expect(factory.newInstance).toHaveBeenCalledTimes(repos.length);
        for (const [field, classField, type] of repos) {
            const cls = target[classField];
            expect(factory.newInstance).toHaveBeenCalledWith(type, { name: cls.name, args: [cls] });
            expect(target[field]).toEqual({ type, opts: { name: cls.name, args: [cls] } });
        }
    });

    it("does not rebuild a repo that is already set", async () => {
        const target: any = make();
        const factory = withFactory(target);
        const preset: any[] = [];
        for (const [field] of repos) {
            target[field] = { preset: field };
            preset.push(target[field]);
        }
        await target.initialize();
        expect(factory.newInstance).not.toHaveBeenCalled();
        repos.forEach(([field], i) => expect(target[field]).toBe(preset[i]));
    });

    it("skips a repo whose class is unset", async () => {
        const target: any = make();
        const factory = withFactory(target);
        for (const [, classField] of repos) {
            target[classField] = undefined;
        }
        await target.initialize();
        expect(factory.newInstance).not.toHaveBeenCalled();
        for (const [field] of repos) {
            expect(target[field]).toBeUndefined();
        }
    });
});
