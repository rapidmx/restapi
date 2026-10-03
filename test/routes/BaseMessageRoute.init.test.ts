///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseMessageRoute's `initMessageRepos()` @Init hook: the repositories (and the sanitized body loader)
// it builds once, with exactly the arguments the route used to build them with lazily.
import { RepoUtils } from "@rapidrest/service-core";
import { RecoverableRepoUtils } from "../../src/util/RecoverableRepoUtils.js";
import { BaseMessageRoute } from "../../src/routes/BaseMessageRoute.js";
import { SanitizedBodyLoader } from "../../src/scan/SanitizedBody.js";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { CorrespondentUtils } from "../../src/util/CorrespondentUtils.js";
import { DomainUtils } from "../../src/util/DomainUtils.js";

class FolderModel {}
class OverrideModel {}
class MailboxModel {}
class KeyVaultModel {}
class AttachmentModel {}
class AuditLogModel {}
class CorrespondentModel {}
class DomainModel {}
class MatterModel {}
class QuarantineModel {}
class IngestQueueModel {}

class TestMessageRoute extends BaseMessageRoute<any> {
    protected folderClass: any = FolderModel;
    protected auditLogClass: any = AuditLogModel;
    protected focusedInboxOverrideClass: any = OverrideModel;
    protected mailboxClass: any = MailboxModel;
    protected correspondentClass: any = CorrespondentModel;
    protected domainClass: any = DomainModel;
    protected matterClass: any = MatterModel;
    protected keyVaultClass: any = KeyVaultModel;
    protected attachmentClass: any = AttachmentModel;
    protected quarantineEntryClass: any = QuarantineModel;
    protected ingestQueueEntryClass: any = IngestQueueModel;

    protected buildLabelUidsFilter(): Record<string, any> {
        return {};
    }

    public run(): Promise<void> {
        return this.initMessageRepos();
    }
}

function build(factory: any): any {
    const route: any = new TestMessageRoute();
    Object.defineProperty(route, "_objectFactory", { value: factory, writable: true, configurable: true });
    return route;
}

describe("BaseMessageRoute initMessageRepos() Tests", () => {
    it("throws when the objectFactory is not set.", async () => {
        const route: any = new TestMessageRoute();
        Object.defineProperty(route, "_objectFactory", { value: undefined, writable: true, configurable: true });

        await expect(route.run()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds each repository, then the services over them, once, by model class, and the sanitized body loader.", async () => {
        const factory: any = { newInstance: vi.fn(async (type: any, options: any) => ({ type, options })) };
        const route: any = build(factory);

        await route.run();

        expect(factory.newInstance).toHaveBeenCalledTimes(15);
        expect(route.folderRepo).toEqual({ type: RecoverableRepoUtils, options: { name: "FolderModel", args: [FolderModel] } });
        expect(route.focusedInboxOverrideRepo).toEqual({ type: RepoUtils, options: { name: "OverrideModel", args: [OverrideModel] } });
        expect(route.mailboxRepo).toEqual({ type: RepoUtils, options: { name: "MailboxModel", args: [MailboxModel] } });
        expect(route.keyVaultRepo).toEqual({ type: RepoUtils, options: { name: "KeyVaultModel", args: [KeyVaultModel] } });
        expect(route.attachmentRepo).toEqual({ type: RepoUtils, options: { name: "AttachmentModel", args: [AttachmentModel] } });
        expect(route.auditLogRepo).toEqual({ type: RepoUtils, options: { name: "AuditLogModel", args: [AuditLogModel] } });
        expect(route.domainRepo).toEqual({ type: RepoUtils, options: { name: "DomainModel", args: [DomainModel] } });
        expect(route.matterRepo).toEqual({ type: RepoUtils, options: { name: "MatterModel", args: [MatterModel] } });
        expect(route.correspondentRepo).toEqual({ type: RepoUtils, options: { name: "CorrespondentModel", args: [CorrespondentModel] } });
        expect(route.quarantineEntryRepo).toEqual({ type: RepoUtils, options: { name: "QuarantineModel", args: [QuarantineModel] } });
        expect(route.ingestQueueEntryRepo).toEqual({ type: RepoUtils, options: { name: "IngestQueueModel", args: [IngestQueueModel] } });
        expect(route.auditLogUtils).toEqual({ type: AuditLogUtils, options: { name: "AuditLogModel", args: [route.auditLogRepo] } });
        expect(route.domainUtils).toEqual({ type: DomainUtils, options: { name: "DomainModel", args: [route.domainRepo] } });
        expect(route.correspondentUtils).toEqual({
            type: CorrespondentUtils,
            options: { name: "CorrespondentModel", args: [route.correspondentRepo, route.mailboxRepo] },
        });
        expect(route.sanitizedBodyLoader).toEqual({ type: SanitizedBodyLoader, options: { name: "default" } });
    });

    it("does not rebuild a repository or the loader that is already set.", async () => {
        const factory: any = { newInstance: vi.fn() };
        const route: any = build(factory);
        const loader: any = {};
        route.folderRepo = { id: "folder" };
        route.focusedInboxOverrideRepo = { id: "override" };
        route.mailboxRepo = { id: "mailbox" };
        route.keyVaultRepo = { id: "vault" };
        route.attachmentRepo = { id: "attachment" };
        route.auditLogRepo = { id: "audit" };
        route.domainRepo = { id: "domain" };
        route.matterRepo = { id: "matter" };
        route.correspondentRepo = { id: "correspondent" };
        route.quarantineEntryRepo = { id: "quarantine" };
        route.ingestQueueEntryRepo = { id: "ingest" };
        route.auditLogUtils = { id: "auditUtils" };
        route.domainUtils = { id: "domainUtils" };
        route.correspondentUtils = { id: "correspondentUtils" };
        route.sanitizedBodyLoader = loader;

        await route.run();

        expect(factory.newInstance).not.toHaveBeenCalled();
        expect(route.folderRepo).toEqual({ id: "folder" });
        expect(route.auditLogUtils).toEqual({ id: "auditUtils" });
        expect(route.sanitizedBodyLoader).toBe(loader);
    });

    it("skips a repository whose class is not set.", async () => {
        const factory: any = { newInstance: vi.fn(async () => ({})) };
        const route: any = build(factory);
        route.folderClass = undefined;
        route.focusedInboxOverrideClass = undefined;
        route.mailboxClass = undefined;
        route.keyVaultClass = undefined;
        route.attachmentClass = undefined;
        route.auditLogClass = undefined;
        route.domainClass = undefined;
        route.matterClass = undefined;
        route.correspondentClass = undefined;
        route.quarantineEntryClass = undefined;
        route.ingestQueueEntryClass = undefined;

        await route.run();

        expect(factory.newInstance).toHaveBeenCalledTimes(1);
        expect(factory.newInstance).toHaveBeenCalledWith(SanitizedBodyLoader, { name: "default" });
        expect(route.attachmentRepo).toBeUndefined();
        expect(route.folderRepo).toBeUndefined();
        expect(route.auditLogUtils).toBeUndefined();
        expect(route.domainUtils).toBeUndefined();
        expect(route.correspondentUtils).toBeUndefined();
    });

    it("builds no correspondent service without the mailbox repository it reads.", async () => {
        const factory: any = { newInstance: vi.fn(async (type: any, options: any) => ({ type, options })) };
        const route: any = build(factory);
        route.mailboxClass = undefined;

        await route.run();

        expect(route.correspondentRepo).toBeDefined();
        expect(route.correspondentUtils).toBeUndefined();
    });
});
