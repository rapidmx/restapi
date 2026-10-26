///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `ZeroAccessBackfillJob`'s paths the HTTP suite (`test/routes/zeroAccessDeliverySuite.ts`, "backfill of existing mail") can't reach.
import "reflect-metadata";
import { ApiError, Logger } from "@rapidrest/core";
import { ApiErrors, ObjectFactory } from "@rapidrest/service-core";
import config from "../config.js";
import { ZeroAccessBackfillJobMongo } from "../../src/jobs/mongo/ZeroAccessBackfillJobMongo.js";
import { openSealedField, testZeroAccessKey, type TestZeroAccessKey } from "../zeroAccessTestKeys.js";

const objectFactory = new ObjectFactory(config, Logger());
const sealed = { subject: "[...]", bodyPreview: "", bodyBlobKey: "za/mb/m", zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" }, indexEntryUid: "ix" };
const message = (uid: string, fields: object = {}) => ({ uid, version: 0, folderUid: "inbox", mailboxUid: "mb", bodyBlobKey: `b/${uid}`, receivedDate: new Date(), ...fields });

function job(options: { mailboxes?: any[]; messages?: any[]; writer?: any; update?: any } = {}) {
    const instance = objectFactory.newInstance<ZeroAccessBackfillJobMongo>(ZeroAccessBackfillJobMongo, { initialize: false }) as any;
    const pages = [options.mailboxes ?? [{ uid: "mb", ownerUserUid: "u", zeroAccessKeys: [{}] }], []];
    const logger = { warn: vi.fn(), debug: vi.fn() };
    Object.assign(instance, {
        logger,
        blobStore: { get: vi.fn().mockResolvedValue(Buffer.from("raw")), delete: vi.fn().mockResolvedValue(undefined), exists: vi.fn().mockResolvedValue(false) },
        mailboxRepo: { find: vi.fn(async () => pages.shift() ?? []), update: vi.fn(async (patch: any) => patch) },
        folderRepo: { find: vi.fn().mockResolvedValue([{ uid: "drafts", type: "drafts" }]) },
        messageRepo: {
            find: vi.fn(async (query: any) => (query.deleted ? [] : (options.messages ?? []))),
            update: options.update ?? vi.fn(async (patch: any) => patch),
        },
        zeroAccessWriter: { allowed: vi.fn().mockResolvedValue(true), ...(options.writer ?? {}) },
    });
    if (!options.writer) {
        Object.assign(instance.zeroAccessWriter, {
            target: vi.fn().mockResolvedValue({}),
            sealRaw: vi.fn().mockResolvedValue(sealed),
            sealDraft: vi.fn().mockResolvedValue(sealed),
            discardPlaintext: vi.fn().mockResolvedValue(undefined),
            discardDraftPlaintext: vi.fn().mockResolvedValue(undefined),
        });
    }
    return { instance, logger };
}

describe("ZeroAccessBackfillJob (isolated)", () => {
    it("can't be initialized without an ObjectFactory, and runs no-op lifecycle hooks", async () => {
        const instance = new ZeroAccessBackfillJobMongo() as any;
        await expect(instance.init()).rejects.toThrow("objectFactory is not set.");
        await expect(instance.start()).resolves.toBeUndefined();
        expect(instance.stop()).toBeUndefined();
        expect(instance.schedule).toBe("0 * * * * *");
    });

    it("does nothing without a zero-access writer (the backend lacks the models)", async () => {
        const { instance } = job();
        instance.zeroAccessWriter = undefined;
        await instance.run();
        expect(instance.mailboxRepo.find).not.toHaveBeenCalled();
    });

    it("skips a mailbox without keys or without zero-access active, and stops at the run's budget", async () => {
        const target = vi.fn(async (mb: any) => (mb.uid === "off" ? undefined : {}));
        const sealRaw = vi.fn().mockResolvedValue(sealed);
        const { instance } = job({
            mailboxes: [{ uid: "nokeys" }, { uid: "off", zeroAccessKeys: [{}] }, { uid: "mb", zeroAccessKeys: [{}] }, { uid: "later", zeroAccessKeys: [{}] }],
            messages: Array.from({ length: 3 }, (_, i) => message(`m${i}`)),
            writer: { target, sealRaw, sealDraft: vi.fn(), discardPlaintext: vi.fn().mockResolvedValue(undefined) },
        });
        instance.batchSize = 2;

        await instance.run();

        expect(sealRaw).toHaveBeenCalledTimes(2);
        expect(target.mock.calls.map(([mb]) => mb.uid)).toEqual(["off", "mb"]);
    });

    it("decides the data types a protected mailbox hasn't yet from its devices, keeping mail protected, and leaves the rest alone", async () => {
        const phone = { activesync: { devices: [{ id: "d", types: ["mail", "contacts"], lastSeenAt: 1 }] } };
        const decided = { mail: true, calendar: false, contacts: false, tasks: false };
        const { instance } = job({
            mailboxes: [
                { uid: "old", version: 3, zeroAccessKeys: [{}], syncClients: phone },
                { uid: "off", zeroAccessKeys: [{}], zeroAccessEnabled: false },
                { uid: "decided", zeroAccessKeys: [{}], zeroAccessTypes: decided },
            ],
        });

        await instance.run();

        expect(instance.mailboxRepo.update).toHaveBeenCalledTimes(1);
        expect(instance.mailboxRepo.update.mock.calls[0][0]).toEqual({ uid: "old", version: 3, zeroAccessTypes: { mail: true, calendar: true, contacts: false, tasks: true } });
    });

    it("leaves the rest of a mailbox when zero-access stops being active mid-run", async () => {
        const sealRaw = vi.fn().mockResolvedValue(undefined);
        const { instance } = job({ messages: [message("m1"), message("m2")], writer: { target: vi.fn().mockResolvedValue({}), sealRaw } });
        await instance.run();
        expect(sealRaw).toHaveBeenCalledTimes(1);
        expect(instance.messageRepo.update).not.toHaveBeenCalled();
    });

    it("marks a message whose body is gone, and tolerates the mark itself failing", async () => {
        const update = vi.fn().mockRejectedValue(new Error("conflict"));
        const { instance, logger } = job({ messages: [message("m1")], update });
        instance.blobStore.get = vi.fn().mockRejectedValue(new Error("NoSuchKey"));
        await instance.run();
        expect(update.mock.calls[0][0].zeroAccessBackfillError).toContain("NoSuchKey");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("NoSuchKey"));
    });

    it("leaves a message whose sealing or body read failed for a while unmarked, for the next run", async () => {
        const update = vi.fn();
        const { instance, logger } = job({
            messages: [message("m1"), message("m2"), message("m3")],
            update,
            writer: { target: vi.fn().mockResolvedValue({}), sealRaw: vi.fn().mockRejectedValue(new Error("store 503")) },
        });
        instance.blobStore.get = vi.fn().mockResolvedValueOnce(Buffer.from("raw")).mockRejectedValueOnce(new Error("timeout")).mockRejectedValueOnce(new Error("timeout"));
        // The body is still there (a read that failed for a while), then a store that can't even say.
        instance.blobStore.exists = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("down"));
        await instance.run();
        expect(update).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("couldn't be sealed this run: store 503"));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("body couldn't be read this run"));
    });

    it("reads the administrator's setting once a run, does nothing while it is off, and reads a mailbox's folders only for mail to seal", async () => {
        const { instance } = job({ mailboxes: [{ uid: "a", zeroAccessKeys: [{}] }, { uid: "b", zeroAccessKeys: [{}] }], messages: [] });
        await instance.run();
        expect(instance.zeroAccessWriter.allowed).toHaveBeenCalledTimes(1);
        expect(instance.zeroAccessWriter.target.mock.calls.map((call: any[]) => call[2])).toEqual([true, true]);
        expect(instance.folderRepo.find).not.toHaveBeenCalled();

        const off = job();
        off.instance.zeroAccessWriter.allowed.mockResolvedValue(false);
        await off.instance.run();
        expect(off.instance.mailboxRepo.find).not.toHaveBeenCalled();
    });

    it("drops a draft's fresh sealed blob when the draft changed meanwhile, and leaves it for the next run", async () => {
        const { instance } = job({ messages: [message("d1", { folderUid: "drafts" })], update: vi.fn().mockRejectedValue(new Error("version")) });
        // Even when that blob won't delete: it is only wasted storage, never the message's.
        instance.blobStore.delete.mockRejectedValue(new Error("store down"));
        await instance.run();
        expect(instance.zeroAccessWriter.sealDraft).toHaveBeenCalled();
        expect(instance.blobStore.delete).toHaveBeenCalledWith(sealed.bodyBlobKey);
        expect(instance.zeroAccessWriter.discardPlaintext).not.toHaveBeenCalled();
    });

    describe("a draft's index entry", () => {
        /** A run over draft d1 sealed with a deferred index write, whose row reads back as `current` (or a rejection) after its update. */
        async function sealedDraft(current: any, update?: any) {
            const writeIndex = vi.fn().mockResolvedValue(undefined);
            const { instance, logger } = job({ messages: [message("d1", { folderUid: "drafts" })], update });
            instance.zeroAccessWriter.sealDraft = vi.fn().mockResolvedValue({ ...sealed, writeIndex });
            instance.zeroAccessWriter.removeIndexEntry = vi.fn().mockResolvedValue(undefined);
            instance.messageRepo.findOne = current instanceof Error ? vi.fn().mockRejectedValue(current) : vi.fn().mockResolvedValue(current);
            await instance.run();
            return { instance, logger, writeIndex };
        }

        it("is written only once the sealed row is stored, deferred from the seal, and replaces the draft's", async () => {
            const { instance, writeIndex } = await sealedDraft({ uid: "d1", bodyBlobKey: sealed.bodyBlobKey });
            expect(instance.zeroAccessWriter.sealDraft).toHaveBeenCalledWith(expect.anything(), expect.anything(), "d1", expect.any(Date), { deferIndex: true });
            expect(writeIndex).toHaveBeenCalledTimes(1);
            expect(instance.messageRepo.update.mock.invocationCallOrder[0]).toBeLessThan(writeIndex.mock.invocationCallOrder[0]);
        });

        it("is never touched by a seal that lost to a concurrent write - a compose save or another replica's seal - whose entry stands", async () => {
            const { instance, writeIndex } = await sealedDraft({ uid: "d1", bodyBlobKey: "za/mb/drafts/winner" }, vi.fn().mockRejectedValue(new Error("version")));
            expect(writeIndex).not.toHaveBeenCalled();
            expect(instance.zeroAccessWriter.removeIndexEntry).not.toHaveBeenCalled();
            expect(instance.blobStore.delete).toHaveBeenCalledWith(sealed.bodyBlobKey);
        });

        it("isn't written over a later save's entry, nor for a draft that is gone, and a failure is logged with the draft left sealed", async () => {
            for (const current of [{ uid: "d1", bodyBlobKey: "za/mb/drafts/later-save" }, undefined]) {
                const { writeIndex } = await sealedDraft(current);
                expect(writeIndex).not.toHaveBeenCalled();
            }
            const unread = await sealedDraft(new Error("database down"));
            expect(unread.writeIndex).not.toHaveBeenCalled();
            expect(unread.logger.warn).toHaveBeenCalledWith(expect.stringContaining("database down"));
            expect(unread.instance.zeroAccessWriter.discardDraftPlaintext).toHaveBeenCalled();
        });
    });

    it("keeps a sealed draft's attachment rows, discarding only its replaced body and extracted text, and a sent message's go", async () => {
        const { instance } = job({ messages: [message("d1", { folderUid: "drafts", sanitizedHtmlBlobKey: "sanitized/d1" }), message("m1")] });
        instance.messageRepo.findOne = vi.fn().mockResolvedValue(undefined);
        await instance.run();
        expect(instance.zeroAccessWriter.discardDraftPlaintext).toHaveBeenCalledTimes(1);
        expect(instance.zeroAccessWriter.discardDraftPlaintext).toHaveBeenCalledWith(instance.blobRepos, "d1", ["b/d1", "sanitized/d1"]);
        expect(instance.zeroAccessWriter.discardPlaintext).toHaveBeenCalledTimes(1);
        expect(instance.zeroAccessWriter.discardPlaintext).toHaveBeenCalledWith(instance.blobRepos, "m1", ["b/m1", undefined]);
    });

    it("leaves an Outbox message whose send can still go ahead, and seals one whose send failed for good or was relayed but never filed", async () => {
        const future = new Date(Date.now() + 60_000);
        const past = new Date(Date.now() - 60_000);
        const { instance } = job({
            messages: [
                message("due", { folderUid: "outbox", scheduledSendTime: past }),
                message("scheduled", { folderUid: "outbox", scheduledSendTime: future }),
                message("claimed", { folderUid: "outbox", scheduledSendTime: null, scheduledSendLeaseExpiresAt: future }),
                message("failed", { folderUid: "outbox", scheduledSendTime: null, scheduledSendError: "550 no such user" }),
                message("lapsed", { folderUid: "outbox", scheduledSendTime: null, scheduledSendLeaseExpiresAt: past }),
                message("unfiled", { folderUid: "outbox", scheduledSendTime: null, scheduledSendRelayedAt: past, sanitizedHtmlBlobKey: "sanitized/u" }),
            ],
        });
        instance.folderRepo.find.mockResolvedValue([{ uid: "outbox", type: "outbox" }]);
        instance.messageRepo.findOne = vi.fn().mockResolvedValue(undefined);
        await instance.run();
        // Never relayed: sealed as a draft, reopened and sent again like any sealed draft; its attachment rows are kept.
        expect(instance.zeroAccessWriter.sealDraft.mock.calls.map((call: any[]) => call[2])).toEqual(["failed", "lapsed"]);
        expect(instance.zeroAccessWriter.discardDraftPlaintext.mock.calls.map((call: any[]) => call[1])).toEqual(["failed", "lapsed"]);
        // Relayed: sealed as sent mail, its relay's render and attachments removed.
        expect(instance.zeroAccessWriter.sealRaw.mock.calls.map((call: any[]) => call[2])).toEqual(["unfiled"]);
        expect(instance.zeroAccessWriter.discardPlaintext).toHaveBeenCalledWith(instance.blobRepos, "unfiled", ["b/unfiled", "sanitized/u"]);
        expect(instance.messageRepo.update.mock.calls.map((call: any[]) => call[0].uid)).toEqual(["failed", "lapsed", "unfiled"]);
    });

    it("keeps a message sealed, and logs it, when its readable copies can't all be removed", async () => {
        const { instance, logger } = job({ messages: [message("m1", { receivedDate: undefined, sentDate: new Date("2026-01-01") })] });
        instance.zeroAccessWriter.discardPlaintext.mockRejectedValue(new Error("store down"));
        await instance.run();
        expect(instance.messageRepo.update).toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("store down"));
    });

    it("leaves a non-draft that changed meanwhile without deleting anything", async () => {
        const { instance } = job({ messages: [message("m1", { receivedDate: undefined })], update: vi.fn().mockRejectedValue(new Error("version")) });
        await instance.run();
        expect(instance.blobStore.delete).not.toHaveBeenCalled();
    });

    it("skips a pending Outbox send and end-to-end encrypted rows if the query returns them", async () => {
        const { instance } = job({ messages: [message("m1", { encrypted: true })] });
        instance.folderRepo.find.mockResolvedValue([{ uid: "outbox", type: "outbox" }]);
        instance.messageRepo.find = vi.fn(async (query: any) =>
            query.deleted ? [message("m2", { folderUid: "outbox", scheduledSendTime: new Date() })] : [message("m1", { encrypted: true })],
        );
        await instance.run();
        expect(instance.zeroAccessWriter.sealRaw).not.toHaveBeenCalled();
    });

    describe("calendar events, contacts and tasks", () => {
        /** A job whose mail is done, with `rows` per record type for the live query and `deleted` for the deleted one. */
        async function recordJob(rows: Record<string, any[]>, options: { protectedTypes?: string[]; deleted?: Record<string, any[]>; update?: any } = {}) {
            const za: TestZeroAccessKey = await testZeroAccessKey();
            const { instance, logger } = job({ messages: [] });
            const target = { key: za.key, certDer: Buffer.from(za.key.publicKey, "base64") };
            const protectedTypes = options.protectedTypes ?? ["calendar", "contacts", "tasks"];
            instance.recordSealer = { target: vi.fn(async (type: string) => (protectedTypes.includes(type) ? target : undefined)) };
            instance.blobStore.put = vi.fn().mockResolvedValue(undefined);
            instance.blobStore.get = vi.fn().mockResolvedValue(Buffer.from("PHOTO"));
            const repos: Record<string, any> = {};
            for (const type of ["calendar", "contacts", "tasks"]) {
                repos[type] = {
                    find: vi.fn(async (query: any) => (query.deleted ? (options.deleted?.[type] ?? []) : (rows[type] ?? []))),
                    update: options.update ?? vi.fn(async (patch: any) => patch),
                    // `deleteBlobsIfUnreferenced()`: nothing else names the old photo.
                    findOne: vi.fn().mockResolvedValue(undefined),
                    count: vi.fn().mockResolvedValue(0),
                };
            }
            instance.recordRepos = repos;
            return { instance, logger, za, repos };
        }

        it("seals each protected type's records not sealed yet - restorable ones too - and marks a record with nothing to seal", async () => {
            const { instance, za, repos } = await recordJob(
                {
                    calendar: [{ uid: "e1", version: 1, mailboxUid: "mb", title: "CANARY board", location: "Room 4", description: null }],
                    tasks: [{ uid: "t1", version: 2, mailboxUid: "mb", title: "", body: null }],
                },
                { deleted: { tasks: [{ uid: "t2", version: 0, mailboxUid: "mb", title: "CANARY deleted task" }] } },
            );

            await instance.run();

            const [event, , options] = repos.calendar.update.mock.calls[0];
            expect(event).toMatchObject({ uid: "e1", version: 1, title: "Protected event", location: null });
            expect(JSON.stringify(event)).not.toContain("CANARY");
            expect(await openSealedField(event.sealedFields.title, za)).toBe("CANARY board");
            expect(options).toMatchObject({ includeDeleted: true });
            expect(repos.calendar.find.mock.calls[0][0]).toMatchObject({ mailboxUid: "mb", sealedFields: null, sealedContent: null });
            expect(repos.tasks.update.mock.calls.map(([patch]: any[]) => [patch.uid, patch.sealedFields])).toEqual([
                ["t1", {}],
                ["t2", { title: expect.any(String) }],
            ]);
            expect(repos.contacts.update).not.toHaveBeenCalled();
        });

        it("keeps a sealed name when it seals the photo of a contact whose name column names an old first address", async () => {
            const { instance, repos } = await recordJob({
                contacts: [
                    {
                        uid: "c1",
                        version: 0,
                        mailboxUid: "mb",
                        displayName: "a@x",
                        emails: [{ address: "b@x", type: "other" }],
                        sealedFields: { displayName: "ALICE", emails: "EM" },
                        photoBlobKey: "contact-photos/c1/old",
                    },
                ],
            });

            await instance.run();

            const [patch] = repos.contacts.update.mock.calls[0];
            expect(patch).toMatchObject({ displayName: "b@x", photoSealed: true, sealedFields: { displayName: "ALICE", emails: "EM" } });
        });

        it("stores a contact's photo again sealed and removes the readable one, and leaves an outside photo key alone", async () => {
            const { instance, za, repos } = await recordJob({
                contacts: [
                    { uid: "c1", version: 0, mailboxUid: "mb", displayName: "Jane", emails: [{ address: "jane@example.com" }], photoBlobKey: "contact-photos/c1/old" },
                    { uid: "c2", version: 0, mailboxUid: "mb", displayName: "Joe", emails: [], photoBlobKey: "elsewhere/x" },
                ],
            });

            await instance.run();

            const [patch] = repos.contacts.update.mock.calls[0];
            expect(patch).toMatchObject({ displayName: "jane@example.com", photoSealed: true, photoBlobKey: expect.stringMatching(/^contact-photos\/c1\//) });
            expect(await openSealedField(patch.sealedFields.displayName, za)).toBe("Jane");
            const [key, bytes] = instance.blobStore.put.mock.calls[0];
            expect(key).toBe(patch.photoBlobKey);
            expect(bytes.toString()).not.toContain("PHOTO");
            expect(instance.blobStore.delete).toHaveBeenCalledWith("contact-photos/c1/old");
            expect(repos.contacts.update.mock.calls[1][0].photoBlobKey).toBeUndefined();
            // Contacts whose fields are sealed but whose photo isn't are selected too, each once.
            expect(repos.contacts.find.mock.calls.map(([query]: any[]) => query.photoBlobKey)).toContain("like(contact-photos/*)");
            expect(repos.contacts.update).toHaveBeenCalledTimes(2);
        });

        it("leaves a type that isn't protected alone, stops at the budget, and retries a record that changed meanwhile next run", async () => {
            const update = vi.fn().mockRejectedValue(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "version"));
            const { instance, logger, repos } = await recordJob(
                { contacts: [{ uid: "c1", version: 0, mailboxUid: "mb", displayName: "Jane", emails: [], photoBlobKey: "contact-photos/c1/old" }], tasks: [{ uid: "t1", title: "x" }] },
                { protectedTypes: ["contacts", "tasks"], update },
            );
            instance.batchSize = 1;

            await instance.run();

            expect(repos.calendar.find).not.toHaveBeenCalled();
            expect(repos.tasks.find).not.toHaveBeenCalled();
            // The sealed copy of the photo it couldn't attach goes; the readable one stays.
            expect(instance.blobStore.delete).toHaveBeenCalledWith(instance.blobStore.put.mock.calls[0][0]);
            expect(instance.blobStore.delete).not.toHaveBeenCalledWith("contact-photos/c1/old");
            expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("version"));
        });

        it("stops at the budget mail used up, and keeps going when the sealed photo it couldn't attach won't delete either", async () => {
            const spent = await recordJob({ tasks: [{ uid: "t1", title: "x" }] });
            spent.instance.messageRepo.find = vi.fn(async (query: any) => (query.deleted ? [] : [message("m1")]));
            spent.instance.batchSize = 1;
            await spent.instance.run();
            expect(spent.repos.calendar.find).not.toHaveBeenCalled();

            // The last type uses up the budget: the next mailbox isn't started.
            const last = await recordJob({ tasks: [{ uid: "t1", title: "x" }] });
            const pages = [[{ uid: "mb", zeroAccessKeys: [{}] }, { uid: "next", zeroAccessKeys: [{}] }], []];
            last.instance.mailboxRepo.find = vi.fn(async () => pages.shift() ?? []);
            last.instance.batchSize = 1;
            await last.instance.run();
            expect(last.instance.recordSealer.target.mock.calls.map(([, mb]: any[]) => mb.uid)).not.toContain("next");

            const stuck = await recordJob(
                { contacts: [{ uid: "c1", version: 0, mailboxUid: "mb", displayName: "Jane", emails: [], photoBlobKey: "contact-photos/c1/old" }] },
                { update: vi.fn().mockRejectedValue(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "version")) },
            );
            stuck.instance.blobStore.delete.mockRejectedValue(new Error("store down"));
            await expect(stuck.instance.run()).resolves.toBeUndefined();
            expect(stuck.logger.debug).toHaveBeenCalledWith(expect.stringContaining("version"));
        });

        it("seals a contact whose photo blob is gone without it, and leaves one whose photo can't be read or stored for now for the next run", async () => {
            const contact = (uid: string) => ({ uid, version: 0, mailboxUid: "mb", displayName: "Jane", emails: [], photoBlobKey: `contact-photos/${uid}/old` });
            const { instance, logger, repos } = await recordJob({ contacts: [contact("gone"), contact("slow"), contact("full")] });
            instance.blobStore.get = vi.fn().mockRejectedValueOnce(new Error("NoSuchKey")).mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(Buffer.from("PHOTO"));
            instance.blobStore.exists = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
            instance.blobStore.put = vi.fn().mockRejectedValue(new Error("disk full"));

            await instance.run();

            expect(repos.contacts.update).toHaveBeenCalledTimes(1);
            const [patch] = repos.contacts.update.mock.calls[0];
            expect(patch).toMatchObject({ uid: "gone", photoBlobKey: null, displayName: "Protected contact" });
            expect(patch.photoSealed).toBeUndefined();
            expect(patch.sealedFields.displayName).toEqual(expect.any(String));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("slow's photo couldn't be read this run"));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("full's sealed photo couldn't be stored this run"));
        });

        it("marks a record whose sealed write is refused for anything but a concurrent change, so it can't use up the budget, tolerating the mark failing", async () => {
            const update = vi.fn().mockRejectedValueOnce(new Error("validation failed")).mockResolvedValueOnce({});
            const { instance, logger, repos } = await recordJob({ tasks: [{ uid: "t1", version: 4, mailboxUid: "mb", title: "x" }] }, { update });

            await instance.run();

            expect(repos.tasks.find.mock.calls[0][0]).toMatchObject({ sealedFields: null, zeroAccessBackfillError: null });
            expect(update.mock.calls[1][0]).toEqual({ uid: "t1", version: 4, zeroAccessBackfillError: expect.stringContaining("validation failed") });
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("leaving tasks t1 unsealed"));

            const stuck = await recordJob({ tasks: [{ uid: "t2", version: 0, mailboxUid: "mb", title: "x" }] }, { update: vi.fn().mockRejectedValue(new Error("db down")) });
            await expect(stuck.instance.run()).resolves.toBeUndefined();

            const raced = await recordJob(
                { tasks: [{ uid: "t3", version: 0, mailboxUid: "mb", title: "x" }] },
                { update: vi.fn().mockRejectedValue(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "version")) },
            );
            await raced.instance.run();
            expect(raced.repos.tasks.update).toHaveBeenCalledTimes(1);
            expect(raced.logger.debug).toHaveBeenCalledWith(expect.stringContaining("changed while it was sealed"));
        });

        it("keeps a contact sealed, logging it, when its readable photo can't be removed", async () => {
            const { instance, logger } = await recordJob({ contacts: [{ uid: "c1", version: 0, mailboxUid: "mb", displayName: "Jane", emails: [], photoBlobKey: "contact-photos/c1/old" }] });
            instance.blobStore.delete.mockRejectedValue(new Error("store down"));
            await instance.run();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("store down"));
        });
    });
});
