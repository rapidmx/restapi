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
});
