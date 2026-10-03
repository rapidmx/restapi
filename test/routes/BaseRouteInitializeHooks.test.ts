///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the single `@Init` hook (`initialize()`) of the standalone (non-CRUD) routes, which builds each
// model repository once through the ObjectFactory instead of lazily inside the handlers.
import { RepoUtils } from "@rapidrest/service-core";
import { BaseAppearanceRoute } from "../../src/routes/BaseAppearanceRoute.js";
import { BaseBrandingRoute } from "../../src/routes/BaseBrandingRoute.js";
import { BaseDataExportRoute } from "../../src/routes/BaseDataExportRoute.js";
import { BaseDataSubjectErasureRequestRoute } from "../../src/routes/BaseDataSubjectErasureRequestRoute.js";
import { BaseDirectoryRoute } from "../../src/routes/BaseDirectoryRoute.js";
import { BaseEncryptionPolicyRoute } from "../../src/routes/BaseEncryptionPolicyRoute.js";
import { BaseMailboxPolicyRoute } from "../../src/routes/BaseMailboxPolicyRoute.js";
import { BasePluginRoute } from "../../src/routes/BasePluginRoute.js";
import { BaseRetentionPolicyRoute } from "../../src/routes/BaseRetentionPolicyRoute.js";
import { BaseSetupRoute } from "../../src/routes/BaseSetupRoute.js";
import { RecoverableRepoUtils } from "../../src/util/RecoverableRepoUtils.js";

/** A uniquely named stand-in model class. */
function model(name: string): any {
    return { [name]: class {} }[name];
}

class TestAppearanceRoute extends (BaseAppearanceRoute as any) {
    protected appearanceClass: any = model("AppearanceModel");
}
class TestBrandingRoute extends (BaseBrandingRoute as any) {
    protected brandingClass: any = model("BrandingModel");
    protected auditLogClass: any = model("AuditModel");
}
class TestDataExportRoute extends (BaseDataExportRoute as any) {
    protected dataExportRequestClass: any = model("ExportRequestModel");
    protected mailboxClass: any = model("MailboxModel");
    protected auditLogClass: any = model("AuditModel");
}
class TestErasureRoute extends (BaseDataSubjectErasureRequestRoute as any) {
    protected dataSubjectErasureRequestClass: any = model("ErasureRequestModel");
    protected mailboxClass: any = model("MailboxModel");
    protected matterClass: any = model("MatterModel");
    protected auditLogClass: any = model("AuditModel");
    protected folderClass: any = model("FolderModel");
}
class TestDirectoryRoute extends (BaseDirectoryRoute as any) {
    protected mailboxClass: any = model("MailboxModel");
    protected folderClass: any = model("FolderModel");
    protected erasureRequestClass: any = model("ErasureRequestModel");
}
class TestEncryptionRoute extends (BaseEncryptionPolicyRoute as any) {
    protected encryptionPolicyClass: any = model("EncryptionPolicyModel");
    protected auditLogClass: any = model("AuditModel");
}
class TestMailboxPolicyRoute extends (BaseMailboxPolicyRoute as any) {
    protected mailboxPolicyClass: any = model("MailboxPolicyModel");
    protected auditLogClass: any = model("AuditModel");
}
class TestPluginRoute extends (BasePluginRoute as any) {
    protected pluginClass: any = model("PluginModel");
    protected auditLogClass: any = model("AuditModel");
}
class TestRetentionRoute extends (BaseRetentionPolicyRoute as any) {
    protected retentionPolicyClass: any = model("RetentionPolicyModel");
    protected auditLogClass: any = model("AuditModel");
}
class TestSetupRoute extends (BaseSetupRoute as any) {
    protected setupStateClass: any = model("SetupStateModel");
    protected domainClass: any = model("DomainModel");
    protected auditLogClass: any = model("AuditModel");
}

interface Case {
    name: string;
    make: () => any;
    /** [repo field, class field, repo type] */
    repos: [string, string, any][];
}

const cases: Case[] = [
    { name: "BaseAppearanceRoute", make: () => new TestAppearanceRoute(), repos: [["repo", "appearanceClass", RepoUtils]] },
    { name: "BaseBrandingRoute", make: () => new TestBrandingRoute(), repos: [["brandingRepo", "brandingClass", RepoUtils]] },
    {
        name: "BaseDataExportRoute",
        make: () => new TestDataExportRoute(),
        repos: [
            ["requestRepo", "dataExportRequestClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
        ],
    },
    {
        name: "BaseDataSubjectErasureRequestRoute",
        make: () => new TestErasureRoute(),
        repos: [
            ["requestRepo", "dataSubjectErasureRequestClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["folderRepo", "folderClass", RecoverableRepoUtils],
        ],
    },
    {
        name: "BaseDirectoryRoute",
        make: () => new TestDirectoryRoute(),
        repos: [
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["folderRepo", "folderClass", RepoUtils],
            ["erasureRepo", "erasureRequestClass", RepoUtils],
        ],
    },
    { name: "BaseEncryptionPolicyRoute", make: () => new TestEncryptionRoute(), repos: [["encryptionPolicyRepo", "encryptionPolicyClass", RepoUtils]] },
    { name: "BaseMailboxPolicyRoute", make: () => new TestMailboxPolicyRoute(), repos: [["repo", "mailboxPolicyClass", RepoUtils]] },
    { name: "BasePluginRoute", make: () => new TestPluginRoute(), repos: [["pluginRepo", "pluginClass", RepoUtils]] },
    { name: "BaseRetentionPolicyRoute", make: () => new TestRetentionRoute(), repos: [["retentionPolicyRepo", "retentionPolicyClass", RepoUtils]] },
    {
        name: "BaseSetupRoute",
        make: () => new TestSetupRoute(),
        repos: [
            ["repo", "setupStateClass", RepoUtils],
            ["domainRepo", "domainClass", RepoUtils],
        ],
    },
];

function withFactory(route: any): any {
    const factory: any = { newInstance: vi.fn(async (type: any, opts: any) => ({ type, opts })) };
    Object.defineProperty(route, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

describe.each(cases)("$name initialize()", ({ make, repos }) => {
    it("throws when the objectFactory is not set", async () => {
        const route: any = make();
        await expect(route.initialize()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds each repo once through the factory with the model class", async () => {
        const route: any = make();
        const factory = withFactory(route);
        await route.initialize();
        expect(factory.newInstance).toHaveBeenCalledTimes(repos.length);
        for (const [field, classField, type] of repos) {
            const cls = route[classField];
            expect(factory.newInstance).toHaveBeenCalledWith(type, { name: cls.name, args: [cls] });
            expect(route[field]).toEqual({ type, opts: { name: cls.name, args: [cls] } });
        }
    });

    it("does not rebuild a repo that is already set", async () => {
        const route: any = make();
        const factory = withFactory(route);
        const preset: any[] = [];
        for (const [field] of repos) {
            route[field] = { preset: field };
            preset.push(route[field]);
        }
        await route.initialize();
        expect(factory.newInstance).not.toHaveBeenCalled();
        repos.forEach(([field], i) => expect(route[field]).toBe(preset[i]));
    });

    it("skips a repo whose class is unset", async () => {
        const route: any = make();
        const factory = withFactory(route);
        for (const [, classField] of repos) {
            route[classField] = undefined;
        }
        await route.initialize();
        expect(factory.newInstance).not.toHaveBeenCalled();
        for (const [field] of repos) {
            expect(route[field]).toBeUndefined();
        }
    });
});
