///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ZeroAccessFiling, zeroAccessBlobKey, zeroAccessIndexEntryUid } from "../../src/zeroaccess/ZeroAccessFiling.js";

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

    it("skips an index entry an earlier attempt wrote", async () => {
        const repo: any = { findOne: vi.fn().mockResolvedValue({ uid: "existing" }), create: vi.fn() };
        const filing = new ZeroAccessFiling(target, {} as any, "mbx");

        await filing.index(repo, class {} as any, "m1", new Date(), {} as any);

        expect(repo.findOne).toHaveBeenCalledWith(zeroAccessIndexEntryUid("m1"), { ignoreACL: true });
        expect(repo.create).not.toHaveBeenCalled();
    });
});
