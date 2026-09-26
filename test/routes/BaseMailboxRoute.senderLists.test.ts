///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for the defensive branches of the sender-list endpoints of BaseMailboxRoute that a real wired server can not reach
// (DI always populates `repoUtils`, and a mailbox the caller just proved access to does not vanish) - the endpoints' behaviour over a real
// datastore is `test/routes/senderListsRouteSuite.ts`.
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

describe("BaseMailboxRoute sender list endpoints Tests (defensive branches only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());
    const user: any = { uid: "user-1" };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        ["blockSender", (route: any) => route.blockSender("m1", { entry: "a@x.example" }, user)],
        ["unblockSender", (route: any) => route.unblockSender("m1", "a@x.example", user)],
        ["trustSender", (route: any) => route.trustSender("m1", { entry: "a@x.example" }, user)],
        ["untrustSender", (route: any) => route.untrustSender("m1", "a@x.example", user)],
    ])("%s() throws INTERNAL_ERROR when repoUtils is not set.", async (_name, call) => {
        const route = objectFactory.newInstance<TestMailboxRoute>(TestMailboxRoute, { initialize: false });

        await expect(call(route)).rejects.toThrow(/internal error/i);
    });

    it("Answers 404 when the mailbox is gone by the time the change is made.", async () => {
        const route: any = objectFactory.newInstance<TestMailboxRoute>(TestMailboxRoute, { initialize: false });
        route.repoUtils = { findOne: vi.fn().mockResolvedValue(undefined) };
        route.hasMailAccess = vi.fn().mockResolvedValue(true);

        await expect(route.blockSender("m1", { entry: "a@x.example" }, user)).rejects.toMatchObject({ status: 404 });
    });
});
