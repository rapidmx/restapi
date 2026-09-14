///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for the non-array guard on BaseDomainRoute/BaseEscrowScopeRoute's updateBulk() overrides -
// over real HTTP the framework's own bulk validation rejects a non-array body before the handler runs, so the
// guard itself is only reachable by calling the method directly. The rest of both overrides is exercised over HTTP
// in test/routes/writeGuardsSuite.ts and test/routes/escrowControlsSuite.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseDomainRoute } from "../../src/routes/BaseDomainRoute.js";
import { BaseEscrowScopeRoute } from "../../src/routes/BaseEscrowScopeRoute.js";

class TestDomainRoute extends BaseDomainRoute<any> {
    protected auditLogClass: any = class {};
}

class TestEscrowScopeRoute extends BaseEscrowScopeRoute<any> {
    protected auditLogClass: any = class {};
    protected matterClass: any = class {};
    protected escrowAccessRequestClass: any = class {};
}

describe("Admin write guard Tests (updateBulk() non-array bodies)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("BaseDomainRoute.updateBulk() rejects a non-array body (400).", async () => {
        const route = objectFactory.newInstance<TestDomainRoute>(TestDomainRoute, { initialize: false });

        await expect(route.updateBulk({} as any, {} as any)).rejects.toMatchObject({ status: 400 });
    });

    it("BaseEscrowScopeRoute.updateBulk() rejects a non-array body (400).", async () => {
        const route = objectFactory.newInstance<TestEscrowScopeRoute>(TestEscrowScopeRoute, { initialize: false });

        await expect(route.updateBulk({} as any, {} as any)).rejects.toMatchObject({ status: 400 });
    });
});
