///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for the `@Init` hooks that build the additional model repositories of the BaseScopedChildRoute family and of
// BaseMailboxRoute/BaseFolderRoute: each throws without an `ObjectFactory`, builds every repository once with `{ name, args }`
// (`RecoverableRepoUtils` where the route works with soft-deleted rows), keeps one that is already set and skips one whose class is unset. The
// services (`AuditLogUtils`, `DomainUtils`, `CorrespondentUtils`) are built once, after the repositories, from those repositories.
import { RepoUtils } from "@rapidrest/service-core";
import { BaseAttachmentRoute } from "../../src/routes/BaseAttachmentRoute.js";
import { BaseCalendarEventRoute } from "../../src/routes/BaseCalendarEventRoute.js";
import { BaseCalendarShareLinkRoute } from "../../src/routes/BaseCalendarShareLinkRoute.js";
import { BaseFolderRoute } from "../../src/routes/BaseFolderRoute.js";
import { BaseLabelRoute } from "../../src/routes/BaseLabelRoute.js";
import { BaseMailboxRoute } from "../../src/routes/BaseMailboxRoute.js";
import { BaseMailFilterRuleRoute } from "../../src/routes/BaseMailFilterRuleRoute.js";
import { BaseScopedChildRoute } from "../../src/routes/BaseScopedChildRoute.js";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";
import { CorrespondentUtils } from "../../src/util/CorrespondentUtils.js";
import { DomainUtils } from "../../src/util/DomainUtils.js";
import { RecoverableRepoUtils } from "../../src/util/RecoverableRepoUtils.js";

class FolderModel {}
class MessageModel {}
class MailboxModel {}
class CorrespondentModel {}
class LabelModel {}
class ShareLinkModel {}
class ErasureRequestModel {}
class DistributionListModel {}
class EscrowScopeModel {}
class AuditLogModel {}
class DomainModel {}
class MatterModel {}
class MailboxPolicyModel {}
class QuarantineEntryModel {}
class IngestQueueEntryModel {}

class ScopedRoute extends BaseScopedChildRoute<any> {
    protected readonly scopeProperty: string = "mailboxUid";
    protected shareLinkClass: any = ShareLinkModel;
    protected scopeFolderClass: any = FolderModel;
    protected auditLogClass: any = AuditLogModel;
}

class AttachmentRoute extends BaseAttachmentRoute<any, any> {
    protected messageClass: any = MessageModel;
    protected mailboxClass: any = MailboxModel;
    protected matterClass: any = MatterModel;
    protected quarantineEntryClass: any = QuarantineEntryModel;
    protected ingestQueueEntryClass: any = IngestQueueEntryModel;
}

class CalendarEventRoute extends BaseCalendarEventRoute<any> {
    protected mailboxClass: any = MailboxModel;
    protected folderClass: any = FolderModel;
    protected correspondentClass: any = CorrespondentModel;
    protected messageClass: any = MessageModel;
}

class CalendarShareLinkRoute extends BaseCalendarShareLinkRoute<any> {
    protected readonly scopeProperty: string = "folderUid";
    protected folderClass: any = FolderModel;
}

class LabelRoute extends BaseLabelRoute<any, any> {
    protected messageClass: any = MessageModel;

    protected buildLabelUidsFilter(): Record<string, any> {
        return {};
    }
}

class MailFilterRuleRoute extends BaseMailFilterRuleRoute<any> {
    protected folderClass: any = FolderModel;
    protected labelClass: any = LabelModel;
}

class MailboxRoute extends BaseMailboxRoute<any> {
    protected folderClass: any = FolderModel;
    protected distributionListClass: any = DistributionListModel;
    protected domainClass: any = DomainModel;
    protected auditLogClass: any = AuditLogModel;
    protected escrowScopeClass: any = EscrowScopeModel;
    protected matterClass: any = MatterModel;
    protected mailboxPolicyClass: any = MailboxPolicyModel;
    protected messageClass: any = MessageModel;
    protected dataSubjectErasureRequestClass: any = ErasureRequestModel;

    protected async findAccessibleMailboxUids(): Promise<string[]> {
        return [];
    }
}

class FolderRoute extends BaseFolderRoute<any> {
    protected shareLinkClass: any = ShareLinkModel;
    protected messageClass: any = MessageModel;
}

interface RepoSpec {
    /** The repository field the hook fills. */
    repo: string;
    /** The route field holding the model class the repository is built for. */
    cls: string;
    model: any;
    util: any;
}

interface ServiceSpec {
    /** The service field the hook fills. */
    service: string;
    /** The route field holding the model class the service is named after. */
    cls: string;
    model: any;
    util: any;
    /** The repository fields of the route handed to the service, in constructor order. */
    args: string[];
}

const spec = (repo: string, cls: string, model: any, util: any = RepoUtils): RepoSpec => ({ repo, cls, model, util });
const svc = (service: string, cls: string, model: any, util: any, args: string[]): ServiceSpec => ({ service, cls, model, util, args });

const HOOKS: { label: string; Route: any; hook: string; repos: RepoSpec[]; services?: ServiceSpec[] }[] = [
    {
        label: "BaseScopedChildRoute",
        Route: ScopedRoute,
        hook: "initScopedChildRepos",
        repos: [
            spec("shareLinkRepo", "shareLinkClass", ShareLinkModel),
            spec("scopeFolderRepo", "scopeFolderClass", FolderModel),
            spec("auditLogRepo", "auditLogClass", AuditLogModel),
        ],
        services: [svc("auditLogUtils", "auditLogClass", AuditLogModel, AuditLogUtils, ["auditLogRepo"])],
    },
    {
        label: "BaseAttachmentRoute",
        Route: AttachmentRoute,
        hook: "initAttachmentRepos",
        repos: [
            spec("messageRepo", "messageClass", MessageModel, RecoverableRepoUtils),
            spec("mailboxRepo", "mailboxClass", MailboxModel),
            spec("matterRepo", "matterClass", MatterModel),
            spec("quarantineEntryRepo", "quarantineEntryClass", QuarantineEntryModel),
            spec("ingestQueueEntryRepo", "ingestQueueEntryClass", IngestQueueEntryModel),
        ],
    },
    {
        label: "BaseCalendarEventRoute",
        Route: CalendarEventRoute,
        hook: "initCalendarEventRepos",
        repos: [
            spec("mailboxRepo", "mailboxClass", MailboxModel),
            spec("messageRepo", "messageClass", MessageModel),
            spec("folderRepo", "folderClass", FolderModel),
            spec("correspondentRepo", "correspondentClass", CorrespondentModel),
        ],
        services: [svc("correspondentUtils", "correspondentClass", CorrespondentModel, CorrespondentUtils, ["correspondentRepo", "mailboxRepo"])],
    },
    { label: "BaseCalendarShareLinkRoute", Route: CalendarShareLinkRoute, hook: "initCalendarShareLinkRepos", repos: [spec("folderRepo", "folderClass", FolderModel)] },
    { label: "BaseLabelRoute", Route: LabelRoute, hook: "initLabelRepos", repos: [spec("messageRepo", "messageClass", MessageModel, RecoverableRepoUtils)] },
    { label: "BaseMailFilterRuleRoute", Route: MailFilterRuleRoute, hook: "initMailFilterRuleRepos", repos: [spec("labelRepo", "labelClass", LabelModel), spec("folderRepo", "folderClass", FolderModel)] },
    {
        label: "BaseMailboxRoute",
        Route: MailboxRoute,
        hook: "initialize",
        repos: [
            spec("folderRepo", "folderClass", FolderModel, RecoverableRepoUtils),
            spec("messageRepo", "messageClass", MessageModel, RecoverableRepoUtils),
            spec("erasureRequestRepo", "dataSubjectErasureRequestClass", ErasureRequestModel),
            spec("distributionListRepo", "distributionListClass", DistributionListModel),
            spec("escrowScopeRepo", "escrowScopeClass", EscrowScopeModel),
            spec("auditLogRepo", "auditLogClass", AuditLogModel),
            spec("domainRepo", "domainClass", DomainModel),
            spec("matterRepo", "matterClass", MatterModel),
            spec("mailboxPolicyRepo", "mailboxPolicyClass", MailboxPolicyModel),
        ],
        services: [
            svc("auditLogUtils", "auditLogClass", AuditLogModel, AuditLogUtils, ["auditLogRepo"]),
            svc("domainUtils", "domainClass", DomainModel, DomainUtils, ["domainRepo"]),
        ],
    },
    {
        label: "BaseFolderRoute",
        Route: FolderRoute,
        hook: "initialize",
        repos: [spec("shareLinkRepo", "shareLinkClass", ShareLinkModel), spec("messageRepo", "messageClass", MessageModel)],
    },
];

/** The `_objectFactory` of a real instance is injected (and not writable), so a test instance gets a fake one the same way. */
function withFactory(route: any): { route: any; newInstance: ReturnType<typeof vi.fn> } {
    const newInstance = vi.fn(async (type: any, options: any) => ({ built: type, options }));
    Object.defineProperty(route, "_objectFactory", { value: { newInstance }, writable: true, configurable: true });
    return { route, newInstance };
}

describe.each(HOOKS)("$label repository hook", ({ Route, hook, repos, services = [] }) => {
    it(`${hook}() throws when the objectFactory is not set.`, async () => {
        const route: any = new Route();
        await expect(route[hook]()).rejects.toThrow("objectFactory is not set.");
    });

    it(`${hook}() builds each repository once, with the model class's name and the class itself.`, async () => {
        const { route, newInstance } = withFactory(new Route());

        await route[hook]();

        expect(newInstance).toHaveBeenCalledTimes(repos.length + services.length);
        for (const { repo, model, util } of repos) {
            expect(newInstance).toHaveBeenCalledWith(util, { name: model.name, args: [model] });
            expect(route[repo]).toEqual({ built: util, options: { name: model.name, args: [model] } });
        }
    });

    it(`${hook}() builds each service once, after the repositories, from the repositories it built.`, async () => {
        const { route, newInstance } = withFactory(new Route());

        await route[hook]();

        const calls: any[][] = newInstance.mock.calls;
        for (const { service, model, util, args } of services) {
            const expected = { name: model.name, args: args.map((repo) => route[repo]) };
            expect(newInstance).toHaveBeenCalledWith(util, expected);
            expect(route[service]).toEqual({ built: util, options: expected });
            expect(calls.findIndex(([type]) => type === util)).toBeGreaterThanOrEqual(repos.length);
        }
    });

    it(`${hook}() does not rebuild a repository or service that is already set.`, async () => {
        const { route, newInstance } = withFactory(new Route());
        const existing = repos.map(() => ({}));
        repos.forEach(({ repo }, i) => (route[repo] = existing[i]));
        const existingServices = services.map(() => ({}));
        services.forEach(({ service }, i) => (route[service] = existingServices[i]));

        await route[hook]();

        expect(newInstance).not.toHaveBeenCalled();
        repos.forEach(({ repo }, i) => expect(route[repo]).toBe(existing[i]));
        services.forEach(({ service }, i) => expect(route[service]).toBe(existingServices[i]));
    });

    it(`${hook}() builds a service from a repository that is already set.`, async () => {
        const { route, newInstance } = withFactory(new Route());
        const existing = repos.map(() => ({}));
        repos.forEach(({ repo }, i) => (route[repo] = existing[i]));

        await route[hook]();

        expect(newInstance).toHaveBeenCalledTimes(services.length);
        for (const { service, model, util, args } of services) {
            expect(route[service]).toEqual({ built: util, options: { name: model.name, args: args.map((repo) => route[repo]) } });
        }
    });

    it(`${hook}() skips a repository or service whose class is not set.`, async () => {
        const { route, newInstance } = withFactory(new Route());
        for (const { cls } of [...repos, ...services]) {
            route[cls] = undefined;
        }

        await route[hook]();

        expect(newInstance).not.toHaveBeenCalled();
        for (const { repo } of repos) {
            expect(route[repo]).toBeUndefined();
        }
        for (const { service } of services) {
            expect(route[service]).toBeUndefined();
        }
    });
});
