///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `ConfigKeyRotationJob` through every phase (spec 5.5), identical on both backends: adding the key to the keyring, activating it once every live server copy
// reports it, re-encrypting every envelope in version-checked batches, removing the old key once none uses it, a compromised rotation, an envelope that
// can't be decrypted, two replicas racing and a stale copy. The keyring is a real file behind `FileConfigKeyringStore`, the cipher a real `ConfigCipher`,
// the heartbeats a `LocalConfigKeyChannel` the test writes; the state row, the plugin rows that hold the envelopes and the audit entries are the real
// database.
import * as fs from "fs";
import { AuditAction, type ConfigEnvelope } from "../../src/models/types.js";
import { dnsProviderEnvelopeSource } from "../../src/dns/DnsProviderEnvelopeSource.js";
import { integrationSettingsEnvelopeSource } from "../../src/util/IntegrationSettingsEnvelopeSource.js";
import { isConfigEnvelope, type ConfigCipher } from "../../src/secrets/ConfigCipher.js";
import { ConfigEnvelopeSourceRegistry, type ConfigEnvelopeSource } from "../../src/secrets/ConfigEnvelopeSource.js";
import type { LocalConfigKeyChannel } from "../../src/secrets/ConfigKeyChannel.js";
import { CONFIG_KEY_STATE_UID, parseConfigKeyring, serializeConfigKeyring, type ConfigKeyring } from "../../src/secrets/ConfigKeyring.js";
import { ConfigKeyringConflictError, ConfigKeyringInvalidError, FileConfigKeyringStore, type ConfigKeyringStore } from "../../src/secrets/ConfigKeyringStore.js";
import { rotationDate } from "../../src/util/DkimRotationUtils.js";

export interface ConfigKeyRotationSuiteContext {
    /** A new replica of the job, as the server builds one; its cipher is the suite's. */
    newJob: () => Promise<any>;
    cipher: () => ConfigCipher;
    channel: () => LocalConfigKeyChannel;
    /** The keyring file the cipher reads and the store writes. */
    keyringFile: () => string;
    saveState: (fields: Record<string, unknown>) => Promise<void>;
    state: () => Promise<any>;
    clearState: () => Promise<void>;
    /** Saves a plugin row holding `settings`, with the uid `uid`. */
    insertPlugin: (uid: string, settings: Record<string, unknown>) => Promise<void>;
    plugin: (uid: string) => Promise<any>;
    /** Changes the plugin row's plain setting `note` directly and bumps its version, as a concurrent change from elsewhere would. */
    touchPlugin: (uid: string, note: string) => Promise<void>;
    /** Deletes the plugin row `uid`, as an administrator would. */
    deletePlugin: (uid: string) => Promise<void>;
    clearPlugins: () => Promise<void>;
    pluginModel: () => any;
    /** Saves a DNS provider row named `provider <uid>` with these credentials and generation. */
    insertProvider: (uid: string, credentials: Record<string, ConfigEnvelope> | null, credentialsGeneration: number) => Promise<void>;
    provider: (uid: string) => Promise<any>;
    clearProviders: () => Promise<void>;
    providerModel: () => any;
    /** Saves the Integrations settings row (`integrations`) with these sections. */
    insertIntegrations: (sections: Record<string, unknown>) => Promise<void>;
    integrations: () => Promise<any>;
    clearIntegrations: () => Promise<void>;
    integrationsModel: () => any;
    auditEntries: (action: AuditAction) => Promise<any[]>;
    clearAudit: () => Promise<void>;
}

const OLD = { kid: "0ld0ld01", key: Buffer.alloc(32, 1).toString("base64"), createdAt: "2026-09-01T00:00:00.000Z" };
const NEW_KID = "n3wn3w03";
const MINUTE = 60_000;

/** Settings of one record type: the keys that start with `prefix`. */
function sourceFor(record: string, prefix: string, modelClass: any): ConfigEnvelopeSource {
    return {
        record,
        modelClass,
        envelopes: (row: any) =>
            Object.entries(row.settings ?? {})
                .filter(([key, value]) => key.startsWith(prefix) && isConfigEnvelope(value))
                .map(([key, envelope]) => ({ field: `settings.${key}`, envelope: envelope as ConfigEnvelope })),
        replace: (row: any, replacements: Record<string, ConfigEnvelope>) => ({
            settings: {
                ...row.settings,
                ...Object.fromEntries(Object.entries(replacements).map(([field, envelope]) => [field.slice("settings.".length), envelope])),
            },
        }),
    };
}

export function configKeyRotationSuite(ctx: ConfigKeyRotationSuiteContext): void {
    describe("Configuration key rotation", () => {
        let job: any;
        let store: ConfigKeyringStore;
        let logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };

        const readRing = (): ConfigKeyring => parseConfigKeyring(fs.readFileSync(ctx.keyringFile(), "utf-8"));
        const writeRing = (...keys: ConfigKeyring["keys"]): void => fs.writeFileSync(ctx.keyringFile(), serializeConfigKeyring({ keys }));
        const kids = (): string[] => readRing().keys.map((key) => key.kid);
        /** The kid a rotation added to the ring: the one that isn't the original. */
        const addedKid = (): string => kids().find((kid) => kid !== OLD.kid)!;

        const requested = (extra: Record<string, unknown> = {}, phase: string = "adding"): Record<string, unknown> => ({
            previousKids: [],
            compromised: false,
            requestedBy: "admin-1",
            requestedAt: new Date(Date.now() - MINUTE),
            phase,
            ...extra,
        });
        const startRotation = async (extra: Record<string, unknown> = {}, state: Record<string, unknown> = {}): Promise<void> => {
            await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, rotation: requested(extra), ...state });
        };
        const rotation = async (): Promise<any> => (await ctx.state())?.rotation;

        const beat = async (copy: string, loaded: string[], encrypting: string | undefined = loaded[0]): Promise<void> => {
            await ctx.channel().putHeartbeat({ copy, kids: loaded, encrypting, at: new Date().toISOString() }, 90_000);
        };

        /** The envelope of `value` for plugin `uid`'s setting `key`, sealed with the cipher's current key. */
        const seal = (record: string, uid: string, key: string, value: string | number | boolean): ConfigEnvelope =>
            ctx.cipher().encrypt(value, { record, uid, field: `settings.${key}` });
        const open = (record: string, uid: string, key: string, envelope: ConfigEnvelope) => ctx.cipher().decrypt(envelope, { record, uid, field: `settings.${key}` });

        /** A plugin row with two secret settings (of two record types) and a plain one. */
        const insertRow = async (uid: string, values: { a?: string; b?: string } = { a: "alpha-secret", b: "bravo-secret" }): Promise<void> => {
            const settings: Record<string, unknown> = { note: "plain text" };
            if (values.a !== undefined) {
                settings.a_token = seal("PluginA", uid, "a_token", values.a);
            }
            if (values.b !== undefined) {
                settings.b_token = seal("PluginB", uid, "b_token", values.b);
            }
            await ctx.insertPlugin(uid, settings);
        };

        beforeEach(async () => {
            writeRing(OLD);
            await ctx.clearState();
            await ctx.clearPlugins();
            await ctx.clearProviders();
            await ctx.clearIntegrations();
            await ctx.clearAudit();
            ctx.channel().reset();
            await ctx.cipher().reload();
            job = await ctx.newJob();
            store = new FileConfigKeyringStore(ctx.keyringFile());
            job.keyringStore = store;
            job.channel = ctx.channel();
            job.cipher = ctx.cipher();
            job.sources = new ConfigEnvelopeSourceRegistry();
            job.sources.register(sourceFor("PluginA", "a_", ctx.pluginModel()));
            job.sources.register(sourceFor("PluginB", "b_", ctx.pluginModel()));
            job.batchSize = 100;
            job.warnMinutes = 15;
            logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
            job.logger = logger;
        });

        afterEach(async () => {
            await job.dispose();
            vi.useRealTimers();
            vi.restoreAllMocks();
        });

        it("Exposes the configured cron schedule (every 30 seconds), and start() and stop() do nothing.", async () => {
            expect(job.schedule).toBe("*/30 * * * * *");
            await expect(job.start()).resolves.toBeUndefined();
            expect(job.stop()).toBeUndefined();
        });

        describe("when there is nothing to do", () => {
            it("leaves everything alone without a rotation, without a state row at all", async () => {
                await job.run();
                expect(await ctx.state()).toBeFalsy();
                expect(kids()).toEqual([OLD.kid]);
            });

            it("leaves a finished or failed rotation alone", async () => {
                for (const phase of ["done", "failed"]) {
                    await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, rotation: requested({ kid: NEW_KID }, phase) });
                    const before = await ctx.state();
                    await job.run();
                    expect((await ctx.state()).version).toBe(before.version);
                    expect(kids()).toEqual([OLD.kid]);
                }
            });

            it("does nothing without a channel (production without Redis), whatever the state says, and listens to nothing", async () => {
                await startRotation();
                job.channel = undefined;
                await expect(job.subscribe()).resolves.toBeUndefined();
                await job.run();
                expect(kids()).toEqual([OLD.kid]);
                expect((await rotation()).phase).toBe("adding");
            });

            it("does nothing without a keyring store, whatever the state says", async () => {
                await startRotation();
                job.keyringStore = undefined;
                await job.run();
                expect(kids()).toEqual([OLD.kid]);
                expect((await rotation()).phase).toBe("adding");
            });

            it("does nothing while another copy holds the lock, and takes the lock back once it lets go", async () => {
                await startRotation();
                const held = await ctx.channel().acquireLock(MINUTE);
                await job.run();
                expect(kids()).toEqual([OLD.kid]);
                await held!.release();
                await job.run();
                expect(kids()).toHaveLength(2);
            });

            it("holds the lock only while it works", async () => {
                await startRotation();
                await job.run();
                const again = await ctx.channel().acquireLock(MINUTE);
                expect(again).toBeDefined();
                await again!.release();
            });

            it("lets the lock go when the run fails, and never throws", async () => {
                await startRotation();
                vi.spyOn(store, "read").mockImplementation(() => {
                    throw new Error("disk on fire");
                });
                await expect(job.run()).resolves.toBeUndefined();
                const again = await ctx.channel().acquireLock(MINUTE);
                expect(again).toBeDefined();
                await again!.release();
            });

            it("is not troubled by a lock that can't be released: it runs out on its own", async () => {
                await startRotation();
                vi.spyOn(ctx.channel(), "acquireLock").mockResolvedValue({
                    release: async () => {
                        throw new Error("redis down");
                    },
                });
                await expect(job.run()).resolves.toBeUndefined();
                expect(kids()).toHaveLength(2);
            });

            it("does nothing, and says so, when the lock can't be taken because Redis is down", async () => {
                await startRotation();
                vi.spyOn(ctx.channel(), "acquireLock").mockRejectedValue(new Error("redis down"));
                await expect(job.run()).resolves.toBeUndefined();
                expect(kids()).toEqual([OLD.kid]);
                expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("redis down"));
            });

            it("leaves a rotation in a phase it doesn't know alone", async () => {
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, rotation: requested({}, "sideways") });
                const before = await ctx.state();
                await job.run();
                expect((await ctx.state()).version).toBe(before.version);
                expect(kids()).toEqual([OLD.kid]);
            });

            it("logs, never throws, and tries again when the key state can't be read", async () => {
                await startRotation();
                vi.spyOn(job.stateRepo, "findOne").mockRejectedValueOnce(new Error("database down"));
                await expect(job.run()).resolves.toBeUndefined();
                expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("database down"));
                await job.run();
                expect(kids()).toHaveLength(2);
            });

            it("logs, never throws, and leaves the step for the next run when saving the key state fails for another reason than a lost race", async () => {
                await startRotation();
                vi.spyOn(job.stateRepo, "update").mockRejectedValueOnce(new Error("disk full"));
                await expect(job.run()).resolves.toBeUndefined();
                expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
            });

            it("runs one pass at a time within a process", async () => {
                await startRotation();
                const read = vi.spyOn(store, "read");
                await Promise.all([job.run(), job.run(), job.run()]);
                // Only the first reached the keyring; adding reads it once.
                expect(read).toHaveBeenCalledTimes(1);
            });
        });

        describe("adding", () => {
            it("adds a new key to the keyring, records it, audits it and tells every copy", async () => {
                await startRotation();
                const noticed = vi.fn();
                await ctx.channel().onChanged(noticed);

                await job.run();

                const ring = readRing();
                expect(ring.keys).toHaveLength(2);
                const added = ring.keys.find((key) => key.kid !== OLD.kid)!;
                expect(added.kid).toMatch(/^[0-9a-f]{8}$/);
                expect(Buffer.from(added.key, "base64")).toHaveLength(32);
                expect(Date.parse(added.createdAt)).toBeGreaterThanOrEqual(Date.parse(OLD.createdAt));
                const current = await rotation();
                expect(current.kid).toBe(added.kid);
                expect(current.previousKids).toEqual([OLD.kid]);
                expect(current.phase).toBe("activating");
                expect(rotationDate(current.activationStartedAt)).toBeDefined();
                const audits = await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATED);
                expect(audits).toHaveLength(1);
                expect(audits[0].details).toEqual({ kid: added.kid, reason: "manual" });
                expect(audits[0].actorUserUid).toBeFalsy();
                expect(noticed).toHaveBeenCalled();
                // Key material is never audited or logged.
                expect(JSON.stringify([audits, logger.warn.mock.calls, logger.info.mock.calls])).not.toContain(added.key);
            });

            it("keeps encrypting with the original key until the new one is activated", async () => {
                await startRotation();
                await job.run();
                await ctx.cipher().reload();
                expect(ctx.cipher().currentKid()).toBe(OLD.kid);
                expect((await ctx.state()).activeKid).toBeFalsy();
            });

            it("audits a compromised rotation as one", async () => {
                await startRotation({ compromised: true });
                await job.run();
                const audits = await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATED);
                expect(audits[0].details.reason).toBe("compromised");
            });

            it("leaves the ring unchanged when the keyring's version changed under it, and adds the key on the next run", async () => {
                await startRotation();
                const write = vi.spyOn(store, "write").mockRejectedValueOnce(new ConfigKeyringConflictError("The keyring was changed by someone else."));
                await job.run();
                expect(kids()).toEqual([OLD.kid]);
                const first = await rotation();
                expect(first.phase).toBe("adding");
                expect(first.lastError).toContain("changed by someone else");
                expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATED)).toHaveLength(0);

                await job.run();
                expect(write).toHaveBeenCalledTimes(2);
                expect(kids()).toHaveLength(2);
                const second = await rotation();
                expect(second.phase).toBe("activating");
                // The retry went on to the next phase, which has no report from any copy yet; the conflict is no longer shown.
                expect(second.lastError ?? "").not.toContain("changed by someone else");
            });

            it("shows a refused write as the rotation's lastError, never with a key in it, and retries", async () => {
                await startRotation();
                vi.spyOn(store, "write").mockRejectedValueOnce(new Error("OpenBao is sealed"));
                await job.run();
                expect(kids()).toEqual([OLD.kid]);
                expect((await rotation()).lastError).toContain("OpenBao is sealed");
                await job.run();
                expect(kids()).toHaveLength(2);
            });

            it("shows a keyring it can't read as lastError and tries again", async () => {
                await startRotation();
                vi.spyOn(store, "read").mockRejectedValueOnce(new Error("the Kubernetes API is unreachable"));
                await job.run();
                const current = await rotation();
                expect(current.phase).toBe("adding");
                expect(current.lastError).toContain("unreachable");
                await job.run();
                expect(kids()).toHaveLength(2);
            });

            it("fails the rotation, without retrying, when the keyring can't be parsed", async () => {
                await startRotation();
                vi.spyOn(store, "read").mockRejectedValue(new ConfigKeyringInvalidError("The configuration keyring isn't valid JSON."));
                await job.run();
                const current = await rotation();
                expect(current.phase).toBe("failed");
                expect(current.lastError).toContain("isn't valid JSON");
                expect(rotationDate(current.finishedAt)).toBeDefined();
                vi.restoreAllMocks();
                await job.run();
                expect(kids()).toEqual([OLD.kid]);
                expect((await rotation()).phase).toBe("failed");
            });

            it("takes up the key a crashed copy had already written, instead of adding a second", async () => {
                const added = { kid: "ex7ra001", key: Buffer.alloc(32, 9).toString("base64"), createdAt: new Date().toISOString() };
                writeRing(OLD, added);
                // The copy recorded the keys the ring held before it wrote the new one.
                await startRotation({ requestedAt: new Date(Date.now() - MINUTE), keyringKids: [OLD.kid] });
                await job.run();
                expect(kids()).toEqual([OLD.kid, "ex7ra001"]);
                const current = await rotation();
                expect(current.kid).toBe("ex7ra001");
                expect(current.previousKids).toEqual([OLD.kid]);
                expect(current.phase).toBe("activating");
                expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATED)).toHaveLength(1);
            });

            it("adds a key of its own even when a key of the ring was made by a clock ahead of the request's, as a keyring written by another machine can be", async () => {
                // The installer's machine ran ten minutes ahead of the cluster, so the original key looks newer than a request made a minute ago.
                const ahead = { ...OLD, createdAt: new Date(Date.now() + 10 * MINUTE).toISOString() };
                writeRing(ahead);
                await startRotation({ compromised: true });

                await job.run();

                expect(kids()).toHaveLength(2);
                const current = await rotation();
                expect(current.kid).toBe(addedKid());
                expect(current.kid).not.toBe(OLD.kid);
                expect(current.previousKids).toEqual([OLD.kid]);
                expect(current.phase).toBe("activating");
                expect((await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATED))[0].details).toEqual({ kid: current.kid, reason: "compromised" });
            });

            it("records the keys the ring held before it writes the new one, so a retry after a failed write finds the same ring, and drops them once the key is recorded", async () => {
                await startRotation();
                vi.spyOn(store, "write").mockRejectedValueOnce(new Error("OpenBao is sealed"));
                await job.run();
                expect((await rotation()).keyringKids).toEqual([OLD.kid]);

                await job.run();
                const current = await rotation();
                expect(kids()).toHaveLength(2);
                expect(current.phase).toBe("activating");
                expect(current.keyringKids).toBeUndefined();
            });

            it("adds the key when the request carries no usable date, taking the key's date from the clock", async () => {
                await startRotation({ requestedAt: "not a date" });
                await job.run();
                expect(kids()).toHaveLength(2);
                expect((await rotation()).phase).toBe("activating");
            });

            it("goes on when the notice can't be sent, saying so: the copies pick the change up within a minute", async () => {
                await startRotation();
                vi.spyOn(ctx.channel(), "notifyChanged").mockRejectedValue(new Error("redis down"));
                await job.run();
                expect(kids()).toHaveLength(2);
                expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("redis down"));
            });

            it("doesn't mistake a key from an earlier rotation for its own", async () => {
                const earlier = { kid: "ea41ea41", key: Buffer.alloc(32, 8).toString("base64"), createdAt: new Date(Date.now() - 24 * 60 * MINUTE).toISOString() };
                writeRing(OLD, earlier);
                await startRotation();
                await job.run();
                const ring = readRing();
                expect(ring.keys).toHaveLength(3);
                const current = await rotation();
                expect(["ea41ea41", OLD.kid]).not.toContain(current.kid);
                expect(current.previousKids.sort()).toEqual([OLD.kid, "ea41ea41"].sort());
            });
        });

        describe("activating", () => {
            /** A rotation that has added its key and is waiting on the copies. Returns the new kid. */
            const addKey = async (extra: Record<string, unknown> = {}): Promise<string> => {
                await startRotation(extra);
                await job.run();
                // Adding went on to activating, which found no copy reporting yet and said so.
                logger.warn.mockClear();
                return addedKid();
            };

            it("waits while a live copy hasn't loaded the key, naming the copy, and activates nothing", async () => {
                const kid = await addKey();
                await beat("pod-a:1", [OLD.kid, kid]);
                await beat("pod-b:2", [OLD.kid]);

                await job.run();

                const current = await rotation();
                expect(current.phase).toBe("activating");
                expect(current.waitingFor).toEqual(["pod-b:2"]);
                expect((await ctx.state()).activeKid).toBeFalsy();
                expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_ACTIVATED)).toHaveLength(0);
            });

            it("writes the waiting list only when it changes", async () => {
                const kid = await addKey();
                await beat("pod-a:1", [OLD.kid]);
                await job.run();
                const before = await ctx.state();
                await job.run();
                await job.run();
                expect((await ctx.state()).version).toBe(before.version);

                await beat("pod-a:1", [OLD.kid, kid]);
                await beat("pod-b:2", [OLD.kid]);
                await job.run();
                expect((await rotation()).waitingFor).toEqual(["pod-b:2"]);
            });

            it("activates the key once every live copy has loaded it, records who had it and tells every copy", async () => {
                const kid = await addKey();
                await beat("pod-a:1", [OLD.kid, kid], OLD.kid);
                await beat("pod-b:2", [OLD.kid, kid], OLD.kid);
                const noticed = vi.fn();
                await ctx.channel().onChanged(noticed);

                await job.run();

                const state = await ctx.state();
                expect(state.activeKid).toBe(kid);
                expect(state.rotation.phase).toBe("reencrypting");
                expect(rotationDate(state.rotation.activatedAt)).toBeDefined();
                const audits = await ctx.auditEntries(AuditAction.CONFIG_KEY_ACTIVATED);
                expect(audits).toHaveLength(1);
                expect(audits[0].details).toEqual({ kid, copies: 2 });
                expect(noticed).toHaveBeenCalled();
                // Both copies still encrypt with the old key until they've reloaded, so re-encryption waits for them.
                expect(state.rotation.waitingFor.sort()).toEqual(["pod-a:1", "pod-b:2"]);
            });

            it("lets a copy that stopped drop out once its heartbeat has expired", async () => {
                const kid = await addKey();
                vi.useFakeTimers({ toFake: ["Date"] });
                await beat("pod-a:1", [OLD.kid, kid]);
                await ctx.channel().putHeartbeat({ copy: "pod-gone:3", kids: [OLD.kid], encrypting: OLD.kid, at: new Date().toISOString() }, 30_000);
                await job.run();
                expect((await rotation()).phase).toBe("activating");

                vi.setSystemTime(Date.now() + 31_000);
                await job.run();
                expect((await ctx.state()).activeKid).toBe(kid);
            });

            it("never activates without a report from any copy, saying why", async () => {
                await addKey();
                await job.run();
                const state = await ctx.state();
                expect(state.activeKid).toBeFalsy();
                expect(state.rotation.phase).toBe("activating");
                expect(state.rotation.lastError).toContain("reporting");
            });

            it("waits when the heartbeats can't be read", async () => {
                const kid = await addKey();
                await beat("pod-a:1", [OLD.kid, kid]);
                vi.spyOn(ctx.channel(), "heartbeats").mockRejectedValue(new Error("redis down"));
                await job.run();
                const state = await ctx.state();
                expect(state.activeKid).toBeFalsy();
                expect(state.rotation.lastError).toContain("redis down");
            });

            it("never activates on a timeout, however long a copy has been missing the key", async () => {
                await addKey();
                const state = await ctx.state();
                await ctx.saveState({
                    uid: CONFIG_KEY_STATE_UID,
                    rotation: { ...state.rotation, activationStartedAt: new Date(Date.now() - 3 * 24 * 60 * MINUTE) },
                });
                await beat("pod-a:1", [OLD.kid]);
                await job.run();
                await job.run();
                expect((await ctx.state()).activeKid).toBeFalsy();
                expect((await rotation()).phase).toBe("activating");
            });

            it("warns once, naming the copies, after the warning time", async () => {
                await addKey();
                const state = await ctx.state();
                await ctx.saveState({
                    uid: CONFIG_KEY_STATE_UID,
                    rotation: { ...state.rotation, activationStartedAt: new Date(Date.now() - 20 * MINUTE) },
                });
                await beat("pod-a:1", [OLD.kid]);
                await job.run();
                await job.run();
                const warnings = logger.warn.mock.calls.map((call: any[]) => call[0]).filter((text: string) => text.includes("pod-a:1"));
                expect(warnings).toHaveLength(1);
                expect(warnings[0]).toContain("restart");
            });

            it("doesn't warn before the warning time", async () => {
                await addKey();
                await beat("pod-a:1", [OLD.kid]);
                await job.run();
                expect(logger.warn).not.toHaveBeenCalled();
            });

            it("fails a rotation that has no new key recorded", async () => {
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, rotation: requested({}, "activating") });
                await job.run();
                const current = await rotation();
                expect(current.phase).toBe("failed");
                expect(current.lastError).toContain("no new key");
            });

            it("activates once only when a second replica acts on the state it read before the first activated", async () => {
                const kid = await addKey();
                await beat("pod-a:1", [OLD.kid, kid]);
                const other = await ctx.newJob();
                Object.assign(other, { keyringStore: store, cipher: ctx.cipher(), sources: job.sources, batchSize: 100, warnMinutes: 15, logger });
                // Both replicas read the state before either writes it (staged in turn: in-process SQLite can't hold two transactions at once).
                const stale = await ctx.state();
                await job.run();
                expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_ACTIVATED)).toHaveLength(1);
                const real = other.loadState.bind(other);
                other.loadState = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockImplementation(real);

                await other.run();
                await other.dispose();

                // The loser's write is refused on the version and skipped quietly.
                expect((await ctx.state()).activeKid).toBe(kid);
                expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_ACTIVATED)).toHaveLength(1);
                expect(logger.warn).not.toHaveBeenCalled();
                expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("another writer"));
            });
        });

        describe("re-encrypting", () => {
            /** A rotation whose key is active, with both keys in the ring and the copies given. */
            const activate = async (extra: Record<string, unknown> = {}): Promise<string> => {
                await startRotation(extra);
                await job.run();
                const kid = addedKid();
                await ctx.cipher().reload();
                const state = await ctx.state();
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: kid, rotation: { ...state.rotation, phase: "reencrypting", activatedAt: new Date() } });
                return kid;
            };

            it("waits for every live copy to encrypt with the new key before touching a value", async () => {
                const kid = await activate();
                await insertRow("p1");
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await beat("pod-b:2", [OLD.kid, kid], OLD.kid);

                await job.run();

                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(OLD.kid);
                const current = await rotation();
                expect(current.phase).toBe("reencrypting");
                expect(current.waitingFor).toEqual(["pod-b:2"]);
                expect(await ctx.auditEntries(AuditAction.CONFIG_REENCRYPTED)).toHaveLength(0);
            });

            it("waits when no copy reports at all", async () => {
                await activate();
                await insertRow("p1");
                await job.run();
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(OLD.kid);
                expect((await rotation()).phase).toBe("reencrypting");
            });

            it("re-encrypts every envelope to the active key without changing a value, and counts them per record type", async () => {
                const kid = await activate();
                await insertRow("p1");
                await insertRow("p2", { a: "second-alpha" });
                await beat("pod-a:1", [OLD.kid, kid], kid);

                await job.run();

                for (const [uid, a, b] of [
                    ["p1", "alpha-secret", "bravo-secret"],
                    ["p2", "second-alpha", undefined],
                ] as const) {
                    const row = await ctx.plugin(uid);
                    expect(row.settings.a_token.kid).toBe(kid);
                    expect(open("PluginA", uid, "a_token", row.settings.a_token)).toBe(a);
                    if (b) {
                        expect(row.settings.b_token.kid).toBe(kid);
                        expect(open("PluginB", uid, "b_token", row.settings.b_token)).toBe(b);
                    }
                    expect(row.settings.note).toBe("plain text");
                }
                const audits = await ctx.auditEntries(AuditAction.CONFIG_REENCRYPTED);
                expect(audits).toHaveLength(1);
                expect(audits[0].details).toEqual({ targetKid: kid, counts: { PluginA: 2, PluginB: 1 } });
                expect(audits[0].actorUserUid).toBeFalsy();
                expect(JSON.stringify(audits)).not.toContain("alpha-secret");
            });

            it("re-encrypts a DNS provider's credentials with their own envelope source, leaving the generation and the rest of the row alone", async () => {
                const kid = await activate();
                job.sources.register(dnsProviderEnvelopeSource(ctx.providerModel()));
                const sealCredential = (uid: string, field: string, value: string) => ctx.cipher().encrypt(value, { record: "DnsProvider", uid, field: `credentials.${field}` });
                await ctx.insertProvider("aws-1", { accessKeyId: sealCredential("aws-1", "accessKeyId", "AKIAEXAMPLE"), secretAccessKey: sealCredential("aws-1", "secretAccessKey", "aws-secret") }, 3);
                await ctx.insertProvider("none-1", null, 0);
                const untouched = (await ctx.provider("none-1")).version;
                await beat("pod-a:1", [OLD.kid, kid], kid);

                await job.run();

                const row = await ctx.provider("aws-1");
                expect(row.credentialsGeneration).toBe(3);
                expect(row.name).toBe("provider aws-1");
                for (const [field, value] of [
                    ["accessKeyId", "AKIAEXAMPLE"],
                    ["secretAccessKey", "aws-secret"],
                ]) {
                    expect(row.credentials[field].kid).toBe(kid);
                    expect(ctx.cipher().decrypt(row.credentials[field], { record: "DnsProvider", uid: "aws-1", field: `credentials.${field}` })).toBe(value);
                }
                // A config without credentials has nothing to re-encrypt, and its row is untouched.
                const bare = await ctx.provider("none-1");
                expect(bare.credentials ?? null).toBeNull();
                expect(bare.version).toBe(untouched);
                expect((await ctx.auditEntries(AuditAction.CONFIG_REENCRYPTED))[0].details).toEqual({ targetKid: kid, counts: { DnsProvider: 2 } });
                expect((await ctx.state()).kidUsage).toEqual({ [kid]: 2 });
            });

            it("re-encrypts the Integrations settings' secrets with their own envelope source, leaving the other sections and fields alone", async () => {
                const kid = await activate();
                job.sources.register(integrationSettingsEnvelopeSource(ctx.integrationsModel()));
                const seal = (field: string, value: string) => ctx.cipher().encrypt(value, { record: "IntegrationSettings", uid: "integrations", field });
                await ctx.insertIntegrations({
                    giphy: { enabled: true, apiKey: seal("giphy.apiKey", "giphy-key") },
                    stun: { urls: ["stun:stun.example.com"] },
                    pluginRegistry: {
                        url: "https://registry.example.com",
                        token: seal("pluginRegistry.token", "registry-token"),
                        namespaces: [{ name: "@acme", registry: "https://npm.acme.example", token: seal("pluginRegistry.namespaces.@acme.token", "acme-token") }, { name: "@open" }],
                    },
                });
                await beat("pod-a:1", [OLD.kid, kid], kid);

                await job.run();

                const row = await ctx.integrations();
                const open = (field: string, envelope: ConfigEnvelope) => ctx.cipher().decrypt(envelope, { record: "IntegrationSettings", uid: "integrations", field });
                expect(row.giphy.enabled).toBe(true);
                expect(row.giphy.apiKey.kid).toBe(kid);
                expect(open("giphy.apiKey", row.giphy.apiKey)).toBe("giphy-key");
                expect(row.stun).toEqual({ urls: ["stun:stun.example.com"] });
                expect(row.pluginRegistry.url).toBe("https://registry.example.com");
                expect(row.pluginRegistry.token.kid).toBe(kid);
                expect(open("pluginRegistry.token", row.pluginRegistry.token)).toBe("registry-token");
                expect(row.pluginRegistry.namespaces).toHaveLength(2);
                expect(row.pluginRegistry.namespaces[0].registry).toBe("https://npm.acme.example");
                expect(row.pluginRegistry.namespaces[0].token.kid).toBe(kid);
                expect(open("pluginRegistry.namespaces.@acme.token", row.pluginRegistry.namespaces[0].token)).toBe("acme-token");
                expect(row.pluginRegistry.namespaces[1].token ?? undefined).toBeUndefined();
                expect((await ctx.auditEntries(AuditAction.CONFIG_REENCRYPTED))[0].details).toEqual({ targetKid: kid, counts: { IntegrationSettings: 3 } });
                expect((await ctx.state()).kidUsage).toEqual({ [kid]: 3 });
            });

            it("records the counts per key and that the pass completed", async () => {
                const kid = await activate();
                await insertRow("p1");
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await job.run();
                const state = await ctx.state();
                expect(state.kidUsage).toEqual({ [kid]: 2 });
                expect(rotationDate(state.countedAt)).toBeDefined();
                expect(state.reencryption.targetKid).toBe(kid);
                expect(state.reencryption.complete).toBe(true);
                expect(rotationDate(state.reencryption.startedAt)).toBeDefined();
                expect(rotationDate(state.reencryption.finishedAt)).toBeDefined();
            });

            it("goes through every page of rows in one run", async () => {
                const kid = await activate();
                for (let i = 0; i < 5; i++) {
                    await insertRow(`row-${i}`, { a: `value-${i}` });
                }
                await beat("pod-a:1", [OLD.kid, kid], kid);
                job.batchSize = 2;
                await job.run();
                for (let i = 0; i < 5; i++) {
                    const row = await ctx.plugin(`row-${i}`);
                    expect(open("PluginA", `row-${i}`, "a_token", row.settings.a_token)).toBe(`value-${i}`);
                    expect(row.settings.a_token.kid).toBe(kid);
                }
                expect((await ctx.state()).kidUsage).toEqual({ [kid]: 5 });
            });

            it("skips no row when one is deleted between two pages, every envelope on the old key being re-encrypted before that key is retired", async () => {
                const kid = await activate();
                for (let i = 0; i < 5; i++) {
                    await insertRow(`row-${i}`, { a: `value-${i}` });
                }
                await beat("pod-a:1", [OLD.kid, kid], kid);
                job.batchSize = 2;
                // row-0 is deleted after the first page was read and before the second is.
                const repo: any = await job.repoFor(job.sources.get("PluginA"));
                const find = repo.find.bind(repo);
                let calls = 0;
                // Spied, so the shared repository is restored after the test.
                vi.spyOn(repo, "find").mockImplementation(async (...args: any[]) => {
                    if (++calls === 2) {
                        await ctx.deletePlugin("row-0");
                    }
                    return await find(...args);
                });

                await job.run();

                expect(calls).toBeGreaterThanOrEqual(3);
                for (let i = 1; i < 5; i++) {
                    const row = await ctx.plugin(`row-${i}`);
                    expect(row.settings.a_token.kid).toBe(kid);
                    expect(open("PluginA", `row-${i}`, "a_token", row.settings.a_token)).toBe(`value-${i}`);
                }
                // row-0 was counted on the first page, before it was deleted.
                expect((await ctx.state()).kidUsage).toEqual({ [kid]: 5 });
                expect(kids()).toEqual([kid]);
            });

            it("skips no row when one is added in front of the page being read", async () => {
                const kid = await activate();
                for (let i = 1; i < 5; i++) {
                    await insertRow(`row-${i}`, { a: `value-${i}` });
                }
                await beat("pod-a:1", [OLD.kid, kid], kid);
                job.batchSize = 2;
                const repo: any = await job.repoFor(job.sources.get("PluginA"));
                const find = repo.find.bind(repo);
                let calls = 0;
                // Spied, so the shared repository is restored after the test.
                vi.spyOn(repo, "find").mockImplementation(async (...args: any[]) => {
                    if (++calls === 2) {
                        // Sorts before everything already read, as a row a copy saved a moment ago with the new key would.
                        await ctx.insertPlugin("row-0", { a_token: seal("PluginA", "row-0", "a_token", "value-0") });
                    }
                    return await find(...args);
                });
                await job.run();
                for (let i = 1; i < 5; i++) {
                    expect((await ctx.plugin(`row-${i}`)).settings.a_token.kid).toBe(kid);
                }
                expect((await ctx.state()).kidUsage).toEqual({ [kid]: 4 });
            });

            it("falls back to the default batch size for a setting that isn't a positive number", async () => {
                const kid = await activate();
                await insertRow("p1");
                await beat("pod-a:1", [OLD.kid, kid], kid);
                job.batchSize = "lots";
                await job.run();
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(kid);
            });

            it("changes nothing in a row that is already on the active key", async () => {
                const kid = await activate();
                await ctx.cipher().reload();
                await insertRow("fresh");
                const before = await ctx.plugin("fresh");
                expect(before.settings.a_token.kid).toBe(kid);
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await job.run();
                expect((await ctx.plugin("fresh")).version).toBe(before.version);
                expect(await ctx.auditEntries(AuditAction.CONFIG_REENCRYPTED)).toHaveLength(0);
            });

            it("leaves a row changed meanwhile for the next run, never overwriting the change, and doesn't retire the old key before it is done", async () => {
                const kid = await activate();
                await insertRow("p1");
                await insertRow("p2");
                await beat("pod-a:1", [OLD.kid, kid], kid);
                // A change from elsewhere lands after this run read p1 and before it wrote it.
                const repo: any = await job.repoFor(job.sources.get("PluginA"));
                const update = repo.update.bind(repo);
                let changed = false;
                repo.update = async (...args: any[]) => {
                    if (!changed && args[0].uid === "p1") {
                        changed = true;
                        await ctx.touchPlugin("p1", "changed elsewhere");
                    }
                    return await update(...args);
                };

                await job.run();

                const left = await ctx.plugin("p1");
                expect(left.settings.note).toBe("changed elsewhere");
                expect(left.settings.a_token.kid).toBe(OLD.kid);
                expect((await ctx.plugin("p2")).settings.a_token.kid).toBe(kid);
                const state = await ctx.state();
                expect(state.reencryption.complete).toBe(false);
                expect(state.kidUsage[OLD.kid]).toBeGreaterThan(0);
                expect(state.rotation.phase).toBe("reencrypting");
                expect(kids()).toContain(OLD.kid);

                await job.run();

                const done = await ctx.plugin("p1");
                expect(done.settings.note).toBe("changed elsewhere");
                expect(open("PluginA", "p1", "a_token", done.settings.a_token)).toBe("alpha-secret");
                expect(done.settings.a_token.kid).toBe(kid);
                expect(kids()).toEqual([kid]);
                expect((await rotation()).phase).toBe("done");
            });

            it("leaves a row it can't update for another reason for the next run too, logging it", async () => {
                const kid = await activate();
                await insertRow("p1");
                await beat("pod-a:1", [OLD.kid, kid], kid);
                const repo: any = await job.repoFor(job.sources.get("PluginA"));
                const update = repo.update.bind(repo);
                repo.update = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockImplementation(update);

                await job.run();
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(OLD.kid);
                expect((await ctx.state()).reencryption.complete).toBe(false);
                expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
                // The console shows which row blocks the rotation, without a value and without the error's own text.
                const stuck = await rotation();
                expect(stuck.phase).toBe("reencrypting");
                expect(stuck.lastError).toContain("PluginA 'p1'");
                expect(stuck.lastError).not.toContain("alpha-secret");
                expect(stuck.lastError).not.toContain("disk full");

                await job.run();
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(kid);
                expect((await rotation()).lastError).toBeFalsy();
            });

            it("leaves an envelope it can't decrypt as it is, counted under its key, and names it", async () => {
                const kid = await activate();
                await insertRow("p1");
                // An envelope copied into another field: it names a key in the ring but fails to decrypt where it is.
                await ctx.insertPlugin("p2", { a_token: seal("PluginA", "p1", "a_token", "moved"), note: "n" });
                await beat("pod-a:1", [OLD.kid, kid], kid);

                await job.run();

                const row = await ctx.plugin("p2");
                expect(row.settings.a_token.kid).toBe(OLD.kid);
                const state = await ctx.state();
                expect(state.kidUsage[OLD.kid]).toBe(1);
                expect(state.reencryption.unreadable).toEqual([{ record: "PluginA", uid: "p2", field: "settings.a_token", kid: OLD.kid }]);
                // The old key stays, since an envelope still uses it; the rotation is over with that said.
                expect(kids().sort()).toEqual([OLD.kid, kid].sort());
                expect(state.rotation.phase).toBe("done");
                expect(state.rotation.lastError).toContain(OLD.kid);
                expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_RETIRED)).toHaveLength(0);
                // The readable one was still moved.
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(kid);
            });

            it("fails a rotation whose key isn't the active one", async () => {
                const kid = await activate();
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: OLD.kid, rotation: (await ctx.state()).rotation });
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await job.run();
                const current = await rotation();
                expect(current.phase).toBe("failed");
                expect(current.lastError).toContain("isn't the active key");
            });

            it("re-encrypts nothing while this copy can't encrypt with the new key itself", async () => {
                // The state says the key is active, but this copy's keyring doesn't have it.
                const kid = "ex7ra001";
                await insertRow("p1");
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: kid, rotation: requested({ kid, previousKids: [OLD.kid] }, "reencrypting") });
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await job.run();
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(OLD.kid);
                const current = await rotation();
                expect(current.phase).toBe("reencrypting");
                expect(current.lastError).toContain("can't encrypt with the new key");
            });

            it("logs and leaves everything for the next run when encrypting fails for a reason other than an unreadable envelope", async () => {
                const kid = await activate();
                await insertRow("p1");
                await beat("pod-a:1", [OLD.kid, kid], kid);
                vi.spyOn(ctx.cipher(), "encrypt").mockImplementationOnce(() => {
                    throw new Error("entropy exhausted");
                });
                await expect(job.run()).resolves.toBeUndefined();
                expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("entropy exhausted"));
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(OLD.kid);
                const stuck = await rotation();
                expect(stuck.phase).toBe("reencrypting");
                // Shown to the administrator, not only in the pod's log.
                expect(stuck.lastError).toContain("entropy exhausted");
                await job.run();
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(kid);
                expect((await rotation()).lastError).toBeFalsy();
            });

            it("names at most five rows that couldn't be saved", async () => {
                const kid = await activate();
                for (let i = 0; i < 7; i++) {
                    await insertRow(`row-${i}`, { a: `value-${i}` });
                }
                await beat("pod-a:1", [OLD.kid, kid], kid);
                const repo: any = await job.repoFor(job.sources.get("PluginA"));
                // The repository is shared by every test: its own update comes back whatever happens.
                const update = repo.update;
                repo.update = vi.fn().mockRejectedValue(new Error("validation failed"));
                try {
                    await job.run();
                } finally {
                    repo.update = update;
                }
                const named = ((await rotation()).lastError as string).match(/PluginA 'row-\d'/g);
                expect(named).toHaveLength(5);
            });

            it("names at most 50 unreadable envelopes, however many a restore leaves", async () => {
                const kid = await activate();
                for (let i = 0; i < 52; i++) {
                    await ctx.insertPlugin(`broken-${String(i).padStart(2, "0")}`, { a_token: seal("PluginA", "elsewhere", "a_token", "x") });
                }
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await job.run();
                const state = await ctx.state();
                expect(state.reencryption.unreadable).toHaveLength(50);
                expect(state.kidUsage[OLD.kid]).toBe(52);
            });

            it("uses the default batch size for a setting of zero", async () => {
                const kid = await activate();
                await insertRow("p1");
                await beat("pod-a:1", [OLD.kid, kid], kid);
                job.batchSize = 0;
                await job.run();
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(kid);
            });

            it("keeps waiting for a stale copy after 'Activate anyway', then goes ahead once it is gone", async () => {
                const kid = await activate({ activationForced: { by: "admin-1", at: new Date(), staleCopies: ["pod-stale:9"] } });
                await insertRow("p1");
                vi.useFakeTimers({ toFake: ["Date"] });
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await ctx.channel().putHeartbeat({ copy: "pod-stale:9", kids: [OLD.kid], encrypting: OLD.kid, at: new Date().toISOString() }, 30_000);

                await job.run();
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(OLD.kid);
                expect((await rotation()).waitingFor).toEqual(["pod-stale:9"]);

                vi.setSystemTime(Date.now() + 31_000);
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await job.run();
                expect((await ctx.plugin("p1")).settings.a_token.kid).toBe(kid);
            });

            it("re-encrypts nothing in a deployment whose record types registered no source, and still finishes", async () => {
                const kid = await activate();
                job.sources = new ConfigEnvelopeSourceRegistry();
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await job.run();
                expect(kids()).toEqual([kid]);
                expect((await rotation()).phase).toBe("done");
                expect((await ctx.state()).kidUsage).toEqual({});
            });
        });

        describe("retiring", () => {
            it("removes the old key as soon as a full pass finds no envelope on it, audits it and tells every copy", async () => {
                await startRotation();
                await job.run();
                const kid = addedKid();
                await insertRow("p1");
                await beat("pod-a:1", [OLD.kid, kid], OLD.kid);
                await job.run();
                expect((await ctx.state()).activeKid).toBe(kid);
                const noticed = vi.fn();
                await ctx.channel().onChanged(noticed);

                // Every copy has reloaded and now encrypts with the new key.
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await job.run();

                expect(kids()).toEqual([kid]);
                const state = await ctx.state();
                expect(state.rotation.phase).toBe("done");
                expect(rotationDate(state.rotation.finishedAt)).toBeDefined();
                expect(state.rotation.lastError).toBeFalsy();
                expect(state.activeKid).toBe(kid);
                const audits = await ctx.auditEntries(AuditAction.CONFIG_KEY_RETIRED);
                expect(audits).toHaveLength(1);
                expect(audits[0].details).toEqual({ kid: OLD.kid });
                expect(noticed).toHaveBeenCalled();
                expect(open("PluginA", "p1", "a_token", (await ctx.plugin("p1")).settings.a_token)).toBe("alpha-secret");
            });

            it("treats a compromised rotation the same, the old key going right after re-encryption", async () => {
                await startRotation({ compromised: true });
                await job.run();
                const kid = addedKid();
                await insertRow("p1");
                await beat("pod-a:1", [OLD.kid, kid], OLD.kid);
                await job.run();
                await beat("pod-a:1", [OLD.kid, kid], kid);
                await job.run();
                expect(kids()).toEqual([kid]);
                const state = await ctx.state();
                expect(state.rotation.phase).toBe("done");
                expect(state.rotation.compromised).toBe(true);
                expect((await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATED))[0].details.reason).toBe("compromised");
            });

            it("retries when the keyring changed under the removal, leaving the rotation in retiring", async () => {
                const kid = "ex7ra001";
                writeRing(OLD, { kid, key: Buffer.alloc(32, 9).toString("base64"), createdAt: new Date().toISOString() });
                await ctx.cipher().reload();
                await ctx.saveState({
                    uid: CONFIG_KEY_STATE_UID,
                    activeKid: kid,
                    kidUsage: { [kid]: 1 },
                    rotation: requested({ kid, previousKids: [OLD.kid] }, "retiring"),
                });
                vi.spyOn(store, "write").mockRejectedValueOnce(new ConfigKeyringConflictError("The keyring was changed by someone else."));
                await job.run();
                expect(kids()).toHaveLength(2);
                const first = await rotation();
                expect(first.phase).toBe("retiring");
                expect(first.lastError).toContain("changed by someone else");
                await job.run();
                expect(kids()).toEqual([kid]);
                const second = await rotation();
                expect(second.phase).toBe("done");
                expect(second.lastError).toBeFalsy();
            });

            it("goes back to re-encrypting instead of removing a key that an envelope saved after the pass still uses", async () => {
                await startRotation();
                await job.run();
                const kid = addedKid();
                await ctx.cipher().reload();
                // Sealed under the old key by a writer that had not yet loaded the new one, and saved after the final pass counted the rows.
                await insertRow("late");
                expect((await ctx.plugin("late")).settings.a_token.kid).toBe(OLD.kid);
                const state = await ctx.state();
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: kid, kidUsage: { [kid]: 0 }, rotation: { ...state.rotation, phase: "retiring" } });
                await beat("pod-a:1", [OLD.kid, kid], kid);

                await job.run();

                expect((await ctx.plugin("late")).settings.a_token.kid).toBe(kid);
                expect(open("PluginA", "late", "a_token", (await ctx.plugin("late")).settings.a_token)).toBe("alpha-secret");
                expect(kids()).toEqual([kid]);
                expect((await rotation()).phase).toBe("done");
            });

            it("does not write the keyring while the recount still finds the old key in use", async () => {
                await startRotation();
                await job.run();
                const kid = addedKid();
                await ctx.cipher().reload();
                await insertRow("late");
                const state = await ctx.state();
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: kid, kidUsage: { [kid]: 0 }, rotation: { ...state.rotation, phase: "retiring" } });
                // No heartbeat: the re-encrypting step that follows waits for the copies, so the run ends with the key still in the ring.
                const write = vi.spyOn(store, "write");

                await job.run();

                expect(write).not.toHaveBeenCalled();
                expect(kids()).toEqual([OLD.kid, kid]);
                expect((await rotation()).phase).toBe("reencrypting");
                expect((await ctx.plugin("late")).settings.a_token.kid).toBe(OLD.kid);
            });

            it("keeps the old key and tries again when the recount before the removal fails", async () => {
                await startRotation();
                await job.run();
                const kid = addedKid();
                await ctx.cipher().reload();
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: kid, kidUsage: { [kid]: 0 }, rotation: requested({ kid, previousKids: [OLD.kid] }, "retiring") });
                const repo: any = await job.repoFor(job.sources.get("PluginA"));
                const find = vi.spyOn(repo, "find").mockRejectedValueOnce(new Error("database down"));

                await job.run();

                expect(kids()).toEqual([OLD.kid, kid]);
                const first = await rotation();
                expect(first.phase).toBe("retiring");
                expect(first.lastError).toContain("database down");
                find.mockRestore();

                await job.run();

                expect(kids()).toEqual([kid]);
                expect((await rotation()).phase).toBe("done");
            });

            it("never removes a key an envelope still uses", async () => {
                const kid = "ex7ra001";
                writeRing(OLD, { kid, key: Buffer.alloc(32, 9).toString("base64"), createdAt: new Date().toISOString() });
                await ctx.cipher().reload();
                await ctx.saveState({
                    uid: CONFIG_KEY_STATE_UID,
                    activeKid: kid,
                    kidUsage: { [kid]: 2, [OLD.kid]: 1 },
                    rotation: requested({ kid, previousKids: [OLD.kid] }, "retiring"),
                });
                await job.run();
                expect(kids()).toEqual([OLD.kid, kid]);
                const state = await ctx.state();
                expect(state.rotation.phase).toBe("done");
                expect(state.rotation.lastError).toContain(OLD.kid);
            });

            it("never removes the active key, and so never empties the ring", async () => {
                await ctx.saveState({
                    uid: CONFIG_KEY_STATE_UID,
                    activeKid: "f00dbabe",
                    kidUsage: {},
                    rotation: requested({ kid: "f00dbabe", previousKids: [OLD.kid] }, "retiring"),
                });
                await job.run();
                expect(kids()).toEqual([OLD.kid]);
                const current = await rotation();
                expect(current.phase).toBe("retiring");
                expect(current.lastError).toContain("f00dbabe");
            });

            it("tries again when the keyring can't be read", async () => {
                await ctx.saveState({
                    uid: CONFIG_KEY_STATE_UID,
                    activeKid: OLD.kid,
                    kidUsage: {},
                    rotation: requested({ kid: OLD.kid }, "retiring"),
                });
                vi.spyOn(store, "read").mockRejectedValueOnce(new Error("the Kubernetes API is unreachable"));
                await job.run();
                const current = await rotation();
                expect(current.phase).toBe("retiring");
                expect(current.lastError).toContain("unreachable");
                await job.run();
                expect((await rotation()).phase).toBe("done");
            });

            it("removes nothing when no key is recorded as active", async () => {
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, kidUsage: {}, rotation: requested({ kid: OLD.kid }, "retiring") });
                await job.run();
                expect(kids()).toEqual([OLD.kid]);
                const current = await rotation();
                expect(current.phase).toBe("retiring");
                expect(current.lastError).toContain("isn't recorded");
            });

            it("removes nothing when the envelopes haven't been counted", async () => {
                const kid = "ex7ra001";
                writeRing(OLD, { kid, key: Buffer.alloc(32, 9).toString("base64"), createdAt: new Date().toISOString() });
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: kid, rotation: requested({ kid, previousKids: [OLD.kid] }, "retiring") });
                await job.run();
                expect(kids()).toEqual([OLD.kid, kid]);
                expect((await rotation()).lastError).toContain("counted");
            });

            it("finishes without a write when there is nothing but the active key", async () => {
                const write = vi.spyOn(store, "write");
                await ctx.saveState({
                    uid: CONFIG_KEY_STATE_UID,
                    activeKid: OLD.kid,
                    kidUsage: { [OLD.kid]: 1 },
                    rotation: requested({ kid: OLD.kid, previousKids: [] }, "retiring"),
                });
                await job.run();
                expect(write).not.toHaveBeenCalled();
                expect((await rotation()).phase).toBe("done");
            });

            it("finishes when another copy already removed the key but crashed before recording it", async () => {
                const kid = "ex7ra001";
                writeRing({ kid, key: Buffer.alloc(32, 9).toString("base64"), createdAt: new Date().toISOString() });
                await ctx.cipher().reload();
                await ctx.saveState({
                    uid: CONFIG_KEY_STATE_UID,
                    activeKid: kid,
                    kidUsage: { [kid]: 1 },
                    rotation: requested({ kid, previousKids: [OLD.kid] }, "retiring"),
                });
                await job.run();
                expect(kids()).toEqual([kid]);
                expect((await rotation()).phase).toBe("done");
            });

            it("is finished once when a second replica acts on the state it read before the first finished, every value still readable", async () => {
                await startRotation();
                await job.run();
                const kid = addedKid();
                await insertRow("p1");
                await insertRow("p2", { a: "second-alpha" });
                await beat("pod-a:1", [OLD.kid, kid], OLD.kid);
                await job.run();
                await beat("pod-a:1", [OLD.kid, kid], kid);
                logger.warn.mockClear();

                const other = await ctx.newJob();
                Object.assign(other, { keyringStore: store, cipher: ctx.cipher(), sources: job.sources, batchSize: 100, warnMinutes: 15, logger });
                // Both replicas read the state before either writes it (staged in turn: in-process SQLite can't hold two transactions at once).
                const stale = await ctx.state();
                await job.run();
                expect(kids()).toEqual([kid]);
                const real = other.loadState.bind(other);
                other.loadState = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockImplementation(real);

                await other.run();
                await other.dispose();

                expect(kids()).toEqual([kid]);
                expect((await rotation()).phase).toBe("done");
                expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_RETIRED)).toHaveLength(1);
                expect(await ctx.auditEntries(AuditAction.CONFIG_REENCRYPTED)).toHaveLength(1);
                expect(logger.warn).not.toHaveBeenCalled();
                expect(open("PluginA", "p1", "a_token", (await ctx.plugin("p1")).settings.a_token)).toBe("alpha-secret");
                expect(open("PluginA", "p2", "a_token", (await ctx.plugin("p2")).settings.a_token)).toBe("second-alpha");
            });
        });

        describe("the rotation notice", () => {
            it("starts a run at once when a notice arrives, without waiting for the schedule", async () => {
                await startRotation();
                await job.subscribe();
                await ctx.channel().notifyChanged();
                await vi.waitFor(async () => expect((await rotation()).phase).toBe("activating"));
            });

            it("stops listening once disposed", async () => {
                await startRotation();
                await job.subscribe();
                await job.dispose();
                await ctx.channel().notifyChanged();
                await new Promise((resolve) => setTimeout(resolve, 200));
                expect((await rotation()).phase).toBe("adding");
            });

            it("keeps the job alive when a run started by a notice fails", async () => {
                await startRotation();
                vi.spyOn(store, "read").mockImplementation(() => {
                    throw new Error("disk on fire");
                });
                await job.subscribe();
                await ctx.channel().notifyChanged();
                await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
            });
        });
    });
}
