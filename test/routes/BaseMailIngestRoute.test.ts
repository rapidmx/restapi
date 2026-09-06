///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseMailIngestRoute's deliver() endpoint, reserved ONLY for the
// `!this.blobStore` defensive guard that a real wired server can never exercise (DI always populates it
// before a request can reach the route). Every other reachable behavior - missing/wrong bearer secret,
// resolve() by primary/alias address, a missing rcpt, both envelope headers being entirely absent, an
// unresolvable recipient, and staging an IngestQueueEntry for a resolvable one - is exercised via real
// HTTP+DB requests in test/routes/mongo/MailIngestRoute.test.ts (and its sql/ counterpart).
//
// Two branches described in this class's doc comments are NOT exercised anywhere (deliberately, not an
// oversight): (1) the Authorization header, or the x-envelope-from/x-envelope-to headers, arriving as a
// string ARRAY rather than a single string. `HttpRequest.headers`'s type allows this in principle, but
// neither Node's http layer nor a real client (including this suite's `supertest`-based `request()`
// helper) ever actually produces an array for a header sent once - repeated headers are joined into a
// single comma-separated string on the wire, not delivered as an array - so this is not reachable via a
// real request short of hand-crafting a raw socket write, and (2) the "no ingest secret configured at
// all" fail-closed branch, which is baked into the route instance at server-construction time from
// static config and would require standing up an entirely separate Server+DB with that one config key
// removed - disproportionate for one branch. Both are left uncovered rather than covered by a
// convenience mock.
//
// The route instance itself is still scaffolded through a real `ObjectFactory` (`newInstance(...,
// { initialize: false })`), not a bare `new TestMailIngestRoute()` - this registers the class and tags
// the instance the same way production DI does, while `initialize: false` deliberately skips the
// `@Config`/`@Logger`/`@Inject` injection and `@Init` phase. `ingestSecret`/`mailboxRepo`/
// `ingestQueueRepo` are then set by hand to reach exactly the `!blobStore` branch under test, without
// tripping the (unrelated) internal-caller-authorization or mailbox-repo-lookup logic first.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseMailIngestRoute } from "../../src/routes/BaseMailIngestRoute.js";

class TestMailIngestRoute extends BaseMailIngestRoute<any, any> {
    protected mailboxClass: any = class {};
    protected ingestQueueClass: any = class {};
}

function makeRes(): any {
    return {
        status: vi.fn().mockReturnThis(),
        json: vi.fn().mockReturnThis(),
    };
}

describe("BaseMailIngestRoute Tests (blobStore guard clause only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("deliver() throws INTERNAL_ERROR when blobStore is not set.", async () => {
        const route = objectFactory.newInstance<TestMailIngestRoute>(TestMailIngestRoute, { initialize: false });
        (route as any).ingestSecret = "s3cr3t";
        (route as any).mailboxRepo = { find: vi.fn().mockResolvedValue([]) };
        (route as any).ingestQueueRepo = { create: vi.fn() };
        const res = makeRes();
        const req: any = {
            headers: {
                authorization: "Bearer s3cr3t",
                "x-envelope-from": "a@example.com",
                "x-envelope-to": "b@example.com",
            },
            rawBody: Buffer.from("From: a@example.com\r\n\r\nHi\r\n"),
            query: {},
        };

        await expect(route.deliver(req, res)).rejects.toThrow(/internal error/i);
    });
});
