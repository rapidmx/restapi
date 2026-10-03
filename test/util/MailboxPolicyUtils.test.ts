///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { findOrCreateSingleton, findOrSeedMailboxPolicy, MAILBOX_POLICY_UID } from "../../src/util/MailboxPolicyUtils.js";

describe("MailboxPolicyUtils Tests", () => {
    class PolicyModel {
        constructor(data: any) {
            Object.assign(this, data);
        }
    }
    const seed = { defaultQuotaBytes: 10, autoProvisionEnabled: true, autoProvisionQuotaBytes: 20 };

    it("findOrCreateSingleton() returns the existing row without creating.", async () => {
        const row = { uid: "x" };
        const repo: any = { findOne: vi.fn().mockResolvedValue(row), create: vi.fn() };

        expect(await findOrCreateSingleton(repo, "x", { a: 1 })).toBe(row);
        expect(repo.create).not.toHaveBeenCalled();
    });

    it("findOrCreateSingleton() creates the row as the repository's model class, seeded with the uid.", async () => {
        const repo: any = { modelClass: PolicyModel, findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn(async (obj: any) => obj) };

        const created: any = await findOrCreateSingleton(repo, "x", { a: 1 });

        expect(created).toBeInstanceOf(PolicyModel);
        expect(created).toMatchObject({ a: 1, uid: "x" });
        expect(repo.create).toHaveBeenCalledWith(created, { ignoreACL: true });
    });

    it("findOrCreateSingleton() defaults the seed, returns the winner of a create race, and rethrows otherwise.", async () => {
        const winner = { uid: "x", winner: true };
        const raced: any = { findOne: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner), create: vi.fn().mockRejectedValue(new Error("dup")) };
        expect(await findOrCreateSingleton(raced, "x")).toBe(winner);

        const broken: any = { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockRejectedValue(new Error("down")) };
        await expect(findOrCreateSingleton(broken, "x")).rejects.toThrow("down");
    });

    it("findOrSeedMailboxPolicy() seeds the first row and returns its values, falling back per field to the seed.", async () => {
        const repo: any = { modelClass: PolicyModel, findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn(async (obj: any) => obj) };

        expect(await findOrSeedMailboxPolicy(repo, seed)).toEqual(seed);
        expect(repo.create.mock.calls[0][0]).toMatchObject({ ...seed, uid: MAILBOX_POLICY_UID });

        const stored: any = { findOne: vi.fn().mockResolvedValue({ defaultQuotaBytes: 1, autoProvisionEnabled: false }) };
        expect(await findOrSeedMailboxPolicy(stored, seed)).toEqual({ defaultQuotaBytes: 1, autoProvisionEnabled: false, autoProvisionQuotaBytes: 20 });
    });

    it("findOrSeedMailboxPolicy() falls back to the seed (logging) when the row can't be read, unless failClosed.", async () => {
        const repo: any = { findOne: vi.fn().mockRejectedValue(new Error("db down")) };
        const logger = { error: vi.fn() };

        expect(await findOrSeedMailboxPolicy(repo, seed, logger)).toEqual(seed);
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("using server config instead: db down"));
        // No logger is fine too.
        expect(await findOrSeedMailboxPolicy(repo, seed)).toEqual(seed);
    });

    it("findOrSeedMailboxPolicy() fills fields the saved row leaves null from the seed.", async () => {
        const repo: any = { findOne: vi.fn().mockResolvedValue({ uid: MAILBOX_POLICY_UID, autoProvisionEnabled: false, defaultQuotaBytes: null }) };

        expect(await findOrSeedMailboxPolicy(repo, seed)).toEqual({ defaultQuotaBytes: 10, autoProvisionEnabled: false, autoProvisionQuotaBytes: 20 });
    });

    it("findOrSeedMailboxPolicy() turns a failing read into a 503 when failClosed.", async () => {
        const repo: any = { findOne: vi.fn().mockRejectedValue(new Error("db down")) };
        const logger = { error: vi.fn() };

        await expect(findOrSeedMailboxPolicy(repo, seed, logger, true)).rejects.toMatchObject({ status: 503 });
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Could not read the mailbox policy: db down"));
        await expect(findOrSeedMailboxPolicy(repo, seed, undefined, true)).rejects.toMatchObject({ status: 503 });
    });
});
