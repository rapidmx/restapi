///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `BaseContactRoute` sealing a contact's readable photo with its first protected write: the failures the HTTP suites
// (`test/routes/{mongo,sql}/ContactRoute.test.ts`) can't reach.
import "reflect-metadata";
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { ContactRouteMongo } from "../../src/routes/mongo/ContactRouteMongo.js";
import { BaseScopedChildRoute } from "../../src/routes/BaseScopedChildRoute.js";
import { testZeroAccessKey } from "../zeroAccessTestKeys.js";

const existing = { uid: "c1", version: 0, mailboxUid: "mb", photoBlobKey: "contact-photos/c1/old" };

async function route(blobStore: any) {
    const za = await testZeroAccessKey();
    const instance = new ObjectFactory(config, Logger()).newInstance<ContactRouteMongo>(ContactRouteMongo, { initialize: false }) as any;
    Object.assign(instance, {
        logger: { warn: vi.fn() },
        blobStore,
        sealing: { certificateFor: vi.fn().mockResolvedValue(Buffer.from(za.key.publicKey, "base64")) },
    });
    instance.deletePhotoBlobs = vi.fn().mockResolvedValue(undefined);
    return instance;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("BaseContactRoute sealing a readable photo (isolated)", () => {
    it("leaves a photo it can't read or store now to the backfill, changing nothing in the write", async () => {
        const unreadable = await route({ get: vi.fn().mockRejectedValue(new Error("timeout")), put: vi.fn() });
        const obj: any = {};
        await unreadable.sealReadablePhoto(obj, existing);
        expect(obj).toEqual({});
        expect(unreadable.blobStore.put).not.toHaveBeenCalled();
        expect(unreadable.logger.warn).toHaveBeenCalledWith(expect.stringContaining("leaving it to the backfill: timeout"));

        const full = await route({ get: vi.fn().mockResolvedValue(Buffer.from("PHOTO")), put: vi.fn().mockRejectedValue(new Error("disk full")) });
        await full.sealReadablePhoto(obj, existing);
        expect(obj).toEqual({});

        // Nothing to do for a sealed photo, or a mailbox that doesn't protect contacts.
        await full.sealReadablePhoto(obj, { ...existing, photoSealed: true });
        full.sealing.certificateFor.mockResolvedValueOnce(undefined);
        await full.sealReadablePhoto(obj, existing);
        expect(full.blobStore.get).toHaveBeenCalledTimes(1);
    });

    it("removes the sealed photo it stored when the write fails, and the readable one once it is stored", async () => {
        const blobStore = { get: vi.fn().mockResolvedValue(Buffer.from("PHOTO")), put: vi.fn().mockResolvedValue(undefined) };
        const failing = await route(blobStore);
        vi.spyOn(BaseScopedChildRoute.prototype, "update").mockImplementation(async function (this: any, _id: string, obj: any) {
            await this.sealReadablePhoto(obj, existing);
            throw new Error("version");
        });
        const body: any = { uid: "c1", version: 0, favorite: true };
        await expect(failing.update("c1", body)).rejects.toThrow("version");
        expect(body.photoSealed).toBe(true);
        expect(failing.deletePhotoBlobs).toHaveBeenCalledWith([body.photoBlobKey]);
        expect(Object.keys(body)).not.toContain("resealedPhoto");

        const stored = await route(blobStore);
        vi.spyOn(BaseScopedChildRoute.prototype, "update").mockImplementation(async function (this: any, _id: string, obj: any) {
            await this.sealReadablePhoto(obj, existing);
            return { ...existing, ...obj };
        });
        await stored.update("c1", { uid: "c1", version: 0, favorite: true });
        expect(stored.deletePhotoBlobs).toHaveBeenCalledWith(["contact-photos/c1/old"]);
    });
});
