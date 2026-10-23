///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `BaseZeroAccessIndexRoute`'s paths the HTTP suite (`test/routes/zeroAccessIndexSuite.ts`) can't reach: losing a compaction race at the
// write itself, a replaced file that won't delete, and a route built without an ObjectFactory.
import "reflect-metadata";
import { createHash, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { ApiErrors, ObjectFactory } from "@rapidrest/service-core";
import { ApiError, Logger } from "@rapidrest/core";
import config from "../config.js";
import { ZeroAccessIndexRouteMongo } from "../../src/routes/mongo/ZeroAccessIndexRouteMongo.js";
import { isoWeekId, sealToCertificate } from "../../src/zeroaccess/ZeroAccessSealer.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

const objectFactory = new ObjectFactory(config, Logger());
const closedWeek: string = isoWeekId(new Date(Date.now() - 21 * 86_400_000));

async function zeroAccessKey() {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=za",
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        keys: keys as CryptoKeyPair,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    const der = Buffer.from(cert.rawData);
    return { der, key: { publicKey: der.toString("base64"), type: "x509", useType: "zero-access", fingerprint: createHash("sha256").update(der).digest("hex"), notBefore: 1, notAfter: 2 } };
}

async function route(segmentRepo: any, mailbox: any) {
    const instance = objectFactory.newInstance<ZeroAccessIndexRouteMongo>(ZeroAccessIndexRouteMongo, { initialize: false }) as any;
    const blobStore = { put: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) };
    const logger = { warn: vi.fn() };
    Object.assign(instance, { mailboxRepo: { findOne: vi.fn().mockResolvedValue(mailbox) }, segmentRepo, blobStore, logger });
    return { instance, blobStore, logger };
}

const user = { uid: "owner" } as any;

describe("BaseZeroAccessIndexRoute (isolated)", () => {
    it("can't be initialized without an ObjectFactory", async () => {
        const instance = new ZeroAccessIndexRouteMongo() as any;
        await expect(instance.initialize()).rejects.toThrow("objectFactory is not set.");
    });

    it("answers 409 and drops its file when another device's compaction is written first", async () => {
        const za = await zeroAccessKey();
        const segmentRepo = { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockRejectedValue(new Error("duplicate key")) };
        const { instance, blobStore } = await route(segmentRepo, { uid: "mb", ownerUserUid: "owner", zeroAccessKeys: [za.key] });
        // Even when its own file won't delete either: the answer is still the conflict.
        blobStore.delete.mockRejectedValue(new Error("store down"));
        const segment = (await sealToCertificate(Buffer.from("db"), za.der)).toString("base64");

        await expect(
            instance.putSegment("mb", closedWeek, { expectedGeneration: 0, segment, keyFingerprint: za.key.fingerprint, schemaVersion: 1 }, user),
        ).rejects.toMatchObject({ status: 409 });
        expect(blobStore.delete).toHaveBeenCalledWith(blobStore.put.mock.calls[0][0]);
    });

    it("passes on an error of the write that isn't a conflict", async () => {
        const za = await zeroAccessKey();
        const failure = new ApiError(ApiErrors.INTERNAL_ERROR, 500, "db down");
        const segmentRepo = { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockRejectedValue(failure) };
        const { instance } = await route(segmentRepo, { uid: "mb", ownerUserUid: "owner", zeroAccessKeys: [za.key] });
        const segment = (await sealToCertificate(Buffer.from("db"), za.der)).toString("base64");

        await expect(
            instance.putSegment("mb", closedWeek, { expectedGeneration: 0, segment, keyFingerprint: za.key.fingerprint, schemaVersion: 1 }, user),
        ).rejects.toBe(failure);
    });

    it("keeps the new generation and logs it when the replaced file won't delete", async () => {
        const za = await zeroAccessKey();
        const current = { uid: "s", version: 0, generation: 1, blobKey: "old", entryCount: 3, weekId: closedWeek, origin: "zero-access" };
        const segmentRepo = { findOne: vi.fn().mockResolvedValue(current), update: vi.fn(async (patch: any) => ({ ...current, ...patch })) };
        const { instance, blobStore, logger } = await route(segmentRepo, { uid: "mb", ownerUserUid: "owner", zeroAccessKeys: [za.key] });
        blobStore.delete.mockRejectedValue(new Error("store down"));
        const segment = (await sealToCertificate(Buffer.from("db"), za.der)).toString("base64");

        const stored = await instance.putSegment("mb", closedWeek, { expectedGeneration: 1, segment, keyFingerprint: za.key.fingerprint, schemaVersion: 1 }, user);

        expect(stored).toMatchObject({ generation: 2, entryCount: 3 });
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("store down"));
    });

    it("refuses an upload for a mailbox without zero-access keys", async () => {
        const za = await zeroAccessKey();
        const { instance } = await route({ findOne: vi.fn() }, { uid: "mb", ownerUserUid: "owner" });
        const segment = (await sealToCertificate(Buffer.from("db"), za.der)).toString("base64");

        await expect(
            instance.putSegment("mb", closedWeek, { expectedGeneration: 0, segment, keyFingerprint: za.key.fingerprint, schemaVersion: 1 }, user),
        ).rejects.toMatchObject({ status: 400 });
    });
});
