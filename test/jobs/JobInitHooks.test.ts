///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for the single `@Init` hook (`init()`) every background job uses to build its model repositories
// once. The hook is exercised through each job's Mongo binding with a stub ObjectFactory, so what is asserted is the
// hook's own contract: it refuses to run without a factory, builds each repo through the factory exactly as
// `{ name: X.name, args: [X] }` with the right repo type, never rebuilds a repo that is already set, and skips a repo
// whose model class is unset. The jobs' behavior against a real database is covered in test/jobs/{mongo,sql}/*.test.ts.
import "reflect-metadata";
import { RepoUtils } from "@rapidrest/service-core";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { CorrespondentUtils } from "../../src/util/CorrespondentUtils.js";
import { DomainUtils } from "../../src/util/DomainUtils.js";
import { EscrowAuditUtils } from "../../src/util/EscrowAuditUtils.js";
import { RecoverableRepoUtils } from "../../src/util/RecoverableRepoUtils.js";
import {
    AcmeEnrollmentDriverJobMongo,
    AttachmentExtractionJobMongo,
    CalendarReminderJobMongo,
    DataExportJobMongo,
    DomainVerificationJobMongo,
    ErasureExecutionJobMongo,
    ExternalShareExpirationJobMongo,
    MailboxImportJobMongo,
    MailboxQuotaRecalcJobMongo,
    MatterExportJobMongo,
    MeetingSchedulingJobMongo,
    OofReplySuppressionCleanupJobMongo,
    QuarantineRetentionJobMongo,
    RetentionEnforcementJobMongo,
    ScanQueueJobMongo,
    ScheduledSendJobMongo,
    SearchIndexJobMongo,
} from "../../src/jobs/mongo.js";

type RepoType = "RepoUtils" | "RecoverableRepoUtils";
type Repo = [repoField: string, classField: string, repoType: RepoType];

const REPO_TYPES: Record<RepoType, any> = { RepoUtils, RecoverableRepoUtils };

/** Every job with the repos its hook builds: [repo field, model class field, repo type]. */
const JOBS: [name: string, ctor: new () => any, repos: Repo[]][] = [
    [
        "AcmeEnrollmentDriverJob",
        AcmeEnrollmentDriverJobMongo,
        [
            ["mailboxRepo", "mailboxClass", "RepoUtils"],
            ["keyVaultRepo", "keyVaultClass", "RepoUtils"],
            ["auditLogRepo", "auditLogClass", "RepoUtils"],
        ],
    ],
    [
        "AttachmentExtractionJob",
        AttachmentExtractionJobMongo,
        [
            ["attachmentRepo", "attachmentClass", "RepoUtils"],
            ["messageRepo", "messageClass", "RecoverableRepoUtils"],
        ],
    ],
    ["CalendarReminderJob", CalendarReminderJobMongo, [["calendarEventRepo", "calendarEventClass", "RecoverableRepoUtils"]]],
    [
        "DataExportJob",
        DataExportJobMongo,
        [
            ["dataExportRequestRepo", "dataExportRequestClass", "RepoUtils"],
            ["messageRepo", "messageClass", "RepoUtils"],
            ["mailboxRepo", "mailboxClass", "RepoUtils"],
            ["auditLogRepo", "auditLogClass", "RepoUtils"],
        ],
    ],
    [
        "DomainVerificationJob",
        DomainVerificationJobMongo,
        [
            ["domainRepo", "domainClass", "RepoUtils"],
            ["auditLogRepo", "auditLogClass", "RepoUtils"],
        ],
    ],
    [
        "ErasureExecutionJob",
        ErasureExecutionJobMongo,
        [
            ["requestRepo", "dataSubjectErasureRequestClass", "RepoUtils"],
            ["mailboxRepo", "mailboxClass", "RepoUtils"],
            ["matterRepo", "matterClass", "RepoUtils"],
            ["auditLogRepo", "auditLogClass", "RepoUtils"],
        ],
    ],
    ["ExternalShareExpirationJob", ExternalShareExpirationJobMongo, [["calendarShareLinkRepo", "calendarShareLinkClass", "RepoUtils"]]],
    [
        "MailboxImportJob",
        MailboxImportJobMongo,
        [
            ["requestRepo", "mailboxImportRequestClass", "RepoUtils"],
            ["mailboxRepo", "mailboxClass", "RepoUtils"],
            ["folderRepo", "folderClass", "RepoUtils"],
            ["messageRepo", "messageClass", "RepoUtils"],
            ["attachmentRepo", "attachmentClass", "RepoUtils"],
            ["auditLogRepo", "auditLogClass", "RepoUtils"],
        ],
    ],
    [
        "MailboxQuotaRecalcJob",
        MailboxQuotaRecalcJobMongo,
        [
            ["mailboxRepo", "mailboxClass", "RepoUtils"],
            ["messageRepo", "messageClass", "RecoverableRepoUtils"],
            ["attachmentRepo", "attachmentClass", "RepoUtils"],
        ],
    ],
    [
        "MatterExportJob",
        MatterExportJobMongo,
        [
            ["requestRepo", "matterExportRequestClass", "RepoUtils"],
            ["matterRepo", "matterClass", "RepoUtils"],
            ["messageRepo", "messageClass", "RepoUtils"],
            ["mailboxRepo", "mailboxClass", "RepoUtils"],
            ["auditLogRepo", "auditLogClass", "RepoUtils"],
            ["escrowAuditEntryRepo", "escrowAuditLogClass", "RepoUtils"],
        ],
    ],
    [
        "MeetingSchedulingJob",
        MeetingSchedulingJobMongo,
        [
            ["calendarEventRepo", "calendarEventClass", "RecoverableRepoUtils"],
            ["mailboxRepo", "mailboxClass", "RepoUtils"],
            ["attendeeLinkRepo", "attendeeLinkClass", "RepoUtils"],
        ],
    ],
    ["OofReplySuppressionCleanupJob", OofReplySuppressionCleanupJobMongo, [["oofReplySuppressionRepo", "oofReplySuppressionClass", "RepoUtils"]]],
    [
        "QuarantineRetentionJob",
        QuarantineRetentionJobMongo,
        [
            ["quarantineEntryRepo", "quarantineEntryClass", "RepoUtils"],
            ["scanResultRepo", "scanResultClass", "RepoUtils"],
            ["ingestQueueEntryRepo", "ingestQueueEntryClass", "RepoUtils"],
            ["messageRepo", "messageClass", "RepoUtils"],
            ["attachmentRepo", "attachmentClass", "RepoUtils"],
            ["matterRepo", "matterClass", "RepoUtils"],
        ],
    ],
    [
        "RetentionEnforcementJob",
        RetentionEnforcementJobMongo,
        [
            ["retentionPolicyRepo", "retentionPolicyClass", "RepoUtils"],
            ["messageRepo", "messageClass", "RecoverableRepoUtils"],
            ["auditLogRepo", "auditLogClass", "RepoUtils"],
            ["attachmentRepo", "attachmentClass", "RepoUtils"],
            ["folderRepo", "folderClass", "RecoverableRepoUtils"],
            ["matterRepo", "matterClass", "RepoUtils"],
            ["quarantineEntryRepo", "quarantineEntryClass", "RepoUtils"],
            ["ingestQueueEntryRepo", "ingestQueueEntryClass", "RepoUtils"],
        ],
    ],
    [
        "ScanQueueJob",
        ScanQueueJobMongo,
        [
            ["ingestQueueRepo", "ingestQueueClass", "RepoUtils"],
            ["folderRepo", "folderClass", "RecoverableRepoUtils"],
            ["messageRepo", "messageClass", "RecoverableRepoUtils"],
            ["attachmentRepo", "attachmentClass", "RepoUtils"],
            ["quarantineEntryRepo", "quarantineEntryClass", "RepoUtils"],
            ["scanResultRepo", "scanResultClass", "RepoUtils"],
            ["mailboxRepo", "mailboxClass", "RepoUtils"],
            ["mailFilterRuleRepo", "mailFilterRuleClass", "RepoUtils"],
            ["calendarEventRepo", "calendarEventClass", "RecoverableRepoUtils"],
            ["oofReplySuppressionRepo", "oofReplySuppressionClass", "RepoUtils"],
            ["focusedInboxOverrideRepo", "focusedInboxOverrideClass", "RepoUtils"],
            ["contactRepo", "contactClass", "RecoverableRepoUtils"],
            ["keyVaultRepo", "keyVaultClass", "RepoUtils"],
            ["erasureRequestRepo", "dataSubjectErasureRequestClass", "RepoUtils"],
            ["correspondentRepo", "correspondentClass", "RepoUtils"],
            ["domainRepo", "domainClass", "RepoUtils"],
        ],
    ],
    [
        "ScheduledSendJob",
        ScheduledSendJobMongo,
        [
            ["messageRepo", "messageClass", "RecoverableRepoUtils"],
            ["folderRepo", "folderClass", "RecoverableRepoUtils"],
            ["mailboxRepo", "mailboxClass", "RepoUtils"],
            ["correspondentRepo", "correspondentClass", "RepoUtils"],
            ["domainRepo", "domainClass", "RepoUtils"],
        ],
    ],
    [
        "SearchIndexJob",
        SearchIndexJobMongo,
        [
            ["messageRepo", "messageClass", "RecoverableRepoUtils"],
            ["attachmentRepo", "attachmentClass", "RepoUtils"],
        ],
    ],
];

type Service = [serviceField: string, serviceType: any, classField: string, argFields: string[]];

/** Every job with the services its hook builds, after its repos: [service field, service type, class field the service is named
 * after, fields holding the repos it is built from, in order]. */
const SERVICES: [name: string, ctor: new () => any, services: Service[]][] = [
    ["AcmeEnrollmentDriverJob", AcmeEnrollmentDriverJobMongo, [["auditLogUtils", AuditLogUtils, "auditLogClass", ["auditLogRepo"]]]],
    ["DataExportJob", DataExportJobMongo, [["auditLogUtils", AuditLogUtils, "auditLogClass", ["auditLogRepo"]]]],
    ["DomainVerificationJob", DomainVerificationJobMongo, [["auditLogUtils", AuditLogUtils, "auditLogClass", ["auditLogRepo"]]]],
    ["ErasureExecutionJob", ErasureExecutionJobMongo, [["auditLogUtils", AuditLogUtils, "auditLogClass", ["auditLogRepo"]]]],
    ["MailboxImportJob", MailboxImportJobMongo, [["auditLogUtils", AuditLogUtils, "auditLogClass", ["auditLogRepo"]]]],
    [
        "MatterExportJob",
        MatterExportJobMongo,
        [
            ["auditLogUtils", AuditLogUtils, "auditLogClass", ["auditLogRepo"]],
            ["escrowAuditUtils", EscrowAuditUtils, "escrowAuditLogClass", ["escrowAuditEntryRepo", "escrowAuditHeadRepo"]],
        ],
    ],
    ["RetentionEnforcementJob", RetentionEnforcementJobMongo, [["auditLogUtils", AuditLogUtils, "auditLogClass", ["auditLogRepo"]]]],
    [
        "ScanQueueJob",
        ScanQueueJobMongo,
        [
            ["correspondentUtils", CorrespondentUtils, "correspondentClass", ["correspondentRepo", "mailboxRepo"]],
            ["domainUtils", DomainUtils, "domainClass", ["domainRepo"]],
        ],
    ],
    [
        "ScheduledSendJob",
        ScheduledSendJobMongo,
        [
            ["correspondentUtils", CorrespondentUtils, "correspondentClass", ["correspondentRepo", "mailboxRepo"]],
            ["domainUtils", DomainUtils, "domainClass", ["domainRepo"]],
        ],
    ],
];

/** The jobs that build the per-entity-type repositories their mailbox content export reads. */
const CONTENT_JOBS: [name: string, ctor: new () => any][] = [
    ["DataExportJob", DataExportJobMongo],
    ["MatterExportJob", MatterExportJobMongo],
];

const CONTENT_ENTITIES: [entityType: string, classField: string][] = [
    ["message", "messageClass"],
    ["contact", "contactClass"],
    ["contactList", "contactListClass"],
    ["calendarEvent", "calendarEventClass"],
    ["task", "taskClass"],
    ["note", "noteClass"],
    ["attachment", "attachmentClass"],
];

/** Gives a job built with `new` (so the ObjectFactory never injected anything) a stand-in factory. */
function withFactory(job: any, factory: any): any {
    Object.defineProperty(job, "_objectFactory", { value: factory, configurable: true, writable: true });
    return job;
}

/** A factory whose `newInstance()` hands back a marker describing the call that built it. */
function stubFactory(): any {
    return { newInstance: vi.fn(async (type: any, options: any) => ({ built: true, type, options })) };
}

describe("Background job init() hook Tests", () => {
    describe.each(JOBS)("%s", (_name, Ctor, repos) => {
        it("throws when the objectFactory is not set.", async () => {
            const job: any = new Ctor();
            job._objectFactory = undefined;

            await expect(job.init()).rejects.toThrow("objectFactory is not set.");
        });

        it("builds each repo through the factory with exactly { name, args: [model class] } and the right repo type.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new Ctor(), factory);

            await job.init();

            for (const [repoField, classField, repoType] of repos) {
                const modelClass: any = job[classField];
                const options = { name: modelClass.name, args: [modelClass] };
                expect(factory.newInstance).toHaveBeenCalledWith(REPO_TYPES[repoType], options);
                expect(job[repoField]).toMatchObject({ built: true, type: REPO_TYPES[repoType], options });
            }
        });

        it("does not rebuild a repo that is already set.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new Ctor(), factory);
            const existing: any = {};
            for (const [repoField] of repos) {
                job[repoField] = existing;
            }

            await job.init();

            for (const [repoField, classField, repoType] of repos) {
                expect(job[repoField]).toBe(existing);
                const modelClass: any = job[classField];
                expect(factory.newInstance).not.toHaveBeenCalledWith(REPO_TYPES[repoType], { name: modelClass.name, args: [modelClass] });
            }
        });

        it("skips a repo whose model class is not set.", async () => {
            for (const [repoField, classField] of repos) {
                const job: any = withFactory(new Ctor(), stubFactory());
                job[classField] = undefined;

                await job.init();

                expect(job[repoField]).toBeUndefined();
            }
        });
    });

    describe.each(SERVICES)("%s services", (_name, Ctor, services) => {
        it("builds each service once through the factory, named after its model class, from the repos built before it.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new Ctor(), factory);

            await job.init();

            for (const [serviceField, serviceType, classField, argFields] of services) {
                const options = { name: job[classField].name, args: argFields.map((field) => job[field]) };
                expect(factory.newInstance).toHaveBeenCalledWith(serviceType, options);
                expect(factory.newInstance.mock.calls.filter(([type]: any[]) => type === serviceType)).toHaveLength(1);
                expect(job[serviceField]).toMatchObject({ built: true, type: serviceType, options });
            }
        });

        it("does not rebuild a service that is already set.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new Ctor(), factory);
            const existing: any = {};
            for (const [serviceField] of services) {
                job[serviceField] = existing;
            }

            await job.init();

            for (const [serviceField, serviceType] of services) {
                expect(job[serviceField]).toBe(existing);
                expect(factory.newInstance).not.toHaveBeenCalledWith(serviceType, expect.anything());
            }
        });

        it("skips a service whose model class is not set.", async () => {
            for (const [serviceField, , classField] of services) {
                const job: any = withFactory(new Ctor(), stubFactory());
                job[classField] = undefined;

                await job.init();

                expect(job[serviceField]).toBeUndefined();
            }
        });
    });

    describe("MatterExportJob escrow audit head repo", () => {
        it("is built from the escrow audit log class's own head class, and skipped when it has none.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new MatterExportJobMongo(), factory);
            const headClass: any = job.escrowAuditLogClass.escrowAuditHeadClass;

            await job.init();

            expect(factory.newInstance).toHaveBeenCalledWith(RepoUtils, { name: headClass.name, args: [headClass] });
            expect(job.escrowAuditHeadRepo).toMatchObject({ built: true, options: { name: headClass.name, args: [headClass] } });

            const bare: any = withFactory(new MatterExportJobMongo(), stubFactory());
            bare.escrowAuditLogClass = class NoHeadEntry {};
            await bare.init();

            expect(bare.escrowAuditHeadRepo).toBeUndefined();
            expect(bare.escrowAuditUtils).toMatchObject({ built: true, type: EscrowAuditUtils });
        });

        it("does not rebuild a head repo that is already set.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new MatterExportJobMongo(), factory);
            const existing: any = {};
            job.escrowAuditHeadRepo = existing;

            await job.init();

            expect(job.escrowAuditHeadRepo).toBe(existing);
            const headClass: any = job.escrowAuditLogClass.escrowAuditHeadClass;
            expect(factory.newInstance).not.toHaveBeenCalledWith(RepoUtils, { name: headClass.name, args: [headClass] });
        });
    });

    describe.each(CONTENT_JOBS)("%s content repos", (_name, Ctor) => {
        it("builds one repo per entity type, once, in init(), sharing messageRepo for the messages.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new Ctor(), factory);

            await job.init();

            for (const [entityType, classField] of CONTENT_ENTITIES) {
                const modelClass: any = job[classField];
                if (entityType === "message") {
                    expect(job.contentRepos.message).toBe(job.messageRepo);
                } else {
                    expect(job.contentRepos[entityType]).toMatchObject({
                        built: true,
                        type: RepoUtils,
                        options: { name: modelClass.name, args: [modelClass] },
                    });
                }
            }
            expect(Object.keys(job.contentRepos)).toHaveLength(CONTENT_ENTITIES.length);
        });

        it("skips an entity type whose model class is not set.", async () => {
            const job: any = withFactory(new Ctor(), stubFactory());
            job.messageClass = undefined;
            job.noteClass = undefined;

            await job.init();

            expect(job.messageRepo).toBeUndefined();
            expect(job.contentRepos.message).toBeUndefined();
            expect(job.contentRepos.note).toBeUndefined();
            expect(job.contentRepos.task).toBeDefined();
        });

        it("does not rebuild content repos that are already set.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new Ctor(), factory);
            const existing: any = {};
            job.contentRepos = existing;

            await job.init();

            expect(job.contentRepos).toBe(existing);
            const taskClass: any = job.taskClass;
            expect(factory.newInstance).not.toHaveBeenCalledWith(RepoUtils, { name: taskClass.name, args: [taskClass] });
        });
    });

    describe("ScanQueueJob erasure-status repo", () => {
        it("is left unset, with a warning, when the datastore has no model for it.", async () => {
            const factory: any = {
                newInstance: vi.fn(async (_type: any, options: any) => {
                    if (options.name === "DataSubjectErasureRequestMongo") {
                        throw new Error("no such model");
                    }
                    return {};
                }),
            };
            const job: any = withFactory(new ScanQueueJobMongo(), factory);
            job.logger = { warn: vi.fn() };

            await job.init();

            expect(job.erasureRequestRepo).toBeUndefined();
            expect(job.logger.warn).toHaveBeenCalledWith(
                expect.stringContaining("DataSubjectErasureRequestMongo repo failed to initialize): no such model"),
            );
        });

        it("takes its model from dataSubjectErasureRequestClass alone, not from the name of the ingest queue class.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new ScanQueueJobMongo(), factory);
            job.ingestQueueClass = class IngestQueueEntrySQL {};
            const custom: any = class CustomErasureRequest {};
            job.dataSubjectErasureRequestClass = custom;

            await job.init();

            expect(factory.newInstance).toHaveBeenCalledWith(RepoUtils, { name: "CustomErasureRequest", args: [custom] });
            expect(factory.newInstance).not.toHaveBeenCalledWith(RepoUtils, expect.objectContaining({ name: "DataSubjectErasureRequestSQL" }));
        });
    });

    describe("ErasureExecutionJob entity repos", () => {
        const classFields: string[] = [
            "attachmentClass",
            "messageClass",
            "contactClass",
            "contactListClass",
            "calendarEventClass",
            "taskClass",
            "noteClass",
            "folderClass",
            "calendarShareLinkClass",
            "focusedInboxOverrideClass",
            "taskListClass",
            "labelClass",
            "mailFilterRuleClass",
            "mailSignatureClass",
            "oofReplySuppressionClass",
            "correspondentClass",
            "keyVaultClass",
            "quarantineEntryClass",
            "ingestQueueEntryClass",
            "dataExportRequestClass",
            "mailboxImportRequestClass",
            "pluginClass",
        ];

        it("builds a repo for every entity class the cascade purges, once, in init().", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new ErasureExecutionJobMongo(), factory);

            await job.init();

            for (const classField of classFields) {
                const modelClass: any = job[classField];
                expect(job.entityRepos.get(modelClass)).toMatchObject({
                    built: true,
                    type: RepoUtils,
                    options: { name: modelClass.name, args: [modelClass] },
                });
            }
            expect(job.entityRepos.size).toBe(new Set(classFields.map((field) => job[field])).size);
        });

        it("does not rebuild an entity repo that is already set, and skips an unset class.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new ErasureExecutionJobMongo(), factory);
            const existing: any = {};
            job.entityRepos.set(job.contactClass, existing);
            job.labelClass = undefined;

            await job.init();

            expect(job.entityRepos.get(job.contactClass)).toBe(existing);
            expect(factory.newInstance).not.toHaveBeenCalledWith(RepoUtils, expect.objectContaining({ name: job.contactClass.name }));
            expect(job.entityRepos.has(undefined)).toBe(false);
        });

        it("getRepo() hands back the repo built in init(), and builds and remembers one for a class only known at run time.", async () => {
            const factory = stubFactory();
            const job: any = withFactory(new ErasureExecutionJobMongo(), factory);
            await job.init();
            const calls: number = factory.newInstance.mock.calls.length;

            expect(await job.getRepo(job.contactClass)).toBe(job.entityRepos.get(job.contactClass));
            expect(factory.newInstance.mock.calls.length).toBe(calls);

            const dynamic: any = class PluginOwnedEntity {};
            const built: any = await job.getRepo(dynamic);

            expect(factory.newInstance).toHaveBeenCalledWith(RepoUtils, { name: "PluginOwnedEntity", args: [dynamic] });
            expect(factory.newInstance.mock.calls.length).toBe(calls + 1);
            expect(await job.getRepo(dynamic)).toBe(built);
            expect(factory.newInstance.mock.calls.length).toBe(calls + 1);
        });
    });
});
