///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for the dependency guard of BaseMessageRoute.report(), which a real wired server can not reach (DI always populates
// `repoUtils` and `blobStore`). The endpoint's behaviour over a real datastore is `test/routes/messageReportSuite.ts`.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseMessageRoute } from "../../src/routes/BaseMessageRoute.js";

class TestMessageRoute extends BaseMessageRoute<any> {
    protected folderClass: any = class {};
}

describe("BaseMessageRoute.report() Tests (dependency guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("throws INTERNAL_ERROR when repoUtils or blobStore is not set.", async () => {
        const route: any = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });

        await expect(route.report("msg-1", { kind: "junk" }, {}, { uid: "user-1" })).rejects.toThrow(/internal error/i);

        route.repoUtils = {};
        await expect(route.report("msg-1", { kind: "junk" }, {}, { uid: "user-1" })).rejects.toThrow(/internal error/i);
    });
});
