///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real OpenPGP keys for tests, generated with OpenPGP.js - the same library `util/OpenPgpKeyUtils.ts` checks them with.
import * as openpgp from "openpgp";
import type { PublicKey } from "../src/models/types.js";

export interface TestOpenPgpKey {
    /** The certificate, ASCII armored. */
    armored: string;
    /** The certificate, base64 of the binary packets - what `PublicKey.publicKey` stores. */
    base64: string;
    fingerprint: string;
    privateKey: openpgp.PrivateKey;
    publicKey: openpgp.PublicKey;
    /** The `PublicKey` this server stores for it. */
    key: PublicKey;
}

export interface TestOpenPgpKeyOptions {
    /** 6 (default) or 4. */
    version?: 4 | 6;
    /** Extra user ID emails, after the first. */
    aliases?: string[];
    /** Seconds until it expires. */
    expiresIn?: number;
    /** When it was created (default now). */
    created?: Date;
    /** No encryption subkey. */
    signOnly?: boolean;
}

/** An OpenPGP key whose user ID names `email`. */
export async function openPgpKey(email: string, options: TestOpenPgpKeyOptions = {}): Promise<TestOpenPgpKey> {
    const userIDs = [{ name: "Test", email }, ...(options.aliases ?? []).map((alias) => ({ email: alias }))];
    const generated =
        options.version === 4
            ? await openpgp.generateKey({
                  type: "ecc",
                  curve: "curve25519Legacy",
                  userIDs,
                  format: "object",
                  ...(options.signOnly ? { subkeys: [] } : {}),
                  ...(options.expiresIn !== undefined ? { keyExpirationTime: options.expiresIn } : {}),
                  ...(options.created ? { date: options.created } : {}),
              })
            : await openpgp.generateKey({
                  type: "curve25519",
                  userIDs,
                  format: "object",
                  config: { v6Keys: true },
                  ...(options.signOnly ? { subkeys: [] } : {}),
                  ...(options.expiresIn !== undefined ? { keyExpirationTime: options.expiresIn } : {}),
                  ...(options.created ? { date: options.created } : {}),
              });
    return describeKey(generated.privateKey, generated.publicKey);
}

/** `TestOpenPgpKey` for an existing key pair. */
export async function describeKey(privateKey: openpgp.PrivateKey, publicKey: openpgp.PublicKey): Promise<TestOpenPgpKey> {
    const expiration = await publicKey.getExpirationTime();
    const base64: string = Buffer.from(publicKey.write()).toString("base64");
    return {
        armored: publicKey.armor(),
        base64,
        fingerprint: publicKey.getFingerprint(),
        privateKey,
        publicKey,
        key: {
            publicKey: base64,
            type: "openpgp",
            useType: "encrypt",
            fingerprint: publicKey.getFingerprint(),
            notBefore: publicKey.getCreationTime().getTime(),
            notAfter: expiration instanceof Date ? expiration.getTime() : 8_640_000_000_000_000,
        },
    };
}

/** `key`, revoked by its own revocation signature. */
export async function revoked(key: TestOpenPgpKey): Promise<TestOpenPgpKey> {
    const { privateKey, publicKey } = await openpgp.revokeKey({ key: key.privateKey, format: "object" });
    return describeKey(privateKey, publicKey);
}

/** `successor` with its primary user ID certified by `predecessor` - how a rotation lets correspondents replace a pinned key. */
export async function certifiedBy(successor: TestOpenPgpKey, predecessor: TestOpenPgpKey): Promise<TestOpenPgpKey> {
    const certifiedPrivate = await successor.privateKey.signPrimaryUser([predecessor.privateKey]);
    const certifiedPublic = await successor.publicKey.signPrimaryUser([predecessor.privateKey]);
    return describeKey(certifiedPrivate, certifiedPublic);
}
