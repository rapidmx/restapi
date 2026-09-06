///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for MailboxQuotaRecalcJobSQL: a real SQLite (better-sqlite3) connection and
// a real `ObjectFactory` construct the job exactly as production wiring would - see
// MailboxQuotaRecalcJobMongo.test.ts's file header for the full rationale (also applies here verbatim). Uses
// `config.sql.ts`, whose `acl` datastore is ALSO SQL-backed (`AccessControlListSQL`, auto-selected by `ACLUtils`
// from the connection's runtime type) - so this file has no MongoDB dependency at all.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { In, Repository } from "typeorm";
import config from "../../config.sql.js";
import { registerTestDoubles } from "../../testDoubles.js";
import { MailboxQuotaRecalcJobSQL } from "../../../src/jobs/sql/MailboxQuotaRecalcJobSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { AttachmentSQL } from "../../../src/models/sql/AttachmentSQL.js";
import { RecipientType } from "../../../src/models/types.js";

describe("MailboxQuotaRecalcJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: MailboxQuotaRecalcJobSQL;
    let mailboxRepo: Repository<MailboxSQL>;
    let messageRepo: Repository<MessageSQL>;
    let attachmentRepo: Repository<AttachmentSQL>;

    const createMailbox = async (data?: Partial<MailboxSQL>): Promise<MailboxSQL> => {
        const obj = new MailboxSQL({
            ownerUserUid: uuid.v4(),
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            displayName: "Test Mailbox",
            timezone: "UTC",
            quotaBytes: 1000000000,
            usedBytes: 0,
            ...data,
        });
        return await mailboxRepo.save(obj);
    };

    const createMessage = async (mailboxUid: string, data?: Partial<MessageSQL>): Promise<MessageSQL> => {
        const obj = new MessageSQL({
            folderUid: uuid.v4(),
            mailboxUid,
            messageId: `<${uuid.v4()}@example.com>`,
            subject: "Test",
            from: { address: "sender@example.com", type: RecipientType.TO },
            bodyBlobKey: `body/${uuid.v4()}`,
            hasAttachments: false,
            ...data,
        });
        return await messageRepo.save(obj);
    };

    const createAttachment = async (messageUid: string, mailboxUid: string, data?: Partial<AttachmentSQL>): Promise<AttachmentSQL> => {
        const obj = new AttachmentSQL({
            messageUid,
            folderUid: uuid.v4(),
            mailboxUid,
            filename: "file.txt",
            mimeType: "text/plain",
            sizeBytes: 0,
            blobKey: `att/${uuid.v4()}`,
            ...data,
        });
        return await attachmentRepo.save(obj);
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        registerTestDoubles(objectFactory);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see MailboxQuotaRecalcJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        // Not auto-discovered here the way `Server`'s `ClassLoader` scan would - a bare TypeORM `DataSource`
        // throws "No metadata found" from `getRepository()` for any entity not explicitly in this map.
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("MailboxSQL", MailboxSQL);
        models.set("MessageSQL", MessageSQL);
        models.set("AttachmentSQL", AttachmentSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        mailboxRepo = conn.getRepository(MailboxSQL);
        messageRepo = conn.getRepository(MessageSQL);
        attachmentRepo = conn.getRepository(AttachmentSQL);

        // Constructed once via real ObjectFactory DI: `@Init` builds its three real `RepoUtils` against the
        // live connection above, and `@Inject("BlobStore")` resolves to the registered test double.
        job = await objectFactory.newInstance(MailboxQuotaRecalcJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        for (const repo of [mailboxRepo, messageRepo, attachmentRepo]) {
            await repo.clear();
        }
        // Restore the job's batch size to the configured default between tests, in case a test overrode it.
        (job as any).batchSize = config.get("mail:jobs:mailbox_quota_recalc:batch_size") ?? 100;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:mailbox_quota_recalc:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no mailboxes.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it.each(["mailboxRepo", "messageRepo", "attachmentRepo", "blobStore"] as const)(
        "Does nothing when %s is not yet initialized.",
        async (field) => {
            const original = (job as any)[field];
            (job as any)[field] = undefined;
            try {
                await expect(job.run()).resolves.toBeUndefined();
            } finally {
                (job as any)[field] = original;
            }
        },
    );

    it("Sums body blob sizes and attachment sizes across every message and updates usedBytes when it drifted.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const mailbox = await createMailbox({ usedBytes: 0 });
        const bodyKey1 = `body/${uuid.v4()}`;
        const bodyKey2 = `body/${uuid.v4()}`;
        await blobStore.put(bodyKey1, Buffer.alloc(1000));
        await blobStore.put(bodyKey2, Buffer.alloc(200));
        const message1 = await createMessage(mailbox.uid, { bodyBlobKey: bodyKey1, hasAttachments: true });
        await createMessage(mailbox.uid, { bodyBlobKey: bodyKey2, hasAttachments: false });
        await createAttachment(message1.uid, mailbox.uid, { sizeBytes: 100 });
        await createAttachment(message1.uid, mailbox.uid, { sizeBytes: 50 });

        await job.run();

        // 1000 (msg1 body) + 150 (msg1 attachments) + 200 (msg2 body) = 1350
        const updated = await mailboxRepo.findOne({ where: { uid: mailbox.uid } });
        expect(updated!.usedBytes).toBe(1350);
        expect(updated!.version).toBe(mailbox.version + 1);
    });

    it("Skips the write entirely when the recomputed usedBytes matches the stored value.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const bodyKey = `body/${uuid.v4()}`;
        await blobStore.put(bodyKey, Buffer.alloc(500));
        const mailbox = await createMailbox({ usedBytes: 500 });
        await createMessage(mailbox.uid, { bodyBlobKey: bodyKey, hasAttachments: false });

        await job.run();

        const updated = await mailboxRepo.findOne({ where: { uid: mailbox.uid } });
        expect(updated!.usedBytes).toBe(500);
        // No write happened at all - the version is unchanged from creation.
        expect(updated!.version).toBe(mailbox.version);
    });

    it("Treats a body blob that fails to size as 0 bytes and still sums the rest.", async () => {
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const mailbox = await createMailbox({ usedBytes: 0 });
        // No blob was ever put at this key, so `blobStore.size()` rejects with a real "no blob" error.
        await createMessage(mailbox.uid, { bodyBlobKey: `body/${uuid.v4()}`, hasAttachments: false });
        const bodyKey2 = `body/${uuid.v4()}`;
        await blobStore.put(bodyKey2, Buffer.alloc(300));
        await createMessage(mailbox.uid, { bodyBlobKey: bodyKey2, hasAttachments: false });

        await job.run();

        const updated = await mailboxRepo.findOne({ where: { uid: mailbox.uid } });
        expect(updated!.usedBytes).toBe(300);
    });

    it("Sums ALL messages in a mailbox, not just the first page, when it has more than one page's worth.", async () => {
        // `RepoUtils.find()` defaults to a 100-row cap when no pagination is requested - `recalcMailbox()` used
        // to call it unpaginated, silently truncating usedBytes to only the first ~100 messages for any larger
        // mailbox. Uses a small page size (10) via a stubbed default so 25 messages genuinely spans multiple
        // pages without the test needing to create 100+ real rows.
        const findAllPages = (job as any).findAllPages.bind(job);
        const pageSizeSpy = vi
            .spyOn(job as any, "findAllPages")
            .mockImplementation((repo: any, criteria: any) => findAllPages(repo, criteria, 10));
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const bodyKey = `body/${uuid.v4()}`;
        await blobStore.put(bodyKey, Buffer.alloc(10));
        const mailbox = await createMailbox({ usedBytes: 0 });
        const messageCount = 25;
        for (let i = 0; i < messageCount; i++) {
            await createMessage(mailbox.uid, { bodyBlobKey: bodyKey, hasAttachments: false });
        }

        await job.run();

        const updated = await mailboxRepo.findOne({ where: { uid: mailbox.uid } });
        expect(updated!.usedBytes).toBe(messageCount * 10);
        pageSizeSpy.mockRestore();
    });

    it("Bounds how many mailboxes are processed per run to the configured batch size.", async () => {
        (job as any).batchSize = 2;
        const bodyKey = `body/${uuid.v4()}`;
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        await blobStore.put(bodyKey, Buffer.alloc(42));
        const mailboxes = [];
        for (let i = 0; i < 3; i++) {
            const mailbox = await createMailbox({ usedBytes: 0 });
            await createMessage(mailbox.uid, { bodyBlobKey: bodyKey, hasAttachments: false });
            mailboxes.push(mailbox);
        }

        await job.run();

        const updatedMailboxes = await mailboxRepo.find({ where: { uid: In(mailboxes.map((m) => m.uid)) } });
        const processedCount = updatedMailboxes.filter((m) => m.usedBytes === 42).length;
        expect(processedCount).toBe(2);
    });

    it("Logs an error and continues with the next mailbox when recalculating one mailbox throws.", async () => {
        // Real infrastructure has no deterministic, non-destructive way to make a single mailbox's own
        // recalculation throw (a plain query against a healthy DB simply succeeds) - this targets a fault at
        // the one seam real infra can't reach: the job's own internal `RepoUtils.find()` call for the "bad"
        // mailbox's messages, restored immediately after so every other call in this test still goes to the
        // real database. See MailboxQuotaRecalcJobMongo.test.ts's equivalent test for the full rationale.
        const blobStore = objectFactory.getInstance<any>("BlobStore")!;
        const bodyKey = `body/${uuid.v4()}`;
        await blobStore.put(bodyKey, Buffer.alloc(42));
        const badMailbox = await createMailbox({ usedBytes: 0 });
        const goodMailbox = await createMailbox({ usedBytes: 0 });
        await createMessage(goodMailbox.uid, { bodyBlobKey: bodyKey, hasAttachments: false });

        const messageRepoUtils = (job as any).messageRepo;
        const originalFind = messageRepoUtils.find.bind(messageRepoUtils);
        vi.spyOn(messageRepoUtils, "find").mockImplementation(async (query: any, opts: any) => {
            if (query.mailboxUid === badMailbox.uid) {
                throw new Error("simulated database failure");
            }
            return originalFind(query, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const updatedBad = await mailboxRepo.findOne({ where: { uid: badMailbox.uid } });
        const updatedGood = await mailboxRepo.findOne({ where: { uid: goodMailbox.uid } });
        expect(updatedBad!.usedBytes).toBe(0);
        expect(updatedGood!.usedBytes).toBe(42);
    });
});
