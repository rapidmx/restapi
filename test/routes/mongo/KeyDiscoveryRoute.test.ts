///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager, RateLimiter } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { KeyVaultMongo } from "../../../src/models/mongo/KeyVaultMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { computeKeyDiscoveryHash } from "../../../src/util/KeyDiscoveryClient.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:KeyDiscoveryMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/.well-known/rapidmx/keys";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let keyVaultRepo: MongoRepository<KeyVaultMongo>;
    let domainRepo: MongoRepository<DomainMongo>;

    const createMailbox = async function (data?: Partial<MailboxMongo>): Promise<MailboxMongo> {
        const primarySmtpAddress = `${uuid.v4()}@example.com`;
        const obj = new MailboxMongo({
            ownerUserUid: uuid.v4(),
            primarySmtpAddress,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
            keyDiscoveryHash: computeKeyDiscoveryHash(primarySmtpAddress.split("@")[0]),
            ...data,
        });
        return await mailboxRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            keyVaultRepo = conn.getMongoRepository("KeyVaultMongo");
            domainRepo = conn.getMongoRepository("DomainMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const r of [mailboxRepo, keyVaultRepo, domainRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
    });

    it("Returns the all-defaults response, with a 200 (not 404), for a hash matching no mailbox - indistinguishable from a real mailbox with nothing published.", async () => {
        const result = await request(server.getApplication()).get(`${baseUrl}/${computeKeyDiscoveryHash("nobody-here")}`);

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ encryptPreference: { preferEncrypt: "nopreference" }, keys: [], escrow: false });
    });

    it("Returns the identical all-defaults response for a real mailbox that has never published a key - byte-for-byte the same shape as the not-found case.", async () => {
        const mailbox = await createMailbox();
        const result = await request(server.getApplication()).get(`${baseUrl}/${mailbox.keyDiscoveryHash}`);

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ encryptPreference: { preferEncrypt: "nopreference" }, keys: [], escrow: false });
    });

    it("Returns a mailbox's actual published keys/preference.", async () => {
        const publicKey = {
            publicKey: "b64",
            type: "x509",
            useType: "encrypt" as const,
            fingerprint: "fp",
            notBefore: 0,
            notAfter: 1,
        };
        const mailbox = await createMailbox({
            encryptPreference: { preferEncrypt: "mutual", lastSeen: 100 },
            keys: [publicKey],
        });

        // `Host` set explicitly: `lookup()` scopes a `keyDiscoveryHash` match to the domain named by the
        // request's `Host` header (the spec's own domain-disambiguation mechanism for a multi-domain
        // deployment - see `BaseKeyDiscoveryRoute`'s own "Domain scoping" doc comment), which supertest's
        // default `Host` (the test server's own listen address) would not otherwise match.
        const result = await request(server.getApplication()).get(`${baseUrl}/${mailbox.keyDiscoveryHash}`).set("Host", "example.com");

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ encryptPreference: { preferEncrypt: "mutual", lastSeen: 100 }, keys: [publicKey], escrow: false });
    });

    it("Reports escrow: true when the mailbox's KeyVault holds an escrow-method master key wrap.", async () => {
        const mailbox = await createMailbox();
        await keyVaultRepo.save(
            new KeyVaultMongo({
                mailboxUid: mailbox.uid,
                wrappedKeys: [],
                masterKeyWraps: [
                    {
                        method: "escrow",
                        escrowScopeId: "legal-hold",
                        ciphertext: "ct",
                        nonce: "n",
                        salt: "s",
                        kdf: "argon2id",
                        schemeVersion: 1,
                        createdAt: Date.now(),
                    },
                ],
            }),
        );

        const result = await request(server.getApplication()).get(`${baseUrl}/${mailbox.keyDiscoveryHash}`).set("Host", "example.com");

        expect(result.body.escrow).toBe(true);
    });

    it("Reports escrow: false when the mailbox's KeyVault holds only non-escrow wraps.", async () => {
        const mailbox = await createMailbox();
        await keyVaultRepo.save(
            new KeyVaultMongo({
                mailboxUid: mailbox.uid,
                wrappedKeys: [],
                masterKeyWraps: [
                    { method: "password", ciphertext: "ct", nonce: "n", salt: "s", kdf: "argon2id", schemeVersion: 1, createdAt: Date.now() },
                ],
            }),
        );

        const result = await request(server.getApplication()).get(`${baseUrl}/${mailbox.keyDiscoveryHash}`).set("Host", "example.com");

        expect(result.body.escrow).toBe(false);
    });

    it("Sets ETag and Cache-Control headers.", async () => {
        const mailbox = await createMailbox();
        const result = await request(server.getApplication()).get(`${baseUrl}/${mailbox.keyDiscoveryHash}`);

        expect(result.headers["etag"]).toMatch(/^"[0-9a-f]{64}"$/);
        expect(result.headers["cache-control"]).toBe("max-age=3600");
    });

    it("Returns the same ETag for the same content, and honors If-None-Match with a 304.", async () => {
        const mailbox = await createMailbox();
        const first = await request(server.getApplication()).get(`${baseUrl}/${mailbox.keyDiscoveryHash}`);

        const second = await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.keyDiscoveryHash}`)
            .set("If-None-Match", first.headers["etag"]);

        expect(second.status).toBe(304);
    });

    it("Returns 200 with a fresh body when If-None-Match does not match the current content.", async () => {
        const mailbox = await createMailbox();
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.keyDiscoveryHash}`)
            .set("If-None-Match", '"stale-etag"');

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ encryptPreference: { preferEncrypt: "nopreference" }, keys: [], escrow: false });
    });

    it("Rejects a :hash that isn't exactly 52 z-base32 characters with a 400.", async () => {
        const hash = computeKeyDiscoveryHash("alice");
        for (const bad of [hash.slice(0, 51), `${hash}y`, `l${hash.slice(1)}`, "in(abc)"]) {
            const result = await request(server.getApplication()).get(`${baseUrl}/${encodeURIComponent(bad)}`);
            expect(result.status).toBe(400);
        }
    });

    it("Scopes the lookup by the ?domain= query parameter, so two domains sharing a local part never get each other's keys.", async () => {
        const localPart = `ceo-${uuid.v4()}`;
        const keyFor = (fp: string) => ({ publicKey: "b64", type: "x509", useType: "encrypt" as const, fingerprint: fp, notBefore: 0, notAfter: 1 });
        const hash = computeKeyDiscoveryHash(localPart);
        await createMailbox({ primarySmtpAddress: `${localPart}@acme.example`, keyDiscoveryHash: hash, keys: [keyFor("acme-fp")] });
        await createMailbox({ primarySmtpAddress: `${localPart}@contoso.example`, keyDiscoveryHash: hash, keys: [keyFor("contoso-fp")] });

        // `Host` is the shared discovery server's own name - it names neither domain.
        const acme = await request(server.getApplication()).get(`${baseUrl}/${hash}?domain=ACME.example`).set("Host", "mail.shared.example");
        const contoso = await request(server.getApplication()).get(`${baseUrl}/${hash}?domain=contoso.example`).set("Host", "mail.shared.example");
        const other = await request(server.getApplication()).get(`${baseUrl}/${hash}?domain=fabrikam.example`).set("Host", "acme.example");

        expect(acme.body.keys).toEqual([keyFor("acme-fp")]);
        expect(contoso.body.keys).toEqual([keyFor("contoso-fp")]);
        // `domain` takes precedence over `Host` when both are present.
        expect(other.body).toEqual({ encryptPreference: { preferEncrypt: "nopreference" }, keys: [], escrow: false });
    });

    it("Falls back to the Host header (port stripped, lowercased) when ?domain= is absent.", async () => {
        const localPart = `ceo-${uuid.v4()}`;
        const hash = computeKeyDiscoveryHash(localPart);
        const key = { publicKey: "b64", type: "x509", useType: "encrypt" as const, fingerprint: "host-fp", notBefore: 0, notAfter: 1 };
        await createMailbox({ primarySmtpAddress: `${localPart}@acme.example`, keyDiscoveryHash: hash, keys: [key] });

        const result = await request(server.getApplication()).get(`${baseUrl}/${hash}`).set("Host", "ACME.example:8443");

        expect(result.body.keys).toEqual([key]);
    });

    it("Resolves a requested alias domain (Domain.aliasOf) to its primary domain, so a peer asking about an alias-domain address still finds the primary mailbox's published keys.", async () => {
        await domainRepo.save(new DomainMongo({ uid: "powerlevel.gg", name: "powerlevel.gg", enabled: true, verified: true }));
        await domainRepo.save(new DomainMongo({ uid: "plc.gg", name: "plc.gg", enabled: true, verified: true, aliasOf: "powerlevel.gg" }));
        const localPart = `boss-${uuid.v4()}`;
        const hash = computeKeyDiscoveryHash(localPart);
        const key = { publicKey: "b64", type: "x509", useType: "encrypt" as const, fingerprint: "alias-fp", notBefore: 0, notAfter: 1 };
        // No mailbox is ever addressed on a pure alias domain - the mailbox lives on the primary domain.
        await createMailbox({ primarySmtpAddress: `${localPart}@powerlevel.gg`, keyDiscoveryHash: hash, keys: [key] });

        const result = await request(server.getApplication()).get(`${baseUrl}/${hash}?domain=plc.gg`);

        expect(result.status).toBe(200);
        expect(result.body.keys).toEqual([key]);
    });

    it("Never leaks a disabled/dangling alias domain into a match - falls back to the all-defaults response.", async () => {
        await domainRepo.save(new DomainMongo({ uid: "powerlevel.gg", name: "powerlevel.gg", enabled: true, verified: true }));
        await domainRepo.save(
            new DomainMongo({ uid: "disabled-alias.gg", name: "disabled-alias.gg", enabled: false, verified: true, aliasOf: "powerlevel.gg" }),
        );
        const localPart = `boss2-${uuid.v4()}`;
        const hash = computeKeyDiscoveryHash(localPart);
        await createMailbox({
            primarySmtpAddress: `${localPart}@powerlevel.gg`,
            keyDiscoveryHash: hash,
            keys: [{ publicKey: "b64", type: "x509", useType: "encrypt" as const, fingerprint: "fp", notBefore: 0, notAfter: 1 }],
        });

        const result = await request(server.getApplication()).get(`${baseUrl}/${hash}?domain=disabled-alias.gg`);

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ encryptPreference: { preferEncrypt: "nopreference" }, keys: [], escrow: false });
    });

    it("Rate limits repeated requests for the same hash (429).", async () => {
        const rateLimiter: any = objectFactory.getInstance(RateLimiter);
        const original = rateLimiter.config;
        rateLimiter.config = { enabled: true, maxAttempts: 2, windowSeconds: 300, ip: { enabled: false } };
        try {
            const mailbox = await createMailbox();

            expect((await request(server.getApplication()).get(`${baseUrl}/${mailbox.keyDiscoveryHash}`)).status).toBe(200);
            expect((await request(server.getApplication()).get(`${baseUrl}/${mailbox.keyDiscoveryHash}`)).status).toBe(200);
            const third = await request(server.getApplication()).get(`${baseUrl}/${mailbox.keyDiscoveryHash}`);

            expect(third.status).toBe(429);
        } finally {
            rateLimiter.config = original;
        }
    });
});
