///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for findOrCreateWellKnownFolder() - a hand-built RepoUtils-shaped mock and a fake
// folder class stand in for the real Mongo/SQL repository/entity.
import { findOrCreateWellKnownFolder } from "../../src/util/FolderUtils.js";
import { FolderType } from "../../src/models/types.js";

/** A fake Folder entity class that just captures the data it was constructed with. */
class FakeFolder {
    public uid: string = "new-folder-uid";
    public data: any;
    constructor(data: any) {
        this.data = data;
        Object.assign(this, data);
    }
}

function makeRepo(overrides: any = {}) {
    return {
        find: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockImplementation(async (instance: any) => instance),
        ...overrides,
    };
}

describe("findOrCreateWellKnownFolder() Tests", () => {
    it("Returns the existing folder without calling create() when one is already found.", async () => {
        const existingFolder = { uid: "existing-uid", type: FolderType.INBOX };
        const repo = makeRepo({ find: vi.fn().mockResolvedValue([existingFolder]) });

        const result = await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);

        expect(result).toBe(existingFolder);
        expect(repo.create).not.toHaveBeenCalled();
        expect(repo.find).toHaveBeenCalledWith(
            { mailboxUid: "mbx-1", type: FolderType.INBOX },
            { ignoreACL: true, limit: 1 },
        );
    });

    it("Creates a new folder with the correct default name/type/mailboxUid when none exists.", async () => {
        const repo = makeRepo();

        const result: any = await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.JUNK);

        expect(repo.create).toHaveBeenCalledTimes(1);
        const [createdInstance] = repo.create.mock.calls[0];
        expect(createdInstance).toBeInstanceOf(FakeFolder);
        expect(createdInstance.data).toEqual({
            mailboxUid: "mbx-1",
            name: "Junk Email",
            type: FolderType.JUNK,
            unreadCount: 0,
            totalCount: 0,
            syncKeyVersion: 0,
        });
        expect(result).toBe(createdInstance);
    });

    it("Seeds the ACL with {uid, parentUid: mailboxUid, records: []} when creating.", async () => {
        const repo = makeRepo();

        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-42", FolderType.SENT_ITEMS);

        const [createdInstance, options] = repo.create.mock.calls[0];
        expect(options).toEqual(
            expect.objectContaining({
                ignoreACL: true,
                acl: { uid: createdInstance.uid, parentUid: "mbx-42", records: [] },
            }),
        );
    });

    it("Passes the given user through to create()'s options.", async () => {
        const repo = makeRepo();
        const user: any = { uid: "user-1", roles: [] };

        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.CALENDAR, user);

        const [, options] = repo.create.mock.calls[0];
        expect(options.user).toBe(user);
    });

    it("Uses each well-known type's own conventional default name.", async () => {
        const repo = makeRepo();

        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.CONTACTS);

        const [createdInstance] = repo.create.mock.calls[0];
        expect(createdInstance.data.name).toBe("Contacts");
    });
});
