///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for EasDeviceStateCleanupJobMongo: a real in-memory MongoDB connection and
// a real `ObjectFactory` construct the job exactly as production wiring would - its own `@Init` builds a real
// `RepoUtils` against the live connection. No repo is hand-mocked. See
// ../../jobs/mongo/ScanQueueJobMongo.test.ts's file header for the full rationale behind bypassing
// `Server`/`ClassLoader`.
import { MongoMemoryServer } from "mongodb-memory-server";
import { ACLUtils, ConnectionManager, MongoConnection, MongoRepository, ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import config from "../../config.js";
import { EasDeviceStateCleanupJobMongo } from "../../../src/jobs/mongo/EasDeviceStateCleanupJobMongo.js";
import { DeviceSyncStateMongo } from "../../../src/models/mongo/DeviceSyncStateMongo.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

const DEVICE_TTL_DAYS = 90; // matches mail:jobs:eas_device_cleanup:device_ttl_days in test/config.ts
const DAY_MS = 24 * 60 * 60 * 1000;

describe("EasDeviceStateCleanupJobMongo Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: EasDeviceStateCleanupJobMongo;
    let deviceSyncStateRepo: MongoRepository<DeviceSyncStateMongo>;

    const createDevice = async (data?: Partial<DeviceSyncStateMongo>): Promise<DeviceSyncStateMongo> => {
        const obj = new DeviceSyncStateMongo({
            mailboxUid: uuid.v4(),
            deviceId: uuid.v4(),
            deviceType: "iPhone",
            folderSyncKeys: {},
            provisioned: true,
            ...data,
        });
        return await deviceSyncStateRepo.save(obj);
    };

    beforeAll(async () => {
        await mongod.start();
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see ScanQueueJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("DeviceSyncStateMongo", DeviceSyncStateMongo);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("mongo");
        if (!(conn instanceof MongoConnection)) {
            throw new Error("Could not find mongo connection");
        }
        deviceSyncStateRepo = conn.getMongoRepository("DeviceSyncStateMongo");

        // Constructed once via real ObjectFactory DI: `@Init` builds its one real `RepoUtils` against the live
        // connection above.
        job = await objectFactory.newInstance(EasDeviceStateCleanupJobMongo, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
        await mongod.stop();
    });

    beforeEach(async () => {
        try {
            await deviceSyncStateRepo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
        // Restore the job's batch size to the configured default between tests, in case a test overrode it.
        (job as any).batchSize = config.get("mail:jobs:eas_device_cleanup:batch_size") ?? 500;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:eas_device_cleanup:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no device sync state rows.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Does nothing when deviceSyncStateRepo is not yet initialized.", async () => {
        const original = (job as any).deviceSyncStateRepo;
        (job as any).deviceSyncStateRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).deviceSyncStateRepo = original;
        }
    });

    it("Purges a device that hasn't synced in more than the configured TTL.", async () => {
        const stale = await createDevice({ lastSyncAt: new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS) });

        await job.run();

        const found = await deviceSyncStateRepo.findOne({ uid: stale.uid } as any);
        expect(found).toBeNull();
    });

    it("Keeps a device that synced recently, within the configured TTL.", async () => {
        const recent = await createDevice({ lastSyncAt: new Date(Date.now() - (DEVICE_TTL_DAYS - 5) * DAY_MS) });

        await job.run();

        const found = await deviceSyncStateRepo.findOne({ uid: recent.uid } as any);
        expect(found).not.toBeNull();
    });

    it("Purges a device that has never successfully synced, regardless of age.", async () => {
        const neverSynced = await createDevice({ lastSyncAt: undefined });

        await job.run();

        const found = await deviceSyncStateRepo.findOne({ uid: neverSynced.uid } as any);
        expect(found).toBeNull();
    });

    it("Bounds how many stale rows are purged per run to the configured batch size.", async () => {
        (job as any).batchSize = 2;
        const staleDate = new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS);
        const devices = await Promise.all([
            createDevice({ lastSyncAt: staleDate }),
            createDevice({ lastSyncAt: staleDate }),
            createDevice({ lastSyncAt: staleDate }),
        ]);

        await job.run();

        const remaining = await deviceSyncStateRepo
            .find({ uid: { $in: devices.map((d) => d.uid) } })
            .toArray();
        expect(remaining.length).toBe(1);
    });

    it("Logs a warning and continues purging subsequent rows when one delete throws.", async () => {
        // Real infrastructure has no deterministic, non-destructive way to make a single row's own delete throw
        // (a plain delete against a healthy DB simply succeeds, even for an already-removed row) - this targets
        // a fault at the one seam real infra can't reach: the job's own internal `RepoUtils.delete()` call for
        // the "bad" row, restored immediately after so every other call in this test still goes to the real
        // database.
        const staleDate = new Date(Date.now() - (DEVICE_TTL_DAYS + 5) * DAY_MS);
        const badDevice = await createDevice({ lastSyncAt: staleDate });
        const goodDevice = await createDevice({ lastSyncAt: staleDate });

        const repoUtils = (job as any).deviceSyncStateRepo;
        const originalDelete = repoUtils.delete.bind(repoUtils);
        vi.spyOn(repoUtils, "delete").mockImplementation(async (uid: string, opts: any) => {
            if (uid === badDevice.uid) {
                throw new Error("simulated database failure");
            }
            return originalDelete(uid, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const badFound = await deviceSyncStateRepo.findOne({ uid: badDevice.uid } as any);
        const goodFound = await deviceSyncStateRepo.findOne({ uid: goodDevice.uid } as any);
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });
});
