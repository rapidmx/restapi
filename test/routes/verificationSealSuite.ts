///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `PUT /mail/messages/:id/verification-seal` and `Message.verificationSeal`/`verificationSealGeneration` staying
// server-managed everywhere else, identical on both backends. `test/routes/{mongo,sql}/MessageVerificationSeal.test.ts`
// supply a started server and raw row helpers.
import { request } from "@rapidrest/service-core/test";
import { ACLAction, RepoUtils } from "@rapidrest/service-core";
import * as uuid from "uuid";
import { MAX_VERIFICATION_SEAL_LENGTH } from "../../src/routes/BaseMessageRoute.js";
import { FolderType, MessageImportance, RecipientType } from "../../src/models/types.js";
import type { InMemoryBlobStore, RecordingMailTransport } from "../testDoubles.js";

export interface VerificationSealSuiteContext {
    app: () => any;
    baseUrl: string;
    tokenFor: (user: any) => string;
    /** Saves a mailbox (aliased `owner@example.com`) with an ACL giving `ownerUid` every action. */
    saveMailbox: (ownerUid: string) => Promise<any>;
    /** Saves a folder with an ACL under its mailbox carrying `records`. */
    saveFolder: (mailboxUid: string, type: FolderType, records?: { userOrRoleId: string; actions: string[] }[]) => Promise<any>;
    saveMessage: (fields: Record<string, any>) => Promise<any>;
    /** Saves the mailbox's key vault; `masterKeyGeneration` left out when `undefined`. */
    saveKeyVault: (mailboxUid: string, masterKeyGeneration?: number) => Promise<void>;
    /** Sets the stored vault's `masterKeyGeneration` directly (a rekey). */
    setVaultGeneration: (mailboxUid: string, masterKeyGeneration: number) => Promise<void>;
    findMessage: (uid: string) => Promise<any>;
    findMessages: (mailboxUid: string) => Promise<any[]>;
    /** Writes `fields` straight to the row, bumping its version like any real write. */
    rawUpdateMessage: (uid: string, fields: Record<string, any>) => Promise<void>;
    saveMatter: (fields: Record<string, any>) => Promise<any>;
    blobStore: () => InMemoryBlobStore;
    transport: () => RecordingMailTransport;
}

export function verificationSealSuite(ctx: VerificationSealSuiteContext): void {
    const owner: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const other: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const delegate: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const reader: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const updaterOnly: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };

    const SEAL = "v1.c2VhbC1vbmU_-:AbC+/==";
    const OTHER_SEAL = "v1.c2VhbC10d28";
    const THIRD_SEAL = "v2.dGhpcmQ";

    /** A mailbox, a folder with delegate records and a message in it; a key vault unless `vault` is `false`
     * (a number sets its `masterKeyGeneration`, `undefined` leaves it absent). */
    const setup = async (options: { type?: FolderType; fields?: Record<string, any>; vault?: number | false } = {}) => {
        const mailbox = await ctx.saveMailbox(owner.uid);
        if (options.vault !== false) {
            await ctx.saveKeyVault(mailbox.uid, options.vault);
        }
        const folder = await ctx.saveFolder(mailbox.uid, options.type ?? FolderType.INBOX, [
            { userOrRoleId: delegate.uid, actions: [ACLAction.READ, ACLAction.UPDATE] },
            { userOrRoleId: reader.uid, actions: [ACLAction.READ] },
            { userOrRoleId: updaterOnly.uid, actions: [ACLAction.UPDATE] },
        ]);
        const message = await ctx.saveMessage({
            mailboxUid: mailbox.uid,
            folderUid: folder.uid,
            messageId: `${uuid.v4()}@example.com`,
            subject: "Signed",
            from: { address: "owner@example.com", type: RecipientType.TO },
            recipients: [{ address: "recipient@example.com", type: RecipientType.TO }],
            sentDate: new Date(),
            receivedDate: new Date(),
            bodyBlobKey: `bodies/${uuid.v4()}`,
            bodyPreview: "Hello",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            importance: MessageImportance.NORMAL,
            references: [],
            hasAttachments: false,
            ...options.fields,
        });
        return { mailbox, folder, message };
    };
    const putRaw = (uid: string, body: any, user: any = owner) => {
        const req = request(ctx.app())
            .put(`${ctx.baseUrl}/${uid}/verification-seal`)
            .set("Authorization", "jwt " + ctx.tokenFor(user));
        return body === undefined ? req : req.send(body);
    };
    const putSeal = (uid: string, seal: string, masterKeyGeneration: number = 0, user: any = owner) =>
        putRaw(uid, { seal, masterKeyGeneration }, user);
    const stateOf = async (uid: string): Promise<{ seal?: string; generation?: number }> => {
        const row = await ctx.findMessage(uid);
        return { seal: row?.verificationSeal ?? undefined, generation: row?.verificationSealGeneration ?? undefined };
    };
    /** Makes the next `RepoUtils.update()` run `interleave()` first - a concurrent write between the route's read and write. */
    const interleaveNextUpdate = (interleave: () => Promise<void>): void => {
        const original = RepoUtils.prototype.update;
        vi.spyOn(RepoUtils.prototype, "update").mockImplementationOnce(async function (this: any, ...args: any[]) {
            await interleave();
            return await (original as any).apply(this, args);
        });
    };

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("PUT /:id/verification-seal", () => {
        it("stores the seal with the vault's generation and returns the updated message", async () => {
            const { message } = await setup();

            const res = await putSeal(message.uid, SEAL, 0);

            expect(res.status).toBe(200);
            expect(res.body.uid).toBe(message.uid);
            expect(res.body.verificationSeal).toBe(SEAL);
            expect(res.body.verificationSealGeneration).toBe(0);
            expect(res.body.subject).toBe("Signed");
            expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 0 });
        });

        it("binds the seal to a rekeyed vault's current generation", async () => {
            const { message } = await setup({ vault: 3 });

            const res = await putSeal(message.uid, SEAL, 3);

            expect(res.status).toBe(200);
            expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 3 });
        });

        it("accepts a seal of exactly the maximum length", async () => {
            const { message } = await setup();
            const seal = "A".repeat(MAX_VERIFICATION_SEAL_LENGTH);

            const res = await putSeal(message.uid, seal);

            expect(res.status).toBe(200);
            expect((await stateOf(message.uid)).seal).toBe(seal);
        });

        it("is idempotent for the identical seal at the same generation (200, no second write)", async () => {
            const { message } = await setup({ vault: 1 });
            expect((await putSeal(message.uid, SEAL, 1)).status).toBe(200);
            const versionAfterFirst = (await ctx.findMessage(message.uid)).version;

            const again = await putSeal(message.uid, SEAL, 1);

            expect(again.status).toBe(200);
            expect(again.body.verificationSeal).toBe(SEAL);
            expect((await ctx.findMessage(message.uid)).version).toBe(versionAfterFirst);
        });

        it("refuses a different seal at the same generation (409), keeping the stored seal", async () => {
            const { message } = await setup();
            expect((await putSeal(message.uid, SEAL)).status).toBe(200);

            const res = await putSeal(message.uid, OTHER_SEAL);

            expect(res.status).toBe(409);
            expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 0 });
        });

        it("replaces a seal from an older generation after a rekey, then holds the new one", async () => {
            const { mailbox, message } = await setup();
            expect((await putSeal(message.uid, SEAL, 0)).status).toBe(200);
            await ctx.setVaultGeneration(mailbox.uid, 1);

            const replaced = await putSeal(message.uid, OTHER_SEAL, 1);
            expect(replaced.status).toBe(200);
            expect(await stateOf(message.uid)).toEqual({ seal: OTHER_SEAL, generation: 1 });

            expect((await putSeal(message.uid, THIRD_SEAL, 1)).status).toBe(409);
            expect((await putSeal(message.uid, OTHER_SEAL, 1)).status).toBe(200);
            expect(await stateOf(message.uid)).toEqual({ seal: OTHER_SEAL, generation: 1 });
        });

        it("re-stamps the identical seal from an older generation with the current one", async () => {
            const { mailbox, message } = await setup();
            expect((await putSeal(message.uid, SEAL, 0)).status).toBe(200);
            await ctx.setVaultGeneration(mailbox.uid, 2);

            const res = await putSeal(message.uid, SEAL, 2);

            expect(res.status).toBe(200);
            expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 2 });
        });

        it("treats a stored seal without a generation as generation 0", async () => {
            const { mailbox, message } = await setup();
            await ctx.rawUpdateMessage(message.uid, { verificationSeal: SEAL });

            expect((await putSeal(message.uid, OTHER_SEAL, 0)).status).toBe(409);
            expect((await putSeal(message.uid, SEAL, 0)).status).toBe(200);
            await ctx.setVaultGeneration(mailbox.uid, 1);
            expect((await putSeal(message.uid, OTHER_SEAL, 1)).status).toBe(200);
            expect(await stateOf(message.uid)).toEqual({ seal: OTHER_SEAL, generation: 1 });
        });

        it("refuses a stale or future masterKeyGeneration (409) without writing", async () => {
            const { mailbox, message } = await setup({ vault: 2 });

            expect((await putSeal(message.uid, SEAL, 1)).status).toBe(409);
            expect((await putSeal(message.uid, SEAL, 3)).status).toBe(409);
            expect(await stateOf(message.uid)).toEqual({});

            expect((await putSeal(message.uid, SEAL, 2)).status).toBe(200);
            await ctx.setVaultGeneration(mailbox.uid, 3);
            // A client still on the old master key can't replace (or re-send) its seal.
            expect((await putSeal(message.uid, OTHER_SEAL, 2)).status).toBe(409);
            expect((await putSeal(message.uid, SEAL, 2)).status).toBe(409);
            expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 2 });
        });

        it("counts a vault without masterKeyGeneration as generation 0", async () => {
            const { message } = await setup({ vault: undefined });

            expect((await putSeal(message.uid, SEAL, 1)).status).toBe(409);
            expect((await putSeal(message.uid, SEAL, 0)).status).toBe(200);
            expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 0 });
        });

        it("refuses a seal from a generation newer than the vault's, identical or not (409)", async () => {
            const { message } = await setup({ vault: 0 });
            await ctx.rawUpdateMessage(message.uid, { verificationSeal: SEAL, verificationSealGeneration: 5 });

            expect((await putSeal(message.uid, OTHER_SEAL, 0)).status).toBe(409);
            expect((await putSeal(message.uid, SEAL, 0)).status).toBe(409);
            expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 5 });
        });

        it("refuses a mailbox with no key vault (409)", async () => {
            const { message } = await setup({ vault: false });

            const res = await putSeal(message.uid, SEAL, 0);

            expect(res.status).toBe(409);
            expect(await stateOf(message.uid)).toEqual({});
        });

        it("leaves exactly one winner when two different first seals race", async () => {
            const { message } = await setup();

            const results = await Promise.all([putSeal(message.uid, SEAL), putSeal(message.uid, OTHER_SEAL)]);

            expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
            const winner = results.find((res) => res.status === 200)!;
            expect((await stateOf(message.uid)).seal).toBe(winner.body.verificationSeal);
        });

        it("leaves exactly one winner when two different seals race to replace an older generation's", async () => {
            const { mailbox, message } = await setup();
            expect((await putSeal(message.uid, SEAL, 0)).status).toBe(200);
            await ctx.setVaultGeneration(mailbox.uid, 1);

            const results = await Promise.all([putSeal(message.uid, OTHER_SEAL, 1), putSeal(message.uid, THIRD_SEAL, 1)]);

            expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
            const winner = results.find((res) => res.status === 200)!;
            expect(await stateOf(message.uid)).toEqual({ seal: winner.body.verificationSeal, generation: 1 });
        });

        it("loses a version-checked first write to a concurrent different seal (409) without overwriting it", async () => {
            const { message } = await setup();
            interleaveNextUpdate(() => ctx.rawUpdateMessage(message.uid, { verificationSeal: OTHER_SEAL, verificationSealGeneration: 0 }));

            const res = await putSeal(message.uid, SEAL);

            expect(res.status).toBe(409);
            expect(await stateOf(message.uid)).toEqual({ seal: OTHER_SEAL, generation: 0 });
        });

        it("loses a version-checked replacement to a concurrent replacement at the current generation (409)", async () => {
            const { mailbox, message } = await setup();
            expect((await putSeal(message.uid, SEAL, 0)).status).toBe(200);
            await ctx.setVaultGeneration(mailbox.uid, 1);
            interleaveNextUpdate(() => ctx.rawUpdateMessage(message.uid, { verificationSeal: THIRD_SEAL, verificationSealGeneration: 1 }));

            const res = await putSeal(message.uid, OTHER_SEAL, 1);

            expect(res.status).toBe(409);
            expect(await stateOf(message.uid)).toEqual({ seal: THIRD_SEAL, generation: 1 });
        });

        it("succeeds when a concurrent write of the identical seal wins the race", async () => {
            const { message } = await setup();
            interleaveNextUpdate(() => ctx.rawUpdateMessage(message.uid, { verificationSeal: SEAL, verificationSealGeneration: 0 }));

            const res = await putSeal(message.uid, SEAL);

            expect(res.status).toBe(200);
            expect(res.body.verificationSeal).toBe(SEAL);
            expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 0 });
        });

        it("retries after losing the lock to an unrelated write, keeping that write", async () => {
            const { message } = await setup();
            interleaveNextUpdate(() =>
                ctx.rawUpdateMessage(message.uid, { flags: { read: true, flagged: true, answered: false, forwarded: false } }),
            );

            const res = await putSeal(message.uid, SEAL);

            expect(res.status).toBe(200);
            const stored = await ctx.findMessage(message.uid);
            expect(stored.verificationSeal).toBe(SEAL);
            expect(stored.flags.flagged).toBe(true);
        });

        it("rejects a bad seal or masterKeyGeneration (400)", async () => {
            const { message } = await setup();
            const bodies: any[] = [
                undefined,
                {},
                { seal: null, masterKeyGeneration: 0 },
                { seal: 42, masterKeyGeneration: 0 },
                { seal: ["abc"], masterKeyGeneration: 0 },
                { seal: { value: "abc" }, masterKeyGeneration: 0 },
                { seal: "", masterKeyGeneration: 0 },
                { seal: "A".repeat(MAX_VERIFICATION_SEAL_LENGTH + 1), masterKeyGeneration: 0 },
                { seal: "has space", masterKeyGeneration: 0 },
                { seal: "semi;colon", masterKeyGeneration: 0 },
                { seal: "new\nline", masterKeyGeneration: 0 },
                { seal: "émoji", masterKeyGeneration: 0 },
                { seal: SEAL },
                { seal: SEAL, masterKeyGeneration: null },
                { seal: SEAL, masterKeyGeneration: "0" },
                { seal: SEAL, masterKeyGeneration: -1 },
                { seal: SEAL, masterKeyGeneration: 1.5 },
                { seal: SEAL, masterKeyGeneration: 2 ** 53 },
                { seal: SEAL, masterKeyGeneration: [0] },
            ];
            for (const body of bodies) {
                const res = await putRaw(message.uid, body);
                expect(res.status, JSON.stringify(body)).toBe(400);
            }
            expect(await stateOf(message.uid)).toEqual({});
        });

        it("returns 404 for an unknown message", async () => {
            const res = await putSeal(uuid.v4(), SEAL);
            expect(res.status).toBe(404);
        });

        it("refuses a caller without READ and UPDATE on the folder (403) and allows a delegate with both", async () => {
            const { message } = await setup();

            for (const user of [other, reader, updaterOnly]) {
                expect((await putSeal(message.uid, SEAL, 0, user)).status).toBe(403);
            }
            expect(await stateOf(message.uid)).toEqual({});

            const res = await putSeal(message.uid, SEAL, 0, delegate);
            expect(res.status).toBe(200);
            expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 0 });
        });

        it("checks access before revealing whether the mailbox has a key vault", async () => {
            const { message } = await setup({ vault: false });

            expect((await putSeal(message.uid, SEAL, 0, other)).status).toBe(403);
        });

        it("isn't blocked by a legal hold on the mailbox", async () => {
            const { mailbox, message } = await setup();
            await ctx.saveMatter({
                name: "Hold",
                escrowScopeId: uuid.v4(),
                custodianMailboxUids: [mailbox.uid],
                dateRangeStart: new Date("2000-01-01"),
                dateRangeEnd: new Date("2100-01-01"),
            });

            const res = await putSeal(message.uid, SEAL);

            expect(res.status).toBe(200);
            expect((await stateOf(message.uid)).seal).toBe(SEAL);
        });
    });

    describe("server-managed everywhere else", () => {
        const draftBody = (folder: any, mailbox: any) => ({
            mailboxUid: mailbox.uid,
            folderUid: folder.uid,
            messageId: `${uuid.v4()}@example.com`,
            subject: "Draft",
            from: { address: "owner@example.com", type: "to" },
            recipients: [],
            bodyBlobKey: `bodies/${uuid.v4()}`,
            bodyPreview: "Draft preview",
            flags: { read: false, flagged: false, answered: false, forwarded: false },
            importance: "normal",
            references: [],
            hasAttachments: false,
            verificationSeal: SEAL,
            verificationSealGeneration: 0,
        });

        it("ignores the seal fields in a create body, for the owner and a trusted caller alike", async () => {
            const { mailbox, folder } = await setup({ type: FolderType.DRAFTS });

            for (const user of [owner, admin]) {
                const res = await request(ctx.app())
                    .post(ctx.baseUrl)
                    .set("Authorization", "jwt " + ctx.tokenFor(user))
                    .send(draftBody(folder, mailbox));
                expect(res.status).toBeGreaterThanOrEqual(200);
                expect(res.status).toBeLessThan(300);
                expect(res.body.verificationSeal ?? undefined).toBeUndefined();
                expect(await stateOf(res.body.uid)).toEqual({});
            }

            const bulk = await request(ctx.app())
                .post(ctx.baseUrl)
                .set("Authorization", "jwt " + ctx.tokenFor(owner))
                .send([draftBody(folder, mailbox), draftBody(folder, mailbox)]);
            expect(bulk.status).toBeGreaterThanOrEqual(200);
            expect(bulk.status).toBeLessThan(300);
            for (const created of bulk.body) {
                expect(await stateOf(created.uid)).toEqual({});
            }
        });

        it("ignores the seal fields in an update body, for the owner and a trusted caller, on an unsealed and a sealed message", async () => {
            const { message } = await setup();

            for (const user of [owner, admin]) {
                const current = await ctx.findMessage(message.uid);
                const res = await request(ctx.app())
                    .put(`${ctx.baseUrl}/${message.uid}`)
                    .set("Authorization", "jwt " + ctx.tokenFor(user))
                    .send({
                        uid: message.uid,
                        version: current.version,
                        subject: `Edited by ${user.uid}`,
                        verificationSeal: SEAL,
                        verificationSealGeneration: 0,
                    });
                expect(res.status).toBe(200);
                expect(res.body.subject).toBe(`Edited by ${user.uid}`);
                expect(await stateOf(message.uid)).toEqual({});
            }

            expect((await putSeal(message.uid, SEAL)).status).toBe(200);
            for (const user of [owner, admin]) {
                for (const fields of [{ verificationSeal: OTHER_SEAL }, { verificationSeal: null }, { verificationSeal: "" }, { verificationSealGeneration: 7 }]) {
                    const current = await ctx.findMessage(message.uid);
                    const res = await request(ctx.app())
                        .put(`${ctx.baseUrl}/${message.uid}`)
                        .set("Authorization", "jwt " + ctx.tokenFor(user))
                        .send({ uid: message.uid, version: current.version, ...fields });
                    expect(res.status).toBe(200);
                    expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 0 });
                }
            }
        });

        it("ignores the seal fields in a bulk update", async () => {
            const { message } = await setup();

            const res = await request(ctx.app())
                .put(ctx.baseUrl)
                .set("Authorization", "jwt " + ctx.tokenFor(owner))
                .send([{ uid: message.uid, version: message.version, verificationSeal: SEAL, verificationSealGeneration: 0 }]);

            expect(res.status).toBe(200);
            expect(await stateOf(message.uid)).toEqual({});
        });

        it("ignores PUT /:id/verificationSeal and /:id/verificationSealGeneration (the generic property route)", async () => {
            const { message } = await setup();

            const unsealed = await request(ctx.app())
                .put(`${ctx.baseUrl}/${message.uid}/verificationSeal`)
                .set("Authorization", "jwt " + ctx.tokenFor(owner))
                .send(SEAL);
            expect(unsealed.status).toBe(200);
            expect(await stateOf(message.uid)).toEqual({});

            expect((await putSeal(message.uid, SEAL)).status).toBe(200);
            const sealed = await request(ctx.app())
                .put(`${ctx.baseUrl}/${message.uid}/verificationSeal`)
                .set("Authorization", "jwt " + ctx.tokenFor(admin))
                .send(OTHER_SEAL);
            expect(sealed.status).toBe(200);
            const generation = await request(ctx.app())
                .put(`${ctx.baseUrl}/${message.uid}/verificationSealGeneration`)
                .set("Authorization", "jwt " + ctx.tokenFor(owner))
                .send("9");
            expect(generation.status).toBe(200);
            expect(await stateOf(message.uid)).toEqual({ seal: SEAL, generation: 0 });
        });
    });

    describe("never copied", () => {
        it("sending a sealed draft files that same row into Sent Items - no copy, and the seal isn't in the relayed message", async () => {
            const bodyBlobKey = `bodies/${uuid.v4()}`;
            await ctx
                .blobStore()
                .put(bodyBlobKey, Buffer.from("From: owner@example.com\r\nTo: recipient@example.com\r\nSubject: Hi\r\n\r\nHello there.\r\n"));
            const { mailbox, message } = await setup({ type: FolderType.DRAFTS, fields: { bodyBlobKey } });
            await ctx.rawUpdateMessage(message.uid, { verificationSeal: SEAL, verificationSealGeneration: 0 });
            ctx.transport().sent = [];

            const res = await request(ctx.app())
                .post(`${ctx.baseUrl}/${message.uid}/send`)
                .set("Authorization", "jwt " + ctx.tokenFor(owner));

            expect(res.status).toBe(200);
            const messages = await ctx.findMessages(mailbox.uid);
            expect(messages.map((row) => row.uid)).toEqual([message.uid]);
            expect(ctx.transport().sent).toHaveLength(1);
            expect(ctx.transport().sent[0].raw.toString("utf-8")).not.toContain(SEAL);
        });
    });
}
