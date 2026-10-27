///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `ConfigKeyChannel` (spec 5.5): the keyring heartbeats every server copy keeps (`rapidmx:config-keys:loaded:<pod>:<pid>`, 90 s TTL), the lock that
// lets one copy act at a time and the `rapidmx:config-keys:changed` notice. `LocalConfigKeyChannel` is the single-process form (`yarn dev`, tests);
// `RedisConfigKeyChannel` is the same over node-redis, tested here against a fake client.
import {
    CONFIG_KEYS_CHANGED_CHANNEL,
    CONFIG_KEYS_LOADED_PREFIX,
    CONFIG_KEYS_LOCK_KEY,
    LocalConfigKeyChannel,
    RedisConfigKeyChannel,
    configKeyCopyId,
    resolveConfigKeyChannel,
    sharedLocalConfigKeyChannel,
    type ConfigKeyHeartbeatEntry,
} from "../../src/secrets/ConfigKeyChannel.js";

const entry = (copy: string, kids: string[] = ["aaaa1111"], encrypting: string | undefined = kids[0]): ConfigKeyHeartbeatEntry => ({
    copy,
    kids,
    encrypting,
    at: "2026-10-28T12:00:00.000Z",
});

describe("names", () => {
    it("uses the spec's Redis keys and channel", () => {
        expect(CONFIG_KEYS_CHANGED_CHANNEL).toBe("rapidmx:config-keys:changed");
        expect(CONFIG_KEYS_LOADED_PREFIX).toBe("rapidmx:config-keys:loaded:");
        expect(CONFIG_KEYS_LOCK_KEY).toBe("rapidmx:config-keys:lock");
    });

    it("identifies a copy by its pod name and process id", () => {
        const before = process.env.HOSTNAME;
        process.env.HOSTNAME = "mail-7d9f-abc12";
        try {
            expect(configKeyCopyId()).toBe(`mail-7d9f-abc12:${process.pid}`);
        } finally {
            if (before === undefined) {
                delete process.env.HOSTNAME;
            } else {
                process.env.HOSTNAME = before;
            }
        }
    });

    it("falls back to the machine's host name outside Kubernetes", () => {
        const before = process.env.HOSTNAME;
        delete process.env.HOSTNAME;
        try {
            expect(configKeyCopyId()).toMatch(new RegExp(`^.+:${process.pid}$`));
        } finally {
            if (before !== undefined) {
                process.env.HOSTNAME = before;
            }
        }
    });
});

describe("LocalConfigKeyChannel", () => {
    let now: number;
    let channel: LocalConfigKeyChannel;

    beforeEach(() => {
        now = 1_000_000;
        channel = new LocalConfigKeyChannel(() => now);
    });

    it("lists the heartbeats that haven't expired, the latest one per copy", async () => {
        await channel.putHeartbeat(entry("pod-a:1", ["k1"]), 90_000);
        await channel.putHeartbeat(entry("pod-b:2", ["k1", "k2"], "k1"), 90_000);
        await channel.putHeartbeat(entry("pod-a:1", ["k1", "k2"], "k1"), 90_000);
        const beats = (await channel.heartbeats()).sort((a, b) => a.copy.localeCompare(b.copy));
        expect(beats.map((beat) => [beat.copy, beat.kids])).toEqual([
            ["pod-a:1", ["k1", "k2"]],
            ["pod-b:2", ["k1", "k2"]],
        ]);
    });

    it("drops a copy once its heartbeat is older than its TTL", async () => {
        await channel.putHeartbeat(entry("pod-a:1"), 90_000);
        await channel.putHeartbeat(entry("pod-b:2"), 30_000);
        now += 31_000;
        expect((await channel.heartbeats()).map((beat) => beat.copy)).toEqual(["pod-a:1"]);
        now += 60_000;
        expect(await channel.heartbeats()).toEqual([]);
    });

    it("grants the lock to one holder at a time until it is released", async () => {
        const first = await channel.acquireLock(60_000);
        expect(first).toBeDefined();
        expect(await channel.acquireLock(60_000)).toBeUndefined();
        await first!.release();
        const second = await channel.acquireLock(60_000);
        expect(second).toBeDefined();
        await second!.release();
    });

    it("frees a lock whose holder never released it once its TTL has passed", async () => {
        await channel.acquireLock(60_000);
        now += 59_000;
        expect(await channel.acquireLock(60_000)).toBeUndefined();
        now += 2_000;
        expect(await channel.acquireLock(60_000)).toBeDefined();
    });

    it("never lets a holder whose lock expired release the lock a later holder took", async () => {
        const stale = await channel.acquireLock(1_000);
        now += 2_000;
        const current = await channel.acquireLock(60_000);
        await stale!.release();
        expect(await channel.acquireLock(60_000)).toBeUndefined();
        await current!.release();
        expect(await channel.acquireLock(60_000)).toBeDefined();
    });

    it("tells every subscriber about a change until it unsubscribes", async () => {
        const first = vi.fn();
        const second = vi.fn();
        const stopFirst = await channel.onChanged(first);
        await channel.onChanged(second);
        await channel.notifyChanged();
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        await stopFirst();
        await channel.notifyChanged();
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(2);
    });

    it("keeps notifying when a subscriber throws", async () => {
        const after = vi.fn();
        await channel.onChanged(() => {
            throw new Error("boom");
        });
        await channel.onChanged(after);
        await expect(channel.notifyChanged()).resolves.toBeUndefined();
        expect(after).toHaveBeenCalledTimes(1);
    });

    it("forgets every heartbeat and lock on reset(), for a test that starts again", async () => {
        await channel.putHeartbeat(entry("pod-a:1"), 90_000);
        await channel.acquireLock(60_000);
        channel.reset();
        expect(await channel.heartbeats()).toEqual([]);
        expect(await channel.acquireLock(60_000)).toBeDefined();
    });

    it("defaults to the real clock", async () => {
        const real = new LocalConfigKeyChannel();
        await real.putHeartbeat(entry("pod-a:1"), 90_000);
        expect(await real.heartbeats()).toHaveLength(1);
    });
});

describe("sharedLocalConfigKeyChannel()", () => {
    it("is one channel for the whole process, so the heartbeat and the job of a single process see each other", () => {
        expect(sharedLocalConfigKeyChannel()).toBe(sharedLocalConfigKeyChannel());
        expect(sharedLocalConfigKeyChannel()).toBeInstanceOf(LocalConfigKeyChannel);
    });
});

describe("resolveConfigKeyChannel()", () => {
    it("uses the channel the server registered", async () => {
        const registered = new LocalConfigKeyChannel();
        const factory: any = { newInstance: vi.fn(async () => registered) };
        expect(await resolveConfigKeyChannel(factory)).toBe(registered);
        expect(factory.newInstance).toHaveBeenCalledWith("ConfigKeyChannel", { name: "default" });
    });

    it("falls back to the process's own channel, saying so, when none is registered", async () => {
        const logger = { warn: vi.fn() };
        const factory: any = {
            newInstance: vi.fn(async () => {
                throw new Error("no such type");
            }),
        };
        expect(await resolveConfigKeyChannel(factory, logger)).toBe(sharedLocalConfigKeyChannel());
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no such type"));
    });

    it("falls back without a factory or a logger, and when the factory answers nothing", async () => {
        expect(await resolveConfigKeyChannel(undefined)).toBe(sharedLocalConfigKeyChannel());
        const empty: any = { newInstance: vi.fn(async () => undefined) };
        expect(await resolveConfigKeyChannel(empty)).toBe(sharedLocalConfigKeyChannel());
        const failing: any = {
            newInstance: vi.fn(async () => {
                throw new Error("x");
            }),
        };
        expect(await resolveConfigKeyChannel(failing)).toBe(sharedLocalConfigKeyChannel());
    });
});

describe("resolveConfigKeyChannel() in production", () => {
    it("still uses the channel the server registered", async () => {
        const registered = new LocalConfigKeyChannel();
        const factory: any = { newInstance: vi.fn(async () => registered) };
        expect(await resolveConfigKeyChannel(factory, undefined, true)).toBe(registered);
    });

    it("has no channel, saying so as an error, rather than coordinate several server copies within each process alone", async () => {
        const logger = { warn: vi.fn(), error: vi.fn() };
        const failing: any = {
            newInstance: vi.fn(async () => {
                throw new Error("no such type");
            }),
        };
        expect(await resolveConfigKeyChannel(failing, logger, true)).toBeUndefined();
        expect(await resolveConfigKeyChannel(undefined, logger, true)).toBeUndefined();
        expect(await resolveConfigKeyChannel({ newInstance: vi.fn(async () => undefined) }, undefined, true)).toBeUndefined();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("no such type"));
        expect(logger.error).toHaveBeenCalledTimes(2);
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("decides by NODE_ENV when not told", async () => {
        vi.stubEnv("NODE_ENV", "production");
        try {
            expect(await resolveConfigKeyChannel(undefined)).toBeUndefined();
        } finally {
            vi.unstubAllEnvs();
        }
        expect(await resolveConfigKeyChannel(undefined)).toBe(sharedLocalConfigKeyChannel());
    });
});

/** The part of node-redis the channel uses, in memory, with expiry on a clock the test moves. */
class FakeRedis {
    public clock: { now: number } = { now: 0 };
    public values: Map<string, { value: string; expiresAt?: number }> = new Map();
    public published: { channel: string; message: string }[] = [];
    public subscriptions: Map<string, Set<(message: string) => void>> = new Map();
    public connected: boolean = false;
    public quitCalled: boolean = false;
    public failNext?: Error;
    public duplicates: FakeRedis[] = [];

    private live(key: string): { value: string; expiresAt?: number } | undefined {
        const found = this.values.get(key);
        if (found && found.expiresAt !== undefined && found.expiresAt <= this.clock.now) {
            this.values.delete(key);
            return undefined;
        }
        return found;
    }

    private check(): void {
        if (this.failNext) {
            const err = this.failNext;
            this.failNext = undefined;
            throw err;
        }
    }

    public async set(key: string, value: string, options?: { NX?: boolean; PX?: number }): Promise<string | null> {
        this.check();
        if (options?.NX && this.live(key)) {
            return null;
        }
        this.values.set(key, { value, expiresAt: options?.PX !== undefined ? this.clock.now + options.PX : undefined });
        return "OK";
    }

    public async scan(cursor: string, options: { MATCH: string; COUNT?: number }): Promise<{ cursor: string; keys: string[] }> {
        this.check();
        const prefix = options.MATCH.replace(/\*$/, "");
        const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix) && this.live(key));
        // Two keys per page, so the channel has to follow the cursor.
        const start = Number(cursor);
        const page = keys.slice(start, start + 2);
        return { cursor: start + 2 >= keys.length ? "0" : String(start + 2), keys: page };
    }

    public async mGet(keys: string[]): Promise<(string | null)[]> {
        this.check();
        return keys.map((key) => this.live(key)?.value ?? null);
    }

    public async eval(_script: string, options: { keys: string[]; arguments: string[] }): Promise<number> {
        this.check();
        const found = this.live(options.keys[0]);
        if (found && found.value === options.arguments[0]) {
            this.values.delete(options.keys[0]);
            return 1;
        }
        return 0;
    }

    public async publish(channel: string, message: string): Promise<number> {
        this.check();
        this.published.push({ channel, message });
        for (const listener of this.subscriptions.get(channel) ?? []) {
            listener(message);
        }
        return 1;
    }

    public duplicate(): FakeRedis {
        const copy = new FakeRedis();
        copy.clock = this.clock;
        this.duplicates.push(copy);
        return copy;
    }

    public async connect(): Promise<void> {
        this.connected = true;
    }

    public async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
        const set = this.subscriptions.get(channel) ?? new Set();
        set.add(listener);
        this.subscriptions.set(channel, set);
    }

    public async unsubscribe(channel: string): Promise<void> {
        this.subscriptions.delete(channel);
    }

    public async quit(): Promise<void> {
        this.quitCalled = true;
        this.connected = false;
    }
}

describe("RedisConfigKeyChannel", () => {
    let cache: FakeRedis;
    let events: FakeRedis;
    let channel: RedisConfigKeyChannel;
    let logger: { warn: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        cache = new FakeRedis();
        events = new FakeRedis();
        events.clock = cache.clock;
        logger = { warn: vi.fn() };
        const connections = new Map<string, any>([
            ["cache", cache],
            ["events", events],
        ]);
        channel = new RedisConfigKeyChannel();
        (channel as any).connectionManager = { connections };
        (channel as any).logger = logger;
    });

    it("writes a heartbeat under the copy's own key with the TTL, as JSON", async () => {
        await channel.putHeartbeat(entry("pod-a:1", ["k1", "k2"], "k1"), 90_000);
        const stored = cache.values.get(`${CONFIG_KEYS_LOADED_PREFIX}pod-a:1`)!;
        expect(JSON.parse(stored.value)).toEqual({ copy: "pod-a:1", kids: ["k1", "k2"], encrypting: "k1", at: "2026-10-28T12:00:00.000Z" });
        expect(stored.expiresAt).toBe(90_000);
    });

    it("lists the live heartbeats across scan pages, skipping an entry it can't parse", async () => {
        for (const name of ["a", "b", "c"]) {
            await channel.putHeartbeat(entry(`pod-${name}:1`), 90_000);
        }
        cache.values.set(`${CONFIG_KEYS_LOADED_PREFIX}pod-bad:1`, { value: "{not json" });
        cache.values.set(`${CONFIG_KEYS_LOADED_PREFIX}pod-shape:1`, { value: JSON.stringify({ copy: "pod-shape:1" }) });
        cache.values.set("rapidmx:config-keys:other", { value: "x" });
        const beats = await channel.heartbeats();
        expect(beats.map((beat) => beat.copy).sort()).toEqual(["pod-a:1", "pod-b:1", "pod-c:1"]);
    });

    it("stops listing a copy once its key has expired", async () => {
        await channel.putHeartbeat(entry("pod-a:1"), 90_000);
        cache.clock.now = 91_000;
        expect(await channel.heartbeats()).toEqual([]);
    });

    it("lists nothing when no heartbeat key exists", async () => {
        expect(await channel.heartbeats()).toEqual([]);
    });

    it("takes the lock with SET NX PX and releases only its own token", async () => {
        const first = await channel.acquireLock(60_000);
        expect(first).toBeDefined();
        expect(cache.values.get(CONFIG_KEYS_LOCK_KEY)!.expiresAt).toBe(60_000);
        expect(await channel.acquireLock(60_000)).toBeUndefined();
        await first!.release();
        expect(cache.values.has(CONFIG_KEYS_LOCK_KEY)).toBe(false);

        const stale = await channel.acquireLock(1_000);
        cache.clock.now = 2_000;
        const current = await channel.acquireLock(60_000);
        await stale!.release();
        expect(cache.values.has(CONFIG_KEYS_LOCK_KEY)).toBe(true);
        await current!.release();
        expect(cache.values.has(CONFIG_KEYS_LOCK_KEY)).toBe(false);
    });

    it("publishes the notice on the changed channel", async () => {
        await channel.notifyChanged();
        expect(events.published).toEqual([{ channel: CONFIG_KEYS_CHANGED_CHANNEL, message: "changed" }]);
    });

    it("subscribes through one connection of its own, shared by every handler, and closes it after the last one leaves", async () => {
        const first = vi.fn();
        const second = vi.fn();
        const stopFirst = await channel.onChanged(first);
        const stopSecond = await channel.onChanged(second);
        expect(events.duplicates).toHaveLength(1);
        expect(events.duplicates[0].connected).toBe(true);

        await channel.notifyChanged();
        expect(events.duplicates[0].published).toEqual([]);
        // The publish went out on the shared connection, which the subscriber connection doesn't see in the fake: deliver as Redis would.
        for (const listener of events.duplicates[0].subscriptions.get(CONFIG_KEYS_CHANGED_CHANNEL) ?? []) {
            listener("changed");
        }
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);

        await stopFirst();
        expect(events.duplicates[0].quitCalled).toBe(false);
        await stopSecond();
        expect(events.duplicates[0].quitCalled).toBe(true);
        expect(events.duplicates[0].subscriptions.has(CONFIG_KEYS_CHANGED_CHANNEL)).toBe(false);

        // A later subscriber starts a new connection.
        await channel.onChanged(first);
        expect(events.duplicates).toHaveLength(2);
    });

    it("keeps delivering to the other handlers when one throws", async () => {
        const after = vi.fn();
        await channel.onChanged(() => {
            throw new Error("boom");
        });
        await channel.onChanged(after);
        for (const listener of events.duplicates[0].subscriptions.get(CONFIG_KEYS_CHANGED_CHANNEL)!) {
            listener("changed");
        }
        expect(after).toHaveBeenCalledTimes(1);
    });

    it("refuses an operation when the datastore isn't configured, naming it", async () => {
        const bare = new RedisConfigKeyChannel();
        (bare as any).connectionManager = { connections: new Map() };
        await expect(bare.heartbeats()).rejects.toThrow("'cache'");
        await expect(bare.notifyChanged()).rejects.toThrow("'events'");
        const without = new RedisConfigKeyChannel();
        await expect(without.acquireLock(1)).rejects.toThrow("'cache'");
        (bare as any).connectionManager = { connections: new Map([["cache", {}]]) };
        await expect(bare.heartbeats()).rejects.toThrow("'cache'");
    });

    it("lets a Redis failure reach the caller", async () => {
        cache.failNext = new Error("connection lost");
        await expect(channel.putHeartbeat(entry("pod-a:1"), 1_000)).rejects.toThrow("connection lost");
    });

    it("skips a heartbeat that expired between the scan and the read", async () => {
        await channel.putHeartbeat(entry("pod-a:1"), 90_000);
        await channel.putHeartbeat(entry("pod-b:2"), 90_000);
        const read = cache.mGet.bind(cache);
        cache.mGet = async (keys: string[]) => (await read(keys)).map((value, index) => (index === 0 ? null : value));
        expect(await channel.heartbeats()).toHaveLength(1);
    });

    it("forgets a handler whose subscriber connection can't be opened, and subscribes afresh next time", async () => {
        const first = vi.fn();
        const connect = vi.spyOn(FakeRedis.prototype, "connect").mockRejectedValueOnce(new Error("connection refused"));
        await expect(channel.onChanged(first)).rejects.toThrow("connection refused");
        connect.mockRestore();
        await channel.onChanged(first);
        for (const listener of events.duplicates[events.duplicates.length - 1].subscriptions.get(CONFIG_KEYS_CHANGED_CHANNEL)!) {
            listener("changed");
        }
        expect(first).toHaveBeenCalledTimes(1);
    });
});
