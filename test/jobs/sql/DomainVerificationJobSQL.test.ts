///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB + real-DI integration test for DomainVerificationJobSQL: a real SQLite (better-sqlite3) connection
// and a real `ObjectFactory` construct the job exactly as production wiring would - see
// DomainVerificationJobMongo.test.ts's file header for the full rationale (also applies here verbatim). Uses
// `config.sql.ts`, whose `acl` datastore is ALSO SQL-backed, so this file has no MongoDB dependency at all.
import { ACLUtils, AccessControlListSQL, ConnectionManager, ObjectFactory, isSqlDataSource } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { In, Repository } from "typeorm";
import config from "../../config.sql.js";
import { DomainVerificationJobSQL } from "../../../src/jobs/sql/DomainVerificationJobSQL.js";
import { AuditLogEntrySQL } from "../../../src/models/sql/AuditLogEntrySQL.js";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { AuditAction } from "../../../src/models/types.js";
import { buildVerificationTxtValue } from "../../../src/util/DomainVerificationUtils.js";
import { StaticDnsResolver } from "../../testDoubles.js";

describe("DomainVerificationJobSQL Tests (real DB + DI)", () => {
    const logger = Logger();
    let objectFactory: ObjectFactory;
    let connectionManager: ConnectionManager;
    let job: DomainVerificationJobSQL;
    let domainRepo: Repository<DomainSQL>;
    let auditLogRepo: Repository<AuditLogEntrySQL>;
    let dnsResolver: StaticDnsResolver;

    const createDomain = async (data?: Partial<DomainSQL>): Promise<DomainSQL> => {
        const name: string = data?.name ?? `${uuid.v4()}.example.com`;
        const obj = new DomainSQL({
            name,
            enabled: true,
            verified: false,
            verificationToken: uuid.v4(),
            uid: name,
            ...data,
        });
        return await domainRepo.save(obj);
    };

    beforeAll(async () => {
        objectFactory = new ObjectFactory(config, logger);
        // Normally registered by `Server`'s own bootstrap - registered explicitly here since this file
        // deliberately bypasses `Server` (see DomainVerificationJobMongo.test.ts's header comment).
        objectFactory.register(ACLUtils);
        objectFactory.register(StaticDnsResolver, "DnsResolver");

        connectionManager = await objectFactory.newInstance(ConnectionManager, { name: "default" });
        const models = new Map<string, any>();
        models.set("AccessControlListSQL", AccessControlListSQL);
        models.set("DomainSQL", DomainSQL);
        models.set("AuditLogEntrySQL", AuditLogEntrySQL);
        await connectionManager.connect(config.get("datastores"), models);

        const conn: any = connectionManager.connections.get("sql");
        if (!isSqlDataSource(conn)) {
            throw new Error("Could not find sql connection");
        }
        domainRepo = conn.getRepository(DomainSQL);
        auditLogRepo = conn.getRepository(AuditLogEntrySQL);

        // Constructed once via real ObjectFactory DI: `@Init` builds its one real `RepoUtils` against the
        // live connection above, and `@Inject("DnsResolver")` resolves the registered test double.
        job = await objectFactory.newInstance(DomainVerificationJobSQL, { name: "default" });
        dnsResolver = objectFactory.getInstance<StaticDnsResolver>("DnsResolver")!;
    });

    afterAll(async () => {
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await domainRepo.clear();
        await auditLogRepo.clear();
        dnsResolver.records.clear();
        // Restore the job's batch size to the configured default between tests, in case a test overrode it.
        (job as any).batchSize = config.get("mail:jobs:domain_verification:batch_size") ?? 100;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("Exposes the configured cron schedule.", () => {
        expect(job.schedule).toBe(config.get("mail:jobs:domain_verification:schedule"));
    });

    it("start() and stop() are no-ops beyond init().", async () => {
        await expect(job.start()).resolves.toBeUndefined();
        expect(job.stop()).toBeUndefined();
    });

    it("Does nothing when there are no domains.", async () => {
        await expect(job.run()).resolves.toBeUndefined();
    });

    it("Does nothing when domainRepo is not yet initialized.", async () => {
        const original = (job as any).domainRepo;
        (job as any).domainRepo = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).domainRepo = original;
        }
    });

    it("Does nothing when dnsResolver is not yet available.", async () => {
        const original = (job as any).dnsResolver;
        (job as any).dnsResolver = undefined;
        try {
            await expect(job.run()).resolves.toBeUndefined();
        } finally {
            (job as any).dnsResolver = original;
        }
    });

    it("Verifies an enabled+unverified domain when the DNS TXT record matches, and writes an AuditLogEntry.", async () => {
        const domain = await createDomain({ name: "verify-me.com" });
        dnsResolver.records.set("verify-me.com", [[buildVerificationTxtValue(domain.verificationToken)]]);

        await job.run();

        const found = await domainRepo.findOne({ where: { uid: domain.uid } });
        expect(found!.verified).toBe(true);
        expect(found!.verifiedAt).toBeTruthy();
        expect(found!.lastCheckedAt).toBeTruthy();

        const entries = await auditLogRepo.find({ where: { targetUid: domain.uid, action: AuditAction.DOMAIN_VERIFIED } });
        expect(entries.length).toBe(1);
        expect(entries[0].targetType).toBe("Domain");
        expect(entries[0].actorUserUid).toBeFalsy();
    });

    it("Leaves a domain unverified (but stamps lastCheckedAt) when the DNS TXT record doesn't match.", async () => {
        const domain = await createDomain({ name: "not-yet.com" });
        dnsResolver.records.set("not-yet.com", [["some-other-value"]]);

        await job.run();

        const found = await domainRepo.findOne({ where: { uid: domain.uid } });
        expect(found!.verified).toBe(false);
        expect(found!.lastCheckedAt).toBeTruthy();

        const entries = await auditLogRepo.find({ where: { targetUid: domain.uid } });
        expect(entries.length).toBe(0);
    });

    it("Skips a disabled domain.", async () => {
        const domain = await createDomain({ name: "disabled.com", enabled: false });
        dnsResolver.records.set("disabled.com", [[buildVerificationTxtValue(domain.verificationToken)]]);

        await job.run();

        const found = await domainRepo.findOne({ where: { uid: domain.uid } });
        expect(found!.verified).toBe(false);
        expect(found!.lastCheckedAt).toBeFalsy();
    });

    it("Skips an already-verified domain.", async () => {
        const domain = await createDomain({ name: "already-verified.com", verified: true, verifiedAt: new Date() });

        await job.run();

        const found = await domainRepo.findOne({ where: { uid: domain.uid } });
        expect(found!.lastCheckedAt).toBeFalsy();
    });

    it("Logs a warning and continues checking subsequent domains when one lookup throws.", async () => {
        const badDomain = await createDomain({ name: "bad.com" });
        const goodDomain = await createDomain({ name: "good.com" });
        dnsResolver.records.set("good.com", [[buildVerificationTxtValue(goodDomain.verificationToken)]]);
        // No record registered for "bad.com" - StaticDnsResolver.resolveTxt() throws for any unknown hostname,
        // which checkDomainVerification() itself already swallows into `false`. To exercise this job's own
        // try/catch (distinct from that), make the *update* call for the "bad" domain throw instead - the one
        // seam real infra can't reach deterministically, same rationale as QuarantineRetentionJobSQL.test.ts.
        const repoUtils = (job as any).domainRepo;
        const originalUpdate = repoUtils.update.bind(repoUtils);
        vi.spyOn(repoUtils, "update").mockImplementation(async (patch: any, existing: any, opts: any) => {
            if (existing.uid === badDomain.uid) {
                throw new Error("simulated database failure");
            }
            return originalUpdate(patch, existing, opts);
        });

        await expect(job.run()).resolves.toBeUndefined();

        const goodFound = await domainRepo.findOne({ where: { uid: goodDomain.uid } });
        expect(goodFound!.verified).toBe(true);
    });

    it("Does not overwrite a concurrent admin edit made while DNS was being checked (version-checked update) - the domain is simply re-checked next run.", async () => {
        const domain = await createDomain({ name: "raced.com" });
        dnsResolver.records.set("raced.com", [[buildVerificationTxtValue(domain.verificationToken)]]);
        const repoUtils = (job as any).domainRepo;
        const [stale] = await repoUtils.find({ uid: domain.uid, limit: 1 } as any, { ignoreACL: true, limit: 1 });
        await domainRepo.update({ uid: domain.uid }, { version: domain.version + 1, dkimSelector: "edited" });
        vi.spyOn(repoUtils, "find").mockResolvedValueOnce([stale]);
        const warnSpy = vi.spyOn((job as any).logger, "warn");

        await job.run();

        const found = await domainRepo.findOne({ where: { uid: domain.uid } });
        expect(found!.version).toBe(domain.version + 1);
        expect(found!.dkimSelector).toBe("edited");
        expect(found!.verified).toBe(false);
        expect(found!.lastCheckedAt ?? null).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("raced.com"));
    });

    it("Bounds how many domains are checked per run to the configured batch size.", async () => {
        (job as any).batchSize = 2;
        const domains = await Promise.all([createDomain(), createDomain(), createDomain()]);

        await job.run();

        const found = await domainRepo.find({ where: { uid: In(domains.map((d) => d.uid)) } });
        const checked = found.filter((d) => d.lastCheckedAt);
        expect(checked.length).toBe(2);
    });
});
