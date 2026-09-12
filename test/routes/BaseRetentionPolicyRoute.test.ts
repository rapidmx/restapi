///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseRetentionPolicyRoute's private findOrCreate(), reserved for the TOCTOU race
// its own doc comment describes - see test/routes/BaseBrandingRoute.test.ts's identical rationale, which
// this mirrors exactly. Every other reachable behavior of this class is exercised via real HTTP+DB
// requests in test/routes/{mongo,sql}/RetentionPolicyRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseRetentionPolicyRoute } from "../../src/routes/BaseRetentionPolicyRoute.js";

class TestRetentionPolicyRoute extends BaseRetentionPolicyRoute<any> {
    protected retentionPolicyClass: any = class {
        constructor(props: any) {
            Object.assign(this, props);
        }
    };
    protected auditLogClass: any = class {};
}

describe("BaseRetentionPolicyRoute Tests (findOrCreate() TOCTOU race only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("Returns the concurrent winner's row when create() throws a duplicate-key error but a row now exists.", async () => {
        const route = objectFactory.newInstance<TestRetentionPolicyRoute>(TestRetentionPolicyRoute, { initialize: false });
        const winner = { uid: "retention-policy", messageRetentionDays: 365 };
        (route as any).retentionPolicyRepo = {
            findOne: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner),
            create: vi.fn().mockRejectedValue(new Error("duplicate key")),
        };

        const result = await (route as any).findOrCreate();

        expect(result).toBe(winner);
    });

    it("Rethrows create()'s error when no row exists even after the race-recovery re-fetch (a real failure).", async () => {
        const route = objectFactory.newInstance<TestRetentionPolicyRoute>(TestRetentionPolicyRoute, { initialize: false });
        const error = new Error("connection reset");
        (route as any).retentionPolicyRepo = {
            findOne: vi.fn().mockResolvedValue(undefined),
            create: vi.fn().mockRejectedValue(error),
        };

        await expect((route as any).findOrCreate()).rejects.toThrow("connection reset");
    });
});
