///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A deployment with no signing certificate provider lists no enrollments instead of failing (R2-15).
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import { SigningEnrollmentAdminRouteSQL } from "../../src/routes/sql/SigningEnrollmentAdminRouteSQL.js";

describe("BaseSigningEnrollmentAdminRoute with no provider", () => {
    it("list() answers an empty list", async () => {
        const objectFactory = new ObjectFactory(undefined, Logger());
        const route: any = await objectFactory.newInstance(SigningEnrollmentAdminRouteSQL, { name: "default", initialize: false });
        route.trustedRoles = ["admin"];
        route.signingCertificateEnrollment = undefined;
        route.audit = vi.fn().mockResolvedValue(undefined);
        const list = await route.list({} as any, { uid: "u", roles: ["admin"], elevated: Date.now() });
        expect(list).toEqual([]);
        expect(route.audit).toHaveBeenCalled();
    });
});
