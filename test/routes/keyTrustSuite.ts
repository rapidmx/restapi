///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `POST /:id/keys/trust` ("Trust this signer"), identical on both backends. `test/routes/{mongo,sql}/KeyLookupRoute.test.ts`
// supply a started server and raw row helpers.
import { request } from "@rapidrest/service-core/test";
import { ACLAction } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import type { StaticDnsResolver } from "../testDoubles.js";
import { makeSignerCertificate, x509 } from "../util/signerCertificates.js";
import { openPgpKey, reexpired, withRotatedSubkey } from "../openPgpTestKeys.js";

const DAY = 86_400_000;

export interface KeyTrustSuiteContext {
    app: () => any;
    baseUrl: string;
    tokenFor: (user: any) => string;
    /** Saves a mailbox row owned by `ownerUid` (no ACL). */
    saveMailbox: (ownerUid: string) => Promise<any>;
    saveAcl: (acl: { uid: string; parentUid: string; records: { userOrRoleId: string; actions: string[] }[] }) => Promise<void>;
    saveContact: (fields: Record<string, any>) => Promise<any>;
    findContacts: (mailboxUid: string) => Promise<any[]>;
    findAuditEntries: (mailboxUid: string) => Promise<any[]>;
    dnsResolver: () => StaticDnsResolver;
    mockFetch: () => ReturnType<typeof vi.fn>;
}

export function keyTrustSuite(ctx: KeyTrustSuiteContext): void {
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
    const trust = (mailboxUid: string, body: any, user: any = owner) =>
        request(ctx.app())
            .post(`${ctx.baseUrl}/${mailboxUid}/keys/trust`)
            .set("Authorization", "jwt " + ctx.tokenFor(user))
            .send(body);
    const signer = (address: string, extra: Record<string, any> = {}) => makeSignerCertificate({ sanEmails: [address], ...extra });
    const signKeys = (contact: any) => (contact.keys ?? []).filter((key: any) => key.useType === "sign");
    const encryptKey = (fingerprint: string) => ({
        publicKey: "b64",
        type: "x509",
        useType: "encrypt",
        fingerprint,
        notBefore: 0,
        notAfter: Date.now() + 1_000_000,
    });

    describe("POST /:id/keys/trust", () => {
        it("pins the signer on a new contact in the Contacts folder, returns the lookup shape and records an audit entry", async () => {
            const mailbox = await createMailbox();
            const address = "alice@trust-1.example.com";
            const { certificate, fingerprint } = await signer(address);

            const res = await trust(mailbox.uid, { address, certificate });

            expect(res.status).toBe(200);
            expect(res.body.keys).toEqual([expect.objectContaining({ publicKey: certificate, type: "x509", useType: "sign", fingerprint })]);
            expect(res.body.encryptPreference).toBeUndefined();
            expect(res.body.keyConflicts).toBeUndefined();
            expect(res.body.previousKeys).toBeUndefined();
            const contacts = await ctx.findContacts(mailbox.uid);
            expect(contacts).toHaveLength(1);
            expect(contacts[0].emails).toEqual([{ address, type: "other" }]);
            expect(contacts[0].keysFirstSeen).toEqual(expect.any(Number));
            expect(signKeys(contacts[0])).toHaveLength(1);
            expect(signKeys(contacts[0])[0].notAfter).toBeGreaterThan(Date.now());

            const audit = await ctx.findAuditEntries(mailbox.uid);
            expect(audit).toHaveLength(1);
            expect(audit[0]).toEqual(
                expect.objectContaining({
                    action: AuditAction.CONTACT_KEY_TRUSTED,
                    targetType: "Contact",
                    targetUid: contacts[0].uid,
                    mailboxUid: mailbox.uid,
                    actorUserUid: owner.uid,
                    details: { address, fingerprint },
                }),
            );
        });

        it("adds the sign key to an existing contact with only an encrypt key, leaving the rest alone", async () => {
            const mailbox = await createMailbox();
            const address = "bob@trust-2.example.com";
            const existing = await ctx.saveContact({
                mailboxUid: mailbox.uid,
                folderUid: uuid.v4(),
                displayName: "Bob",
                emails: [{ address, type: "work" }],
                phones: [],
                addresses: [],
                keys: [encryptKey("enc-fp")],
                encryptPreference: { preferEncrypt: "mutual", lastSeen: 7 },
                keysFirstSeen: 1234,
                keyConflicts: [{ useType: "encrypt", observedKey: encryptKey("other-enc"), observedAt: 5, source: "discovery" }],
            });
            await ctx.saveAcl({ uid: existing.folderUid, parentUid: mailbox.uid, records: [] });
            const { certificate, fingerprint } = await signer(address);

            const res = await trust(mailbox.uid, { address, certificate });

            expect(res.status).toBe(200);
            expect(res.body.keys.map((key: any) => [key.useType, key.fingerprint])).toEqual([
                ["encrypt", "enc-fp"],
                ["sign", fingerprint],
            ]);
            expect(res.body.encryptPreference).toEqual({ preferEncrypt: "mutual", lastSeen: 7 });
            expect(res.body.keyConflicts).toEqual([
                { useType: "encrypt", observedKey: expect.objectContaining({ fingerprint: "other-enc" }), observedAt: 5, source: "discovery" },
            ]);
            const contacts = await ctx.findContacts(mailbox.uid);
            expect(contacts).toHaveLength(1);
            expect(contacts[0].uid).toBe(existing.uid);
            expect(contacts[0].keysFirstSeen).toBe(1234);
            expect(contacts[0].displayName).toBe("Bob");
        });

        it("is idempotent for the same certificate (200, no second key, no second audit entry)", async () => {
            const mailbox = await createMailbox();
            const address = "carol@trust-3.example.com";
            const { certificate, fingerprint } = await signer(address);

            expect((await trust(mailbox.uid, { address, certificate })).status).toBe(200);
            const again = await trust(mailbox.uid, { address, certificate });

            expect(again.status).toBe(200);
            expect(again.body.keys).toEqual([expect.objectContaining({ useType: "sign", fingerprint })]);
            const contacts = await ctx.findContacts(mailbox.uid);
            expect(contacts).toHaveLength(1);
            expect(signKeys(contacts[0])).toHaveLength(1);
            expect(await ctx.findAuditEntries(mailbox.uid)).toHaveLength(1);
        });

        it("refuses 409 when a different signing key is already pinned, leaving it in place", async () => {
            const mailbox = await createMailbox();
            const address = "dave@trust-4.example.com";
            const first = await signer(address);
            const second = await signer(address);
            expect((await trust(mailbox.uid, { address, certificate: first.certificate })).status).toBe(200);

            const res = await trust(mailbox.uid, { address, certificate: second.certificate });

            expect(res.status).toBe(409);
            const contacts = await ctx.findContacts(mailbox.uid);
            expect(signKeys(contacts[0]).map((key: any) => key.fingerprint)).toEqual([first.fingerprint]);
            expect(await ctx.findAuditEntries(mailbox.uid)).toHaveLength(1);
        });

        it("refuses 400 for malformed bodies and addresses", async () => {
            const mailbox = await createMailbox();
            const { certificate } = await signer("erin@trust-5.example.com");
            for (const body of [
                [],
                { certificate },
                { address: 42, certificate },
                { address: "Erin <erin@trust-5.example.com>", certificate },
                { address: "erin@trust-5.example.com, x@trust-5.example.com", certificate },
                { address: "erin@trust-5.example.com" },
                { address: "erin@trust-5.example.com", certificate: "not base64!" },
                { address: "erin@trust-5.example.com", certificate: "AAAA" },
            ]) {
                const res = await trust(mailbox.uid, body);
                expect(res.status, JSON.stringify(body)).toBe(400);
            }
            expect(await ctx.findContacts(mailbox.uid)).toHaveLength(0);
        });

        it("refuses 400 for certificates that are expired, don't name the address, or aren't usable for signing mail", async () => {
            const mailbox = await createMailbox();
            const address = "frank@trust-6.example.com";
            const cases: [string, Promise<{ certificate: string }>][] = [
                ["expired", signer(address, { notBefore: new Date(Date.now() - 10 * 86_400_000), notAfter: new Date(Date.now() - 86_400_000) })],
                ["SAN mismatch", signer("someone-else@trust-6.example.com")],
                ["no SAN, no subject email", makeSignerCertificate()],
                ["keyUsage without digitalSignature", signer(address, { keyUsage: x509.KeyUsageFlags.keyEncipherment })],
                ["extKeyUsage without emailProtection", signer(address, { extKeyUsage: [x509.ExtendedKeyUsage.clientAuth] })],
                ["malformed extension", makeSignerCertificate({ extensions: [new x509.Extension("2.5.29.17", false, new Uint8Array([1, 2, 3]))] })],
            ];
            for (const [label, pending] of cases) {
                const res = await trust(mailbox.uid, { address, certificate: (await pending).certificate });
                expect(res.status, label).toBe(400);
            }
            expect(await ctx.findContacts(mailbox.uid)).toHaveLength(0);
            expect(await ctx.findAuditEntries(mailbox.uid)).toHaveLength(0);
        });

        it("accepts a subject emailAddress when there's no SAN email, a different-case SAN, and full signing usages", async () => {
            const mailbox = await createMailbox();
            const subjectOnly = await makeSignerCertificate({ subjectEmail: "grace@trust-7.example.com" });
            expect((await trust(mailbox.uid, { address: "grace@trust-7.example.com", certificate: subjectOnly.certificate })).status).toBe(200);
            const usages = await makeSignerCertificate({
                sanEmails: ["HEIDI@Trust-7.example.com"],
                keyUsage: x509.KeyUsageFlags.digitalSignature,
                extKeyUsage: [x509.ExtendedKeyUsage.emailProtection],
            });
            expect((await trust(mailbox.uid, { address: "heidi@trust-7.example.com", certificate: usages.certificate })).status).toBe(200);
        });

        it("returns 403 for a missing mailbox (as for another user's - it doesn't reveal which addresses have one), 403 for another user or a read-only delegate, and 200 for a manager", async () => {
            const mailbox = await createMailbox();
            const address = "ivan@trust-8.example.com";
            const { certificate } = await signer(address);

            expect((await trust(uuid.v4(), { address, certificate })).status).toBe(403);
            expect((await trust(mailbox.uid, { address, certificate }, other)).status).toBe(403);
            expect((await trust(mailbox.uid, { address, certificate }, viewer)).status).toBe(403);
            expect(await ctx.findContacts(mailbox.uid)).toHaveLength(0);
            const res = await trust(mailbox.uid, { address, certificate }, manager);
            expect(res.status).toBe(200);
            expect((await ctx.findAuditEntries(mailbox.uid))[0].actorUserUid).toBe(manager.uid);
        });

        it("needs CREATE on the Contacts folder to create a contact, and UPDATE on the contact's folder to pin on one", async () => {
            const mailbox = await createMailbox();
            const address = "judy@trust-9.example.com";
            const { certificate } = await signer(address);

            // `updater` has READ and UPDATE on the mailbox, but no CREATE.
            expect((await trust(mailbox.uid, { address, certificate }, updater)).status).toBe(403);
            expect(await ctx.findContacts(mailbox.uid)).toHaveLength(0);

            const saveContactIn = async (contactAddress: string, parentUid: string) => {
                const contact = await ctx.saveContact({
                    mailboxUid: mailbox.uid,
                    folderUid: uuid.v4(),
                    displayName: contactAddress,
                    emails: [{ address: contactAddress, type: "other" }],
                    phones: [],
                    addresses: [],
                });
                await ctx.saveAcl({ uid: contact.folderUid, parentUid, records: [] });
                return contact;
            };
            // A folder that grants nothing of its own and isn't parented to the mailbox.
            await saveContactIn(address, "Folder");
            expect((await trust(mailbox.uid, { address, certificate }, updater)).status).toBe(403);

            // A folder inheriting the mailbox's ACL, where `updater` has UPDATE.
            const shared = "judy.shared@trust-9.example.com";
            await saveContactIn(shared, mailbox.uid);
            const sharedCert = await signer(shared);
            expect((await trust(mailbox.uid, { address: shared, certificate: sharedCert.certificate }, updater)).status).toBe(200);
            // Nothing pinned where the caller was refused.
            const contacts = await ctx.findContacts(mailbox.uid);
            expect(contacts.map((contact: any) => [contact.emails[0].address, signKeys(contact).length]).sort()).toEqual([
                [shared, 1],
                [address, 0],
            ]);
        });

        it("two concurrent trusts of the same certificate leave one contact with one sign key", async () => {
            const mailbox = await createMailbox();
            const address = "kate@trust-10.example.com";
            const { certificate } = await signer(address);

            const results = await Promise.all([1, 2, 3].map(() => trust(mailbox.uid, { address, certificate })));

            expect(results.map((res) => res.status)).toEqual([200, 200, 200]);
            const contacts = await ctx.findContacts(mailbox.uid);
            expect(contacts).toHaveLength(1);
            expect(signKeys(contacts[0])).toHaveLength(1);
            expect(await ctx.findAuditEntries(mailbox.uid)).toHaveLength(1);
        });

        it("two concurrent trusts of different certificates pin exactly one of them", async () => {
            const mailbox = await createMailbox();
            const address = "leo@trust-11.example.com";
            const [a, b] = await Promise.all([signer(address), signer(address)]);

            const results = await Promise.all([a, b].map((cert) => trust(mailbox.uid, { address, certificate: cert.certificate })));

            expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
            const contacts = await ctx.findContacts(mailbox.uid);
            expect(contacts).toHaveLength(1);
            expect(signKeys(contacts[0])).toHaveLength(1);
        });

        it("a trust racing a discovery lookup for the same address leaves one contact with one sign key", async () => {
            const mailbox = await createMailbox();
            const domain = "trust-12.example.com";
            const address = `mallory@${domain}`;
            const discovered = await signer(address);
            const trusted = await signer(address);
            ctx.dnsResolver().records.set(`_rapidmx.${domain}`, [[`v=RMXv1; id=1; host=mail.${domain};`]]);
            ctx.mockFetch().mockResolvedValue({
                ok: true,
                status: 200,
                json: vi.fn().mockResolvedValue({
                    encryptPreference: { preferEncrypt: "mutual", lastSeen: 100 },
                    keys: [{ publicKey: discovered.certificate, type: "x509", useType: "sign", fingerprint: "x", notBefore: 0, notAfter: 1 }],
                    escrow: false,
                }),
                headers: { get: () => null },
            });

            const [lookup, trustRes] = await Promise.all([
                request(ctx.app())
                    .get(`${ctx.baseUrl}/${mailbox.uid}/keys/lookup?addr=${encodeURIComponent(address)}`)
                    .set("Authorization", "jwt " + ctx.tokenFor(owner)),
                trust(mailbox.uid, { address, certificate: trusted.certificate }),
            ]);

            expect(lookup.status).toBe(200);
            expect([200, 409]).toContain(trustRes.status);
            const contacts = await ctx.findContacts(mailbox.uid);
            expect(contacts).toHaveLength(1);
            const pinned = signKeys(contacts[0]);
            expect(pinned).toHaveLength(1);
            expect(pinned[0].fingerprint).toBe(trustRes.status === 200 ? trusted.fingerprint : discovered.fingerprint);
        });
    });

    describe("OpenPGP keys (POST /:id/keys/trust and /:id/keys/resolve with type openpgp)", () => {
        const resolve = (mailboxUid: string, body: any) =>
            request(ctx.app())
                .post(`${ctx.baseUrl}/${mailboxUid}/keys/resolve`)
                .set("Authorization", "jwt " + ctx.tokenFor(owner))
                .send(body);

        it("pins an OpenPGP key next to the contact's S/MIME keys, refuses a different one, and audits its type", async () => {
            const mailbox = await createMailbox();
            const address = "pgp-trust@proton.example";
            const pgp = await openPgpKey(address);
            const { certificate } = await signer(address);
            expect((await trust(mailbox.uid, { address, certificate })).status).toBe(200);

            const res = await trust(mailbox.uid, { address, certificate: pgp.armored, type: "openpgp" });
            expect(res.status).toBe(200);
            expect(res.body.keys.map((k: any) => [k.type, k.useType])).toEqual([
                ["x509", "sign"],
                ["openpgp", "encrypt"],
            ]);
            expect(res.body.keys[1]).toEqual(pgp.key);
            expect((await trust(mailbox.uid, { address, certificate: pgp.base64, type: "openpgp" })).status).toBe(200);
            const other = await trust(mailbox.uid, { address, certificate: (await openPgpKey(address)).armored, type: "openpgp" });
            expect(other.status).toBe(409);
            expect(other.body.message).toContain("OpenPGP");
            const audits = (await ctx.findAuditEntries(mailbox.uid)).filter((e: any) => e.action === AuditAction.CONTACT_KEY_TRUSTED);
            expect(audits.map((e: any) => e.details.type ?? null)).toEqual([null, "openpgp"]);
        });

        it("refreshes the pinned OpenPGP certificate from trust and resolve with the same fingerprint: an extended expiry, a rotated subkey", async () => {
            const mailbox = await createMailbox();
            const address = "pgp-refresh@proton.example";
            const pinned = await openPgpKey(address, { created: new Date(Date.now() - 10 * DAY), expiresIn: 20 * 86_400 });
            expect((await trust(mailbox.uid, { address, certificate: pinned.armored, type: "openpgp" })).status).toBe(200);

            const extended = await reexpired(pinned, 800 * 86_400);
            const trusted = await trust(mailbox.uid, { address, certificate: extended.armored, type: "openpgp" });
            expect(trusted.status).toBe(200);
            expect(trusted.body.keys).toEqual([expect.objectContaining({ fingerprint: pinned.fingerprint, notAfter: extended.key.notAfter })]);

            const rotated = await withRotatedSubkey(extended);
            const resolved = await resolve(mailbox.uid, { address, useType: "encrypt", type: "openpgp", action: "accept", expectedPinnedFingerprint: pinned.fingerprint, certificate: rotated.armored });
            expect(resolved.status).toBe(200);
            expect(resolved.body.keys).toHaveLength(1);
            expect(resolved.body.keys[0].fingerprint).toBe(pinned.fingerprint);
            expect(resolved.body.keys[0].publicKey).not.toBe(trusted.body.keys[0].publicKey);
            expect(resolved.body.previousKeys).toBeUndefined();
            // The same copy again changes nothing.
            const again = await resolve(mailbox.uid, { address, useType: "encrypt", type: "openpgp", action: "accept", expectedPinnedFingerprint: pinned.fingerprint, certificate: rotated.armored });
            expect(again.body.keys[0].publicKey).toBe(resolved.body.keys[0].publicKey);
        });

        it("refuses an unknown type, and an OpenPGP key that doesn't name the address", async () => {
            const mailbox = await createMailbox();
            expect((await trust(mailbox.uid, { address: "a@b.example", certificate: "x", type: "pgp" })).status).toBe(400);
            const res = await trust(mailbox.uid, { address: "a@b.example", certificate: (await openPgpKey("c@d.example")).armored, type: "openpgp" });
            expect(res.status).toBe(400);
        });

        it("accepts or rejects a changed OpenPGP key on its own slot", async () => {
            const mailbox = await createMailbox();
            const address = "pgp-resolve@proton.example";
            const pinned = await openPgpKey(address);
            const observed = await openPgpKey(address);
            const conflict = { useType: "encrypt", observedKey: observed.key, observedAt: Date.now(), source: "discovery" };
            // Created through trust, so it is filed in the mailbox's Contacts folder; then given an S/MIME key and the conflict.
            expect((await trust(mailbox.uid, { address, certificate: pinned.armored, type: "openpgp" })).status).toBe(200);
            const [created] = await ctx.findContacts(mailbox.uid);
            await ctx.saveContact({ ...created, keys: [encryptKey("smime-fp"), pinned.key], keyConflicts: [conflict] });
            const base = { address, useType: "encrypt", expectedPinnedFingerprint: pinned.fingerprint, type: "openpgp" };
            expect((await resolve(mailbox.uid, { ...base, useType: "sign" })).status).toBe(400);
            expect((await resolve(mailbox.uid, { ...base, type: "nope" })).status).toBe(400);
            // The X.509 slot's pinned fingerprint isn't this one.
            expect((await resolve(mailbox.uid, { ...base, type: undefined, action: "accept" })).status).toBe(409);

            const accepted = await resolve(mailbox.uid, { ...base, action: "accept" });
            expect(accepted.status).toBe(200);
            expect(accepted.body.keys.map((k: any) => k.fingerprint)).toEqual(["smime-fp", observed.fingerprint]);
            expect(accepted.body.keyConflicts).toBeUndefined();
            expect(accepted.body.previousKeys).toEqual([expect.objectContaining({ fingerprint: pinned.fingerprint, type: "openpgp", replacement: "user" })]);

            // A given certificate replaces it too, validated as OpenPGP.
            const third = await openPgpKey(address);
            const given = await resolve(mailbox.uid, { ...base, expectedPinnedFingerprint: observed.fingerprint, action: "accept", certificate: third.armored });
            expect(given.body.keys.map((k: any) => k.fingerprint)).toEqual(["smime-fp", third.fingerprint]);
        });
    });
}
