///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseMailboxImportRoute's create() `!blobStore` defensive guard, reserved ONLY
// for the branch a real wired server can never exercise (DI always populates `blobStore` before a
// request can reach the route). Every other behavior is exercised via real HTTP+DB requests in
// test/routes/{mongo,sql}/MailboxImportRequestRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseMailboxImportRoute } from "../../src/routes/BaseMailboxImportRoute.js";

class TestMailboxImportRoute extends BaseMailboxImportRoute<any, any, any> {
    protected mailboxImportRequestClass: any = class {};
    protected mailboxClass: any = class {};
    protected folderClass: any = class {};
    protected auditLogClass: any = class {};
}

describe("BaseMailboxImportRoute Tests (blobStore guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("create() throws INTERNAL_ERROR when blobStore is not set.", async () => {
        const route = objectFactory.newInstance<TestMailboxImportRoute>(TestMailboxImportRoute, { initialize: false });
        // Pre-set every repo `init()` would otherwise build via a real `RepoUtils` (which needs real
        // `@Protect`-decorated entity classes to resolve an ACL, unlike these bare test doubles) - the
        // same "skip init()'s own repo construction" technique `BaseDataExportRoute.test.ts`'s identical
        // guard-clause test uses, isolating this test to the `!blobStore` branch alone.
        (route as any).requestRepo = {};
        (route as any).mailboxRepo = {};
        (route as any).folderRepo = {};
        const req: any = { rawBody: Buffer.from("From x\r\n\r\n") };

        await expect(
            route.create(req, "folder-1", "mbox", undefined, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });
});
