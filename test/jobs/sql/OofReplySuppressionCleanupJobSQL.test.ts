///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for OofReplySuppressionCleanupJobSQL - direct structural copy of
// QuarantineRetentionJobSQL.test.ts. See OofReplySuppressionCleanupJobMongo.test.ts's file header for the full
// rationale.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { In, Repository } from "typeorm";
import config from "../../config.sql.js";
import { OofReplySuppressionCleanupJobSQL } from "../../../src/jobs/sql/OofReplySuppressionCleanupJobSQL.js";
import { OofReplySuppressionSQL } from "../../../src/models/sql/OofReplySuppressionSQL.js";

const RETENTION_DAYS = 30; // matches mail:jobs:oof_suppression_cleanup:retention_days in test/config-defaults.ts
const DAY_MS = 24 * 60 * 60 * 1000;

describe("OofReplySuppressionCleanupJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: OofReplySuppressionCleanupJobSQL;
    let oofReplySuppressionRepo: Repository<OofReplySuppressionSQL>;

    const createEntry = async (data?: Partial<OofReplySuppressionSQL>): Promise<OofReplySuppressionSQL> => {
        const obj = new OofReplySuppressionSQL({
            mailboxUid: uuid.v4(),
            senderAddress: "sender@example.com",
            lastRepliedAt: new Date(),
            ...data,
        });
        return await oofReplySuppressionRepo.save(obj);
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("OofReplySuppressionSQL", OofReplySuppressionSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        oofReplySuppressionRepo = conn.getRepository(OofReplySuppressionSQL);

        job = await objectFactory.newInstance(OofReplySuppressionCleanupJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await oofReplySuppressionRepo.clear();
        (job as any).batchSize = config.get("mail:jobs:oof_suppression_cleanup:batch_size") ?? 500;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:oof_suppression_cleanup:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no suppression entries.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Does nothing when oofReplySuppressionRepo is not yet initialized.", async () => {
        const original = (job as any).oofReplySuppressionRepo;
        (job as any).oofReplySuppressionRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).oofReplySuppressionRepo = original;
        }
    });

    it("Purges an entry whose lastRepliedAt is older than the retention cutoff.", async () => {
        const old = await createEntry({ lastRepliedAt: new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS) });

        await job.run();

        const found = await oofReplySuppressionRepo.findOne({ where: { uid: old.uid } });
        expect(found).toBeNull();
    });

    it("Keeps an entry whose lastRepliedAt is within the retention window.", async () => {
        const recent = await createEntry({ lastRepliedAt: new Date(Date.now() - (RETENTION_DAYS - 5) * DAY_MS) });

        await job.run();

        const found = await oofReplySuppressionRepo.findOne({ where: { uid: recent.uid } });
        expect(found).not.toBeNull();
    });

    it("Bounds how many expired entries are purged per run to the configured batch size.", async () => {
        (job as any).batchSize = 2;
        const oldDate = new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS);
        const entries = await Promise.all([
            createEntry({ lastRepliedAt: oldDate }),
            createEntry({ lastRepliedAt: oldDate }),
            createEntry({ lastRepliedAt: oldDate }),
        ]);

        await job.run();

        const remaining = await oofReplySuppressionRepo.find({ where: { uid: In(entries.map((e) => e.uid)) } });
        expect(remaining.length).toBe(1);
    });

    it("Logs a warning and continues purging subsequent entries when one delete throws.", async () => {
        const oldDate = new Date(Date.now() - (RETENTION_DAYS + 5) * DAY_MS);
        const badEntry = await createEntry({ lastRepliedAt: oldDate });
        const goodEntry = await createEntry({ lastRepliedAt: oldDate });

        const repoUtils = (job as any).oofReplySuppressionRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: string, opts: any) => {
            if (uid === badEntry.uid) {
                throw new Error("simulated database failure");
            }
            return originalDelete(uid, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const badFound = await oofReplySuppressionRepo.findOne({ where: { uid: badEntry.uid } });
        const goodFound = await oofReplySuppressionRepo.findOne({ where: { uid: goodEntry.uid } });
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });
});
