///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for findOrCreateWellKnownFolder() - a hand-built RepoUtils-shaped mock and a fake
// folder class stand in for the real Mongo/SQL repository/entity.
import { findOrCreateWellKnownFolder, getMailboxUidForFolder, wellKnownFolderUid } from "../../src/util/FolderUtils.js";
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
        // Sorted oldest-first so every caller settles on the same folder when duplicates already exist.
        expect(repo.find).toHaveBeenCalledWith(
            { mailboxUid: "mbx-1", type: FolderType.INBOX, sort: { dateCreated: "ASC", uid: "ASC" }, limit: 1 },
            { ignoreACL: true, limit: 1, skipCache: true },
        );
    });

    it("Creates a new folder with the correct default name/type/mailboxUid when none exists.", async () => {
        const repo = makeRepo();

        const result: any = await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.JUNK);

        expect(repo.create).toHaveBeenCalledTimes(1);
        const [createdInstance] = repo.create.mock.calls[0];
        expect(createdInstance).toBeInstanceOf(FakeFolder);
        expect(createdInstance.data).toEqual({
            uid: wellKnownFolderUid("mbx-1", FolderType.JUNK),
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

    it("Derives a stable, per-mailbox-and-type RFC 4122 version 5 uid.", () => {
        const uid = wellKnownFolderUid("mbx-1", FolderType.INBOX);
        expect(uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(wellKnownFolderUid("mbx-1", FolderType.INBOX)).toBe(uid);
        expect(wellKnownFolderUid("mbx-2", FolderType.INBOX)).not.toBe(uid);
        expect(wellKnownFolderUid("mbx-1", FolderType.JUNK)).not.toBe(uid);
    });

    it("Returns the concurrently created folder when its own create() loses the race on the deterministic uid.", async () => {
        const winner = { uid: wellKnownFolderUid("mbx-1", FolderType.INBOX), type: FolderType.INBOX };
        const repo = makeRepo({
            find: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([winner]),
            create: vi.fn().mockRejectedValue(new Error("duplicate key")),
        });

        const result = await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);

        expect(result).toBe(winner);
        expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it("Falls back to a random uid when a soft-deleted folder already holds the deterministic uid.", async () => {
        const repo = makeRepo({
            create: vi
                .fn()
                .mockRejectedValueOnce(new Error("duplicate key"))
                .mockImplementation(async (instance: any) => instance),
            findOne: vi.fn().mockResolvedValue({ uid: wellKnownFolderUid("mbx-1", FolderType.INBOX), deleted: true }),
        });

        const result: any = await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);

        expect(repo.create).toHaveBeenCalledTimes(2);
        expect(repo.findOne).toHaveBeenCalledWith(wellKnownFolderUid("mbx-1", FolderType.INBOX), { ignoreACL: true, includeDeleted: true });
        expect(result.data.uid).toBeUndefined();
    });

    it("Rethrows a create() failure that isn't a lost race.", async () => {
        const repo = makeRepo({
            create: vi.fn().mockRejectedValue(new Error("connection lost")),
            findOne: vi.fn().mockResolvedValue(undefined),
        });

        await expect(findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX)).rejects.toThrow("connection lost");
    });

    it("Lets only a deterministic-uid create reuse an existing ACL (service-core 2.1.0 allowExistingACL).", async () => {
        const repo = makeRepo({
            create: vi
                .fn()
                .mockRejectedValueOnce(new Error("duplicate key"))
                .mockImplementation(async (instance: any) => instance),
            findOne: vi.fn().mockResolvedValue({ uid: wellKnownFolderUid("mbx-1", FolderType.INBOX), deleted: true }),
        });

        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);

        expect(repo.create.mock.calls[0][1].allowExistingACL).toBe(true);
        // The random-uid fallback keeps service-core's default refusal.
        expect(repo.create.mock.calls[1][1].allowExistingACL).toBeUndefined();
    });

    it("Resets a leftover ACL at the deterministic uid to a fresh, mailbox-parented ACL once the create wins the uid.", async () => {
        const uid = wellKnownFolderUid("mbx-1", FolderType.INBOX);
        const leftover = { uid, parentUid: "someone-else", records: [{ userOrRoleId: "stale-token", actions: ["read"] }], version: 3 };
        const current = { ...leftover, records: [...leftover.records] };
        const aclUtils = {
            findACL: vi.fn().mockResolvedValueOnce(leftover).mockResolvedValueOnce(current),
            saveACL: vi.fn().mockResolvedValue(undefined),
        };
        const repo: any = makeRepo();
        repo.aclUtils = aclUtils;

        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);

        expect(aclUtils.findACL).toHaveBeenCalledWith(uid, [], { skipCache: true, skipParents: true });
        expect(repo.create.mock.calls[0][1]).toEqual(expect.objectContaining({ allowExistingACL: true }));
        expect(aclUtils.saveACL).toHaveBeenCalledWith({ uid, parentUid: "mbx-1", records: [], version: 3 });
    });

    it("Leaves the ACL alone when none was at the deterministic uid before the create, or it is gone after.", async () => {
        const aclUtils = { findACL: vi.fn().mockResolvedValue(undefined), saveACL: vi.fn() };
        const repo: any = makeRepo();
        repo.aclUtils = aclUtils;
        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);
        expect(aclUtils.findACL).toHaveBeenCalledTimes(1);

        aclUtils.findACL.mockReset().mockResolvedValueOnce({ uid: "x", parentUid: "mbx-1", records: [] }).mockResolvedValueOnce(undefined);
        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.DRAFTS);
        expect(aclUtils.findACL).toHaveBeenCalledTimes(2);
        expect(aclUtils.saveACL).not.toHaveBeenCalled();
    });

    it("Uses 'Archive' as the default name for FolderType.ARCHIVE.", async () => {
        const repo = makeRepo();

        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.ARCHIVE);

        const [createdInstance] = repo.create.mock.calls[0];
        expect(createdInstance.data.name).toBe("Archive");
    });
});

// Isolated unit tests for getMailboxUidForFolder() - a hand-built objectFactory/repo mock stands in for a
// real Mongo/SQL repository, matching test/util/LegalHoldUtils.test.ts's identical rationale (this
// function caches one RepoUtils per `folderClass` object identity in a module-level WeakMap, so each test
// declares its own fresh, locally-scoped stub class rather than a single shared one).
describe("getMailboxUidForFolder() Tests", () => {
    function makeStubFolderClass(): any {
        return class StubFolder {};
    }

    function makeObjectFactory(repo: any): any {
        return { newInstance: vi.fn().mockResolvedValue(repo) };
    }

    it("Returns the real mailboxUid of the resolved folder.", async () => {
        const repo = { findOne: vi.fn().mockResolvedValue({ uid: "folder-1", mailboxUid: "mailbox-real" }) };
        const objectFactory = makeObjectFactory(repo);

        const result = await getMailboxUidForFolder(objectFactory, makeStubFolderClass(), "folder-1");

        expect(result).toBe("mailbox-real");
        expect(repo.findOne).toHaveBeenCalledWith("folder-1", { ignoreACL: true });
    });

    it("Returns undefined when no such folder exists.", async () => {
        const repo = { findOne: vi.fn().mockResolvedValue(undefined) };
        const objectFactory = makeObjectFactory(repo);

        const result = await getMailboxUidForFolder(objectFactory, makeStubFolderClass(), "no-such-folder");

        expect(result).toBeUndefined();
    });
});
