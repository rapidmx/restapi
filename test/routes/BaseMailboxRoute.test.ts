///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseMailboxRoute, reserved ONLY for defensive guard branches a real wired
// server can never exercise (DI always populates `repoUtils`/an authenticated `user` before a request
// reaches a route's own body). Every other behavior (create's `!user` 403, the bulk-array create path,
// count's `!user` branch, exists' found/not-found and permission outcomes, autoProvision's real
// enabled/alias/domain logic) is exercised via real HTTP+DB requests in
// test/routes/mongo/MailboxRoute.test.ts + MailboxAutoProvision.test.ts (and their sql/ counterparts),
// matching this library's real-server-integration-test convention.
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
    protected folderClass: any = Object;

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

    it("autoProvision() throws AUTH_PERMISSION_FAILURE when no user is given.", async () => {
        const route = objectFactory.newInstance<TestMailboxRoute>(TestMailboxRoute, { initialize: false });

        await expect(route.autoProvision({} as any, undefined, undefined)).rejects.toThrow(/permission/i);
    });

    it("autoProvision() throws INTERNAL_ERROR when repoUtils is not set, before ever touching enabled/domains/alias config.", async () => {
        const route = objectFactory.newInstance<TestMailboxRoute>(TestMailboxRoute, { initialize: false });
        // `repoUtils` is checked before the (now DB-backed, async) verified-domains lookup, so this guard
        // is reachable with `initialize: false`'s otherwise-unconfigured defaults left untouched - no need
        // to hand-set autoProvisionEnabled/authServerUrl/domainClass here at all.

        await expect(route.autoProvision({} as any, undefined, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("delete() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMailboxRoute>(TestMailboxRoute, { initialize: false });

        await expect(route.delete("id-1", undefined, undefined, {} as any, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("truncate() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMailboxRoute>(TestMailboxRoute, { initialize: false });

        await expect(route.truncate({}, {}, { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });
});
