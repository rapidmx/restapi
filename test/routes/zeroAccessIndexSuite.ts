///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The zero-access search index route (`BaseZeroAccessIndexRoute`): the manifest, the pending entries, and segment compaction - run
// against Mongo and SQL by `test/routes/{mongo,sql}/ZeroAccessDelivery.test.ts`.
import { createHash, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { request } from "@rapidrest/service-core/test";
import * as uuid from "uuid";
import { isoWeekId, sealToCertificate } from "../../src/zeroaccess/ZeroAccessSealer.js";
import { zeroAccessSegmentUid } from "../../src/zeroaccess/ZeroAccessIndexStore.js";
import type { InMemoryBlobStore } from "../testDoubles.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface ZeroAccessIndexSuiteContext {
    app: () => any;
    /** The mailbox route, e.g. `/mongo/mailboxes`. */
    mailboxesUrl: string;
    tokenFor: (uid: string) => string;
    blobStore: () => InMemoryBlobStore;
    createMailbox: (data?: any) => Promise<any>;
    createIndexEntry: (data: any) => Promise<any>;
    indexEntries: () => Promise<any[]>;
    findSegment: (uid: string) => Promise<any>;
}

async function zeroAccessKey() {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: uuid.v4().replace(/-/g, "").slice(0, 16),
        name: "CN=za",
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        keys: keys as CryptoKeyPair,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    const der = Buffer.from(cert.rawData);
    return {
        der,
        key: {
            publicKey: der.toString("base64"),
            type: "x509",
            useType: "zero-access" as const,
            fingerprint: createHash("sha256").update(der).digest("hex"),
            notBefore: 1,
            notAfter: 2,
        },
    };
}

const WEEK_MS = 7 * 86_400_000;

export function zeroAccessIndexSuite(ctx: ZeroAccessIndexSuiteContext): void {
    describe("zero-access search index", () => {
        const owner = uuid.v4();
        const auth = (uid: string = owner) => "jwt " + ctx.tokenFor(uid);
        const url = (mailbox: any, path: string) => `${ctx.mailboxesUrl}/${mailbox.uid}/search-index${path}`;
        // A week long closed (past any grace period), and the current one.
        const closedWeek: string = isoWeekId(new Date(Date.now() - 3 * WEEK_MS));
        const currentWeek: string = isoWeekId(new Date());

        const setup = async () => {
            const za = await zeroAccessKey();
            const mailbox = await ctx.createMailbox({ ownerUserUid: owner, zeroAccessKeys: [za.key] });
            return { mailbox, za };
        };
        const entry = (mailbox: any, weekId: string, fields: any = {}) =>
            ctx.createIndexEntry({
                mailboxUid: mailbox.uid,
                messageUid: uuid.v4(),
                weekId,
                receivedAt: new Date(),
                keyFingerprint: "fp",
                sealed: "c2VhbGVk",
                ...fields,
            });
        const upload = async (za: any, fields: any = {}) => ({
            expectedGeneration: 0,
            segment: (await sealToCertificate(Buffer.from("SQLite format 3\0 fake"), za.der)).toString("base64"),
            keyFingerprint: za.key.fingerprint,
            schemaVersion: 1,
            ...fields,
        });

        it("lists no segments and counts the pending entries per week, marking only a closed week compactable", async () => {
            const { mailbox } = await setup();
            await entry(mailbox, closedWeek);
            await entry(mailbox, closedWeek, { sealed: "c2VhbGVkIGxvbmdlcg==" });
            await entry(mailbox, currentWeek);

            const result = await request(ctx.app()).get(url(mailbox, "/manifest")).set("Authorization", auth());

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body.segments).toEqual([]);
            expect(result.body.weeks).toEqual([
                expect.objectContaining({ weekId: closedWeek, pendingEntries: 2, compactable: true, pendingBytes: 8 + 20 }),
                expect.objectContaining({ weekId: currentWeek, pendingEntries: 1, compactable: false, pendingBytes: 8 }),
            ]);
            // A week becomes compactable when it ends plus the grace period: in the past for the closed week, ahead for this one.
            const [closed, current] = result.body.weeks.map((week: any) => Date.parse(week.compactableAt));
            expect(closed).toBeLessThan(Date.now());
            expect(current).toBeGreaterThan(Date.now());
            expect(current - closed).toBe(3 * WEEK_MS);
        });

        it("leaves a week that isn't an ISO week out of the manifest, rather than failing it", async () => {
            const { mailbox } = await setup();
            await entry(mailbox, "499-W53");
            await entry(mailbox, currentWeek);

            const result = await request(ctx.app()).get(url(mailbox, "/manifest")).set("Authorization", auth());

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body.weeks.map((week: any) => week.weekId)).toEqual([currentWeek]);
        });

        it("refuses everyone but the owner, and a mailbox that doesn't exist", async () => {
            const { mailbox } = await setup();
            expect((await request(ctx.app()).get(url(mailbox, "/manifest")).set("Authorization", auth(uuid.v4()))).status).toBe(403);
            expect((await request(ctx.app()).get(url({ uid: uuid.v4() }, "/manifest")).set("Authorization", auth())).status).toBe(403);
            expect((await request(ctx.app()).get(url(mailbox, "/entries")).set("Authorization", auth(uuid.v4()))).status).toBe(403);
        });

        it("pages through pending entries by uid, optionally of one week and written since a time", async () => {
            const { mailbox } = await setup();
            const created = [await entry(mailbox, closedWeek), await entry(mailbox, closedWeek), await entry(mailbox, currentWeek)];

            const first = await request(ctx.app()).get(url(mailbox, "/entries?limit=2")).set("Authorization", auth());
            const second = await request(ctx.app()).get(url(mailbox, `/entries?limit=2&after=${first.body.next}`)).set("Authorization", auth());
            const week = await request(ctx.app()).get(url(mailbox, `/entries?week=${currentWeek}`)).set("Authorization", auth());
            const future = await request(ctx.app())
                .get(url(mailbox, `/entries?since=${new Date(Date.now() + 60_000).toISOString()}`))
                .set("Authorization", auth());

            expect(first.body.entries).toHaveLength(2);
            expect(second.body.entries).toHaveLength(1);
            expect(second.body.next).toBeUndefined();
            expect([...first.body.entries, ...second.body.entries].map((e: any) => e.uid).sort()).toEqual(created.map((e) => e.uid).sort());
            expect(first.body.entries[0]).toMatchObject({ sealed: "c2VhbGVk", keyFingerprint: "fp" });
            expect(week.body.entries.map((e: any) => e.uid)).toEqual([created[2].uid]);
            expect(future.body.entries).toEqual([]);
            expect((await request(ctx.app()).get(url(mailbox, "/entries?week=nope")).set("Authorization", auth())).status).toBe(400);
            expect((await request(ctx.app()).get(url(mailbox, "/entries?since=nope")).set("Authorization", auth())).status).toBe(400);
        });

        it("stores a compaction, removes exactly the entries it folded, and serves the file with its ETag", async () => {
            const { mailbox, za } = await setup();
            const folded = [await entry(mailbox, closedWeek), await entry(mailbox, closedWeek)];
            const late = await entry(mailbox, closedWeek);
            const otherWeek = await entry(mailbox, currentWeek);
            const body = await upload(za, { foldedEntryUids: [...folded.map((e) => e.uid), otherWeek.uid, "unknown"] });

            const result = await request(ctx.app()).put(url(mailbox, `/segments/${closedWeek}`)).set("Authorization", auth()).send(body);

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({ weekId: closedWeek, generation: 1, origin: "zero-access", entryCount: 2, keyFingerprint: za.key.fingerprint });
            expect((await ctx.indexEntries()).map((e) => e.uid).sort()).toEqual([late.uid, otherWeek.uid].sort());

            const file = await request(ctx.app()).get(url(mailbox, `/segments/${closedWeek}?generation=1`)).set("Authorization", auth());
            expect(file.status).toBe(200);
            const stored = await ctx.findSegment(zeroAccessSegmentUid(mailbox.uid, closedWeek, "zero-access"));
            expect((await ctx.blobStore().get(stored.blobKey)).toString("base64")).toBe(body.segment);
            expect(Number(file.headers["content-length"])).toBe(Buffer.from(body.segment, "base64").length);
            expect(result.body.etag).toBe(createHash("sha256").update(Buffer.from(body.segment, "base64")).digest("hex"));
            expect(file.headers.etag).toBe(`"${result.body.etag}"`);
            const cached = await request(ctx.app())
                .get(url(mailbox, `/segments/${closedWeek}`))
                .set("Authorization", auth())
                .set("If-None-Match", file.headers.etag);
            expect(cached.status).toBe(304);
            expect((await request(ctx.app()).get(url(mailbox, `/segments/${closedWeek}?generation=2`)).set("Authorization", auth())).status).toBe(404);
            expect((await request(ctx.app()).get(url(mailbox, `/segments/${currentWeek}`)).set("Authorization", auth())).status).toBe(404);
        });

        it("compacts later entries into a new generation, removing the previous file, and refuses a stale generation", async () => {
            const { mailbox, za } = await setup();
            const first = await entry(mailbox, closedWeek);
            await request(ctx.app())
                .put(url(mailbox, `/segments/${closedWeek}`))
                .set("Authorization", auth())
                .send(await upload(za, { foldedEntryUids: [first.uid] }));
            const firstFile: string = (await ctx.findSegment(zeroAccessSegmentUid(mailbox.uid, closedWeek, "zero-access"))).blobKey;
            const second = await entry(mailbox, closedWeek);

            const stale = await request(ctx.app())
                .put(url(mailbox, `/segments/${closedWeek}`))
                .set("Authorization", auth())
                .send(await upload(za, { foldedEntryUids: [second.uid] }));
            const next = await request(ctx.app())
                .put(url(mailbox, `/segments/${closedWeek}`))
                .set("Authorization", auth())
                .send(await upload(za, { expectedGeneration: 1, foldedEntryUids: [second.uid] }));

            expect(stale.status).toBe(409);
            expect(next.status).toBe(200);
            expect(next.body).toMatchObject({ generation: 2, entryCount: 2 });
            expect(await ctx.blobStore().exists(firstFile)).toBe(false);
            expect(await ctx.indexEntries()).toEqual([]);

            const manifest = await request(ctx.app()).get(url(mailbox, "/manifest")).set("Authorization", auth());
            expect(manifest.body.segments).toEqual([expect.objectContaining({ weekId: closedWeek, generation: 2 })]);
            expect(manifest.body.weeks).toEqual([]);
        });

        it("refuses a file not encrypted to the mailbox's zero-access key, an open week, and malformed uploads", async () => {
            const { mailbox, za } = await setup();
            const stranger = await zeroAccessKey();
            const put = async (weekId: string, body: any) =>
                (await request(ctx.app()).put(url(mailbox, `/segments/${weekId}`)).set("Authorization", auth()).send(body)).status;

            expect(await put(closedWeek, await upload(za, { segment: Buffer.from("SQLite format 3\0 plaintext").toString("base64") }))).toBe(400);
            expect(await put(closedWeek, await upload(stranger, { keyFingerprint: za.key.fingerprint }))).toBe(400);
            expect(await put(closedWeek, await upload(stranger))).toBe(400);
            expect(await put(currentWeek, await upload(za))).toBe(400);
            expect(await put("2026-W99", await upload(za))).toBe(400);
            expect(await put(closedWeek, await upload(za, { expectedGeneration: -1 }))).toBe(400);
            expect(await put(closedWeek, await upload(za, { schemaVersion: 0 }))).toBe(400);
            expect(await put(closedWeek, await upload(za, { foldedEntryUids: [5] }))).toBe(400);
            expect(await put(closedWeek, await upload(za, { origin: "client", foldedEntryUids: ["x"] }))).toBe(400);
            expect(await put(closedWeek, await upload(za, { origin: "server" }))).toBe(400);
            expect(await put(closedWeek, await upload(za, { segment: "" }))).toBe(413);
            expect(await put(closedWeek, undefined)).toBe(400);
        });

        it("keeps a client-built segment (end-to-end encrypted mail) beside the zero-access one, for any week", async () => {
            const { mailbox, za } = await setup();
            const result = await request(ctx.app())
                .put(url(mailbox, `/segments/${currentWeek}`))
                .set("Authorization", auth())
                .send(await upload(za, { origin: "client" }));

            expect(result.status).toBe(200);
            expect(result.body).toMatchObject({ origin: "client", generation: 1 });
            const file = await request(ctx.app()).get(url(mailbox, `/segments/${currentWeek}?origin=client`)).set("Authorization", auth());
            expect(file.status).toBe(200);

            for (const origin of ["zero-access", "client"]) {
                await request(ctx.app())
                    .put(url(mailbox, `/segments/${closedWeek}`))
                    .set("Authorization", auth())
                    .send(await upload(za, { origin }));
            }
            const manifest = await request(ctx.app()).get(url(mailbox, "/manifest")).set("Authorization", auth());
            expect(manifest.body.segments.map((segment: any) => `${segment.weekId}/${segment.origin}`)).toEqual([
                `${closedWeek}/client`,
                `${closedWeek}/zero-access`,
                `${currentWeek}/client`,
            ]);
        });
    });
}
