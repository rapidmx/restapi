///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseScopedChildRoute, reserved for (1) the `!this.repoUtils` defensive guard
// branches that a real wired server can never exercise (DI always populates `repoUtils` before a
// request can reach a route), and (2) truncate()'s own snapshot-vs-live-query TOCTOU fix below, for the
// same reason test/routes/BaseBrandingRoute.test.ts's own "findOrCreate() TOCTOU race" describe block
// gives for using a mocked repo instead of the real HTTP+DB suite: exercising a genuine timing race
// deterministically through test/routes/{mongo,sql}/*.test.ts would require actually winning a race
// against a second concurrent request, which isn't reliable. Every other behavior of this generic base
// class (permission grant/denial outcomes, not-found handling, the bulk-array create path,
// delete/findById/truncate/update/updateBulk/updateProperty in the NON-racing case) is exercised via
// real HTTP+DB requests against its concrete subclasses (Contact/ContactList/Message/Attachment/
// CalendarEvent/CalendarShareLink/Task/Note) in test/routes/mongo/*.test.ts (and their sql/
// counterparts) - see in particular test/routes/mongo/ContactRoute.test.ts, which now covers
// delete/exists/truncate/updateBulk/updateProperty/bulk-create-with-one-denied-item for this shared
// base class.
//
// The route instance itself is still scaffolded through a real `ObjectFactory` (`newInstance(...,
// { initialize: false })`), not a bare `new TestScopedRoute()` - this registers the class and tags the
// instance the same way production DI does, while `initialize: false` deliberately skips the
// `@Config`/`@Logger`/`@Inject` injection and `@Init` phase, which is exactly what leaves `repoUtils`
// (and `aclUtils`) genuinely `undefined` for the guard-clause tests below to observe.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseScopedChildRoute } from "../../src/routes/BaseScopedChildRoute.js";

class TestScopedRoute extends BaseScopedChildRoute<any> {
    protected readonly scopeProperty = "folderUid";
}

function makeRes(): any {
    return {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn().mockReturnThis(),
    };
}

describe("BaseScopedChildRoute Tests (repoUtils guard clauses only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("count() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestScopedRoute>(TestScopedRoute, { initialize: false });
        const res = makeRes();

        await expect(
            route.count({}, { folderUid: "folder-1" }, res, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("delete() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestScopedRoute>(TestScopedRoute, { initialize: false });
        const req: any = {};

        await expect(
            route.delete("id-1", undefined, undefined, req, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("exists() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestScopedRoute>(TestScopedRoute, { initialize: false });
        const res = makeRes();

        await expect(route.exists("id-1", {}, res, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("find() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestScopedRoute>(TestScopedRoute, { initialize: false });

        await expect(route.find({}, { folderUid: "folder-1" }, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("findById() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestScopedRoute>(TestScopedRoute, { initialize: false });

        await expect(route.findById("id-1", {}, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("truncate() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestScopedRoute>(TestScopedRoute, { initialize: false });

        await expect(route.truncate({}, { folderUid: "folder-1" }, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("update() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestScopedRoute>(TestScopedRoute, { initialize: false });

        await expect(
            route.update("id-1", { uid: "id-1" } as any, undefined, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("updateProperty() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestScopedRoute>(TestScopedRoute, { initialize: false });

        await expect(
            route.updateProperty("id-1", "subject", "New Subject", { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });
});

class TestScopedRouteForTruncate extends BaseScopedChildRoute<any> {
    protected readonly scopeProperty = "folderUid";
    public checkedUids: string[] = [];
    protected async checkLegalHold(existing: any): Promise<void> {
        this.checkedUids.push(existing.uid);
    }
}

describe("BaseScopedChildRoute Tests (truncate() TOCTOU-scoping fix only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("Scopes the actual delete to exactly the uids that were snapshotted and checked, not the original filter re-run live against RepoUtils.truncate()'s own independent query.", async () => {
        const route = objectFactory.newInstance<TestScopedRouteForTruncate>(TestScopedRouteForTruncate, { initialize: false });
        const matched = [
            { uid: "msg-1", folderUid: "folder-1" },
            { uid: "msg-2", folderUid: "folder-1" },
        ];
        const truncateSpy = vi.fn().mockResolvedValue(undefined);
        (route as any).repoUtils = {
            find: vi.fn().mockResolvedValue(matched),
            truncate: truncateSpy,
        };
        (route as any).aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };

        await route.truncate({}, { folderUid: "folder-1" }, { uid: "user-1" } as any);

        // Every snapshotted record went through checkLegalHold() ...
        expect(route.checkedUids).toEqual(["msg-1", "msg-2"]);
        // ... and the actual delete names exactly those uids - a record matching `folderUid: "folder-1"`
        // that only starts existing AFTER this snapshot (e.g. mail delivered mid-request) is not in this
        // filter at all, so RepoUtils.truncate()'s own independent live re-query can't sweep it in
        // unchecked, unlike passing the original `{folderUid: "folder-1"}` filter straight through would.
        // One literal `eq()` per uid, never a comma-split `in(...)`.
        expect(truncateSpy.mock.calls).toEqual([
            [{ uid: "eq(msg-1)" }, { user: { uid: "user-1" }, ignoreACL: true }],
            [{ uid: "eq(msg-2)" }, { user: { uid: "user-1" }, ignoreACL: true }],
        ]);
        // The snapshot query itself is scoped by the permission-checked folder, as a literal.
        expect((route as any).repoUtils.find.mock.calls[0][0].folderUid).toBe("eq(folder-1)");
    });

    it("Never calls truncate() at all when nothing matches - nothing to check and nothing to delete.", async () => {
        const route = objectFactory.newInstance<TestScopedRouteForTruncate>(TestScopedRouteForTruncate, { initialize: false });
        const truncateSpy = vi.fn();
        (route as any).repoUtils = { find: vi.fn().mockResolvedValue([]), truncate: truncateSpy };
        (route as any).aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };

        await route.truncate({}, { folderUid: "folder-1" }, { uid: "user-1" } as any);

        expect(route.checkedUids).toEqual([]);
        expect(truncateSpy).not.toHaveBeenCalled();
    });
});
