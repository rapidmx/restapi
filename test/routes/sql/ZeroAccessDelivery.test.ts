///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { AccessControlListSQL, ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { CalendarEventSQL } from "../../../src/models/sql/CalendarEventSQL.js";
import { EncryptionPolicySQL } from "../../../src/models/sql/EncryptionPolicySQL.js";
import { FolderSQL } from "../../../src/models/sql/FolderSQL.js";
import { IngestQueueEntrySQL } from "../../../src/models/sql/IngestQueueEntrySQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { QuarantineEntrySQL } from "../../../src/models/sql/QuarantineEntrySQL.js";
import { ScanResultSQL } from "../../../src/models/sql/ScanResultSQL.js";
import { TransportRuleSQL } from "../../../src/models/sql/TransportRuleSQL.js";
import { ZeroAccessIndexEntrySQL } from "../../../src/models/sql/ZeroAccessIndexEntrySQL.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";
import { zeroAccessDeliverySuite } from "../zeroAccessDeliverySuite.js";

describe("Zero-access delivery (SQL)", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const classes = [
        MailboxSQL,
        IngestQueueEntrySQL,
        MessageSQL,
        ZeroAccessIndexEntrySQL,
        QuarantineEntrySQL,
        AttachmentSQL,
        EncryptionPolicySQL,
        TransportRuleSQL,
        FolderSQL,
        ScanResultSQL,
        CalendarEventSQL,
    ];
    const repos = new Map<any, Repository<any>>();
    let aclRepo: Repository<AccessControlListSQL>;
    const repo = (cls: any): Repository<any> => repos.get(cls)!;

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        const aclConn: any = connMgr?.connections.get("acl");
        if (!isSqlDataSource(conn) || !isSqlDataSource(aclConn)) {
            throw new Error("Could not find the sql connections");
        }
        for (const cls of classes) {
            repos.set(cls, conn.getRepository(cls));
        }
        aclRepo = aclConn.getRepository(AccessControlListSQL);
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const r of [...repos.values(), aclRepo]) {
            await r.clear();
        }
        ((objectFactory.getInstance<InMemoryBlobStore>("BlobStore")! as any).store as Map<string, Buffer>).clear();
    });

    zeroAccessDeliverySuite({
        app: () => server.getApplication(),
        baseUrl: "/sql/internal/mta",
        secret: config.get("mail:transport:ingest:secret"),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        createMailbox: async (data?: any) =>
            repo(MailboxSQL).save(
                new MailboxSQL({
                    ownerUserUid: uuid.v4(),
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: [],
                    displayName: "Test Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                    ...data,
                }),
            ),
        updateMailbox: async (uid, fields) => {
            await repo(MailboxSQL).update({ uid }, fields);
        },
        setAllowZeroAccess: async (allow) => {
            await repo(EncryptionPolicySQL).clear();
            if (allow !== undefined) {
                await repo(EncryptionPolicySQL).save(new EncryptionPolicySQL({ uid: "encryption-policy", allowZeroAccess: allow }));
            }
        },
        setAcl: async (mailboxUid, records) => {
            await aclRepo.save({ uid: mailboxUid, dateCreated: new Date(), dateModified: new Date(), version: 0, records, parentUid: "Mailbox" } as any);
        },
        createTransportRule: async (data) =>
            repo(TransportRuleSQL).save(new TransportRuleSQL({ name: "Rule", enabled: true, sequence: 0, stopProcessingRules: false, conditions: {}, actions: [], ...data })),
        entries: () => repo(IngestQueueEntrySQL).find(),
        messages: () => repo(MessageSQL).find(),
        indexEntries: () => repo(ZeroAccessIndexEntrySQL).find(),
        quarantineEntries: () => repo(QuarantineEntrySQL).find(),
        attachments: () => repo(AttachmentSQL).find(),
        calendarEvents: () => repo(CalendarEventSQL).find(),
        createCalendarEvent: async (data) => repo(CalendarEventSQL).save(new CalendarEventSQL(data)),
    });
});
