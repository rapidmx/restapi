///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `POST /:id/keys/resolve` (accepting or rejecting a changed key) and the lookup response's `keyConflicts`/`previousKeys`,
// identical on both backends. `test/routes/{mongo,sql}/KeyLookupRoute.test.ts` supply a started server and raw row helpers.
import { request } from "@rapidrest/service-core/test";
import { ACLAction } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { AuditAction, type KeyConflict, type PublicKey } from "../../src/models/types.js";
import { sanitizeDiscoveredKey } from "../../src/util/KeyringUtils.js";
import type { KeyTrustSuiteContext } from "./keyTrustSuite.js";
import { issueCertificate, makeSignerCertificate, makeTestIssuer, type SignerCertificate, x509 } from "../util/signerCertificates.js";

const DAY = 24 * 60 * 60 * 1000;

function keyOf(cert: SignerCertificate, overrides: Partial<PublicKey> = {}): PublicKey {
    return {
        ...sanitizeDiscoveredKey({ publicKey: cert.certificate, type: "x509", useType: "sign", fingerprint: "", notBefore: 0, notAfter: 0 })!,
        ...overrides,
    };
}

export function keyResolveSuite(ctx: KeyTrustSuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const other: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const viewer: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const manager: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const updater: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };

    const createMailbox = async () => {
        const mailbox = await ctx.saveMailbox(owner.uid);
        await ctx.saveAcl({
            uid: mailbox.uid,
            parentUid: "Mailbox",
            records: [
                { userOrRoleId: owner.uid, actions: [ACLAction.FULL] },
                { userOrRoleId: viewer.uid, actions: [ACLAction.READ, ACLAction.LIST, ACLAction.COUNT, ACLAction.EXISTS] },
                { userOrRoleId: manager.uid, actions: [ACLAction.FULL] },
                { userOrRoleId: updater.uid, actions: [ACLAction.READ, ACLAction.UPDATE] },
            ],
        });
        return mailbox;
    };
    /** A contact for `address` whose folder inherits the mailbox's ACL (or `folderParentUid`'s). */
    const saveContact = async (mailbox: any, address: string, fields: Record<string, any>, folderParentUid: string = mailbox.uid) => {
        const contact = await ctx.saveContact({
            mailboxUid: mailbox.uid,
            folderUid: uuid.v4(),
            displayName: address,
            emails: [{ address, type: "other" }],
            phones: [],
            addresses: [],
            ...fields,
        });
        await ctx.saveAcl({ uid: contact.folderUid, parentUid: folderParentUid, records: [] });
        return contact;
    };
    const resolve = (mailboxUid: string, body: any, user: any = owner) =>
        request(ctx.app())
            .post(`${ctx.baseUrl}/${mailboxUid}/keys/resolve`)
            .set("Authorization", "jwt " + ctx.tokenFor(user))
            .send(body);
    const lookup = (mailboxUid: string, address: string) =>
        request(ctx.app())
            .get(`${ctx.baseUrl}/${mailboxUid}/keys/lookup?addr=${encodeURIComponent(address)}`)
            .set("Authorization", "jwt " + ctx.tokenFor(owner));
    const serveDiscovery = (domain: string, keys: PublicKey[]) => {
        ctx.dnsResolver().records.set(`_rapidmx.${domain}`, [[`v=RMXv1; id=1; host=mail.${domain};`]]);
        ctx.mockFetch().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ encryptPreference: { preferEncrypt: "mutual", lastSeen: 100 }, keys, escrow: false }),
            headers: { get: () => null },
        });
    };
    const signer = (address: string, extra: Record<string, any> = {}) => makeSignerCertificate({ sanEmails: [address], ...extra });
    const conflictFor = (observedKey: PublicKey, observedAt: number = 1000): KeyConflict => ({
        useType: observedKey.useType,
        observedKey,
        observedAt,
        source: "discovery",
    });
    const fingerprintsOf = (keys: PublicKey[] | undefined) => (keys ?? []).map((key) => [key.useType, key.fingerprint]);

    describe("POST /:id/keys/resolve", () => {
        it("accepts the recorded conflict: pins it, keeps the old key in previousKeys, clears the conflict and the rejection, and audits", async () => {
            const mailbox = await createMailbox();
            const address = "alice@resolve-1.example.com";
            const pinned = keyOf(await signer(address));
            const issuer = await makeTestIssuer();
            const observed = keyOf(await issueCertificate(issuer, { sanEmails: [address] }), { issuerCertificate: issuer.certificate });
            const encryptPinned = keyOf(await signer(address), { useType: "encrypt" });
            const encryptConflict = conflictFor(keyOf(await signer(address), { useType: "encrypt" }), 900);
            const contact = await saveContact(mailbox, address, {
                keys: [encryptPinned, pinned],
                keyConflicts: [encryptConflict, conflictFor(observed)],
                rejectedKeys: [
                    { useType: "sign", fingerprint: observed.fingerprint, rejectedAt: 1 },
                    { useType: "sign", fingerprint: "other", rejectedAt: 2 },
                ],
            });

            const res = await resolve(mailbox.uid, { address, useType: "sign", action: "accept", expectedPinnedFingerprint: pinned.fingerprint });

            expect(res.status).toBe(200);
            expect(fingerprintsOf(res.body.keys)).toEqual([
                ["encrypt", encryptPinned.fingerprint],
                ["sign", observed.fingerprint],
            ]);
            // The conflict's key is pinned with the issuer certificate it was published with.
            expect(res.body.keys[1].issuerCertificate).toBe(issuer.certificate);
            expect(res.body.keyConflicts).toEqual([encryptConflict]);
            expect(res.body.previousKeys).toEqual([{ ...pinned, replacedAt: expect.any(Number), replacement: "user" }]);
            const [stored] = await ctx.findContacts(mailbox.uid);
            expect(stored.uid).toBe(contact.uid);
            expect(stored.rejectedKeys).toEqual([{ useType: "sign", fingerprint: "other", rejectedAt: 2 }]);

            const audit = await ctx.findAuditEntries(mailbox.uid);
            expect(audit).toHaveLength(1);
            expect(audit[0]).toEqual(
                expect.objectContaining({
                    action: AuditAction.CONTACT_KEY_REPLACED,
                    targetType: "Contact",
                    targetUid: contact.uid,
                    mailboxUid: mailbox.uid,
                    actorUserUid: owner.uid,
                    details: { address, useType: "sign", from: pinned.fingerprint, to: observed.fingerprint },
                }),
            );
        });

        it("accepts a given certificate for an encrypt key without a conflict, and a retry of the same certificate is a no-op", async () => {
            const mailbox = await createMailbox();
            const address = "bob@resolve-2.example.com";
            const pinned = keyOf(await signer(address), { useType: "encrypt" });
            const previous = { ...keyOf(await signer(address), { useType: "encrypt" }), replacedAt: 5, replacement: "automatic" };
            const next = await signer(address, { keyUsage: x509.KeyUsageFlags.keyAgreement });
            await saveContact(mailbox, address, { keys: [pinned], previousKeys: [previous] });

            const body = { address, useType: "encrypt", action: "accept", expectedPinnedFingerprint: pinned.fingerprint, certificate: next.certificate };
            const res = await resolve(mailbox.uid, body);

            expect(res.status).toBe(200);
            expect(fingerprintsOf(res.body.keys)).toEqual([["encrypt", next.fingerprint]]);
            expect(res.body.previousKeys.map((key: any) => [key.fingerprint, key.replacement])).toEqual([
                [pinned.fingerprint, "user"],
                [previous.fingerprint, "automatic"],
            ]);
            expect(res.body.keyConflicts).toBeUndefined();

            const again = await resolve(mailbox.uid, body);
            expect(again.status).toBe(200);
            expect(fingerprintsOf(again.body.keys)).toEqual([["encrypt", next.fingerprint]]);
            expect(await ctx.findAuditEntries(mailbox.uid)).toHaveLength(1);
        });

        it("accepting a previous key again takes it out of previousKeys", async () => {
            const mailbox = await createMailbox();
            const address = "carl@resolve-3.example.com";
            const pinned = keyOf(await signer(address));
            const oldCert = await signer(address);
            await saveContact(mailbox, address, { keys: [pinned], previousKeys: [{ ...keyOf(oldCert), replacedAt: 5, replacement: "user" }] });

            const res = await resolve(mailbox.uid, {
                address,
                useType: "sign",
                action: "accept",
                expectedPinnedFingerprint: pinned.fingerprint,
                certificate: oldCert.certificate,
            });

            expect(res.status).toBe(200);
            expect(res.body.previousKeys.map((key: any) => key.fingerprint)).toEqual([pinned.fingerprint]);
        });

        it("rejects a conflict: clears it, remembers the fingerprint, audits, and discovery doesn't record that key again", async () => {
            const mailbox = await createMailbox();
            const domain = "resolve-4.example.com";
            const address = `dana@${domain}`;
            const pinned = keyOf(await signer(address));
            const observedCert = await signer(address);
            const observed = keyOf(observedCert);
            const contact = await saveContact(mailbox, address, { keys: [pinned], keyConflicts: [conflictFor(observed)] });

            const res = await resolve(mailbox.uid, { address, useType: "sign", action: "reject", expectedPinnedFingerprint: pinned.fingerprint });

            expect(res.status).toBe(200);
            expect(fingerprintsOf(res.body.keys)).toEqual([["sign", pinned.fingerprint]]);
            expect(res.body.keyConflicts).toBeUndefined();
            let [stored] = await ctx.findContacts(mailbox.uid);
            expect(stored.rejectedKeys).toEqual([{ useType: "sign", fingerprint: observed.fingerprint, rejectedAt: expect.any(Number) }]);
            const audit = await ctx.findAuditEntries(mailbox.uid);
            expect(audit).toEqual([
                expect.objectContaining({
                    action: AuditAction.CONTACT_KEY_CONFLICT_REJECTED,
                    targetUid: contact.uid,
                    details: { address, useType: "sign", fingerprint: observed.fingerprint, pinnedFingerprint: pinned.fingerprint },
                }),
            ]);

            serveDiscovery(domain, [{ ...observed, fingerprint: "asserted" }]);
            const looked = await lookup(mailbox.uid, address);
            expect(looked.status).toBe(200);
            expect(looked.body.keyConflicts).toBeUndefined();
            [stored] = await ctx.findContacts(mailbox.uid);
            expect(stored.keys.map((key: any) => key.fingerprint)).toEqual([pinned.fingerprint]);

            // Rejected, then accepted by certificate: the rejection is lifted.
            const accepted = await resolve(mailbox.uid, {
                address,
                useType: "sign",
                action: "accept",
                expectedPinnedFingerprint: pinned.fingerprint,
                certificate: observedCert.certificate,
            });
            expect(accepted.status).toBe(200);
            [stored] = await ctx.findContacts(mailbox.uid);
            expect(stored.rejectedKeys ?? []).toEqual([]);
        });

        it("refuses 409 when the pinned key isn't the expected one, changing nothing", async () => {
            const mailbox = await createMailbox();
            const address = "erin@resolve-5.example.com";
            const pinned = keyOf(await signer(address));
            const observed = keyOf(await signer(address));
            const next = await signer(address);
            await saveContact(mailbox, address, { keys: [pinned], keyConflicts: [conflictFor(observed)] });

            for (const body of [
                { address, useType: "sign", action: "accept", expectedPinnedFingerprint: "stale" },
                { address, useType: "sign", action: "accept", expectedPinnedFingerprint: "stale", certificate: next.certificate },
                { address, useType: "sign", action: "reject", expectedPinnedFingerprint: "stale" },
            ]) {
                const res = await resolve(mailbox.uid, body);
                expect(res.status, JSON.stringify(body)).toBe(409);
            }
            const [stored] = await ctx.findContacts(mailbox.uid);
            expect(stored.keys.map((key: any) => key.fingerprint)).toEqual([pinned.fingerprint]);
            expect(stored.keyConflicts).toHaveLength(1);
            expect(await ctx.findAuditEntries(mailbox.uid)).toHaveLength(0);
        });

        it("refuses 403 for a missing mailbox (as for another user's) and 404 for a missing contact, pinned key or conflict", async () => {
            const mailbox = await createMailbox();
            const address = "frank@resolve-6.example.com";
            const pinned = keyOf(await signer(address));
            const cert = await signer(address);
            const accept = { address, useType: "sign", action: "accept", expectedPinnedFingerprint: pinned.fingerprint };
            const reject = { ...accept, action: "reject" };

            expect((await resolve(uuid.v4(), accept)).status).toBe(403);
            expect((await resolve(mailbox.uid, accept)).status).toBe(404);
            expect((await resolve(mailbox.uid, reject)).status).toBe(404);
            expect(await ctx.findContacts(mailbox.uid)).toHaveLength(0);

            // A contact with no keys at all has no pinned key to replace.
            const keyless = "frank.keyless@resolve-6.example.com";
            await saveContact(mailbox, keyless, {});
            expect((await resolve(mailbox.uid, { ...accept, address: keyless, certificate: (await signer(keyless)).certificate })).status).toBe(404);

            await saveContact(mailbox, address, { keys: [pinned] });
            // No conflict to accept or reject.
            expect((await resolve(mailbox.uid, accept)).status).toBe(404);
            expect((await resolve(mailbox.uid, reject)).status).toBe(404);
            // No pinned encrypt key to replace.
            const encryptCert = await signer(address, { keyUsage: x509.KeyUsageFlags.keyAgreement });
            expect((await resolve(mailbox.uid, { ...accept, useType: "encrypt", certificate: encryptCert.certificate })).status).toBe(404);
            expect(await ctx.findAuditEntries(mailbox.uid)).toHaveLength(0);
            // The certificate itself was fine.
            expect((await resolve(mailbox.uid, { ...accept, certificate: cert.certificate })).status).toBe(200);
        });

        it("refuses 400 for malformed bodies and invalid certificates", async () => {
            const mailbox = await createMailbox();
            const address = "gina@resolve-7.example.com";
            const pinned = keyOf(await signer(address));
            const expiredObserved = keyOf(await signer(address, { notBefore: new Date(Date.now() - 10 * DAY), notAfter: new Date(Date.now() - DAY) }));
            await saveContact(mailbox, address, { keys: [pinned], keyConflicts: [conflictFor(expiredObserved)] });
            const valid = { address, useType: "sign", action: "accept", expectedPinnedFingerprint: pinned.fingerprint };
            const cert = await signer(address);

            for (const body of [
                [],
                "text",
                { ...valid, address: undefined },
                { ...valid, address: "Gina <gina@resolve-7.example.com>" },
                { ...valid, useType: "decrypt" },
                { ...valid, action: "ignore" },
                { ...valid, expectedPinnedFingerprint: undefined },
                { ...valid, expectedPinnedFingerprint: "" },
                { ...valid, expectedPinnedFingerprint: "f".repeat(257) },
                { ...valid, action: "reject", certificate: cert.certificate },
                { ...valid, certificate: "not base64!" },
                { ...valid, certificate: "AAAA" },
                { ...valid, certificate: (await signer("someone-else@resolve-7.example.com")).certificate },
                { ...valid, certificate: (await signer(address, { keyUsage: x509.KeyUsageFlags.keyEncipherment })).certificate },
                // The recorded conflict's key has expired since it was observed.
                valid,
            ]) {
                const res = await resolve(mailbox.uid, body);
                expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400);
            }
            const [stored] = await ctx.findContacts(mailbox.uid);
            expect(stored.keys.map((key: any) => key.fingerprint)).toEqual([pinned.fingerprint]);
            expect(await ctx.findAuditEntries(mailbox.uid)).toHaveLength(0);
        });

        it("requires UPDATE on the mailbox and on the contact's folder", async () => {
            const mailbox = await createMailbox();
            const address = "hank@resolve-8.example.com";
            const pinned = keyOf(await signer(address));
            const observed = keyOf(await signer(address));
            await saveContact(mailbox, address, { keys: [pinned], keyConflicts: [conflictFor(observed)] });
            const body = { address, useType: "sign", action: "reject", expectedPinnedFingerprint: pinned.fingerprint };

            expect((await resolve(mailbox.uid, body, other)).status).toBe(403);
            expect((await resolve(mailbox.uid, body, viewer)).status).toBe(403);

            // `updater` has UPDATE on the mailbox, but this contact's folder doesn't inherit it.
            const isolated = "hank.isolated@resolve-8.example.com";
            const isolatedPinned = keyOf(await signer(isolated));
            await saveContact(mailbox, isolated, { keys: [isolatedPinned], keyConflicts: [conflictFor(keyOf(await signer(isolated)))] }, "Folder");
            expect((await resolve(mailbox.uid, { ...body, address: isolated, expectedPinnedFingerprint: isolatedPinned.fingerprint }, updater)).status).toBe(403);
            expect(await ctx.findAuditEntries(mailbox.uid)).toHaveLength(0);

            expect((await resolve(mailbox.uid, body, updater)).status).toBe(200);
            const audit = await ctx.findAuditEntries(mailbox.uid);
            expect(audit.map((entry: any) => entry.actorUserUid)).toEqual([updater.uid]);

            const managed = "hank.managed@resolve-8.example.com";
            const managedPinned = keyOf(await signer(managed));
            await saveContact(mailbox, managed, { keys: [managedPinned], keyConflicts: [conflictFor(keyOf(await signer(managed)))] });
            expect(
                (await resolve(mailbox.uid, { ...body, address: managed, action: "accept", expectedPinnedFingerprint: managedPinned.fingerprint }, manager)).status,
            ).toBe(200);
        });

        it("a resolve racing a discovery that replaces the key automatically ends with one sign key and no lost update", async () => {
            const mailbox = await createMailbox();
            const domain = "resolve-9.example.com";
            const address = `ivy@${domain}`;
            const issuer = await makeTestIssuer();
            const pinned = keyOf(await issueCertificate(issuer, { sanEmails: [address], notBefore: new Date(Date.now() - 30 * DAY), notAfter: new Date(Date.now() - DAY) }));
            const conflicting = keyOf(await signer(address));
            const rotated = keyOf(await issueCertificate(issuer, { sanEmails: [address] }), { issuerCertificate: issuer.certificate });
            await saveContact(mailbox, address, { keys: [pinned], keyConflicts: [conflictFor(conflicting)] });
            serveDiscovery(domain, [rotated]);

            const [resolved, looked] = await Promise.all([
                resolve(mailbox.uid, { address, useType: "sign", action: "accept", expectedPinnedFingerprint: pinned.fingerprint }),
                lookup(mailbox.uid, address),
            ]);

            expect(looked.status).toBe(200);
            expect([200, 409]).toContain(resolved.status);
            const contacts = await ctx.findContacts(mailbox.uid);
            expect(contacts).toHaveLength(1);
            const signKeys = contacts[0].keys.filter((key: any) => key.useType === "sign");
            expect(signKeys).toHaveLength(1);
            expect(contacts[0].previousKeys.map((key: any) => key.fingerprint)).toContain(pinned.fingerprint);
            if (resolved.status === 200) {
                // The user's choice landed first; the later discovery can't prove the rotated key against it.
                expect(signKeys[0].fingerprint).toBe(conflicting.fingerprint);
                expect(contacts[0].keyConflicts.map((c: any) => c.observedKey.fingerprint)).toEqual([rotated.fingerprint]);
            } else {
                expect(signKeys[0].fingerprint).toBe(rotated.fingerprint);
                expect(contacts[0].previousKeys[0]).toEqual(expect.objectContaining({ fingerprint: pinned.fingerprint, replacement: "automatic" }));
            }
        });

        it("lookup replaces a pinned key the peer lists as superseded automatically and returns previousKeys", async () => {
            const mailbox = await createMailbox();
            const domain = "resolve-10.example.com";
            const address = `jack@${domain}`;
            const issuer = await makeTestIssuer();
            const pinned = keyOf(await issueCertificate(issuer, { sanEmails: [address] }));
            const rotated = keyOf(await issueCertificate(issuer, { sanEmails: [address] }), { issuerCertificate: issuer.certificate });
            await saveContact(mailbox, address, { keys: [pinned] });
            serveDiscovery(domain, [{ ...pinned, revokedAt: Date.now() - 1000, revocationReason: "superseded" }, rotated]);

            const res = await lookup(mailbox.uid, address);

            expect(res.status).toBe(200);
            expect(res.body.keys).toEqual([expect.objectContaining({ fingerprint: rotated.fingerprint, issuerCertificate: issuer.certificate })]);
            expect(res.body.previousKeys).toEqual([
                expect.objectContaining({ fingerprint: pinned.fingerprint, revocationReason: "superseded", replacement: "automatic" }),
            ]);
            expect(res.body.keyConflicts).toBeUndefined();
        });
    });
}
