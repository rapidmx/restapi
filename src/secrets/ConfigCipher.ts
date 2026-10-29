///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import { ConfigEnvelope, ConfigKeyState } from "../models/types.js";
import { CONFIG_KEY_STATE_UID, ConfigKeyEntry, ConfigKeyring, newestConfigKey, oldestConfigKey, readConfigKeyring } from "./ConfigKeyring.js";
const { Config, Destroy, Init, Logger } = ObjectDecorators;

/** The format tag in every envelope's associated data. */
export const CONFIG_ENVELOPE_FORMAT = "rapidmx-config/1";

/** How often a process re-reads the keyring and the active kid, and the least time between two re-reads for an unknown `kid` (spec 5.3). */
export const CONFIG_RELOAD_INTERVAL_MS = 60_000;

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE64_PATTERN: RegExp = /^[A-Za-z0-9+/]*={0,2}$/;

/** What a configuration secret can be: a credential's text, or a plugin setting's number or flag. */
export type ConfigSecretValue = string | number | boolean;

/** Where an envelope belongs: the record type (`DnsProvider`, `IntegrationSettings`, `Plugin`), the row's `uid` and the field's path (`credentials.apiToken`,
 * `giphy.apiKey`, `settings.<key>`). An envelope decrypts only in the context it was made for. */
export interface ConfigCipherContext {
    record: string;
    uid: string;
    field: string;
}

/** Why a secret can't be read: its key isn't in the ring (`unknown_key`), it isn't a well-formed envelope or doesn't hold a value (`invalid`), or it failed
 * authentication - another record or field, a changed byte or the wrong key (`failed`). */
export type ConfigSecretUnavailableReason = "unknown_key" | "invalid" | "failed";

/** A loaded key as the console shows it: never its material. */
export interface ConfigKeyInfo {
    kid: string;
    /** ISO 8601, as the keyring records it. */
    createdAt: string;
    /** Whether this process encrypts with it. */
    active: boolean;
}

/**
 * A stored secret can't be decrypted. It names the record and field (and, for a missing key, the `kid`), never the value, the envelope or a key: the
 * consumer treats the secret as unset and shows the field as "set, but can't be read: enter it again" (spec 5.4).
 */
export class ConfigSecretUnavailableError extends Error {
    constructor(
        public readonly record: string,
        public readonly uid: string,
        public readonly field: string,
        public readonly reason: ConfigSecretUnavailableReason,
        detail: string,
    ) {
        super(`The secret '${field}' of ${record} '${uid}' can't be read: ${detail}.`);
        this.name = "ConfigSecretUnavailableError";
    }
}

/** Whether `value` is an envelope: an object of exactly the five keys, `$enc` 1 and the rest text. It doesn't check that the text decodes. */
export function isConfigEnvelope(value: unknown): value is ConfigEnvelope {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const keys: string[] = Object.keys(value);
    const candidate = value as Record<string, unknown>;
    return (
        keys.length === 5 &&
        candidate.$enc === 1 &&
        typeof candidate.kid === "string" &&
        typeof candidate.iv === "string" &&
        typeof candidate.ct === "string" &&
        typeof candidate.tag === "string"
    );
}

/**
 * The associated data that binds a ciphertext to its place (spec 5.2): the format tag, the record type, the `uid` and the field path, each a 4-byte
 * big-endian length followed by its UTF-8 bytes, so moving a character from one part to its neighbour never makes two contexts encode alike.
 */
export function configAssociatedData(context: ConfigCipherContext): Buffer {
    const parts: Buffer[] = [];
    for (const text of [CONFIG_ENVELOPE_FORMAT, context.record, context.uid, context.field]) {
        const bytes: Buffer = Buffer.from(text, "utf-8");
        const length: Buffer = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        parts.push(length, bytes);
    }
    return Buffer.concat(parts);
}

/** `text` as the bytes it encodes, or `undefined` when it isn't base64 or doesn't decode to exactly `length` bytes (any length when not given). */
function decodeBase64(text: string, length?: number): Buffer | undefined {
    if (!BASE64_PATTERN.test(text)) {
        return undefined;
    }
    const bytes: Buffer = Buffer.from(text, "base64");
    return length === undefined || bytes.length === length ? bytes : undefined;
}

/**
 * Encrypts and decrypts the configuration secrets stored in the database (spec 5.2): AES-256-GCM with a random 96-bit nonce per value, the value's UTF-8
 * JSON as plaintext and the record, row and field as associated data, with the deployment's keyring (`config_encryption:keyring_file`, else
 * `config_encryption:keyring`). The active key encrypts - `ConfigKeyState.activeKid` when it is in the ring; with none set, the oldest key (the deployment's original, which
 * every process has, so a key a rotation has only just added never encrypts before it is activated); with one this process hasn't loaded yet, the newest -
 * and every key decrypts.
 *
 * The keyring is re-read every minute, on `reload()` (a rotation notice reaches a process through it) and, at most once a minute, when an envelope names a
 * `kid` the process doesn't have, so a rotation reaches every process without a restart. A reload that fails (a keyring half-written, the datastore
 * briefly down) keeps what the process has and says so once. Neither the plaintext, a key nor an envelope is ever logged or put in an error.
 *
 * The server registers it under the DI token `"ConfigCipher"` as `ConfigCipherMongo` or `ConfigCipherSQL`, which read the active kid from the datastore; the
 * base class has no datastore and uses the oldest key. The server refuses to start in production without a keyring (`assertProductionConfigKeyring()`), so
 * a cipher with none only exists in development and tests, where encrypting fails with a 503.
 *
 * @author Jean-Philippe Steinmetz
 */
export class ConfigCipher {
    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    /** Supplied by the Mongo/SQL subclasses so the active kid can be read from the `ConfigKeyState` row. */
    protected configKeyStateClass: any;

    protected stateRepo?: RepoUtils<ConfigKeyState>;

    @Config("config_encryption:keyring_file", "")
    private keyringFile: string = "";

    @Config("config_encryption:keyring", "")
    private keyring: unknown = "";

    @Logger
    private logger: any;

    /** The loaded keys by `kid`, and the one that is newest by `createdAt`. */
    private keys: Map<string, Buffer> = new Map();
    /** The loaded keyring's entries in the order it lists them, without their material (`keyInfo()`). */
    private keyDates: { kid: string; createdAt: string }[] = [];
    private newestKid?: string;
    private oldestKid?: string;
    /** `ConfigKeyState.activeKid` as last read. */
    private activeKid?: string;
    /** Whether the row was read at least once (always so without a repository for it). Until then `activeKid` is unknown, which is not the same as none: a
     * process that couldn't read it during a rotation would encrypt with the oldest key, which that rotation is about to retire. */
    private activeKidKnown: boolean = true;
    /** Whether a periodic reload is still running, and which `ConfigKeyState` read started last, so an older read that finishes late is discarded. */
    private reloading: boolean = false;
    private stateReads: number = 0;
    private timer?: NodeJS.Timeout;
    private lastUnknownKidReload: number = 0;
    /** The last failure a reload logged, so the same one isn't logged every minute. */
    private lastKeyringError?: string;
    private lastStateError?: string;
    /** Who is told when the loaded keys or the key this process encrypts with change (`onChange()`), and what they were when it last told them. */
    private listeners: Set<() => void> = new Set();
    private lastSignature: string = "";

    @Init
    public async init(): Promise<void> {
        if (!this.stateRepo && this.configKeyStateClass && this._objectFactory) {
            this.stateRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.configKeyStateClass.name, args: [this.configKeyStateClass] });
        }
        this.loadKeys("error");
        this.activeKidKnown = !this.stateRepo;
        await this.loadActiveKid();
        this.timer = setInterval(() => void this.reloadUnlessRunning(), CONFIG_RELOAD_INTERVAL_MS);
        this.timer.unref();
    }

    /** Stops the periodic reload. Also run by the ObjectFactory when it destroys this instance. */
    @Destroy
    public async dispose(): Promise<void> {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /**
     * Re-reads the keyring and the active kid now: what the periodic timer does every minute, and what a process runs at once when it is told a rotation
     * happened. Never throws; a failure keeps what the process has.
     */
    public async reload(): Promise<void> {
        this.loadKeys("warn");
        await this.loadActiveKid();
    }

    /** The periodic reload: skipped while the previous one is still waiting on a slow datastore. */
    private async reloadUnlessRunning(): Promise<void> {
        if (this.reloading) {
            return;
        }
        this.reloading = true;
        try {
            await this.reload();
        } finally {
            this.reloading = false;
        }
    }

    /** The `kid` new values are encrypted with, or `undefined` when no keyring is loaded or the active key hasn't been read yet. */
    public currentKid(): string | undefined {
        return this.activeKey()?.kid;
    }

    /** The `kid`s of the keys this process has loaded: what its keyring heartbeat reports (spec 5.5). */
    public loadedKids(): string[] {
        return [...this.keys.keys()];
    }

    /** The loaded keys by `kid` and creation date, which one encrypts, never key material: what the key console lists. */
    public keyInfo(): ConfigKeyInfo[] {
        const active: string | undefined = this.currentKid();
        return this.keyDates.map((entry) => ({ kid: entry.kid, createdAt: entry.createdAt, active: entry.kid === active }));
    }

    /**
     * Calls `listener` after a reload that changed the loaded keys or the key this process encrypts with - also the re-read an unknown `kid` causes - so the
     * keyring heartbeat reports the change at once instead of at its next beat. A listener that throws is skipped. Returns the function that unsubscribes it.
     */
    public onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Tells the listeners when what `onChange()` watches differs from when they were last told. */
    private notifyIfChanged(): void {
        const signature = `${[...this.keys.keys()].sort().join(",")}|${this.currentKid() ?? ""}`;
        if (signature === this.lastSignature) {
            return;
        }
        this.lastSignature = signature;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (err: any) {
                this.logger?.warn(`ConfigCipher: a change listener failed: ${err?.message}`);
            }
        }
    }

    /** Whether `value` is an envelope (`isConfigEnvelope()`). */
    public isEnvelope(value: unknown): value is ConfigEnvelope {
        return isConfigEnvelope(value);
    }

    /**
     * Encrypts `value` for `context` with the active key. A 503 when no keyring is loaded; a `TypeError` for a value that isn't a text, a finite number or a
     * flag (a programming error: no route takes one).
     */
    public encrypt(value: ConfigSecretValue, context: ConfigCipherContext): ConfigEnvelope {
        if (typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) {
            throw new TypeError("A configuration secret must be a text, a finite number or a flag.");
        }
        const active: { kid: string; key: Buffer } | undefined = this.activeKey();
        if (!active) {
            throw new ApiError(
                ApiErrors.INTERNAL_ERROR,
                503,
                this.keys.size > 0 && !this.activeKidKnown
                    ? "The active configuration key could not be read yet, so secrets can't be saved. Try again in a moment."
                    : "No configuration keyring is loaded, so secrets can't be saved.",
            );
        }
        const iv: Buffer = crypto.randomBytes(NONCE_BYTES);
        const cipher: crypto.CipherGCM = crypto.createCipheriv(ALGORITHM, active.key, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(configAssociatedData(context));
        const ct: Buffer = Buffer.concat([cipher.update(JSON.stringify(value), "utf-8"), cipher.final()]);
        return { $enc: 1, kid: active.kid, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
    }

    /**
     * Decrypts `envelope` as the value saved for `context`, with the key its `kid` names. Throws `ConfigSecretUnavailableError` when it can't: an unknown
     * `kid` (after one re-read of the keyring file, at most once a minute), another context, a changed byte or a malformed envelope. The value is whatever was
     * sealed - a text, a number or a flag; a caller that needs a text uses `decryptString()`.
     */
    public decrypt(envelope: ConfigEnvelope, context: ConfigCipherContext): ConfigSecretValue {
        const unavailable = (reason: ConfigSecretUnavailableReason, detail: string): ConfigSecretUnavailableError =>
            new ConfigSecretUnavailableError(context.record, context.uid, context.field, reason, detail);
        if (!isConfigEnvelope(envelope)) {
            throw unavailable("invalid", "it isn't an encrypted value of this format");
        }
        let key: Buffer | undefined = this.keys.get(envelope.kid);
        if (!key && Date.now() - this.lastUnknownKidReload >= CONFIG_RELOAD_INTERVAL_MS) {
            this.lastUnknownKidReload = Date.now();
            this.loadKeys("warn");
            key = this.keys.get(envelope.kid);
        }
        if (!key) {
            throw unavailable("unknown_key", `its key '${envelope.kid}' isn't in the keyring`);
        }
        const iv: Buffer | undefined = decodeBase64(envelope.iv, NONCE_BYTES);
        const tag: Buffer | undefined = decodeBase64(envelope.tag, TAG_BYTES);
        const ct: Buffer | undefined = decodeBase64(envelope.ct);
        if (!iv || !tag || !ct) {
            throw unavailable("invalid", "the encrypted value is malformed");
        }
        let plaintext: string;
        try {
            const decipher: crypto.DecipherGCM = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
            decipher.setAAD(configAssociatedData(context));
            decipher.setAuthTag(tag);
            plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
        } catch {
            throw unavailable("failed", "the key, the record or the field doesn't match, or the value was changed");
        }
        let value: unknown;
        try {
            value = JSON.parse(plaintext);
        } catch {
            throw unavailable("invalid", "it doesn't hold a value");
        }
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
            throw unavailable("invalid", "it doesn't hold a text, number or flag");
        }
        return value;
    }

    /** `decrypt()` for a secret that must be a text (a credential, a key): one that holds a number or a flag is unavailable (`invalid`), never returned as one. */
    public decryptString(envelope: ConfigEnvelope, context: ConfigCipherContext): string {
        const value: ConfigSecretValue = this.decrypt(envelope, context);
        if (typeof value !== "string") {
            throw new ConfigSecretUnavailableError(context.record, context.uid, context.field, "invalid", "it doesn't hold a text");
        }
        return value;
    }

    /**
     * The key that encrypts and its `kid`: `activeKid` when it is in the ring. With none set, no rotation has ever been activated, so the oldest key - the
     * original one every process has - encrypts, even while a rotation has added a newer one that some process may not have loaded yet. With one this process
     * hasn't loaded, a key activated after its last reload, the newest it has: every process had that one when it was activated. None while the row has not been
     * read yet (`activeKidKnown`): which key is active is not known, so no key is chosen.
     */
    private activeKey(): { kid: string; key: Buffer } | undefined {
        if (!this.activeKidKnown) {
            return undefined;
        }
        const kid: string | undefined = this.activeKid === undefined ? this.oldestKid : this.keys.has(this.activeKid) ? this.activeKid : this.newestKid;
        const key: Buffer | undefined = kid === undefined ? undefined : this.keys.get(kid);
        return kid !== undefined && key ? { kid, key } : undefined;
    }

    /**
     * Replaces the loaded keys with the configured keyring's. Keeps the ones it has, and logs once, when the keyring is unusable; there is nothing to
     * re-read for an inline keyring, which only the process's own configuration could change.
     *
     * @param level How a failure is logged: `error` when the process starts, where it means there may be no key at all.
     */
    private loadKeys(level: "error" | "warn"): void {
        let ring: ConfigKeyring | undefined;
        try {
            ring = readConfigKeyring({ keyringFile: this.keyringFile, keyring: this.keyring });
        } catch (err: any) {
            if (err.message !== this.lastKeyringError) {
                this.lastKeyringError = err.message;
                this.logger?.[level](`ConfigCipher: ${err.message} ${this.keys.size > 0 ? "Keeping the keyring already loaded." : "No secret can be saved or read."}`);
            }
            return;
        }
        this.lastKeyringError = undefined;
        if (!ring) {
            return;
        }
        this.keys = new Map(ring.keys.map((entry: ConfigKeyEntry) => [entry.kid, Buffer.from(entry.key, "base64")]));
        this.keyDates = ring.keys.map((entry: ConfigKeyEntry) => ({ kid: entry.kid, createdAt: entry.createdAt }));
        this.newestKid = newestConfigKey(ring)?.kid;
        this.oldestKid = oldestConfigKey(ring)?.kid;
        this.notifyIfChanged();
    }

    /** Reads `ConfigKeyState.activeKid`. Keeps the one it has, and logs once, when the row can't be read. */
    private async loadActiveKid(): Promise<void> {
        if (!this.stateRepo) {
            return;
        }
        const read: number = ++this.stateReads;
        try {
            const state: ConfigKeyState | undefined = (await this.stateRepo.findOne(CONFIG_KEY_STATE_UID, { ignoreACL: true, skipCache: true })) ?? undefined;
            if (read !== this.stateReads) {
                // A later read started while this one waited, so this answer is older than the one that replaces it.
                return;
            }
            this.activeKid = state?.activeKid ?? undefined;
            this.activeKidKnown = true;
            this.lastStateError = undefined;
            this.notifyIfChanged();
        } catch (err: any) {
            if (err.message !== this.lastStateError) {
                this.lastStateError = err.message;
                this.logger?.warn(
                    `ConfigCipher: the active key can't be read (${err.message}); ${this.activeKidKnown ? "keeping the one already known" : "encrypting nothing until it can be"}.`,
                );
            }
        }
    }
}
