///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseDataExportRoute's download() `!blobStore` defensive guard, reserved ONLY
// for the branch a real wired server can never exercise (DI always populates `blobStore` before a
// request can reach the route). Every other behavior is exercised via real HTTP+DB requests in
// test/routes/{mongo,sql}/DataExportRequestRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseDataExportRoute } from "../../src/routes/BaseDataExportRoute.js";

class TestDataExportRoute extends BaseDataExportRoute<any, any> {
    protected dataExportRequestClass: any = class {};
    protected mailboxClass: any = class {};
    protected auditLogClass: any = class {};
}

describe("BaseDataExportRoute Tests (blobStore guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("download() throws INTERNAL_ERROR when blobStore is not set.", async () => {
        const route = objectFactory.newInstance<TestDataExportRoute>(TestDataExportRoute, { initialize: false });
        // Pre-set both repos `init()` would otherwise build via a real `RepoUtils` (which needs real
        // `@Protect`-decorated entity classes to resolve an ACL, unlike these bare test doubles) - the
        // same "skip init()'s own repo construction" technique `BaseKeyVaultRoute.test.ts`'s identical
        // guard-clause tests use, isolating this test to the `!blobStore` branch alone.
        (route as any).requestRepo = {};
        (route as any).mailboxRepo = {};
        const res: any = { setHeader: vi.fn().mockReturnThis(), send: vi.fn() };

        await expect(route.download("id-1", res, { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });
});
