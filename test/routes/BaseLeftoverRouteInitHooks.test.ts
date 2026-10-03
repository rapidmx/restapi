///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for the `@Init` hooks of the admin routes that only audit (BaseDomainRoute, BaseTransportRuleRoute,
// BaseSigningEnrollmentAdminRoute): each throws without an `ObjectFactory`, builds the `AuditLogEntry` repository and then `AuditLogUtils` once with
// `{ name, args }`, keeps ones that are already set and skips them when `auditLogClass` is unset.
import { RepoUtils } from "@rapidrest/service-core";
import { BaseDomainRoute } from "../../src/routes/BaseDomainRoute.js";
import { BaseSigningEnrollmentAdminRoute } from "../../src/routes/BaseSigningEnrollmentAdminRoute.js";
import { BaseTransportRuleRoute } from "../../src/routes/BaseTransportRuleRoute.js";
import { AuditLogUtils } from "../../src/util/AuditLogUtils.js";

/** A uniquely named stand-in model class. */
function model(name: string): any {
    return { [name]: class {} }[name];
}

class TestDomainRoute extends (BaseDomainRoute as any) {
    protected auditLogClass: any = model("AuditModel");
}
class TestTransportRuleRoute extends (BaseTransportRuleRoute as any) {
    protected auditLogClass: any = model("AuditModel");
}
class TestSigningEnrollmentAdminRoute extends (BaseSigningEnrollmentAdminRoute as any) {
    protected auditLogClass: any = model("AuditModel");
}

const cases: { name: string; hook: string; make: () => any }[] = [
    { name: "BaseDomainRoute", hook: "initDomainRepos", make: () => new TestDomainRoute() },
    { name: "BaseTransportRuleRoute", hook: "initTransportRuleRepos", make: () => new TestTransportRuleRoute() },
    { name: "BaseSigningEnrollmentAdminRoute", hook: "initialize", make: () => new TestSigningEnrollmentAdminRoute() },
];

function withFactory(route: any): any {
    const factory: any = { newInstance: vi.fn(async (type: any, opts: any) => ({ type, opts })) };
    Object.defineProperty(route, "_objectFactory", { value: factory, writable: true, configurable: true });
    return factory;
}

describe.each(cases)("$name $hook()", ({ hook, make }) => {
    it("throws when the objectFactory is not set", async () => {
        const route: any = make();
        await expect(route[hook]()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds the audit repo and then the audit service once through the factory", async () => {
        const route: any = make();
        const factory = withFactory(route);
        await route[hook]();
        const cls = route.auditLogClass;
        expect(factory.newInstance).toHaveBeenCalledTimes(2);
        expect(factory.newInstance).toHaveBeenNthCalledWith(1, RepoUtils, { name: cls.name, args: [cls] });
        expect(route.auditLogRepo).toEqual({ type: RepoUtils, opts: { name: cls.name, args: [cls] } });
        expect(factory.newInstance).toHaveBeenNthCalledWith(2, AuditLogUtils, { name: cls.name, args: [route.auditLogRepo] });
        expect(route.auditLogUtils).toEqual({ type: AuditLogUtils, opts: { name: cls.name, args: [route.auditLogRepo] } });
    });

    it("does not rebuild a repo or service that is already set", async () => {
        const route: any = make();
        const factory = withFactory(route);
        const repo = (route.auditLogRepo = { preset: "repo" });
        const utils = (route.auditLogUtils = { preset: "utils" });
        await route[hook]();
        expect(factory.newInstance).not.toHaveBeenCalled();
        expect(route.auditLogRepo).toBe(repo);
        expect(route.auditLogUtils).toBe(utils);
    });

    it("builds the service on top of a preset repo, and rebuilds nothing else", async () => {
        const route: any = make();
        const factory = withFactory(route);
        const repo = (route.auditLogRepo = { preset: "repo" });
        await route[hook]();
        expect(factory.newInstance).toHaveBeenCalledTimes(1);
        expect(factory.newInstance).toHaveBeenCalledWith(AuditLogUtils, { name: route.auditLogClass.name, args: [repo] });
    });

    it("skips the repo and the service when auditLogClass is unset", async () => {
        const route: any = make();
        const factory = withFactory(route);
        route.auditLogClass = undefined;
        await route[hook]();
        expect(factory.newInstance).not.toHaveBeenCalled();
        expect(route.auditLogRepo).toBeUndefined();
        expect(route.auditLogUtils).toBeUndefined();
    });
});
