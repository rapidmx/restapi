///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Round-5 review fixes for the key vault, identical on both backends: enrollment ids bound to their mailbox, rotation
// refused while a signing enrollment holds a wrapped key, escrow wraps replaced (not piled up) on rotation, and bootstrap
// master-key wraps refused on an already set-up vault. `test/routes/{mongo,sql}/KeyVaultRoute.SignEnrollmentAutomated.test.ts`
// register `FakeAutomatedEnrollment` and supply a started server and raw row helpers.
import * as x509 from "@peculiar/x509";
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import type { EnrollmentBinding, EnrollmentResult, SigningCertificateEnrollment } from "../../src/pki/SigningCertificateEnrollment.js";

x509.cryptoProvider.set(crypto);

interface FakeEnrollment {
    identity: string;
    csr: string;
    status: "pending" | "issued" | "failed";
    wrappedKey?: any;
    binding?: { mailboxUid: string; masterKeyGeneration: number };
    error?: string;
    installed?: boolean;
}

/** A minimal, in-memory automated `SigningCertificateEnrollment` with every optional method `BaseKeyVaultRoute` uses. */
export class FakeAutomatedEnrollment implements SigningCertificateEnrollment {
    public readonly name = "fake-automated";
    public static enrollments = new Map<string, FakeEnrollment>();

    public async startEnrollment(identity: string, csr: string): Promise<{ enrollmentId: string }> {
        const enrollmentId = uuid.v4();
        FakeAutomatedEnrollment.enrollments.set(enrollmentId, { identity, csr, status: "pending" });
        return { enrollmentId };
    }

    private require(enrollmentId: string): FakeEnrollment {
        const enrollment = FakeAutomatedEnrollment.enrollments.get(enrollmentId);
        if (!enrollment) {
            throw new Error("not found");
        }
        return enrollment;
    }

    public async checkStatus(enrollmentId: string): Promise<EnrollmentResult> {
        const enrollment = this.require(enrollmentId);
        return { status: enrollment.status, certificate: undefined, error: enrollment.error };
    }

    public async attachWrappedKey(enrollmentId: string, wrappedKey: any, binding?: { mailboxUid: string; masterKeyGeneration: number }): Promise<void> {
        const enrollment = this.require(enrollmentId);
        enrollment.wrappedKey = wrappedKey;
        enrollment.binding = binding;
    }

    public async describeEnrollment(enrollmentId: string): Promise<EnrollmentBinding> {
        const enrollment = this.require(enrollmentId);
        return { identity: enrollment.identity, mailboxUid: enrollment.binding?.mailboxUid };
    }

    public async listPendingEnrollments(): Promise<any[]> {
        return [...FakeAutomatedEnrollment.enrollments.entries()]
            .filter(([, e]) => e.status === "pending" || (e.status === "issued" && !e.installed))
            .map(([enrollmentId, e]) => ({ enrollmentId, identity: e.identity, status: e.status, mailboxUid: e.binding?.mailboxUid, hasWrappedKey: !!e.wrappedKey }));
    }

    public async cancelEnrollment(enrollmentId: string, reason: string): Promise<void> {
        const enrollment = this.require(enrollmentId);
        if (enrollment.status === "pending" || (enrollment.status === "issued" && !enrollment.installed)) {
            enrollment.status = "failed";
            enrollment.error = reason;
        }
    }
}

async function generateSelfSignedCert(identity: string): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: `CN=${identity}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions: [new x509.SubjectAlternativeNameExtension([{ type: "email", value: identity }])],
    });
    return cert.toString("pem");
}

export interface KeyVaultRound5SuiteContext {
    app: () => any;
    /** e.g. `/mongo/mailboxes`. */
    baseUrl: string;
    tokenFor: (user: any) => string;
    /** A mailbox owned by `ownerUid` with a FULL owner ACL record. */
    createMailbox: (ownerUid: string) => Promise<any>;
    createEscrowScope: () => Promise<any>;
    deleteEscrowScope: (uid: string) => Promise<void>;
    /** Sets `Mailbox.escrowScopeId` directly (`null` unassigns). */
    setEscrowScope: (mailboxUid: string, escrowScopeId: string | null) => Promise<void>;
    /** The stored `KeyVault` row. */
    findKeyVault: (mailboxUid: string) => Promise<any | undefined>;
    generateCsr: (identity: string) => Promise<string>;
}

export function keyVaultRound5Suite(ctx: KeyVaultRound5SuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const other: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const auth = (req: any, user: any) => req.set("Authorization", "jwt " + ctx.tokenFor(user));
    const wrappedKey = { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" };
    const wrap = (method: string, fields: Record<string, any> = {}) => ({
        method,
        ciphertext: `mk-${uuid.v4()}`,
        nonce: "n",
        salt: "s",
        kdf: "argon2id",
        schemeVersion: 1,
        createdAt: Date.now(),
        ...fields,
    });

    /** Enrolls a signing key with `masterKeyWraps` and returns the mailbox's published key. */
    const setUpVault = async (mailbox: any, masterKeyWraps: any[]) => {
        const enrolled = await auth(request(ctx.app()).post(`${ctx.baseUrl}/${mailbox.uid}/keyvault/keys`), owner).send({
            useType: "sign",
            certificate: await generateSelfSignedCert(mailbox.primarySmtpAddress),
            wrappedKey,
            masterKeyWraps,
        });
        expect(enrolled.status).toBe(200);
        const published = await auth(request(ctx.app()).get(`${ctx.baseUrl}/${mailbox.uid}`), owner);
        return { key: published.body.keys[0], vault: enrolled.body };
    };
    const rekey = (mailbox: any, key: any, masterKeyWraps: any[]) =>
        auth(request(ctx.app()).put(`${ctx.baseUrl}/${mailbox.uid}/keyvault/rekey`), owner).send({
            keys: [key],
            wrappedKeys: [{ ...wrappedKey, ciphertext: `rewrapped-${uuid.v4()}`, fingerprint: key.fingerprint, useType: "sign" }],
            masterKeyWraps,
        });
    const startSignEnrollment = async (mailbox: any, user: any = owner) =>
        auth(request(ctx.app()).post(`${ctx.baseUrl}/${mailbox.uid}/keyvault/keys/sign-enrollment`), user).send({
            csr: await ctx.generateCsr(mailbox.primarySmtpAddress),
            wrappedKey,
        });
    const enrollmentUrl = (mailbox: any, enrollmentId: string) => `${ctx.baseUrl}/${mailbox.uid}/keyvault/keys/sign-enrollment/${enrollmentId}`;

    describe("round 5", () => {
        it("binds an enrollment id to its mailbox: another mailbox's id is a 404, even for the same owner (finding 6)", async () => {
            const mine = await ctx.createMailbox(owner.uid);
            const mySecond = await ctx.createMailbox(owner.uid);
            const theirs = await ctx.createMailbox(other.uid);
            const started = await startSignEnrollment(mine);
            expect(started.status).toBe(200);
            const { enrollmentId } = started.body;
            expect(FakeAutomatedEnrollment.enrollments.get(enrollmentId)?.binding).toEqual({ mailboxUid: mine.uid, masterKeyGeneration: 0 });

            expect((await auth(request(ctx.app()).get(enrollmentUrl(mine, enrollmentId)), owner)).status).toBe(200);
            expect((await auth(request(ctx.app()).get(enrollmentUrl(mySecond, enrollmentId)), owner)).status).toBe(404);
            expect((await auth(request(ctx.app()).get(enrollmentUrl(theirs, enrollmentId)), other)).status).toBe(404);
            expect((await auth(request(ctx.app()).get(enrollmentUrl(theirs, uuid.v4())), other)).status).toBe(404);
            expect((await auth(request(ctx.app()).delete(enrollmentUrl(theirs, enrollmentId)), other)).status).toBe(404);
            expect(FakeAutomatedEnrollment.enrollments.get(enrollmentId)?.status).toBe("pending");

            // An enrollment with no recorded mailbox (started before binding existed) is matched by address.
            const legacyId = uuid.v4();
            FakeAutomatedEnrollment.enrollments.set(legacyId, { identity: mine.primarySmtpAddress.toUpperCase(), csr: "", status: "pending" });
            expect((await auth(request(ctx.app()).get(enrollmentUrl(mine, legacyId)), owner)).status).toBe(200);
            expect((await auth(request(ctx.app()).get(enrollmentUrl(mySecond, legacyId)), owner)).status).toBe(404);
        });

        it("refuses to rotate keys (409) while a signing enrollment holds a wrapped key, until the owner cancels it; the rotation moves the master-key generation on (finding 4)", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            const { key } = await setUpVault(mailbox, [wrap("password")]);
            const started = await startSignEnrollment(mailbox);
            const { enrollmentId } = started.body;

            const blocked = await rekey(mailbox, key, [wrap("password")]);
            expect(blocked.status).toBe(409);
            expect(blocked.body.message).toMatch(/signing certificate enrollment for this mailbox is still in progress/);
            // Another mailbox's enrollment doesn't block it.
            const unrelated = await ctx.createMailbox(other.uid);
            FakeAutomatedEnrollment.enrollments.set(uuid.v4(), {
                identity: unrelated.primarySmtpAddress,
                csr: "",
                status: "issued",
                wrappedKey,
                binding: { mailboxUid: unrelated.uid, masterKeyGeneration: 0 },
            });

            // Only the owner may cancel.
            expect((await auth(request(ctx.app()).delete(enrollmentUrl(mailbox, enrollmentId)), other)).status).toBe(403);
            const cancelled = await auth(request(ctx.app()).delete(enrollmentUrl(mailbox, enrollmentId)), owner);
            expect(cancelled.status).toBe(200);
            expect(cancelled.body.status).toBe("failed");

            const rotated = await rekey(mailbox, key, [wrap("password")]);
            expect(rotated.status).toBe(200);
            expect((await ctx.findKeyVault(mailbox.uid))?.masterKeyGeneration).toBe(1);

            // An enrollment started now records the new generation.
            const next = await startSignEnrollment(mailbox);
            expect(FakeAutomatedEnrollment.enrollments.get(next.body.enrollmentId)?.binding).toEqual({ mailboxUid: mailbox.uid, masterKeyGeneration: 1 });
        });

        it("replaces escrow wraps on rotation: a replacement is required while escrowed, and stale ones are dropped (refinement B)", async () => {
            const scope = await ctx.createEscrowScope();
            const mailbox = await ctx.createMailbox(owner.uid);
            await ctx.setEscrowScope(mailbox.uid, scope.uid);
            const { key, vault } = await setUpVault(mailbox, [wrap("password"), wrap("escrow", { escrowScopeId: scope.uid })]);
            expect(vault.masterKeyWraps.map((w: any) => w.method)).toEqual(["password", "escrow"]);

            // Escrowed: dropping the escrow wrap without a replacement would strip coverage.
            const stripped = await rekey(mailbox, key, [wrap("password")]);
            expect(stripped.status).toBe(409);
            expect(stripped.body.message).toMatch(/must include a new escrow wrap/);

            // Every rotation replaces the escrow wrap, so they never pile up.
            for (let i = 0; i < 3; i++) {
                const rotated = await rekey(mailbox, key, [wrap("password"), wrap("escrow", { escrowScopeId: scope.uid })]);
                expect(rotated.status).toBe(200);
                expect(rotated.body.masterKeyWraps.map((w: any) => w.method)).toEqual(["password", "escrow"]);
            }

            // A scope that no longer exists covers nothing, so its wrap needs no replacement.
            await ctx.deleteEscrowScope(scope.uid);
            const scopeGone = await rekey(mailbox, key, [wrap("password")]);
            expect(scopeGone.status).toBe(200);
            expect(scopeGone.body.masterKeyWraps.map((w: any) => w.method)).toEqual(["password"]);

            // Once the mailbox leaves the scope, the old scope's wrap is simply dropped.
            const other2 = await ctx.createEscrowScope();
            const moved = await ctx.createMailbox(owner.uid);
            await ctx.setEscrowScope(moved.uid, other2.uid);
            const movedVault = await setUpVault(moved, [wrap("password"), wrap("escrow", { escrowScopeId: other2.uid })]);
            await ctx.setEscrowScope(moved.uid, null);
            const unscoped = await rekey(moved, movedVault.key, [wrap("password")]);
            expect(unscoped.status).toBe(200);
            expect(unscoped.body.masterKeyWraps.map((w: any) => w.method)).toEqual(["password"]);
            expect((await ctx.findKeyVault(mailbox.uid))?.masterKeyGeneration).toBe(4);
        });

        it("refuses bootstrap masterKeyWraps (409) once the vault holds wrapped keys, even with no wraps yet (finding 5)", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            const first = await auth(request(ctx.app()).post(`${ctx.baseUrl}/${mailbox.uid}/keyvault/keys`), owner).send({
                useType: "sign",
                certificate: await generateSelfSignedCert(mailbox.primarySmtpAddress),
                wrappedKey,
            });
            expect(first.status).toBe(200);
            expect(first.body.masterKeyWraps).toEqual([]);

            const second = await auth(request(ctx.app()).post(`${ctx.baseUrl}/${mailbox.uid}/keyvault/keys`), owner).send({
                useType: "sign",
                certificate: await generateSelfSignedCert(mailbox.primarySmtpAddress),
                wrappedKey,
                masterKeyWraps: [wrap("password")],
            });
            expect(second.status).toBe(409);
            const stored = await ctx.findKeyVault(mailbox.uid);
            expect(stored?.wrappedKeys).toHaveLength(1);
            expect(stored?.masterKeyWraps ?? []).toEqual([]);
        });

        it("two concurrent first-time setups: exactly one succeeds, and the vault is sealed under the winner's master key (finding 5)", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            const [a, b] = await Promise.all(
                ["tab-a", "tab-b"].map(async (tab) =>
                    auth(request(ctx.app()).post(`${ctx.baseUrl}/${mailbox.uid}/keyvault/keys`), owner).send({
                        useType: "sign",
                        certificate: await generateSelfSignedCert(mailbox.primarySmtpAddress),
                        wrappedKey: { ...wrappedKey, ciphertext: tab },
                        masterKeyWraps: [wrap("password", { ciphertext: tab })],
                    }),
                ),
            );
            const statuses: number[] = [a.status, b.status].sort();
            expect(statuses[0]).toBe(200);
            expect(statuses[1]).toBeGreaterThanOrEqual(400);
            const winner: string = a.status === 200 ? "tab-a" : "tab-b";
            const stored = await ctx.findKeyVault(mailbox.uid);
            expect(stored?.wrappedKeys.map((k: any) => k.ciphertext)).toEqual([winner]);
            expect(stored?.masterKeyWraps.map((w: any) => w.ciphertext)).toEqual([winner]);
        });
    });

    describe("round 6 (part B): expectedMasterKeyGeneration", () => {
        const vaultUrl = (mailbox: any, path: string = "") => `${ctx.baseUrl}/${mailbox.uid}/keyvault${path}`;

        it("reports the generation, and refuses (409) sealed material from a client that missed a rotation on every write that takes it", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            expect((await auth(request(ctx.app()).get(vaultUrl(mailbox)), owner)).body.masterKeyGeneration).toBe(0);
            // A first-time setup may state generation 0.
            const setUp = await auth(request(ctx.app()).post(vaultUrl(mailbox, "/keys")), owner).send({
                useType: "sign",
                certificate: await generateSelfSignedCert(mailbox.primarySmtpAddress),
                wrappedKey,
                masterKeyWraps: [wrap("password")],
                expectedMasterKeyGeneration: 0,
            });
            expect(setUp.status).toBe(200);
            expect(setUp.body.masterKeyGeneration).toBe(0);
            const key = (await auth(request(ctx.app()).get(`${ctx.baseUrl}/${mailbox.uid}`), owner)).body.keys[0];

            // Another device rotates: generation 1.
            const rotated = await auth(request(ctx.app()).put(vaultUrl(mailbox, "/rekey")), owner).send({
                keys: [key],
                wrappedKeys: [{ ...wrappedKey, ciphertext: "under-mk1", fingerprint: key.fingerprint, useType: "sign" }],
                masterKeyWraps: [wrap("password")],
                expectedMasterKeyGeneration: 0,
            });
            expect(rotated.status).toBe(200);
            expect(rotated.body.masterKeyGeneration).toBe(1);
            const before = await ctx.findKeyVault(mailbox.uid);

            // The stale device (still on generation 0) is refused everywhere, and nothing is written or started.
            const staleEnroll = await auth(request(ctx.app()).post(vaultUrl(mailbox, "/keys")), owner).send({
                useType: "sign",
                certificate: await generateSelfSignedCert(mailbox.primarySmtpAddress),
                wrappedKey: { ...wrappedKey, ciphertext: "under-mk0" },
                expectedMasterKeyGeneration: 0,
            });
            expect(staleEnroll.status).toBe(409);
            expect(staleEnroll.body.message).toMatch(/master key was rotated/);
            const staleStart = await auth(request(ctx.app()).post(vaultUrl(mailbox, "/keys/sign-enrollment")), owner).send({
                csr: await ctx.generateCsr(mailbox.primarySmtpAddress),
                wrappedKey,
                expectedMasterKeyGeneration: 0,
            });
            expect(staleStart.status).toBe(409);
            expect(FakeAutomatedEnrollment.enrollments.size).toBe(0);
            const staleWrap = await auth(request(ctx.app()).post(vaultUrl(mailbox, "/wraps")), owner).send({ ...wrap("passkey"), expectedMasterKeyGeneration: 0 });
            expect(staleWrap.status).toBe(409);
            const staleRekey = await auth(request(ctx.app()).put(vaultUrl(mailbox, "/rekey")), owner).send({
                keys: [key],
                wrappedKeys: [{ ...wrappedKey, ciphertext: "stale", fingerprint: key.fingerprint, useType: "sign" }],
                masterKeyWraps: [wrap("password")],
                expectedMasterKeyGeneration: 0,
            });
            expect(staleRekey.status).toBe(409);
            const after = await ctx.findKeyVault(mailbox.uid);
            expect(after?.version).toBe(before?.version);
            expect(after?.wrappedKeys.map((k: any) => k.ciphertext)).toEqual(["under-mk1"]);
            expect(after?.masterKeyGeneration).toBe(1);

            // The current generation is accepted; the wrap is stored without the field; an enrollment records it.
            const addedWrap = await auth(request(ctx.app()).post(vaultUrl(mailbox, "/wraps")), owner).send({ ...wrap("passkey", { methodId: "pk-1" }), expectedMasterKeyGeneration: 1 });
            expect(addedWrap.status).toBe(200);
            expect(addedWrap.body.masterKeyGeneration).toBe(1);
            expect(addedWrap.body.masterKeyWraps[1]).not.toHaveProperty("expectedMasterKeyGeneration");
            expect((await ctx.findKeyVault(mailbox.uid))?.masterKeyWraps[1]).not.toHaveProperty("expectedMasterKeyGeneration");
            const started = await auth(request(ctx.app()).post(vaultUrl(mailbox, "/keys/sign-enrollment")), owner).send({
                csr: await ctx.generateCsr(mailbox.primarySmtpAddress),
                wrappedKey,
                expectedMasterKeyGeneration: 1,
            });
            expect(started.status).toBe(200);
            expect(FakeAutomatedEnrollment.enrollments.get(started.body.enrollmentId)?.binding).toEqual({ mailboxUid: mailbox.uid, masterKeyGeneration: 1 });
            await auth(request(ctx.app()).delete(enrollmentUrl(mailbox, started.body.enrollmentId)), owner);
            const enrolled = await auth(request(ctx.app()).post(vaultUrl(mailbox, "/keys")), owner).send({
                useType: "sign",
                certificate: await generateSelfSignedCert(mailbox.primarySmtpAddress),
                wrappedKey: { ...wrappedKey, ciphertext: "also-under-mk1" },
                expectedMasterKeyGeneration: 1,
            });
            expect(enrolled.status).toBe(200);
            expect(enrolled.body.wrappedKeys.map((k: any) => k.ciphertext)).toEqual(["under-mk1", "also-under-mk1"]);

            // Omitted, older clients keep working.
            const legacy = await auth(request(ctx.app()).post(vaultUrl(mailbox, "/wraps")), owner).send(wrap("recovery"));
            expect(legacy.status).toBe(200);
        });

        it("rejects a malformed expectedMasterKeyGeneration (400), and treats null as not given", async () => {
            const mailbox = await ctx.createMailbox(owner.uid);
            for (const bad of [-1, 1.5, "0", true]) {
                const result = await auth(request(ctx.app()).post(vaultUrl(mailbox, "/keys/sign-enrollment")), owner).send({
                    csr: await ctx.generateCsr(mailbox.primarySmtpAddress),
                    wrappedKey,
                    expectedMasterKeyGeneration: bad,
                });
                expect(result.status).toBe(400);
                expect(result.body.message).toMatch(/expectedMasterKeyGeneration must be a non-negative integer/);
            }
            // `null` counts as not given.
            expect(
                (
                    await auth(request(ctx.app()).post(vaultUrl(mailbox, "/keys/sign-enrollment")), owner).send({
                        csr: await ctx.generateCsr(mailbox.primarySmtpAddress),
                        wrappedKey,
                        expectedMasterKeyGeneration: null,
                    })
                ).status,
            ).toBe(200);
        });
    });
}
