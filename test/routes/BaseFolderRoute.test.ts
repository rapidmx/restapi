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
