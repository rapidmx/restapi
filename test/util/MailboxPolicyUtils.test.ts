///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { findOrCreateSingleton, findOrSeedMailboxPolicy, MAILBOX_POLICY_UID } from "../../src/util/MailboxPolicyUtils.js";

class Row {
    constructor(fields: any) {
        Object.assign(this, fields);
    }
}

const seed = { defaultQuotaBytes: 10, autoProvisionEnabled: true, autoProvisionQuotaBytes: 20 };

describe("findOrCreateSingleton", () => {
    it("returns the existing row without creating one", async () => {
        const repo: any = { findOne: vi.fn().mockResolvedValue({ uid: "x" }), create: vi.fn() };
        expect(await findOrCreateSingleton(repo, Row, "x", { a: 1 })).toEqual({ uid: "x" });
        expect(repo.create).not.toHaveBeenCalled();
    });

    it("creates the row from the seed", async () => {
        const repo: any = { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn(async (row: any) => row) };
        expect(await findOrCreateSingleton(repo, Row, "x", { a: 1 })).toEqual(new Row({ a: 1, uid: "x" }));
    });

    it("returns the row a concurrent caller created first, and rethrows when there is none", async () => {
        const raced: any = { findOne: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ uid: "x", winner: true }), create: vi.fn().mockRejectedValue(new Error("duplicate key")) };
        expect(await findOrCreateSingleton(raced, Row, "x")).toEqual({ uid: "x", winner: true });

        const broken: any = { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockRejectedValue(new Error("disk full")) };
        await expect(findOrCreateSingleton(broken, Row, "x")).rejects.toThrow("disk full");
    });
});

describe("findOrSeedMailboxPolicy", () => {
    it("fills fields the saved row leaves unset from config", async () => {
        const repo = { findOne: vi.fn().mockResolvedValue({ uid: MAILBOX_POLICY_UID, autoProvisionEnabled: false, defaultQuotaBytes: null }) };
        const objectFactory: any = { newInstance: vi.fn().mockResolvedValue(repo) };
        expect(await findOrSeedMailboxPolicy(objectFactory, Row, seed)).toEqual({ defaultQuotaBytes: 10, autoProvisionEnabled: false, autoProvisionQuotaBytes: 20 });
    });

    it("falls back to config, with a warning, when the policy can't be read", async () => {
        const objectFactory: any = { newInstance: vi.fn().mockRejectedValue(new Error("datastore offline")) };
        const logger = { warn: vi.fn() };
        expect(await findOrSeedMailboxPolicy(objectFactory, Row, seed, logger)).toEqual(seed);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/datastore offline/));
        expect(await findOrSeedMailboxPolicy(objectFactory, Row, seed)).toEqual(seed);
    });
});
