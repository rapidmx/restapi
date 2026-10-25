///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { ConnectionManager, MongoConnection, MongoRepository, ObjectFactory, Server } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MongoMemoryServer } from "mongodb-memory-server";
import { AttachmentMongo } from "../../../src/models/mongo/AttachmentMongo.js";
import { CalendarEventMongo } from "../../../src/models/mongo/CalendarEventMongo.js";
import { FolderMongo } from "../../../src/models/mongo/FolderMongo.js";
import { MessageMongo } from "../../../src/models/mongo/MessageMongo.js";
import { EncryptionPolicyMongo } from "../../../src/models/mongo/EncryptionPolicyMongo.js";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { DataSubjectErasureRequestMongo } from "../../../src/models/mongo/DataSubjectErasureRequestMongo.js";
import { TransportRuleMongo } from "../../../src/models/mongo/TransportRuleMongo.js";
import { InMemoryBlobStore, registerTestDoubles } from "../../testDoubles.js";
import { zeroAccessDeliverySuite } from "../zeroAccessDeliverySuite.js";
import { zeroAccessIndexSuite } from "../zeroAccessIndexSuite.js";
import { ZeroAccessBackfillJobMongo } from "../../../src/jobs/mongo/ZeroAccessBackfillJobMongo.js";
import { ScheduledSendJobMongo } from "../../../src/jobs/mongo/ScheduledSendJobMongo.js";
import { ZeroAccessIndexEntryMongo } from "../../../src/models/mongo/ZeroAccessIndexEntryMongo.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({ instance: { port: 9999, dbName: "rrst-test" } });

describe("Zero-access delivery (Mongo)", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const repos: Record<string, MongoRepository<any>> = {};
    const names = [
        "MailboxMongo",
        "IngestQueueEntryMongo",
        "MessageMongo",
        "ZeroAccessIndexEntryMongo",
        "ZeroAccessIndexSegmentMongo",
        "QuarantineEntryMongo",
        "AttachmentMongo",
        "EncryptionPolicyMongo",
        "TransportRuleMongo",
        "FolderMongo",
        "ScanResultMongo",
        "CalendarEventMongo",
        "DataSubjectErasureRequestMongo",
    ];

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        const conn: any = objectFactory.getInstance(ConnectionManager)?.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        for (const name of names) {
            repos[name] = conn.getMongoRepository(name);
        }
        const aclConn: any = objectFactory.getInstance(ConnectionManager)?.connections.get("acl");
        if (aclConn instanceof MongoConnection) {
            repos.AccessControlListMongo = aclConn.getMongoRepository("AccessControlListMongo");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of Object.values(repos)) {
            try {
                await repo.clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        ((objectFactory.getInstance<InMemoryBlobStore>("BlobStore")! as any).store as Map<string, Buffer>).clear();
    });

    zeroAccessDeliverySuite({
        app: () => server.getApplication(),
        baseUrl: "/mongo/internal/mta",
        secret: config.get("mail:transport:ingest:secret"),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        createMailbox: async (data?: any) =>
            repos.MailboxMongo.save(
                new MailboxMongo({
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
            await repos.MailboxMongo.updateOne({ uid }, { $set: fields });
        },
        setAllowZeroAccess: async (allow) => {
            await repos.EncryptionPolicyMongo.clear();
            if (allow !== undefined) {
                await repos.EncryptionPolicyMongo.save(new EncryptionPolicyMongo({ uid: "encryption-policy", allowZeroAccess: allow }));
            }
        },
        setAcl: async (mailboxUid, records) => {
            await repos.AccessControlListMongo.save({ uid: mailboxUid, dateCreated: new Date(), dateModified: new Date(), version: 0, records, parentUid: "Mailbox" });
        },
        createTransportRule: async (data) =>
            repos.TransportRuleMongo.save(new TransportRuleMongo({ name: "Rule", enabled: true, sequence: 0, stopProcessingRules: false, conditions: {}, actions: [], ...data })),
        entries: () => repos.IngestQueueEntryMongo.find({}).toArray(),
        messages: () => repos.MessageMongo.find({}).toArray(),
        indexEntries: () => repos.ZeroAccessIndexEntryMongo.find({}).toArray(),
        quarantineEntries: () => repos.QuarantineEntryMongo.find({}).toArray(),
        attachments: () => repos.AttachmentMongo.find({}).toArray(),
        calendarEvents: () => repos.CalendarEventMongo.find({}).toArray(),
        createCalendarEvent: async (data) => repos.CalendarEventMongo.save(new CalendarEventMongo(data)),
        messagesUrl: "/mongo/messages",
        calendarEventsUrl: "/mongo/calendar-events",
        tokenFor: (uid) => JWTUtils.createTokenSync(config.get("auth"), { uid, roles: [] } as any),
        createFolder: async (mailboxUid, type) => {
            const folder = await repos.FolderMongo.save(new FolderMongo({ mailboxUid, name: type, type: type as any, unreadCount: 0, totalCount: 0, syncKeyVersion: 0 }));
            await repos.AccessControlListMongo.save({ uid: folder.uid, dateCreated: new Date(), dateModified: new Date(), version: 0, records: [], parentUid: mailboxUid });
            return folder;
        },
        createMessage: async (data) =>
            repos.MessageMongo.save(
                new MessageMongo({
                    messageId: `${uuid.v4()}@example.com`,
                    sentDate: new Date(),
                    receivedDate: new Date(),
                    flags: { read: false, flagged: false, answered: false, forwarded: false },
                    importance: "normal" as any,
                    references: [],
                    ...data,
                }),
            ),
        createAttachment: async (data) => repos.AttachmentMongo.save(new AttachmentMongo(data)),
        findMessage: (uid) => repos.MessageMongo.findOne({ uid } as any),
        updateMessage: async (uid, fields) => {
            await repos.MessageMongo.updateOne({ uid } as any, { $set: fields });
        },
        createErasureRequest: async (mailboxUid, status) =>
            repos.DataSubjectErasureRequestMongo.save(new DataSubjectErasureRequestMongo({ mailboxUid, requestedByUserUid: uuid.v4(), status })),
        runBackfill: async () => {
            const job = await objectFactory.newInstance<ZeroAccessBackfillJobMongo>(ZeroAccessBackfillJobMongo, { name: `za-backfill-${uuid.v4()}` });
            await job.run();
        },
        runScheduledSend: async () => {
            const job = await objectFactory.newInstance<ScheduledSendJobMongo>(ScheduledSendJobMongo, { name: `za-send-${uuid.v4()}` });
            await job.run();
        },
    });

    zeroAccessIndexSuite({
        app: () => server.getApplication(),
        mailboxesUrl: "/mongo/mailboxes",
        tokenFor: (uid) => JWTUtils.createTokenSync(config.get("auth"), { uid, roles: [] } as any),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        createMailbox: async (data?: any) =>
            repos.MailboxMongo.save(
                new MailboxMongo({
                    primarySmtpAddress: `${uuid.v4()}@example.com`,
                    aliasAddresses: [],
                    displayName: "Index Mailbox",
                    timezone: "UTC",
                    quotaBytes: 1_000_000_000,
                    usedBytes: 0,
                    ...data,
                }),
            ),
        createIndexEntry: async (data) => repos.ZeroAccessIndexEntryMongo.save(new ZeroAccessIndexEntryMongo(data)),
        indexEntries: () => repos.ZeroAccessIndexEntryMongo.find({}).toArray(),
        findSegment: (uid) => repos.ZeroAccessIndexSegmentMongo.findOne({ uid } as any),
    });
});
