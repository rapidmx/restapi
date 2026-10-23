///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Shared mailboxes' zero-access keys (`specs/search.md` §3 *Shared Mailboxes*): member key wraps, their status, the ownerless
// provisioning and the rotation clean-up - run against Mongo and SQL by `test/routes/{mongo,sql}/KeyVaultRoute.test.ts`.
import { createHash, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { ACLAction } from "@rapidrest/service-core";
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { sealToCertificate } from "../../src/zeroaccess/ZeroAccessSealer.js";
import { generateTestCsr } from "../testDoubles.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface SharedZeroAccessKeySuiteContext {
    app: () => any;
    /** The mailbox route, e.g. `/mongo/mailboxes`. */
    baseUrl: string;
    tokenFor: (uid: string) => string;
    createMailbox: (data?: any) => Promise<any>;
    setAcl: (mailboxUid: string, records: { userOrRoleId: string; actions: string[] }[]) => Promise<void>;
    findMailbox: (uid: string) => Promise<any>;
    findKeyVault: (mailboxUid: string) => Promise<any>;
    updateMailbox: (uid: string, data: any) => Promise<void>;
    setEscrowWraps: (mailboxUid: string, wraps: any[]) => Promise<void>;
    /** An escrow scope whose key is the certificate `certificate` (base64 DER). */
    createEscrowScope: (certificate: string, fingerprint: string) => Promise<any>;
}

async function zeroAccessKey() {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: uuid.v4().replace(/-/g, "").slice(0, 16),
        name: "CN=za",
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        keys: keys as CryptoKeyPair,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    const der = Buffer.from(cert.rawData);
    return {
        der,
        key: { publicKey: der.toString("base64"), type: "x509", useType: "zero-access", fingerprint: createHash("sha256").update(der).digest("hex"), notBefore: 1, notAfter: 2 },
    };
}

export function sharedZeroAccessKeySuite(ctx: SharedZeroAccessKeySuiteContext): void {
    describe("shared mailbox zero-access keys", () => {
        const as = (uid: string) => "jwt " + ctx.tokenFor(uid);

        /** A user with their own mailbox and zero-access key - what their member wraps are addressed to. */
        const user = async () => {
            const uid = uuid.v4();
            const za = await zeroAccessKey();
            await ctx.createMailbox({ ownerUserUid: uid, zeroAccessKeys: [za.key] });
            return { uid, za };
        };
        const wrapFor = async (member: { uid: string; za: Awaited<ReturnType<typeof zeroAccessKey>> }, keyFingerprint?: string) => ({
            memberUserUid: member.uid,
            recipientFingerprint: member.za.key.fingerprint,
            ...(keyFingerprint ? { zeroAccessKeyFingerprint: keyFingerprint } : {}),
            cms: (await sealToCertificate(Buffer.from("pkcs8"), member.za.der)).toString("base64"),
        });

        it("provisions an ownerless mailbox's key together with its member wraps, reports pending members, and lets them fetch their own", async () => {
            const manager = await user();
            const reader = await user();
            const newcomer = await user();
            // Never signed in: no mailbox of their own, so no certificate to wrap for yet - not pending either.
            const keyless = uuid.v4();
            const shared = await ctx.createMailbox({ ownerUserUid: null });
            await ctx.setAcl(shared.uid, [
                { userOrRoleId: manager.uid, actions: [ACLAction.FULL] },
                { userOrRoleId: reader.uid, actions: [ACLAction.READ] },
                { userOrRoleId: newcomer.uid, actions: [ACLAction.READ] },
                { userOrRoleId: keyless, actions: [ACLAction.READ] },
                { userOrRoleId: "admin", actions: [ACLAction.FULL] },
            ]);

            const enrolled = await request(ctx.app())
                .post(`${ctx.baseUrl}/${shared.uid}/keyvault/shared-zero-access-key`)
                .set("Authorization", as(manager.uid))
                .send({ csr: await generateTestCsr(shared.primarySmtpAddress), wraps: [await wrapFor(manager), await wrapFor(reader)] });

            expect(enrolled.status).toBe(200);
            const active: string = enrolled.body.activeKeyFingerprint;
            expect(active).toBeTruthy();
            expect(enrolled.body).toMatchObject({ ownerless: true, role: "member", manager: true, pending: [newcomer.uid], departed: [], rotationPending: false });
            expect(enrolled.body.members.find((m: any) => m.userUid === keyless)).toEqual({ userUid: keyless, full: false, wrapped: [] });
            expect((await ctx.findMailbox(shared.uid)).zeroAccessKeys.map((k: any) => k.fingerprint)).toEqual([active]);

            const mine = await request(ctx.app()).get(`${ctx.baseUrl}/${shared.uid}/keyvault/member-wraps`).set("Authorization", as(reader.uid));
            expect(mine.body).toHaveLength(1);
            expect(mine.body[0]).toMatchObject({ memberUserUid: reader.uid, zeroAccessKeyFingerprint: active, recipientFingerprint: reader.za.key.fingerprint });

            // A reader sees the status but can't change wraps; the manager fulfils the pending grant.
            const readerStatus = await request(ctx.app()).get(`${ctx.baseUrl}/${shared.uid}/keyvault/members`).set("Authorization", as(reader.uid));
            expect(readerStatus.body).toMatchObject({ manager: false, role: "member" });
            const refused = await request(ctx.app())
                .put(`${ctx.baseUrl}/${shared.uid}/keyvault/member-wraps`)
                .set("Authorization", as(reader.uid))
                .send({ wraps: [await wrapFor(newcomer, active)] });
            expect(refused.status).toBe(403);
            const fulfilled = await request(ctx.app())
                .put(`${ctx.baseUrl}/${shared.uid}/keyvault/member-wraps`)
                .set("Authorization", as(manager.uid))
                .send({ wraps: [await wrapFor(newcomer, active)] });
            expect(fulfilled.status).toBe(200);
            expect(fulfilled.body.pending).toEqual([]);

            // Someone with no access gets nothing at all.
            const stranger = await user();
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/${shared.uid}/keyvault/members`).set("Authorization", as(stranger.uid))).status).toBe(403);
        });

        it("refuses a wrap not addressed to the member's own certificate, for a non-member, or of a key the mailbox doesn't have", async () => {
            const manager = await user();
            const other = await user();
            const outsider = await user();
            const shared = await ctx.createMailbox({ ownerUserUid: null });
            await ctx.setAcl(shared.uid, [
                { userOrRoleId: manager.uid, actions: [ACLAction.FULL] },
                { userOrRoleId: other.uid, actions: [ACLAction.READ] },
            ]);
            const enrolled = await request(ctx.app())
                .post(`${ctx.baseUrl}/${shared.uid}/keyvault/shared-zero-access-key`)
                .set("Authorization", as(manager.uid))
                .send({ csr: await generateTestCsr(shared.primarySmtpAddress), wraps: [await wrapFor(manager)] });
            const active: string = enrolled.body.activeKeyFingerprint;
            const put = async (wraps: any) =>
                (await request(ctx.app()).put(`${ctx.baseUrl}/${shared.uid}/keyvault/member-wraps`).set("Authorization", as(manager.uid)).send({ wraps })).status;

            // Sealed to someone else's certificate.
            expect(await put([{ ...(await wrapFor(other, active)), cms: (await wrapFor(manager, active)).cms }])).toBe(400);
            expect(await put([{ ...(await wrapFor(other, active)), recipientFingerprint: "nope" }])).toBe(400);
            expect(await put([await wrapFor(outsider, active)])).toBe(400);
            expect(await put([await wrapFor(other, "not-a-key")])).toBe(400);
            expect(await put([await wrapFor(other, active), await wrapFor(other, active)])).toBe(400);
            expect(await put([])).toBe(400);
            expect(await put([{ memberUserUid: 5 }])).toBe(400);

            // Provisioning: the caller's own wrap is required, and an owned mailbox gets its key from its owner.
            const noOwnWrap = await request(ctx.app())
                .post(`${ctx.baseUrl}/${shared.uid}/keyvault/shared-zero-access-key`)
                .set("Authorization", as(manager.uid))
                .send({ csr: await generateTestCsr(shared.primarySmtpAddress), wraps: [await wrapFor(other)] });
            expect(noOwnWrap.status).toBe(400);
            expect(
                (await request(ctx.app()).post(`${ctx.baseUrl}/${shared.uid}/keyvault/shared-zero-access-key`).set("Authorization", as(manager.uid)).send({})).status,
            ).toBe(400);
            const owned = await ctx.createMailbox({ ownerUserUid: manager.uid });
            const ownedEnroll = await request(ctx.app())
                .post(`${ctx.baseUrl}/${owned.uid}/keyvault/shared-zero-access-key`)
                .set("Authorization", as(manager.uid))
                .send({ csr: await generateTestCsr(owned.primarySmtpAddress), wraps: [await wrapFor(manager)] });
            expect(ownedEnroll.status).toBe(400);
            // A member with read access only can't provision.
            const byReader = await request(ctx.app())
                .post(`${ctx.baseUrl}/${shared.uid}/keyvault/shared-zero-access-key`)
                .set("Authorization", as(other.uid))
                .send({ csr: await generateTestCsr(shared.primarySmtpAddress), wraps: [await wrapFor(other)] });
            expect(byReader.status).toBe(403);
        });

        it("lets an owner wrap their mailbox's key for delegates, flags a rotation once one leaves, and clears the departed's wraps afterwards", async () => {
            const owner = await user();
            const delegate = await user();
            const ownerKey = await zeroAccessKey();
            const mailbox = await ctx.createMailbox({ ownerUserUid: owner.uid, zeroAccessKeys: [ownerKey.key] });
            await ctx.setAcl(mailbox.uid, [
                { userOrRoleId: owner.uid, actions: [ACLAction.FULL] },
                { userOrRoleId: delegate.uid, actions: [ACLAction.READ] },
            ]);

            const status = await request(ctx.app()).get(`${ctx.baseUrl}/${mailbox.uid}/keyvault/members`).set("Authorization", as(owner.uid));
            expect(status.body).toMatchObject({ ownerless: false, role: "owner", manager: true, activeKeyFingerprint: ownerKey.key.fingerprint, pending: [delegate.uid] });
            const ownerWraps = await request(ctx.app()).get(`${ctx.baseUrl}/${mailbox.uid}/keyvault/member-wraps`).set("Authorization", as(owner.uid));
            expect(ownerWraps.body).toEqual([]);

            await request(ctx.app())
                .put(`${ctx.baseUrl}/${mailbox.uid}/keyvault/member-wraps`)
                .set("Authorization", as(owner.uid))
                .send({ wraps: [await wrapFor(delegate, ownerKey.key.fingerprint)] });
            // Wrapping again replaces, never duplicates.
            const again = await request(ctx.app())
                .put(`${ctx.baseUrl}/${mailbox.uid}/keyvault/member-wraps`)
                .set("Authorization", as(owner.uid))
                .send({ wraps: [await wrapFor(delegate, ownerKey.key.fingerprint)] });
            expect(again.body.members[0].wrapped).toEqual([ownerKey.key.fingerprint]);

            // A current member's wraps can't be taken away here.
            const early = await request(ctx.app()).delete(`${ctx.baseUrl}/${mailbox.uid}/keyvault/member-wraps/${delegate.uid}`).set("Authorization", as(owner.uid));
            expect(early.status).toBe(409);

            // The delegate leaves: they still hold the active key, so it must be rotated; they read no more wraps.
            await ctx.setAcl(mailbox.uid, [{ userOrRoleId: owner.uid, actions: [ACLAction.FULL] }]);
            const after = await request(ctx.app()).get(`${ctx.baseUrl}/${mailbox.uid}/keyvault/members`).set("Authorization", as(owner.uid));
            expect(after.body).toMatchObject({ departed: [delegate.uid], rotationPending: true });
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/${mailbox.uid}/keyvault/member-wraps`).set("Authorization", as(delegate.uid))).status).toBe(403);

            const cleared = await request(ctx.app()).delete(`${ctx.baseUrl}/${mailbox.uid}/keyvault/member-wraps/${delegate.uid}`).set("Authorization", as(owner.uid));
            expect(cleared.status).toBe(200);
            expect(cleared.body).toMatchObject({ departed: [], rotationPending: false });
            expect((await ctx.findKeyVault(mailbox.uid)).memberKeyWraps).toEqual([]);
            // Nothing left to clear is not an error.
            expect((await request(ctx.app()).delete(`${ctx.baseUrl}/${mailbox.uid}/keyvault/member-wraps/${delegate.uid}`).set("Authorization", as(owner.uid))).status).toBe(200);
        });

        it("escrows an ownerless mailbox's key to its escrow scope: required when provisioning, reported while missing, and added later", async () => {
            const manager = await user();
            const reader = await user();
            const escrow = await zeroAccessKey();
            const scope = await ctx.createEscrowScope(escrow.der.toString("base64"), escrow.key.fingerprint);
            const otherScope = await ctx.createEscrowScope(escrow.der.toString("base64"), escrow.key.fingerprint);
            const shared = await ctx.createMailbox({ ownerUserUid: null, escrowScopeId: scope.uid });
            await ctx.setAcl(shared.uid, [
                { userOrRoleId: manager.uid, actions: [ACLAction.FULL] },
                { userOrRoleId: reader.uid, actions: [ACLAction.READ] },
            ]);
            const escrowCms = async () => (await sealToCertificate(Buffer.from("pkcs8"), escrow.der)).toString("base64");
            const provision = async (body: any) =>
                await request(ctx.app())
                    .post(`${ctx.baseUrl}/${shared.uid}/keyvault/shared-zero-access-key`)
                    .set("Authorization", as(manager.uid))
                    .send({ csr: await generateTestCsr(shared.primarySmtpAddress), wraps: [await wrapFor(manager)], ...body });

            // Without an escrow wrap, or with one sealed elsewhere or naming another scope, nothing is provisioned.
            expect((await provision({})).status).toBe(400);
            expect((await provision({ escrowWrap: { escrowScopeId: scope.uid, cms: (await wrapFor(manager)).cms } })).status).toBe(400);
            expect((await provision({ escrowWrap: { escrowScopeId: otherScope.uid, cms: await escrowCms() } })).status).toBe(400);
            expect((await ctx.findMailbox(shared.uid)).zeroAccessKeys ?? []).toHaveLength(0);

            const first = await provision({ escrowWrap: { escrowScopeId: scope.uid, cms: await escrowCms() } });
            expect(first.status).toBe(200);
            expect(first.body).toMatchObject({ escrowScopeId: scope.uid, escrowPending: [] });
            const firstKey: string = first.body.activeKeyFingerprint;
            const vault = await ctx.findKeyVault(shared.uid);
            expect(vault.zeroAccessEscrowWraps).toEqual([
                expect.objectContaining({ escrowScopeId: scope.uid, escrowKeyFingerprint: escrow.key.fingerprint, zeroAccessKeyFingerprint: firstKey }),
            ]);

            // Moved to another scope: the key has no copy for the new one yet.
            await ctx.updateMailbox(shared.uid, { escrowScopeId: otherScope.uid });
            const status = await request(ctx.app()).get(`${ctx.baseUrl}/${shared.uid}/keyvault/members`).set("Authorization", as(reader.uid));
            expect(status.body).toMatchObject({ escrowScopeId: otherScope.uid, escrowPending: [firstKey] });

            const put = async (uid: string, wraps: any) =>
                await request(ctx.app()).put(`${ctx.baseUrl}/${shared.uid}/keyvault/escrow-wraps`).set("Authorization", as(uid)).send({ wraps });
            expect((await put(reader.uid, [{ escrowScopeId: otherScope.uid, zeroAccessKeyFingerprint: firstKey, cms: await escrowCms() }])).status).toBe(403);
            for (const bad of [
                [],
                [{ escrowScopeId: scope.uid, zeroAccessKeyFingerprint: firstKey, cms: await escrowCms() }],
                [{ escrowScopeId: otherScope.uid, zeroAccessKeyFingerprint: "not-a-key", cms: await escrowCms() }],
                [{ escrowScopeId: otherScope.uid, zeroAccessKeyFingerprint: firstKey, cms: (await wrapFor(manager)).cms }],
                [
                    { escrowScopeId: otherScope.uid, zeroAccessKeyFingerprint: firstKey, cms: await escrowCms() },
                    { escrowScopeId: otherScope.uid, zeroAccessKeyFingerprint: firstKey, cms: await escrowCms() },
                ],
            ]) {
                expect((await put(manager.uid, bad)).status).toBe(400);
            }
            const added = await put(manager.uid, [{ escrowScopeId: otherScope.uid, zeroAccessKeyFingerprint: firstKey, cms: await escrowCms() }]);
            expect(added.status).toBe(200);
            expect(added.body.escrowPending).toEqual([]);
            // Replaced per scope and key, never duplicated; the earlier scope's copy stays.
            await put(manager.uid, [{ escrowScopeId: otherScope.uid, zeroAccessKeyFingerprint: firstKey, cms: await escrowCms() }]);
            const kept = (await ctx.findKeyVault(shared.uid)).zeroAccessEscrowWraps;
            expect(kept.map((w: any) => w.escrowScopeId)).toEqual([scope.uid, otherScope.uid]);

            // A vault already holding the most escrow wraps takes no more.
            const full = Array.from({ length: 200 }, (_, i) => ({ ...kept[0], escrowScopeId: `old-${i}` }));
            await ctx.setEscrowWraps(shared.uid, full);
            const refused = await put(manager.uid, [{ escrowScopeId: otherScope.uid, zeroAccessKeyFingerprint: firstKey, cms: await escrowCms() }]);
            expect(refused.status).toBe(400);
        });

        it("refuses escrow wraps for a mailbox with an owner or without an escrow scope, and leaves provisioning without one alone", async () => {
            const manager = await user();
            const escrow = await zeroAccessKey();
            const owned = await user();
            const ownedMailbox = await ctx.createMailbox({ ownerUserUid: owned.uid });
            const wraps = [{ escrowScopeId: "x", zeroAccessKeyFingerprint: "y", cms: (await sealToCertificate(Buffer.from("k"), escrow.der)).toString("base64") }];
            expect(
                (await request(ctx.app()).put(`${ctx.baseUrl}/${ownedMailbox.uid}/keyvault/escrow-wraps`).set("Authorization", as(owned.uid)).send({ wraps })).status,
            ).toBe(400);

            const shared = await ctx.createMailbox({ ownerUserUid: null });
            await ctx.setAcl(shared.uid, [{ userOrRoleId: manager.uid, actions: [ACLAction.FULL] }]);
            expect(
                (await request(ctx.app()).put(`${ctx.baseUrl}/${shared.uid}/keyvault/escrow-wraps`).set("Authorization", as(manager.uid)).send({ wraps })).status,
            ).toBe(409);
            // An escrow wrap sent for a mailbox without a scope is ignored.
            const enrolled = await request(ctx.app())
                .post(`${ctx.baseUrl}/${shared.uid}/keyvault/shared-zero-access-key`)
                .set("Authorization", as(manager.uid))
                .send({ csr: await generateTestCsr(shared.primarySmtpAddress), wraps: [await wrapFor(manager)], escrowWrap: wraps[0] });
            expect(enrolled.status).toBe(200);
            expect(enrolled.body.escrowPending).toEqual([]);
            expect(enrolled.body.escrowScopeId).toBeUndefined();
            expect((await ctx.findKeyVault(shared.uid)).zeroAccessEscrowWraps ?? []).toEqual([]);
        });
    });
}
