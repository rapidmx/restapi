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
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { CorrespondentBackfillUtils, CorrespondentUtils } from "../../src/util/CorrespondentUtils.js";
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
    protected messageClass: any = model("MessageModel");
    protected calendarEventClass: any = model("CalendarEventModel");
    protected correspondentClass: any = model("CorrespondentModel");
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
    /** [service field, service type, class field the service is named after, args built from the route, suffix of its name] */
    services: [string, any, string, (route: any) => any[], string?][];
}

/** Every route that audits builds the `AuditLogEntry` repository, then the service on top of it. */
const audit = (): [string, string, any][] => [["auditLogRepo", "auditLogClass", RepoUtils]];
const auditService = (): [string, any, string, (route: any) => any[], string?][] => [["auditLogUtils", AuditLogUtils, "auditLogClass", (route) => [route.auditLogRepo]]];

const cases: Case[] = [
    { name: "BaseAppearanceRoute", make: () => new TestAppearanceRoute(), repos: [["repo", "appearanceClass", RepoUtils]], services: [] },
    { name: "BaseBrandingRoute", make: () => new TestBrandingRoute(), repos: [["brandingRepo", "brandingClass", RepoUtils], ...audit()], services: auditService() },
    {
        name: "BaseDataExportRoute",
        make: () => new TestDataExportRoute(),
        repos: [
            ["requestRepo", "dataExportRequestClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ...audit(),
        ],
        services: auditService(),
    },
    {
        name: "BaseDataSubjectErasureRequestRoute",
        make: () => new TestErasureRoute(),
        repos: [
            ["requestRepo", "dataSubjectErasureRequestClass", RepoUtils],
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["folderRepo", "folderClass", RecoverableRepoUtils],
            ["matterRepo", "matterClass", RepoUtils],
            ...audit(),
        ],
        services: auditService(),
    },
    {
        name: "BaseDirectoryRoute",
        make: () => new TestDirectoryRoute(),
        repos: [
            ["mailboxRepo", "mailboxClass", RepoUtils],
            ["folderRepo", "folderClass", RepoUtils],
            ["erasureRepo", "erasureRequestClass", RepoUtils],
            ["messageRepo", "messageClass", RepoUtils],
            ["calendarEventRepo", "calendarEventClass", RepoUtils],
            ["correspondentRepo", "correspondentClass", RepoUtils],
        ],
        services: [
            [
                "correspondentUtils",
                CorrespondentUtils,
                "correspondentClass",
                (route) => [route.correspondentRepo, route.mailboxRepo],
            ],
            [
                "correspondentBackfillUtils",
                CorrespondentBackfillUtils,
                "correspondentClass",
                (route) => [route.correspondentUtils, route.folderRepo, route.messageRepo, route.calendarEventRepo],
            ],
        ],
    },
    { name: "BaseEncryptionPolicyRoute", make: () => new TestEncryptionRoute(), repos: [["encryptionPolicyRepo", "encryptionPolicyClass", RepoUtils], ...audit()], services: auditService() },
    { name: "BaseMailboxPolicyRoute", make: () => new TestMailboxPolicyRoute(), repos: [["repo", "mailboxPolicyClass", RepoUtils], ...audit()], services: auditService() },
    { name: "BasePluginRoute", make: () => new TestPluginRoute(), repos: [["pluginRepo", "pluginClass", RepoUtils], ...audit()], services: auditService() },
    { name: "BaseRetentionPolicyRoute", make: () => new TestRetentionRoute(), repos: [["retentionPolicyRepo", "retentionPolicyClass", RepoUtils], ...audit()], services: auditService() },
    {
        name: "BaseSetupRoute",
        make: () => new TestSetupRoute(),
        repos: [
            ["repo", "setupStateClass", RepoUtils],
            ["domainRepo", "domainClass", RepoUtils],
            ...audit(),
        ],
        services: auditService(),
    },
];

function withFactory(route: any): any {
    const factory: any = { newInstance: vi.fn(async (type: any, opts: any) => ({ type, opts })) };
    Object.defineProperty(route, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

describe.each(cases)("$name initialize()", ({ make, repos, services }) => {
    it("throws when the objectFactory is not set", async () => {
        const route: any = make();
        await expect(route.initialize()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds each repo and then each service once through the factory", async () => {
        const route: any = make();
        const factory = withFactory(route);
        await route.initialize();
        expect(factory.newInstance).toHaveBeenCalledTimes(repos.length + services.length);
        for (const [field, classField, type] of repos) {
            const cls = route[classField];
            expect(factory.newInstance).toHaveBeenCalledWith(type, { name: cls.name, args: [cls] });
            expect(route[field]).toEqual({ type, opts: { name: cls.name, args: [cls] } });
        }
        for (const [field, type, classField, args, suffix] of services) {
            const opts = { name: route[classField].name + (suffix ?? ""), args: args(route) };
            expect(factory.newInstance).toHaveBeenCalledWith(type, opts);
            expect(route[field]).toEqual({ type, opts });
        }
        // The services are built after every repo they are built from.
        const types: any[] = factory.newInstance.mock.calls.map((call: any[]) => call[0]);
        services.forEach(([, type], i) => expect(types.indexOf(type)).toBe(repos.length + i));
    });

    it("does not rebuild a repo or service that is already set", async () => {
        const route: any = make();
        const factory = withFactory(route);
        const fields: string[] = [...repos.map(([field]) => field), ...services.map(([field]) => field)];
        const preset: any[] = fields.map((field) => (route[field] = { preset: field }));
        await route.initialize();
        expect(factory.newInstance).not.toHaveBeenCalled();
        fields.forEach((field, i) => expect(route[field]).toBe(preset[i]));
    });

    it("builds a service on top of a preset repo, and rebuilds nothing else", async () => {
        const route: any = make();
        const factory = withFactory(route);
        for (const [field] of repos) {
            route[field] = { preset: field };
        }
        await route.initialize();
        expect(factory.newInstance).toHaveBeenCalledTimes(services.length);
        for (const [field, type, classField, args, suffix] of services) {
            expect(route[field]).toEqual({ type, opts: { name: route[classField].name + (suffix ?? ""), args: args(route) } });
        }
    });

    it("skips a repo whose class is unset, and the service built from it", async () => {
        const route: any = make();
        const factory = withFactory(route);
        for (const [, classField] of repos) {
            route[classField] = undefined;
        }
        await route.initialize();
        expect(factory.newInstance).not.toHaveBeenCalled();
        for (const [field] of [...repos, ...services]) {
            expect(route[field]).toBeUndefined();
        }
    });
});
