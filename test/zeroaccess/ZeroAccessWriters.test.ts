///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for the zero-access writers other than delivery: `ZeroAccessWriter` itself, and the branches of the import job,
// the message route and the scheduled send job that the HTTP suite (`test/routes/zeroAccessDeliverySuite.ts`) can't reach - failures of
// best-effort cleanup, a rolled-back import, `/content` refusing a sealed message, and a conversation row carrying its sealed summary.
import "reflect-metadata";
import { createHash, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { MailboxImportJobMongo } from "../../src/jobs/mongo/MailboxImportJobMongo.js";
import { ScheduledSendJobMongo } from "../../src/jobs/mongo/ScheduledSendJobMongo.js";
import { MessageRouteMongo } from "../../src/routes/mongo/MessageRouteMongo.js";
import { newZeroAccessWriter, ZeroAccessWriter } from "../../src/zeroaccess/ZeroAccessWriter.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

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
    return { publicKey: der.toString("base64"), type: "x509", useType: "zero-access" as const, fingerprint: createHash("sha256").update(der).digest("hex"), notBefore: 1, notAfter: 2 };
}

const objectFactory = new ObjectFactory(config, Logger());

function writer(fields: Record<string, unknown> = {}, repos: { policy?: any; index?: any } = {}): ZeroAccessWriter {
    const instance = new ZeroAccessWriter(repos.policy ?? { findOne: vi.fn().mockResolvedValue(undefined) }, repos.index, class {
        constructor(props: any) {
            Object.assign(this, props);
        }
    });
    Object.assign(instance, { aclUtils: { findACL: vi.fn().mockResolvedValue(undefined) }, ...fields });
    return instance;
}

describe("ZeroAccessWriter", () => {
    it("isn't built for a backend without both model classes", async () => {
        expect(await newZeroAccessWriter(objectFactory, undefined, class {})).toBeUndefined();
        expect(await newZeroAccessWriter(objectFactory, class {}, undefined)).toBeUndefined();
    });

    it("seals nothing for a mailbox without zero-access", async () => {
        const w = writer();
        expect(await w.sealRaw({ uid: "mbx", ownerUserUid: "u" }, Buffer.from("Subject: hi\r\n\r\nbody"), "m1", new Date())).toBeUndefined();
    });

    it("refuses to seal without a blob store or the index model, rather than file unindexed", async () => {
        const mailbox = { uid: "mbx", ownerUserUid: "u", zeroAccessKeys: [await zeroAccessKey()] };
        await expect(writer({ blobStore: undefined }, { index: {} }).sealRaw(mailbox, Buffer.from("x"), "m1", new Date())).rejects.toThrow(
            "needs a BlobStore and the ZeroAccessIndexEntry model",
        );
        await expect(writer({ blobStore: {} }).sealRaw(mailbox, Buffer.from("x"), "m1", new Date())).rejects.toThrow("needs a BlobStore");
    });

    it("seals an HTML-only message with no sender, indexing its text, and removes an index entry on request", async () => {
        const mailbox = { uid: "mbx", ownerUserUid: "u", zeroAccessKeys: [await zeroAccessKey()] };
        const blobs = new Map<string, Buffer>();
        const blobStore = { exists: async (k: string) => blobs.has(k), put: async (k: string, v: Buffer) => void blobs.set(k, v) };
        const created: any[] = [];
        const index = { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn(async (e: any) => created.push(e)), delete: vi.fn() };
        const w = writer({ blobStore, extractorRegistry: undefined }, { index });

        const sealed = await w.sealRaw(mailbox, Buffer.from("Content-Type: text/html\r\n\r\n<p>Only <b>HTML</b></p>"), "m1", new Date());

        expect(sealed).toMatchObject({ subject: "[...]", bodyPreview: "", bodyBlobKey: "za/mbx/m1" });
        expect(blobs.has("za/mbx/m1")).toBe(true);
        expect(created).toHaveLength(1);
        await w.removeIndexEntry(sealed!.indexEntryUid);
        expect(index.delete).toHaveBeenCalledWith(sealed!.indexEntryUid, expect.objectContaining({ purge: true }));
    });

    it("seals nothing through seal() either for a mailbox without zero-access", async () => {
        expect(await writer().seal({ uid: "mbx", ownerUserUid: "u" }, { messageUid: "m1", raw: Buffer.from("x") } as any)).toBeUndefined();
    });

    it("extracts an attachment's text into the index entry", async () => {
        const mailbox = { uid: "mbx", ownerUserUid: "u", zeroAccessKeys: [await zeroAccessKey()] };
        const blobStore = { exists: async () => false, put: vi.fn() };
        const index = { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn() };
        const extract = vi.fn().mockResolvedValue("minutes of the meeting");
        const w = writer({ blobStore, extractorRegistry: { extract } }, { index });
        const raw = [
            "From: Bob <bob@example.com>",
            "To: alice@example.com",
            "Subject: notes",
            'Content-Type: multipart/mixed; boundary="b"',
            "",
            "--b",
            "Content-Type: text/plain",
            "",
            "see attached",
            "--b",
            'Content-Type: application/pdf; name="notes.pdf"',
            'Content-Disposition: attachment; filename="notes.pdf"',
            "Content-Transfer-Encoding: base64",
            "",
            Buffer.from("%PDF-1.4 fake").toString("base64"),
            "--b--",
            "",
        ].join("\r\n");

        expect(await w.sealRaw(mailbox, Buffer.from(raw), "m1", new Date())).toBeDefined();

        expect(extract).toHaveBeenCalledWith("application/pdf", expect.any(Buffer));
        expect(index.create).toHaveBeenCalledTimes(1);
    });

    it("seals each draft save to a fresh blob and replaces the draft's index entry", async () => {
        const mailbox = { uid: "mbx", ownerUserUid: "u", zeroAccessKeys: [await zeroAccessKey()] };
        const blobs = new Map<string, Buffer>();
        const blobStore = { exists: async (k: string) => blobs.has(k), put: async (k: string, v: Buffer) => void blobs.set(k, v) };
        const entries = new Map<string, any>();
        const index = {
            findOne: vi.fn(async (uid: string) => entries.get(uid)),
            create: vi.fn(async (e: any) => void entries.set(e.uid, e)),
            delete: vi.fn(async (uid: string) => void entries.delete(uid)),
        };
        const w = writer({ blobStore }, { index });
        const raw = (body: string) => Buffer.from(`From: alice@example.com\r\nSubject: plan\r\n\r\n${body}`);

        const first = await w.sealDraft(mailbox, raw("first"), "d1", new Date());
        const firstEntry = [...entries.values()][0];
        const second = await w.sealDraft(mailbox, raw("second"), "d1", new Date());

        expect(first!.bodyBlobKey).toMatch(/^za\/mbx\/drafts\//);
        expect(second!.bodyBlobKey).toMatch(/^za\/mbx\/drafts\//);
        expect(second!.bodyBlobKey).not.toBe(first!.bodyBlobKey);
        expect(blobs.size).toBe(2);
        expect(index.delete).toHaveBeenCalledWith(second!.indexEntryUid, expect.objectContaining({ purge: true }));
        expect(entries.size).toBe(1);
        expect([...entries.values()][0].sealed).not.toBe(firstEntry.sealed);
    });

    it("discards plaintext blobs without an attachment repo too", async () => {
        const blobStore = { delete: vi.fn() };
        const w = writer({ blobStore });
        await w.discardPlaintext({}, "m1", ["composed/a", undefined, null]);
        expect(blobStore.delete).toHaveBeenCalledWith("composed/a");
    });
});

describe("MailboxImportJob (zero-access, isolated)", () => {
    function job(sealRaw: any, create: any) {
        const instance = objectFactory.newInstance<MailboxImportJobMongo>(MailboxImportJobMongo, { initialize: false }) as any;
        const deleted: string[] = [];
        Object.assign(instance, {
            logger: { warn: vi.fn() },
            blobStore: { put: vi.fn(), delete: vi.fn(async (k: string) => void deleted.push(k)) },
            messageRepo: { create, delete: vi.fn() },
            attachmentRepo: { create: vi.fn(), delete: vi.fn() },
            zeroAccessWriter: { sealRaw, removeIndexEntry: vi.fn() },
        });
        return { instance, deleted };
    }
    const result: any = { subject: "S", bodyPreview: "P", attachments: [{ content: Buffer.from("a"), contentType: "text/plain" }], sanitizedHtml: "<p>P</p>", references: [] };
    const mailbox: any = { uid: "mbx" };

    it("files an imported message sealed, with no plaintext body, sanitized copy or attachments", async () => {
        const create = vi.fn(async (m: any) => m);
        const sealRaw = vi.fn().mockResolvedValue({ subject: "[...]", bodyPreview: "", bodyBlobKey: "za/mbx/u1", zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" }, indexEntryUid: "ix" });
        const { instance } = job(sealRaw, create);

        expect(await instance.storeImportedMessage(Buffer.from("Date: x\r\n\r\nbody"), result, mailbox, { uid: "f1" })).toBe(true);

        expect(create.mock.calls[0][0]).toMatchObject({ subject: "[...]", bodyPreview: "", bodyBlobKey: "za/mbx/u1", zeroAccess: { keyFingerprint: "fp" } });
        expect(instance.blobStore.put).not.toHaveBeenCalled();
        expect(instance.attachmentRepo.create).not.toHaveBeenCalled();
    });

    it("removes the sealed blob and the index entry when filing the sealed message fails", async () => {
        const sealRaw = vi.fn(async (_m: any, _raw: any, uid: string) => ({ subject: "[...]", bodyPreview: "", bodyBlobKey: `za/mbx/${uid}`, zeroAccess: {}, indexEntryUid: "ix" }));
        const { instance, deleted } = job(sealRaw, vi.fn().mockRejectedValue(new Error("db down")));

        await expect(instance.storeImportedMessage(Buffer.from("x"), result, mailbox, { uid: "f1" })).rejects.toThrow("db down");

        expect(deleted.some((k) => k.startsWith("za/mbx/"))).toBe(true);
        expect(instance.zeroAccessWriter.removeIndexEntry).toHaveBeenCalledWith("ix");
    });
});

describe("Sent Items sealing (isolated)", () => {
    it("the message route logs, and doesn't fail the send, when the sealed copy's plaintext can't be removed", async () => {
        const route = objectFactory.newInstance<MessageRouteMongo>(MessageRouteMongo, { initialize: false }) as any;
        const logger = { warn: vi.fn() };
        Object.assign(route, { logger, zeroAccessWriter: { discardPlaintext: vi.fn().mockRejectedValue(new Error("blob store down")) } });

        await route.discardSentPlaintext({ uid: "m1", bodyBlobKey: "composed/a" }, undefined);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("blob store down"));
    });

    it("the scheduled send job logs, and doesn't fail the send, when the sealed copy's plaintext can't be removed", async () => {
        const instance = objectFactory.newInstance<ScheduledSendJobMongo>(ScheduledSendJobMongo, { initialize: false }) as any;
        const logger = { warn: vi.fn() };
        Object.assign(instance, { logger, zeroAccessWriter: { discardPlaintext: vi.fn().mockRejectedValue(new Error("blob store down")) } });

        await instance.discardSentPlaintext({ uid: "m1", bodyBlobKey: "composed/a" }, undefined);

        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("blob store down"));
    });

    it("the scheduled send job seals nothing without a zero-access writer", async () => {
        const instance = objectFactory.newInstance<ScheduledSendJobMongo>(ScheduledSendJobMongo, { initialize: false }) as any;
        expect(await instance.sealSentCopy({ mailboxUid: "mbx" }, Buffer.from("x"))).toBeUndefined();
    });
});

describe("Message route readers (zero-access, isolated)", () => {
    function route() {
        const instance = objectFactory.newInstance<MessageRouteMongo>(MessageRouteMongo, { initialize: false }) as any;
        Object.assign(instance, { blobStore: {}, hasMailAccess: vi.fn().mockResolvedValue(true) });
        return instance;
    }

    it("refuses /content for a sealed message with a 409, since there is no readable body to serve", async () => {
        const instance = route();
        instance.repoUtils = { findOne: vi.fn().mockResolvedValue({ uid: "m1", folderUid: "f1", zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" } }) };

        await expect(instance.content("m1", {} as any, { uid: "u" } as any)).rejects.toMatchObject({ status: 409 });
    });

    it("refuses a report's rawMessage that isn't base64 text", async () => {
        const instance = route();
        instance.repoUtils = { findOne: vi.fn() };
        for (const rawMessage of [5, "not base64!"]) {
            await expect(instance.report("m1", { kind: "junk", rawMessage }, {} as any, { uid: "u" } as any)).rejects.toMatchObject({ status: 400 });
        }
        expect(instance.repoUtils.findOne).not.toHaveBeenCalled();
    });

    it("accepts a report's decrypted copy only for a zero-access message, and only when it is that message", () => {
        const instance = route();
        const raw = Buffer.from("Message-ID: <Abc@Example.com>\r\nSubject: hi\r\n\r\nbody");
        const sealed = { uid: "m1", messageId: "abc@example.com", zeroAccess: { keyFingerprint: "fp" } };

        expect(instance.reportedZeroAccessSource(sealed, raw.toString("base64"))).toEqual(raw);
        expect(instance.reportedZeroAccessSource({ ...sealed, messageId: undefined }, raw.toString("base64"))).toEqual(raw);
        expect(() => instance.reportedZeroAccessSource({ ...sealed, messageId: "other@example.com" }, raw.toString("base64"))).toThrow(
            expect.objectContaining({ status: 400 }),
        );
        expect(() => instance.reportedZeroAccessSource({ uid: "m1", messageId: "abc@example.com" }, raw.toString("base64"))).toThrow(
            expect.objectContaining({ status: 400 }),
        );
    });

    it("teaches the spam filter a zero-access message only from the client's copy, never handing the source on", async () => {
        const instance = route();
        const learn = vi.fn().mockResolvedValue(undefined);
        Object.assign(instance, { spamScanProvider: { learn }, spamLearnEnabled: true, logger: { warn: vi.fn() } });
        const sealed = { uid: "m1", zeroAccess: { keyFingerprint: "fp" } };
        const mailbox = { primarySmtpAddress: "alice@example.com" };

        expect(await instance.teachSpamFilter(sealed, "junk", mailbox, true)).toEqual({ learned: false, learnSkipped: "zero_access" });

        const copy = Buffer.from("Subject: hi\r\n\r\nbody");
        expect(await instance.teachSpamFilter(sealed, "not_junk", mailbox, true, copy)).toEqual({ learned: true });
        expect(learn).toHaveBeenCalledWith(copy, "ham", { recipient: "alice@example.com" });

        expect(await instance.teachSpamFilter(sealed, "junk", mailbox, false, Buffer.alloc(5 * 1024 * 1024 + 1))).toEqual({
            learned: false,
            learnSkipped: "too_large",
        });

        learn.mockRejectedValueOnce(new Error("rspamd down"));
        expect(await instance.teachSpamFilter(sealed, "junk", mailbox, false, copy)).toEqual({ learned: false, learnSkipped: "failed" });

        instance.spamLearnEnabled = false;
        expect(await instance.teachSpamFilter(sealed, "junk", mailbox, false, copy)).toEqual({ learned: false, learnSkipped: "disabled" });
    });

    it("gives a conversation row its latest message's sealed summary", async () => {
        const instance = route();
        const sealed = { keyFingerprint: "fp", sealedSummary: "s" };
        const message = (uid: string, receivedDate: string, zeroAccess?: any) => ({
            uid,
            conversationId: "c1",
            subject: "[...]",
            bodyPreview: "",
            folderUid: "f1",
            receivedDate: new Date(receivedDate),
            from: { address: "a@example.com" },
            recipients: [],
            flags: { read: true },
            hasAttachments: false,
            ...(zeroAccess ? { zeroAccess } : {}),
        });
        instance.requireConversationScope = vi.fn().mockResolvedValue("mbx");
        instance.repoUtils = { find: vi.fn().mockResolvedValue([message("m2", "2026-02-01", sealed), message("m1", "2026-01-01")]) };

        const [summary] = await instance.conversations({}, { uid: "u" });

        expect(summary.latestZeroAccess).toEqual(sealed);
    });
});
