///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseMessageRoute's send()/recall()/content()/conversations()/archive() endpoints,
// reserved ONLY for the `!repoUtils`/`!blobStore`(/`!mailTransport`/`!scanPipeline` for send(), `!repoUtils`/
// `!mailTransport` for recall(), `!repoUtils` for conversations()/archive()) defensive guards that a real
// wired server can never exercise (DI always populates every dependency before a request can reach the
// route). Every other behavior - a clean draft being relayed and moved to Sent Items, permission-denied
// (403), a nonexistent message (404), a message failing spam/malware scanning (422), the configured
// MailTransport rejecting a message (502), a second successful send reusing the already-resolved folderRepo
// cache, recall()'s Sent-Items/Message-ID checks and its actual relay, conversations()'s grouping/permission
// behavior, content()'s sanitized-HTML/plain-text-fallback/403/404 behavior, and archive()'s Drafts/Outbox
// block - is exercised via real HTTP+DB requests in test/routes/mongo/MessageRoute.test.ts (and its sql/
// counterpart).
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

        await expect(route.send("msg-1", undefined, req, {} as any, { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });

    it("send() refuses a background send with a 501 when the route has no ScheduledSendJob to hand it to, and a background flag that is not a boolean with a 400.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });

        await expect(route.send("msg-1", { background: true }, {} as any, {} as any, { uid: "user-1" } as any)).rejects.toMatchObject({ status: 501 });
        await expect(route.send("msg-1", { background: "yes" as any }, {} as any, {} as any, { uid: "user-1" } as any)).rejects.toMatchObject({ status: 400 });
    });

    it("recall() throws INTERNAL_ERROR when repoUtils/mailTransport are not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });

        await expect(route.recall("msg-1", { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });

    it("classify() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });

        await expect(
            route.classify("msg-1", { classifyAs: "other" }, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("setVerificationSeal() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });

        await expect(
            route.setVerificationSeal("msg-1", { seal: "abc", masterKeyGeneration: 0 }, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("conversations() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });

        await expect(route.conversations({ mailboxUid: "mbx-1" }, { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });

    it("conversationMessages() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });

        await expect(route.conversationMessages("thread-1", { mailboxUid: "mbx-1" }, { uid: "user-1" } as any)).rejects.toThrow(
            /internal error/i,
        );
    });

    it("content() throws INTERNAL_ERROR when repoUtils/blobStore are not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });
        const res: any = { setHeader: vi.fn().mockReturnThis(), send: vi.fn() };

        await expect(route.content("msg-1", res, { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });

    it("approveReceipt() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });

        await expect(
            route.approveReceipt("msg-1", { type: "delivery" }, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("declineReceipt() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });

        await expect(
            route.declineReceipt("msg-1", { type: "delivery" }, { uid: "user-1" } as any),
        ).rejects.toThrow(/internal error/i);
    });

    it("archive() throws INTERNAL_ERROR when repoUtils is not set.", async () => {
        const route = objectFactory.newInstance<TestMessageRoute>(TestMessageRoute, { initialize: false });

        await expect(route.archive("msg-1", { uid: "user-1" } as any)).rejects.toThrow(/internal error/i);
    });
});
