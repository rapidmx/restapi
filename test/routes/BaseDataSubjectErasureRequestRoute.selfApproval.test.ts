///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `mail:erasure:allow_self_approval` (X2-11): a deployment with a single administrator can approve its own erasure request, audited as such.
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";

const audit = vi.fn().mockResolvedValue(undefined);

import { DataSubjectErasureRequestRouteSQL } from "../../src/routes/sql/DataSubjectErasureRequestRouteSQL.js";

describe("DataSubjectErasureRequest approval of one's own request", () => {
    const admin: any = { uid: "11111111-1111-4111-8111-111111111111", roles: ["admin"], elevated: Date.now() };

    async function newRoute(allowSelfApproval: boolean): Promise<any> {
        const objectFactory = new ObjectFactory(undefined, Logger());
        const route: any = await objectFactory.newInstance(DataSubjectErasureRequestRouteSQL, { name: "default", initialize: false });
        const request: any = { uid: "r1", version: 1, status: "pending", mailboxUid: "m1", requestedByUserUid: admin.uid };
        Object.assign(route, {
            trustedRoles: ["admin"],
            allowSelfApproval,
            init: async () => undefined,
            auditLogUtils: { record: audit },
            matterRepo: { find: async () => [] },
            requestRepo: { findOne: async () => request, update: async (patch: any) => ({ ...request, ...patch }) },
        });
        return route;
    }

    beforeEach(() => audit.mockClear());

    it("is refused by default", async () => {
        await expect((await newRoute(false)).approve("r1", admin)).rejects.toMatchObject({ status: 403 });
        expect(audit).not.toHaveBeenCalled();
    });

    it("is allowed when the deployment says it has no one else, and audited as a self-approval", async () => {
        const approved = await (await newRoute(true)).approve("r1", admin);
        expect(approved).toMatchObject({ status: "approved", reviewedByUserUid: admin.uid });
        expect(audit.mock.calls[0][0]).toMatchObject({ details: { selfApproved: true } });
    });
});
