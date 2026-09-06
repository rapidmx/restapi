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
import { ObjectFactory } from "@rapidrest/service-core";
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

    it("download() throws INTERNAL_ERROR when repoUtils/blobStore are not set.", async () => {
        const route = objectFactory.newInstance<TestAttachmentRoute>(TestAttachmentRoute, { initialize: false });
        const res = makeRes();

        await expect(route.download("id-1", res, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });
});
