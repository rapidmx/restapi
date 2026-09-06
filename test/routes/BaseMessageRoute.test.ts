///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseMessageRoute's send()/content() endpoints, reserved ONLY for the
// `!repoUtils`/`!blobStore`(/`!mailTransport`/`!scanPipeline` for send()) defensive guards that a real wired
// server can never exercise (DI always populates every dependency before a request can reach the route).
// Every other behavior - a clean draft being relayed and moved to Sent Items, permission-denied (403), a
// nonexistent message (404), a message failing spam/malware scanning (422), the configured
// MailTransport rejecting a message (502), a second successful send reusing the already-resolved
// folderRepo cache, and content()'s sanitized-HTML/plain-text-fallback/403/404 behavior - is exercised via
// real HTTP+DB requests in test/routes/mongo/MessageRoute.test.ts (and its sql/ counterpart).
//
// The route instance itself is still scaffolded through a real `ObjectFactory` (`newInstance(...,
// { initialize: false })`), not a bare `new TestMessageRoute()` - this registers the class and tags the
// instance the same way production DI does, while `initialize: false` deliberately skips the
// `@Config`/`@Logger`/`@Inject` injection and `@Init` phase, which is exactly what leaves all four
// dependencies genuinely `undefined` for this guard-clause test to observe.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseMessageRoute } from "../../src/routes/BaseMessageRoute.js";

class TestMessageRoute extends BaseMessageRoute<any> {
    protected folderClass: any = class {};
}

describe("BaseMessageRoute Tests (dependency guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("send() throws INTERNAL_ERROR when any required dependency (repoUtils/blobStore/mailTransport/scanPipeline) is not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });
        const req: any = {};

        await expect(route.send("msg-1", req, { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });

    it("content() throws INTERNAL_ERROR when repoUtils/blobStore are not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });
        const res: any = { setHeader: vi.fn().mockReturnThis(), send: vi.fn() };

        await expect(route.content("msg-1", res, { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });
});
