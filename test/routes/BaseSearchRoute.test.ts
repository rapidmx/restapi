///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseSearchRoute, reserved ONLY for the `!this.searchProvider` defensive guard
// that a real wired server can never exercise (DI always populates it before a request can reach the
// route). Every other behavior - unauthenticated (401), missing query text (400), no owned mailbox
// (404), a successful search with and without a `types` filter, and a provided `limit` query parameter
// - is exercised via real HTTP+DB requests in test/routes/mongo/SearchRoute.test.ts (and its sql/
// counterpart).
//
// The route instance itself is still scaffolded through a real `ObjectFactory` (`newInstance(...,
// { initialize: false })`), not a bare `new TestSearchRoute()` - this registers the class and tags the
// instance the same way production DI does, while `initialize: false` deliberately skips the
// `@Config`/`@Logger`/`@Inject` injection and `@Init` phase, which is exactly what leaves
// `searchProvider` genuinely `undefined` for this guard-clause test to observe.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseSearchRoute } from "../../src/routes/BaseSearchRoute.js";

class TestSearchRoute extends BaseSearchRoute<any> {
    protected mailboxClass: any = class {};
}

describe("BaseSearchRoute Tests (searchProvider guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("search() throws INTERNAL_ERROR when searchProvider is not set.", async () => {
        const route = objectFactory.newInstance<TestSearchRoute>(TestSearchRoute, { initialize: false });

        await expect(
            route.search("hello", undefined, undefined, undefined, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("candidates() throws INTERNAL_ERROR when searchProvider is not set.", async () => {
        const route = objectFactory.newInstance<TestSearchRoute>(TestSearchRoute, { initialize: false });

        await expect(
            route.candidates(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
                uid: "user-1",
            } as any),
        ).rejects.toThrow(/internal error/i);
    });
});

// Isolated unit test for requireCallerMailboxUid()'s `!user` guard - unreachable via HTTP since
// `@Auth(["jwt"])` already returns 401 before the handler body runs for any unauthenticated request (see
// test/routes/{mongo,sql}/SearchRoute.test.ts's own "Requires authentication." tests), the same
// dispatcher-vs-direct-call gap as BaseScopedChildRoute's repoUtils guard clauses.
class TestSearchRouteWithProvider extends BaseSearchRoute<any> {
    protected mailboxClass: any = class {};
}

describe("BaseSearchRoute Tests (requireCallerMailboxUid() !user guard only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("search() throws INVALID_REQUEST when no user is present, even with searchProvider set.", async () => {
        const route = objectFactory.newInstance<TestSearchRouteWithProvider>(TestSearchRouteWithProvider, { initialize: false });
        (route as any).searchProvider = { search: vi.fn() };

        await expect(route.search("hello", undefined, undefined, undefined, undefined)).rejects.toThrow(
            /invalid (message or )?request/i,
        );
    });
});
