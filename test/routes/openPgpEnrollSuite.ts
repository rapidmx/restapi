///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Enrolling a mailbox's OpenPGP key (`POST /:id/keyvault/keys` with `type: "openpgp"`) - run against Mongo and SQL by
// `test/routes/{mongo,sql}/KeyVaultRoute.test.ts`.
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { generateTestCsr } from "../testDoubles.js";
import { openPgpKey } from "../openPgpTestKeys.js";
import { MAX_PUBLIC_KEY_BASE64_LENGTH } from "../../src/util/KeyDiscoveryClient.js";

export interface OpenPgpEnrollSuiteContext {
    app: () => any;
    baseUrl: string;
    tokenFor: (uid: string) => string;
    createMailbox: (data?: any) => Promise<any>;
    findMailbox: (uid: string) => Promise<any>;
    findKeyVault: (mailboxUid: string) => Promise<any>;
    /** Saves "Allow OpenPGP" (`EncryptionPolicy.allowOpenPgp`); `undefined` removes the saved policy. */
    setOpenPgpAllowed: (allowed: boolean | undefined) => Promise<void>;
}

const wrappedKey = { ciphertext: "Y3Q=", nonce: "bm9uY2U=", algorithm: "AES-256-GCM" };

export function openPgpEnrollSuite(ctx: OpenPgpEnrollSuiteContext): void {
    describe("OpenPGP key enrollment", () => {
        const as = (uid: string) => "jwt " + ctx.tokenFor(uid);
        const enroll = (mailbox: any, owner: string, body: any) =>
            request(ctx.app()).post(`${ctx.baseUrl}/${mailbox.uid}/keyvault/keys`).set("Authorization", as(owner)).send(body);

        afterEach(async () => {
            await ctx.setOpenPgpAllowed(undefined);
        });

        it("enrolls a self-certified v4 or v6 key next to the S/MIME one, superseding only an earlier OpenPGP key", async () => {
            const owner = uuid.v4();
            const mailbox = await ctx.createMailbox({ ownerUserUid: owner });
            const smime = await enroll(mailbox, owner, { useType: "encrypt", csr: await generateTestCsr(mailbox.primarySmtpAddress), wrappedKey });
            expect(smime.status).toBe(200);

            const first = await openPgpKey(mailbox.primarySmtpAddress);
            const res = await enroll(mailbox, owner, { useType: "encrypt", type: "openpgp", publicKey: first.armored, wrappedKey });
            expect(res.status).toBe(200);
            const second = await openPgpKey(mailbox.primarySmtpAddress, { version: 6 });
            expect((await enroll(mailbox, owner, { useType: "encrypt", type: "openpgp", publicKey: second.base64, wrappedKey })).status).toBe(200);

            const stored = await ctx.findMailbox(mailbox.uid);
            expect(stored.keys.map((k: any) => [k.type, k.fingerprint === first.fingerprint ? "first" : k.fingerprint === second.fingerprint ? "second" : "smime", !!k.revokedAt])).toEqual([
                ["x509", "smime", false],
                ["openpgp", "first", true],
                ["openpgp", "second", false],
            ]);
            expect(stored.keys[2]).toEqual(second.key);
            const vault = await ctx.findKeyVault(mailbox.uid);
            expect(vault.wrappedKeys.map((k: any) => k.type ?? null)).toEqual([null, "openpgp", "openpgp"]);
            expect(vault.wrappedKeys[2]).toEqual({ ...wrappedKey, fingerprint: second.fingerprint, useType: "encrypt", type: "openpgp" });
        });

        it("refuses a key for another address, the wrong use type, an unknown type, and everything once OpenPGP is disallowed", async () => {
            const owner = uuid.v4();
            const mailbox = await ctx.createMailbox({ ownerUserUid: owner });
            const own = await openPgpKey(mailbox.primarySmtpAddress);
            expect((await enroll(mailbox, owner, { useType: "encrypt", type: "openpgp", publicKey: (await openPgpKey("x@elsewhere.example")).armored, wrappedKey })).status).toBe(400);
            expect((await enroll(mailbox, owner, { useType: "sign", type: "openpgp", publicKey: own.armored, wrappedKey })).status).toBe(400);
            expect((await enroll(mailbox, owner, { useType: "encrypt", type: "pgp", publicKey: own.armored, wrappedKey })).status).toBe(400);
            expect((await enroll(mailbox, owner, { useType: "encrypt", type: "openpgp", wrappedKey })).status).toBe(400);

            await ctx.setOpenPgpAllowed(false);
            const refused = await enroll(mailbox, owner, { useType: "encrypt", type: "openpgp", publicKey: own.armored, wrappedKey });
            expect(refused.status).toBe(403);
            expect((await ctx.findMailbox(mailbox.uid)).keys ?? []).toEqual([]);
        });

        it("refuses a key too large for a peer to accept from discovery, which would hide the mailbox's other keys (round 7, #708)", async () => {
            const owner = uuid.v4();
            const mailbox = await ctx.createMailbox({ ownerUserUid: owner });
            const aliases: string[] = Array.from({ length: 40 }, (_unused, i) => `alias-${i}-${"x".repeat(40)}@example.org`);
            const large = await openPgpKey(mailbox.primarySmtpAddress, { aliases });
            expect(large.base64.length).toBeGreaterThan(MAX_PUBLIC_KEY_BASE64_LENGTH);

            const refused = await enroll(mailbox, owner, { useType: "encrypt", type: "openpgp", publicKey: large.armored, wrappedKey });

            expect(refused.status).toBe(400);
            expect(refused.body.message).toContain("too large");
            expect((await ctx.findMailbox(mailbox.uid)).keys ?? []).toEqual([]);
        });
    });
}
