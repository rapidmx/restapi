///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Runs `keyLocalDiscoverySuite` (key lookup for a recipient on this deployment) against the Mongo fixture server.
import "reflect-metadata";
import config from "../../config.js";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ContactMongo } from "../../../src/models/mongo/ContactMongo.js";
import { DomainMongo } from "../../../src/models/mongo/DomainMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { registerTestDoubles, StaticDnsResolver } from "../../testDoubles.js";
import { keyLocalDiscoverySuite } from "../keyLocalDiscoverySuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("Route:KeyLookupMongo Tests - local discovery", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mailboxRepo: MongoRepository<MailboxMongo>;
    let contactRepo: MongoRepository<ContactMongo>;
    let domainRepo: MongoRepository<DomainMongo>;
    let aclRepo: MongoRepository<any>;
    let mockFetch: ReturnType<typeof vi.fn>;

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
        for (const r of [mailboxRepo, contactRepo, domainRepo]) {
            try {
                await r.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!.records.clear();
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    keyLocalDiscoverySuite({
        app: () => server.getApplication(),
        baseUrl: "/mongo/mailboxes",
        discoveryUrl: "/mongo/.well-known/rapidmx/keys",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        saveMailbox: async (fields) => await mailboxRepo.save(new MailboxMongo(fields as any)),
        saveAcl: async (acl) => {
            await aclRepo.deleteMany({ uid: acl.uid });
            await aclRepo.save({ ...acl, dateCreated: new Date(), dateModified: new Date(), version: 0 });
        },
        setMailboxKeys: async (uid, keys) => {
            await mailboxRepo.updateOne({ uid } as any, { $set: { keys } });
        },
        saveDomain: async (name) => {
            await domainRepo.save(new DomainMongo({ uid: name, name, enabled: true, verified: true, verificationToken: name }));
        },
        findContacts: async (mailboxUid) => await contactRepo.find({ mailboxUid }).toArray(),
        dnsResolver: () => objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!,
        mockFetch: () => mockFetch,
    });
});
