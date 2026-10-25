///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for BaseMailIngestRoute's zero-access branches a real HTTP+DB test can't reach: a deployment with no
// ScanQueueJob class to process a zero-access entry with. Same DI-bypass pattern as BaseMailIngestRoute.DistributionLists.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseMailIngestRoute } from "../../src/routes/BaseMailIngestRoute.js";

class StubEntity {
    constructor(props: any) {
        Object.assign(this, props);
    }
}

class TestMailIngestRoute extends BaseMailIngestRoute<any, any> {
    protected mailboxClass: any = StubEntity;
    protected ingestQueueClass: any = StubEntity;
    protected distributionListClass: any = StubEntity;
    protected transportRuleClass: any = StubEntity;
}

describe("BaseMailIngestRoute (zero-access, isolated)", () => {
    it("answers 503, logging why, when a zero-access recipient can't be processed because no ScanQueueJob class is configured", async () => {
        const route = new ObjectFactory(config, Logger()).newInstance<TestMailIngestRoute>(TestMailIngestRoute, { initialize: false }) as any;
        const mailbox = { uid: "mbx", primarySmtpAddress: "alice@example.com", aliasAddresses: [] };
        const logger = { warn: vi.fn(), error: vi.fn() };
        Object.assign(route, {
            ingestSecret: "s3cr3t",
            logger,
            blobStore: { put: vi.fn() },
            mailboxRepo: { find: vi.fn(async (query: any) => (query?.primarySmtpAddress?.value === "alice@example.com" ? [mailbox] : [])) },
            distributionListRepo: { find: vi.fn().mockResolvedValue([]) },
            transportRuleRepo: { find: vi.fn().mockResolvedValue([]) },
            ingestQueueRepo: { create: vi.fn(async (entry: any) => entry), findOne: vi.fn().mockResolvedValue(undefined) },
            domainUtils: { getVerifiedDomainNames: vi.fn().mockResolvedValue([]), resolveDomainAlias: vi.fn().mockResolvedValue(undefined) },
            zeroAccessResolver: { target: vi.fn().mockResolvedValue({ key: { fingerprint: "fp" }, certDer: Buffer.alloc(0) }) },
        });
        const req = {
            headers: { authorization: "Bearer s3cr3t", "x-envelope-from": "bob@example.org", "x-envelope-to": "alice@example.com" },
            rawBody: Buffer.from("From: bob@example.org\r\n\r\nHi\r\n"),
            query: {},
        };
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };

        await expect(route.deliver(req, res)).rejects.toMatchObject({ status: 503 });
        expect(route.ingestQueueRepo.create.mock.calls[0][0]).toMatchObject({ rawBlobKey: "", zeroAccessKeyFingerprint: "fp" });
        expect(route.blobStore.put).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("no ScanQueueJob is configured"));
    });

    it("removes the sealed notice of an unknown recipient it couldn't file, so a retry makes it again, and still answers 202", async () => {
        const route = new ObjectFactory(config, Logger()).newInstance<TestMailIngestRoute>(TestMailIngestRoute, { initialize: false }) as any;
        const sender = { uid: "mbx", primarySmtpAddress: "alice@example.com", aliasAddresses: [] };
        const logger = { warn: vi.fn(), error: vi.fn() };
        Object.assign(route, {
            ingestSecret: "s3cr3t",
            logger,
            blobStore: { put: vi.fn() },
            mailboxRepo: { find: vi.fn(async (query: any) => (query?.primarySmtpAddress?.value === "alice@example.com" ? [sender] : [])) },
            distributionListRepo: { find: vi.fn().mockResolvedValue([]) },
            transportRuleRepo: { find: vi.fn().mockResolvedValue([]) },
            ingestQueueRepo: { create: vi.fn(async (entry: any) => entry), findOne: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
            domainUtils: { getVerifiedDomainNames: vi.fn().mockResolvedValue([]), resolveDomainAlias: vi.fn().mockResolvedValue(undefined) },
            zeroAccessResolver: { target: vi.fn().mockResolvedValue({ key: { fingerprint: "fp" }, certDer: Buffer.alloc(0) }) },
        });
        const req = {
            headers: { authorization: "Bearer s3cr3t", "x-envelope-from": "alice@example.com", "x-envelope-to": "nobody@example.com" },
            rawBody: Buffer.from("From: alice@example.com\r\nSubject: Q3 plan\r\n\r\nHi\r\n"),
            query: {},
        };
        const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };

        await route.deliver(req, res);

        expect(res.status).toHaveBeenCalledWith(202);
        const [entry] = route.ingestQueueRepo.create.mock.calls[0];
        expect(entry).toMatchObject({ mailboxUid: "mbx", rawBlobKey: "", zeroAccessKeyFingerprint: "fp" });
        expect(route.blobStore.put).not.toHaveBeenCalled();
        expect(route.ingestQueueRepo.delete).toHaveBeenCalledWith(entry.uid, { ignoreACL: true, purge: true });
    });
});
