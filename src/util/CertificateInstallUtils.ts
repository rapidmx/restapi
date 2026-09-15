///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { PublicKey } from "../models/types.js";
import { MAX_ISSUER_CERTIFICATE_BASE64_LENGTH } from "./KeyDiscoveryClient.js";

const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/** Normalizes a `crypto.X509Certificate`'s colon-separated-hex fingerprint to the same lowercase,
 * no-separator hex format `EncryptionCertificateAuthority.issue()` already produces (see
 * `LocalX509CertificateAuthority`/`OpenBaoPkiCertificateAuthority`'s own `getThumbprint()`-derived
 * fingerprints), so a `PublicKey.fingerprint` looks the same regardless of which code path derived it. */
export function normalizeFingerprint(fingerprint256: string): string {
    return fingerprint256.replace(/:/g, "").toLowerCase();
}

/** Every `CERTIFICATE` PEM block in `pem`, in order - a PEM chain (leaf first, then its issuer, then that issuer's
 * issuer...) as ACME downloads and most CA portals hand out. Text outside the blocks is ignored. */
export function splitPemCertificates(pem: string): string[] {
    return typeof pem === "string" ? (pem.match(PEM_CERTIFICATE_PATTERN) ?? []) : [];
}

/**
 * The base64 DER of `issuerPem` when it provably issued `leaf`, else `undefined` (never throws). Proven means all of:
 * it parses; the leaf's issuer name equals its subject; OpenSSL's `checkIssued()` agrees (name, key identifiers, and
 * a CA key usage when one is present); `leaf`'s signature verifies against its public key; and its DER is at most
 * `MAX_ISSUER_CERTIFICATE_BASE64_LENGTH` base64 characters (the bound a peer's `parseKeyDiscoveryResponse()` accepts,
 * so a mailbox never publishes a key its peers would reject). Anything else is dropped rather than refused: the leaf is
 * still installed, it just carries no `issuerCertificate`.
 */
export function verifiedIssuerCertificate(leaf: crypto.X509Certificate, issuerPem: string | undefined): string | undefined {
    if (!issuerPem) {
        return undefined;
    }
    try {
        const issuer = new crypto.X509Certificate(issuerPem);
        if (leaf.issuer !== issuer.subject || !leaf.checkIssued(issuer) || !leaf.verify(issuer.publicKey)) {
            return undefined;
        }
        const der: string = issuer.raw.toString("base64");
        return der.length <= MAX_ISSUER_CERTIFICATE_BASE64_LENGTH ? der : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Parses and validates a client- or CA-supplied certificate PEM into a `PublicKey` ready to append to
 * `Mailbox.keys` - shared by `BaseKeyVaultRoute.enrollKey()`'s `useType: "sign"` install path (a human
 * pastes/uploads an already-issued certificate) and `AcmeEnrollmentDriverJob`'s automatic install once an
 * RFC 8823 enrollment reaches `"issued"` (no human involved at all) - both need the exact same
 * parse/validate/normalize logic, only how they obtain `certificatePem` differs.
 *
 * `certificatePem` may be a PEM chain: the first certificate is the leaf that gets installed, and the second - when
 * present - is taken as its issuer and published as `PublicKey.issuerCertificate` only if it verifies
 * (`verifiedIssuerCertificate()`). Any further certificates are ignored.
 *
 * @throws `ApiError` (400) if the PEM can't be parsed, or if it doesn't identify `mailboxAddress` at all -
 * see the inline comment on why the latter check exists.
 */
export function publicKeyFromCertificatePem(
    certificatePem: string,
    useType: "sign" | "encrypt",
    mailboxAddress: string,
): { publicKey: PublicKey; fingerprint: string } {
    const blocks: string[] = splitPemCertificates(certificatePem);
    let cert: crypto.X509Certificate;
    try {
        cert = new crypto.X509Certificate(blocks[0] ?? certificatePem);
    } catch {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided certificate could not be parsed.");
    }
    // Identity binding: "matches the mailbox identity is left to the CA that issued it" is true for
    // chain-of-trust validity, but was previously also true for whether the certificate names this
    // mailbox at all - nothing checked that, so any mailbox owner could publish any third party's
    // genuinely-valid signing certificate (e.g. lifted from any signed email they received) as their own.
    // `checkEmail()` is Node's own RFC 5280 `rfc822Name` SAN matcher (falls back to a CN-based comparison
    // per its documented legacy behavior) - this does not re-litigate the issuing CA's trust decision,
    // only that the certificate the CA vouched for actually names *this* mailbox.
    if (!cert.checkEmail(mailboxAddress)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "The provided certificate does not identify this mailbox's address.");
    }
    return { fingerprint: normalizeFingerprint(cert.fingerprint256), publicKey: publicKeyFromCertificate(cert, useType, blocks[1]) };
}

/**
 * Builds the `PublicKey` for an already parsed (and, by the caller, already validated) leaf certificate, with
 * `issuerCertificate` set only when `issuerPem` verifiably issued it (`verifiedIssuerCertificate()`).
 */
export function publicKeyFromCertificate(cert: crypto.X509Certificate, useType: "sign" | "encrypt", issuerPem?: string): PublicKey {
    const fingerprint: string = normalizeFingerprint(cert.fingerprint256);
    const publicKey: PublicKey = {
        publicKey: cert.raw.toString("base64"),
        type: "x509",
        useType,
        fingerprint,
        notBefore: new Date(cert.validFrom).getTime(),
        notAfter: new Date(cert.validTo).getTime(),
    };
    const issuerCertificate: string | undefined = verifiedIssuerCertificate(cert, issuerPem);
    if (issuerCertificate) {
        publicKey.issuerCertificate = issuerCertificate;
    }
    return publicKey;
}

/** A `PublicKey.revocationReason` value. */
export const REVOCATION_REASONS = ["superseded", "compromised"] as const;

/** `key` revoked at `at` because a newer key of its `useType` replaced it. */
function superseded(key: PublicKey, at: number): PublicKey {
    return { ...key, revokedAt: at, revocationReason: "superseded" };
}

/**
 * `keys` with `installed` made the mailbox's active key of its `useType`: every other key of that `useType` that isn't
 * already revoked gets `revokedAt: installedAt` and `revocationReason: "superseded"`, so a peer re-running discovery sees the previous key as retired (the
 * condition, with a shared issuer, under which the spec lets it replace a pinned key without prompting). Entries with
 * `installed`'s own fingerprint (a re-enrollment of the same certificate) are replaced by `installed`, which is
 * appended last. Keys of the other `useType` are untouched. Only the public record changes - wrapped private keys are
 * not touched here (see `specs/end-to-end_encryption.md`'s rotation table).
 *
 * The caller must write the result in the same update that publishes `installed`, so a failed install revokes nothing.
 */
export function supersedeKeys(keys: PublicKey[] | null | undefined, installed: PublicKey, installedAt: number): PublicKey[] {
    const kept: PublicKey[] = (keys ?? [])
        .filter((key) => key.fingerprint !== installed.fingerprint)
        .map((key) => (key.useType === installed.useType && !key.revokedAt ? superseded(key, installedAt) : key));
    return [...kept, installed];
}

/**
 * For each `useType`, revokes as superseded (`revokedAt: at`, `revocationReason: "superseded"`) every unrevoked key except the active one - the unrevoked, unexpired
 * key with the latest `notBefore` (later array position on a tie), the same choice react-shared's
 * `findActivePublicKey()` makes. A `useType` with no unexpired unrevoked key is left as it is. Used by `rekey()` so a
 * mailbox whose keys were enrolled before superseded keys were revoked is normalized on its next rotation.
 */
export function revokeInactiveKeys(keys: PublicKey[], at: number): PublicKey[] {
    const activeIndex = new Map<string, number>();
    keys.forEach((key, index) => {
        if (key.revokedAt || !(key.notAfter > at)) {
            return;
        }
        const current: number | undefined = activeIndex.get(key.useType);
        if (current === undefined || key.notBefore >= keys[current].notBefore) {
            activeIndex.set(key.useType, index);
        }
    });
    return keys.map((key, index) => {
        const active: number | undefined = activeIndex.get(key.useType);
        return active !== undefined && active !== index && !key.revokedAt ? superseded(key, at) : key;
    });
}
