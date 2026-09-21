///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the folder count derivation, cache refresh and live event. The grouped queries themselves run against
// real MongoDB and SQL in `test/routes/{mongo,sql}/FolderCounts.test.ts`; here the repositories are hand-built so the
// races and failures a real datastore can't be made to produce on demand (a lost version race, a failing count query, a
// failing publish) are covered too.
import { MongoRepository } from "@rapidrest/service-core";
import {
    coalesceFolderCounts,
    countMessagesByFolder,
    healStoredFolderCounts,
    notifyFolderCounts,
    refreshFolderCounts,
    type FolderCountsContext,
} from "../../src/util/FolderCountUtils.js";

class FolderClass {}

/** A message repo whose backing collection is a `MongoRepository` answering each `$group` from `rows(batch)`. */
function mongoMessageRepo(rows: (folderUids: string[]) => any[]): any {
    const repo: any = Object.create(MongoRepository.prototype);
    repo.aggregate = vi.fn((pipeline: any[]) => ({ toArray: async () => rows(pipeline[0].$match.folderUid.$in) }));
    return { repo };
}

/** A message repo whose backing table is a SQL repository whose query builder answers `rows`. */
function sqlMessageRepo(rows: any[]): any {
    const builder: any = {};
    for (const method of ["select", "addSelect", "where", "andWhere", "groupBy", "setParameter"]) {
        builder[method] = vi.fn().mockReturnValue(builder);
    }
    builder.getRawMany = vi.fn().mockResolvedValue(rows);
    return { repo: { createQueryBuilder: vi.fn().mockReturnValue(builder) }, builder };
}

describe("countMessagesByFolder()", () => {
    it("counts every named folder with one $group on MongoDB, and reports a folder with no messages as zero", async () => {
        const messageRepo = mongoMessageRepo(() => [{ _id: "a", totalCount: 3, unreadCount: 2 }]);

        const counts = await countMessagesByFolder(messageRepo, ["a", "b", "a"]);

        expect(counts).toEqual(
            new Map([
                ["a", { unreadCount: 2, totalCount: 3 }],
                ["b", { unreadCount: 0, totalCount: 0 }],
            ]),
        );
        expect(messageRepo.repo.aggregate).toHaveBeenCalledTimes(1);
        const [pipeline] = messageRepo.repo.aggregate.mock.calls[0];
        // Live messages only, grouped by folder; a message is unread unless its `flags.read` is true.
        expect(pipeline[0]).toEqual({ $match: { folderUid: { $in: ["a", "b"] }, deleted: false } });
        expect(pipeline[1].$group._id).toBe("$folderUid");
        expect(pipeline[1].$group.unreadCount).toEqual({ $sum: { $cond: [{ $eq: ["$flags.read", true] }, 0, 1] } });
    });

    it("groups on SQL by folderUid over the live rows, and reads the driver's string sums as numbers", async () => {
        const { repo, builder } = sqlMessageRepo([{ _id: "a", totalCount: "12", unreadCount: "5" }]);

        const counts = await countMessagesByFolder({ repo } as any, ["a"]);

        expect(counts.get("a")).toEqual({ unreadCount: 5, totalCount: 12 });
        expect(builder.groupBy).toHaveBeenCalledWith("m.folderUid");
        expect(builder.andWhere).toHaveBeenCalledWith("m.deleted = :deleted", { deleted: false });
        expect(builder.addSelect).toHaveBeenCalledWith("SUM(CASE WHEN m.flags LIKE :read THEN 0 ELSE 1 END)", "unreadCount");
        expect(builder.setParameter).toHaveBeenCalledWith("read", '%"read":true%');
        expect(builder.getRawMany).toHaveBeenCalledTimes(1);
    });

    it("asks in batches of 500 folders, so an IN list stays bounded, but never one query per folder", async () => {
        const uids = Array.from({ length: 501 }, (_, i) => `folder-${i}`);
        const messageRepo = mongoMessageRepo((batch) => batch.map((uid) => ({ _id: uid, totalCount: 1, unreadCount: 1 })));

        const counts = await countMessagesByFolder(messageRepo, uids);

        expect(messageRepo.repo.aggregate).toHaveBeenCalledTimes(2);
        expect(counts.size).toBe(501);
        expect(counts.get("folder-500")).toEqual({ unreadCount: 1, totalCount: 1 });
    });

    it("asks nothing for no folders", async () => {
        const messageRepo = mongoMessageRepo(() => []);

        expect((await countMessagesByFolder(messageRepo, [])).size).toBe(0);
        expect(messageRepo.repo.aggregate).not.toHaveBeenCalled();
    });
});

describe("refreshFolderCounts() / notifyFolderCounts() / coalesceFolderCounts()", () => {
    const stored = (over: any = {}) => ({ uid: "f1", mailboxUid: "m1", version: 4, unreadCount: 9, totalCount: 9, syncKeyVersion: 2, ...over });
    let derived: Record<string, { totalCount: number; unreadCount: number }>;
    let folders: Record<string, any>;
    let messageRepo: any;
    let folderRepo: any;
    let notificationUtils: { sendMessage: ReturnType<typeof vi.fn> };
    let logger: { warn: ReturnType<typeof vi.fn> };
    let ctx: FolderCountsContext;

    beforeEach(() => {
        derived = { f1: { totalCount: 3, unreadCount: 1 }, f2: { totalCount: 0, unreadCount: 0 } };
        folders = { f1: stored(), f2: stored({ uid: "f2", unreadCount: 0, totalCount: 0 }) };
        messageRepo = mongoMessageRepo((batch) => batch.filter((uid) => derived[uid]?.totalCount).map((uid) => ({ _id: uid, ...derived[uid] })));
        folderRepo = {
            findOne: vi.fn(async (uid: string) => folders[uid]),
            update: vi.fn().mockResolvedValue(undefined),
        };
        notificationUtils = { sendMessage: vi.fn() };
        logger = { warn: vi.fn() };
        ctx = { messageRepo, folderRepo, folderClass: FolderClass, notificationUtils: notificationUtils as any, logger };
    });

    it("stores the derived counts on the folder (version-checked, without publishing the record) and publishes them on the folder's and its mailbox's channel", async () => {
        await refreshFolderCounts(ctx, ["f1"]);

        expect(folderRepo.update).toHaveBeenCalledWith(
            { uid: "f1", version: 4, unreadCount: 1, totalCount: 3 },
            expect.anything(),
            { ignoreACL: true, skipPush: true },
        );
        expect(notificationUtils.sendMessage).toHaveBeenCalledTimes(1);
        expect(notificationUtils.sendMessage).toHaveBeenCalledWith(["f1", "m1"], "FolderClass", "update", {
            uid: "f1",
            mailboxUid: "m1",
            unreadCount: 1,
            totalCount: 3,
        });
    });

    it("publishes each folder once however often it is named, ignoring empty entries, with one count query", async () => {
        await refreshFolderCounts(ctx, ["f1", undefined, "f1", null, "", "f2"]);

        expect(notificationUtils.sendMessage).toHaveBeenCalledTimes(2);
        expect(messageRepo.repo.aggregate).toHaveBeenCalledTimes(1);
    });

    it("writes nothing when the stored counts are already right, but still publishes them", async () => {
        folders.f1 = stored({ unreadCount: 1, totalCount: 3 });

        await refreshFolderCounts(ctx, ["f1"]);

        expect(folderRepo.update).not.toHaveBeenCalled();
        expect(notificationUtils.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("bumps syncKeyVersion on request, even when the counts are unchanged, and from zero when it was never set", async () => {
        folders.f1 = stored({ unreadCount: 1, totalCount: 3, syncKeyVersion: undefined });

        await refreshFolderCounts(ctx, ["f1"], { bumpSyncKey: true });

        expect(folderRepo.update).toHaveBeenCalledWith(
            { uid: "f1", version: 4, unreadCount: 1, totalCount: 3, syncKeyVersion: 1 },
            expect.anything(),
            { ignoreACL: true, skipPush: true },
        );
    });

    it("recomputes the counts, not just the write, when another writer wins the folder's version", async () => {
        folderRepo.update.mockRejectedValueOnce(new Error("version conflict"));
        let call = 0;
        messageRepo.repo.aggregate = vi.fn(() => ({
            // A message arrives between the two counts.
            toArray: async () => [{ _id: "f1", totalCount: 3 + call++, unreadCount: 1 }],
        }));

        await refreshFolderCounts(ctx, ["f1"]);

        expect(messageRepo.repo.aggregate).toHaveBeenCalledTimes(2);
        expect(folderRepo.update).toHaveBeenCalledTimes(2);
        expect(folderRepo.update).toHaveBeenLastCalledWith({ uid: "f1", version: 4, unreadCount: 1, totalCount: 4 }, expect.anything(), expect.anything());
        expect(notificationUtils.sendMessage).toHaveBeenCalledTimes(1);
        expect(notificationUtils.sendMessage.mock.calls[0][3].totalCount).toBe(4);
    });

    it("gives up storing after three attempts, and still publishes what the messages say", async () => {
        folderRepo.update.mockRejectedValue(new Error("always conflicting"));

        await refreshFolderCounts(ctx, ["f1"]);

        expect(folderRepo.update).toHaveBeenCalledTimes(3);
        expect(notificationUtils.sendMessage).toHaveBeenCalledTimes(1);
        expect(notificationUtils.sendMessage.mock.calls[0][3]).toMatchObject({ unreadCount: 1, totalCount: 3 });
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("skips a folder that no longer exists, without failing the others", async () => {
        delete folders.f1;

        await refreshFolderCounts(ctx, ["f1", "f2"]);

        expect(notificationUtils.sendMessage).toHaveBeenCalledTimes(1);
        expect(notificationUtils.sendMessage.mock.calls[0][3].uid).toBe("f2");
    });

    it("works without a publisher", async () => {
        await refreshFolderCounts({ ...ctx, notificationUtils: undefined }, ["f1"]);

        expect(folderRepo.update).toHaveBeenCalledTimes(1);
    });

    it("never throws: a failing count query is logged - with or without a logger - and the write it follows is unaffected", async () => {
        messageRepo.repo.aggregate = vi.fn(() => {
            throw new Error("datastore down");
        });

        await expect(refreshFolderCounts(ctx, ["f1"])).resolves.toBeUndefined();
        await expect(refreshFolderCounts({ ...ctx, logger: undefined }, ["f1"])).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toContain("f1");
        expect(logger.warn.mock.calls[0][0]).toContain("datastore down");
        expect(notificationUtils.sendMessage).not.toHaveBeenCalled();
    });

    it("does nothing at all for no folders", async () => {
        await refreshFolderCounts(ctx, []);
        await refreshFolderCounts(ctx, [undefined]);

        expect(messageRepo.repo.aggregate).not.toHaveBeenCalled();
    });

    it("notifyFolderCounts() refreshes now outside a coalescing scope", async () => {
        await notifyFolderCounts(ctx, ["f1"]);

        expect(notificationUtils.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("coalesceFolderCounts() publishes each folder named while it runs once, when it ends - nested scopes join the outer one", async () => {
        const result = await coalesceFolderCounts(ctx, async () => {
            await notifyFolderCounts(ctx, ["f1", undefined]);
            await notifyFolderCounts(ctx, ["f1", "f2"]);
            const inner = await coalesceFolderCounts(ctx, async () => {
                await notifyFolderCounts(ctx, ["f2"]);
                return "inner";
            });
            expect(notificationUtils.sendMessage).not.toHaveBeenCalled();
            return inner;
        });

        expect(result).toBe("inner");
        expect(notificationUtils.sendMessage.mock.calls.map(([channels]) => channels[0]).sort()).toEqual(["f1", "f2"]);
        expect(messageRepo.repo.aggregate).toHaveBeenCalledTimes(1);
    });

    it("coalesceFolderCounts() still publishes for what a failing run had done, and rethrows", async () => {
        await expect(
            coalesceFolderCounts(ctx, async () => {
                await notifyFolderCounts(ctx, ["f1"]);
                throw new Error("stopped part-way");
            }),
        ).rejects.toThrow("stopped part-way");

        expect(notificationUtils.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("coalesceFolderCounts() builds its context only when a folder was named", async () => {
        const build = vi.fn(async () => ctx);

        await coalesceFolderCounts(build, async () => undefined);
        expect(build).not.toHaveBeenCalled();

        await coalesceFolderCounts(build, async () => notifyFolderCounts(ctx, ["f1"]));
        expect(build).toHaveBeenCalledTimes(1);
        expect(notificationUtils.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("does not leak a scope into the next call", async () => {
        await coalesceFolderCounts(ctx, async () => undefined);
        await notifyFolderCounts(ctx, ["f2"]);

        expect(notificationUtils.sendMessage).toHaveBeenCalledTimes(1);
    });
});

describe("healStoredFolderCounts()", () => {
    it("rewrites only the folders whose stored counts differ from the derived ones, and skips one with no derived entry", async () => {
        const folderRepo: any = { update: vi.fn().mockResolvedValue(undefined) };
        const wrong = { uid: "a", version: 2, unreadCount: 7, totalCount: 7 };
        const right = { uid: "b", version: 1, unreadCount: 1, totalCount: 2 };
        const unknown = { uid: "c", version: 1, unreadCount: 5, totalCount: 5 };

        await healStoredFolderCounts(
            folderRepo,
            [wrong, right, unknown],
            new Map([
                ["a", { unreadCount: 0, totalCount: 3 }],
                ["b", { unreadCount: 1, totalCount: 2 }],
            ]),
        );

        expect(folderRepo.update).toHaveBeenCalledTimes(1);
        expect(folderRepo.update).toHaveBeenCalledWith({ uid: "a", version: 2, unreadCount: 0, totalCount: 3 }, wrong, {
            ignoreACL: true,
            skipPush: true,
        });
    });

    it("leaves a folder it can't update for whoever changes it next", async () => {
        const folderRepo: any = { update: vi.fn().mockRejectedValue(new Error("version conflict")) };

        await expect(
            healStoredFolderCounts(folderRepo, [{ uid: "a", version: 2, unreadCount: 7, totalCount: 7 }], new Map([["a", { unreadCount: 0, totalCount: 0 }]])),
        ).resolves.toBeUndefined();
    });
});
