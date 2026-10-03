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

class FolderModel {}
class OverrideModel {}
class MailboxModel {}
class KeyVaultModel {}
class AttachmentModel {}

class TestMessageRoute extends BaseMessageRoute<any> {
    protected folderClass: any = FolderModel;
    protected auditLogClass: any = class {};
    protected focusedInboxOverrideClass: any = OverrideModel;
    protected mailboxClass: any = MailboxModel;
    protected correspondentClass: any = class {};
    protected domainClass: any = class {};
    protected matterClass: any = class {};
    protected keyVaultClass: any = KeyVaultModel;
    protected attachmentClass: any = AttachmentModel;

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

    it("builds each repository once, by its model class, and the sanitized body loader.", async () => {
        const factory: any = { newInstance: vi.fn(async (type: any, options: any) => ({ type, options })) };
        const route: any = build(factory);

        await route.run();

        expect(factory.newInstance).toHaveBeenCalledTimes(6);
        expect(route.folderRepo).toEqual({ type: RecoverableRepoUtils, options: { name: "FolderModel", args: [FolderModel] } });
        expect(route.focusedInboxOverrideRepo).toEqual({ type: RepoUtils, options: { name: "OverrideModel", args: [OverrideModel] } });
        expect(route.mailboxRepo).toEqual({ type: RepoUtils, options: { name: "MailboxModel", args: [MailboxModel] } });
        expect(route.keyVaultRepo).toEqual({ type: RepoUtils, options: { name: "KeyVaultModel", args: [KeyVaultModel] } });
        expect(route.attachmentRepo).toEqual({ type: RepoUtils, options: { name: "AttachmentModel", args: [AttachmentModel] } });
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
        route.sanitizedBodyLoader = loader;

        await route.run();

        expect(factory.newInstance).not.toHaveBeenCalled();
        expect(route.folderRepo).toEqual({ id: "folder" });
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

        await route.run();

        expect(factory.newInstance).toHaveBeenCalledTimes(1);
        expect(factory.newInstance).toHaveBeenCalledWith(SanitizedBodyLoader, { name: "default" });
        expect(route.attachmentRepo).toBeUndefined();
        expect(route.folderRepo).toBeUndefined();
    });
});
