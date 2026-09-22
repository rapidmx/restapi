///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for the non-array guard on BaseDomainRoute/BaseEscrowScopeRoute/BaseMatterRoute's updateBulk()
// overrides - over real HTTP the framework's own bulk validation rejects a non-array body before the handler runs, so
// the guard itself is only reachable by calling the method directly. The rest of these overrides is exercised over
// HTTP in test/routes/writeGuardsSuite.ts and test/routes/escrowControlsSuite.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseDomainRoute } from "../../src/routes/BaseDomainRoute.js";
import { BaseEscrowScopeRoute } from "../../src/routes/BaseEscrowScopeRoute.js";
import { BaseMatterRoute } from "../../src/routes/BaseMatterRoute.js";

class TestDomainRoute extends BaseDomainRoute<any> {
    protected auditLogClass: any = class {};
}

class TestEscrowScopeRoute extends BaseEscrowScopeRoute<any> {
    protected auditLogClass: any = class {};
    protected matterClass: any = class {};
    protected escrowAccessRequestClass: any = class {};
    protected mailboxClass: any = class {};
}

class TestMatterRoute extends BaseMatterRoute<any> {
    protected escrowScopeClass: any = class {};
    protected auditLogClass: any = class {};
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

        // A trusted, elevated caller - assertAdminScope() runs first in every action on this route (see its own
        // doc comment), so an unauthorized caller would be refused before ever reaching this guard, not with a 400.
        await expect(route.updateBulk({} as any, {} as any, { uid: "admin", roles: ["admin"], elevated: Date.now() } as any)).rejects.toMatchObject({
            status: 400,
        });
    });

    it("BaseMatterRoute.updateBulk() rejects a non-array body (400), including an iterable string.", async () => {
        const route = objectFactory.newInstance<TestMatterRoute>(TestMatterRoute, { initialize: false });

        await expect(route.updateBulk({} as any, {} as any)).rejects.toMatchObject({ status: 400 });
        await expect(route.updateBulk("ab" as any, {} as any)).rejects.toMatchObject({ status: 400 });
    });
});
