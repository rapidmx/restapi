///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseAttachmentRoute, reserved ONLY for the `!this.repoUtils`/`!this.blobStore`
// defensive guard branches that a real wired server can never exercise (DI always populates both
// before a request can reach a route). Every other behavior - a missing required upload query
// parameter, mimeType/contentId arriving as an array (a real HTTP client CAN produce this by repeating
// a query key, e.g. `?mimeType=a&mimeType=b`), mimeType being omitted entirely, downloading a
// nonexistent attachment, and an inline attachment's content-disposition - is exercised via real
// HTTP+DB requests in test/routes/mongo/AttachmentRoute.test.ts (and its sql/ counterpart).
//
// The route instance itself is still scaffolded through a real `ObjectFactory` (`newInstance(...,
// { initialize: false })`), not a bare `new TestAttachmentRoute()` - this registers the class and tags
// the instance the same way production DI does, while `initialize: false` deliberately skips the
// `@Config`/`@Logger`/`@Inject` injection and `@Init` phase, which is exactly what leaves `repoUtils`/
// `blobStore` genuinely `undefined` for these guard-clause tests to observe.
import config from "../config.js";
import { ObjectFactory, QueryLiteral } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseAttachmentRoute } from "../../src/routes/BaseAttachmentRoute.js";

class TestAttachmentRoute extends BaseAttachmentRoute<any> {}

function makeReq(overrides: Partial<{ query: Record<string, any>; rawBody: Buffer }> = {}): any {
    return {
        query: overrides.query ?? {},
        rawBody: overrides.rawBody,
    };
}

function makeRes(): any {
    return {
        setHeader: vi.fn().mockReturnThis(),
        send: vi.fn(),
    };
}

describe("BaseAttachmentRoute Tests (repoUtils/blobStore guard clauses only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("upload() throws INTERNAL_ERROR when repoUtils/blobStore are not set.", async () => {
        const route = objectFactory.newInstance<TestAttachmentRoute>(TestAttachmentRoute, { initialize: false });
        const req = makeReq();

        await expect(route.upload(req, { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });

    it("Logs a warning when a post-store-failure quota refund itself fails every retry attempt (round 7).", async () => {
        const route = objectFactory.newInstance<TestAttachmentRoute>(TestAttachmentRoute, { initialize: false });
        (route as any).repoUtils = {};
        (route as any).aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        (route as any).messageRepo = { findOne: vi.fn().mockResolvedValue({ uid: "m1", folderUid: "f1", mailboxUid: "mb" }) };
        (route as any).mailboxRepo = {
            findOne: vi.fn().mockResolvedValue({ uid: "mb", version: 0, quotaBytes: 1000, usedBytes: 0 }),
            // The charge itself succeeds; every subsequent call (the refund's own retry loop) then fails.
            update: vi.fn().mockResolvedValueOnce({ uid: "mb", version: 1 }).mockRejectedValue(new Error("simulated persistent conflict")),
        };
        (route as any).blobStore = { put: vi.fn().mockRejectedValue(new Error("simulated blob store failure")) };
        const warn = vi.fn();
        (route as any).logger = { warn };
        const req = makeReq({ query: { messageUid: "m1", filename: "test.txt", mimeType: "text/plain" }, rawBody: Buffer.from("hello") });

        await expect(route.upload(req, { uid: "user-1" } as any)).rejects.toThrow(/simulated blob store failure/);

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("failed to refund"));
    });

    it("download() throws INTERNAL_ERROR when repoUtils/blobStore are not set.", async () => {
        const route = objectFactory.newInstance<TestAttachmentRoute>(TestAttachmentRoute, { initialize: false });
        const res = makeRes();

        await expect(route.download("id-1", res, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });
    it("count() and truncate() page through a folder-scoped scan until a short page (round 5).", async () => {
        const route = objectFactory.newInstance<TestAttachmentRoute>(TestAttachmentRoute, { initialize: false });
        (route as any).folderScanPageSize = 1;
        const a1 = { uid: "a1", messageUid: "m1", folderUid: "f1", mailboxUid: "mb" };
        const a2 = { uid: "a2", messageUid: "m1", folderUid: "f1", mailboxUid: "mb" };
        const find = vi.fn().mockResolvedValueOnce([a1]).mockResolvedValueOnce([a2]).mockResolvedValue([]);
        (route as any).repoUtils = { find, truncate: vi.fn() };
        (route as any).aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        (route as any).messageRepo = { findOne: vi.fn().mockResolvedValue({ uid: "m1", folderUid: "f1", mailboxUid: "mb" }) };
        const res: any = { status: vi.fn().mockReturnThis(), setHeader: vi.fn().mockReturnThis() };

        await route.count({}, { folderUid: "f1" }, res, { uid: "user-1" } as any);
        expect(res.setHeader).toHaveBeenCalledWith("content-length", 2);
        expect(find).toHaveBeenCalledTimes(3);

        find.mockReset().mockResolvedValueOnce([a1]).mockResolvedValueOnce([a2]).mockResolvedValue([]);
        await route.truncate({}, { folderUid: "f1" }, { uid: "user-1" } as any);
        // Round 6: the re-stamp scan is keyset-paged on uid (two full pages, then an empty one past a2), then the inherited
        // truncate's own scan.
        const scans = find.mock.calls.filter(([criteria]) => criteria.folderUid instanceof QueryLiteral && criteria.folderUid.value === "f1" && criteria.sort?.uid === "ASC");
        expect(scans.map(([criteria]) => criteria.uid)).toEqual([undefined, "gt(a1)", "gt(a2)"]);
    });

    it("truncate()'s re-stamp scan doesn't skip stale rows when re-stamping moves earlier rows out of the folder (round 6).", async () => {
        const route = objectFactory.newInstance<TestAttachmentRoute>(TestAttachmentRoute, { initialize: false });
        (route as any).folderScanPageSize = 2;
        // Five attachments stamped f1 whose message has moved to f2. The fake repo answers the folder scan from live state,
        // so every re-stamp removes a row from the result set, as a real backend does.
        const rows = ["a1", "a2", "a3", "a4", "a5"].map((uid) => ({ uid, messageUid: "m1", folderUid: "f1", mailboxUid: "mb", version: 0 }));
        const find = vi.fn().mockImplementation(async (criteria: any) => {
            const after: string | undefined = typeof criteria.uid === "string" ? criteria.uid.slice(3, -1) : undefined;
            const matching = rows.filter((row) => row.folderUid === criteria.folderUid.value && (after === undefined || row.uid > after));
            const offset: number = (criteria.page ?? 0) * (criteria.limit ?? 100);
            return matching.slice(offset, offset + (criteria.limit ?? 100)).map((row) => ({ ...row }));
        });
        const update = vi.fn().mockImplementation(async (patch: any) => {
            const row = rows.find((candidate) => candidate.uid === patch.uid)!;
            Object.assign(row, { folderUid: patch.folderUid, mailboxUid: patch.mailboxUid, version: row.version + 1 });
            return { ...row };
        });
        (route as any).repoUtils = { find, update, truncate: vi.fn(), instantiateObject: (obj: any) => obj };
        (route as any).aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        (route as any).messageRepo = { findOne: vi.fn().mockResolvedValue({ uid: "m1", folderUid: "f2", mailboxUid: "mb" }) };
        const superTruncate = vi.spyOn(Object.getPrototypeOf(BaseAttachmentRoute.prototype), "truncate").mockResolvedValue(undefined);

        await route.truncate({}, { folderUid: "f1" }, { uid: "user-1" } as any);

        expect(rows.map((row) => row.folderUid)).toEqual(["f2", "f2", "f2", "f2", "f2"]);
        expect(superTruncate).toHaveBeenCalledTimes(1);
    });
});
