///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for recordAuditLog() - objectFactory/repo/logger are hand-built mocks so this can
// assert exactly what gets persisted and how the repo-construction cache behaves, without a real DB.
//
// `recordAuditLog()` caches one repo per `auditLogClass` *object identity* in a module-level WeakMap (see
// its own doc comment) - shared across every call in this process, not reset between tests. Each test
// below therefore declares its own fresh, locally-scoped stub class rather than a single shared one, so
// no test's cache entry can leak into (and mask a missing `newInstance()` call in) another.
import { isNonOwnerAccess, recordAuditLog } from "../../src/util/AuditLogUtils.js";
import { AuditAction } from "../../src/models/types.js";

function makeStubClass(): any {
    return class StubAuditLogEntry {
        [key: string]: any;
        constructor(props: any) {
            Object.assign(this, props);
        }
    };
}

function makeRequest(remoteAddress = "203.0.113.5"): any {
    return { headers: {}, socket: { remoteAddress } };
}

describe("recordAuditLog() Tests", () => {
    let repo: { create: ReturnType<typeof vi.fn> };
    let objectFactory: { newInstance: ReturnType<typeof vi.fn> };
    let logger: { warn: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        repo = { create: vi.fn().mockResolvedValue(undefined) };
        objectFactory = { newInstance: vi.fn().mockResolvedValue(repo) };
        logger = { warn: vi.fn() };
    });

    it("Persists a matching AuditLogEntry row, including the caller's IP via NetUtils.", async () => {
        await recordAuditLog(
            objectFactory as any,
            makeStubClass(),
            { config: { get: () => undefined }, req: makeRequest(), user: { uid: "user-1" } as any, logger },
            {
                action: AuditAction.MAILBOX_CREATE,
                targetType: "Mailbox",
                targetUid: "mbx-1",
                mailboxUid: "mbx-1",
                details: { primarySmtpAddress: "a@example.com" },
            },
        );

        expect(repo.create).toHaveBeenCalledTimes(1);
        const [entry, options] = repo.create.mock.calls[0];
        expect(entry.action).toBe(AuditAction.MAILBOX_CREATE);
        expect(entry.targetType).toBe("Mailbox");
        expect(entry.targetUid).toBe("mbx-1");
        expect(entry.mailboxUid).toBe("mbx-1");
        expect(entry.actorUserUid).toBe("user-1");
        expect(entry.ip).toBe("203.0.113.5");
        expect(entry.details).toEqual({ primarySmtpAddress: "a@example.com" });
        expect(options).toEqual({ ignoreACL: true });
    });

    it("Resolves the client IP through CIDR trusted_proxies and X-Forwarded-For.", async () => {
        const req = { headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.1.0.4" }, socket: { remoteAddress: "::ffff:10.0.0.2" } };
        await recordAuditLog(
            objectFactory as any,
            makeStubClass(),
            { config: { get: (key: string) => (key === "trusted_proxies" ? ["10.0.0.0/8"] : undefined) }, req: req as any, logger },
            { action: AuditAction.MAILBOX_CREATE, targetType: "Mailbox", targetUid: "mbx-2" },
        );

        expect(repo.create.mock.calls[0][0].ip).toBe("198.51.100.7");
    });

    it("Leaves ip/actorUserUid undefined when no req/user is given.", async () => {
        await recordAuditLog(
            objectFactory as any,
            makeStubClass(),
            { config: { get: () => undefined }, logger },
            { action: AuditAction.TRANSPORT_RULE_DELETE, targetType: "TransportRule", targetUid: "rule-1" },
        );

        const entry = repo.create.mock.calls[0][0];
        expect(entry.ip).toBeUndefined();
        expect(entry.actorUserUid).toBeUndefined();
    });

    it("Swallows a repo-write failure, logging a warning instead of throwing.", async () => {
        repo.create.mockRejectedValueOnce(new Error("simulated database failure"));

        await expect(
            recordAuditLog(
                objectFactory as any,
                makeStubClass(),
                { config: { get: () => undefined }, logger },
                { action: AuditAction.MESSAGE_DELETE, targetType: "Message", targetUid: "msg-1" },
            ),
        ).resolves.toBeUndefined();

        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn.mock.calls[0][0]).toContain("message.delete");
    });

    it("Does not throw when EventUtils has never been initialized (this repo's own test environment).", async () => {
        // EventUtils.record() already swallows "not initialized" internally - this just proves
        // recordAuditLog() doesn't add its own unguarded call on top of that.
        await expect(
            recordAuditLog(
                objectFactory as any,
                makeStubClass(),
                { config: { get: () => undefined }, logger },
                { action: AuditAction.MESSAGE_RECALL, targetType: "Message", targetUid: "msg-1" },
            ),
        ).resolves.toBeUndefined();
    });

    it("Reuses the same cached repo across two calls with the same auditLogClass (only one newInstance call).", async () => {
        const auditLogClass = makeStubClass();

        await recordAuditLog(
            objectFactory as any,
            auditLogClass,
            { config: { get: () => undefined }, logger },
            { action: AuditAction.DISTRIBUTION_LIST_CREATE, targetType: "DistributionList", targetUid: "dl-1" },
        );
        await recordAuditLog(
            objectFactory as any,
            auditLogClass,
            { config: { get: () => undefined }, logger },
            { action: AuditAction.DISTRIBUTION_LIST_UPDATE, targetType: "DistributionList", targetUid: "dl-1" },
        );

        expect(objectFactory.newInstance).toHaveBeenCalledTimes(1);
        expect(repo.create).toHaveBeenCalledTimes(2);
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
