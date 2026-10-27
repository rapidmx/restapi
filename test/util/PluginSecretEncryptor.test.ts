///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for what the real-DB suites can't reach: `PluginSecretEncryptor`'s `@Init` hook, how it resolves the rollout check, the polling loop's
// timing, and the failures that only a fake repository can stage. Encryption itself is tested on both backends in ./pluginSecretEncryptionSuite.ts.
import { ApiError } from "@rapidrest/core";
import { ApiErrors, RepoUtils } from "@rapidrest/service-core";
import { NullServerRolloutCheck } from "../../src/plugins/ServerRolloutCheck.js";
import { PLUGIN_API_VERSION } from "../../src/plugins/PluginUtils.js";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { PluginSecretEncryptor } from "../../src/util/PluginSecretEncryptor.js";
import { newTestConfigCipher } from "../testDoubles.js";

/** A uniquely named stand-in model class. */
function model(name: string): any {
    return { [name]: class {} }[name];
}

class TestPluginSecretEncryptor extends (PluginSecretEncryptor as any) {
    protected pluginClass: any = model("PluginModel");
    protected auditLogClass: any = model("AuditModel");
    protected configKeyStateClass: any = class StateModel {
        constructor(fields: any) {
            Object.assign(this, fields);
        }
    };
}

function withFactory(encryptor: any, newInstance: any = vi.fn(async (type: any, opts: any) => ({ type, opts }))): any {
    const factory: any = { newInstance };
    Object.defineProperty(encryptor, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

const ROW = {
    uid: "p1",
    version: 1,
    name: "@rapidmx/vault",
    removed: false,
    settings: { "mail:v:api_key": "s3cr3t" },
    manifest: { apiVersion: PLUGIN_API_VERSION, displayName: "Vault", settings: [{ key: "mail:v:api_key", label: "API key", type: "string" }] },
};

/** An encryptor over fake repositories: one plugin row (`plugins`, which `pluginRepo.update()` changes as a database would), and a key state row that `stateRepo.update()` saves into `state`. */
async function fakeEncryptor(): Promise<{ encryptor: any; logger: any; state: { row?: any }; pluginRepo: any; stateRepo: any; plugins: any[] }> {
    const encryptor: any = new TestPluginSecretEncryptor();
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    Object.defineProperty(encryptor, "logger", { value: logger, configurable: true });
    encryptor.cipher = await newTestConfigCipher();
    encryptor.rolloutCheck = new NullServerRolloutCheck();
    const state: { row?: any } = {};
    const stateRepo = {
        findOne: vi.fn(async () => state.row),
        create: vi.fn(async (row: any) => {
            state.row = { ...row, version: 1 };
            return state.row;
        }),
        update: vi.fn(async (fields: any) => {
            state.row = { ...state.row, ...fields, version: state.row.version + 1 };
            return state.row;
        }),
    };
    const plugins: any[] = [{ ...ROW }];
    const pluginRepo = {
        find: vi.fn(async () => plugins),
        findOne: vi.fn(async (uid: string) => plugins.find((row) => row.uid === uid)),
        update: vi.fn(async (fields: any) => {
            const row = plugins.find((candidate) => candidate.uid === fields.uid);
            Object.assign(row, fields, { version: row.version + 1 });
            return row;
        }),
    };
    encryptor.stateRepo = stateRepo;
    encryptor.pluginRepo = pluginRepo;
    encryptor.auditLogUtils = { record: vi.fn() };
    return { encryptor, logger, state, pluginRepo, stateRepo, plugins };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("PluginSecretEncryptor init()", () => {
    it("throws when the objectFactory is not set", async () => {
        await expect((new TestPluginSecretEncryptor() as any).init()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds the plugin, key state and audit repos and the audit service once, and resolves the channel and the rollout check", async () => {
        const encryptor: any = new TestPluginSecretEncryptor();
        const factory = withFactory(encryptor);
        await encryptor.init();
        expect(factory.newInstance.mock.calls.map(([type, opts]: any) => [type, opts.name])).toEqual([
            [RepoUtils, "PluginModel"],
            [RepoUtils, "StateModel"],
            [RepoUtils, "AuditModel"],
            [AuditLogUtils, "AuditModel"],
            ["ServerRolloutCheck", "default"],
            ["ConfigKeyChannel", "default"],
        ]);
        expect(encryptor.rolloutCheck).toEqual({ type: "ServerRolloutCheck", opts: { name: "default" } });
        await encryptor.init();
        expect(factory.newInstance).toHaveBeenCalledTimes(6);
    });

    it("rebuilds nothing already set, and skips what has no model class", async () => {
        const bare: any = new TestPluginSecretEncryptor();
        const factory = withFactory(bare);
        Object.assign(bare, { pluginClass: undefined, auditLogClass: undefined, configKeyStateClass: undefined, rolloutCheck: new NullServerRolloutCheck(), channel: {} });
        await bare.init();
        expect(factory.newInstance).not.toHaveBeenCalled();
    });

    it("falls back to the check that answers 'rolled out' on a server that registers none (outside Kubernetes)", async () => {
        vi.stubEnv("KUBERNETES_SERVICE_HOST", "");
        const encryptor: any = new TestPluginSecretEncryptor();
        withFactory(
            encryptor,
            vi.fn(async (type: any, opts: any) => {
                if (type === "ServerRolloutCheck") {
                    throw new Error("No class found with name: ServerRolloutCheck");
                }
                return { type, opts };
            }),
        );
        await encryptor.init();
        expect(encryptor.rolloutCheck).toBeInstanceOf(NullServerRolloutCheck);
        expect(await encryptor.rolloutCheck.check()).toEqual({ rolledOut: true });
    });

    it("waits, rather than fall back to 'rolled out', when the registered check fails to start", async () => {
        const encryptor: any = new TestPluginSecretEncryptor();
        withFactory(
            encryptor,
            vi.fn(async (type: any, opts: any) => {
                if (type === "ServerRolloutCheck") {
                    throw new Error("projected token not mounted");
                }
                return { type, opts };
            }),
        );
        encryptor.cipher = await newTestConfigCipher();
        Object.defineProperty(encryptor, "logger", { value: { warn: vi.fn(), error: vi.fn(), info: vi.fn() }, configurable: true });
        const { stateRepo, pluginRepo } = await fakeEncryptor();
        encryptor.stateRepo = stateRepo;
        encryptor.pluginRepo = pluginRepo;
        await encryptor.init();
        encryptor.stateRepo = stateRepo;
        encryptor.pluginRepo = pluginRepo;

        const result = await encryptor.run();

        expect(result.waiting).toMatch(/pods can't be listed/);
        expect(result.completed).toBe(false);
        expect(pluginRepo.update).not.toHaveBeenCalled();
    });
});

describe("PluginSecretEncryptor run()", () => {
    it("gives up on the key state row after three lost races, encrypts anyway and does not complete", async () => {
        const { encryptor, logger, stateRepo, state } = await fakeEncryptor();
        state.row = { uid: "config-keys", version: 1, pluginSecrets: {} };
        stateRepo.update.mockRejectedValue(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale"));

        const result = await encryptor.run();

        expect(stateRepo.update).toHaveBeenCalledTimes(3);
        expect(result.encrypted).toEqual([{ name: "@rapidmx/vault", key: "mail:v:api_key" }]);
        expect(result.completed).toBe(false);
        // The loop must ask again: a state row that couldn't be saved is not a row for the next start.
        expect(result.waiting).toMatch(/key state/);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("key state"));
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("s3cr3t");
    });

    it("creates the key state row on the first run, with the plugin secrets recorded and nothing else", async () => {
        const { encryptor, stateRepo, state } = await fakeEncryptor();
        expect((await encryptor.run()).completed).toBe(true);
        expect(stateRepo.create).toHaveBeenCalledTimes(1);
        expect(state.row.uid).toBe("config-keys");
        expect(state.row.pluginSecrets.waitingForRollout).toBe(false);
        expect(state.row.pluginSecrets.encryptedAt).toBeInstanceOf(Date);
        expect(Object.keys(state.row).sort()).toEqual(["pluginSecrets", "uid", "version"]);
    });

    it("treats a null encryptedAt (as SQL reads an unset one) as not yet encrypted", async () => {
        const { encryptor, state, stateRepo } = await fakeEncryptor();
        state.row = { uid: "config-keys", version: 1, pluginSecrets: { encryptedAt: null, waitingForRollout: true, reason: "Old pods." } };
        const result = await encryptor.run();
        expect(result.completed).toBe(true);
        expect(stateRepo.update).toHaveBeenCalledTimes(1);
        expect(state.row.pluginSecrets.encryptedAt).toBeInstanceOf(Date);
    });

    it("reads a stored checkedAt as a date or as text, rewriting the waiting state once five minutes have passed", async () => {
        const { encryptor, state, stateRepo } = await fakeEncryptor();
        encryptor.rolloutCheck = { check: async () => ({ rolledOut: false, reason: "Old pods." }) };
        state.row = { uid: "config-keys", version: 1, pluginSecrets: { waitingForRollout: true, reason: "Old pods.", checkedAt: new Date().toISOString() } };

        await encryptor.run();
        expect(stateRepo.update).not.toHaveBeenCalled();

        state.row.pluginSecrets.checkedAt = new Date(Date.now() - 6 * 60_000).toISOString();
        await encryptor.run();
        expect(stateRepo.update).toHaveBeenCalledTimes(1);

        // An unreadable date counts as stale.
        state.row.pluginSecrets.checkedAt = "not a date";
        await encryptor.run();
        expect(stateRepo.update).toHaveBeenCalledTimes(2);
        state.row.pluginSecrets.checkedAt = undefined;
        await encryptor.run();
        expect(stateRepo.update).toHaveBeenCalledTimes(3);
    });

    it("does not throw when the waiting state can't be recorded, and still reports why it waits", async () => {
        const { encryptor, logger, stateRepo } = await fakeEncryptor();
        encryptor.rolloutCheck = { check: async () => ({ rolledOut: false, reason: "Old pods." }) };
        stateRepo.create.mockRejectedValue(new Error("database unavailable"));

        const result = await encryptor.run();

        expect(result.waiting).toBe("Old pods.");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("database unavailable"));
    });

    it("gives the pods' reason a default when the check says not rolled out without one", async () => {
        const { encryptor } = await fakeEncryptor();
        encryptor.rolloutCheck = { check: async () => ({ rolledOut: false }) };
        expect((await encryptor.run()).waiting).toMatch(/older release/);
    });

    it("doesn't rewrite the waiting state when another copy recorded the same reason between its read and its write", async () => {
        const { encryptor, stateRepo } = await fakeEncryptor();
        encryptor.rolloutCheck = { check: async () => ({ rolledOut: false, reason: "Old pods." }) };
        stateRepo.findOne
            .mockResolvedValueOnce({ uid: "config-keys", version: 1, pluginSecrets: {} })
            .mockResolvedValueOnce({ uid: "config-keys", version: 2, pluginSecrets: { waitingForRollout: true, reason: "Old pods.", checkedAt: new Date() } });

        expect((await encryptor.run()).waiting).toBe("Old pods.");
        expect(stateRepo.update).not.toHaveBeenCalled();
        expect(stateRepo.create).not.toHaveBeenCalled();
    });

    it("never erases an encryptedAt another copy recorded between its rollout check and its waiting record", async () => {
        const { encryptor, stateRepo } = await fakeEncryptor();
        encryptor.rolloutCheck = { check: async () => ({ rolledOut: false, reason: "Old pods." }) };
        stateRepo.findOne
            .mockResolvedValueOnce({ uid: "config-keys", version: 1, pluginSecrets: { waitingForRollout: true, reason: "Other." } })
            .mockResolvedValueOnce({ uid: "config-keys", version: 2, pluginSecrets: { encryptedAt: new Date(), waitingForRollout: false, checkedAt: new Date() } });

        expect((await encryptor.run()).waiting).toBe("Old pods.");
        expect(stateRepo.update).not.toHaveBeenCalled();
        expect(stateRepo.create).not.toHaveBeenCalled();
    });

    it("looks once more after recording encryptedAt, for a secret saved in plaintext by a save that read the state before it", async () => {
        const { encryptor, pluginRepo, plugins } = await fakeEncryptor();
        const late = { ...ROW, uid: "p2", name: "@rapidmx/late", settings: { "mail:v:api_key": "l4te" } };
        // The late save lands once the first pass has read the rows.
        pluginRepo.find.mockImplementationOnce(async () => {
            const seen = [...plugins];
            plugins.push(late);
            return seen;
        });

        const result = await encryptor.run();

        expect(result.completed).toBe(true);
        expect(result.encrypted).toEqual([
            { name: "@rapidmx/vault", key: "mail:v:api_key" },
            { name: "@rapidmx/late", key: "mail:v:api_key" },
        ]);
    });

    it("works on when its lock can't be released", async () => {
        const { encryptor } = await fakeEncryptor();
        encryptor.channel = { acquireLock: async () => ({ release: async () => { throw new Error("redis down"); } }) };
        const result = await encryptor.run();
        expect(result.encrypted).toHaveLength(1);
        expect(result.completed).toBe(true);
    });

    it("says nothing when a run has no plaintext secret to encrypt", async () => {
        const { encryptor, logger, pluginRepo } = await fakeEncryptor();
        pluginRepo.find.mockResolvedValue([{ ...ROW, settings: { "mail:v:note": "hi" } }]);
        await encryptor.run();
        expect(logger.info).not.toHaveBeenCalled();
    });

    it("logs the counts of a run that encrypted or dropped something, never a value", async () => {
        const { encryptor, logger, plugins } = await fakeEncryptor();
        plugins.push({ ...ROW, uid: "p2", name: "@rapidmx/gone", removed: true });
        await encryptor.run();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("encrypted 1 "));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("removed 1 "));
        expect(JSON.stringify(logger.info.mock.calls)).not.toContain("s3cr3t");
    });

    it("reports a datastore that can't be read as waiting, never as thrown", async () => {
        const { encryptor, logger, stateRepo } = await fakeEncryptor();
        stateRepo.findOne.mockRejectedValue(new Error("replica set failover"));
        const result = await encryptor.run();
        expect(result.completed).toBe(false);
        expect(result.waiting).toMatch(/tried again/);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("replica set failover"));
    });
});

describe("PluginSecretEncryptor runUntilEncrypted()", () => {
    it("checks every 30 seconds unless told otherwise, until a run completes", async () => {
        vi.useFakeTimers();
        const { encryptor } = await fakeEncryptor();
        const waiting = { encrypted: [], dropped: [], remaining: [], completed: false, waiting: "Old pods." };
        const done = { encrypted: [], dropped: [], remaining: [], completed: true };
        const run = vi.fn().mockResolvedValueOnce(waiting).mockResolvedValueOnce(waiting).mockResolvedValueOnce(done);
        encryptor.run = run;

        const finished = encryptor.runUntilEncrypted();
        await vi.advanceTimersByTimeAsync(29_999);
        expect(run).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(run).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(await finished).toBe(done);
        expect(run).toHaveBeenCalledTimes(3);
    });

    it("keeps asking after a run that failed on a datastore error, and stops at the first that completes", async () => {
        vi.useFakeTimers();
        const { encryptor, stateRepo } = await fakeEncryptor();
        stateRepo.findOne.mockRejectedValueOnce(new Error("replica set failover"));

        const finished = encryptor.runUntilEncrypted({ intervalMs: 1000 });
        await vi.advanceTimersByTimeAsync(1000);
        const result = await finished;

        expect(result.completed).toBe(true);
        expect(stateRepo.findOne).toHaveBeenCalledTimes(3);
    });

    it("stops waiting the moment it is aborted", async () => {
        vi.useFakeTimers();
        const { encryptor } = await fakeEncryptor();
        const waiting = { encrypted: [], dropped: [], remaining: [], completed: false, waiting: "Old pods." };
        encryptor.run = vi.fn().mockResolvedValue(waiting);
        const controller = new AbortController();

        const finished = encryptor.runUntilEncrypted({ signal: controller.signal });
        await vi.advanceTimersByTimeAsync(10_000);
        controller.abort();
        expect(await finished).toBe(waiting);
        expect(encryptor.run).toHaveBeenCalledTimes(1);
    });
});
