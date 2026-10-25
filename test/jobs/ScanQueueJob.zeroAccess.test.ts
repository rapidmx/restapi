///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for ScanQueueJob's zero-access guard branches, which the real HTTP+DB suite
// (test/routes/zeroAccessDeliverySuite.ts) can't reach: a vanished entry, an entry already delivered, a backend without the
// index model, a key the mailbox no longer has, and a zero-access entry reached without its raw message in memory.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ScanQueueJobMongo } from "../../src/jobs/mongo/ScanQueueJobMongo.js";
import { IngestStatus } from "../../src/models/types.js";

function makeJob(fields: Record<string, unknown> = {}): any {
    const job = new ObjectFactory(config, Logger()).newInstance<ScanQueueJobMongo>(ScanQueueJobMongo, { initialize: false }) as any;
    Object.assign(job, { logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }, ...fields });
    return job;
}

const ZA_ENTRY = { uid: "e1", mailboxUid: "mbx", rawBlobKey: "", zeroAccessKeyFingerprint: "fp", status: IngestStatus.PENDING };

describe("ScanQueueJob (zero-access, isolated)", () => {
    it("processInline() rejects an entry that doesn't exist", async () => {
        const job = makeJob({ ingestQueueRepo: { findOne: vi.fn().mockResolvedValue(undefined) } });
        await expect(job.processInline("missing", Buffer.from("x"))).rejects.toThrow("Ingest entry missing not found.");
    });

    it("processInline() leaves an entry already delivered alone", async () => {
        const update = vi.fn();
        const job = makeJob({ ingestQueueRepo: { findOne: vi.fn().mockResolvedValue({ ...ZA_ENTRY, status: IngestStatus.DELIVERED }), update } });
        await job.processInline("e1", Buffer.from("x"));
        expect(update).not.toHaveBeenCalled();
    });

    it("processInline() refuses an entry another request is still processing, and takes over one whose lease lapsed", async () => {
        const live = { ...ZA_ENTRY, status: IngestStatus.SCANNING, scanLeaseExpiresAt: new Date(Date.now() + 60_000) };
        const update = vi.fn().mockRejectedValue(new Error("version"));
        const findOne = vi.fn().mockResolvedValueOnce(live).mockResolvedValueOnce({ ...live, scanLeaseExpiresAt: new Date(Date.now() - 1000) });
        const job = makeJob({ ingestQueueRepo: { findOne, update } });
        await expect(job.processInline("e1", Buffer.from("x"))).rejects.toThrow("being processed by another request");
        expect(update).not.toHaveBeenCalled();
        await expect(job.processInline("e1", Buffer.from("x"))).rejects.toThrow("version");
        expect(update).toHaveBeenCalled();
    });

    it("processInline() hands an entry deferred for a pending erasure back without counting a failed attempt, and throws for the MTA", async () => {
        const job = makeJob({ ingestQueueRepo: { findOne: vi.fn().mockResolvedValue({ ...ZA_ENTRY, attempts: 0 }), update: vi.fn().mockResolvedValue(undefined) } });
        job.erasureDisposition = vi.fn().mockResolvedValue("defer");
        const recordFailure = vi.spyOn(job, "recordFailure");
        await expect(job.processInline("e1", Buffer.from("x"))).rejects.toThrow("an erasure of mailbox mbx is pending");
        expect(recordFailure).not.toHaveBeenCalled();
        expect(job.ingestQueueRepo.update.mock.calls[1][0]).toMatchObject({ status: IngestStatus.FAILED, attempts: 0 });
    });

    it("refuses to process a zero-access entry without its raw message in memory - there is no spool to read", async () => {
        const job = makeJob({ blobStore: { get: vi.fn() } });
        await expect(job.processEntry({ row: ZA_ENTRY, leaseGrantedAt: Date.now() })).rejects.toThrow("only processed inside its ingest request");
        expect(job.blobStore.get).not.toHaveBeenCalled();
    });

    it("refuses to file zero-access mail on a backend without the index model, rather than file it unindexed", async () => {
        const job = makeJob({ zeroAccessIndexEntryRepo: undefined });
        await expect(job.zeroAccessFilingFor(ZA_ENTRY)).rejects.toThrow("needs the ZeroAccessIndexEntry model");
    });

    it("refuses to file for a mailbox that no longer has the entry's key, or no longer exists", async () => {
        const job = makeJob({ zeroAccessIndexEntryRepo: {}, mailboxRepo: { findOne: vi.fn().mockResolvedValueOnce({ uid: "mbx", zeroAccessKeys: [] }).mockResolvedValueOnce(undefined) } });
        await expect(job.zeroAccessFilingFor(ZA_ENTRY)).rejects.toThrow("no longer has the zero-access key fp");
        await expect(job.zeroAccessFilingFor(ZA_ENTRY)).rejects.toThrow("no longer has the zero-access key fp");
    });

    it("files a plaintext entry without any zero-access filing", async () => {
        expect(await makeJob().zeroAccessFilingFor({ ...ZA_ENTRY, zeroAccessKeyFingerprint: undefined })).toBeUndefined();
    });
});
