///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The default rollout check (spec 5.7): a deployment outside Kubernetes has no older pods to wait for.
import { NullServerRolloutCheck, resolveServerRolloutCheck, UnavailableServerRolloutCheck } from "../../src/plugins/ServerRolloutCheck.js";

describe("NullServerRolloutCheck", () => {
    it("answers that the rollout has finished, with no reason, every time", async () => {
        const check = new NullServerRolloutCheck();
        expect(await check.check()).toEqual({ rolledOut: true });
        expect(await check.check()).toEqual({ rolledOut: true });
    });
});

describe("resolveServerRolloutCheck()", () => {
    it("is the check the server registered under \"ServerRolloutCheck\"", async () => {
        const registered = { check: async () => ({ rolledOut: false, reason: "Old pods." }) };
        const newInstance = vi.fn(async () => registered);
        expect(await resolveServerRolloutCheck({ newInstance })).toBe(registered);
        expect(newInstance).toHaveBeenCalledWith("ServerRolloutCheck", { name: "default" });
    });

    it("is the default check on a server that registers none: no object factory, nothing resolved or the factory's \"No class found\" answer", async () => {
        const none = async (): Promise<never> => {
            throw new Error("No class found with name: ServerRolloutCheck");
        };
        for (const factory of [undefined, { newInstance: async () => undefined }, { newInstance: none }]) {
            expect(await resolveServerRolloutCheck(factory, undefined, {})).toBeInstanceOf(NullServerRolloutCheck);
        }
    });

    it("is a check that can't tell, never the default, when the registered class fails to build or start", async () => {
        const logger = { error: vi.fn(), warn: vi.fn() };
        const newInstance = async (): Promise<never> => {
            throw new Error("projected token not mounted");
        };
        const check = await resolveServerRolloutCheck({ newInstance }, logger, {});
        expect(check).toBeInstanceOf(UnavailableServerRolloutCheck);
        await expect(check.check()).rejects.toThrow("projected token not mounted");
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("projected token not mounted"));
    });

    it("is a check that can't tell on a server running in Kubernetes that registers none, since it can't know the rollout is over", async () => {
        const logger = { error: vi.fn(), warn: vi.fn() };
        const env = { KUBERNETES_SERVICE_HOST: "10.0.0.1" };
        const check = await resolveServerRolloutCheck(undefined, logger, env);
        expect(check).toBeInstanceOf(UnavailableServerRolloutCheck);
        await expect(check.check()).rejects.toThrow(/wait_for_rollout/);
        expect(logger.warn).toHaveBeenCalled();
        // Without a logger it is the same check.
        expect(await resolveServerRolloutCheck({ newInstance: async () => undefined }, undefined, env)).toBeInstanceOf(UnavailableServerRolloutCheck);
    });

    it("lets the process environment decide by default", async () => {
        expect(await resolveServerRolloutCheck(undefined)).toBeInstanceOf(process.env.KUBERNETES_SERVICE_HOST ? UnavailableServerRolloutCheck : NullServerRolloutCheck);
    });
});
