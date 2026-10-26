///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `SearchIndexJob` and zero-access (`specs/search.md` §3): what a mailbox whose mail is zero-access may have in the server-side search
// index - run against Mongo and SQL by `test/jobs/{mongo,sql}/SearchIndexJob*.test.ts`, with a real job, database and `NoopSearchProvider`.
import * as uuid from "uuid";
import type { NoopSearchProvider } from "../testDoubles.js";
import { RecipientType } from "../../src/models/types.js";

export interface SearchIndexZeroAccessSuiteContext {
    job: () => any;
    searchProvider: () => NoopSearchProvider;
    blobStore: () => any;
    createMessage: (data?: any) => Promise<any>;
    createAttachment: (data?: any) => Promise<any>;
    findMessage: (uid: string) => Promise<any>;
    updateMessage: (uid: string, fields: any) => Promise<void>;
    createMailbox: (data?: any) => Promise<any>;
    /** Saves the singleton `EncryptionPolicy` with `allowZeroAccess` (`undefined` leaves the row out). */
    setAllowZeroAccess: (allow: boolean | undefined) => Promise<void>;
}

const CANARY_SUBJECT = "CANARY merger codename";
const CANARY_BODY = "CANARY the acquisition closes on Friday";
const CANARY_ATTACHMENT = "CANARY board minutes";

const KEY = { publicKey: "AAAA", type: "x509", useType: "zero-access", fingerprint: "fp", notBefore: 0, notAfter: 4_102_444_800_000 };

export function searchIndexZeroAccessSuite(ctx: SearchIndexZeroAccessSuiteContext): void {
    describe("zero-access mailboxes", () => {
        afterEach(async () => {
            vi.restoreAllMocks();
            await ctx.setAllowZeroAccess(undefined);
        });

        /** A readable message of `mailbox` - a draft assembled for sending, say - with its body and one extracted attachment. */
        const readable = async (mailbox: any, fields: any = {}) => {
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await ctx.blobStore().put(bodyBlobKey, Buffer.from(`Subject: ${CANARY_SUBJECT}\r\n\r\n${CANARY_BODY}\r\n`));
            const message = await ctx.createMessage({
                mailboxUid: mailbox.uid,
                subject: CANARY_SUBJECT,
                from: { address: "me@example.com", type: RecipientType.TO },
                recipients: [{ address: "carol@example.org", type: RecipientType.TO }],
                bodyBlobKey,
                hasAttachments: true,
                ...fields,
            });
            const extractedTextBlobKey = `attachment-text/${uuid.v4()}`;
            await ctx.blobStore().put(extractedTextBlobKey, Buffer.from(CANARY_ATTACHMENT));
            await ctx.createAttachment({ messageUid: message.uid, mailboxUid: mailbox.uid, extractedTextBlobKey });
            return message;
        };
        const docOf = (uid: string) => ctx.searchProvider().indexed.get(`message:${uid}`);

        it("indexes a readable message of a zero-access mailbox as metadata only, under the placeholder subject", async () => {
            const mailbox = await ctx.createMailbox({ zeroAccessKeys: [KEY] });
            const message = await readable(mailbox);

            await ctx.job().run();

            const doc = docOf(message.uid);
            expect(doc).toMatchObject({ subject: "[...]", body: "", attachmentText: [], metadataOnly: true, participants: ["me@example.com", "carol@example.org"] });
            expect(JSON.stringify(doc)).not.toContain("CANARY");
            // Stamped, and stays stamped: its attachment text was never read, so the post-stamp re-check has nothing to clear it for.
            expect((await ctx.findMessage(message.uid)).searchIndexedAt).toBeTruthy();
        });

        it("keeps a sealed message with an extracted attachment stamped, rather than clearing its stamp on every pass", async () => {
            const mailbox = await ctx.createMailbox({ zeroAccessKeys: [KEY] });
            const message = await readable(mailbox, { subject: "[...]", zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" } });

            await ctx.job().run();

            const stamped = await ctx.findMessage(message.uid);
            expect(stamped.searchIndexedAt).toBeTruthy();
            expect(docOf(message.uid)).toMatchObject({ metadataOnly: true, attachmentText: [] });
        });

        it("indexes a readable message in full when the mailbox has no zero-access, the administrator disallows it, or the mailbox is gone", async () => {
            const plain = await ctx.createMailbox();
            const disabled = await ctx.createMailbox({ zeroAccessKeys: [KEY], zeroAccessEnabled: false });
            const fromPlain = await readable(plain);
            const fromDisabled = await readable(disabled);
            const orphan = await readable({ uid: uuid.v4() });

            await ctx.job().run();

            for (const message of [fromPlain, fromDisabled, orphan]) {
                expect(docOf(message.uid)).toMatchObject({ subject: CANARY_SUBJECT, attachmentText: [CANARY_ATTACHMENT], metadataOnly: false });
            }

            const protectedMailbox = await ctx.createMailbox({ zeroAccessKeys: [KEY] });
            const whileDisallowed = await readable(protectedMailbox);
            await ctx.setAllowZeroAccess(false);
            await ctx.job().run();
            expect(docOf(whileDisallowed.uid)).toMatchObject({ subject: CANARY_SUBJECT, metadataOnly: false });
        });

        it("leaves a readable message for a later run when its mailbox's zero-access state can't be read, indexing nothing", async () => {
            const mailbox = await ctx.createMailbox({ zeroAccessKeys: [KEY] });
            const message = await readable(mailbox);
            const job = ctx.job();
            vi.spyOn(job.mailboxRepo, "findOne").mockRejectedValueOnce(new Error("database down"));

            await job.run();

            expect(docOf(message.uid)).toBeUndefined();
            const failed = await ctx.findMessage(message.uid);
            expect(failed.searchIndexedAt ?? null).toBeNull();
            expect(failed.searchIndexAttempts).toBe(1);
            expect(failed.searchIndexError).toContain("zero-access");

            // The administrator's setting unreadable: the same.
            await ctx.updateMessage(message.uid, { searchIndexAttempts: null, searchIndexNextAttemptAt: null, searchIndexError: null });
            vi.spyOn(job.zeroAccessWriter, "allowed").mockRejectedValueOnce(new Error("policy down"));
            await job.run();
            expect(docOf(message.uid)).toBeUndefined();
            expect((await ctx.findMessage(message.uid)).searchIndexAttempts).toBe(1);

            // Readable again: indexed as metadata only.
            await ctx.updateMessage(message.uid, { searchIndexAttempts: null, searchIndexNextAttemptAt: null, searchIndexError: null });
            await job.run();
            expect(docOf(message.uid)).toMatchObject({ metadataOnly: true, subject: "[...]" });
        });

        describe("soft-deleted sealed mail", () => {
            /** A soft-deleted sealed message whose readable document - from before it was sealed - is still in the index. */
            const deletedSealed = async (fields: any = {}) => {
                const message = await ctx.createMessage({ subject: "[...]", zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" }, deleted: true, ...fields });
                await ctx.searchProvider().index({ entityType: "message", entityUid: message.uid, mailboxUid: message.mailboxUid, subject: CANARY_SUBJECT, body: CANARY_BODY } as any);
                return message;
            };

            it("replaces the readable document of a sealed message deleted before it was re-indexed, and leaves other deleted mail alone", async () => {
                const sealed = await deletedSealed();
                const plain = await ctx.createMailbox();
                const deletedReadable = await readable(plain, { deleted: true });

                await ctx.job().run();

                expect(docOf(sealed.uid)).toMatchObject({ subject: "[...]", body: "", metadataOnly: true });
                expect(JSON.stringify(docOf(sealed.uid))).not.toContain("CANARY");
                const stamped = await ctx.findMessage(sealed.uid);
                expect(stamped.searchIndexedAt).toBeTruthy();
                expect(stamped.deleted).toBe(true);
                // Deleted readable mail keeps today's behaviour: never selected.
                expect(docOf(deletedReadable.uid)).toBeUndefined();
                expect((await ctx.findMessage(deletedReadable.uid)).searchIndexedAt ?? null).toBeNull();
            });

            it("retries one whose metadata document can't be written, as it does live mail, until it is", async () => {
                const sealed = await deletedSealed();
                vi.spyOn(ctx.searchProvider(), "bulkIndex").mockRejectedValueOnce(new Error("cluster down"));

                await ctx.job().run();

                expect(docOf(sealed.uid)).toMatchObject({ body: CANARY_BODY });
                const failed = await ctx.findMessage(sealed.uid);
                expect(failed.searchIndexAttempts).toBe(1);
                expect(failed.searchIndexError).toContain("cluster down");

                await ctx.updateMessage(sealed.uid, { searchIndexNextAttemptAt: new Date(Date.now() - 1000) });
                await ctx.job().run();
                expect(docOf(sealed.uid)).toMatchObject({ body: "", metadataOnly: true });
                expect((await ctx.findMessage(sealed.uid)).searchIndexedAt).toBeTruthy();
            });

            it("takes them only in what is left of a batch after live mail", async () => {
                const job = ctx.job();
                const savedBatchSize: number = job.batchSize;
                job.batchSize = 1;
                try {
                    const live = await ctx.createMessage({ subject: "[...]", zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" } });
                    const sealed = await deletedSealed();

                    await job.run();
                    expect(docOf(live.uid)).toMatchObject({ metadataOnly: true });
                    expect(docOf(sealed.uid)).toMatchObject({ body: CANARY_BODY });

                    await job.run();
                    expect(docOf(sealed.uid)).toMatchObject({ body: "", metadataOnly: true });
                } finally {
                    job.batchSize = savedBatchSize;
                }
            });
        });

        describe("a sealed message whose metadata document can't be written", () => {
            let savedMaxAttempts: number;
            beforeEach(() => {
                savedMaxAttempts = ctx.job().maxAttempts;
            });
            afterEach(() => {
                ctx.job().maxAttempts = savedMaxAttempts;
            });

            /** A sealed message whose readable document is still in the index, one failed attempt short of its last. */
            const lastAttempt = async () => {
                const message = await ctx.createMessage({
                    subject: "[...]",
                    zeroAccess: { keyFingerprint: "fp", sealedSummary: "s" },
                    searchIndexAttempts: 1,
                    searchIndexNextAttemptAt: new Date(Date.now() - 1000),
                });
                await ctx.searchProvider().index({ entityType: "message", entityUid: message.uid, mailboxUid: message.mailboxUid, subject: CANARY_SUBJECT, body: CANARY_BODY } as any);
                ctx.job().maxAttempts = 2;
                return message;
            };

            it("removes its readable document when its retries run out", async () => {
                const message = await lastAttempt();
                vi.spyOn(ctx.searchProvider(), "bulkIndex").mockRejectedValueOnce(new Error("cluster down"));

                await ctx.job().run();

                expect(docOf(message.uid)).toBeUndefined();
                const exhausted = await ctx.findMessage(message.uid);
                expect(exhausted.searchIndexAttempts).toBe(2);
                expect(exhausted.searchIndexNextAttemptAt ?? null).toBeNull();
                expect(exhausted.searchIndexError).toContain("removed");
            });

            it("keeps retrying while that document can't be removed either, then writes the metadata document", async () => {
                const message = await lastAttempt();
                vi.spyOn(ctx.searchProvider(), "bulkIndex").mockRejectedValueOnce(new Error("cluster down"));
                vi.spyOn(ctx.searchProvider(), "remove").mockRejectedValueOnce(new Error("cluster down"));

                await ctx.job().run();

                expect(docOf(message.uid)).toMatchObject({ body: CANARY_BODY });
                const pending = await ctx.findMessage(message.uid);
                expect(pending.searchIndexAttempts).toBe(1);
                expect(new Date(pending.searchIndexNextAttemptAt).getTime()).toBeGreaterThan(Date.now());
                expect(pending.searchIndexError).toContain("retried");

                // Due again once the cluster is back: the metadata document replaces the readable one.
                await ctx.updateMessage(message.uid, { searchIndexNextAttemptAt: new Date(Date.now() - 1000) });
                await ctx.job().run();
                expect(docOf(message.uid)).toMatchObject({ body: "", metadataOnly: true });
                expect((await ctx.findMessage(message.uid)).searchIndexedAt).toBeTruthy();
            });
        });
    });
}
