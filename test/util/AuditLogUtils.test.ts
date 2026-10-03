///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for `AuditLogUtils`: hand-built fake repository for every behaviour, plus a real ObjectFactory to prove the
// standard construction wiring, and the `isNonOwnerAccess()` helper.
import config from "../config.js";
import { Event, EventUtils, Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import { AuditLogUtils, isNonOwnerAccess } from "../../src/util/AuditLogUtils.js";
import { AuditAction } from "../../src/models/types.js";

function makeRequest(remoteAddress = "203.0.113.5", headers: Record<string, string> = {}): any {
    return { headers, socket: { remoteAddress } };
}

describe("AuditLogUtils Tests", () => {
    let repo: { create: ReturnType<typeof vi.fn> };
    let utils: AuditLogUtils;
    let logger: { warn: ReturnType<typeof vi.fn> };
    let recordSpy: any;

    beforeEach(() => {
        repo = { create: vi.fn().mockResolvedValue(undefined) };
        logger = { warn: vi.fn() };
        utils = new AuditLogUtils(repo as any);
        (utils as any).logger = logger;
        (utils as any).config = { get: () => undefined };
        (utils as any).trustedProxies = [];
        recordSpy = vi.spyOn(EventUtils, "record").mockResolvedValue(undefined as any);
    });

    afterEach(() => {
        recordSpy.mockRestore();
    });

    it("Persists the row, including the caller's IP and the actor, and records the same event data.", async () => {
        await utils.record(
            {
                action: AuditAction.MAILBOX_CREATE,
                targetType: "Mailbox",
                targetUid: "mbx-1",
                mailboxUid: "mbx-1",
                details: { primarySmtpAddress: "a@example.com" },
            },
            { req: makeRequest(), user: { uid: "user-1" } as any },
        );

        expect(repo.create).toHaveBeenCalledTimes(1);
        const [entry, options] = repo.create.mock.calls[0];
        expect(entry).toEqual({
            action: AuditAction.MAILBOX_CREATE,
            targetType: "Mailbox",
            targetUid: "mbx-1",
            mailboxUid: "mbx-1",
            details: { primarySmtpAddress: "a@example.com" },
            actorUserUid: "user-1",
            ip: "203.0.113.5",
        });
        expect(options).toEqual({ ignoreACL: true });

        expect(recordSpy).toHaveBeenCalledTimes(1);
        const event: any = recordSpy.mock.calls[0][0];
        expect(event).toBeInstanceOf(Event);
        expect(event.type).toBe(AuditAction.MAILBOX_CREATE);
        expect(event.targetUid).toBe("mbx-1");
        expect(event.ip).toBe("203.0.113.5");
        expect(event.userId).toBe("user-1");
    });

    it("Resolves the client IP through the configured trusted proxies and X-Forwarded-For.", async () => {
        (utils as any).trustedProxies = ["10.0.0.0/8"];
        const req = makeRequest("::ffff:10.0.0.2", { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.1.0.4" });

        await utils.record({ action: AuditAction.MAILBOX_CREATE, targetType: "Mailbox", targetUid: "mbx-2" }, { req });

        expect(repo.create.mock.calls[0][0].ip).toBe("198.51.100.7");
    });

    it("Leaves ip/actorUserUid undefined, and records an anonymous event, when no caller is given.", async () => {
        await utils.record({ action: AuditAction.TRANSPORT_RULE_DELETE, targetType: "TransportRule", targetUid: "rule-1" });

        const entry = repo.create.mock.calls[0][0];
        expect(entry.ip).toBeUndefined();
        expect(entry.actorUserUid).toBeUndefined();
        expect(recordSpy.mock.calls[0][0].userId).toBe("anonymous");
    });

    it("Swallows a repo-write failure, logging a warning, and still records the event.", async () => {
        repo.create.mockRejectedValueOnce(new Error("simulated database failure"));

        await expect(
            utils.record({ action: AuditAction.MESSAGE_DELETE, targetType: "Message", targetUid: "msg-1" }, {}),
        ).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toContain("message.delete");
        expect(recordSpy).toHaveBeenCalledTimes(1);
    });

    it("Does not throw without a logger when the write fails.", async () => {
        (utils as any).logger = undefined;
        repo.create.mockRejectedValueOnce(new Error("boom"));

        await expect(utils.record({ action: AuditAction.MESSAGE_RECALL, targetType: "Message", targetUid: "m" })).resolves.toBeUndefined();
    });

    describe("With a real ObjectFactory", () => {
        let objectFactory: ObjectFactory;
        let previousProxies: any;

        beforeEach(() => {
            previousProxies = config.get("trusted_proxies");
            config.set("trusted_proxies", ["10.0.0.0/8"]);
            objectFactory = new ObjectFactory(config, Logger());
        });

        afterEach(async () => {
            await objectFactory.destroy();
            config.set("trusted_proxies", previousProxies);
        });

        it("Injects the config, trusted_proxies and a logger, and returns the same instance for the same name.", async () => {
            const first: any = await objectFactory.newInstance(AuditLogUtils, { name: "AuditLogEntryMongo", args: [repo] });
            const second: any = await objectFactory.newInstance(AuditLogUtils, { name: "AuditLogEntryMongo", args: [repo] });

            expect(first).toBeInstanceOf(AuditLogUtils);
            expect(second).toBe(first);
            expect(first.auditLogRepo).toBe(repo);
            expect(first.config).toBe(config);
            expect(first.trustedProxies).toEqual(["10.0.0.0/8"]);
            expect(first.logger).toBeDefined();

            const other: any = await objectFactory.newInstance(AuditLogUtils, { name: "AuditLogEntrySQL", args: [repo] });
            expect(other).not.toBe(first);
        });

        it("Defaults trusted_proxies to an empty list when it is not configured.", async () => {
            config.set("trusted_proxies", undefined);
            const instance: any = await objectFactory.newInstance(AuditLogUtils, { name: "AuditLogEntryDefault", args: [repo] });

            expect(instance.trustedProxies).toEqual([]);
        });
    });
});

describe("isNonOwnerAccess() Tests", () => {
    it("Returns false for the mailbox's own owner.", () => {
        const mailbox: any = { ownerUserUid: "user-1" };

        expect(isNonOwnerAccess(mailbox, { uid: "user-1" } as any)).toBe(false);
    });

    it("Returns true for a different authenticated user.", () => {
        const mailbox: any = { ownerUserUid: "user-1" };

        expect(isNonOwnerAccess(mailbox, { uid: "user-2" } as any)).toBe(true);
    });

    it("Returns true when no user is given at all.", () => {
        const mailbox: any = { ownerUserUid: "user-1" };

        expect(isNonOwnerAccess(mailbox, undefined)).toBe(true);
    });
});
