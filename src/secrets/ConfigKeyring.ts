///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import * as fs from "fs";
import { createFileExclusive } from "../pki/FileStoreUtils.js";

/** The fixed identifier of the one `ConfigKeyState` row (same singleton convention as `MAILBOX_POLICY_UID`). */
export const CONFIG_KEY_STATE_UID = "config-keys";

/** One key of the configuration keyring (spec 5.3). */
export interface ConfigKeyEntry {
    /** What an envelope's `kid` names: letters, digits, `-` and `_`, at most 64 (a new key's is 8 random hex digits). */
    kid: string;
    /** Base64 of exactly 32 random bytes. */
    key: string;
    /** ISO 8601: the newest key is the one that encrypts until a rotation activates another. */
    createdAt: string;
}

/** The deployment's configuration keyring: usually one key, two or more only during a rotation. */
export interface ConfigKeyring {
    keys: ConfigKeyEntry[];
}

/** Where the keyring comes from: the file `config_encryption:keyring_file` names, else `config_encryption:keyring` (the JSON itself, or the document an
 * environment variable's JSON was parsed into). */
export interface ConfigKeyringSource {
    keyringFile?: string;
    keyring?: unknown;
}

const KID_PATTERN: RegExp = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64_PATTERN: RegExp = /^[A-Za-z0-9+/]+={0,2}$/;
/** AES-256. */
const KEY_BYTES = 32;

/**
 * A new key: 32 random bytes and an 8-hex `kid`, dated `createdAt`. Used for a deployment's first keyring (`generateConfigKeyring()`), for the development
 * keyring and by a rotation.
 */
export function generateConfigKey(createdAt: Date = new Date()): ConfigKeyEntry {
    return { kid: crypto.randomBytes(4).toString("hex"), key: crypto.randomBytes(KEY_BYTES).toString("base64"), createdAt: createdAt.toISOString() };
}

/** A keyring of one new key. */
export function generateConfigKeyring(): ConfigKeyring {
    return { keys: [generateConfigKey()] };
}

/** The keyring as the JSON document stored in the Secret, the KV entry or the file. */
export function serializeConfigKeyring(keyring: ConfigKeyring): string {
    return `${JSON.stringify(keyring, null, 2)}\n`;
}

/**
 * Reads a keyring from its JSON text or from the document itself (nconf parses a JSON environment variable). Only the three fields of each key are kept.
 * Every refusal's message says what is wrong with the document, never what is in it: `JSON.parse()`'s own message quotes the text, which here is key material.
 */
export function parseConfigKeyring(input: unknown): ConfigKeyring {
    let document: unknown = input;
    if (typeof input === "string") {
        try {
            document = JSON.parse(input);
        } catch {
            throw new Error("The configuration keyring isn't valid JSON.");
        }
    }
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
        throw new Error("The configuration keyring must be a JSON object with a list of keys.");
    }
    const keys: unknown = (document as { keys?: unknown }).keys;
    if (!Array.isArray(keys) || keys.length === 0) {
        throw new Error("The configuration keyring must hold at least one key.");
    }
    const kids: Set<string> = new Set();
    const entries: ConfigKeyEntry[] = keys.map((item: unknown, position: number): ConfigKeyEntry => {
        const label = `The configuration keyring's key ${position + 1}`;
        if (typeof item !== "object" || item === null || Array.isArray(item)) {
            throw new Error(`${label} must be an object.`);
        }
        const { kid, key, createdAt } = item as Record<string, unknown>;
        if (typeof kid !== "string" || !KID_PATTERN.test(kid)) {
            throw new Error(`${label} needs a kid of letters, digits, - and _, at most 64.`);
        }
        if (kids.has(kid)) {
            throw new Error(`The configuration keyring holds the kid '${kid}' twice.`);
        }
        kids.add(kid);
        if (typeof key !== "string" || !BASE64_PATTERN.test(key) || Buffer.from(key, "base64").length !== KEY_BYTES) {
            throw new Error(`${label} ('${kid}') must be 32 bytes in base64.`);
        }
        if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
            throw new Error(`${label} ('${kid}') needs a createdAt date.`);
        }
        return { kid, key, createdAt };
    });
    return { keys: entries };
}

/** The key created first (the earlier of two made at the same moment): what encrypts until a rotation has activated another. `undefined` for an empty list. */
export function oldestConfigKey(keyring: ConfigKeyring): ConfigKeyEntry | undefined {
    let oldest: ConfigKeyEntry | undefined;
    for (const entry of keyring.keys) {
        if (!oldest || Date.parse(entry.createdAt) < Date.parse(oldest.createdAt)) {
            oldest = entry;
        }
    }
    return oldest;
}

/** The key created last (the later of two made at the same moment): what encrypts when `activeKid` names a key the process hasn't loaded. `undefined` for an empty list. */
export function newestConfigKey(keyring: ConfigKeyring): ConfigKeyEntry | undefined {
    let newest: ConfigKeyEntry | undefined;
    for (const entry of keyring.keys) {
        if (!newest || Date.parse(entry.createdAt) >= Date.parse(newest.createdAt)) {
            newest = entry;
        }
    }
    return newest;
}

/**
 * Reads the keyring from `source`: the file when `keyringFile` is set, else the inline `keyring`. `undefined` when neither is set; throws when one is set and
 * can't be read or isn't a keyring, naming the setting (never what it holds). Synchronous, so a decryption that meets an unknown `kid` can re-read the file.
 */
export function readConfigKeyring(source: ConfigKeyringSource): ConfigKeyring | undefined {
    const file: string = typeof source.keyringFile === "string" ? source.keyringFile.trim() : "";
    if (file) {
        let text: string;
        try {
            text = fs.readFileSync(file, "utf-8");
        } catch (err: any) {
            throw new Error(`config_encryption:keyring_file can't be read (${err?.code ?? "unknown error"}).`);
        }
        try {
            return parseConfigKeyring(text);
        } catch (err: any) {
            throw new Error(`config_encryption:keyring_file isn't a usable keyring: ${err.message}`);
        }
    }
    const inline: unknown = source.keyring;
    if (inline === undefined || inline === null || (typeof inline === "string" && inline.trim() === "")) {
        return undefined;
    }
    try {
        return parseConfigKeyring(inline);
    } catch (err: any) {
        throw new Error(`config_encryption:keyring isn't a usable keyring: ${err.message}`);
    }
}

/** Whether the process runs in production, as the server decides it for the JWT secret: `NODE_ENV=production`. */
export function isProductionEnvironment(): boolean {
    return process.env.NODE_ENV === "production";
}

/**
 * The production key guard (spec 5.2): the server calls it before it starts, and in production a missing, unreadable or malformed keyring is a refusal to
 * start, since secrets could otherwise be saved with no key to read them back (or not at all). Outside production it checks nothing, so `yarn dev` and
 * tests start without one (`ensureDevelopmentConfigKeyring()` gives development its own).
 *
 * @param production Whether this is production; defaults to `NODE_ENV`.
 */
export function assertProductionConfigKeyring(source: ConfigKeyringSource, production: boolean = isProductionEnvironment()): void {
    if (!production) {
        return;
    }
    let keyring: ConfigKeyring | undefined;
    try {
        keyring = readConfigKeyring(source);
    } catch (err: any) {
        throw new Error(`A usable configuration keyring is required in production: ${err.message}`);
    }
    if (!keyring) {
        throw new Error("A configuration keyring is required in production: set config_encryption:keyring_file (or config_encryption:keyring).");
    }
}

/**
 * The development keyring (spec 5.2): `file`'s keyring, generated into it (readable by its owner only) the first time. The server calls it in development
 * before it starts and sets `config_encryption:keyring_file` to `file`, which belongs in `.gitignore`. A file that exists but isn't a keyring is an error,
 * never overwritten; two starts racing to create it end up with the same keyring.
 */
export async function ensureDevelopmentConfigKeyring(file: string): Promise<ConfigKeyring> {
    await createFileExclusive(file, serializeConfigKeyring(generateConfigKeyring()), 0o600);
    return readConfigKeyring({ keyringFile: file }) as ConfigKeyring;
}
