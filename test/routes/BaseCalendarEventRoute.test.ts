///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseCalendarEventRoute's `update()`/`respond()` endpoints, reserved ONLY for the
// `!repoUtils`(/`!mailTransport` for respond()) defensive guards that a real wired server can never exercise
// (DI always populates every dependency before a request can reach the route). Every other behavior - the
// sequence auto-bump, accept/decline/tentative semantics, permission checks, 404s, and the iTIP REPLY email -
// is exercised via real HTTP+DB requests in test/routes/mongo/CalendarEventRoute.test.ts (and its sql/
// counterpart). See BaseMessageRoute.test.ts for the identical rationale/pattern this mirrors.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseCalendarEventRoute } from "../../src/routes/BaseCalendarEventRoute.js";

class TestCalendarEventRoute extends BaseCalendarEventRoute<any> {
    protected mailboxClass: any = class {};
    protected messageClass: any = class {};
}

describe("BaseCalendarEventRoute Tests (dependency guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("update() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestCalendarEventRoute>(TestCalendarEventRoute, { initialize: false });

        await expect(route.update("event-1", {} as any)).rejects.toThrow(/internal error/i);
    });

    it("respond() throws INTERNAL_ERROR when repoUtils/mailTransport are not set.", async () => {
        const route = objectFactory.newInstance<TestCalendarEventRoute>(TestCalendarEventRoute, { initialize: false });

        await expect(route.respond("event-1", { responseStatus: "accepted" }, { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });

    it("The invitation endpoints throw INTERNAL_ERROR when repoUtils/blobStore are not set.", async () => {
        const route = objectFactory.newInstance<TestCalendarEventRoute>(TestCalendarEventRoute, { initialize: false });
        const user: any = { uid: "user-1" };

        await expect(route.getInvite("message-1", user)).rejects.toThrow(/internal error/i);
        await expect(route.respondToInvite("message-1", { responseStatus: "accepted" }, user)).rejects.toThrow(/internal error/i);
        await expect(route.removeInvite("message-1", user)).rejects.toThrow(/internal error/i);
        await expect(route.proposeNewTime("message-1", {}, user)).rejects.toThrow(/internal error/i);
        await expect(route.acceptProposal("message-1", user)).rejects.toThrow(/internal error/i);
    });
});
