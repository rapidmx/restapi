///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { AccessControlListSQL, ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import * as models from "../../../src/sql.js";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport } from "../../testDoubles.js";
import { mailRoutesReviewSuite, ReviewRowKind } from "../mailRoutesReviewSuite.js";

const KINDS: ReadonlySet<string> = new Set<string>(["Mailbox", "Folder", "Message", "Attachment", "Matter", "Label", "CalendarShareLink", "DistributionList", "MailFilterRule", "IngestQueueEntry", "QuarantineEntry", "DataExportRequest", "MailboxImportRequest", "DataSubjectErasureRequest", "AuditLogEntry", "CalendarEvent", "RetentionPolicy", "Branding", "Plugin", "EscrowScope", "KeyVault", "TransportRule", "Domain", "MatterExportRequest", "RetentionPolicy"]);
const CLASSES: Record<string, any> = new Proxy({}, { get: (_t, kind: string) => (models as any)[kind + "SQL"] });

describe("Route:SQL mail authorization (routes review fixes)", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let sql: any;
    let aclRepo: Repository<AccessControlListSQL>;
    const repo = (kind: ReviewRowKind): Repository<any> => sql.getRepository(CLASSES[kind]);

    beforeAll(async () => {
        registerTestDoubles(objectFactory);
        await server.start();
        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const aclConn: any = connMgr?.connections.get("acl");
        const conn: any = connMgr?.connections.get("sql");
        if (!isSqlDataSource(aclConn) || !isSqlDataSource(conn)) {
            throw new Error("Could not find sql connections");
        }
        aclRepo = aclConn.getRepository(AccessControlListSQL);
        sql = conn;
    });

    afterAll(async () => {
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const kind of [...KINDS] as ReviewRowKind[]) {
            await repo(kind).clear();
        }
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport");
        if (transport) {
            transport.sent = [];
        }
    });

    mailRoutesReviewSuite({
        app: () => server.getApplication(),
        prefix: "/sql",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        save: async (kind, fields) => await repo(kind).save(new CLASSES[kind](fields)),
        findOne: async (kind, uid) => (await repo(kind).findOne({ where: { uid } })) ?? undefined,
        count: async (kind) => await repo(kind).count(),
        findAll: async (kind) => await repo(kind).find(),
        update: async (kind, uid, fields) => {
            await repo(kind).update({ uid }, fields);
        },
        saveAcl: async (acl) => {
            await aclRepo.delete({ uid: acl.uid });
            await aclRepo.save({ ...acl, dateCreated: new Date(), dateModified: new Date(), version: 0 } as any);
        },
        findAcl: async (uid) => (await aclRepo.findOne({ where: { uid } })) ?? undefined,
        searchProvider: () => objectFactory.getInstance<any>("SearchProvider")!,
        ingestSecret: config.get("mail:transport:ingest:secret"),
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        transport: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!,
    });
});
