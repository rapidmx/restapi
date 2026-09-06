///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for ExternalShareExpirationJobSQL: a real SQLite (better-sqlite3)
// connection and a real `ObjectFactory` construct the job exactly as production wiring would - see
// ExternalShareExpirationJobMongo.test.ts's file header for the full rationale (also applies here verbatim).
// Uses `config.sql.ts`, whose `acl` datastore is ALSO SQL-backed (`AccessControlListSQL`, auto-selected by
// `ACLUtils` from the connection's runtime type) - so this file has no MongoDB dependency at all.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { In, Repository } from "typeorm";
import config from "../../config.sql.js";
import { ExternalShareExpirationJobSQL } from "../../../src/jobs/sql/ExternalShareExpirationJobSQL.js";
import { CalendarShareLinkSQL } from "../../../src/models/sql/CalendarShareLinkSQL.js";

const HOUR_MS = 60 * 60 * 1000;

describe("ExternalShareExpirationJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: ExternalShareExpirationJobSQL;
    let calendarShareLinkRepo: Repository<CalendarShareLinkSQL>;

    const createShareLink = async (data?: Partial<CalendarShareLinkSQL>): Promise<CalendarShareLinkSQL> => {
        const obj = new CalendarShareLinkSQL({
            token: uuid.v4(),
            folderUid: uuid.v4(),
            permittedActions: ["freebusy"],
            createdByUserUid: uuid.v4(),
            ...data,
        });
        return await calendarShareLinkRepo.save(obj);
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see ExternalShareExpirationJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        // Not auto-discovered here the way `Server`'s `ClassLoader` scan would - a bare TypeORM `DataSource`
        // throws "No metadata found" from `getRepository()` for any entity not explicitly in this map.
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("CalendarShareLinkSQL", CalendarShareLinkSQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        calendarShareLinkRepo = conn.getRepository(CalendarShareLinkSQL);

        // Constructed once via real ObjectFactory DI: `@Init` builds its one real `RepoUtils` against the live
        // connection above.
        job = await objectFactory.newInstance(ExternalShareExpirationJobSQL, { name: "default" });
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await calendarShareLinkRepo.clear();
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

        const found = await calendarShareLinkRepo.findOne({ where: { uid: expired.uid } });
        expect(found).toBeNull();
    });

    it("Keeps a share link whose expiresAt is in the future.", async () => {
        const active = await createShareLink({ expiresAt: new Date(Date.now() + HOUR_MS) });

        await job.run();

        const found = await calendarShareLinkRepo.findOne({ where: { uid: active.uid } });
        expect(found).not.toBeNull();
    });

    it("Keeps a share link with no expiresAt set at all.", async () => {
        const permanent = await createShareLink({ expiresAt: undefined });

        await job.run();

        const found = await calendarShareLinkRepo.findOne({ where: { uid: permanent.uid } });
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

        const remaining = await calendarShareLinkRepo.find({ where: { uid: In(links.map((l) => l.uid)) } });
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
        const found = await calendarShareLinkRepo.findOne({ where: { uid: expired.uid } });
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

        const badFound = await calendarShareLinkRepo.findOne({ where: { uid: badLink.uid } });
        const goodFound = await calendarShareLinkRepo.findOne({ where: { uid: goodLink.uid } });
        expect(badFound).not.toBeNull();
        expect(goodFound).toBeNull();
    });
});
