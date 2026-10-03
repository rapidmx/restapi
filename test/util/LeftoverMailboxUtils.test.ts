///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `fileLeftoverErasure()` through its context: the built `matterRepo` and `auditLogUtils`.
import { AuditAction } from "../../src/models/types.js";
import { fileLeftoverErasure } from "../../src/util/LeftoverMailboxUtils.js";

class RequestModel {
    constructor(init: any) {
        Object.assign(this, init, { uid: "request-1" });
    }
}

function makeRepos(matters: any[] = []) {
    const matterRepo: any = { find: vi.fn(async () => matters) };
    const created: any[] = [];
    const requestRepo: any = {
        find: vi.fn(async () => []),
        create: vi.fn(async (r: any) => {
            created.push(r);
            return r;
        }),
    };
    return {
        matterRepo,
        requestRepo,
        mailboxRepo: { findOne: vi.fn(async () => undefined) } as any,
        folderRepo: { count: vi.fn(async () => 2) } as any,
        created,
    };
}

const caller: any = { user: { uid: "admin-1" }, req: undefined };

describe("fileLeftoverErasure() context Tests", () => {
    it("checks the legal hold on the built matter repository and audits through the built audit service", async () => {
        const repos = makeRepos();
        const auditLogUtils: any = { record: vi.fn(async () => undefined) };
        const result = await fileLeftoverErasure({ ...repos, requestClass: RequestModel, matterRepo: repos.matterRepo, auditLogUtils }, caller, "gone@example.com");

        expect(result.created).toBe(true);
        expect(repos.matterRepo.find).toHaveBeenCalled();
        expect(auditLogUtils.record).toHaveBeenCalledTimes(2);
        expect(auditLogUtils.record).toHaveBeenNthCalledWith(
            1,
            { action: AuditAction.ERASURE_REQUEST_CREATED, targetType: "DataSubjectErasureRequest", targetUid: "request-1", mailboxUid: "gone@example.com", details: { leftover: true, folderCount: 2 } },
            { req: undefined, user: caller.user },
        );
    });

    it("blocks on a legal hold found through the built matter repository", async () => {
        const repos = makeRepos([{ uid: "matter-1", custodianMailboxUids: ["gone@example.com"] }]);
        await expect(
            fileLeftoverErasure({ ...repos, requestClass: RequestModel, auditLogUtils: { record: vi.fn() } as any }, caller, "gone@example.com"),
        ).rejects.toMatchObject({ status: 409 });
    });
});
