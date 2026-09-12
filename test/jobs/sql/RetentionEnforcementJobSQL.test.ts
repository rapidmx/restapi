///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for RetentionEnforcementJobSQL - see
// QuarantineRetentionJobSQL.test.ts's file header for the full rationale (bypasses `Server`, wires a real
// ObjectFactory/ConnectionManager directly).
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import config from "../../config.sql.js";
import { RetentionEnforcementJobSQL } from "../../../src/jobs/sql/RetentionEnforcementJobSQL.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { MatterSQL } from "../../../src/models/sql/MatterSQL.js";
import { MessageSQL } from "../../../src/models/sql/MessageSQL.js";
import { RetentionPolicySQL } from "../../../src/models/sql/RetentionPolicySQL.js";
import { AuditAction, AuditLogEntry, RecipientType } from "../../../src/models/types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("RetentionEnforcementJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: RetentionEnforcementJobSQL;
    let retentionPolicyRepo: Repository<RetentionPolicySQL>;
    let messageRepo: Repository<MessageSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;
    let matterRepo: Repository<MatterSQL>;

    const createMessage = async (data?: Partial<MessageSQL>): Promise<MessageSQL> => {
        const obj = new MessageSQL({
            mailboxUid: uuid.v4(),
            folderUid: uuid.v4(),
            messageId: `${uuid.v4()}@example.com`,
            subject: "Test Subject",
            from: { address: "sender@example.com", type: RecipientType.TO },
            recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
            sentDate: new Date(),
            receivedDate: new Date(),
            bodyBlobKey: `bodies/${uuid.v4()}`,
            bodyPreview: "Hello",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            references: [],
            hasAttachments: false,
            ...data,
        });
        return await messageRepo.save(obj);
    };

    const createAuditLogEntry = async (data?: Partial<AuditLogEntry>): Promise<AuditLogEntrySQL> => {
        const obj = new AuditLogEntrySQL({
            action: AuditAction.MAILBOX_CREATE,
            targetType: "Mailbox",
            targetUid: uuid.v4(),
            ...data,
        });
        return await auditLogRepo.save(obj);
    };

    const createMatter = async (data?: Partial<MatterSQL>): Promise<MatterSQL> => {
        const obj = new MatterSQL({
            name: "Test Matter",
            escrowScopeId: uuid.v4(),
            custodianMailboxUids: [],
            dateRangeStart: new Date("2020-01-01"),
            dateRangeEnd: new Date("2030-01-01"),
            ...data,
        });
        return await matterRepo.save(obj);
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("RetentionPolicySQL", RetentionPolicySQL);
        models.set("MessageSQL", MessageSQL);
        models.set("AuditLogEntrySQL", AuditLogEntrySQL);
        models.set("MatterSQL", MatterSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        retentionPolicyRepo = conn.getRepository(RetentionPolicySQL);
        messageRepo = conn.getRepository(MessageSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);
        matterRepo = conn.getRepository(MatterSQL);

        job = await objectFactory.newInstance(RetentionEnforcementJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await retentionPolicyRepo.clear();
        await messageRepo.clear();
        await auditLogRepo.clear();
        await matterRepo.clear();
        (job as any).batchSize = config.get("mail:jobs:retention_enforcement:batch_size") ?? 500;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:retention_enforcement:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when no policy row exists at all.", async () => {
        const message = await createMessage({ sentDate: new Date(Date.now() - 3650 * DAY_MS) });

        await expect(job.run()).resolves.toBeUndefined();

        const found = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(found).not.toBeNull();
    });

    it("Does nothing when a policy row exists but neither field is configured.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy" }));
        const message = await createMessage({ sentDate: new Date(Date.now() - 3650 * DAY_MS) });

        await expect(job.run()).resolves.toBeUndefined();

        const found = await messageRepo.findOne({ where: { uid: message.uid } });
        expect(found).not.toBeNull();
    });

    it("Does nothing when the repos are not yet initialized.", async () => {
        const original = (job as any).messageRepo;
        (job as any).messageRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).messageRepo = original;
        }
    });

    it("Purges a message older than messageRetentionDays and records one audit entry.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS) });

        await job.run();

        const found = await messageRepo.findOne({ where: { uid: old.uid } });
        expect(found).toBeNull();

        const entries = await auditLogRepo.find({ where: { action: AuditAction.RETENTION_PURGE_EXECUTED } });
        expect(entries.length).toBe(1);
        expect(entries[0].targetType).toBe("Message");
        expect(entries[0].details).toEqual({ count: 1, maxAgeDays: 30 });
    });

    it("Keeps a message within the retention window.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const recent = await createMessage({ sentDate: new Date(Date.now() - 5 * DAY_MS) });

        await job.run();

        const found = await messageRepo.findOne({ where: { uid: recent.uid } });
        expect(found).not.toBeNull();
    });

    it("Skips (does not purge) an expired message under an active legal hold, and retries it on a later run once the hold lifts.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const old = await createMessage({ sentDate: new Date(Date.now() - 35 * DAY_MS) });
        const matter = await createMatter({ custodianMailboxUids: [old.mailboxUid] });

        await job.run();

        const stillHeld = await messageRepo.findOne({ where: { uid: old.uid } });
        expect(stillHeld).not.toBeNull();
        const noAuditYet = await auditLogRepo.find({ where: { action: AuditAction.RETENTION_PURGE_EXECUTED } });
        expect(noAuditYet.length).toBe(0);

        await matterRepo.update({ uid: matter.uid }, { closedAt: new Date() });
        await job.run();

        const nowPurged = await messageRepo.findOne({ where: { uid: old.uid } });
        expect(nowPurged).toBeNull();
    });

    it("Purges an AuditLogEntry older than auditLogRetentionDays and records one summary entry for the batch.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const old = await createAuditLogEntry({ dateCreated: new Date(Date.now() - 2200 * DAY_MS) });

        await job.run();

        const found = await auditLogRepo.findOne({ where: { uid: old.uid } });
        expect(found).toBeNull();

        // The summary entry this same run recorded is itself brand new, so only it remains.
        const remaining = await auditLogRepo.find({ where: { action: AuditAction.RETENTION_PURGE_EXECUTED } });
        expect(remaining.length).toBe(1);
        expect(remaining[0].targetType).toBe("AuditLogEntry");
        expect(remaining[0].details).toEqual({ count: 1, maxAgeDays: 2190 });
    });

    it("Keeps an AuditLogEntry within the retention window.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const recent = await createAuditLogEntry();

        await job.run();

        const found = await auditLogRepo.findOne({ where: { uid: recent.uid } });
        expect(found).not.toBeNull();
    });

    it("Bounds how many expired messages are purged per run to the configured batch size.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        (job as any).batchSize = 2;
        const oldDate = new Date(Date.now() - 35 * DAY_MS);
        await Promise.all([createMessage({ sentDate: oldDate }), createMessage({ sentDate: oldDate }), createMessage({ sentDate: oldDate })]);

        await job.run();

        const remaining = await messageRepo.find({ where: { sentDate: oldDate } });
        expect(remaining.length).toBe(1);
    });

    it("Logs a warning and continues purging subsequent messages when one delete throws.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", messageRetentionDays: 30 }));
        const oldDate = new Date(Date.now() - 35 * DAY_MS);
        const badMessage = await createMessage({ sentDate: oldDate });
        const goodMessage = await createMessage({ sentDate: oldDate });

        const repoUtils = (job as any).messageRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: string, opts: any) => {
            if (uid === badMessage.uid) {
                throw new Error("simulated database failure");
            }
            return originalDelete(uid, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const badFound = await messageRepo.findOne({ where: { uid: badMessage.uid } });
        const goodFound = await messageRepo.findOne({ where: { uid: goodMessage.uid } });
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });

    it("Logs a warning and continues purging subsequent audit log entries when one delete throws.", async () => {
        await retentionPolicyRepo.save(new RetentionPolicySQL({ uid: "retention-policy", auditLogRetentionDays: 2190 }));
        const oldDate = new Date(Date.now() - 2200 * DAY_MS);
        const badEntry = await createAuditLogEntry({ dateCreated: oldDate });
        const goodEntry = await createAuditLogEntry({ dateCreated: oldDate });

        const repoUtils = (job as any).auditLogRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: string, opts: any) => {
            if (uid === badEntry.uid) {
                throw new Error("simulated database failure");
            }
            return originalDelete(uid, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const badFound = await auditLogRepo.findOne({ where: { uid: badEntry.uid } });
        const goodFound = await auditLogRepo.findOne({ where: { uid: goodEntry.uid } });
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });
});
