///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { buildKeyDiscoveryResponse, discoverLocalKeys, NOT_PUBLISHED_RESPONSE, type LocalKeyDiscovery } from "../../src/util/LocalKeyDiscoveryUtils.js";
import { discoverAndMergeKeys } from "../../src/util/KeyringUtils.js";
import { issueCertificate, makeTestIssuer } from "./signerCertificates.js";
import type { StaticDnsResolver } from "../testDoubles.js";

/** A repo whose `find()` answers from `rows` by `primarySmtpAddress`/`aliasAddresses`/`mailboxUid`, and remembers each query. */
function fakeRepo(rows: any[]): { find: ReturnType<typeof vi.fn> } {
    return {
        find: vi.fn(async (query: any) => {
            const literal = (value: any): string => value?.value ?? value;
            if ("primarySmtpAddress" in query) {
                return rows.filter((row) => row.primarySmtpAddress === literal(query.primarySmtpAddress)).slice(0, 1);
            }
            if ("aliasAddresses" in query) {
                return rows.filter((row) => row.aliasAddresses?.includes(literal(query.aliasAddresses))).slice(0, 1);
            }
            return rows.filter((row) => row.mailboxUid === query.mailboxUid).slice(0, 1);
        }),
    };
}

function localOf(mailboxes: any[], vaults: any[] = [], options: Partial<LocalKeyDiscovery> = {}): LocalKeyDiscovery & { mailboxRepo: any; keyVaultRepo: any } {
    return {
        mailboxRepo: fakeRepo(mailboxes) as any,
        keyVaultRepo: fakeRepo(vaults) as any,
        domainNames: async () => ["example.com"],
        aliasQueryValue: (address: string) => address,
        plusAddressing: true,
        ...options,
    };
}

const mailbox = (fields: Record<string, any> = {}) => ({
    uid: "bob@example.com",
    primarySmtpAddress: "bob@example.com",
    aliasAddresses: ["robert@example.com"],
    keys: [{ publicKey: "AAAA", type: "x509", useType: "encrypt", fingerprint: "fp", notBefore: 0, notAfter: 1 }],
    encryptPreference: { preferEncrypt: "mutual", lastSeen: 3 },
    ...fields,
});

describe("LocalKeyDiscoveryUtils", () => {
    describe("buildKeyDiscoveryResponse()", () => {
        it("answers the defaults for no mailbox, after exactly one KeyVault lookup", async () => {
            const vaults = fakeRepo([]);

            expect(await buildKeyDiscoveryResponse(vaults as any, undefined)).toBe(NOT_PUBLISHED_RESPONSE);
            expect(vaults.find).toHaveBeenCalledTimes(1);
            expect(vaults.find.mock.calls[0][0]).toEqual({ mailboxUid: "" });
        });

        it("answers a mailbox's keys and preference, with escrow only when its vault holds an escrow wrap", async () => {
            const plain = fakeRepo([{ mailboxUid: "bob@example.com", masterKeyWraps: [{ method: "password" }] }]);
            const escrowed = fakeRepo([{ mailboxUid: "bob@example.com", masterKeyWraps: [{ method: "password" }, { method: "escrow" }] }]);

            expect(await buildKeyDiscoveryResponse(plain as any, mailbox() as any)).toEqual({
                encryptPreference: { preferEncrypt: "mutual", lastSeen: 3 },
                keys: mailbox().keys,
                escrow: false,
            });
            expect((await buildKeyDiscoveryResponse(escrowed as any, mailbox() as any)).escrow).toBe(true);
            expect((await buildKeyDiscoveryResponse(fakeRepo([]) as any, mailbox() as any)).escrow).toBe(false);
        });

        it("falls back to the default preference and no keys for a mailbox row that has neither", async () => {
            const response = await buildKeyDiscoveryResponse(fakeRepo([]) as any, mailbox({ keys: undefined, encryptPreference: undefined }) as any);

            expect(response).toEqual({ encryptPreference: { preferEncrypt: "nopreference" }, keys: [], escrow: false });
        });
    });

    describe("discoverLocalKeys()", () => {
        it("finds a mailbox by primary address without looking at aliases", async () => {
            const local = localOf([mailbox()]);

            const found = await discoverLocalKeys(local, "Bob@Example.COM");

            expect(found?.address).toBe("bob@example.com");
            expect(found?.response?.keys).toHaveLength(1);
            expect(local.mailboxRepo.find).toHaveBeenCalledTimes(1);
        });

        it("finds a mailbox by alias and reports the mailbox's primary address", async () => {
            const found = await discoverLocalKeys(localOf([mailbox()]), "robert@example.com");

            expect(found?.address).toBe("bob@example.com");
            expect(found?.response?.encryptPreference.preferEncrypt).toBe("mutual");
        });

        it("resolves a plus-tagged address to the untagged mailbox when plus-addressing is on, and not when it is off", async () => {
            expect((await discoverLocalKeys(localOf([mailbox()]), "bob+news@example.com"))?.address).toBe("bob@example.com");
            expect((await discoverLocalKeys(localOf([mailbox()]), "robert+news@example.com"))?.address).toBe("bob@example.com");

            const off = await discoverLocalKeys(localOf([mailbox()], [], { plusAddressing: false }), "bob+news@example.com");
            expect(off).toEqual({ address: "bob+news@example.com" });
        });

        it("prefers a mailbox that registered the plus-tagged address literally", async () => {
            const tagged = mailbox({ uid: "bob+news@example.com", primarySmtpAddress: "bob+news@example.com", aliasAddresses: [] });

            const found = await discoverLocalKeys(localOf([mailbox(), tagged]), "bob+news@example.com");

            expect(found?.address).toBe("bob+news@example.com");
        });

        it("has no response for an address of a domain this deployment serves that no mailbox has", async () => {
            expect(await discoverLocalKeys(localOf([mailbox()]), "ghost@example.com")).toEqual({ address: "ghost@example.com" });
        });

        it("has no answer for another server's address, or an address that isn't one", async () => {
            const local = localOf([mailbox()]);

            expect(await discoverLocalKeys(local, "carol@elsewhere.example")).toBeUndefined();
            expect(await discoverLocalKeys(local, "not an address")).toBeUndefined();
            expect(await discoverLocalKeys(local, "a@b@example.com")).toBeUndefined();
            expect(local.mailboxRepo.find).not.toHaveBeenCalledWith(expect.objectContaining({ primarySmtpAddress: expect.anything() }));
        });
    });

    describe("discoverAndMergeKeys() with local mailboxes", () => {
        it("merges a local mailbox's keys with no DNS lookup, keyed on the mailbox's primary address", async () => {
            const issuer = await makeTestIssuer();
            const cert = await issueCertificate(issuer, { sanEmails: ["bob@example.com"] });
            const local = localOf([
                mailbox({
                    keys: [{ publicKey: cert.certificate, type: "x509", useType: "encrypt", fingerprint: "x", notBefore: 0, notAfter: 1 }],
                }),
            ]);
            const dns = { resolveTxt: vi.fn() } as unknown as StaticDnsResolver;

            // The alias names the mailbox, whose certificate names its primary address.
            const update = await discoverAndMergeKeys(dns, "robert@example.com", undefined, 1000, local);

            expect(update?.keys?.map((key) => key.fingerprint)).toEqual([cert.fingerprint]);
            expect(dns.resolveTxt).not.toHaveBeenCalled();
        });

        it("answers undefined for a served-domain address with no mailbox, without DNS", async () => {
            const dns = { resolveTxt: vi.fn() } as unknown as StaticDnsResolver;

            expect(await discoverAndMergeKeys(dns, "ghost@example.com", undefined, 1000, localOf([]))).toBeUndefined();
            expect(dns.resolveTxt).not.toHaveBeenCalled();
        });

        it("falls through to federation for an address that isn't local, and for every address when there is no local access", async () => {
            const dns = { resolveTxt: vi.fn().mockRejectedValue(new Error("NXDOMAIN")) } as unknown as StaticDnsResolver;

            expect(await discoverAndMergeKeys(dns, "carol@elsewhere.example", undefined, 1000, localOf([mailbox()]))).toBeUndefined();
            expect(await discoverAndMergeKeys(dns, "bob@example.com", undefined, 1000)).toBeUndefined();
            expect(dns.resolveTxt).toHaveBeenCalledTimes(2);
            expect(dns.resolveTxt).toHaveBeenCalledWith("_rapidmx.elsewhere.example");
            expect(dns.resolveTxt).toHaveBeenCalledWith("_rapidmx.example.com");
        });
    });
});
