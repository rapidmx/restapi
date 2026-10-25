///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `ZeroAccessBackfillJob`'s paths the HTTP suite (`test/routes/zeroAccessDeliverySuite.ts`, "backfill of existing mail") can't reach.
import "reflect-metadata";
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
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
        blobStore: { get: vi.fn().mockResolvedValue(Buffer.from("raw")), delete: vi.fn().mockResolvedValue(undefined) },
        mailboxRepo: { find: vi.fn(async () => pages.shift() ?? []), update: vi.fn(async (patch: any) => patch) },
        folderRepo: { find: vi.fn().mockResolvedValue([{ uid: "drafts", type: "drafts" }]) },
        messageRepo: {
            find: vi.fn(async (query: any) => (query.deleted ? [] : (options.messages ?? []))),
            update: options.update ?? vi.fn(async (patch: any) => patch),
        },
        zeroAccessWriter: options.writer ?? {
            target: vi.fn().mockResolvedValue({}),
            sealRaw: vi.fn().mockResolvedValue(sealed),
            sealDraft: vi.fn().mockResolvedValue(sealed),
            discardPlaintext: vi.fn().mockResolvedValue(undefined),
        },
    });
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

    it("marks a message the writer can't seal, and tolerates the mark itself failing", async () => {
        const update = vi.fn().mockRejectedValue(new Error("conflict"));
        const { instance, logger } = job({
            messages: [message("m1")],
            update,
            writer: { target: vi.fn().mockResolvedValue({}), sealRaw: vi.fn().mockRejectedValue(new Error("bad mime")) },
        });
        await instance.run();
        expect(update.mock.calls[0][0].zeroAccessBackfillError).toContain("bad mime");
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("bad mime"));
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

    it("skips Outbox and end-to-end encrypted rows if the query returns them", async () => {
        const { instance } = job({ messages: [message("m1", { encrypted: true })] });
        instance.folderRepo.find.mockResolvedValue([{ uid: "outbox", type: "outbox" }]);
        instance.messageRepo.find = vi.fn(async (query: any) => (query.deleted ? [message("m2", { folderUid: "outbox" })] : [message("m1", { encrypted: true })]));
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
        });

        it("leaves a type that isn't protected alone, stops at the budget, and retries a record that changed meanwhile next run", async () => {
            const update = vi.fn().mockRejectedValue(new Error("version"));
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
                { update: vi.fn().mockRejectedValue(new Error("version")) },
            );
            stuck.instance.blobStore.delete.mockRejectedValue(new Error("store down"));
            await expect(stuck.instance.run()).resolves.toBeUndefined();
            expect(stuck.logger.debug).toHaveBeenCalledWith(expect.stringContaining("version"));
        });

        it("keeps a contact sealed, logging it, when its readable photo can't be removed", async () => {
            const { instance, logger } = await recordJob({ contacts: [{ uid: "c1", version: 0, mailboxUid: "mb", displayName: "Jane", emails: [], photoBlobKey: "contact-photos/c1/old" }] });
            instance.blobStore.delete.mockRejectedValue(new Error("store down"));
            await instance.run();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("store down"));
        });
    });
});
