///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.js";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { MongoMemoryServer } from "mongodb-memory-server";
import * as models from "../../../src/mongo.js";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport } from "../../testDoubles.js";
import { mailRoutesReviewSuite, ReviewRowKind } from "../mailRoutesReviewSuite.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

const KINDS: ReadonlySet<string> = new Set<string>(["Mailbox", "Folder", "Message", "Attachment", "Matter", "Label", "CalendarShareLink", "DistributionList", "MailFilterRule", "IngestQueueEntry", "QuarantineEntry", "DataExportRequest", "MailboxImportRequest", "DataSubjectErasureRequest", "AuditLogEntry", "CalendarEvent", "RetentionPolicy", "Branding", "Plugin", "EscrowScope", "KeyVault", "TransportRule", "Domain", "MatterExportRequest"]);
const CLASSES: Record<string, any> = new Proxy({}, { get: (_t, kind: string) => (models as any)[kind + "Mongo"] });

describe("Route:Mongo mail authorization (routes review fixes)", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    let mongo: MongoConnection;
    let aclRepo: MongoRepository<any>;
    const repo = (kind: ReviewRowKind): MongoRepository<any> => mongo.getMongoRepository(CLASSES[kind].name);

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();
        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const aclConn: any = connMgr?.connections.get("acl");
        const conn: any = connMgr?.connections.get("mongo");
        if (!(aclConn instanceof MongoConnection) || !(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connections");
        }
        aclRepo = aclConn.getMongoRepository("AccessControlListMongo");
        mongo = conn;
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const kind of [...KINDS] as ReviewRowKind[]) {
            try {
                await repo(kind).clear();
            } catch (err: any) {
                if (err.message !== "ns not found") {
                    throw err;
                }
            }
        }
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport");
        if (transport) {
            transport.sent = [];
        }
    });

    mailRoutesReviewSuite({
        app: () => server.getApplication(),
        prefix: "/mongo",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        save: async (kind, fields) => await repo(kind).save(new CLASSES[kind](fields)),
        findOne: async (kind, uid) => (await repo(kind).findOne({ uid } as any)) ?? undefined,
        count: async (kind) => await repo(kind).count({} as any),
        findAll: async (kind) => await repo(kind).find({} as any).toArray(),
        update: async (kind, uid, fields) => {
            await repo(kind).updateOne({ uid } as any, { $set: fields });
        },
        saveAcl: async (acl) => {
            await aclRepo.deleteMany({ uid: acl.uid });
            await aclRepo.save({ ...acl, dateCreated: new Date(), dateModified: new Date(), version: 0 });
        },
        findAcl: async (uid) => (await aclRepo.findOne({ uid } as any)) ?? undefined,
        searchProvider: () => objectFactory.getInstance<any>("SearchProvider")!,
        ingestSecret: config.get("mail:transport:ingest:secret"),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        transport: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!,
    });
});
