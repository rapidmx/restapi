///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseKeyVaultRoute's private findOrCreateKeyVault(), reserved for the TOCTOU race its
// own doc comment describes - see test/routes/BaseEncryptionPolicyRoute.test.ts's identical rationale, which
// this mirrors exactly. Every other reachable behavior of this class is exercised via real HTTP+DB requests
// in test/routes/{mongo,sql}/KeyVaultRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseKeyVaultRoute } from "../../src/routes/BaseKeyVaultRoute.js";

class TestKeyVaultRoute extends BaseKeyVaultRoute<any, any> {
    protected keyVaultClass: any = class {
        constructor(props: any) {
            Object.assign(this, props);
        }
    };
    protected mailboxClass: any = class {};
    protected auditLogClass: any = class {};
}

describe("BaseKeyVaultRoute Tests (findOrCreateKeyVault() TOCTOU race only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    it("Returns the concurrent winner's row when create() throws a duplicate-key error but a row now exists.", async () => {
        const route = objectFactory.newInstance<TestKeyVaultRoute>(TestKeyVaultRoute, { initialize: false });
        const winner = { uid: "kv-1", mailboxUid: "mailbox-1", wrappedKeys: [], masterKeyWraps: [] };
        (route as any).keyVaultRepo = {
            find: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([winner]),
            create: vi.fn().mockRejectedValue(new Error("duplicate key")),
        };

        const result = await (route as any).findOrCreateKeyVault("mailbox-1");

        expect(result).toBe(winner);
    });

    it("Rethrows create()'s error when no row exists even after the race-recovery re-fetch (a real failure).", async () => {
        const route = objectFactory.newInstance<TestKeyVaultRoute>(TestKeyVaultRoute, { initialize: false });
        const error = new Error("connection reset");
        (route as any).keyVaultRepo = {
            find: vi.fn().mockResolvedValue([]),
            create: vi.fn().mockRejectedValue(error),
        };

        await expect((route as any).findOrCreateKeyVault("mailbox-1")).rejects.toThrow("connection reset");
    });
});
