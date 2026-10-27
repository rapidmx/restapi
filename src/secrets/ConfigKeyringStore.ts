///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { ObjectDecorators } from "@rapidrest/core";
import type { ObjectFactory } from "@rapidrest/service-core";
import { ConfigKeyring, parseConfigKeyring, serializeConfigKeyring } from "./ConfigKeyring.js";
const { Config } = ObjectDecorators;

/** Where the server writes a new keyring (`config_encryption:keyring_store:backend`, spec 5.3): `none` for a keyring given inline, which rotation can't change. */
export type ConfigKeyringBackend = "kubernetes" | "openbao" | "file" | "none";

/** A keyring and the version it was read at, which the write that replaces it must still find. */
export interface ConfigKeyringSnapshot {
    keyring: ConfigKeyring;
    /** What the store versions the ring by: a Secret's `resourceVersion`, a KV secret's version, a file's content hash. Opaque to the caller. */
    version: string;
}

/** The keyring changed since it was read: another writer won, so nothing was written and the step is retried on a fresh read. */
export class ConfigKeyringConflictError extends Error {
    constructor(message: string = "The configuration keyring was changed by someone else.") {
        super(message);
        this.name = "ConfigKeyringConflictError";
    }
}

/** The keyring can't be parsed, or the ring to write isn't a usable keyring: the one failure a rotation gives up on (spec 5.5). Its message never repeats the
 * keyring's text. */
export class ConfigKeyringInvalidError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigKeyringInvalidError";
    }
}

/**
 * Where the configuration keyring is kept and changed (spec 5.5): the server's rotation reads it with its version, adds or removes a key and writes it back
 * only if nobody changed it meanwhile. The server registers `KubernetesConfigKeyringStore` (the one Secret, by its `resourceVersion`) or
 * `OpenBaoConfigKeyringStore` (the one KV path, with check-and-set) under `"ConfigKeyringStore"`; `FileConfigKeyringStore` is the development form. The
 * pods read the ring through their mount or file, never through this interface, and a store never logs key material.
 */
export interface ConfigKeyringStore {
    /** The keyring and its version. Rejects with `ConfigKeyringInvalidError` for a ring that can't be parsed and with any other error when it can't be read at
     * all (the step is retried). */
    read(): Promise<ConfigKeyringSnapshot>;
    /** Replaces the keyring when `version` is still the stored one, otherwise rejects with `ConfigKeyringConflictError` and leaves the stored ring alone. */
    write(keyring: ConfigKeyring, version: string): Promise<void>;
}

/** `text`'s version in a `FileConfigKeyringStore`. */
function contentVersion(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * The keyring in the file `config_encryption:keyring_file` names, for `yarn dev` (backend `file`): read with the SHA-256 of its text as the version, replaced
 * by writing a sibling file (mode 0600) and renaming it over the original, so a pod's read never sees half a ring. The check that the version is still the
 * file's and the rename aren't one atomic step, which one development process, or the rotation's lock across copies, makes no matter.
 */
export class FileConfigKeyringStore implements ConfigKeyringStore {
    @Config("config_encryption:keyring_file", "")
    private configuredFile: string = "";

    /** @param file The keyring file; the configured `config_encryption:keyring_file` when not given. */
    constructor(private readonly file?: string) {}

    private path(): string {
        const file: string = (this.file ?? this.configuredFile ?? "").trim();
        if (!file) {
            throw new Error("config_encryption:keyring_file isn't set, so the keyring can't be read or changed.");
        }
        return file;
    }

    private readText(file: string): string {
        try {
            return fs.readFileSync(file, "utf-8");
        } catch (err: any) {
            throw new Error(`config_encryption:keyring_file can't be read (${err?.code ?? "unknown error"}).`);
        }
    }

    public async read(): Promise<ConfigKeyringSnapshot> {
        const text: string = this.readText(this.path());
        try {
            return { keyring: parseConfigKeyring(text), version: contentVersion(text) };
        } catch (err: any) {
            throw new ConfigKeyringInvalidError(`config_encryption:keyring_file isn't a usable keyring: ${err.message}`);
        }
    }

    public async write(keyring: ConfigKeyring, version: string): Promise<void> {
        const file: string = this.path();
        let text: string;
        try {
            text = serializeConfigKeyring(parseConfigKeyring(keyring));
        } catch (err: any) {
            throw new ConfigKeyringInvalidError(`The keyring to write isn't usable: ${err.message}`);
        }
        if (contentVersion(this.readText(file)) !== version) {
            throw new ConfigKeyringConflictError();
        }
        const temporary: string = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString("hex")}.tmp`);
        try {
            fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
            fs.renameSync(temporary, file);
        } catch (err: any) {
            fs.rmSync(temporary, { force: true });
            throw new Error(`config_encryption:keyring_file can't be written (${err?.code ?? "unknown error"}).`);
        }
    }
}

/**
 * The store for `backend`: the file store for `file`, whatever the server registered under `"ConfigKeyringStore"` for `kubernetes` and `openbao`, and none
 * for `none` (rotation is then unavailable: the keyring was given inline). A backend with nothing registered for it, or an unknown one, is none too, said once
 * in `logger`.
 */
export async function resolveConfigKeyringStore(
    objectFactory: Pick<ObjectFactory, "newInstance"> | undefined,
    backend: string,
    logger?: any,
): Promise<ConfigKeyringStore | undefined> {
    switch (backend) {
        case "none":
            return undefined;
        case "file":
            return objectFactory ? await objectFactory.newInstance(FileConfigKeyringStore, { name: "default" }) : new FileConfigKeyringStore();
        case "kubernetes":
        case "openbao":
            try {
                const store: ConfigKeyringStore | undefined = objectFactory ? await objectFactory.newInstance<ConfigKeyringStore>("ConfigKeyringStore", { name: "default" }) : undefined;
                if (store) {
                    return store;
                }
            } catch (err: any) {
                logger?.warn(`config_encryption:keyring_store:backend is '${backend}', but no ConfigKeyringStore is registered, so keys can't be rotated: ${err?.message}`);
                return undefined;
            }
            logger?.warn(`config_encryption:keyring_store:backend is '${backend}', but no ConfigKeyringStore is registered, so keys can't be rotated.`);
            return undefined;
        default:
            logger?.warn(`config_encryption:keyring_store:backend '${backend}' isn't one of kubernetes, openbao, file or none, so keys can't be rotated.`);
            return undefined;
    }
}
