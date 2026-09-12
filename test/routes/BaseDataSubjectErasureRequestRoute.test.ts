///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseDataSubjectErasureRequestRoute's create() TOCTOU mitigation, reserved for
// the same reason test/routes/BaseBrandingRoute.test.ts's own "findOrCreate() TOCTOU race" describe block
// gives: the pending-request pre-check and this row's own creation are not atomic (this codebase has no
// precedent for a partial-unique-index scoped to status = "pending" - see create()'s own doc comment),
// so exercising the real race deterministically through the HTTP+DB suite
// (test/routes/{mongo,sql}/DataSubjectErasureRequestRoute.test.ts) would require actually winning a
// timing race against a second concurrent request, which isn't reliable. A mocked repo lets both the
// "our own request loses the race" and "our own request wins the race" outcomes be exercised directly.
// Every other reachable behavior of this class is exercised via real HTTP+DB requests in that suite.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseDataSubjectErasureRequestRoute } from "../../src/routes/BaseDataSubjectErasureRequestRoute.js";

class TestDataSubjectErasureRequestRoute extends BaseDataSubjectErasureRequestRoute<any, any> {
    protected dataSubjectErasureRequestClass: any = class {
        constructor(props: any) {
            Object.assign(this, props);
        }
    };
    protected mailboxClass: any = class {};
    protected matterClass: any = class {};
    protected auditLogClass: any = class {};
}

describe("BaseDataSubjectErasureRequestRoute Tests (create() TOCTOU mitigation only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());
    const user: any = { uid: "user-1" };

    function makeRoute(): TestDataSubjectErasureRequestRoute {
        const route = objectFactory.newInstance<TestDataSubjectErasureRequestRoute>(TestDataSubjectErasureRequestRoute, {
            initialize: false,
        });
        (route as any).mailboxRepo = { find: vi.fn().mockResolvedValue([{ uid: "mailbox-1" }]) };
        (route as any).config = config;
        (route as any).logger = { warn: vi.fn(), error: vi.fn() };
        return route;
    }

    it("Supersedes (409, auto-denied) this call's own row when a concurrently-raced request for the same mailbox was created first.", async () => {
        const route = makeRoute();
        const ours: any = { uid: "req-ours", version: 0, requestedByUserUid: user.uid, dateCreated: new Date("2026-01-01T00:00:01Z") };
        const earlierWinner: any = {
            uid: "req-winner",
            version: 0,
            requestedByUserUid: user.uid,
            dateCreated: new Date("2026-01-01T00:00:00Z"),
        };
        const updateSpy = vi.fn().mockResolvedValue({ ...ours, status: "denied" });
        (route as any).requestRepo = {
            find: vi
                .fn()
                .mockResolvedValueOnce([]) // the initial "already pending?" pre-check sees nothing yet
                .mockResolvedValueOnce([ours, earlierWinner]), // the post-create re-check sees the race
            create: vi.fn().mockResolvedValue(ours),
            update: updateSpy,
        };

        await expect(route.create(user)).rejects.toThrow(/already pending review/i);

        // Our own row is the one superseded (denied), not the earlier winner.
        expect(updateSpy).toHaveBeenCalledWith(
            expect.objectContaining({ uid: "req-ours", status: "denied" }),
            ours,
            { ignoreACL: true },
        );
    });

    it("Returns normally when this call's own row is the earlier (winning) one, even if a second pending row also exists.", async () => {
        const route = makeRoute();
        const ours: any = { uid: "req-ours", version: 0, requestedByUserUid: user.uid, dateCreated: new Date("2026-01-01T00:00:00Z") };
        const laterLoser: any = {
            uid: "req-loser",
            version: 0,
            requestedByUserUid: user.uid,
            dateCreated: new Date("2026-01-01T00:00:01Z"),
        };
        const updateSpy = vi.fn();
        (route as any).requestRepo = {
            find: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([ours, laterLoser]),
            create: vi.fn().mockResolvedValue(ours),
            update: updateSpy,
        };

        const result = await route.create(user);

        expect(result).toBe(ours);
        expect(updateSpy).not.toHaveBeenCalled();
    });

    it("Returns normally (the ordinary, non-racing path) when only this call's own row exists after creation.", async () => {
        const route = makeRoute();
        const ours: any = { uid: "req-ours", version: 0, requestedByUserUid: user.uid, dateCreated: new Date() };
        (route as any).requestRepo = {
            find: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([ours]),
            create: vi.fn().mockResolvedValue(ours),
            update: vi.fn(),
        };

        const result = await route.create(user);

        expect(result).toBe(ours);
    });
});
