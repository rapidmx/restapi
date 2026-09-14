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
import { applyDiscoveredKeys, discoverAndMergeKeys, type ContactKeyState } from "../../src/util/KeyringUtils.js";
import type { DnsResolver } from "../../src/dns/DnsResolver.js";
import type { KeyDiscoveryResponse, PublicKey } from "../../src/models/types.js";

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

function makeDiscovery(keys: PublicKey[], lastSeen?: number): KeyDiscoveryResponse {
    return { encryptPreference: { preferEncrypt: "mutual", lastSeen }, keys, escrow: false };
}

describe("applyDiscoveredKeys() Tests", () => {
    it("TOFU-pins the first key ever observed for a useType, with no conflict, and stamps keysFirstSeen.", async () => {
        const newKey = await makeKey();
        const result = applyDiscoveredKeys(undefined, makeDiscovery([newKey]), 1000, "discovery");

        expect(result.keys).toEqual([newKey]);
        expect(result.keyConflict).toBeUndefined();
        expect(result.keysFirstSeen).toBe(1000);
    });

    it("TOFU-pins encrypt and sign keys independently from the same discovery response.", async () => {
        const encryptKey = await makeKey({ useType: "encrypt" });
        const signKey = await makeKey({ useType: "sign" });
        const result = applyDiscoveredKeys(undefined, makeDiscovery([encryptKey, signKey]), 1000, "discovery");

        expect(result.keys).toEqual([encryptKey, signKey]);
    });

    it("Is a no-op when the observed key exactly matches the pinned one.", async () => {
        const pinned = await makeKey();
        const existing: ContactKeyState = { keys: [pinned], encryptPreference: { preferEncrypt: "mutual", lastSeen: 500 } };
        const result = applyDiscoveredKeys(existing, makeDiscovery([{ ...pinned }], 500), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict).toBeUndefined();
    });

    it("Records a conflict (retaining the pinned key) when a different, still-valid key is observed.", async () => {
        const pinned = await makeKey({ notAfter: Date.now() + 1_000_000 });
        const existing: ContactKeyState = { keys: [pinned] };
        const observed = await makeKey();

        const result = applyDiscoveredKeys(existing, makeDiscovery([observed]), 2000, "header");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict).toEqual({ observedFingerprint: observed.fingerprint, observedAt: 2000, source: "header" });
    });

    it("Records a conflict (never auto-replaces) when the pinned key is expired, even when the new one is genuinely issued by the same CA - issuer equality can't be proven without the issuer's own certificate, which a PublicKey never carries.", async () => {
        const { first, second } = await makeCaIssuedCertPair();
        const pinned = await makeKey({ publicKey: first, notAfter: 500 });
        const observed = await makeKey({ publicKey: second });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict).toEqual({ observedFingerprint: observed.fingerprint, observedAt: 1000, source: "discovery" });
    });

    it("Records a conflict (never auto-replaces) when the pinned key is revoked and the new one shares its issuer DN.", async () => {
        const { first, second } = await makeCaIssuedCertPair();
        const pinned = await makeKey({ publicKey: first, notAfter: Date.now() + 1_000_000, revokedAt: 999 });
        const observed = await makeKey({ publicKey: second });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict?.observedFingerprint).toBe(observed.fingerprint);
    });

    it("Records a conflict (does not auto-replace) when the pinned key is expired but the issuers genuinely differ.", async () => {
        const pinnedCertDer = await makeCertDer("issuer-a@example.com");
        const observedCertDer = await makeCertDer("issuer-b@example.com");
        const pinned = await makeKey({ publicKey: pinnedCertDer, notAfter: 500 });
        const observed = await makeKey({ publicKey: observedCertDer });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict?.observedFingerprint).toBe(observed.fingerprint);
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

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict?.observedFingerprint).toBe(observed.fingerprint);
    });

    it("Records a conflict when the pinned certificate is unparseable, even though the observed one is valid - sameIssuingCa() fails closed rather than throwing.", async () => {
        const pinned = await makeKey({ publicKey: "not-a-real-cert", fingerprint: "fp-unparseable-pinned", notAfter: 500 });
        const observed = await makeKey();

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict?.observedFingerprint).toBe(observed.fingerprint);
    });

    it("Silently drops (never pins, never conflicts) a discovered key whose certificate doesn't parse at all.", async () => {
        const pinned = await makeKey();
        const existing: ContactKeyState = { keys: [pinned] };
        const unparseable: PublicKey = { publicKey: "also-not-a-cert", type: "x509", useType: "encrypt", fingerprint: "fp-whatever", notBefore: 0, notAfter: Date.now() + 1_000_000 };

        const result = applyDiscoveredKeys(existing, makeDiscovery([unparseable]), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict).toBeUndefined();
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

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([notACert]), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict).toBeUndefined();
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

        const result = applyDiscoveredKeys(undefined, makeDiscovery([badTime]), 1000, "discovery");

        expect(result.keys).toEqual([]);
    });

    it("Takes notBefore/notAfter from the certificate itself, ignoring peer-asserted values.", async () => {
        const realKey = await makeKey();
        const lying: PublicKey = { ...realKey, notBefore: 1, notAfter: 8_000_000_000_000 };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([lying]), 1000, "discovery");

        expect(result.keys).toEqual([realKey]);
        expect(result.keys![0].notAfter).not.toBe(8_000_000_000_000);
    });

    it("Treats a structurally malformed response as no response at all (no throw, nothing applied).", async () => {
        const existing: ContactKeyState = { keys: [], encryptPreference: { preferEncrypt: "mutual", lastSeen: 1 } };
        const malformed = { keys: [await makeKey()], escrow: false } as unknown as KeyDiscoveryResponse;

        const result = applyDiscoveredKeys(existing, malformed, 1000, "discovery");

        expect(result).toEqual({ ...existing, keysFirstSeen: undefined, keyConflict: undefined });
    });

    it("Silently drops a discovered key whose useType isn't 'sign'/'encrypt'.", async () => {
        const realKey = await makeKey();
        const bogus: PublicKey = { ...realKey, useType: "decode" as any };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([bogus]), 1000, "discovery");

        expect(result.keys).toEqual([]);
    });

    it("Silently drops a discovered key whose publicKey is missing/empty.", async () => {
        const realKey = await makeKey();
        const bogus: PublicKey = { ...realKey, publicKey: "" };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([bogus]), 1000, "discovery");

        expect(result.keys).toEqual([]);
    });

    it("Silently drops a discovered key whose publicKey exceeds the maximum allowed length (oversized-blob DoS guard).", async () => {
        const realKey = await makeKey();
        const bogus: PublicKey = { ...realKey, publicKey: "A".repeat(9000) };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([bogus]), 1000, "discovery");

        expect(result.keys).toEqual([]);
    });

    it("Silently drops a discovered key whose notBefore/notAfter aren't finite numbers.", async () => {
        const realKey = await makeKey();
        const bogus: PublicKey = { ...realKey, notAfter: NaN };

        const result = applyDiscoveredKeys(undefined, makeDiscovery([bogus]), 1000, "discovery");

        expect(result.keys).toEqual([]);
    });

    it("Anti-Downgrade: a discovered of undefined leaves keys/preference/keysFirstSeen/keyConflict untouched.", async () => {
        const existing: ContactKeyState = {
            keys: [await makeKey()],
            encryptPreference: { preferEncrypt: "mutual", lastSeen: 500 },
            keysFirstSeen: 100,
            keyConflict: { observedFingerprint: "x", observedAt: 1, source: "header" },
        };

        const result = applyDiscoveredKeys(existing, undefined, 9999, "header");

        expect(result).toEqual(existing);
    });

    it("Anti-Downgrade: does not apply a preference update whose lastSeen is not strictly newer than what's on file.", () => {
        const existing: ContactKeyState = { keys: [], encryptPreference: { preferEncrypt: "mutual", lastSeen: 500 } };
        const result = applyDiscoveredKeys(existing, makeDiscovery([], 500), 1000, "discovery");

        expect(result.encryptPreference).toEqual({ preferEncrypt: "mutual", lastSeen: 500 });
    });

    it("Applies a preference update whose lastSeen is strictly newer than what's on file.", () => {
        const existing: ContactKeyState = { keys: [], encryptPreference: { preferEncrypt: "mutual", lastSeen: 500 } };
        const discovered = makeDiscovery([], 600);
        discovered.encryptPreference.preferEncrypt = "nopreference";

        const result = applyDiscoveredKeys(existing, discovered, 1000, "discovery");

        expect(result.encryptPreference).toEqual({ preferEncrypt: "nopreference", lastSeen: 600 });
    });

    it("Applies the discovered preference outright when nothing was previously on file.", () => {
        const result = applyDiscoveredKeys(undefined, makeDiscovery([], 1), 1000, "discovery");
        expect(result.encryptPreference).toEqual({ preferEncrypt: "mutual", lastSeen: 1 });
    });

    it("Preserves an already-set keysFirstSeen rather than overwriting it on a later call.", async () => {
        const key = await makeKey();
        const existing: ContactKeyState = { keys: [key], keysFirstSeen: 42 };
        const result = applyDiscoveredKeys(existing, makeDiscovery([{ ...key }]), 9999, "discovery");

        expect(result.keysFirstSeen).toBe(42);
    });

    it("Caps the number of keys considered from one discovery response, ignoring anything past the limit.", async () => {
        // `MAX_DISCOVERED_KEYS` (8) - one real cert, repeated past the cap; each entry has the same `useType`,
        // so only the first ever gets pinned regardless (the useType-indexed merge caps stored state at 2
        // entries on its own) - this specifically exercises the `.slice()` bound itself running without error
        // over an oversized array, not a distinguishable stored-state difference.
        const key = await makeKey();
        const manyKeys: PublicKey[] = Array.from({ length: 50 }, () => ({ ...key }));

        const result = applyDiscoveredKeys(undefined, makeDiscovery(manyKeys), 1000, "discovery");

        expect(result.keys).toEqual([key]);
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
