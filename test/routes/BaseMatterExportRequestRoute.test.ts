///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseMatterExportRequestRoute's download() `!blobStore` defensive guard,
// reserved ONLY for the branch a real wired server can never exercise (DI always populates `blobStore`
// before a request can reach the route). Every other behavior is exercised via real HTTP+DB requests in
// test/routes/{mongo,sql}/MatterExportRequestRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseMatterExportRequestRoute } from "../../src/routes/BaseMatterExportRequestRoute.js";

class TestMatterExportRequestRoute extends BaseMatterExportRequestRoute<any, any, any> {
    protected matterExportRequestClass: any = class {};
    protected matterClass: any = class {};
    protected mailboxClass: any = class {};
    protected escrowScopeClass: any = class {};
    protected escrowAuditLogClass: any = class {};
}

describe("BaseMatterExportRequestRoute Tests (blobStore guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("download() throws INTERNAL_ERROR when blobStore is not set.", async () => {
        const route = objectFactory.newInstance<TestMatterExportRequestRoute>(TestMatterExportRequestRoute, { initialize: false });
        // Pre-set both repos `init()` would otherwise build via a real `RepoUtils` (which needs real
        // `@Protect`-decorated entity classes to resolve an ACL, unlike these bare test doubles) - the
        // same "skip init()'s own repo construction" technique `BaseDataExportRoute.test.ts`'s identical
        // guard-clause test uses, isolating this test to the `!blobStore` branch alone.
        (route as any).requestRepo = {};
        (route as any).matterRepo = {};
        const res: any = { setHeader: vi.fn().mockReturnThis(), send: vi.fn() };

        await expect(route.download("id-1", res, { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });
});
