///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `PluginSecretEncryptor` (spec 5.7), identical on both backends: the run that encrypts plugin secret settings still saved in plaintext, in place on the plugin's
// own row, once no pod of an older release is left. Each value is encrypted for its row and setting and audited per key without the value; the first completed
// run records `encryptedAt`, from which point saves encrypt; running it again changes nothing; an uninstalled plugin's plaintext secrets are dropped; it waits for
// the rollout and for another copy; a failure leaves the row as it was; two replicas encrypting at once encrypt each value once; nothing here fails the server's
// start.
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { AuditAction } from "../../src/models/types.js";
import { isConfigEnvelope } from "../../src/secrets/ConfigCipher.js";
import { PLUGIN_API_VERSION, pluginSecretContext } from "../../src/plugins/PluginUtils.js";
import { CONFIG_KEY_STATE_UID } from "../../src/secrets/ConfigKeyring.js";
import type { InMemoryServerRolloutCheck } from "../testDoubles.js";

export interface PluginSecretEncryptionSuiteContext {
    /** A new encryptor, as the server builds one at startup (or another replica does). */
    newEncryptor: () => Promise<any>;
    /** Saves a plugin row with these fields (and defaults for the rest), as an older server would have. */
    insertPlugin: (fields: Record<string, unknown>) => Promise<void>;
    /** Every plugin row, by name. */
    rows: () => Promise<Record<string, any>>;
    /** Bumps a row's optimistic-lock version directly, as a concurrent change would. */
    bumpVersion: (uid: string) => Promise<void>;
    auditEntries: () => Promise<any[]>;
    /** The key state row, or nothing. */
    state: () => Promise<any | null | undefined>;
    /** Saves the key state row with these fields (and its uid), replacing what was there. */
    saveState: (fields: Record<string, unknown>) => Promise<void>;
    clearState: () => Promise<void>;
    /** The rollout check the encryptors resolve (a test double, reset before each test). */
    rollout: () => InMemoryServerRolloutCheck;
}

const MANIFEST = {
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Vault",
    settings: [
        { key: "mail:v:api_key", label: "API key", type: "string" },
        { key: "mail:v:pin", label: "PIN", type: "number", secret: true },
        { key: "mail:v:note", label: "Note", type: "string" },
        { key: "mail:v:empty_token", label: "Empty token", type: "string" },
    ],
};

export function pluginSecretEncryptionSuite(ctx: PluginSecretEncryptionSuiteContext): void {
    describe("PluginSecretEncryptor", () => {
        const encryptions = async () => (await ctx.auditEntries()).filter((entry) => entry.action === AuditAction.PLUGIN_SECRET_MIGRATED);
        /** The value an envelope of `key` on row `uid` holds. */
        const open = async (encryptor: any, uid: string, key: string, envelope: any) => encryptor.cipher.decrypt(envelope, pluginSecretContext(uid, key));

        async function insertVault(fields: Record<string, unknown> = {}): Promise<void> {
            await ctx.insertPlugin({
                name: "@rapidmx/vault",
                packageVersion: "1.0.0",
                enabled: true,
                removed: false,
                settings: { "mail:v:api_key": "s3cr3t", "mail:v:pin": 4321, "mail:v:note": "hi", "mail:v:empty_token": "" },
                manifest: MANIFEST,
                ...fields,
            });
        }

        beforeEach(async () => {
            await ctx.clearState();
            ctx.rollout().reset();
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("encrypts every plaintext secret setting in place, the row keeping an envelope bound to its row and setting, audited per key without the value", async () => {
            await insertVault();
            await ctx.insertPlugin({ name: "@rapidmx/plain", packageVersion: "1.0.0", enabled: true, removed: false, settings: { "mail:p:note": "hi" }, manifest: MANIFEST });
            const { "@rapidmx/plain": plainBefore, "@rapidmx/vault": vaultBefore } = await ctx.rows();
            const encryptor = await ctx.newEncryptor();

            const result = await encryptor.run();

            expect(result).toEqual({
                encrypted: [
                    { name: "@rapidmx/vault", key: "mail:v:api_key" },
                    { name: "@rapidmx/vault", key: "mail:v:pin" },
                ],
                dropped: [],
                remaining: [],
                completed: true,
            });
            const rows = await ctx.rows();
            const vault = rows["@rapidmx/vault"];
            expect(isConfigEnvelope(vault.settings["mail:v:api_key"])).toBe(true);
            expect(await open(encryptor, vault.uid, "mail:v:api_key", vault.settings["mail:v:api_key"])).toBe("s3cr3t");
            // A number stays a number, and an envelope opens for no other row or setting.
            expect(await open(encryptor, vault.uid, "mail:v:pin", vault.settings["mail:v:pin"])).toBe(4321);
            expect(() => encryptor.cipher.decrypt(vault.settings["mail:v:pin"], pluginSecretContext(vault.uid, "mail:v:api_key"))).toThrow();
            expect(() => encryptor.cipher.decrypt(vault.settings["mail:v:pin"], pluginSecretContext("another-row", "mail:v:pin"))).toThrow();
            // Settings that aren't secrets, and an empty secret (which nothing treats as set), stay as they were; a row without secrets isn't written.
            expect(vault.settings["mail:v:note"]).toBe("hi");
            expect(vault.settings["mail:v:empty_token"]).toBe("");
            expect(vault.version).toBeGreaterThan(vaultBefore.version);
            expect(JSON.stringify(rows)).not.toContain("s3cr3t");
            expect(rows["@rapidmx/plain"].version).toBe(plainBefore.version);

            const audits = await encryptions();
            expect(audits.map((entry) => [entry.targetType, entry.targetUid, entry.details, entry.actorUserUid ?? undefined])).toEqual(
                expect.arrayContaining([
                    ["Plugin", vault.uid, { name: "@rapidmx/vault", key: "mail:v:api_key" }, undefined],
                    ["Plugin", vault.uid, { name: "@rapidmx/vault", key: "mail:v:pin" }, undefined],
                ]),
            );
            expect(audits).toHaveLength(2);
            expect(JSON.stringify(audits)).not.toContain("s3cr3t");
            expect(JSON.stringify(audits)).not.toContain("4321");
        });

        it("records encryptedAt on the key state row with its first completed run, from which point saves encrypt", async () => {
            await insertVault();
            expect(await ctx.state()).toBeFalsy();

            const before = Date.now();
            await (await ctx.newEncryptor()).run();

            const state = await ctx.state();
            expect(state.uid).toBe(CONFIG_KEY_STATE_UID);
            expect(new Date(state.pluginSecrets.encryptedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
            expect(state.pluginSecrets.waitingForRollout).toBe(false);
            expect(state.pluginSecrets.reason ?? undefined).toBeUndefined();
        });

        it("keeps the rest of an existing key state row, and sets encryptedAt on it", async () => {
            await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: "te5tkey1", pluginSecrets: { waitingForRollout: true, reason: "Old pods are still running." } });
            await (await ctx.newEncryptor()).run();

            const state = await ctx.state();
            expect(state.activeKid).toBe("te5tkey1");
            expect(state.pluginSecrets.encryptedAt).toBeTruthy();
            expect(state.pluginSecrets.waitingForRollout).toBe(false);
            expect(state.pluginSecrets.reason ?? undefined).toBeUndefined();
        });

        it("with no plugin installed it completes at once, which is all a deployment with no secret setting needs", async () => {
            expect(await (await ctx.newEncryptor()).run()).toEqual({ encrypted: [], dropped: [], remaining: [], completed: true });
            expect((await ctx.state()).pluginSecrets.encryptedAt).toBeTruthy();
        });

        it("is idempotent: the next start finds nothing to encrypt, writes nothing and doesn't ask about the rollout again", async () => {
            await insertVault();
            await (await ctx.newEncryptor()).run();
            const before = await ctx.rows();
            const state = await ctx.state();
            ctx.rollout().checks = 0;
            ctx.rollout().answer = { rolledOut: false, reason: "Old pods are back." };

            expect(await (await ctx.newEncryptor()).run()).toEqual({ encrypted: [], dropped: [], remaining: [], completed: true });
            expect(await ctx.rows()).toEqual(before);
            expect(await ctx.state()).toEqual(state);
            expect(ctx.rollout().checks).toBe(0);
            expect(await encryptions()).toHaveLength(2);
        });

        it("encrypts what an older pod saved in plaintext after the first run, at the next start, without asking about the rollout", async () => {
            await (await ctx.newEncryptor()).run();
            await insertVault();
            ctx.rollout().checks = 0;

            const result = await (await ctx.newEncryptor()).run();

            expect(result.encrypted).toHaveLength(2);
            expect(result.completed).toBe(true);
            expect(isConfigEnvelope((await ctx.rows())["@rapidmx/vault"].settings["mail:v:pin"])).toBe(true);
            expect(ctx.rollout().checks).toBe(0);
        });

        it("drops an uninstalled plugin's plaintext secrets rather than encrypting them: adding it again starts from its defaults", async () => {
            await insertVault({ enabled: false, removed: true });

            const result = await (await ctx.newEncryptor()).run();

            expect(result).toEqual({
                encrypted: [],
                dropped: [
                    { name: "@rapidmx/vault", key: "mail:v:api_key" },
                    { name: "@rapidmx/vault", key: "mail:v:pin" },
                ],
                remaining: [],
                completed: true,
            });
            expect((await ctx.rows())["@rapidmx/vault"].settings).toEqual({ "mail:v:note": "hi", "mail:v:empty_token": "" });
            expect((await encryptions()).map((entry) => entry.details)).toEqual(
                expect.arrayContaining([
                    { name: "@rapidmx/vault", key: "mail:v:api_key", dropped: true },
                    { name: "@rapidmx/vault", key: "mail:v:pin", dropped: true },
                ]),
            );
        });

        describe("the rollout", () => {
            it("waits while pods of an older release run: nothing is encrypted, and the key state row says why", async () => {
                await insertVault();
                const before = await ctx.rows();
                ctx.rollout().answer = { rolledOut: false, reason: "Pods of the previous release are still running: mail-server-6d4f9-abcde." };

                const result = await (await ctx.newEncryptor()).run();

                expect(result).toEqual({
                    encrypted: [],
                    dropped: [],
                    remaining: [],
                    completed: false,
                    waiting: "Pods of the previous release are still running: mail-server-6d4f9-abcde.",
                });
                expect(await ctx.rows()).toEqual(before);
                expect(await encryptions()).toHaveLength(0);
                const state = await ctx.state();
                expect(state.pluginSecrets.encryptedAt ?? undefined).toBeUndefined();
                expect(state.pluginSecrets.waitingForRollout).toBe(true);
                expect(state.pluginSecrets.reason).toBe("Pods of the previous release are still running: mail-server-6d4f9-abcde.");
                expect(Math.abs(new Date(state.pluginSecrets.checkedAt).getTime() - Date.now())).toBeLessThan(60_000);
            });

            it("waits, and says so, when the pods can't be listed, logging the failure once and never throwing", async () => {
                await insertVault();
                const before = await ctx.rows();
                const encryptor = await ctx.newEncryptor();
                const warn = vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);
                ctx.rollout().fail = new Error("pods is forbidden");

                const first = await encryptor.run();
                const second = await encryptor.run();

                for (const result of [first, second]) {
                    expect(result.completed).toBe(false);
                    expect(result.waiting).toMatch(/pods can't be listed/);
                    expect(result.encrypted).toEqual([]);
                }
                expect(warn).toHaveBeenCalledTimes(1);
                expect(warn.mock.calls[0][0]).toContain("pods is forbidden");
                expect(await ctx.rows()).toEqual(before);
                expect((await ctx.state()).pluginSecrets.reason).toMatch(/pods can't be listed/);
            });

            it("doesn't rewrite the key state row on every check while the reason is the same, and does when it changes", async () => {
                await insertVault();
                ctx.rollout().answer = { rolledOut: false, reason: "Old pods: a." };
                const encryptor = await ctx.newEncryptor();
                await encryptor.run();
                const version = (await ctx.state()).version;

                await encryptor.run();
                expect((await ctx.state()).version).toBe(version);

                ctx.rollout().answer = { rolledOut: false, reason: "Old pods: b." };
                await encryptor.run();
                expect((await ctx.state()).pluginSecrets.reason).toBe("Old pods: b.");
                expect((await ctx.state()).version).toBeGreaterThan(version);
            });

            it("encrypts as soon as the check says the rollout has finished", async () => {
                await insertVault();
                ctx.rollout().answer = { rolledOut: false, reason: "Old pods: a." };
                const encryptor = await ctx.newEncryptor();
                expect((await encryptor.run()).completed).toBe(false);

                ctx.rollout().answer = { rolledOut: true };
                const result = await encryptor.run();
                expect(result.completed).toBe(true);
                expect(result.encrypted).toHaveLength(2);
                expect(result.waiting).toBeUndefined();
                const state = await ctx.state();
                expect(state.pluginSecrets.encryptedAt).toBeTruthy();
                expect(state.pluginSecrets.waitingForRollout).toBe(false);
                expect(state.pluginSecrets.reason ?? undefined).toBeUndefined();
            });

            it("skips the check for an operator who has checked the rollout (config_encryption:plugin_secrets:wait_for_rollout: false)", async () => {
                await insertVault();
                ctx.rollout().answer = { rolledOut: false, reason: "Old pods: a." };
                const encryptor = await ctx.newEncryptor();
                encryptor.waitForRollout = false;

                expect((await encryptor.run()).encrypted).toHaveLength(2);
                expect(ctx.rollout().checks).toBe(0);
            });

            it("reads the switch as a string too, as an environment variable sets it", async () => {
                const encryptor = await ctx.newEncryptor();
                for (const off of [false, "false", " FALSE ", "0", 0]) {
                    encryptor.waitForRollout = off;
                    expect(encryptor.rolloutWanted).toBe(false);
                }
                for (const on of [true, "true", "yes", undefined]) {
                    encryptor.waitForRollout = on;
                    expect(encryptor.rolloutWanted).toBe(true);
                }
            });
        });

        describe("without a cipher", () => {
            it("changes nothing, writes no state and says why, so a server without a keyring keeps its plaintext as it was", async () => {
                await insertVault();
                const before = await ctx.rows();
                const encryptor = await ctx.newEncryptor();
                encryptor.cipher = undefined;

                const result = await encryptor.run();

                expect(result).toEqual({ encrypted: [], dropped: [], remaining: [], completed: false, waiting: expect.stringMatching(/no configuration cipher/i) });
                expect(await ctx.rows()).toEqual(before);
                expect(await ctx.state()).toBeFalsy();
            });
        });

        describe("another copy", () => {
            it("leaves the work to the copy that holds the lock, and waits", async () => {
                await insertVault();
                const before = await ctx.rows();
                const encryptor = await ctx.newEncryptor();
                const lock = await encryptor.channel.acquireLock(60_000);
                expect(lock).toBeDefined();

                const result = await (await ctx.newEncryptor()).run();

                expect(result).toEqual({ encrypted: [], dropped: [], remaining: [], completed: false, waiting: expect.stringMatching(/another server copy/i) });
                expect(await ctx.rows()).toEqual(before);
                await lock!.release();
                expect((await (await ctx.newEncryptor()).run()).encrypted).toHaveLength(2);
            });

            it("releases the lock when it is done, even when its work fails", async () => {
                await insertVault();
                const encryptor = await ctx.newEncryptor();
                vi.spyOn(encryptor.pluginRepo, "find").mockRejectedValueOnce(new Error("database unavailable"));
                vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);

                expect((await encryptor.run()).completed).toBe(false);
                const lock = await encryptor.channel.acquireLock(1000);
                expect(lock).toBeDefined();
                await lock!.release();
            });

            it("runs without a lock where no channel can be had, the version checks keeping it safe", async () => {
                await insertVault();
                const encryptor = await ctx.newEncryptor();
                encryptor.channel = undefined;
                expect((await encryptor.run()).encrypted).toHaveLength(2);
            });

            it("waits, and logs, when the lock can't be taken", async () => {
                await insertVault();
                const encryptor = await ctx.newEncryptor();
                vi.spyOn(encryptor.channel, "acquireLock").mockRejectedValueOnce(new Error("redis down"));
                const warn = vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);

                const result = await encryptor.run();
                expect(result.completed).toBe(false);
                expect(result.waiting).toMatch(/lock/);
                expect(warn).toHaveBeenCalledWith(expect.stringContaining("redis down"));
            });

            it("two replicas encrypting at once encrypt each value once and audit it once", async () => {
                await insertVault();
                const first = await ctx.newEncryptor();
                first.channel = undefined;
                const second = await ctx.newEncryptor();
                second.channel = undefined;
                // While the first replica is about to write its row, the second encrypts the whole of it: the first's write is stale.
                const update = first.pluginRepo.update.bind(first.pluginRepo);
                vi.spyOn(first.pluginRepo, "update").mockImplementationOnce(async (...args: any[]) => {
                    expect((await second.run()).encrypted).toHaveLength(2);
                    return await update(...args);
                });

                const result = await first.run();

                // The first finds nothing left to do on the row it reads again.
                expect(result).toEqual({ encrypted: [], dropped: [], remaining: [], completed: true });
                const vault = (await ctx.rows())["@rapidmx/vault"];
                expect(await open(first, vault.uid, "mail:v:api_key", vault.settings["mail:v:api_key"])).toBe("s3cr3t");
                expect(await encryptions()).toHaveLength(2);
            });
        });

        it("a row write that fails leaves the row as it was, remembers what stays in plaintext and doesn't complete; the next start encrypts it", async () => {
            await insertVault();
            const before = await ctx.rows();
            const encryptor = await ctx.newEncryptor();
            vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);
            vi.spyOn(encryptor.pluginRepo, "update").mockRejectedValueOnce(new Error("database unavailable"));

            const result = await encryptor.run();

            expect(result).toEqual({
                encrypted: [],
                dropped: [],
                remaining: [
                    { name: "@rapidmx/vault", key: "mail:v:api_key" },
                    { name: "@rapidmx/vault", key: "mail:v:pin" },
                ],
                completed: false,
            });
            expect(await ctx.rows()).toEqual(before);
            expect(await encryptions()).toHaveLength(0);
            expect((await ctx.state())?.pluginSecrets?.encryptedAt ?? undefined).toBeUndefined();

            const next = await (await ctx.newEncryptor()).run();
            expect(next.encrypted).toHaveLength(2);
            expect(next.completed).toBe(true);
        });

        it("an encryption that fails (no keyring) leaves the row as it was and doesn't complete", async () => {
            await insertVault();
            const before = await ctx.rows();
            const encryptor = await ctx.newEncryptor();
            vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);
            vi.spyOn(encryptor.cipher, "encrypt").mockImplementation(() => {
                throw new ApiError(ApiErrors.INTERNAL_ERROR, 503, "No configuration keyring is loaded, so secrets can't be saved.");
            });

            const result = await encryptor.run();

            expect(result.completed).toBe(false);
            expect(result.remaining).toHaveLength(2);
            expect(await ctx.rows()).toEqual(before);
        });

        it("a row that keeps changing under it is left for the next start", async () => {
            await insertVault();
            const encryptor = await ctx.newEncryptor();
            vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);
            const stale = new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale");
            const update = vi.spyOn(encryptor.pluginRepo, "update").mockRejectedValue(stale);

            const result = await encryptor.run();

            expect(update).toHaveBeenCalledTimes(3);
            expect(result.remaining).toHaveLength(2);
            expect(result.completed).toBe(false);
            expect(isConfigEnvelope((await ctx.rows())["@rapidmx/vault"].settings["mail:v:api_key"])).toBe(false);
        });

        it("a row changed under it is read again and encrypted as it now is", async () => {
            await insertVault();
            const uid: string = (await ctx.rows())["@rapidmx/vault"].uid;
            const encryptor = await ctx.newEncryptor();
            const update = encryptor.pluginRepo.update.bind(encryptor.pluginRepo);
            vi.spyOn(encryptor.pluginRepo, "update").mockImplementationOnce(async (...args: any[]) => {
                await ctx.bumpVersion(uid);
                return await update(...args);
            });

            const result = await encryptor.run();

            expect(result.encrypted).toHaveLength(2);
            expect(result.completed).toBe(true);
            const vault = (await ctx.rows())["@rapidmx/vault"];
            expect(isConfigEnvelope(vault.settings["mail:v:api_key"])).toBe(true);
            expect(await encryptions()).toHaveLength(2);
        });

        it("has nothing left to encrypt for a row deleted while it was encrypting it, and still completes", async () => {
            await insertVault();
            const encryptor = await ctx.newEncryptor();
            // The row is deleted by the time the write is refused, and again when the run looks once more after recording itself.
            vi.spyOn(encryptor.pluginRepo, "update").mockImplementationOnce(async (fields: any) => {
                await encryptor.pluginRepo.delete(fields.uid, { ignoreACL: true });
                throw new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale");
            });

            expect(await encryptor.run()).toEqual({ encrypted: [], dropped: [], remaining: [], completed: true });
        });

        it("leaves a row it can't read back after losing a race for the next start", async () => {
            await insertVault();
            const encryptor = await ctx.newEncryptor();
            vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);
            vi.spyOn(encryptor.pluginRepo, "update").mockRejectedValueOnce(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale"));
            vi.spyOn(encryptor.pluginRepo, "findOne").mockRejectedValueOnce(new Error("database unavailable"));

            const result = await encryptor.run();
            expect(result.remaining).toHaveLength(2);
            expect(result.completed).toBe(false);
        });

        it("keeps an encryption it saved when its audit entry can't be written, and logs that", async () => {
            await insertVault();
            const encryptor = await ctx.newEncryptor();
            const warn = vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);
            vi.spyOn(encryptor.auditLogUtils, "record").mockRejectedValue(new Error("audit log unavailable"));

            const result = await encryptor.run();

            expect(result.encrypted).toHaveLength(2);
            expect(result.completed).toBe(true);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("audit log unavailable"));
            expect(JSON.stringify(warn.mock.calls)).not.toContain("s3cr3t");
        });

        it("reads every plugin row, past the first page a plain find returns", async () => {
            // One at a time: in-process SQLite can't hold two transactions at once.
            for (let i = 0; i < 100; i++) {
                const n: string = String(i).padStart(3, "0");
                await ctx.insertPlugin({ uid: `p-${n}`, name: `@rapidmx/plain-${n}`, packageVersion: "1.0.0", enabled: true, removed: false, settings: {}, manifest: MANIFEST });
            }
            await insertVault({ uid: "zz-last" });

            expect((await (await ctx.newEncryptor()).run()).encrypted).toEqual([
                { name: "@rapidmx/vault", key: "mail:v:api_key" },
                { name: "@rapidmx/vault", key: "mail:v:pin" },
            ]);
        });

        it("never throws: rows that can't be read are logged and the next start tries again, without recording a completed run", async () => {
            const encryptor = await ctx.newEncryptor();
            const error = vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);
            vi.spyOn(encryptor.pluginRepo, "find").mockRejectedValueOnce(new Error("database unavailable"));

            // The server's loop asks again: a datastore that failed to answer is not for the next start.
            expect(await encryptor.run()).toEqual({ encrypted: [], dropped: [], remaining: [], completed: false, waiting: expect.stringContaining("tried again") });
            expect(error).toHaveBeenCalledWith(expect.stringContaining("database unavailable"));
            expect((await ctx.state())?.pluginSecrets?.encryptedAt ?? undefined).toBeUndefined();
        });

        it("never throws: a key state row that can't be read is logged and the next start tries again", async () => {
            await insertVault();
            const before = await ctx.rows();
            const encryptor = await ctx.newEncryptor();
            const warn = vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);
            vi.spyOn(encryptor.stateRepo, "findOne").mockRejectedValueOnce(new Error("database unavailable"));

            // The server's loop asks again: a datastore that failed to answer is not for the next start.
            expect(await encryptor.run()).toEqual({ encrypted: [], dropped: [], remaining: [], completed: false, waiting: expect.stringContaining("tried again") });
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("database unavailable"));
            expect(await ctx.rows()).toEqual(before);
        });

        it("encrypts, but records nothing, when the key state row can't be written, and logs that", async () => {
            await insertVault();
            const encryptor = await ctx.newEncryptor();
            const warn = vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);
            vi.spyOn(encryptor.stateRepo, "create").mockRejectedValueOnce(new Error("database unavailable"));

            const result = await encryptor.run();

            expect(result.encrypted).toHaveLength(2);
            expect(result.completed).toBe(false);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("database unavailable"));
            // The next start finds nothing left to encrypt and records the run.
            expect((await (await ctx.newEncryptor()).run()).completed).toBe(true);
        });

        it("tries the key state row again when it was created or changed by another copy meanwhile", async () => {
            await insertVault();
            const encryptor = await ctx.newEncryptor();
            const create = encryptor.stateRepo.create.bind(encryptor.stateRepo);
            let lost = false;
            vi.spyOn(encryptor.stateRepo, "create").mockImplementation(async (...args: any[]) => {
                if (!lost) {
                    lost = true;
                    // Another copy created the row first.
                    await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: "te5tkey1" });
                    throw new ApiError(ApiErrors.IDENTIFIER_EXISTS, 409, "exists");
                }
                return await create(...args);
            });

            const result = await encryptor.run();

            expect(result.completed).toBe(true);
            const state = await ctx.state();
            expect(state.activeKid).toBe("te5tkey1");
            expect(state.pluginSecrets.encryptedAt).toBeTruthy();
        });

        it("leaves a first completed run another copy recorded meanwhile as it is", async () => {
            await insertVault();
            const encryptor = await ctx.newEncryptor();
            const recorded = new Date("2026-10-01T00:00:00.000Z");
            const update = encryptor.pluginRepo.update.bind(encryptor.pluginRepo);
            vi.spyOn(encryptor.pluginRepo, "update").mockImplementation(async (...args: any[]) => {
                const saved = await update(...args);
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, pluginSecrets: { encryptedAt: recorded, waitingForRollout: false } });
                return saved;
            });

            const result = await encryptor.run();

            expect(result.completed).toBe(true);
            expect(new Date((await ctx.state()).pluginSecrets.encryptedAt).getTime()).toBe(recorded.getTime());
        });

        describe("runUntilEncrypted()", () => {
            it("keeps checking every interval while it waits for the rollout, and encrypts once it has finished", async () => {
                await insertVault();
                ctx.rollout().answer = { rolledOut: false, reason: "Old pods: a." };
                const encryptor = await ctx.newEncryptor();
                let checks = 0;
                const check = ctx.rollout().check.bind(ctx.rollout());
                vi.spyOn(ctx.rollout(), "check").mockImplementation(async () => {
                    if (++checks === 3) {
                        ctx.rollout().answer = { rolledOut: true };
                    }
                    return await check();
                });

                const result = await encryptor.runUntilEncrypted({ intervalMs: 5 });

                expect(checks).toBe(3);
                expect(result.completed).toBe(true);
                expect(result.encrypted).toHaveLength(2);
            });

            it("stops when it is aborted, answering the last result", async () => {
                ctx.rollout().answer = { rolledOut: false, reason: "Old pods: a." };
                const encryptor = await ctx.newEncryptor();
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 30);

                const result = await encryptor.runUntilEncrypted({ intervalMs: 5, signal: controller.signal });

                expect(result.completed).toBe(false);
                expect(result.waiting).toBe("Old pods: a.");
                // Aborted before it starts: one run, no wait.
                controller.abort();
                const once = await encryptor.runUntilEncrypted({ intervalMs: 60_000, signal: controller.signal });
                expect(once.waiting).toBe("Old pods: a.");
            });

            it("returns when there is no more waiting to do: a failure to encrypt is for the next start, not for a loop", async () => {
                await insertVault();
                const encryptor = await ctx.newEncryptor();
                vi.spyOn(encryptor.logger, "warn").mockImplementation(() => undefined);
                vi.spyOn(encryptor.pluginRepo, "update").mockRejectedValue(new Error("database unavailable"));

                const result = await encryptor.runUntilEncrypted({ intervalMs: 5 });
                expect(result.completed).toBe(false);
                expect(result.waiting).toBeUndefined();
                expect(result.remaining).toHaveLength(2);
            });

        });
    });
}
