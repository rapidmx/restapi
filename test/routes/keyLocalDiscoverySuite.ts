///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `GET /:id/keys/lookup` for a recipient that lives on THIS deployment, identical on both backends: answered from the
// local mailbox (the same response the public discovery endpoint serves) with no DNS and no HTTP, pinned and merged like a
// remote result. `test/routes/{mongo,sql}/KeyLocalDiscovery.test.ts` supply a started server and raw row helpers.
import { request } from "@rapidrest/service-core/test";
import { ACLAction } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { computeKeyDiscoveryHash } from "../../src/util/KeyDiscoveryClient.js";
import type { StaticDnsResolver } from "../testDoubles.js";
import { issueCertificate, makeTestIssuer, type TestIssuer } from "../util/signerCertificates.js";

const DAY = 24 * 60 * 60 * 1000;

export interface KeyLocalDiscoverySuiteContext {
    app: () => any;
    /** e.g. `/mongo/mailboxes`. */
    baseUrl: string;
    /** e.g. `/mongo/.well-known/rapidmx/keys`. */
    discoveryUrl: string;
    tokenFor: (user: any) => string;
    /** Saves a mailbox row (its `keyDiscoveryHash` is set from the address), with no ACL. */
    saveMailbox: (fields: Record<string, any>) => Promise<any>;
    saveAcl: (acl: { uid: string; parentUid: string; records: { userOrRoleId: string; actions: string[] }[] }) => Promise<void>;
    /** Replaces `Mailbox.keys` directly. */
    setMailboxKeys: (uid: string, keys: any[]) => Promise<void>;
    /** Saves an enabled, verified `Domain`. */
    saveDomain: (name: string) => Promise<void>;
    findContacts: (mailboxUid: string) => Promise<any[]>;
    dnsResolver: () => StaticDnsResolver;
    mockFetch: () => ReturnType<typeof vi.fn>;
}

export function keyLocalDiscoverySuite(ctx: KeyLocalDiscoverySuiteContext): void {
    const caller: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const stranger: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    let issuer: TestIssuer;
    let dnsSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
        issuer = await makeTestIssuer();
    });

    beforeEach(() => {
        dnsSpy = vi.spyOn(ctx.dnsResolver(), "resolveTxt");
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** A mailbox for `local@domain`, with keys and an ACL record for `owner` (the caller by default). */
    const createMailbox = async (local: string, fields: Record<string, any> = {}, domain: string = "example.com", owner: any = caller) => {
        const mailbox = await ctx.saveMailbox({
            ownerUserUid: owner.uid,
            primarySmtpAddress: `${local}@${domain}`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            keyDiscoveryHash: computeKeyDiscoveryHash(local),
            ...fields,
        });
        await ctx.saveAcl({ uid: mailbox.uid, parentUid: "Mailbox", records: [{ userOrRoleId: owner.uid, actions: [ACLAction.FULL] }] });
        return mailbox;
    };

    const certKey = async (address: string, extra: Record<string, any> = {}, useIssuer: boolean = true) => {
        const cert = await issueCertificate(issuer, { sanEmails: [address] });
        return {
            publicKey: cert.certificate,
            type: "x509",
            useType: "encrypt",
            fingerprint: cert.fingerprint,
            notBefore: Date.now() - DAY,
            notAfter: Date.now() + 365 * DAY,
            ...(useIssuer ? { issuerCertificate: issuer.certificate } : {}),
            ...extra,
        };
    };

    const lookup = (mailboxUid: string, addr: string, user: any = caller) =>
        request(ctx.app())
            .get(`${ctx.baseUrl}/${mailboxUid}/keys/lookup?addr=${encodeURIComponent(addr)}`)
            .set("Authorization", "jwt " + ctx.tokenFor(user));

    const expectNoFederation = () => {
        expect(dnsSpy).not.toHaveBeenCalled();
        expect(ctx.mockFetch()).not.toHaveBeenCalled();
    };

    describe("GET /:id/keys/lookup for an address on this deployment", () => {
        it("answers from the recipient's mailbox by primary address, pins its key on the caller's contact and never touches DNS or HTTP", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const recipient = await createMailbox(`bob-${uuid.v4()}`, {}, "example.com", stranger);
            const key = await certKey(recipient.primarySmtpAddress);
            await ctx.setMailboxKeys(recipient.uid, [key]);

            const res = await lookup(own.uid, recipient.primarySmtpAddress);

            expect(res.status).toBe(200);
            expect(res.body.keys).toEqual([expect.objectContaining({ publicKey: key.publicKey, useType: "encrypt", fingerprint: key.fingerprint, issuerCertificate: issuer.certificate })]);
            const contacts = await ctx.findContacts(own.uid);
            expect(contacts).toHaveLength(1);
            expect(contacts[0].emails).toEqual([{ address: recipient.primarySmtpAddress, type: "other" }]);
            expect(contacts[0].keys.map((k: any) => k.fingerprint)).toEqual([key.fingerprint]);
            expect(contacts[0].keysFirstSeen).toBeGreaterThan(0);
            expectNoFederation();
        });

        it("answers with the mailbox's own encryption preference", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const recipient = await createMailbox(`bob-${uuid.v4()}`, { encryptPreference: { preferEncrypt: "mutual", lastSeen: 500 } }, "example.com", stranger);
            await ctx.setMailboxKeys(recipient.uid, [await certKey(recipient.primarySmtpAddress)]);

            const res = await lookup(own.uid, recipient.primarySmtpAddress);

            expect(res.status).toBe(200);
            expect(res.body.encryptPreference).toEqual({ preferEncrypt: "mutual", lastSeen: 500 });
        });

        it("matches the address case-insensitively, keeping the caller's contact under the address as typed", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const local = `bob-${uuid.v4()}`;
            const recipient = await createMailbox(local, {}, "example.com", stranger);
            const key = await certKey(recipient.primarySmtpAddress);
            await ctx.setMailboxKeys(recipient.uid, [key]);
            const typed = `${local.toUpperCase()}@Example.COM`;

            const res = await lookup(own.uid, typed);

            expect(res.status).toBe(200);
            expect(res.body.keys[0].fingerprint).toBe(key.fingerprint);
            expect((await ctx.findContacts(own.uid))[0].emails[0].address).toBe(typed);
            expectNoFederation();
        });

        it("resolves an alias to its mailbox, and a plus-tagged address to the untagged one", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const local = `bob-${uuid.v4()}`;
            const alias = `sales-${uuid.v4()}@example.com`;
            const otherDomainAlias = `bob-${uuid.v4()}@alias-domain.example`;
            const recipient = await createMailbox(local, { aliasAddresses: [alias, otherDomainAlias] }, "example.com", stranger);
            const key = await certKey(recipient.primarySmtpAddress);
            await ctx.setMailboxKeys(recipient.uid, [key]);

            for (const addr of [alias, otherDomainAlias, `${local}+news@example.com`, `${alias.split("@")[0]}+x@example.com`]) {
                const res = await lookup(own.uid, addr);
                expect(res.status, addr).toBe(200);
                expect(res.body.keys[0].fingerprint, addr).toBe(key.fingerprint);
            }
            expect(await ctx.findContacts(own.uid)).toHaveLength(4);
            expectNoFederation();
        });

        it("doesn't let a literal % or _ in the address match another mailbox's alias", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const recipient = await createMailbox(`bob-${uuid.v4()}`, { aliasAddresses: ["sales-wild@example.com"] }, "example.com", stranger);
            await ctx.setMailboxKeys(recipient.uid, [await certKey(recipient.primarySmtpAddress)]);

            for (const addr of ["sales%wild@example.com", "sales_wild@example.com", "%@example.com"]) {
                expect((await lookup(own.uid, addr)).status, addr).toBe(404);
            }
        });

        it("answers 200 with no keys, and the default preference, for a mailbox that never published one", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const recipient = await createMailbox(`bob-${uuid.v4()}`, {}, "example.com", stranger);

            const res = await lookup(own.uid, recipient.primarySmtpAddress);

            expect(res.status).toBe(200);
            expect(res.body.keys).toEqual([]);
            expect(res.body.encryptPreference).toEqual({ preferEncrypt: "nopreference" });
            expectNoFederation();
        });

        it("works for a shared mailbox the caller has no access to, and for the caller's own address", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const shared = await createMailbox(`shared-${uuid.v4()}`, {}, "example.com", stranger);
            await ctx.saveAcl({
                uid: shared.uid,
                parentUid: "Mailbox",
                records: [
                    { userOrRoleId: stranger.uid, actions: [ACLAction.FULL] },
                    { userOrRoleId: admin.uid, actions: [ACLAction.READ] },
                ],
            });
            const sharedKey = await certKey(shared.primarySmtpAddress);
            await ctx.setMailboxKeys(shared.uid, [sharedKey]);
            const ownKey = await certKey(own.primarySmtpAddress);
            await ctx.setMailboxKeys(own.uid, [ownKey]);

            expect((await lookup(own.uid, shared.primarySmtpAddress)).body.keys[0].fingerprint).toBe(sharedKey.fingerprint);
            expect((await lookup(own.uid, own.primarySmtpAddress)).body.keys[0].fingerprint).toBe(ownKey.fingerprint);
        });

        it("pins only the active key of a mailbox whose earlier key was revoked, and serves the same key the public endpoint does", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const local = `bob-${uuid.v4()}`;
            const recipient = await createMailbox(local, { encryptPreference: { preferEncrypt: "mutual", lastSeen: 1 } }, "example.com", stranger);
            const old = await certKey(recipient.primarySmtpAddress, { revokedAt: Date.now() - 1000, revocationReason: "superseded" });
            const current = await certKey(recipient.primarySmtpAddress);
            await ctx.setMailboxKeys(recipient.uid, [old, current]);

            const res = await lookup(own.uid, recipient.primarySmtpAddress);

            expect(res.status).toBe(200);
            expect(res.body.keys.map((k: any) => k.fingerprint)).toEqual([current.fingerprint]);
            const published = (await request(ctx.app()).get(`${ctx.discoveryUrl}/${computeKeyDiscoveryHash(local)}?domain=example.com`)).body;
            expect(published.keys.map((k: any) => k.publicKey)).toEqual([old.publicKey, current.publicKey]);
            expect(published.encryptPreference).toEqual(res.body.encryptPreference);
        });

        it("serves nothing but public key fields of the mailbox", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const recipient = await createMailbox(`bob-${uuid.v4()}`, {}, "example.com", stranger);
            await ctx.setMailboxKeys(recipient.uid, [
                { ...(await certKey(recipient.primarySmtpAddress)), wrappedKey: "secret", privateKey: "secret" },
            ]);

            const res = await lookup(own.uid, recipient.primarySmtpAddress);

            expect(Object.keys(res.body).sort()).toEqual(["encryptPreference", "keys"]);
            expect(JSON.stringify(res.body)).not.toContain("secret");
        });

        it("replaces the pinned key automatically after the recipient rotates within the same CA, keeping the old one as previous", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const recipient = await createMailbox(`bob-${uuid.v4()}`, {}, "example.com", stranger);
            const old = await certKey(recipient.primarySmtpAddress);
            await ctx.setMailboxKeys(recipient.uid, [old]);
            expect((await lookup(own.uid, recipient.primarySmtpAddress)).body.keys[0].fingerprint).toBe(old.fingerprint);

            const rotated = await certKey(recipient.primarySmtpAddress);
            await ctx.setMailboxKeys(recipient.uid, [{ ...old, revokedAt: Date.now(), revocationReason: "superseded" }, rotated]);
            const res = await lookup(own.uid, recipient.primarySmtpAddress);

            expect(res.status).toBe(200);
            expect(res.body.keys.map((k: any) => k.fingerprint)).toEqual([rotated.fingerprint]);
            expect(res.body.keyConflicts).toBeUndefined();
            expect(res.body.previousKeys).toEqual([expect.objectContaining({ fingerprint: old.fingerprint, replacement: "automatic" })]);
            expect(await ctx.findContacts(own.uid)).toHaveLength(1);
            expectNoFederation();
        });

        it("keeps the pinned key and records a conflict when the new key can't be proven to come from the same CA", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const recipient = await createMailbox(`bob-${uuid.v4()}`, {}, "example.com", stranger);
            const pinned = await certKey(recipient.primarySmtpAddress);
            await ctx.setMailboxKeys(recipient.uid, [pinned]);
            await lookup(own.uid, recipient.primarySmtpAddress);

            const replacement = await certKey(recipient.primarySmtpAddress, {}, false);
            await ctx.setMailboxKeys(recipient.uid, [replacement]);
            const res = await lookup(own.uid, recipient.primarySmtpAddress);

            expect(res.status).toBe(200);
            expect(res.body.keys.map((k: any) => k.fingerprint)).toEqual([pinned.fingerprint]);
            expect(res.body.keyConflicts).toEqual([expect.objectContaining({ useType: "encrypt", source: "discovery", observedKey: expect.objectContaining({ fingerprint: replacement.fingerprint }) })]);
        });

        it("keeps the existing contact's keys when a mailbox no longer publishes any (Anti-Downgrade)", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const recipient = await createMailbox(`bob-${uuid.v4()}`, {}, "example.com", stranger);
            const key = await certKey(recipient.primarySmtpAddress);
            await ctx.setMailboxKeys(recipient.uid, [key]);
            await lookup(own.uid, recipient.primarySmtpAddress);

            await ctx.setMailboxKeys(recipient.uid, []);
            const res = await lookup(own.uid, recipient.primarySmtpAddress);

            expect(res.status).toBe(200);
            expect(res.body.keys.map((k: any) => k.fingerprint)).toEqual([key.fingerprint]);
        });

        it("answers 404 without DNS or HTTP for an address of the deployment's own domain that no mailbox has, even when the domain publishes a _rapidmx record", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            await ctx.saveDomain("served-lookup.example");
            ctx.dnsResolver().records.set("_rapidmx.served-lookup.example", [["v=RMXv1; id=1; host=mail.served-lookup.example;"]]);

            const res = await lookup(own.uid, "ghost@served-lookup.example");

            expect(res.status).toBe(404);
            expect(res.body.message).toBe("No keys could be discovered for this address.");
            expect(await ctx.findContacts(own.uid)).toEqual([]);
            expectNoFederation();
        });

        it("still resolves a recipient on another server through federation, though the caller's own domain is served here", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            await ctx.saveDomain("example.com");
            const addr = "carol@peer-lookup.example";
            const key = await certKey(addr);
            ctx.dnsResolver().records.set("_rapidmx.peer-lookup.example", [["v=RMXv1; id=1; host=mail.peer-lookup.example;"]]);
            ctx.mockFetch().mockResolvedValue({
                ok: true,
                status: 200,
                json: vi.fn().mockResolvedValue({ encryptPreference: { preferEncrypt: "mutual", lastSeen: 1 }, keys: [key], escrow: false }),
                headers: { get: () => null },
            });

            const res = await lookup(own.uid, addr);

            expect(res.status).toBe(200);
            expect(res.body.keys[0].fingerprint).toBe(key.fingerprint);
            expect(dnsSpy).toHaveBeenCalledWith("_rapidmx.peer-lookup.example");
            expect(ctx.mockFetch()).toHaveBeenCalledTimes(1);
            expect(ctx.mockFetch().mock.calls[0][0]).toContain("https://mail.peer-lookup.example/.well-known/rapidmx/keys/");
        });

        it("answers 404 for an address on another server that isn't a federated peer, after asking DNS", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);

            const res = await lookup(own.uid, "nobody@not-a-peer-lookup.example");

            expect(res.status).toBe(404);
            expect(dnsSpy).toHaveBeenCalledWith("_rapidmx.not-a-peer-lookup.example");
        });

        it("keeps its authorization: only someone with UPDATE on the caller's mailbox, and a trusted role alone grants nothing", async () => {
            const own = await createMailbox(`alice-${uuid.v4()}`);
            const recipient = await createMailbox(`bob-${uuid.v4()}`, {}, "example.com", stranger);
            await ctx.setMailboxKeys(recipient.uid, [await certKey(recipient.primarySmtpAddress)]);

            expect((await lookup(own.uid, recipient.primarySmtpAddress, stranger)).status).toBe(403);
            expect((await lookup(own.uid, recipient.primarySmtpAddress, admin)).status).toBe(403);
            expect((await lookup(own.uid, recipient.primarySmtpAddress)).status).toBe(200);
            expect(await ctx.findContacts(own.uid)).toHaveLength(1);
        });
    });
}
