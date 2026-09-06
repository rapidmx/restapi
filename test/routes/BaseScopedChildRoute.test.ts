///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseScopedChildRoute, reserved ONLY for the `!this.repoUtils` defensive guard
// branches that a real wired server can never exercise (DI always populates `repoUtils` before a
// request can reach a route). Every other behavior of this generic base class (permission
// grant/denial outcomes, not-found handling, the bulk-array create path, delete/findById/truncate/
// update/updateBulk/updateProperty) is exercised via real HTTP+DB requests against its concrete
// subclasses (Contact/ContactList/Message/Attachment/CalendarEvent/CalendarShareLink/Task/Note) in
// test/routes/mongo/*.test.ts (and their sql/ counterparts) - see in particular
// test/routes/mongo/ContactRoute.test.ts, which now covers delete/exists/truncate/updateBulk/
// updateProperty/bulk-create-with-one-denied-item for this shared base class.
//
// The route instance itself is still scaffolded through a real `ObjectFactory` (`newInstance(...,
// { initialize: false })`), not a bare `new TestScopedRoute()` - this registers the class and tags the
// instance the same way production DI does, while `initialize: false` deliberately skips the
// `@Config`/`@Logger`/`@Inject` injection and `@Init` phase, which is exactly what leaves `repoUtils`
// (and `aclUtils`) genuinely `undefined` for these guard-clause tests to observe.
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
