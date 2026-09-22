///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseFolderRoute, reserved ONLY for the `!this.repoUtils` defensive guard
// branches that a real wired server can never exercise (DI always populates `repoUtils` before a
// request can reach a route). Every other behavior (count's missing-mailboxUid/permission outcomes,
// create's bulk-array path, exists' found/not-found and permission outcomes) is exercised via real
// HTTP+DB requests in test/routes/mongo/FolderRoute.test.ts (and its sql/ counterpart), matching this
// library's real-server-integration-test convention.
//
// The route instance itself is still scaffolded through a real `ObjectFactory` (`newInstance(...,
// { initialize: false })`), not a bare `new TestFolderRoute()` - this registers the class and tags the
// instance the same way production DI does, while `initialize: false` deliberately skips the
// `@Config`/`@Logger`/`@Inject` injection and `@Init` phase, which is exactly what leaves `repoUtils`
// (and `aclUtils`) genuinely `undefined` for these guard-clause tests to observe.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseFolderRoute } from "../../src/routes/BaseFolderRoute.js";

class TestFolderRoute extends BaseFolderRoute<any> {}

function makeRes(): any {
    return {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn().mockReturnThis(),
    };
}

describe("BaseFolderRoute Tests (repoUtils guard clauses only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("count() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestFolderRoute>(TestFolderRoute, { initialize: false });
        const res = makeRes();

        await expect(
            route.count({}, { mailboxUid: "mbx-1" }, res, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("find() answers the stored counts, untouched, when the route has no messageClass to derive them from.", async () => {
        const route = objectFactory.newInstance<TestFolderRoute>(TestFolderRoute, { initialize: false });
        const stored = [{ uid: "folder-1", unreadCount: 4, totalCount: 5 }];
        (route as any).repoUtils = { find: vi.fn().mockResolvedValue(stored) };
        (route as any).aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };

        expect(await route.find({}, { mailboxUid: "mbx-1" }, { uid: "user-1" } as any)).toEqual([
            { uid: "folder-1", unreadCount: 4, totalCount: 5 },
        ]);
    });

    it("find() logs, and still answers the list, when the mailbox's well-known folders can't be provisioned.", async () => {
        const route = objectFactory.newInstance<TestFolderRoute>(TestFolderRoute, { initialize: false });
        const stored = [{ uid: "folder-1", unreadCount: 0, totalCount: 0 }];
        void Object.defineProperty(route, "modelClass", { value: class FolderTest {} });
        (route as any).logger = { warn: vi.fn() };
        (route as any).repoUtils = { find: vi.fn().mockRejectedValueOnce(new Error("database is down")).mockResolvedValue(stored) };
        (route as any).aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };

        expect(await route.find({}, { mailboxUid: "mbx-1" }, { uid: "user-1" } as any)).toEqual(stored);
        expect((route as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining("database is down"));
    });

    it("findById() heals only for a caller who may list the folder's whole mailbox.", async () => {
        const route = objectFactory.newInstance<TestFolderRoute>(TestFolderRoute, { initialize: false });
        void Object.defineProperty(route, "modelClass", { value: class FolderTest {} });
        (route as any).repoUtils = { find: vi.fn().mockResolvedValue([]), findOne: vi.fn().mockResolvedValue({ uid: "folder-1", mailboxUid: "mbx-1" }) };
        // READ on the folder itself, but nothing on the mailbox: a folder-only share.
        (route as any).aclUtils = { hasPermission: vi.fn().mockImplementation(async (_user: any, uid: string) => uid === "folder-1") };
        vi.spyOn(Object.getPrototypeOf(BaseFolderRoute.prototype), "findById").mockResolvedValue({ uid: "folder-1", mailboxUid: "mbx-1" });

        const folder = await route.findById("folder-1", {}, { uid: "user-1" } as any);

        expect(folder?.uid).toBe("folder-1");
        expect((route as any).repoUtils.find).not.toHaveBeenCalled();
    });

    it("create() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestFolderRoute>(TestFolderRoute, { initialize: false });
        const req: any = {};

        await expect(
            route.create({ mailboxUid: "mbx-1" } as any, req, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("find() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestFolderRoute>(TestFolderRoute, { initialize: false });

        await expect(route.find({}, { mailboxUid: "mbx-1" }, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("exists() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestFolderRoute>(TestFolderRoute, { initialize: false });
        const res = makeRes();

        await expect(route.exists("id-1", {}, res, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });
});
