///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Runs `keyLocalDiscoverySuite` (key lookup for a recipient on this deployment) against the SQL fixture server.
import "reflect-metadata";
import config from "../../config.sql.js";
import { Server, ObjectFactory, ConnectionManager, AccessControlListSQL, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import { ContactSQL } from "../../../src/models/sql/ContactSQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { registerTestDoubles, StaticDnsResolver } from "../../testDoubles.js";
import { keyLocalDiscoverySuite } from "../keyLocalDiscoverySuite.js";

describe("Route:KeyLookupSQL Tests - local discovery", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let mailboxRepo: Repository<MailboxSQL>;
    let contactRepo: Repository<ContactSQL>;
    let domainRepo: Repository<DomainSQL>;
    let aclRepo: Repository<AccessControlListSQL>;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        let conn: any = connMgr?.connections.get("acl");
        if (isSqlDataSource(conn)) {
            aclRepo = conn.getRepository(AccessControlListSQL);
        } else {
            throw new Error("Could not find sql acl connection");
        }
        conn = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            mailboxRepo = conn.getRepository(MailboxSQL);
            contactRepo = conn.getRepository(ContactSQL);
            domainRepo = conn.getRepository(DomainSQL);
        } else {
            throw new Error("Could not find sql connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await mailboxRepo.clear();
        await contactRepo.clear();
        await domainRepo.clear();
        await aclRepo.clear();
        objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!.records.clear();
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    keyLocalDiscoverySuite({
        app: () => server.getApplication(),
        baseUrl: "/sql/mailboxes",
        discoveryUrl: "/sql/.well-known/rapidmx/keys",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        saveMailbox: async (fields) => await mailboxRepo.save(new MailboxSQL(fields as any)),
        saveAcl: async (acl) => {
            await aclRepo.delete({ uid: acl.uid });
            await aclRepo.save({ ...acl, dateCreated: new Date(), dateModified: new Date(), version: 0 } as any);
        },
        setMailboxKeys: async (uid, keys) => {
            await mailboxRepo.update({ uid }, { keys });
        },
        saveDomain: async (name) => {
            await domainRepo.save(new DomainSQL({ uid: name, name, enabled: true, verified: true, verificationToken: name }));
        },
        findContacts: async (mailboxUid) => await contactRepo.find({ where: { mailboxUid } }),
        dnsResolver: () => objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!,
        mockFetch: () => mockFetch,
    });
});
