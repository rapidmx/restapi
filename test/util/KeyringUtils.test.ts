///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests - `applyDiscoveredKeys()` is pure logic, tested directly with hand-built inputs.
// `discoverAndMergeKeys()`'s own DNS/HTTP calls are stubbed the same way test/util/FederationUtils.test.ts and
// test/util/KeyDiscoveryClient.test.ts stub theirs - each test uses a unique domain/address, since both of
// those modules keep a shared module-level cache across every test in this process.
import "reflect-metadata";
import * as nodeCrypto from "crypto";
import * as x509 from "@peculiar/x509";
import {
    addPreviousKey,
    addRejectedKey,
    applyDiscoveredKeys,
    canReplaceAutomatically,
    discoverAndMergeKeys,
    escalateRevocation,
    listField,
    MAX_PREVIOUS_KEYS_PER_USE_TYPE,
    MAX_REJECTED_KEYS,
    normalizeKeyConflicts,
    sanitizeDiscoveredKey,
    withoutKey,
    type ContactKeyState,
} from "../../src/util/KeyringUtils.js";
import type { DnsResolver } from "../../src/dns/DnsResolver.js";
import type { KeyConflict, KeyDiscoveryResponse, PreviousKey, PublicKey, RejectedKey } from "../../src/models/types.js";
import {
    issueCertificate,
    makeSignerCertificate,
    makeTestIssuer,
    type SignerCertificate,
    type SignerCertificateOptions,
    type TestIssuer,
} from "./signerCertificates.js";

x509.cryptoProvider.set(crypto);

async function makeCertDer(cn: string): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: `CN=${cn}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return Buffer.from(cert.rawData).toString("base64");
}

/** Builds two leaf certificates genuinely issued by the same (test-only, self-signed) CA - `makeCertDer()`
 * alone only ever produces self-signed certs, which `sameIssuingCa()` never treats as "same CA" evidence
 * regardless of DN (a self-signed certificate's own `issuer` is just an attacker-choosable string in a
 * certificate the attacker minted themselves - see that function's own doc comment) - these tests need a
 * real, non-self-signed issuer relationship to exercise the auto-replace path at all. */
async function makeCaIssuedCertPair(): Promise<{ first: string; second: string }> {
    const caKeys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const ca = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=Test Shared CA",
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        keys: caKeys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
    });
    async function issueLeaf(cn: string): Promise<string> {
        const leafKeys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
        const leaf = await x509.X509CertificateGenerator.create({
            subject: `CN=${cn}`,
            issuer: ca.subjectName,
            notBefore: new Date(),
            notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            publicKey: leafKeys.publicKey,
            signingKey: caKeys.privateKey,
            signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        });
        return Buffer.from(leaf.rawData).toString("base64");
    }
    return { first: await issueLeaf("leaf-1@example.com"), second: await issueLeaf("leaf-2@example.com") };
}

// `sanitizeDiscoveredKey()` (`src/util/KeyringUtils.ts`) always recomputes `fingerprint` from the certificate
// itself rather than trusting an asserted value - this mirrors that exact computation (Node's own
// `crypto.X509Certificate`, not `@peculiar/x509`'s) so a test can assert against the real, resulting
// fingerprint of a `makeCertDer()`-built certificate instead of an arbitrary placeholder string.
function certFingerprint(certDer: string): string {
    return new nodeCrypto.X509Certificate(Buffer.from(certDer, "base64")).fingerprint256.replace(/:/g, "").toLowerCase();
}

let uniqueCn = 0;

/**
 * Builds a `PublicKey` for a test. `publicKey` defaults to a freshly generated *real*, parseable self-signed
 * certificate (base64 DER) - `applyDiscoveredKeys()` runs every *discovered* key through `sanitizeDiscoveredKey()`,
 * which drops (never pins) anything that doesn't parse as a real X.509 certificate and always recomputes
 * `fingerprint` from it, so a discovered-side test key needs real cert bytes and must assert against
 * `certFingerprint()`'s result, not an arbitrary literal. A test exercising only the *pinned* (existing) side
 * - never re-validated - may still pass a placeholder `publicKey`/`fingerprint` via `overrides`.
 */
async function makeKey(overrides: Partial<PublicKey> = {}): Promise<PublicKey> {
    const publicKey: string = overrides.publicKey ?? (await makeCertDer(`test-${uniqueCn++}@example.com`));
    // An explicit `fingerprint` override means the caller is deliberately building a pinned-only (never
    // re-validated) key, possibly with an intentionally-unparseable `publicKey` - skip recomputing in that
    // case rather than throwing trying to parse it.
    const fingerprint: string = overrides.fingerprint ?? certFingerprint(publicKey);
    // `sanitizeDiscoveredKey()` also takes `notBefore`/`notAfter` from the certificate itself, so default to
    // the certificate's real validity window (falling back to placeholders for an unparseable pinned-only key).
    let notBefore = 0;
    let notAfter: number = Date.now() + 1_000_000;
    try {
        const cert = new nodeCrypto.X509Certificate(Buffer.from(publicKey, "base64"));
        notBefore = new Date(cert.validFrom).getTime();
        notAfter = new Date(cert.validTo).getTime();
    } catch {
        // Placeholder values stand.
    }
    return {
        publicKey,
        type: "x509",
        useType: "encrypt",
        fingerprint,
        notBefore,
        notAfter,
        ...overrides,
    };
}

const ADDRESS = "peer@example.com";

function makeDiscovery(keys: PublicKey[], lastSeen?: number): KeyDiscoveryResponse {
    return { encryptPreference: { preferEncrypt: "mutual", lastSeen }, keys, escrow: false };
}

describe("applyDiscoveredKeys() Tests", () => {
    it("TOFU-pins the first key ever observed for a useType, with no conflict, and stamps keysFirstSeen.", async () => {
        const newKey = await makeKey();
        const result = applyDiscoveredKeys(undefined, makeDiscovery([newKey]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([newKey]);
        expect(result.keyConflicts).toBeUndefined();
        expect(result.keysFirstSeen).toBe(1000);
    });

    it("TOFU-pins encrypt and sign keys independently from the same discovery response.", async () => {
        const encryptKey = await makeKey({ useType: "encrypt" });
        const signKey = await makeKey({ useType: "sign" });
        const result = applyDiscoveredKeys(undefined, makeDiscovery([encryptKey, signKey]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([encryptKey, signKey]);
    });

    it("Is a no-op when the observed key exactly matches the pinned one.", async () => {
        const pinned = await makeKey();
        const existing: ContactKeyState = { keys: [pinned], encryptPreference: { preferEncrypt: "mutual", lastSeen: 500 } };
        const result = applyDiscoveredKeys(existing, makeDiscovery([{ ...pinned }], 500), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflicts).toBeUndefined();
    });

    it("Records a conflict (retaining the pinned key) when a different, still-valid key is observed.", async () => {
        const pinned = await makeKey({ notAfter: Date.now() + 1_000_000 });
        const existing: ContactKeyState = { keys: [pinned] };
        const observed = await makeKey();

        const result = applyDiscoveredKeys(existing, makeDiscovery([observed]), 2000, "header", ADDRESS);

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflicts).toEqual([{ useType: "encrypt", observedKey: observed, observedAt: 2000, source: "header" }]);
    });

    it("Records a conflict (never auto-replaces) when the pinned key is expired and the new one is genuinely issued by the same CA, but carries no issuerCertificate to prove it.", async () => {
        const { first, second } = await makeCaIssuedCertPair();
        const pinned = await makeKey({ publicKey: first, notAfter: 500 });
        const observed = await makeKey({ publicKey: second });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflicts).toEqual([{ useType: "encrypt", observedKey: observed, observedAt: 1000, source: "discovery" }]);
    });

    it("Records a conflict (never auto-replaces) when the pinned key is revoked and the new one shares its issuer DN without an issuerCertificate.", async () => {
        const { first, second } = await makeCaIssuedCertPair();
        const pinned = await makeKey({ publicKey: first, notAfter: Date.now() + 1_000_000, revokedAt: 999 });
        const observed = await makeKey({ publicKey: second });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflicts?.[0].observedKey.fingerprint).toBe(observed.fingerprint);
    });

    it("Records a conflict (does not auto-replace) when the pinned key is expired but the issuers genuinely differ.", async () => {
        const pinnedCertDer = await makeCertDer("issuer-a@example.com");
        const observedCertDer = await makeCertDer("issuer-b@example.com");
        const pinned = await makeKey({ publicKey: pinnedCertDer, notAfter: 500 });
        const observed = await makeKey({ publicKey: observedCertDer });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflicts?.[0].observedKey.fingerprint).toBe(observed.fingerprint);
    });

    it("Records a conflict rather than silently replacing when the pinned key is expired and a self-signed replacement forges the same issuer DN - self-signed is never trusted as 'same CA' evidence, regardless of what the DN claims.", async () => {
        // The concrete attack `sameIssuingCa()` exists to stop: both certificates claim `CN=shared@example.com`
        // as their issuer (a plain string, copyable by anyone), but each is independently self-signed by a
        // different key - a naive issuer-DN string comparison would treat this pair as "same CA" and silently
        // substitute the pinned key; `checkIssued()` correctly identifies each as self-signed instead.
        const pinnedCertDer = await makeCertDer("shared@example.com");
        const forgedCertDer = await makeCertDer("shared@example.com");
        const pinned = await makeKey({ publicKey: pinnedCertDer, notAfter: 500 });
        const observed = await makeKey({ publicKey: forgedCertDer });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflicts?.[0].observedKey.fingerprint).toBe(observed.fingerprint);
    });

    it("Records a conflict when the pinned certificate is unparseable, even though the observed one is valid - sameIssuingCa() fails closed rather than throwing.", async () => {
        const pinned = await makeKey({ publicKey: "not-a-real-cert", fingerprint: "fp-unparseable-pinned", notAfter: 500 });
        const observed = await makeKey();

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflicts?.[0].observedKey.fingerprint).toBe(observed.fingerprint);
    });

    it("Silently drops (never pins, never conflicts) a discovered key whose certificate doesn't parse at all.", async () => {
        const pinned = await makeKey();
        const existing: ContactKeyState = { keys: [pinned] };
        const unparseable: PublicKey = { publicKey: "also-not-a-cert", type: "x509", useType: "encrypt", fingerprint: "fp-whatever", notBefore: 0, notAfter: Date.now() + 1_000_000 };

        const result = applyDiscoveredKeys(existing, makeDiscovery([unparseable]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflicts).toBeUndefined();
    });

    it("Silently drops a discovered key whose well-formed base64 isn't a certificate at all.", async () => {
        const pinned = await makeKey();
        const notACert: PublicKey = {
            publicKey: Buffer.from("definitely not a DER certificate").toString("base64"),
            type: "x509",
            useType: "encrypt",
            fingerprint: "fp-whatever",
            notBefore: 0,
            notAfter: Date.now() + 1_000_000,
        };

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([notACert]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflicts).toBeUndefined();
    });

    it("Silently drops a discovered certificate whose validity dates don't parse (e.g. an out-of-range month).", async () => {
        const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
        const cert = await x509.X509CertificateGenerator.createSelfSigned({
            name: "CN=bad-time@example.com",
            notBefore: new Date("2026-01-01T00:00:00.000Z"),
            notAfter: new Date("2099-01-01T00:00:00.000Z"),
            keys,
            signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        });
        const der: Buffer = Buffer.from(cert.rawData);
        const offset: number = der.toString("latin1").indexOf("260101000000Z");
        expect(offset).toBeGreaterThan(0);
        // Month 13: Node still parses the certificate, but reports its validFrom as "Bad time value".
        der.write("261301000000Z", offset, "latin1");
        expect(Number.isFinite(new Date(new nodeCrypto.X509Certificate(der).validFrom).getTime())).toBe(false);
        const badTime: PublicKey = { publicKey: der.toString("base64"), type: "x509", useType: "sign", fingerprint: "fp", notBefore: 0, notAfter: 1 };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([badTime]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([]);
    });

    it("Takes notBefore/notAfter from the certificate itself, ignoring peer-asserted values.", async () => {
        const realKey = await makeKey();
        const lying: PublicKey = { ...realKey, notBefore: 1, notAfter: 8_000_000_000_000 };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([lying]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([realKey]);
        expect(result.keys![0].notAfter).not.toBe(8_000_000_000_000);
    });

    it("Treats a structurally malformed response as no response at all (no throw, nothing applied).", async () => {
        const existing: ContactKeyState = { keys: [], encryptPreference: { preferEncrypt: "mutual", lastSeen: 1 } };
        const malformed = { keys: [await makeKey()], escrow: false } as unknown as KeyDiscoveryResponse;

        const result = applyDiscoveredKeys(existing, malformed, 1000, "discovery", ADDRESS);

        expect(result).toEqual({ ...existing, keysFirstSeen: undefined, keyConflicts: undefined, previousKeys: undefined, rejectedKeys: undefined });
    });

    it("Silently drops a discovered key whose useType isn't 'sign'/'encrypt'.", async () => {
        const realKey = await makeKey();
        const bogus: PublicKey = { ...realKey, useType: "decode" as any };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([bogus]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([]);
    });

    it("Silently drops a discovered key whose publicKey is missing/empty.", async () => {
        const realKey = await makeKey();
        const bogus: PublicKey = { ...realKey, publicKey: "" };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([bogus]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([]);
    });

    it("Silently drops a discovered key whose publicKey exceeds the maximum allowed length (oversized-blob DoS guard).", async () => {
        const realKey = await makeKey();
        const bogus: PublicKey = { ...realKey, publicKey: "A".repeat(9000) };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([bogus]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([]);
    });

    it("Silently drops a discovered key whose notBefore/notAfter aren't finite numbers.", async () => {
        const realKey = await makeKey();
        const bogus: PublicKey = { ...realKey, notAfter: NaN };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([bogus]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([]);
    });

    it("Anti-Downgrade: a discovered of undefined leaves keys/preference/keysFirstSeen/keyConflicts/previousKeys untouched.", async () => {
        const key = await makeKey();
        const existing: ContactKeyState = {
            keys: [key],
            encryptPreference: { preferEncrypt: "mutual", lastSeen: 500 },
            keysFirstSeen: 100,
            keyConflicts: [{ useType: "encrypt", observedKey: await makeKey(), observedAt: 1, source: "header" }],
            previousKeys: [{ ...(await makeKey()), replacedAt: 2, replacement: "user" }],
            rejectedKeys: [{ useType: "encrypt", fingerprint: "r", rejectedAt: 3 }],
        };

        const result = applyDiscoveredKeys(existing, undefined, 9999, "header", ADDRESS);

        expect(result).toEqual(existing);
    });

    it("Anti-Downgrade: does not apply a preference update whose lastSeen is not strictly newer than what's on file.", () => {
        const existing: ContactKeyState = { keys: [], encryptPreference: { preferEncrypt: "mutual", lastSeen: 500 } };
        const result = applyDiscoveredKeys(existing, makeDiscovery([], 500), 1000, "discovery", ADDRESS);

        expect(result.encryptPreference).toEqual({ preferEncrypt: "mutual", lastSeen: 500 });
    });

    it("Applies a preference update whose lastSeen is strictly newer than what's on file.", () => {
        const existing: ContactKeyState = { keys: [], encryptPreference: { preferEncrypt: "mutual", lastSeen: 500 } };
        const discovered = makeDiscovery([], 600);
        discovered.encryptPreference.preferEncrypt = "nopreference";

        const result = applyDiscoveredKeys(existing, discovered, 1000, "discovery", ADDRESS);

        expect(result.encryptPreference).toEqual({ preferEncrypt: "nopreference", lastSeen: 600 });
    });

    it("Applies the discovered preference outright when nothing was previously on file.", () => {
        const result = applyDiscoveredKeys(undefined, makeDiscovery([], 1), 1000, "discovery", ADDRESS);
        expect(result.encryptPreference).toEqual({ preferEncrypt: "mutual", lastSeen: 1 });
    });

    it("Preserves an already-set keysFirstSeen rather than overwriting it on a later call.", async () => {
        const key = await makeKey();
        const existing: ContactKeyState = { keys: [key], keysFirstSeen: 42 };
        const result = applyDiscoveredKeys(existing, makeDiscovery([{ ...key }]), 9999, "discovery", ADDRESS);

        expect(result.keysFirstSeen).toBe(42);
    });

    it("Caps the number of keys considered from one discovery response, ignoring anything past the limit.", async () => {
        // `MAX_DISCOVERED_KEYS` (8) - one real cert, repeated past the cap; each entry has the same `useType`,
        // so only the first ever gets pinned regardless (the useType-indexed merge caps stored state at 2
        // entries on its own) - this specifically exercises the `.slice()` bound itself running without error
        // over an oversized array, not a distinguishable stored-state difference.
        const key = await makeKey();
        const manyKeys: PublicKey[] = Array.from({ length: 50 }, () => ({ ...key }));

        const result = applyDiscoveredKeys(undefined, makeDiscovery(manyKeys), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([key]);
    });
});

describe("Key rotation continuity Tests", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const expired = { notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - DAY) };

    /** The pinned/observed `PublicKey` for a generated certificate, as `sanitizeDiscoveredKey()` stores it. */
    function keyOf(cert: SignerCertificate, overrides: Partial<PublicKey> = {}): PublicKey {
        return {
            ...sanitizeDiscoveredKey({ publicKey: cert.certificate, type: "x509", useType: "sign", fingerprint: "", notBefore: 0, notAfter: 0 })!,
            ...overrides,
        };
    }

    async function rotation(options: { pinned?: SignerCertificateOptions; issuer?: TestIssuer } = {}) {
        const issuer: TestIssuer = options.issuer ?? (await makeTestIssuer());
        const pinned = await issueCertificate(issuer, { sanEmails: [ADDRESS], ...options.pinned });
        const next = await issueCertificate(issuer, { sanEmails: [ADDRESS] });
        return { issuer, pinned, next };
    }

    it("Replaces an expired pinned key with a same-CA key carrying its issuer, moving the old key to previousKeys and clearing the conflict.", async () => {
        const { issuer, pinned, next } = await rotation({ pinned: expired });
        const pinnedKey = keyOf(pinned);
        const staleConflict: KeyConflict = { useType: "sign", observedKey: keyOf(await makeSignerCertificate()), observedAt: 1, source: "header" };
        const encryptConflict: KeyConflict = { useType: "encrypt", observedKey: await makeKey(), observedAt: 2, source: "discovery" };
        const observed = keyOf(next, { issuerCertificate: issuer.certificate });
        const now = Date.now();

        const result = applyDiscoveredKeys(
            { keys: [pinnedKey], keyConflicts: [staleConflict, encryptConflict] },
            makeDiscovery([observed]),
            now,
            "discovery",
            ADDRESS,
        );

        expect(result.keys).toEqual([observed]);
        expect(result.keys![0].issuerCertificate).toBe(issuer.certificate);
        expect(result.previousKeys).toEqual([{ ...pinnedKey, replacedAt: now, replacement: "automatic" }]);
        expect(result.keyConflicts).toEqual([encryptConflict]);
    });

    it("Clears the last conflict to an empty list (so the write clears it) on an automatic replacement.", async () => {
        const { issuer, pinned, next } = await rotation({ pinned: expired });
        const staleConflict: KeyConflict = { useType: "sign", observedKey: keyOf(await makeSignerCertificate()), observedAt: 1, source: "header" };

        const result = applyDiscoveredKeys(
            { keys: [keyOf(pinned)], keyConflicts: [staleConflict] },
            makeDiscovery([keyOf(next, { issuerCertificate: issuer.certificate })]),
            Date.now(),
            "discovery",
            ADDRESS,
        );

        expect(result.keyConflicts).toEqual([]);
    });

    it("Replaces a pinned key revoked on its stored record, keeping its revocation reason in previousKeys.", async () => {
        const { issuer, pinned, next } = await rotation();
        const pinnedKey = keyOf(pinned, { revokedAt: 5, revocationReason: "superseded" });
        const observed = keyOf(next, { issuerCertificate: issuer.certificate });

        const result = applyDiscoveredKeys({ keys: [pinnedKey] }, makeDiscovery([observed]), 1000 + Date.now(), "discovery", ADDRESS);

        expect(result.keys).toEqual([observed]);
        expect(result.previousKeys).toEqual([expect.objectContaining({ fingerprint: pinned.fingerprint, revokedAt: 5, revocationReason: "superseded", replacement: "automatic" })]);
    });

    it("Replaces a pinned key the same response lists as superseded, carrying the listed revocation into previousKeys.", async () => {
        const { issuer, pinned, next } = await rotation();
        const observed = keyOf(next, { issuerCertificate: issuer.certificate });
        const listedOld = keyOf(pinned, { revokedAt: 7, revocationReason: "superseded" });

        // The new key is listed first: the listed revocation still applies before it's considered.
        const result = applyDiscoveredKeys({ keys: [keyOf(pinned)] }, makeDiscovery([observed, listedOld]), Date.now(), "discovery", ADDRESS);

        expect(result.keys).toEqual([observed]);
        expect(result.previousKeys).toEqual([expect.objectContaining({ fingerprint: pinned.fingerprint, revokedAt: 7, revocationReason: "superseded" })]);
        expect(result.keyConflicts).toBeUndefined();
    });

    it("Replaces a pinned key the same response lists as revoked without a reason (compromised).", async () => {
        const { issuer, pinned, next } = await rotation();
        const observed = keyOf(next, { issuerCertificate: issuer.certificate });

        const result = applyDiscoveredKeys(
            { keys: [keyOf(pinned, { revokedAt: 3, revocationReason: "superseded" })] },
            makeDiscovery([keyOf(pinned, { revokedAt: 9 }), observed]),
            Date.now(),
            "discovery",
            ADDRESS,
        );

        expect(result.keys).toEqual([observed]);
        expect(result.previousKeys![0].revokedAt).toBe(9);
        expect(result.previousKeys![0].revocationReason).toBeUndefined();
    });

    it("Records a listed revocation onto a pinned key and a previous key without replacing anything, never weakening one.", async () => {
        const pinnedCert = await makeSignerCertificate({ sanEmails: [ADDRESS] });
        const previousCert = await makeSignerCertificate({ sanEmails: [ADDRESS] });
        const compromisedCert = await makeSignerCertificate({ sanEmails: [ADDRESS] });
        const previous: PreviousKey = { ...keyOf(previousCert), replacedAt: 1, replacement: "user" };
        const compromised: PreviousKey = { ...keyOf(compromisedCert, { revokedAt: 2, revocationReason: "compromised" }), replacedAt: 1, replacement: "user" };

        const result = applyDiscoveredKeys(
            { keys: [keyOf(pinnedCert)], previousKeys: [previous, compromised] },
            makeDiscovery([
                keyOf(pinnedCert, { revokedAt: 10, revocationReason: "superseded" }),
                keyOf(previousCert, { revokedAt: 11 }),
                keyOf(compromisedCert, { revokedAt: 12, revocationReason: "superseded" }),
            ]),
            Date.now(),
            "discovery",
            ADDRESS,
        );

        expect(result.keys).toEqual([keyOf(pinnedCert, { revokedAt: 10, revocationReason: "superseded" })]);
        expect(result.previousKeys).toEqual([{ ...previous, revokedAt: 11 }, compromised]);
        expect(result.keyConflicts).toBeUndefined();
    });

    it("escalateRevocation() only ever strengthens a revocation.", async () => {
        const key = keyOf(await makeSignerCertificate());
        const superseded = { ...key, revokedAt: 1, revocationReason: "superseded" as const };
        const compromised = { ...key, revokedAt: 2, revocationReason: "compromised" as const };
        expect(escalateRevocation(key, undefined)).toBe(key);
        expect(escalateRevocation(key, key)).toBe(key);
        expect(escalateRevocation(key, superseded)).toEqual(superseded);
        expect(escalateRevocation(superseded, compromised)).toEqual(compromised);
        expect(escalateRevocation(superseded, { ...key, revokedAt: 3 })).toEqual({ ...key, revokedAt: 3 });
        expect(escalateRevocation(compromised, superseded)).toBe(compromised);
    });

    it("Replaces when the issuer certificate has no basicConstraints extension at all.", async () => {
        const { issuer, pinned, next } = await rotation({ issuer: await makeTestIssuer({ ca: null }), pinned: expired });
        const observed = keyOf(next, { issuerCertificate: issuer.certificate });

        const result = applyDiscoveredKeys({ keys: [keyOf(pinned)] }, makeDiscovery([observed]), Date.now(), "discovery", ADDRESS);

        expect(result.keys).toEqual([observed]);
    });

    it("Replaces an encrypt key whose usage fits encryption.", async () => {
        const issuer = await makeTestIssuer();
        const pinned = await issueCertificate(issuer, { sanEmails: [ADDRESS], ...expired });
        const next = await issueCertificate(issuer, {
            sanEmails: [ADDRESS],
            keyUsage: x509.KeyUsageFlags.keyAgreement,
            extKeyUsage: [x509.ExtendedKeyUsage.emailProtection],
        });
        const observed = keyOf(next, { useType: "encrypt", issuerCertificate: issuer.certificate });

        const result = applyDiscoveredKeys({ keys: [keyOf(pinned, { useType: "encrypt" })] }, makeDiscovery([observed]), Date.now(), "discovery", ADDRESS);

        expect(result.keys).toEqual([observed]);
    });

    describe("records a conflict instead of replacing", () => {
        async function expectConflict(pinnedKey: PublicKey, observed: PublicKey, observedAt: number = Date.now()): Promise<void> {
            const result = applyDiscoveredKeys({ keys: [pinnedKey] }, makeDiscovery([observed]), observedAt, "discovery", ADDRESS);
            expect(result.keys).toEqual([pinnedKey]);
            expect(result.previousKeys).toBeUndefined();
            expect(result.keyConflicts).toEqual([{ useType: observed.useType, observedKey: observed, observedAt, source: "discovery" }]);
        }

        it("when the new key comes from a different CA", async () => {
            const { pinned } = await rotation({ pinned: expired });
            const other = await rotation();
            await expectConflict(keyOf(pinned), keyOf(other.next, { issuerCertificate: other.issuer.certificate }));
        });

        it("when a different CA key reuses the same CA name", async () => {
            const { pinned } = await rotation({ pinned: expired });
            const impostor = await makeTestIssuer();
            const next = await issueCertificate(impostor, { sanEmails: [ADDRESS] });
            await expectConflict(keyOf(pinned), keyOf(next, { issuerCertificate: impostor.certificate }));
        });

        it("when the new key carries no issuer certificate", async () => {
            const { pinned, next } = await rotation({ pinned: expired });
            await expectConflict(keyOf(pinned), keyOf(next));
        });

        it("when the pinned key is still valid and unrevoked", async () => {
            const { issuer, pinned, next } = await rotation();
            await expectConflict(keyOf(pinned), keyOf(next, { issuerCertificate: issuer.certificate }));
        });

        it("when the issuer certificate isn't a CA", async () => {
            const { issuer, pinned, next } = await rotation({ issuer: await makeTestIssuer({ ca: false }), pinned: expired });
            await expectConflict(keyOf(pinned), keyOf(next, { issuerCertificate: issuer.certificate }));
        });

        it("when the issuer certificate doesn't parse", async () => {
            const { pinned, next } = await rotation({ pinned: expired });
            await expectConflict(keyOf(pinned), keyOf(next, { issuerCertificate: Buffer.from("not a certificate").toString("base64") }));
        });

        it("when the new key's signature doesn't verify with the issuer's key", async () => {
            const { issuer, pinned } = await rotation({ pinned: expired });
            const forger = await makeTestIssuer();
            const forged = await issueCertificate(issuer, { sanEmails: [ADDRESS], signingKey: forger.keys.privateKey });
            await expectConflict(keyOf(pinned), keyOf(forged, { issuerCertificate: issuer.certificate }));
        });

        it("when the pinned key's signature doesn't verify with the issuer's key", async () => {
            const { issuer, next } = await rotation();
            const forger = await makeTestIssuer();
            const pinned = await issueCertificate(issuer, { sanEmails: [ADDRESS], signingKey: forger.keys.privateKey, ...expired });
            await expectConflict(keyOf(pinned), keyOf(next, { issuerCertificate: issuer.certificate }));
        });

        it("when the new key names another address", async () => {
            const { issuer, pinned } = await rotation({ pinned: expired });
            const next = await issueCertificate(issuer, { sanEmails: ["someone-else@example.com"] });
            await expectConflict(keyOf(pinned), keyOf(next, { issuerCertificate: issuer.certificate }));
        });

        it("when the new key's usage doesn't fit its use type", async () => {
            const { issuer, pinned } = await rotation({ pinned: expired });
            const next = await issueCertificate(issuer, { sanEmails: [ADDRESS], keyUsage: x509.KeyUsageFlags.keyEncipherment });
            await expectConflict(keyOf(pinned), keyOf(next, { issuerCertificate: issuer.certificate }));
        });
    });

    it("Never pins a revoked key on first use.", async () => {
        const revoked = keyOf(await makeSignerCertificate({ sanEmails: [ADDRESS] }), { revokedAt: 1, revocationReason: "superseded" });

        const result = applyDiscoveredKeys(undefined, makeDiscovery([revoked]), 1000, "discovery", ADDRESS);

        expect(result.keys).toEqual([]);
        expect(result.keysFirstSeen).toBeUndefined();
    });

    it("Ignores a key that was already replaced (in previousKeys) instead of recording it as a conflict.", async () => {
        const pinned = keyOf(await makeSignerCertificate({ sanEmails: [ADDRESS] }));
        const old = keyOf(await makeSignerCertificate({ sanEmails: [ADDRESS] }));

        const result = applyDiscoveredKeys(
            { keys: [pinned], previousKeys: [{ ...old, replacedAt: 1, replacement: "automatic" }] },
            makeDiscovery([old]),
            1000,
            "discovery",
            ADDRESS,
        );

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflicts).toBeUndefined();
    });

    it("Replaces an earlier conflict of the same use type with the latest observation.", async () => {
        const pinned = await makeKey();
        const first = await makeKey();
        const second = await makeKey();

        const once = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([first]), 1000, "header", ADDRESS);
        const twice = applyDiscoveredKeys({ keys: [pinned], keyConflicts: once.keyConflicts }, makeDiscovery([second]), 2000, "discovery", ADDRESS);

        expect(twice.keyConflicts).toEqual([{ useType: "encrypt", observedKey: second, observedAt: 2000, source: "discovery" }]);
    });

    it("Doesn't record a conflict for a key the user rejected.", async () => {
        const pinned = await makeKey();
        const rejected = await makeKey();
        const rejectedKeys: RejectedKey[] = [{ useType: "encrypt", fingerprint: rejected.fingerprint, rejectedAt: 5 }];

        const result = applyDiscoveredKeys({ keys: [pinned], rejectedKeys }, makeDiscovery([rejected]), 1000, "header", ADDRESS);

        expect(result.keyConflicts).toBeUndefined();
        expect(result.rejectedKeys).toBe(rejectedKeys);
        // The same fingerprint rejected for the other use type doesn't count.
        const otherUse = applyDiscoveredKeys(
            { keys: [pinned], rejectedKeys: [{ useType: "sign", fingerprint: rejected.fingerprint, rejectedAt: 5 }] },
            makeDiscovery([rejected]),
            1000,
            "header",
            ADDRESS,
        );
        expect(otherUse.keyConflicts).toHaveLength(1);
    });

    it("addPreviousKey() keeps the newest first, at most 5 per use type, without duplicates.", async () => {
        const make = (useType: "sign" | "encrypt", n: number): PreviousKey => ({
            publicKey: "b64",
            type: "x509",
            useType,
            fingerprint: `${useType}-${n}`,
            notBefore: 0,
            notAfter: 1,
            replacedAt: n,
            replacement: "user",
        });
        const stored: PreviousKey[] = [make("sign", 5), make("encrypt", 5), make("sign", 4), make("sign", 3), make("sign", 2), make("sign", 1)];

        const result = addPreviousKey(stored, make("sign", 6));

        expect(result.map((k) => k.fingerprint)).toEqual(["sign-6", "sign-5", "encrypt-5", "sign-4", "sign-3", "sign-2"]);
        expect(result.filter((k) => k.useType === "sign")).toHaveLength(MAX_PREVIOUS_KEYS_PER_USE_TYPE);
        expect(addPreviousKey(stored, { ...make("sign", 3), replacedAt: 9 }).map((k) => k.fingerprint)).toEqual([
            "sign-3",
            "sign-5",
            "encrypt-5",
            "sign-4",
            "sign-2",
            "sign-1",
        ]);
        expect(addPreviousKey(undefined, make("encrypt", 1))).toEqual([make("encrypt", 1)]);
    });

    it("Bounds previousKeys across repeated automatic replacements.", async () => {
        const issuer = await makeTestIssuer();
        let state: ContactKeyState = { keys: [keyOf(await issueCertificate(issuer, { sanEmails: [ADDRESS], ...expired }))] };
        for (let i = 0; i < MAX_PREVIOUS_KEYS_PER_USE_TYPE + 2; i++) {
            const next = keyOf(await issueCertificate(issuer, { sanEmails: [ADDRESS] }), { issuerCertificate: issuer.certificate });
            const previousPinned = state.keys![0];
            // The pinned key is superseded by the next one.
            state = applyDiscoveredKeys(
                state,
                makeDiscovery([{ ...previousPinned, revokedAt: i + 1, revocationReason: "superseded" }, next]),
                Date.now(),
                "discovery",
                ADDRESS,
            );
            expect(state.keys).toEqual([next]);
        }
        expect(state.previousKeys).toHaveLength(MAX_PREVIOUS_KEYS_PER_USE_TYPE);
        expect(state.previousKeys!.map((k) => k.revokedAt)).toEqual([7, 6, 5, 4, 3]);
    });

    it("addRejectedKey() keeps the newest first, at most 10, without duplicates.", () => {
        const stored: RejectedKey[] = Array.from({ length: MAX_REJECTED_KEYS }, (_, i) => ({ useType: "sign" as const, fingerprint: `fp-${i}`, rejectedAt: i }));

        const added = addRejectedKey(stored, { useType: "sign", fingerprint: "new", rejectedAt: 99 });
        expect(added).toHaveLength(MAX_REJECTED_KEYS);
        expect(added[0].fingerprint).toBe("new");
        expect(added[MAX_REJECTED_KEYS - 1].fingerprint).toBe("fp-8");

        const again = addRejectedKey(stored, { useType: "sign", fingerprint: "fp-3", rejectedAt: 100 });
        expect(again).toHaveLength(MAX_REJECTED_KEYS);
        expect(again.filter((k) => k.fingerprint === "fp-3")).toEqual([{ useType: "sign", fingerprint: "fp-3", rejectedAt: 100 }]);
        expect(addRejectedKey(undefined, { useType: "encrypt", fingerprint: "x", rejectedAt: 1 })).toHaveLength(1);
    });

    it("withoutKey() and listField() helpers.", () => {
        const keys = [
            { useType: "sign" as const, fingerprint: "a" },
            { useType: "encrypt" as const, fingerprint: "a" },
        ];
        expect(withoutKey(keys, "sign", "a")).toEqual([{ useType: "encrypt", fingerprint: "a" }]);
        expect(withoutKey(undefined, "sign", "a")).toEqual([]);
        expect(listField([], undefined)).toBeUndefined();
        expect(listField([], [1])).toEqual([]);
        expect(listField([1], undefined)).toEqual([1]);
    });

    it("Migrates stored conflicts on read: drops a legacy single keyConflict and malformed entries, keeping the latest per use type.", async () => {
        const pinned = await makeKey();
        const olderSign: KeyConflict = { useType: "sign", observedKey: { ...(await makeKey()), useType: "sign" }, observedAt: 10, source: "header" };
        const newerSign: KeyConflict = { ...olderSign, observedAt: 20, source: "discovery" };
        const encrypt: KeyConflict = { useType: "encrypt", observedKey: await makeKey(), observedAt: 5, source: "discovery" };
        const legacy = { observedFingerprint: "legacy-fp", observedAt: 1, source: "header" };
        const stored: any[] = [
            null,
            "junk",
            legacy,
            { ...encrypt, useType: "other" },
            { ...encrypt, observedKey: "not-an-object" },
            { ...encrypt, observedKey: { ...encrypt.observedKey, useType: "sign" } },
            { ...encrypt, observedKey: { ...encrypt.observedKey, publicKey: 1 } },
            { ...encrypt, observedKey: { ...encrypt.observedKey, fingerprint: undefined } },
            { ...encrypt, observedAt: "1" },
            { ...encrypt, observedAt: Infinity },
            { ...encrypt, source: "mdn" },
            newerSign,
            olderSign,
            encrypt,
        ];

        expect(normalizeKeyConflicts(stored)).toEqual([newerSign, encrypt]);
        expect(normalizeKeyConflicts({ not: "an array" })).toEqual([]);

        // A contact that still carries the former single `keyConflict` (read from an old row) loses it on any merge.
        const existing = { keys: [pinned], keyConflict: legacy, keyConflicts: [legacy] } as unknown as ContactKeyState;
        const untouched = applyDiscoveredKeys(existing, undefined, 1000, "header", ADDRESS);
        expect(untouched.keyConflicts).toEqual([]);
        expect(untouched).not.toHaveProperty("keyConflict");

        // The next observation of the differing key records a complete conflict that can be accepted.
        const observed = await makeKey();
        const recorded = applyDiscoveredKeys(existing, makeDiscovery([observed]), 2000, "header", ADDRESS);
        expect(recorded.keyConflicts).toEqual([{ useType: "encrypt", observedKey: observed, observedAt: 2000, source: "header" }]);
    });

    it("sanitizeDiscoveredKey() keeps a known revocation reason only on a revoked key.", async () => {
        const cert = await makeSignerCertificate();
        const base: PublicKey = { publicKey: cert.certificate, type: "x509", useType: "sign", fingerprint: "", notBefore: 0, notAfter: 0 };
        expect(sanitizeDiscoveredKey({ ...base, revokedAt: 1, revocationReason: "superseded" })!.revocationReason).toBe("superseded");
        expect(sanitizeDiscoveredKey({ ...base, revokedAt: 1, revocationReason: "compromised" })!.revocationReason).toBe("compromised");
        expect(sanitizeDiscoveredKey({ ...base, revokedAt: 1, revocationReason: "lost" as any })).not.toHaveProperty("revocationReason");
        expect(sanitizeDiscoveredKey({ ...base, revocationReason: "superseded" })).not.toHaveProperty("revocationReason");
    });

    it("canReplaceAutomatically() is false for an unparseable pinned certificate.", async () => {
        const { issuer, next } = await rotation();
        const observed = keyOf(next, { issuerCertificate: issuer.certificate });
        expect(canReplaceAutomatically({ ...observed, publicKey: "AAAA", fingerprint: "x", revokedAt: 1 }, observed, ADDRESS, Date.now())).toBe(false);
    });
});

describe("discoverAndMergeKeys() Tests", () => {
    let dnsResolver: DnsResolver;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        dnsResolver = { resolveTxt: vi.fn(), resolveMx: vi.fn() };
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    it("Returns undefined for an address with no domain part.", async () => {
        const result = await discoverAndMergeKeys(dnsResolver, "not-an-address", undefined);
        expect(result).toBeUndefined();
    });

    it("Rejects an address with multiple @ (or an empty local part) without any DNS lookup or fetch.", async () => {
        expect(await discoverAndMergeKeys(dnsResolver, "a@evil.example.com@victim.example.com", undefined)).toBeUndefined();
        expect(await discoverAndMergeKeys(dnsResolver, "@victim.example.com", undefined)).toBeUndefined();
        expect(dnsResolver.resolveTxt).not.toHaveBeenCalled();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("Returns undefined when the domain publishes no _rapidmx record (not a federated peer).", async () => {
        (dnsResolver.resolveTxt as any).mockRejectedValue(new Error("NXDOMAIN"));
        const result = await discoverAndMergeKeys(dnsResolver, "alice@non-participating-1.example.com", undefined);
        expect(result).toBeUndefined();
    });

    it("Returns undefined when the peer's discovery endpoint fetch fails with nothing cached.", async () => {
        (dnsResolver.resolveTxt as any).mockResolvedValue([["v=RMXv1; id=1; host=mail.participating-1.example.com;"]]);
        mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

        const result = await discoverAndMergeKeys(dnsResolver, "alice@participating-1.example.com", undefined);
        expect(result).toBeUndefined();
    });

    it("Resolves the peer, fetches its keys, and merges them via applyDiscoveredKeys().", async () => {
        (dnsResolver.resolveTxt as any).mockResolvedValue([["v=RMXv1; id=1; host=mail.participating-2.example.com;"]]);
        const remoteKey = await makeKey();
        const discovered = makeDiscovery([remoteKey], 100);
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue(discovered),
            headers: { get: () => null },
        });

        const result = await discoverAndMergeKeys(dnsResolver, "alice@participating-2.example.com", undefined, 5000);

        expect(result?.keys).toEqual([remoteKey]);
        expect(result?.keysFirstSeen).toBe(5000);
    });
});
