///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
/**
 * OpenPGP certificates (`specs/end-to-end_encryption.md` *OpenPGP Interoperability*): what this server checks before it
 * stores, pins or publishes one. Built on OpenPGP.js, used only to parse and verify public keys - this server never holds
 * an OpenPGP secret key in the clear, and never decrypts or signs with one.
 *
 * An OpenPGP certificate both encrypts and signs, so it is stored as ONE `PublicKey` with `type: "openpgp"` and
 * `useType: "encrypt"` (its pin also covers signature verification), unlike an S/MIME mailbox, which has one certificate
 * per use. Its `publicKey` is the base64 of the binary transferable public key; its `fingerprint` the primary key's (64 hex
 * characters for a v6 key, 40 for v4); `notBefore` its creation time and `notAfter` its expiry (`OPENPGP_NO_EXPIRY` when it
 * never expires).
 *
 * OpenPGP.js is loaded on first use, so a deployment that never sees an OpenPGP key never loads it.
 */
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import type { PublicKey } from "../models/types.js";

/** `PublicKey.type` of an OpenPGP certificate. */
export const OPENPGP_KEY_TYPE = "openpgp";

/** `PublicKey.notAfter` of an OpenPGP certificate that never expires: the largest valid JavaScript date. */
export const OPENPGP_NO_EXPIRY = 8_640_000_000_000_000;

/** The largest OpenPGP certificate accepted, in bytes (an Ed25519/X25519 key, v4 or v6, is well under 1 KB; a key with many
 * signatures or a photo user ID is refused rather than stored). */
export const MAX_OPENPGP_KEY_BYTES = 32 * 1024;

/** The longest armored or base64 certificate text accepted. */
const MAX_OPENPGP_KEY_TEXT_LENGTH = 64 * 1024;

const ARMOR_HEADER = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

type OpenPgp = typeof import("openpgp");
let loaded: Promise<OpenPgp> | undefined;
const openpgp = (): Promise<OpenPgp> => (loaded ??= import("openpgp"));

/** `promise`'s value, or `fallback` when it rejects - OpenPGP.js reports most "not usable" answers by rejecting. */
async function orElse<T>(promise: Promise<T>, fallback: T): Promise<T> {
    try {
        return await promise;
    } catch {
        return fallback;
    }
}

/** Whether `promise` resolves. */
async function succeeds(promise: Promise<unknown>): Promise<boolean> {
    return await orElse(promise.then(() => true), false);
}

/** Whether `key` is an OpenPGP certificate (`PublicKey.type`). */
export function isOpenPgpKey(key: { type?: string } | undefined): boolean {
    return key?.type === OPENPGP_KEY_TYPE;
}

/** A key's format: `"openpgp"` for an OpenPGP certificate, `"x509"` for anything else (every key from before OpenPGP). */
export function keyFormat(key: { type?: string }): "x509" | "openpgp" {
    return isOpenPgpKey(key) ? "openpgp" : "x509";
}

/**
 * Where a key is pinned on a contact (or active on a mailbox): its `useType` and its format. A contact has at most one pinned
 * key per slot, so an S/MIME encryption certificate and an OpenPGP certificate of the same address are pinned side by side,
 * never as replacements of each other.
 */
export function keySlot(key: { useType: string; type?: string }): string {
    return `${key.useType}:${keyFormat(key)}`;
}

/** What a parsed and verified OpenPGP certificate says about itself. */
export interface OpenPgpCertificate {
    /** The `PublicKey` to store: every field derived from the certificate. */
    key: PublicKey;
    /** The email addresses of its user IDs whose self-signatures verify, lowercased. */
    emails: string[];
    /** It has a subkey (or primary key) valid for encryption at the time checked. */
    canEncrypt: boolean;
    /** The primary key is revoked, and when (the revocation signature's creation time). */
    revokedAt?: number;
    /** 4 or 6. */
    version: number;
}

/** The binary certificate in `text`: ASCII armor, or base64 of the binary packets. `undefined` when it's neither. */
async function readCertificate(text: unknown): Promise<import("openpgp").Key | undefined> {
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_OPENPGP_KEY_TEXT_LENGTH) {
        return undefined;
    }
    const pgp: OpenPgp = await openpgp();
    try {
        const trimmed: string = text.trim();
        if (trimmed.startsWith(ARMOR_HEADER)) {
            return await pgp.readKey({ armoredKey: trimmed });
        }
        if (!BASE64_PATTERN.test(trimmed)) {
            return undefined;
        }
        const bytes: Uint8Array = new Uint8Array(Buffer.from(trimmed, "base64"));
        if (bytes.length === 0 || bytes.length > MAX_OPENPGP_KEY_BYTES) {
            return undefined;
        }
        return await pgp.readKey({ binaryKey: bytes });
    } catch {
        return undefined;
    }
}

/**
 * Parses an OpenPGP public certificate (armored, or base64 binary) and checks it as of `now`, or `undefined` when it isn't
 * one: unparseable, a secret key, too large, or a primary key whose self-signature doesn't verify. A revoked or expired
 * certificate still parses (`revokedAt`, `key.notAfter`) - what to do with one is the caller's decision.
 */
export async function parseOpenPgpCertificate(text: unknown, now: number = Date.now()): Promise<OpenPgpCertificate | undefined> {
    const cert = await readCertificate(text);
    if (!cert || cert.isPrivate()) {
        return undefined;
    }
    const binary: Uint8Array = cert.write();
    if (binary.length > MAX_OPENPGP_KEY_BYTES) {
        return undefined;
    }
    const at = new Date(now);
    const revoked: boolean = await orElse(cert.isRevoked(undefined, undefined, at), false);
    // The revocation's date comes from one that verifies, not from whichever signature happens to be listed first.
    const { enums } = await openpgp();
    const revocation = revoked
        ? (await holderSignatures(cert.revocationSignatures, cert.keyPacket, enums.signature.keyRevocation, { key: cert.keyPacket }))[0]
        : undefined;
    if (!revoked) {
        // Self-signatures of a revoked key may still be fine, but an unrevoked key must have a verifiable primary key at all.
        try {
            await cert.verifyPrimaryKey(at);
        } catch (err) {
            // An expired key still parses (the caller decides); anything else is not a usable certificate.
            if (!/expired/i.test((err as Error)?.message ?? "")) {
                return undefined;
            }
        }
    }
    const emails: string[] = [];
    for (const user of cert.users) {
        const email: string | undefined = user.userID?.email;
        if (!email) {
            continue;
        }
        try {
            await user.verify(at);
            emails.push(email.toLowerCase());
        } catch {
            // A user ID without a valid self-signature names nobody.
        }
    }
    const expiration = await orElse(cert.getExpirationTime(), null);
    const notAfter: number = expiration instanceof Date ? expiration.getTime() : expiration === Infinity ? OPENPGP_NO_EXPIRY : 0;
    const canEncrypt: boolean = await succeeds(cert.getEncryptionKey(undefined, at));
    return {
        key: {
            publicKey: Buffer.from(binary).toString("base64"),
            type: OPENPGP_KEY_TYPE,
            useType: "encrypt",
            fingerprint: cert.getFingerprint().toLowerCase(),
            notBefore: cert.getCreationTime().getTime(),
            notAfter,
        },
        emails,
        canEncrypt,
        ...(revoked ? { revokedAt: revocation?.created ? revocation.created.getTime() : now } : {}),
        version: cert.keyPacket.version,
    };
}

/**
 * `sanitizeDiscoveredKey()` for an OpenPGP `key` from an untrusted source (a peer's discovery response, a key header): the
 * stored `PublicKey` with `publicKey`, `fingerprint`, `notBefore` and `notAfter` taken from the certificate, never as
 * asserted. A revocation listed with it is kept as listed (`revokedAt`/`revocationReason`, as for X.509); a certificate
 * that carries its own revocation is marked revoked from that signature's time (`"compromised"`, the safe reading of an
 * OpenPGP revocation without a reason this server interprets). `undefined` for anything that isn't an OpenPGP certificate.
 */
export async function sanitizeOpenPgpKey(key: PublicKey, now: number = Date.now()): Promise<PublicKey | undefined> {
    if (key.useType !== "encrypt") {
        return undefined;
    }
    const parsed: OpenPgpCertificate | undefined = await parseOpenPgpCertificate(key.publicKey, now);
    if (!parsed) {
        return undefined;
    }
    const sanitized: PublicKey = { ...parsed.key };
    if (key.revokedAt !== undefined) {
        sanitized.revokedAt = key.revokedAt;
        if (key.revocationReason === "superseded" || key.revocationReason === "compromised") {
            sanitized.revocationReason = key.revocationReason;
        }
    } else if (parsed.revokedAt !== undefined) {
        sanitized.revokedAt = parsed.revokedAt;
        sanitized.revocationReason = "compromised";
    }
    return sanitized;
}

function invalid(message: string): ApiError {
    return new ApiError(ApiErrors.INVALID_REQUEST, 400, message);
}

/**
 * `SignerCertificateUtils.parseContactKey()` for OpenPGP: validates `certificate` as `address`'s OpenPGP key at `now` and
 * returns the `PublicKey` to pin or publish.
 *
 * @throws `ApiError` 400 when it isn't an OpenPGP public certificate, is revoked or not valid at `now` (created later,
 * expired), has no user ID with a valid self-signature naming `address` (case-insensitively), or can't encrypt at `now`.
 * (A key that can't sign is still a recipient; its signatures just won't verify.)
 */
export async function parseOpenPgpContactKey(certificate: unknown, address: string, now: number = Date.now()): Promise<PublicKey> {
    return checkedContactKey(await parseOpenPgpCertificate(certificate, now), address, now);
}

/** `parseOpenPgpContactKey()`'s checks of an already parsed certificate. */
function checkedContactKey(parsed: OpenPgpCertificate | undefined, address: string, now: number): PublicKey {
    if (!parsed) {
        throw invalid("'certificate' must be an OpenPGP public key (ASCII armored, or base64 binary).");
    }
    if (parsed.revokedAt !== undefined) {
        throw invalid("The provided OpenPGP key is revoked.");
    }
    if (now < parsed.key.notBefore || now > parsed.key.notAfter) {
        throw invalid("The provided OpenPGP key is not currently valid.");
    }
    if (!parsed.emails.includes(address.toLowerCase())) {
        throw invalid("The provided OpenPGP key does not identify this address.");
    }
    if (!parsed.canEncrypt) {
        throw invalid("The provided OpenPGP key has no key usable for encryption.");
    }
    return parsed.key;
}

/** The signatures of `signatures` that verify with `primaryKey` as `type` over `data`, whatever their dates: a revocation, or the binding
 * of an expired subkey, still says what the key holder said. */
async function holderSignatures(
    signatures: import("openpgp").SignaturePacket[],
    primaryKey: import("openpgp").PublicKeyPacket | import("openpgp").SecretKeyPacket,
    type: import("openpgp").enums.signature,
    data: object,
): Promise<import("openpgp").SignaturePacket[]> {
    const verified: boolean[] = await Promise.all(signatures.map((signature) => succeeds(signature.verify(primaryKey, type, data, null as any, false))));
    return signatures.filter((_signature, i) => verified[i]);
}

/**
 * Strips `cert` down to what its holder made: user IDs with their self-certifications and revocations, subkeys with their bindings and
 * revocations, and the primary key's revocations and direct signatures - each only when it verifies with the primary key. Third-party
 * certifications are dropped, and so is a user ID or subkey left with nothing that binds it. OpenPGP.js's `Key.update()` doesn't do
 * this: it takes a user ID or subkey the destination lacks, third-party certifications, and any revocation or direct signature when the
 * destination has none, all unverified.
 */
async function keepHolderComponents(cert: import("openpgp").Key): Promise<void> {
    const { enums } = await openpgp();
    const primary = cert.keyPacket;
    cert.revocationSignatures = await holderSignatures(cert.revocationSignatures, primary, enums.signature.keyRevocation, { key: primary });
    const direct = cert as unknown as { directSignatures: import("openpgp").SignaturePacket[] };
    direct.directSignatures = await holderSignatures(direct.directSignatures, primary, enums.signature.key, { key: primary });
    for (const user of cert.users) {
        const data = { userID: user.userID, userAttribute: user.userAttribute, key: primary };
        user.selfCertifications = await holderSignatures(user.selfCertifications, primary, enums.signature.certGeneric, data);
        user.otherCertifications = [];
        user.revocationSignatures = await holderSignatures(user.revocationSignatures, primary, enums.signature.certRevocation, data);
    }
    cert.users = cert.users.filter((user) => user.selfCertifications.length > 0);
    for (const subkey of cert.subkeys) {
        const data = { key: primary, bind: subkey.keyPacket };
        subkey.bindingSignatures = await holderSignatures(subkey.bindingSignatures, primary, enums.signature.subkeyBinding, data);
        subkey.revocationSignatures = await holderSignatures(subkey.revocationSignatures, primary, enums.signature.subkeyRevocation, data);
    }
    cert.subkeys = cert.subkeys.filter((subkey) => subkey.bindingSignatures.length > 0);
}

/**
 * `pinned`, an OpenPGP certificate on file, refreshed with what `observed` - the same certificate (its primary key's fingerprint) as it
 * is served now - adds: newer self-signatures (an extended expiry), new subkeys, subkey and primary key revocations. The two are merged
 * by OpenPGP.js (`Key.update()`) - `observed` stripped to what verifies with the primary key (`keepHolderComponents()`) first, and the result
 * again after - so nobody but the key holder can add anything - no third-party certification, foreign subkey or forged revocation grows
 * the pin, and no forged later-dated binding or self-certification displaces the pin's - and a stale copy, one without a revocation or a
 * subkey already on file, takes nothing away. `publicKey`, `notBefore` and `notAfter` are read
 * again from the merged certificate, and a primary key revocation it now carries marks it revoked (as `"compromised"`, as
 * `sanitizeOpenPgpKey()` reads one) unless it already is; the pin itself is unchanged. `undefined` when there is nothing to store: not
 * the same certificate, unreadable, nothing new, or a merge larger than `MAX_OPENPGP_KEY_BYTES`.
 */
export async function mergeOpenPgpCertificate(pinned: PublicKey, observed: PublicKey, now: number = Date.now()): Promise<PublicKey | undefined> {
    const [pinnedCert, observedCert] = await Promise.all([readCertificate(pinned.publicKey), readCertificate(observed.publicKey)]);
    if (!pinnedCert || !observedCert || observedCert.isPrivate() || pinnedCert.getFingerprint() !== observedCert.getFingerprint()) {
        return undefined;
    }
    // Stripped before the merge as well as after: `Key.update()` replaces the pin's binding or self-certification in place with a later-dated one
    // from the same issuer without verifying it, so a forged copy would otherwise take the genuine one out (and its subkey or user ID with it,
    // once the merged result is stripped) - a copy carrying a garbage binding would quietly leave the pin unable to encrypt.
    await keepHolderComponents(observedCert);
    const merged = await orElse(pinnedCert.update(observedCert, new Date(now)), undefined);
    if (merged) {
        await keepHolderComponents(merged);
    }
    const text: string | undefined = merged ? Buffer.from(merged.write()).toString("base64") : undefined;
    const parsed: OpenPgpCertificate | undefined = text && text !== pinned.publicKey ? await parseOpenPgpCertificate(text, now) : undefined;
    if (!parsed) {
        return undefined;
    }
    const refreshed: PublicKey = { ...pinned, publicKey: parsed.key.publicKey, notBefore: parsed.key.notBefore, notAfter: parsed.key.notAfter };
    if (pinned.revokedAt === undefined && parsed.revokedAt !== undefined) {
        refreshed.revokedAt = parsed.revokedAt;
        refreshed.revocationReason = "compromised";
    }
    return refreshed;
}

/**
 * Whether OpenPGP `observed` may replace the pinned OpenPGP key `pinned` without prompting - this format's counterpart of
 * the same-issuing-CA rule (`KeyringUtils.canReplaceAutomatically()`): `pinned` is expired at `observedAt` or revoked as
 * `"superseded"`, and `observed` is a valid key for `address` (`parseOpenPgpContactKey()`) whose user ID for `address` carries a
 * certification that verifies with `pinned`'s primary key, made no later than `pinned` was retired - the key the user trusted
 * vouches for its successor. Unlike X.509, where the issuing CA vouches, here the retired key itself does: a key revoked as
 * `"compromised"` (or for no stated reason) may be in an attacker's hands, so it never vouches, and its successor is a key conflict
 * for the user to decide. Never throws.
 */
export async function canReplaceOpenPgpKeyAutomatically(pinned: PublicKey, observed: PublicKey, address: string, observedAt: number): Promise<boolean> {
    try {
        if (pinned.revokedAt !== undefined ? pinned.revocationReason !== "superseded" : !(observedAt > pinned.notAfter)) {
            return false;
        }
        await parseOpenPgpContactKey(observed.publicKey, address, observedAt);
        const [pinnedCert, observedCert] = await Promise.all([readCertificate(pinned.publicKey), readCertificate(observed.publicKey)]);
        if (!pinnedCert || !observedCert) {
            return false;
        }
        const wanted: string = address.toLowerCase();
        const pinnedKeyIds = pinnedCert.getKeyIDs();
        // A certification dated after the pinned key was retired vouches for nothing.
        const retiredAt: number = Math.min(pinned.revokedAt ?? Infinity, pinned.notAfter);
        for (const user of observedCert.users) {
            if (user.userID?.email?.toLowerCase() !== wanted) {
                continue;
            }
            for (const certification of user.otherCertifications) {
                const created: number | undefined = certification.created?.getTime();
                if (created === undefined || created > retiredAt || !pinnedKeyIds.some((id) => id.equals(certification.issuerKeyID))) {
                    continue;
                }
                // Checked against the pinned key as of the certification's own date (OpenPGP.js), so an expired or revoked pinned key
                // still verifies a certification it made while it was valid.
                if ((await orElse(user.verifyCertificate(certification, [pinnedCert as any], new Date(observedAt)), null)) === true) {
                    return true;
                }
            }
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * The OpenPGP certificates in `binary` (one or more concatenated transferable public keys, as a Web Key Directory answers) that are
 * `address`'s: the one that is its key at `now` (`parseOpenPgpContactKey()`), the newest when several are, first; then every one its
 * holder revoked that names `address`, marked revoked (`revokedAt`, `"compromised"` as `sanitizeOpenPgpKey()` reads one). A revoked one
 * is never pinned: it is revocation evidence for a contact that pins it (`KeyringUtils.applyDiscoveredKeys()`), and a directory can only
 * replay a revocation the key holder signed. Empty when there is none.
 */
export async function selectOpenPgpKeysFor(binary: Uint8Array, address: string, now: number = Date.now()): Promise<PublicKey[]> {
    if (binary.length === 0 || binary.length > MAX_OPENPGP_KEY_BYTES * 4) {
        return [];
    }
    const pgp: OpenPgp = await openpgp();
    const certs = await orElse(pgp.readKeys({ binaryKeys: binary }), []);
    let newest: PublicKey | undefined;
    const revoked: PublicKey[] = [];
    for (const cert of certs.slice(0, 8)) {
        const parsed: OpenPgpCertificate | undefined = await parseOpenPgpCertificate(Buffer.from(cert.write()).toString("base64"), now);
        if (parsed?.revokedAt !== undefined) {
            if (parsed.emails.includes(address.toLowerCase())) {
                revoked.push({ ...parsed.key, revokedAt: parsed.revokedAt, revocationReason: "compromised" });
            }
            continue;
        }
        let key: PublicKey;
        try {
            key = checkedContactKey(parsed, address, now);
        } catch {
            continue;
        }
        if (!newest || key.notBefore > newest.notBefore) {
            newest = key;
        }
    }
    return [...(newest ? [newest] : []), ...revoked];
}
