///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseDistributionListRoute's updateProperty()/updateBulk() guard clauses and loop, which route every write
// through update(). The full update() behavior is exercised through real HTTP+DB requests in test/routes/{mongo,sql}/DistributionListRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseDistributionListRoute } from "../../src/routes/BaseDistributionListRoute.js";

class TestDistributionListRoute extends BaseDistributionListRoute<any> {
    protected mailboxClass: any = class {};
    protected domainClass: any = class {};
    protected auditLogClass: any = class {};
}

describe("BaseDistributionListRoute Tests (updateProperty()/updateBulk() only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("updateProperty() answers 404 when the list does not exist.", async () => {
        const route: any = objectFactory.newInstance<TestDistributionListRoute>(TestDistributionListRoute, { initialize: false });
        route.repoUtils = { findOne: vi.fn().mockResolvedValue(undefined) };

        await expect(route.updateProperty("missing", "name", "x", { uid: "u1" })).rejects.toMatchObject({ status: 404 });
    });

    it("updateProperty() writes the one property through update().", async () => {
        const route: any = objectFactory.newInstance<TestDistributionListRoute>(TestDistributionListRoute, { initialize: false });
        route.repoUtils = { findOne: vi.fn().mockResolvedValue({ uid: "l1", version: 3 }) };
        const update = vi.spyOn(route, "update").mockResolvedValue({ uid: "l1" } as any);

        await route.updateProperty("l1", "name", "x", { uid: "u1" });

        expect(update).toHaveBeenCalledWith("l1", { uid: "l1", version: 3, name: "x" }, undefined, { uid: "u1" });
    });

    it("updateBulk() answers 400 for a body that is not an array.", async () => {
        const route: any = objectFactory.newInstance<TestDistributionListRoute>(TestDistributionListRoute, { initialize: false });

        await expect(route.updateBulk({ uid: "l1" }, {}, { uid: "u1" })).rejects.toMatchObject({ status: 400 });
    });

    it("updateBulk() sends each entry through update() and returns the results in order.", async () => {
        const route: any = objectFactory.newInstance<TestDistributionListRoute>(TestDistributionListRoute, { initialize: false });
        const update = vi.spyOn(route, "update").mockImplementation(async (id: string) => ({ uid: id }) as any);
        const req: any = {};
        const user: any = { uid: "u1" };

        const result = await route.updateBulk([{ uid: "l1" }, { uid: "l2" }], req, user);

        expect(result).toEqual([{ uid: "l1" }, { uid: "l2" }]);
        expect(update).toHaveBeenNthCalledWith(1, "l1", { uid: "l1" }, req, user);
        expect(update).toHaveBeenNthCalledWith(2, "l2", { uid: "l2" }, req, user);
    });
});
