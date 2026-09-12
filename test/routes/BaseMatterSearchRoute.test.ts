///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseMatterSearchRoute's search() `!searchProvider` defensive guard, reserved
// ONLY for the branch a real wired server can never exercise (DI always populates `searchProvider` before
// a request can reach the route). Every other behavior is exercised via real HTTP requests in
// test/routes/{mongo,sql}/MatterSearchRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseMatterSearchRoute } from "../../src/routes/BaseMatterSearchRoute.js";

class TestMatterSearchRoute extends BaseMatterSearchRoute<any, any> {
    protected matterClass: any = class {};
    protected escrowScopeClass: any = class {};
    protected mailboxClass: any = class {};
}

describe("BaseMatterSearchRoute Tests (searchProvider guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("search() throws INTERNAL_ERROR when searchProvider is not set.", async () => {
        const route = objectFactory.newInstance<TestMatterSearchRoute>(TestMatterSearchRoute, { initialize: false });

        await expect(
            route.search(
                "matter-1",
                "hello",
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { uid: "user-1" } as any,
            ),
        ).rejects.toThrow(/internal error/i);
    });
});
