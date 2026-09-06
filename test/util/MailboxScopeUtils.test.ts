///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for resolveCallerMailboxUid() - a hand-built RepoUtils-shaped mock stands in for the
// real Mongo/SQL mailbox repository.
import { resolveCallerMailboxUid } from "../../src/util/MailboxScopeUtils.js";

function makeRepo(overrides: any = {}) {
    return {
        find: vi.fn().mockResolvedValue([]),
        ...overrides,
    };
}

describe("resolveCallerMailboxUid() Tests", () => {
    it("Returns undefined without calling find() when no user is provided.", async () => {
        const repo = makeRepo();

        const result = await resolveCallerMailboxUid(repo, undefined);

        expect(result).toBeUndefined();
        expect(repo.find).not.toHaveBeenCalled();
    });

    it("Returns the uid of the found mailbox, scoped by ownerUserUid with ignoreACL.", async () => {
        const repo = makeRepo({ find: vi.fn().mockResolvedValue([{ uid: "mbx-1" }]) });
        const user: any = { uid: "user-1", roles: [] };

        const result = await resolveCallerMailboxUid(repo, user);

        expect(result).toBe("mbx-1");
        expect(repo.find).toHaveBeenCalledWith({ ownerUserUid: "user-1" }, { ignoreACL: true, limit: 1 });
    });

    it("Returns undefined when the user owns no mailbox.", async () => {
        const repo = makeRepo({ find: vi.fn().mockResolvedValue([]) });
        const user: any = { uid: "user-with-no-mailbox", roles: [] };

        const result = await resolveCallerMailboxUid(repo, user);

        expect(result).toBeUndefined();
    });
});
