///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests - `applyDiscoveredKeys()` is pure logic, tested directly with hand-built inputs.
// `discoverAndMergeKeys()`'s own DNS/HTTP calls are stubbed the same way test/util/FederationUtils.test.ts and
// test/util/KeyDiscoveryClient.test.ts stub theirs - each test uses a unique domain/address, since both of
// those modules keep a shared module-level cache across every test in this process.
import "reflect-metadata";
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

function makeKey(overrides: Partial<PublicKey> = {}): PublicKey {
    return {
        publicKey: "placeholder",
        type: "x509",
        useType: "encrypt",
        fingerprint: "fp-1",
        notBefore: 0,
        notAfter: Date.now() + 1_000_000,
        ...overrides,
    };
}

function makeDiscovery(keys: PublicKey[], lastSeen?: number): KeyDiscoveryResponse {
    return { encryptPreference: { preferEncrypt: "mutual", lastSeen }, keys, escrow: false };
}

describe("applyDiscoveredKeys() Tests", () => {
    it("TOFU-pins the first key ever observed for a useType, with no conflict, and stamps keysFirstSeen.", () => {
        const newKey = makeKey({ fingerprint: "fp-new" });
        const result = applyDiscoveredKeys(undefined, makeDiscovery([newKey]), 1000, "discovery");

        expect(result.keys).toEqual([newKey]);
        expect(result.keyConflict).toBeUndefined();
        expect(result.keysFirstSeen).toBe(1000);
    });

    it("TOFU-pins encrypt and sign keys independently from the same discovery response.", () => {
        const encryptKey = makeKey({ useType: "encrypt", fingerprint: "fp-enc" });
        const signKey = makeKey({ useType: "sign", fingerprint: "fp-sign" });
        const result = applyDiscoveredKeys(undefined, makeDiscovery([encryptKey, signKey]), 1000, "discovery");

        expect(result.keys).toEqual([encryptKey, signKey]);
    });

    it("Is a no-op when the observed key exactly matches the pinned one.", () => {
        const pinned = makeKey({ fingerprint: "fp-same" });
        const existing: ContactKeyState = { keys: [pinned], encryptPreference: { preferEncrypt: "mutual", lastSeen: 500 } };
        const result = applyDiscoveredKeys(existing, makeDiscovery([{ ...pinned }], 500), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict).toBeUndefined();
    });

    it("Records a conflict (retaining the pinned key) when a different, still-valid key is observed.", () => {
        const pinned = makeKey({ fingerprint: "fp-pinned", notAfter: Date.now() + 1_000_000 });
        const existing: ContactKeyState = { keys: [pinned] };
        const observed = makeKey({ fingerprint: "fp-different" });

        const result = applyDiscoveredKeys(existing, makeDiscovery([observed]), 2000, "header");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict).toEqual({ observedFingerprint: "fp-different", observedAt: 2000, source: "header" });
    });

    it("Auto-replaces without a conflict when the pinned key is expired AND the new one shares its issuer.", async () => {
        const certDer = await makeCertDer("shared-issuer@example.com");
        const pinned = makeKey({ publicKey: certDer, fingerprint: "fp-old", notAfter: 500 });
        const observed = makeKey({ publicKey: certDer, fingerprint: "fp-new" });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery");

        expect(result.keys).toEqual([observed]);
        expect(result.keyConflict).toBeUndefined();
    });

    it("Auto-replaces without a conflict when the pinned key is revoked AND the new one shares its issuer.", async () => {
        const certDer = await makeCertDer("shared-issuer-2@example.com");
        const pinned = makeKey({ publicKey: certDer, fingerprint: "fp-old", notAfter: Date.now() + 1_000_000, revokedAt: 999 });
        const observed = makeKey({ publicKey: certDer, fingerprint: "fp-new" });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery");

        expect(result.keys).toEqual([observed]);
        expect(result.keyConflict).toBeUndefined();
    });

    it("Records a conflict (does not auto-replace) when the pinned key is expired but the issuers differ.", async () => {
        const pinnedCertDer = await makeCertDer("issuer-a@example.com");
        const observedCertDer = await makeCertDer("issuer-b@example.com");
        const pinned = makeKey({ publicKey: pinnedCertDer, fingerprint: "fp-old", notAfter: 500 });
        const observed = makeKey({ publicKey: observedCertDer, fingerprint: "fp-new" });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict?.observedFingerprint).toBe("fp-new");
    });

    it("Treats an unparseable pinned/observed certificate as a conflict rather than throwing.", () => {
        const pinned = makeKey({ publicKey: "not-a-real-cert", fingerprint: "fp-old", notAfter: 500 });
        const observed = makeKey({ publicKey: "also-not-a-cert", fingerprint: "fp-new" });

        const result = applyDiscoveredKeys({ keys: [pinned] }, makeDiscovery([observed]), 1000, "discovery");

        expect(result.keys).toEqual([pinned]);
        expect(result.keyConflict).toBeDefined();
    });

    it("Anti-Downgrade: a discovered of undefined leaves keys/preference/keysFirstSeen/keyConflict untouched.", () => {
        const existing: ContactKeyState = {
            keys: [makeKey()],
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

    it("Preserves an already-set keysFirstSeen rather than overwriting it on a later call.", () => {
        const existing: ContactKeyState = { keys: [makeKey({ fingerprint: "fp-1" })], keysFirstSeen: 42 };
        const result = applyDiscoveredKeys(existing, makeDiscovery([makeKey({ fingerprint: "fp-1" })]), 9999, "discovery");

        expect(result.keysFirstSeen).toBe(42);
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
        const discovered = makeDiscovery([makeKey({ fingerprint: "fp-remote" })], 100);
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue(discovered),
            headers: { get: () => null },
        });

        const result = await discoverAndMergeKeys(dnsResolver, "alice@participating-2.example.com", undefined, 5000);

        expect(result?.keys).toEqual([makeKey({ fingerprint: "fp-remote" })]);
        expect(result?.keysFirstSeen).toBe(5000);
    });
});
