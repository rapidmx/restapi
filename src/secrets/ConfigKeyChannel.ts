///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import * as os from "os";
import { ObjectDecorators } from "@rapidrest/core";
import { ConnectionManager, type ObjectFactory } from "@rapidrest/service-core";
import { isProductionEnvironment } from "./ConfigKeyring.js";
const { Inject } = ObjectDecorators;

/** The Redis channel a rotation announces itself on (spec 5.5): every server copy re-reads the keyring, reports it and, where it has work, runs the rotation. */
export const CONFIG_KEYS_CHANGED_CHANNEL = "rapidmx:config-keys:changed";

/** The prefix of each server copy's heartbeat key: `rapidmx:config-keys:loaded:<pod name>:<pid>`. */
export const CONFIG_KEYS_LOADED_PREFIX = "rapidmx:config-keys:loaded:";

/** The key of the lock that lets one copy act on a rotation at a time. */
export const CONFIG_KEYS_LOCK_KEY = "rapidmx:config-keys:lock";

/** What a notice on `CONFIG_KEYS_CHANGED_CHANNEL` carries. Nothing depends on it: any message means "look again". */
const CHANGED_MESSAGE = "changed";

/** The Redis datastore (`datastores:cache`) the heartbeats and the lock live on, and the one (`datastores:events`) the notice goes through, as the plugin
 * status and its change notice do. */
const HEARTBEAT_DATASTORE = "cache";
const NOTICE_DATASTORE = "events";

/** One server process's account of itself (spec 5.5, step 2). */
export interface ConfigKeyHeartbeatEntry {
    /** `<pod name>:<pid>`: what the console names a copy by. */
    copy: string;
    /** The `kid`s in the ring this copy has loaded. */
    kids: string[];
    /** The `kid` it encrypts with, when it has a keyring at all. */
    encrypting?: string;
    /** ISO 8601. */
    at: string;
}

/** The right to act on a rotation, held until released or until its TTL runs out. */
export interface ConfigKeyLock {
    release(): Promise<void>;
}

/**
 * How the server copies talk to each other about the keyring (spec 5.5): each keeps a heartbeat saying which keys it has loaded and which it encrypts with, the
 * rotation takes a lock so one copy acts at a time, and a notice makes every copy look again at once. The server registers `RedisConfigKeyChannel` under
 * `"ConfigKeyChannel"`; a process with none uses the in-process `LocalConfigKeyChannel` outside production, which is right only for a single process (`yarn dev`, tests), and has none in
 * production, where rotation is then unavailable (`resolveConfigKeyChannel()`).
 */
export interface ConfigKeyChannel {
    /** Records `entry` as its copy's latest heartbeat, to disappear `ttlMs` later unless renewed. */
    putHeartbeat(entry: ConfigKeyHeartbeatEntry, ttlMs: number): Promise<void>;
    /** The heartbeats that haven't expired: every copy that is running. */
    heartbeats(): Promise<ConfigKeyHeartbeatEntry[]>;
    /** Takes the lock for `ttlMs`, or `undefined` when another holder has it. */
    acquireLock(ttlMs: number): Promise<ConfigKeyLock | undefined>;
    /** Tells every copy (this one included) to look again at the keyring and the rotation. */
    notifyChanged(): Promise<void>;
    /** Calls `handler` on every notice; the returned function stops it. */
    onChanged(handler: () => void): Promise<() => Promise<void>>;
}

/** This process's name in the heartbeats: the pod name (`HOSTNAME`, which Kubernetes sets) or the machine's, and the process id, since a pod can run several. */
export function configKeyCopyId(): string {
    return `${process.env.HOSTNAME || os.hostname()}:${process.pid}`;
}

/** A `ConfigKeyChannel` inside one process: the heartbeats, the lock and the handlers live in memory. */
export class LocalConfigKeyChannel implements ConfigKeyChannel {
    private readonly beats: Map<string, { entry: ConfigKeyHeartbeatEntry; expiresAt: number }> = new Map();
    private lock?: { token: string; expiresAt: number };
    private readonly handlers: Set<() => void> = new Set();

    /** @param now The clock, in milliseconds; the real one by default. */
    constructor(private readonly now: () => number = () => Date.now()) {}

    /** Forgets every heartbeat and the lock, for a test that starts over. Subscribers stay. */
    public reset(): void {
        this.beats.clear();
        this.lock = undefined;
    }

    public async putHeartbeat(entry: ConfigKeyHeartbeatEntry, ttlMs: number): Promise<void> {
        this.beats.set(entry.copy, { entry: { ...entry, kids: [...entry.kids] }, expiresAt: this.now() + ttlMs });
    }

    public async heartbeats(): Promise<ConfigKeyHeartbeatEntry[]> {
        const now: number = this.now();
        const live: ConfigKeyHeartbeatEntry[] = [];
        for (const [copy, beat] of this.beats) {
            if (beat.expiresAt > now) {
                live.push({ ...beat.entry, kids: [...beat.entry.kids] });
            } else {
                this.beats.delete(copy);
            }
        }
        return live;
    }

    public async acquireLock(ttlMs: number): Promise<ConfigKeyLock | undefined> {
        if (this.lock && this.lock.expiresAt > this.now()) {
            return undefined;
        }
        const held = { token: crypto.randomUUID(), expiresAt: this.now() + ttlMs };
        this.lock = held;
        return {
            release: async () => {
                // Only the holder's own lock: one that ran out and was taken by another is not this holder's to release.
                if (this.lock === held) {
                    this.lock = undefined;
                }
            },
        };
    }

    public async notifyChanged(): Promise<void> {
        for (const handler of [...this.handlers]) {
            try {
                handler();
            } catch {
                // A handler's failure is its own: the others still hear the notice.
            }
        }
    }

    public async onChanged(handler: () => void): Promise<() => Promise<void>> {
        this.handlers.add(handler);
        return async () => {
            this.handlers.delete(handler);
        };
    }
}

let sharedLocal: LocalConfigKeyChannel | undefined;

/** The one in-process channel of this process, so the heartbeat and the rotation job of a single process (no Redis registered) see each other. */
export function sharedLocalConfigKeyChannel(): LocalConfigKeyChannel {
    sharedLocal ??= new LocalConfigKeyChannel();
    return sharedLocal;
}

/** The part of a node-redis client the channel uses. */
export interface ConfigKeyRedisClient {
    set(key: string, value: string, options?: { NX?: boolean; PX?: number }): Promise<string | null>;
    scan(cursor: string, options: { MATCH: string; COUNT?: number }): Promise<{ cursor: string | number; keys: string[] }>;
    mGet(keys: string[]): Promise<(string | null)[]>;
    eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
    publish(channel: string, message: string): Promise<number>;
    duplicate(): ConfigKeyRedisClient;
    connect(): Promise<unknown>;
    subscribe(channel: string, listener: (message: string) => void): Promise<unknown>;
    unsubscribe(channel: string): Promise<unknown>;
    quit(): Promise<unknown>;
}

/** Releases the lock only if it still holds this holder's token, so a lock that ran out and was taken by another is never deleted from under it. */
const RELEASE_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/** A heartbeat as stored, or `undefined` for text that isn't one (another version's, or damaged). */
function parseHeartbeat(text: string | null): ConfigKeyHeartbeatEntry | undefined {
    if (!text) {
        return undefined;
    }
    try {
        const value: any = JSON.parse(text);
        if (
            typeof value?.copy === "string" &&
            Array.isArray(value.kids) &&
            value.kids.every((kid: unknown) => typeof kid === "string") &&
            typeof value.at === "string" &&
            (value.encrypting === undefined || typeof value.encrypting === "string")
        ) {
            return { copy: value.copy, kids: value.kids, ...(value.encrypting !== undefined ? { encrypting: value.encrypting } : {}), at: value.at };
        }
    } catch {
        // Not JSON: skipped like any other entry that isn't a heartbeat.
    }
    return undefined;
}

/**
 * The `ConfigKeyChannel` the server registers: the heartbeats are keys with a TTL on the `cache` Redis (`rapidmx:config-keys:loaded:<pod>:<pid>`), the lock one
 * `SET NX PX` key released only by its holder's token, and the notice a message on the `events` Redis, heard through one subscriber connection of its own that
 * every handler shares. A Redis failure rejects the call: the heartbeat logs it and tries again at its next beat, the rotation waits.
 */
export class RedisConfigKeyChannel implements ConfigKeyChannel {
    @Inject(ConnectionManager)
    private connectionManager?: ConnectionManager;

    private readonly handlers: Set<() => void> = new Set();
    private subscriber?: Promise<ConfigKeyRedisClient>;

    /** The client of the configured datastore, or an error naming it: nothing here can work without it. `probe` is a command the client must have. */
    private client(datastore: string, probe: string): ConfigKeyRedisClient {
        const client: any = this.connectionManager?.connections.get(datastore);
        if (!client || typeof client[probe] !== "function") {
            throw new Error(`The Redis datastore '${datastore}' isn't configured, so the configuration keyring can't be coordinated between server copies.`);
        }
        return client;
    }

    public async putHeartbeat(entry: ConfigKeyHeartbeatEntry, ttlMs: number): Promise<void> {
        await this.client(HEARTBEAT_DATASTORE, "mGet").set(`${CONFIG_KEYS_LOADED_PREFIX}${entry.copy}`, JSON.stringify(entry), { PX: ttlMs });
    }

    public async heartbeats(): Promise<ConfigKeyHeartbeatEntry[]> {
        const redis: ConfigKeyRedisClient = this.client(HEARTBEAT_DATASTORE, "mGet");
        const keys: Set<string> = new Set();
        let cursor = "0";
        do {
            const page = await redis.scan(cursor, { MATCH: `${CONFIG_KEYS_LOADED_PREFIX}*`, COUNT: 100 });
            cursor = String(page.cursor);
            page.keys.forEach((key) => keys.add(key));
        } while (cursor !== "0");
        if (keys.size === 0) {
            return [];
        }
        const values: (string | null)[] = await redis.mGet([...keys]);
        return values.flatMap((text) => {
            const entry: ConfigKeyHeartbeatEntry | undefined = parseHeartbeat(text);
            return entry ? [entry] : [];
        });
    }

    public async acquireLock(ttlMs: number): Promise<ConfigKeyLock | undefined> {
        const redis: ConfigKeyRedisClient = this.client(HEARTBEAT_DATASTORE, "mGet");
        const token: string = crypto.randomUUID();
        if ((await redis.set(CONFIG_KEYS_LOCK_KEY, token, { NX: true, PX: ttlMs })) === null) {
            return undefined;
        }
        return {
            release: async () => {
                await redis.eval(RELEASE_SCRIPT, { keys: [CONFIG_KEYS_LOCK_KEY], arguments: [token] });
            },
        };
    }

    public async notifyChanged(): Promise<void> {
        await this.client(NOTICE_DATASTORE, "publish").publish(CONFIG_KEYS_CHANGED_CHANNEL, CHANGED_MESSAGE);
    }

    public async onChanged(handler: () => void): Promise<() => Promise<void>> {
        this.handlers.add(handler);
        this.subscriber ??= this.openSubscriber();
        try {
            await this.subscriber;
        } catch (err) {
            this.handlers.delete(handler);
            this.subscriber = undefined;
            throw err;
        }
        return async () => {
            this.handlers.delete(handler);
            if (this.handlers.size === 0 && this.subscriber) {
                const closing: Promise<ConfigKeyRedisClient> = this.subscriber;
                this.subscriber = undefined;
                const client: ConfigKeyRedisClient = await closing;
                await client.unsubscribe(CONFIG_KEYS_CHANGED_CHANNEL);
                await client.quit();
            }
        };
    }

    /** A connection of its own, since a node-redis client that subscribes can't run other commands. */
    private async openSubscriber(): Promise<ConfigKeyRedisClient> {
        const client: ConfigKeyRedisClient = this.client(NOTICE_DATASTORE, "publish").duplicate();
        await client.connect();
        await client.subscribe(CONFIG_KEYS_CHANGED_CHANNEL, () => {
            for (const handler of [...this.handlers]) {
                try {
                    handler();
                } catch {
                    // A handler's failure is its own: the others still hear the notice.
                }
            }
        });
        return client;
    }
}

/**
 * The `"ConfigKeyChannel"` the server registered. Without one the process outside production uses its own in-process channel, which is right for one process
 * (`yarn dev`, tests) and said once in `logger`. In production there is none at all (`undefined`, said as an error): each of several server copies would activate
 * a key knowing only its own heartbeat and take its own lock, which is exactly what the heartbeats guard against, so rotation is unavailable until the server
 * registers `RedisConfigKeyChannel`.
 *
 * @param production Whether this is production; defaults to `NODE_ENV`.
 */
export async function resolveConfigKeyChannel(
    objectFactory: Pick<ObjectFactory, "newInstance"> | undefined,
    logger?: any,
    production: boolean = isProductionEnvironment(),
): Promise<ConfigKeyChannel | undefined> {
    let reason = "";
    try {
        const channel: ConfigKeyChannel | undefined = objectFactory ? await objectFactory.newInstance<ConfigKeyChannel>("ConfigKeyChannel", { name: "default" }) : undefined;
        if (channel) {
            return channel;
        }
    } catch (err: any) {
        reason = `: ${err?.message}`;
    }
    if (production) {
        logger?.error(`No ConfigKeyChannel is registered, so configuration keys can't be rotated: server copies can't be coordinated without Redis${reason}`);
        return undefined;
    }
    logger?.warn(`No ConfigKeyChannel is registered, so the configuration keyring is coordinated within this process only${reason}`);
    return sharedLocalConfigKeyChannel();
}
