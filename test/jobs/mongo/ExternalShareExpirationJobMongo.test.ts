///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ExternalShareExpirationJobMongo: a real in-memory MongoDB connection
// and a real `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds a
// real `RepoUtils` against the live connection. No repo is hand-mocked. See
// ../../jobs/mongo/ScanQueueJobMongo.test.ts's file header for the full rationale behind bypassing
// `Server`/`ClassLoader`.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { ExternalShareExpirationJobMongo } from "../../../src/jobs/mongo/ExternalShareExpirationJobMongo.js";
import { CalendarShareLinkMongo } from "../../../src/models/mongo/CalendarShareLinkMongo.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

const HOUR_MS = 60 * 60 * 1000;

describe("ExternalShareExpirationJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: ExternalShareExpirationJobMongo;
    let calendarShareLinkRepo: MongoRepository<CalendarShareLinkMongo>;

    const createShareLink = async (data?: Partial<CalendarShareLinkMongo>): Promise<CalendarShareLinkMongo> => {
        const obj = new CalendarShareLinkMongo({
            token: uuid.v4(),
            folderUid: uuid.v4(),
            permittedActions: ["freebusy"],
            createdByUserUid: uuid.v4(),
            ...data,
        });
        return await calendarShareLinkRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see ScanQueueJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("CalendarShareLinkMongo", CalendarShareLinkMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        calendarShareLinkRepo = conn.getMongoRepository("CalendarShareLinkMongo");

        // Constructed once via real ObjectFactory DI: `@Init` builds its one real `RepoUtils` against the live
        // connection above.
        job = await objectFactory.newInstance(ExternalShareExpirationJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        try {
            await calendarShareLinkRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
        // Restore the job's batch size to the configured default between tests, in case a test overrode it.
        (job as any).batchSize = config.get("mail:jobs:external_share_expiration:batch_size") ?? 500;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:external_share_expiration:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no share links.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Does nothing when calendarShareLinkRepo is not yet initialized.", async () => {
        const original = (job as any).calendarShareLinkRepo;
        (job as any).calendarShareLinkRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).calendarShareLinkRepo = original;
        }
    });

    it("Purges a share link whose expiresAt has already passed.", async () => {
        const expired = await createShareLink({ expiresAt: new Date(Date.now() - HOUR_MS) });

        await job.run();

        const found = await calendarShareLinkRepo.findOne({ uid: expired.uid } as any);
        expect(found).toBeNull();
    });

    it("Keeps a share link whose expiresAt is in the future.", async () => {
        const active = await createShareLink({ expiresAt: new Date(Date.now() + HOUR_MS) });

        await job.run();

        const found = await calendarShareLinkRepo.findOne({ uid: active.uid } as any);
        expect(found).not.toBeNull();
    });

    it("Keeps a share link with no expiresAt set at all.", async () => {
        const permanent = await createShareLink({ expiresAt: undefined });

        await job.run();

        const found = await calendarShareLinkRepo.findOne({ uid: permanent.uid } as any);
        expect(found).not.toBeNull();
    });

    it("Bounds how many expired links are purged per run to the configured batch size.", async () => {
        (job as any).batchSize = 2;
        const expiredDate = new Date(Date.now() - HOUR_MS);
        const links = await Promise.all([
            createShareLink({ expiresAt: expiredDate }),
            createShareLink({ expiresAt: expiredDate }),
            createShareLink({ expiresAt: expiredDate }),
        ]);

        await job.run();

        const remaining = await calendarShareLinkRepo.find({ uid: { $in: links.map((l) => l.uid) } }).toArray();
        expect(remaining.length).toBe(1);
    });

    it("Revokes the expired link's ACLRecord from its folder's real ACL when purging it.", async () => {
        const aclUtils: ACLUtils = objectFactory.getInstance(ACLUtils)!;
        const folderUid = uuid.v4();
        const expired = await createShareLink({ expiresAt: new Date(Date.now() - HOUR_MS), folderUid });
        await aclUtils.saveACL({
            uid: folderUid,
            records: [
                { userOrRoleId: expired.token, actions: ["freebusy"] },
                { userOrRoleId: "someone-else", actions: ["read"] },
            ],
        });

        await job.run();

        const acl = await aclUtils.findACL(folderUid, [], { skipCache: true });
        expect(acl?.records.find((r) => r.userOrRoleId === expired.token)).toBeUndefined();
        expect(acl?.records.find((r) => r.userOrRoleId === "someone-else")).toBeDefined();
    });

    it("Does nothing to the folder's ACL when it exists but has no record for the expired link's token.", async () => {
        const aclUtils: ACLUtils = objectFactory.getInstance(ACLUtils)!;
        const folderUid = uuid.v4();
        const expired = await createShareLink({ expiresAt: new Date(Date.now() - HOUR_MS), folderUid });
        await aclUtils.saveACL({ uid: folderUid, records: [{ userOrRoleId: "someone-else", actions: ["read"] }] });

        await expect(job.run()).resolves.toBeUndefined();

        const acl = await aclUtils.findACL(folderUid, [], { skipCache: true });
        expect(acl?.records.length).toBe(1);
        expect(acl?.records[0].userOrRoleId).toBe("someone-else");
        const found = await calendarShareLinkRepo.findOne({ uid: expired.uid } as any);
        expect(found).toBeNull();
    });

    it("Logs a warning and continues purging subsequent links when one delete throws.", async () => {
        // Real infrastructure has no deterministic, non-destructive way to make a single link's own delete throw
        // (a plain delete against a healthy DB simply succeeds, even for an already-removed row) - this targets
        // a fault at the one seam real infra can't reach: the job's own internal `RepoUtils.delete()` call for
        // the "bad" link, restored immediately after so every other call in this test still goes to the real
        // database.
        const expiredDate = new Date(Date.now() - HOUR_MS);
        const badLink = await createShareLink({ expiresAt: expiredDate });
        const goodLink = await createShareLink({ expiresAt: expiredDate });

        const repoUtils = (job as any).calendarShareLinkRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: string, opts: any) => {
            if (uid === badLink.uid) {
                throw new Error("simulated database failure");
            }
            return originalDelete(uid, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const badFound = await calendarShareLinkRepo.findOne({ uid: badLink.uid } as any);
        const goodFound = await calendarShareLinkRepo.findOne({ uid: goodLink.uid } as any);
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });
});
