///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `ConfigKeyHeartbeat` (spec 5.5, step 2): each server process tells the others which keys it has loaded and which one it encrypts with, every 30 s with
// a TTL of three heartbeats and at once after each keyring reload, so a rotation activates a new key only when every live copy has it.
import { ConfigCipher } from "../../src/secrets/ConfigCipher.js";
import { configKeyCopyId, LocalConfigKeyChannel, type ConfigKeyHeartbeatEntry } from "../../src/secrets/ConfigKeyChannel.js";
import { ConfigKeyHeartbeat } from "../../src/secrets/ConfigKeyHeartbeat.js";
import type { ConfigKeyring } from "../../src/secrets/ConfigKeyring.js";

const OLD = { kid: "0ld0ld01", key: Buffer.alloc(32, 1).toString("base64"), createdAt: "2026-09-01T00:00:00.000Z" };
const NEW = { kid: "n3wn3w03", key: Buffer.alloc(32, 3).toString("base64"), createdAt: "2026-10-28T00:00:00.000Z" };

interface Harness {
    heartbeat: ConfigKeyHeartbeat;
    cipher: ConfigCipher;
    channel: LocalConfigKeyChannel;
    logger: { warn: ReturnType<typeof vi.fn> };
    ring: { value: ConfigKeyring };
    ttls: number[];
}

const live: { dispose(): Promise<void> }[] = [];

async function setup(ring: ConfigKeyring, heartbeatSeconds: unknown = 30): Promise<Harness> {
    const holder = { value: ring };
    const cipher: any = new ConfigCipher();
    Object.defineProperty(cipher, "keyring", { get: () => holder.value, set: () => undefined, configurable: true });
    cipher.keyringFile = "";
    cipher.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    await cipher.init();
    live.push(cipher);

    const channel = new LocalConfigKeyChannel();
    const ttls: number[] = [];
    const originalPut = channel.putHeartbeat.bind(channel);
    channel.putHeartbeat = async (entry: ConfigKeyHeartbeatEntry, ttlMs: number) => {
        ttls.push(ttlMs);
        await originalPut(entry, ttlMs);
    };
    const logger = { warn: vi.fn() };
    const heartbeat: any = new ConfigKeyHeartbeat();
    heartbeat.cipher = cipher;
    heartbeat.channel = channel;
    heartbeat.logger = logger;
    heartbeat.heartbeatSeconds = heartbeatSeconds;
    await heartbeat.init();
    live.push(heartbeat);
    return { heartbeat, cipher, channel, logger, ring: holder, ttls };
}

const mine = async (channel: LocalConfigKeyChannel): Promise<ConfigKeyHeartbeatEntry | undefined> =>
    (await channel.heartbeats()).find((beat) => beat.copy === configKeyCopyId());

afterEach(async () => {
    for (const item of live.splice(0)) {
        await item.dispose();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("ConfigKeyHeartbeat", () => {
    it("reports the loaded keys and the one this copy encrypts with as soon as it starts, with a TTL of three heartbeats", async () => {
        const { channel, ttls } = await setup({ keys: [OLD, NEW] });
        const beat = await mine(channel);
        expect(beat).toBeDefined();
        expect(beat!.kids.sort()).toEqual([NEW.kid, OLD.kid].sort());
        // No key has ever been activated, so the original encrypts even with a newer one loaded.
        expect(beat!.encrypting).toBe(OLD.kid);
        expect(Date.parse(beat!.at)).not.toBeNaN();
        expect(ttls).toEqual([90_000]);
    });

    it("beats again every heartbeat interval", async () => {
        vi.useFakeTimers();
        const { ttls } = await setup({ keys: [OLD] });
        expect(ttls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(ttls).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(ttls).toHaveLength(4);
    });

    it("takes the interval from config_encryption:activation:heartbeat_seconds, and the TTL as three of them", async () => {
        vi.useFakeTimers();
        const { ttls } = await setup({ keys: [OLD] }, 10);
        expect(ttls).toEqual([30_000]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(ttls).toEqual([30_000, 30_000]);
    });

    it("uses 30 seconds for an interval that isn't a positive number", async () => {
        vi.useFakeTimers();
        const { ttls } = await setup({ keys: [OLD] }, "soon");
        expect(ttls).toEqual([90_000]);
        await vi.advanceTimersByTimeAsync(29_000);
        expect(ttls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ttls).toHaveLength(2);
    });

    it("reports a key added by a reload at once, without waiting for the next beat", async () => {
        const { channel, cipher, ring } = await setup({ keys: [OLD] });
        expect((await mine(channel))!.kids).toEqual([OLD.kid]);
        ring.value = { keys: [OLD, NEW] };
        await cipher.reload();
        await vi.waitFor(async () => expect((await mine(channel))!.kids.sort()).toEqual([NEW.kid, OLD.kid].sort()));
    });

    it("reloads the keyring and beats at once when a rotation notice arrives", async () => {
        const { channel, ring } = await setup({ keys: [OLD] });
        ring.value = { keys: [OLD, NEW] };
        await channel.notifyChanged();
        await vi.waitFor(async () => expect((await mine(channel))!.kids.sort()).toEqual([NEW.kid, OLD.kid].sort()));
    });

    it("never throws when the channel fails, logging each distinct failure once", async () => {
        vi.useFakeTimers();
        const { heartbeat, channel, logger } = await setup({ keys: [OLD] });
        const put = vi.spyOn(channel, "putHeartbeat").mockRejectedValue(new Error("redis down"));
        await expect(heartbeat.beat()).resolves.toBeUndefined();
        await expect(heartbeat.beat()).resolves.toBeUndefined();
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toContain("redis down");
        put.mockRejectedValue(new Error("redis still down, differently"));
        await heartbeat.beat();
        expect(logger.warn).toHaveBeenCalledTimes(2);
        put.mockRestore();
        await heartbeat.beat();
        expect(await mine(channel)).toBeDefined();
        // A failure after it recovered is news again.
        vi.spyOn(channel, "putHeartbeat").mockRejectedValue(new Error("redis down"));
        await heartbeat.beat();
        expect(logger.warn).toHaveBeenCalledTimes(3);
    });

    it("stops beating, and stops listening, once disposed", async () => {
        vi.useFakeTimers();
        const { heartbeat, channel, cipher, ring, ttls } = await setup({ keys: [OLD] });
        await heartbeat.dispose();
        const beats = ttls.length;
        await vi.advanceTimersByTimeAsync(120_000);
        ring.value = { keys: [OLD, NEW] };
        await cipher.reload();
        await channel.notifyChanged();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ttls).toHaveLength(beats);
        // Disposing twice is fine.
        await expect(heartbeat.dispose()).resolves.toBeUndefined();
    });

    it("finds the channel through the object factory when none was given", async () => {
        const registered = new LocalConfigKeyChannel();
        const cipher: any = new ConfigCipher();
        cipher.keyring = { keys: [OLD] };
        cipher.keyringFile = "";
        await cipher.init();
        live.push(cipher);
        const heartbeat: any = new ConfigKeyHeartbeat();
        heartbeat.cipher = cipher;
        heartbeat._objectFactory = { newInstance: vi.fn(async () => registered) };
        await heartbeat.init();
        live.push(heartbeat);
        expect((await registered.heartbeats()).map((beat) => beat.copy)).toEqual([configKeyCopyId()]);
    });

    it("reports to no one in production when the server registered no channel, rather than to a channel only this process can see", async () => {
        vi.stubEnv("NODE_ENV", "production");
        const cipher: any = new ConfigCipher();
        cipher.keyring = { keys: [OLD] };
        cipher.keyringFile = "";
        await cipher.init();
        live.push(cipher);
        const heartbeat: any = new ConfigKeyHeartbeat();
        heartbeat.cipher = cipher;
        heartbeat.logger = { warn: vi.fn(), error: vi.fn() };
        await expect(heartbeat.init()).resolves.toBeUndefined();
        live.push(heartbeat);
        expect(heartbeat.channel).toBeUndefined();
        expect(heartbeat.timer).toBeUndefined();
        expect(heartbeat.logger.error).toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it("does nothing without a cipher, rather than reporting keys it doesn't have", async () => {
        const heartbeat: any = new ConfigKeyHeartbeat();
        heartbeat.channel = new LocalConfigKeyChannel();
        await heartbeat.init();
        live.push(heartbeat);
        expect(await heartbeat.channel.heartbeats()).toEqual([]);
    });

    it("reports no encrypting key, and no kids, while it has no keyring", async () => {
        const { channel } = await setup({ keys: [OLD] });
        const bare: any = new ConfigCipher();
        bare.keyringFile = "";
        bare.keyring = "";
        bare.logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
        await bare.init();
        live.push(bare);
        const heartbeat: any = new ConfigKeyHeartbeat();
        heartbeat.cipher = bare;
        heartbeat.channel = channel;
        await heartbeat.init();
        live.push(heartbeat);
        const own = await mine(channel);
        expect(own!.kids).toEqual([]);
        expect("encrypting" in own!).toBe(false);
    });

    it("relies on the next beat, saying so, when the rotation notice can't be heard", async () => {
        const channel = new LocalConfigKeyChannel();
        vi.spyOn(channel, "onChanged").mockRejectedValue(new Error("redis down"));
        const cipher: any = new ConfigCipher();
        cipher.keyring = { keys: [OLD] };
        cipher.keyringFile = "";
        await cipher.init();
        live.push(cipher);
        const logger = { warn: vi.fn() };
        const heartbeat: any = new ConfigKeyHeartbeat();
        heartbeat.cipher = cipher;
        heartbeat.channel = channel;
        heartbeat.logger = logger;
        await heartbeat.init();
        live.push(heartbeat);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("redis down"));
        expect(await mine(channel)).toBeDefined();
    });

    it("is not troubled by a notice subscription that can't be ended", async () => {
        const channel = new LocalConfigKeyChannel();
        vi.spyOn(channel, "onChanged").mockResolvedValue(async () => {
            throw new Error("already gone");
        });
        const cipher: any = new ConfigCipher();
        cipher.keyring = { keys: [OLD] };
        cipher.keyringFile = "";
        await cipher.init();
        live.push(cipher);
        const heartbeat: any = new ConfigKeyHeartbeat();
        heartbeat.cipher = cipher;
        heartbeat.channel = channel;
        await heartbeat.init();
        await expect(heartbeat.dispose()).resolves.toBeUndefined();
    });
});
