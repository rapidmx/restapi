///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { ZeroAccessFiling, zeroAccessBlobKey, zeroAccessIndexEntryUid } from "../../src/zeroaccess/ZeroAccessFiling.js";
import { testZeroAccessKey } from "../zeroAccessTestKeys.js";

// Everything that actually encrypts is covered against real keys by ZeroAccessSealer.test.ts and the delivery suite; these cover the
// "already done by an earlier attempt" paths, which reach no sealing at all.
const target: any = { key: { fingerprint: "fp" }, certDer: Buffer.alloc(0) };

describe("ZeroAccessFiling", () => {
    it("names blobs and index entries after the message", () => {
        expect(zeroAccessBlobKey("mbx", "m1")).toBe("za/mbx/m1");
        expect(zeroAccessIndexEntryUid("m1")).toBe(zeroAccessIndexEntryUid("m1"));
        expect(zeroAccessIndexEntryUid("m1")).not.toBe(zeroAccessIndexEntryUid("m2"));
    });

    it("reuses a sealed blob an earlier attempt stored, without sealing again", async () => {
        const blobStore: any = { exists: vi.fn().mockResolvedValue(true), put: vi.fn() };
        const filing = new ZeroAccessFiling(target, blobStore, "mbx");

        expect(await filing.storeMessage(Buffer.from("raw"), "m1")).toBe("za/mbx/m1");
        expect(await filing.storeMessage(Buffer.from("raw"), "m2")).toBe("za/mbx/m1");
        expect(blobStore.put).not.toHaveBeenCalled();
        expect(blobStore.exists).toHaveBeenCalledTimes(1);
        expect(filing.keyFingerprint).toBe("fp");
    });

    it("indexes a message dated in a year no week can be named for into the current week", async () => {
        const created: any[] = [];
        const repo: any = { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn(async (entry: any) => created.push(entry)) };
        const za = await testZeroAccessKey();
        const filing = new ZeroAccessFiling({ key: za.key, certDer: Buffer.from(za.key.publicKey, "base64") }, {} as any, "mbx");

        await filing.index(repo, class { constructor(fields: any) { Object.assign(this, fields); } } as any, "m1", new Date("0500-01-01T00:00:00Z"), {} as any);
        await filing.index(repo, class { constructor(fields: any) { Object.assign(this, fields); } } as any, "m2", new Date("2026-10-21T00:00:00Z"), {} as any);

        expect(created[0].weekId).toMatch(/^\d{4}-W\d{2}$/);
        expect(created[0].receivedAt.getUTCFullYear()).toBeGreaterThanOrEqual(2026);
        expect(created[1].weekId).toBe("2026-W43");
    });

    it("skips an index entry an earlier attempt wrote", async () => {
        const repo: any = { findOne: vi.fn().mockResolvedValue({ uid: "existing" }), create: vi.fn() };
        const filing = new ZeroAccessFiling(target, {} as any, "mbx");

        await filing.index(repo, class {} as any, "m1", new Date(), {} as any);

        expect(repo.findOne).toHaveBeenCalledWith(zeroAccessIndexEntryUid("m1"), { ignoreACL: true });
        expect(repo.create).not.toHaveBeenCalled();
    });
});
