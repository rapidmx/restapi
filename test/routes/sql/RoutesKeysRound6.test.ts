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
    DistributionListSQL,
    FocusedInboxOverrideSQL,
    FolderSQL,
    LabelSQL,
    MailboxSQL,
    MailFilterRuleSQL,
    MatterSQL,
    MessageSQL,
    TaskSQL,
    TransportRuleSQL,
} from "../../../src/sql.js";
import { registerTestDoubles, InMemoryBlobStore, RecordingMailTransport } from "../../testDoubles.js";
import { type Round4RowKind } from "../mailAuthzRound4Suite.js";
import { routesKeysRound6Suite } from "../routesKeysRound6Suite.js";

const CLASSES: Record<Round4RowKind, any> = {
    Mailbox: MailboxSQL,
    Folder: FolderSQL,
    Message: MessageSQL,
    Attachment: AttachmentSQL,
    Matter: MatterSQL,
    Label: LabelSQL,
    CalendarShareLink: CalendarShareLinkSQL,
    Task: TaskSQL,
    DistributionList: DistributionListSQL,
    TransportRule: TransportRuleSQL,
    FocusedInboxOverride: FocusedInboxOverrideSQL,
    MailFilterRule: MailFilterRuleSQL,
};

describe("Route:SQL mailbox and attachment routes (round 6, part B)", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    let sql: any;
    let aclRepo: Repository<AccessControlListSQL>;
    const repo = (kind: Round4RowKind): Repository<any> => sql.getRepository(CLASSES[kind]);

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
        for (const kind of Object.keys(CLASSES) as Round4RowKind[]) {
            await repo(kind).clear();
        }
        const transport = objectFactory.getInstance<RecordingMailTransport>("MailTransport");
        if (transport) {
            transport.sent = [];
        }
    });

    routesKeysRound6Suite({
        app: () => server.getApplication(),
        prefix: "/sql",
        tokenFor: (user) => JWTUtils.createTokenSync(config.get("auth"), user),
        save: async (kind, fields) => await repo(kind).save(new CLASSES[kind](fields)),
        findOne: async (kind, uid) => (await repo(kind).findOne({ where: { uid } })) ?? undefined,
        count: async (kind) => await repo(kind).count(),
        update: async (kind, uid, fields) => {
            await repo(kind).update({ uid }, fields);
        },
        saveAcl: async (acl) => {
            await aclRepo.delete({ uid: acl.uid });
            await aclRepo.save({ ...acl, dateCreated: new Date(), dateModified: new Date(), version: 0 } as any);
        },
        findAcl: async (uid) => (await aclRepo.findOne({ where: { uid } })) ?? undefined,
        objectFactory: () => objectFactory,
        folderClass: CLASSES.Folder,
        blobStore: () => objectFactory.getInstance<InMemoryBlobStore>("BlobStore")!,
        transport: () => objectFactory.getInstance<RecordingMailTransport>("MailTransport")!,
    });
});
