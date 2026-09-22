///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for findOrCreateWellKnownFolder() - a hand-built RepoUtils-shaped mock and a fake
// folder class stand in for the real Mongo/SQL repository/entity.
import {
    ensureWellKnownFolders,
    findOrCreateWellKnownFolder,
    getMailboxUidForFolder,
    WELL_KNOWN_FOLDER_TYPES,
    wellKnownFolderUid,
} from "../../src/util/FolderUtils.js";
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
        expect(repo.findOne).toHaveBeenCalledWith(wellKnownFolderUid("mbx-1", FolderType.INBOX), { ignoreACL: true, includeDeleted: true, skipCache: true });
        expect(result.data.uid).toBeUndefined();
    });

    it("Uses the winner - never a random-uid duplicate - when its row only becomes visible after the type lookup came up empty.", async () => {
        const winner = { uid: wellKnownFolderUid("mbx-1", FolderType.NOTES), type: FolderType.NOTES };
        const repo = makeRepo({
            // Lost the race, and the type lookup ran before the winner's insert was visible ...
            create: vi.fn().mockRejectedValue(new Error("duplicate key")),
            find: vi.fn().mockResolvedValue([]),
            // ... but the uid lookup sees it (a live row, not a soft-deleted one).
            findOne: vi.fn().mockResolvedValue(winner),
        });

        const result = await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.NOTES);

        expect(result).toBe(winner);
        expect(repo.create).toHaveBeenCalledTimes(1);
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

    it("Doesn't reset anything when no ACL was at the deterministic uid before the create, and only recreates a missing one.", async () => {
        const uid = wellKnownFolderUid("mbx-1", FolderType.INBOX);
        const fresh = { uid, parentUid: "mbx-1", records: [], version: 0 };
        // Before the create: none. After it: the ACL the create claimed is there - nothing to save.
        const aclUtils = { findACL: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(fresh), saveACL: vi.fn() };
        const repo: any = makeRepo();
        repo.aclUtils = aclUtils;
        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);
        expect(aclUtils.findACL).toHaveBeenCalledTimes(2);
        expect(aclUtils.saveACL).not.toHaveBeenCalled();

        // A leftover that is gone again by the reset: nothing to reset, but the folder's ACL is recreated.
        aclUtils.findACL.mockReset().mockResolvedValueOnce({ uid, parentUid: "mbx-1", records: [] }).mockResolvedValue(undefined);
        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.DRAFTS);
        expect(aclUtils.saveACL).toHaveBeenCalledTimes(1);
        expect(aclUtils.saveACL).toHaveBeenCalledWith({ uid: wellKnownFolderUid("mbx-1", FolderType.DRAFTS), parentUid: "mbx-1", records: [] }, { createOnly: true });
    });

    it("Removes only the leftover snapshot's records on reset, keeping a grant made after the insert (round 6).", async () => {
        const uid = wellKnownFolderUid("mbx-1", FolderType.INBOX);
        const leftover = { uid, parentUid: "old-parent", records: [{ userOrRoleId: "stale", actions: ["read", "list"] }], version: 3 };
        const current = {
            uid,
            parentUid: "old-parent",
            records: [
                { userOrRoleId: "stale", actions: ["list", "read"] },
                { userOrRoleId: "new-delegate", actions: ["read"] },
            ],
            version: 4,
        };
        const aclUtils = {
            findACL: vi.fn().mockResolvedValueOnce(leftover).mockResolvedValueOnce(current).mockResolvedValue({ ...current }),
            saveACL: vi.fn().mockResolvedValue(undefined),
        };
        const repo: any = makeRepo();
        repo.aclUtils = aclUtils;

        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);

        expect(aclUtils.saveACL).toHaveBeenCalledTimes(1);
        expect(aclUtils.saveACL).toHaveBeenCalledWith({ uid, parentUid: "mbx-1", records: [{ userOrRoleId: "new-delegate", actions: ["read"] }], version: 4 });
    });

    it("Retries the reset on a concurrent ACL save, skips it when nothing is left to change, and gives up after three attempts.", async () => {
        const uid = wellKnownFolderUid("mbx-1", FolderType.INBOX);
        const leftover = { uid, parentUid: "mbx-1", records: [{ userOrRoleId: "stale", actions: ["read"] }], version: 1 };
        const aclUtils = {
            findACL: vi.fn().mockImplementation(async () => ({ ...leftover, records: [...leftover.records] })),
            saveACL: vi.fn().mockRejectedValueOnce(new Error("The acl to save must be of the same version.")).mockResolvedValue(undefined),
        };
        const repo: any = makeRepo();
        repo.aclUtils = aclUtils;
        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);
        expect(aclUtils.saveACL).toHaveBeenCalledTimes(2);

        // Already reset (parent is the mailbox, no stale records): no write.
        aclUtils.saveACL.mockReset();
        aclUtils.findACL.mockReset().mockResolvedValueOnce(leftover).mockResolvedValue({ uid, parentUid: "mbx-1", records: [], version: 2 });
        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.JUNK);
        expect(aclUtils.saveACL).not.toHaveBeenCalled();

        // Every save conflicts: the create has succeeded, so the lost reset surfaces through the re-read path, which
        // returns the (now visible) folder.
        const created = { uid: wellKnownFolderUid("mbx-1", FolderType.TASKS), type: FolderType.TASKS };
        repo.find = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([created]);
        aclUtils.findACL.mockReset().mockImplementation(async () => ({ ...leftover, records: [...leftover.records] }));
        aclUtils.saveACL.mockReset().mockRejectedValue(new Error("conflict"));
        await expect(findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.TASKS)).resolves.toBe(created);
        expect(aclUtils.saveACL).toHaveBeenCalledTimes(3);
    });

    it("Recreates the winner's ACL when this create lost the race after the winner reused the ACL this create claimed (round 6).", async () => {
        const uid = wellKnownFolderUid("mbx-1", FolderType.INBOX);
        const winner = { uid, type: FolderType.INBOX };
        const aclUtils = { findACL: vi.fn().mockResolvedValue(undefined), saveACL: vi.fn().mockResolvedValue(undefined) };
        const repo: any = makeRepo({
            find: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([winner]),
            create: vi.fn().mockRejectedValue(new Error("duplicate key")),
        });
        repo.aclUtils = aclUtils;

        await expect(findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX)).resolves.toBe(winner);
        expect(aclUtils.saveACL).toHaveBeenCalledWith({ uid, parentUid: "mbx-1", records: [] }, { createOnly: true });

        // A concurrent repair got there first: its IDENTIFIER_EXISTS is fine. Any other failure with no ACL is thrown.
        aclUtils.findACL.mockReset().mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockResolvedValue({ uid, parentUid: "mbx-1", records: [] });
        aclUtils.saveACL.mockReset().mockRejectedValue(new Error("exists"));
        repo.find = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([winner]);
        await expect(findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX)).resolves.toBe(winner);

        aclUtils.findACL.mockReset().mockResolvedValue(undefined);
        aclUtils.saveACL.mockReset().mockRejectedValue(new Error("acl store down"));
        repo.find = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([winner]);
        await expect(findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX)).rejects.toThrow("acl store down");

        // A winner under another uid (an older duplicate) is returned as it is.
        const older = { uid: "older-random-uid", type: FolderType.INBOX };
        aclUtils.saveACL.mockReset();
        repo.find = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([older]);
        await expect(findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX)).resolves.toBe(older);
        expect(aclUtils.saveACL).not.toHaveBeenCalled();
    });

    it("Repairs a missing ACL of an existing deterministic-uid folder, reading the cache first (round 6).", async () => {
        const uid = wellKnownFolderUid("mbx-1", FolderType.INBOX);
        const aclUtils = { findACL: vi.fn().mockResolvedValue({ uid, parentUid: "mbx-1", records: [] }), saveACL: vi.fn() };
        const repo: any = makeRepo({ find: vi.fn().mockResolvedValue([{ uid, type: FolderType.INBOX }]) });
        repo.aclUtils = aclUtils;
        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);
        expect(aclUtils.findACL).toHaveBeenCalledTimes(1);
        expect(aclUtils.findACL).toHaveBeenCalledWith(uid, [], { skipCache: false, skipParents: true });

        // A cache miss is confirmed uncached, then recreated.
        aclUtils.findACL.mockReset().mockResolvedValue(undefined);
        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);
        expect(aclUtils.findACL).toHaveBeenCalledWith(uid, [], { skipCache: true, skipParents: true });
        expect(aclUtils.saveACL).toHaveBeenCalledWith({ uid, parentUid: "mbx-1", records: [] }, { createOnly: true });

        // A random-uid folder isn't touched.
        aclUtils.findACL.mockReset();
        repo.find = vi.fn().mockResolvedValue([{ uid: "random", type: FolderType.INBOX }]);
        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.INBOX);
        expect(aclUtils.findACL).not.toHaveBeenCalled();
    });

    it("Uses 'Archive' as the default name for FolderType.ARCHIVE.", async () => {
        const repo = makeRepo();

        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.ARCHIVE);

        const [createdInstance] = repo.create.mock.calls[0];
        expect(createdInstance.data.name).toBe("Archive");
    });

    it("Asks create() to publish the new folder on the mailbox's channel as well as its own (pushChannels), for either uid.", async () => {
        const repo = makeRepo();
        await findOrCreateWellKnownFolder(repo, FakeFolder, "mbx-1", FolderType.OUTBOX);
        expect(repo.create.mock.calls[0][1].pushChannels).toEqual(["mbx-1"]);

        const fallback = makeRepo({
            create: vi
                .fn()
                .mockRejectedValueOnce(new Error("duplicate key"))
                .mockImplementation(async (instance: any) => instance),
            findOne: vi.fn().mockResolvedValue({ uid: wellKnownFolderUid("mbx-1", FolderType.INBOX), deleted: true }),
        });
        await findOrCreateWellKnownFolder(fallback, FakeFolder, "mbx-1", FolderType.INBOX);
        expect(fallback.create.mock.calls[1][1].pushChannels).toEqual(["mbx-1"]);
    });
});

describe("ensureWellKnownFolders() Tests", () => {
    it("Lists every mail folder plus calendar, contacts, tasks and notes, and never the user type.", () => {
        expect([...WELL_KNOWN_FOLDER_TYPES]).toEqual([
            FolderType.INBOX,
            FolderType.DRAFTS,
            FolderType.OUTBOX,
            FolderType.SENT_ITEMS,
            FolderType.DELETED_ITEMS,
            FolderType.JUNK,
            FolderType.ARCHIVE,
            FolderType.CALENDAR,
            FolderType.CONTACTS,
            FolderType.TASKS,
            FolderType.NOTES,
        ]);
    });

    it("Costs one uncached existence query and writes nothing when the mailbox already has every well-known folder.", async () => {
        const present = WELL_KNOWN_FOLDER_TYPES.map((type) => ({ uid: `f-${type}`, type }));
        const repo = makeRepo({ find: vi.fn().mockResolvedValue([...present, { uid: "mine", type: FolderType.USER }]) });

        const ensured = await ensureWellKnownFolders(repo, FakeFolder, "mbx-1");

        expect(ensured).toEqual([]);
        expect(repo.find).toHaveBeenCalledTimes(1);
        expect(repo.create).not.toHaveBeenCalled();
        const [query, options] = repo.find.mock.calls[0];
        expect(query.type).toEqual([...WELL_KNOWN_FOLDER_TYPES]);
        expect(options).toEqual(expect.objectContaining({ ignoreACL: true, skipCache: true }));
    });

    it("Creates exactly the missing ones, in the well-known order, through findOrCreateWellKnownFolder().", async () => {
        // The existence query sees the Inbox and Drafts; each single-folder lookup that follows sees nothing.
        const find = vi
            .fn()
            .mockResolvedValueOnce([
                { uid: "inbox", type: FolderType.INBOX },
                { uid: "drafts", type: FolderType.DRAFTS },
            ])
            .mockResolvedValue([]);
        const repo = makeRepo({ find });

        const ensured: any[] = await ensureWellKnownFolders(repo, FakeFolder, "mbx-1");

        expect(ensured.map((folder) => folder.data.type)).toEqual(WELL_KNOWN_FOLDER_TYPES.filter((type) => type !== FolderType.INBOX && type !== FolderType.DRAFTS));
        expect(repo.create).toHaveBeenCalledTimes(9);
        expect(ensured[0].uid).toBe(wellKnownFolderUid("mbx-1", FolderType.OUTBOX));
    });

    it("Passes the creator through to each create() (the mailbox-creation path), and none when healing on read.", async () => {
        const user: any = { uid: "user-1", roles: [] };
        const creating = makeRepo();
        await ensureWellKnownFolders(creating, FakeFolder, "mbx-1", user);
        expect(creating.create).toHaveBeenCalledTimes(WELL_KNOWN_FOLDER_TYPES.length);
        expect(creating.create.mock.calls.every(([, options]: any[]) => options.user === user)).toBe(true);

        const healing = makeRepo();
        await ensureWellKnownFolders(healing, FakeFolder, "mbx-1");
        expect(healing.create.mock.calls.every(([, options]: any[]) => options.user === undefined)).toBe(true);
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
