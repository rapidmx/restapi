///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseSetupRoute.saveStep()'s retry of a save that lost a concurrent save's race - deterministic
// here, where the real HTTP+DB suite (test/routes/systemSettingsSuite.ts) can only race for real. Every other behavior
// of this class is exercised there.
import config from "../config.js";
import { ApiErrorMessages, ApiErrors, ObjectFactory } from "@rapidrest/service-core";
import { ApiError, Logger } from "@rapidrest/core";
import { BaseSetupRoute } from "../../src/routes/BaseSetupRoute.js";

class TestSetupRoute extends BaseSetupRoute<any> {
    protected setupStateClass: any = class {};
    protected domainClass: any = class {};
    protected auditLogClass: any = class {};
}

describe("BaseSetupRoute Tests (saveStep() retry only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());
    const conflict = () => new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, ApiErrorMessages.INVALID_OBJECT_VERSION);

    function newRoute(update: any): any {
        const route: any = objectFactory.newInstance<TestSetupRoute>(TestSetupRoute, { initialize: false });
        route.repo = { findOne: vi.fn().mockResolvedValue({ uid: "setup-state", version: 1, startedAt: new Date(0) }), update };
        route.domainRepo = { find: vi.fn().mockResolvedValue([]) };
        return route;
    }

    it("re-reads and retries a save that lost the race, including one reported as a 500", async () => {
        const update = vi
            .fn()
            .mockRejectedValueOnce(conflict())
            .mockRejectedValueOnce(new ApiError(ApiErrors.INTERNAL_ERROR, 500, ApiErrorMessages.INTERNAL_ERROR))
            .mockResolvedValue({ uid: "setup-state", startedAt: new Date(0), currentStep: "domain" });
        const route = newRoute(update);
        expect(await route.saveStep({ currentStep: "domain" })).toEqual(expect.objectContaining({ required: true, currentStep: "domain" }));
        expect(update).toHaveBeenCalledTimes(3);
        expect(route.repo.findOne).toHaveBeenCalledTimes(3);
    });

    it("gives up after a few attempts, and never retries any other error", async () => {
        const always = newRoute(vi.fn().mockRejectedValue(conflict()));
        await expect(always.saveStep({ currentStep: "domain" })).rejects.toMatchObject({ status: 409 });
        expect(always.repo.update).toHaveBeenCalledTimes(5);

        const broken = newRoute(vi.fn().mockRejectedValue(new Error("disk full")));
        await expect(broken.saveStep({ currentStep: "domain" })).rejects.toThrow("disk full");
        expect(broken.repo.update).toHaveBeenCalledTimes(1);

        const invalid = newRoute(vi.fn().mockRejectedValue(new ApiError(ApiErrors.INVALID_REQUEST, 400, "nope")));
        await expect(invalid.saveStep({ currentStep: "domain" })).rejects.toMatchObject({ status: 400 });
        expect(invalid.repo.update).toHaveBeenCalledTimes(1);
    });
});
