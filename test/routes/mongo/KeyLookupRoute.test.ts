///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { request } from "@rapidrest/service-core/test";
import { ACLRecord, MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager, ACLAction } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles, StaticDnsResolver } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

function makeDiscoveryResponse(fingerprint: string) {
    return {
        encryptPreference: { preferEncrypt: "mutual", lastSeen: 100 },
        keys: [{ publicKey: "b64", type: "x509", useType: "encrypt", fingerprint, notBefore: 0, notAfter: Date.now() + 1_000_000 }],
        escrow: false,
    };
}

describe("Route:KeyLookupMongo Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/mailboxes";
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let contactRepo: MongoRepository<ContactMongo>;
    let aclRepo: MongoRepository<any>;
    let mockFetch: ReturnType<typeof vi.fn>;

    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const ownerToken = JWTUtils.createTokenSync(config.get("auth"), owner);
    const otherUser: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const otherUserToken = JWTUtils.createTokenSync(config.get("auth"), otherUser);

    const createMailbox = async function (): Promise<MailboxMongo> {
        const obj = new MailboxMongo({
            ownerUserUid: owner.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        const result: MailboxMongo = await mailboxRepo.save(obj);
        await aclRepo.save({
            uid: result.uid,
            dateCreated: new Date(),
            dateModified: new Date(),
            version: 0,
            records: [{ userOrRoleId: owner.uid, actions: [ACLAction.FULL] }] as ACLRecord[],
            parentUid: "Mailbox",
        });
        return result;
    };

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (conn instanceof MongoConnection) {
            aclRepo = conn.getMongoRepository("AccessControlListMongo");
        }
        conn = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            mailboxRepo = conn.getMongoRepository("MailboxMongo");
            contactRepo = conn.getMongoRepository("ContactMongo");
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
        for (const r of [mailboxRepo, contactRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    it("Discovers a federated peer's keys, creates a new Contact in the mailbox's address book, and returns the keys.", async () => {
        const mailbox = await createMailbox();
        const addr = `alice@participating-lookup-1.example.com`;
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue(makeDiscoveryResponse("fp-1")),
            headers: { get: () => null },
        });
        const dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
        dnsResolver.records.set("_rapidmx.participating-lookup-1.example.com", [
            ["v=RMXv1; id=1; host=mail.participating-lookup-1.example.com;"],
        ]);

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.uid}/keys/lookup?addr=${encodeURIComponent(addr)}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.keys).toHaveLength(1);
        expect(result.body.keys[0].fingerprint).toBe("fp-1");

        const contacts = await contactRepo.find({ mailboxUid: mailbox.uid }).toArray();
        expect(contacts).toHaveLength(1);
        expect(contacts[0].emails).toEqual([{ address: addr, type: "other" }]);
        expect(contacts[0].keys).toHaveLength(1);
    });

    it("A second lookup for the same address updates the existing Contact rather than creating a duplicate.", async () => {
        const mailbox = await createMailbox();
        const addr = `bob@participating-lookup-2.example.com`;
        const dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
        dnsResolver.records.set("_rapidmx.participating-lookup-2.example.com", [
            ["v=RMXv1; id=1; host=mail.participating-lookup-2.example.com;"],
        ]);
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue(makeDiscoveryResponse("fp-2")),
            headers: { get: () => null },
        });

        await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.uid}/keys/lookup?addr=${encodeURIComponent(addr)}`)
            .set("Authorization", "jwt " + ownerToken);
        await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.uid}/keys/lookup?addr=${encodeURIComponent(addr)}`)
            .set("Authorization", "jwt " + ownerToken);

        const contacts = await contactRepo.find({ mailboxUid: mailbox.uid }).toArray();
        expect(contacts).toHaveLength(1);
    });

    it("Returns 404 when the domain isn't a federated peer and there's no existing Contact to fall back to.", async () => {
        const mailbox = await createMailbox();
        const addr = `nobody@non-participating-lookup.example.com`;
        // No entry registered for this domain in `StaticDnsResolver` - it throws (matching NXDOMAIN), which
        // `resolveFederationPolicy()` treats as "not a federated peer".

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.uid}/keys/lookup?addr=${encodeURIComponent(addr)}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
    });

    it("Falls back to the existing Contact's keys (Anti-Downgrade) when the domain is no longer a federated peer.", async () => {
        const mailbox = await createMailbox();
        const addr = `carol@non-participating-lookup-3.example.com`;
        // Directly seeds an existing Contact, bypassing the lookup route entirely - this is what "already
        // pinned from an earlier lookup" looks like, without depending on `fetchRemoteKeys()`'s own
        // internal cache (which would otherwise make a rejected fetch fall back to *its* cached response
        // instead of genuinely exercising this route's own Anti-Downgrade fallback).
        await contactRepo.save(
            new ContactMongo({
                mailboxUid: mailbox.uid,
                folderUid: uuid.v4(),
                displayName: addr,
                emails: [{ address: addr, type: "other" as any }],
                phones: [],
                addresses: [],
                keys: [{ publicKey: "b64", type: "x509", useType: "encrypt", fingerprint: "fp-3", notBefore: 0, notAfter: Date.now() + 1_000_000 }],
                encryptPreference: { preferEncrypt: "mutual", lastSeen: 1 },
            }),
        );
        // No entry registered for this domain in `StaticDnsResolver` - not (or no longer) a federated peer.

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.uid}/keys/lookup?addr=${encodeURIComponent(addr)}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.keys[0].fingerprint).toBe("fp-3");
    });

    it("Falls back to an empty keys array for an existing Contact that has never had any keys assigned.", async () => {
        const mailbox = await createMailbox();
        const addr = `dave@non-participating-lookup-4.example.com`;
        await contactRepo.save(
            new ContactMongo({
                mailboxUid: mailbox.uid,
                folderUid: uuid.v4(),
                displayName: addr,
                emails: [{ address: addr, type: "other" as any }],
                phones: [],
                addresses: [],
            }),
        );

        const result = await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.uid}/keys/lookup?addr=${encodeURIComponent(addr)}`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(200);
        expect(result.body.keys).toEqual([]);
    });

    it("Rejects a request with no addr query parameter (400).", async () => {
        const mailbox = await createMailbox();
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.uid}/keys/lookup`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(400);
    });

    it("Returns 404 for a nonexistent mailbox.", async () => {
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${uuid.v4()}/keys/lookup?addr=x@example.com`)
            .set("Authorization", "jwt " + ownerToken);

        expect(result.status).toBe(404);
    });

    it("A different, unrelated user cannot look up keys through someone else's mailbox (403).", async () => {
        const mailbox = await createMailbox();
        const result = await request(server.getApplication())
            .get(`${baseUrl}/${mailbox.uid}/keys/lookup?addr=x@example.com`)
            .set("Authorization", "jwt " + otherUserToken);

        expect(result.status).toBe(403);
    });
});
