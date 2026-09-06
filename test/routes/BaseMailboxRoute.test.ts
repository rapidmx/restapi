///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseMailboxRoute, reserved ONLY for the `!this.repoUtils` defensive guard
// branches that a real wired server can never exercise (DI always populates `repoUtils` before a
// request can reach a route). Every other behavior (create's `!user` 403, the bulk-array create path,
// count's `!user` branch, exists' found/not-found and permission outcomes) is exercised via real
// HTTP+DB requests in test/routes/mongo/MailboxRoute.test.ts (and its sql/ counterpart), matching this
// library's real-server-integration-test convention.
//
// The route instance itself is still scaffolded through a real `ObjectFactory` (`newInstance(...,
// { initialize: false })`), not a bare `new TestMailboxRoute()` - this registers the class and tags the
// instance the same way production DI does, while `initialize: false` deliberately skips the
// `@Config`/`@Logger`/`@Inject` injection and `@Init` phase, which is exactly what leaves `repoUtils`
// (and `aclUtils`) genuinely `undefined` for these guard-clause tests to observe.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseMailboxRoute } from "../../src/routes/BaseMailboxRoute.js";

class TestMailboxRoute extends BaseMailboxRoute<any> {
    protected async findAccessibleMailboxUids(): Promise<string[]> {
        return [];
    }
}

function makeRes(): any {
    return {
        status: vi.fn().mockReturnThis(),
        setHeader: vi.fn().mockReturnThis(),
    };
}

describe("BaseMailboxRoute Tests (repoUtils guard clauses only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("count() returns a zero-length count without throwing when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMailboxRoute>(TestMailboxRoute, { initialize: false });
        const res = makeRes();

        const result = await route.count({}, {}, res, { uid: "user-1" } as any);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.setHeader).toHaveBeenCalledWith("content-length", 0);
        expect(result).toBe(res);
    });

    it("exists() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMailboxRoute>(TestMailboxRoute, { initialize: false });
        const res = makeRes();

        await expect(route.exists("id-1", {}, res, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });
});
