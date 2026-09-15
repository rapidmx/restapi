///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Key rotation continuity (publishing side), identical on both backends: the issuing CA's certificate is captured on
// every install path and published through discovery as `PublicKey.issuerCertificate`, and installing a new key marks
// the older keys of its `useType` revoked. `test/routes/{mongo,sql}/KeyRotationContinuity.test.ts` register
// `ChainingTestCertificateAuthority` and supply a started server and raw row helpers.
import "reflect-metadata";
import * as nodeCrypto from "crypto";
import * as x509 from "@peculiar/x509";
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import type { EncryptionCertificateAuthority, IssuedCertificate } from "../../src/pki/EncryptionCertificateAuthority.js";

x509.cryptoProvider.set(crypto);

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" };
const SIGNING_ALGORITHM = { name: "ECDSA", hash: "SHA-256" };
const DAY = 24 * 60 * 60 * 1000;

export interface TestCa {
    keys: CryptoKeyPair;
    cert: x509.X509Certificate;
    pem: string;
    /** Base64 DER - what `PublicKey.issuerCertificate` holds. */
    der: string;
}

export async function makeTestCa(name: string = "CN=Rotation Test CA"): Promise<TestCa> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name,
        notBefore: new Date(Date.now() - DAY),
        notAfter: new Date(Date.now() + 3650 * DAY),
        keys,
        signingAlgorithm: SIGNING_ALGORITHM,
        extensions: [
            new x509.BasicConstraintsExtension(true, undefined, true),
            new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
        ],
    });
    return { keys, cert, pem: cert.toString("pem"), der: Buffer.from(cert.rawData).toString("base64") };
}

/** A leaf for `identity` (SAN email) signed by `ca`, for the public key `publicKey` (a fresh key pair when omitted). */
export async function issueTestLeaf(ca: TestCa, identity: string, publicKey?: CryptoKey): Promise<string> {
    const subjectKey: CryptoKey = publicKey ?? (await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])).publicKey;
    const leaf = await x509.X509CertificateGenerator.create({
        subject: [{ CN: [identity] }],
        issuer: ca.cert.subjectName,
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 365 * DAY),
        publicKey: subjectKey,
        signingKey: ca.keys.privateKey,
        signingAlgorithm: SIGNING_ALGORITHM,
        extensions: [new x509.SubjectAlternativeNameExtension([{ type: "email", value: identity }])],
    });
    return leaf.toString("pem");
}

/**
 * An `EncryptionCertificateAuthority` whose issuer is controllable: `mode` `"good"` returns the real issuing CA,
 * `"impostor"` a CA with the same subject but a different key (so the issuer name matches but the signature doesn't),
 * `"none"` no issuer, and `"fail"` throws.
 */
export class ChainingTestCertificateAuthority implements EncryptionCertificateAuthority {
    public readonly name = "chaining-test";
    public static mode: "good" | "impostor" | "none" | "fail" = "good";
    public static ca?: TestCa;
    public static impostor?: TestCa;

    public static async reset(): Promise<void> {
        ChainingTestCertificateAuthority.mode = "good";
        ChainingTestCertificateAuthority.ca ??= await makeTestCa();
        ChainingTestCertificateAuthority.impostor ??= await makeTestCa();
    }

    public async issue(identity: string, csr: string): Promise<IssuedCertificate> {
        const { mode, ca, impostor } = ChainingTestCertificateAuthority;
        if (mode === "fail") {
            throw new Error("simulated CA outage");
        }
        const parsedCsr = new x509.Pkcs10CertificateRequest(csr);
        const pem: string = await issueTestLeaf(ca!, identity, await parsedCsr.publicKey.export());
        const cert = new nodeCrypto.X509Certificate(pem);
        return {
            certificate: pem,
            fingerprint: cert.fingerprint256.replace(/:/g, "").toLowerCase(),
            notBefore: new Date(cert.validFrom),
            notAfter: new Date(cert.validTo),
            ...(mode === "good" ? { issuerCertificate: ca!.pem } : mode === "impostor" ? { issuerCertificate: impostor!.pem } : {}),
        };
    }

    public async revoke(_fingerprint: string): Promise<void> {
        // Nothing to do.
    }
}

export interface KeyRotationContinuitySuiteContext {
    app: () => any;
    /** e.g. `/mongo/mailboxes`. */
    baseUrl: string;
    /** e.g. `/mongo/.well-known/rapidmx/keys`. */
    discoveryUrl: string;
    tokenFor: (user: any) => string;
    /** A mailbox at `@example.com` owned by `ownerUid`, with a FULL owner ACL record and its `keyDiscoveryHash` set. */
    createMailbox: (ownerUid: string) => Promise<any>;
    findMailbox: (uid: string) => Promise<any>;
    /** Replaces `Mailbox.keys` directly. */
    setMailboxKeys: (uid: string, keys: any[]) => Promise<void>;
    findKeyVault: (mailboxUid: string) => Promise<any | undefined>;
    generateCsr: (identity: string) => Promise<string>;
}

export function keyRotationContinuitySuite(ctx: KeyRotationContinuitySuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const auth = (req: any) => req.set("Authorization", "jwt " + ctx.tokenFor(owner));
    const wrappedKey = () => ({ ciphertext: `ct-${uuid.v4()}`, nonce: "n", algorithm: "AES-256-GCM" });
    const passwordWrap = () => ({ method: "password", ciphertext: `mk-${uuid.v4()}`, nonce: "n", salt: "s", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() });

    const enroll = (mailbox: any, body: Record<string, any>) =>
        auth(request(ctx.app()).post(`${ctx.baseUrl}/${mailbox.uid}/keyvault/keys`)).send({ wrappedKey: wrappedKey(), ...body });
    const enrollEncrypt = async (mailbox: any, first: boolean = false) =>
        enroll(mailbox, { useType: "encrypt", csr: await ctx.generateCsr(mailbox.primarySmtpAddress), ...(first ? { masterKeyWraps: [passwordWrap()] } : {}) });
    const discover = (mailbox: any) => request(ctx.app()).get(`${ctx.discoveryUrl}/${mailbox.keyDiscoveryHash}?domain=example.com`);
    const keysOf = async (mailbox: any): Promise<any[]> => (await ctx.findMailbox(mailbox.uid))?.keys ?? [];

    beforeEach(async () => {
        await ChainingTestCertificateAuthority.reset();
    });

    describe("key rotation continuity (publishing side)", () => {
        it("publishes the issuing CA's certificate (base64 DER) on an enrolled encryption key and through discovery", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            const enrolled = await enrollEncrypt(mailbox, true);
            expect(enrolled.status).toBe(200);

            const [key] = await keysOf(mailbox);
            expect(key.issuerCertificate).toBe(ChainingTestCertificateAuthority.ca!.der);
            const leaf = new nodeCrypto.X509Certificate(Buffer.from(key.publicKey, "base64"));
            expect(leaf.verify(new nodeCrypto.X509Certificate(Buffer.from(key.issuerCertificate, "base64")).publicKey)).toBe(true);

            const discovered = await discover(mailbox);
            expect(discovered.status).toBe(200);
            expect(discovered.body.keys).toHaveLength(1);
            expect(discovered.body.keys[0].issuerCertificate).toBe(ChainingTestCertificateAuthority.ca!.der);
        });

        it("drops (never refuses) an issuer from the CA that didn't sign the certificate, or none at all", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            ChainingTestCertificateAuthority.mode = "impostor";
            expect((await enrollEncrypt(mailbox, true)).status).toBe(200);
            ChainingTestCertificateAuthority.mode = "none";
            expect((await enrollEncrypt(mailbox)).status).toBe(200);

            const keys = await keysOf(mailbox);
            expect(keys).toHaveLength(2);
            expect(keys.every((key) => key.issuerCertificate === undefined || key.issuerCertificate === null)).toBe(true);
            expect((await discover(mailbox)).body.keys.some((key: any) => "issuerCertificate" in key && key.issuerCertificate)).toBe(false);
        });

        it("revokes the previous encryption key when a new one is enrolled, keeps its wrapped private key and leaves signing keys alone", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            expect((await enrollEncrypt(mailbox, true)).status).toBe(200);
            const signCa = await makeTestCa("CN=Public Signing CA");
            const signing = await enroll(mailbox, { useType: "sign", certificate: await issueTestLeaf(signCa, mailbox.primarySmtpAddress) });
            expect(signing.status).toBe(200);

            const before = Date.now();
            expect((await enrollEncrypt(mailbox)).status).toBe(200);
            const after = Date.now();

            const keys = await keysOf(mailbox);
            expect(keys.map((key) => key.useType)).toEqual(["encrypt", "sign", "encrypt"]);
            expect(keys[0].revokedAt).toBeGreaterThanOrEqual(before);
            expect(keys[0].revokedAt).toBeLessThanOrEqual(after);
            expect(keys[0].revocationReason).toBe("superseded");
            expect(keys[1].revokedAt ?? undefined).toBeUndefined();
            expect(keys[1].revocationReason ?? undefined).toBeUndefined();
            expect(keys[2].revokedAt ?? undefined).toBeUndefined();
            expect(keys[2].revocationReason ?? undefined).toBeUndefined();
            // Old encryption private keys are retained.
            expect((await ctx.findKeyVault(mailbox.uid))?.wrappedKeys).toHaveLength(3);

            const discovered = (await discover(mailbox)).body.keys;
            expect(discovered[0].revokedAt).toBe(keys[0].revokedAt);
            expect(discovered[0].revocationReason).toBe("superseded");
            expect(discovered[2].revokedAt ?? undefined).toBeUndefined();
            // Both encryption keys share the issuing CA a peer can compare.
            expect(discovered[0].issuerCertificate).toBe(discovered[2].issuerCertificate);
        });

        it("revokes nothing when an enrollment fails: CA outage, stale master key generation, active fingerprint collision, wrong identity", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            expect((await enrollEncrypt(mailbox, true)).status).toBe(200);
            const signCa = await makeTestCa("CN=Public Signing CA");
            const signingPem = await issueTestLeaf(signCa, mailbox.primarySmtpAddress);
            expect((await enroll(mailbox, { useType: "sign", certificate: signingPem })).status).toBe(200);

            ChainingTestCertificateAuthority.mode = "fail";
            expect((await enrollEncrypt(mailbox)).status).toBeGreaterThanOrEqual(500);
            ChainingTestCertificateAuthority.mode = "good";
            const stale = await enroll(mailbox, { useType: "encrypt", csr: await ctx.generateCsr(mailbox.primarySmtpAddress), expectedMasterKeyGeneration: 7 });
            expect(stale.status).toBe(409);
            expect((await enroll(mailbox, { useType: "sign", certificate: signingPem })).status).toBe(400);
            expect((await enroll(mailbox, { useType: "sign", certificate: await issueTestLeaf(signCa, "someone-else@example.com") })).status).toBe(400);

            const keys = await keysOf(mailbox);
            expect(keys).toHaveLength(2);
            expect(keys.every((key) => !key.revokedAt)).toBe(true);
        });

        it("installs a PEM chain's leaf with its verified issuer, revoking the previous signing key", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            const signCa = await makeTestCa("CN=Public Signing CA");
            const first = await enroll(mailbox, {
                useType: "sign",
                certificate: `${await issueTestLeaf(signCa, mailbox.primarySmtpAddress)}\n${signCa.pem}`,
                masterKeyWraps: [passwordWrap()],
            });
            expect(first.status).toBe(200);
            const second = await enroll(mailbox, { useType: "sign", certificate: `${await issueTestLeaf(signCa, mailbox.primarySmtpAddress)}${signCa.pem}` });
            expect(second.status).toBe(200);

            const keys = await keysOf(mailbox);
            expect(keys).toHaveLength(2);
            expect(keys.map((key) => key.issuerCertificate)).toEqual([signCa.der, signCa.der]);
            expect(keys[0].revokedAt).toEqual(expect.any(Number));
            expect(keys[0].revocationReason).toBe("superseded");
            expect(keys[1].revokedAt ?? undefined).toBeUndefined();
            const discovered = (await discover(mailbox)).body.keys;
            expect(discovered.map((key: any) => key.issuerCertificate)).toEqual([signCa.der, signCa.der]);
            expect(discovered.map((key: any) => key.revocationReason ?? null)).toEqual(["superseded", null]);
        });

        it("drops a chain's second certificate when it didn't issue the leaf (other name, same name with another key, unparseable)", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            const signCa = await makeTestCa("CN=Public Signing CA");
            const otherName = await makeTestCa("CN=Somebody Else");
            const sameNameOtherKey = await makeTestCa("CN=Public Signing CA");
            const garbage = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
            let firstInstall = true;
            for (const issuerPem of [otherName.pem, sameNameOtherKey.pem, garbage]) {
                const result = await enroll(mailbox, {
                    useType: "sign",
                    certificate: `${await issueTestLeaf(signCa, mailbox.primarySmtpAddress)}\n${issuerPem}`,
                    ...(firstInstall ? { masterKeyWraps: [passwordWrap()] } : {}),
                });
                firstInstall = false;
                expect(result.status).toBe(200);
            }
            const keys = await keysOf(mailbox);
            expect(keys).toHaveLength(3);
            expect(keys.every((key) => !key.issuerCertificate)).toBe(true);
        });

        describe("rekey", () => {
            const rekey = (mailbox: any, keys: any[]) =>
                auth(request(ctx.app()).put(`${ctx.baseUrl}/${mailbox.uid}/keyvault/rekey`)).send({
                    keys,
                    wrappedKeys: keys.map((key) => ({ ...wrappedKey(), fingerprint: key.fingerprint, useType: key.useType })),
                    masterKeyWraps: [passwordWrap()],
                });
            const strip = (key: any) => {
                const { issuerCertificate: _issuer, revokedAt: _revokedAt, revocationReason: _reason, ...rest } = key;
                return rest;
            };

            it("keeps the stored issuerCertificate when the request omits it, accepts it unchanged, and refuses a different one", async () => {
                const mailbox = await ctx.createMailbox(owner.uid);
                expect((await enrollEncrypt(mailbox, true)).status).toBe(200);
                const [stored] = await keysOf(mailbox);

                expect((await rekey(mailbox, [strip(stored)])).status).toBe(200);
                expect((await keysOf(mailbox))[0].issuerCertificate).toBe(stored.issuerCertificate);
                expect((await rekey(mailbox, [{ ...strip(stored), issuerCertificate: null }])).status).toBe(200);
                expect((await rekey(mailbox, [stored])).status).toBe(200);
                expect((await keysOf(mailbox))[0].issuerCertificate).toBe(stored.issuerCertificate);

                const refused = await rekey(mailbox, [{ ...stored, issuerCertificate: ChainingTestCertificateAuthority.impostor!.der }]);
                expect(refused.status).toBe(400);
                expect(refused.body.message).toMatch(/identical fields aside from revokedAt/);
                // A key enrolled without an issuer can't gain one through rekey.
                const bare = await ctx.createMailbox(owner.uid);
                ChainingTestCertificateAuthority.mode = "none";
                expect((await enrollEncrypt(bare, true)).status).toBe(200);
                const [bareKey] = await keysOf(bare);
                expect((await rekey(bare, [{ ...strip(bareKey), issuerCertificate: ChainingTestCertificateAuthority.ca!.der }])).status).toBe(400);
                expect((await rekey(bare, [strip(bareKey)])).status).toBe(200);
            });

            it("keeps a stored revocation and its reason (escalation to compromised only), revokes as compromised by default, refuses bad values, and doesn't store extra fields", async () => {
                const mailbox = await ctx.createMailbox(owner.uid);
                expect((await enrollEncrypt(mailbox, true)).status).toBe(200);
                expect((await enrollEncrypt(mailbox)).status).toBe(200);
                const [old, current] = await keysOf(mailbox);
                expect(old.revokedAt).toEqual(expect.any(Number));

                // Sending the superseded key without its revokedAt doesn't withdraw the revocation.
                expect((await rekey(mailbox, [strip(old), { ...current, junk: "x" }])).status).toBe(200);
                let keys = await keysOf(mailbox);
                expect(keys[0].revokedAt).toBe(old.revokedAt);
                expect(keys[0].revocationReason).toBe("superseded");
                expect(keys[1].revokedAt ?? undefined).toBeUndefined();
                expect(keys[1].junk).toBeUndefined();

                expect((await rekey(mailbox, [old, { ...current, revokedAt: "soon" }])).status).toBe(400);
                expect((await rekey(mailbox, [old, { ...current, revokedAt: 12345, revocationReason: "lost" }])).status).toBe(400);
                // A reason alone doesn't revoke.
                expect((await rekey(mailbox, [old, { ...current, revocationReason: "compromised" }])).status).toBe(200);
                expect((await keysOf(mailbox))[1].revokedAt ?? undefined).toBeUndefined();
                expect((await keysOf(mailbox))[1].revocationReason ?? undefined).toBeUndefined();
                // An explicit revoke with no reason means compromised.
                expect((await rekey(mailbox, [old, { ...current, revokedAt: 12345 }])).status).toBe(200);
                keys = await keysOf(mailbox);
                expect(keys.map((key) => key.revokedAt)).toEqual([old.revokedAt, 12345]);
                expect(keys.map((key) => key.revocationReason)).toEqual(["superseded", "compromised"]);

                // Compromised can't be downgraded; superseded can be escalated.
                expect((await rekey(mailbox, [old, { ...keys[1], revocationReason: "superseded" }])).status).toBe(200);
                expect((await keysOf(mailbox))[1].revocationReason).toBe("compromised");
                expect((await rekey(mailbox, [{ ...old, revocationReason: "compromised" }, keys[1]])).status).toBe(200);
                expect((await keysOf(mailbox)).map((key) => key.revocationReason)).toEqual(["compromised", "compromised"]);

                // A request-chosen reason on a new revoke is kept.
                const other = await ctx.createMailbox(owner.uid);
                expect((await enrollEncrypt(other, true)).status).toBe(200);
                const [only] = await keysOf(other);
                expect((await rekey(other, [{ ...only, revokedAt: 777, revocationReason: "superseded" }])).status).toBe(200);
                expect((await keysOf(other))[0]).toMatchObject({ revokedAt: 777, revocationReason: "superseded" });
            });

            it("revokes the older of two unrevoked keys of a useType left by an earlier enrollment (normalization)", async () => {
                const mailbox = await ctx.createMailbox(owner.uid);
                expect((await enrollEncrypt(mailbox, true)).status).toBe(200);
                expect((await enrollEncrypt(mailbox)).status).toBe(200);
                const [old, current] = await keysOf(mailbox);
                // A mailbox enrolled before superseded keys were revoked: both unrevoked, the newer one first.
                const legacyOld = { ...strip(old), notBefore: current.notBefore - 1000, issuerCertificate: old.issuerCertificate };
                await ctx.setMailboxKeys(mailbox.uid, [current, legacyOld]);

                const before = Date.now();
                expect((await rekey(mailbox, [current, legacyOld])).status).toBe(200);
                const keys = await keysOf(mailbox);
                expect(keys[0].revokedAt ?? undefined).toBeUndefined();
                expect(keys[1].revokedAt).toBeGreaterThanOrEqual(before);
                expect(keys[1].revocationReason).toBe("superseded");
                expect((await discover(mailbox)).body.keys[1]).toMatchObject({ revokedAt: keys[1].revokedAt, revocationReason: "superseded" });
            });
        });
    });
}
