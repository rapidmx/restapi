///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseKeyVaultRoute's private findOrCreateKeyVault() (the TOCTOU race its own doc
// comment describes - see test/routes/BaseEncryptionPolicyRoute.test.ts's identical rationale, which this
// mirrors exactly) and its mechanical MAX_*_EXCEEDED 400 validations in enrollKey()/addMasterKeyWrap()/
// rekey() - each guards a fixed-size-array-length check that's trivial to hit directly here but would need
// generating dozens of individually-valid wrap/key fixtures (plus real cert issuance for enrollKey()) to hit
// through test/routes/{mongo,sql}/KeyVaultRoute.test.ts's full HTTP+DB harness. Every other reachable
// behavior of this class is exercised there.
import config from "../config.js";
import { BaseEntity, ObjectFactory } from "@rapidrest/service-core";
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

describe("BaseKeyVaultRoute Tests (findOrCreateKeyVault() TOCTOU race and MAX_*_EXCEEDED validations)", () => {
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

    it("enrollKey() rejects more than MAX_MASTER_KEY_WRAPS master key wraps (400).", async () => {
        const route = objectFactory.newInstance<TestKeyVaultRoute>(TestKeyVaultRoute, { initialize: false });
        const user: any = { uid: "user-1" };
        const mailbox = { uid: "mailbox-1", ownerUserUid: "user-1", keys: [] };
        (route as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(mailbox) };
        (route as any).keyVaultRepo = {};
        (route as any).escrowScopeRepo = {};

        await expect(
            route.enrollKey(
                "mailbox-1",
                {
                    wrappedKey: { ciphertext: "c", nonce: "n", algorithm: "aes-gcm" },
                    masterKeyWraps: Array(21).fill({}),
                } as any,
                user,
            ),
        ).rejects.toThrow("masterKeyWraps cannot exceed 20 entries.");
    });

    it("enrollKey() rejects a mailbox that has already enrolled MAX_ENROLLED_KEYS keys (400).", async () => {
        const route = objectFactory.newInstance<TestKeyVaultRoute>(TestKeyVaultRoute, { initialize: false });
        const user: any = { uid: "user-1" };
        const mailbox = { uid: "mailbox-1", ownerUserUid: "user-1", keys: Array(50).fill({}) };
        (route as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(mailbox) };
        (route as any).keyVaultRepo = {};
        (route as any).escrowScopeRepo = {};

        await expect(
            route.enrollKey(
                "mailbox-1",
                { wrappedKey: { ciphertext: "c", nonce: "n", algorithm: "aes-gcm" }, masterKeyWraps: [] } as any,
                user,
            ),
        ).rejects.toThrow("A mailbox cannot enroll more than 50 keys.");
    });

    it("addMasterKeyWrap() rejects once a key vault already holds MAX_MASTER_KEY_WRAPS wraps (400).", async () => {
        const route = objectFactory.newInstance<TestKeyVaultRoute>(TestKeyVaultRoute, { initialize: false });
        const user: any = { uid: "user-1" };
        const mailbox = { uid: "mailbox-1", ownerUserUid: "user-1" };
        const keyVault = { uid: "kv-1", masterKeyWraps: Array(20).fill({}) };
        (route as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(mailbox) };
        (route as any).keyVaultRepo = { find: vi.fn().mockResolvedValue([keyVault]) };
        (route as any).escrowScopeRepo = {};

        await expect(
            route.addMasterKeyWrap(
                "mailbox-1",
                { method: "password", ciphertext: "c", nonce: "n", salt: "s", kdf: "argon2id", schemeVersion: 1 } as any,
                user,
            ),
        ).rejects.toThrow("A key vault cannot hold more than 20 master key wraps.");
    });

    it("rekey() rejects more than MAX_MASTER_KEY_WRAPS master key wraps (400).", async () => {
        const route = objectFactory.newInstance<TestKeyVaultRoute>(TestKeyVaultRoute, { initialize: false });
        const user: any = { uid: "user-1" };
        const mailbox = { uid: "mailbox-1", ownerUserUid: "user-1" };
        const keyVault = { uid: "kv-1" };
        (route as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(mailbox) };
        (route as any).keyVaultRepo = { find: vi.fn().mockResolvedValue([keyVault]) };
        (route as any).escrowScopeRepo = {};

        await expect(
            route.rekey("mailbox-1", { keys: [], wrappedKeys: [], masterKeyWraps: Array(21).fill({}) } as any, user),
        ).rejects.toThrow("masterKeyWraps cannot exceed 20 entries.");
    });

    it("rekey() rejects more than MAX_ENROLLED_KEYS wrapped keys (400).", async () => {
        const route = objectFactory.newInstance<TestKeyVaultRoute>(TestKeyVaultRoute, { initialize: false });
        const user: any = { uid: "user-1" };
        const mailbox = { uid: "mailbox-1", ownerUserUid: "user-1" };
        const keyVault = { uid: "kv-1" };
        (route as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(mailbox) };
        (route as any).keyVaultRepo = { find: vi.fn().mockResolvedValue([keyVault]) };
        (route as any).escrowScopeRepo = {};

        await expect(
            route.rekey("mailbox-1", { keys: [], wrappedKeys: Array(51).fill({}), masterKeyWraps: [passwordWrap] } as any, user),
        ).rejects.toThrow("wrappedKeys cannot exceed 50 entries.");
    });

    const passwordWrap = { method: "password", ciphertext: "c", nonce: "n", salt: "s", kdf: "argon2id", schemeVersion: 1 };

    it("rekey() requires keys, wrappedKeys and masterKeyWraps arrays, and at least one (non-escrow) master key wrap (400), before writing anything.", async () => {
        const route = objectFactory.newInstance<TestKeyVaultRoute>(TestKeyVaultRoute, { initialize: false });
        const user: any = { uid: "user-1" };
        const mailbox = { uid: "mailbox-1", ownerUserUid: "user-1", keys: [] };
        const update = vi.fn();
        (route as any).mailboxRepo = { findOne: vi.fn().mockResolvedValue(mailbox), update };
        (route as any).keyVaultRepo = { find: vi.fn().mockResolvedValue([{ uid: "kv-1", masterKeyWraps: [], wrappedKeys: [] }]), update };
        (route as any).escrowScopeRepo = {};

        const valid = { keys: [], wrappedKeys: [], masterKeyWraps: [passwordWrap] };
        const cases: [any, string][] = [
            [undefined, "wrappedKeys must be an array."],
            [{ ...valid, wrappedKeys: undefined }, "wrappedKeys must be an array."],
            [{ ...valid, masterKeyWraps: "x" }, "masterKeyWraps must be an array."],
            [{ ...valid, keys: undefined }, "keys must be an array."],
            [{ ...valid, masterKeyWraps: [] }, "masterKeyWraps must include at least one non-escrow wrap."],
        ];
        for (const [body, message] of cases) {
            const error: any = await route.rekey("mailbox-1", body, user).catch((err) => err);
            expect(error?.status).toBe(400);
            expect(error?.message).toBe(message);
        }
        expect(update).not.toHaveBeenCalled();
    });

    it("findKeyVault() returns an entity instance, so vault updates are version-checked on MongoDB (plain documents aren't).", async () => {
        class VaultEntity extends BaseEntity {
            constructor(other?: any) {
                super(other);
                Object.assign(this, other);
            }
        }
        const route = objectFactory.newInstance<TestKeyVaultRoute>(TestKeyVaultRoute, { initialize: false });
        const plain = { uid: "kv-1", version: 3, mailboxUid: "mailbox-1", wrappedKeys: [], masterKeyWraps: [] };
        (route as any).keyVaultRepo = { modelClass: VaultEntity, find: vi.fn().mockResolvedValue([plain]) };

        const vault = await (route as any).findKeyVault("mailbox-1");

        expect(vault).toBeInstanceOf(BaseEntity);
        expect(vault.version).toBe(3);
        expect(vault.uid).toBe("kv-1");
    });
});
