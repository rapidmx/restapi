///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import config from "../../config.sql.js";
import { AccessControlListSQL, ConnectionManager, isSqlDataSource, ObjectFactory, Server } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import { Repository } from "typeorm";
import {
    AttachmentSQL,
    CalendarShareLinkSQL,
    ContactSQL,
    DomainSQL,
    FolderSQL,
    IngestQueueEntrySQL,
    LabelSQL,
    MailboxSQL,
    MatterSQL,
    MessageSQL,
    QuarantineEntrySQL,
} from "../../../src/sql.js";
import { registerTestDoubles, InMemoryBlobStore, NoopSearchProvider, RecordingMailTransport } from "../../testDoubles.js";
import { mailAuthzRound3Suite, RowKind } from "../mailAuthzRound3Suite.js";

const CLASSES: Record<RowKind, any> = {
    Mailbox: MailboxSQL,
    Folder: FolderSQL,
    Message: MessageSQL,
    Attachment: AttachmentSQL,
    Contact: ContactSQL,
    QuarantineEntry: QuarantineEntrySQL,
    IngestQueueEntry: IngestQueueEntrySQL,
    Matter: MatterSQL,
    Label: LabelSQL,
    CalendarShareLink: CalendarShareLinkSQL,
    Domain: DomainSQL,
};

describe("Route:SQL mail authorization (round 3)", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let sql: any;
    let aclRepo: Repository<AccessControlListSQL>;
    const repo = (kind: RowKind): Repository<any> => sql.getRepository(CLASSES[kind]);

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
        for (const kind of Object.keys(CLASSES) as RowKind[]) {
            await repo(kind).clear();
        }
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport");
        if (transport) {
            transport.sent = [];
        }
    });

    mailAuthzRound3Suite({
        app: () => server.getApplication(),
        prefix: "/sql",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        save: async (kind, fields) => await repo(kind).save(new CLASSES[kind](fields)),
        findOne: async (kind, uid) => (await repo(kind).findOne({ where: { uid } })) ?? undefined,
        update: async (kind, uid, fields) => {
            await repo(kind).update({ uid }, fields);
        },
        saveAcl: async (acl) => {
            await aclRepo.delete({ uid: acl.uid });
            await aclRepo.save({ ...acl, dateCreated: new Date(), dateModified: new Date(), version: 0 } as any);
        },
        findAcl: async (uid) => (await aclRepo.findOne({ where: { uid } })) ?? undefined,
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        transport: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!,
        searchProvider: () => objectFactory.getInstance<NoopSearchProvider>("SearchProvider")!,
    });
});
