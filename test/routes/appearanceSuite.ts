///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `GET/PUT /mail/preferences/appearance` and the background image routes, over a real HTTP server, identical on both
// backends. `test/routes/{mongo,sql}/AppearanceRoute.test.ts` supply the server, the `InMemoryBlobStore` and the row access.
import { request } from "@rapidrest/service-core/test";
import { NotificationUtils } from "@rapidrest/service-core";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import type { InMemoryBlobStore } from "../testDoubles.js";

export interface AppearanceSuiteContext {
    app: () => any;
    baseUrl: string;
    /** The entity class name events are published under. */
    entityName: string;
    authConfig: () => any;
    blobStore: () => InMemoryBlobStore;
    /** Every saved row. */
    rows: () => Promise<any[]>;
    /** What `fetchAppearanceForSSR()` answers for `userUid`. */
    ssr: (userUid: string) => Promise<any>;
}

/** The smallest bytes each supported type is sniffed as (only the magic number matters to the route). */
export const PNG: Buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
export const JPEG: Buffer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg body")]);
export const WEBP: Buffer = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x10, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.from("webp body")]);
export const AVIF: Buffer = Buffer.concat([
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from("ftypavif"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("mif1avif"),
    Buffer.from("avif body"),
]);
export const SVG: Buffer = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
export const GIF: Buffer = Buffer.concat([Buffer.from("GIF89a"), Buffer.from("gif body")]);

export function appearanceSuite(ctx: AppearanceSuiteContext): void {
    const person = (roles: string[] = []) => {
        const uid: string = uuid.v4();
        return { uid, token: JWTUtils.createTokenSync(ctx.authConfig(), { uid, roles, elevated: Date.now() } as any) };
    };
    const alice = person();
    const bob = person();
    const admin = person(["admin"]);

    const get = (who = alice) => request(ctx.app()).get(ctx.baseUrl).set("Authorization", "jwt " + who.token);
    const put = (body: any, who = alice) => request(ctx.app()).put(ctx.baseUrl).set("Authorization", "jwt " + who.token).send(body);
    const upload = (bytes: Buffer, type: string = "image/png", who = alice) =>
        request(ctx.app()).post(`${ctx.baseUrl}/background`).set("Authorization", "jwt " + who.token).set("Content-Type", type).send(bytes);
    const remove = (who = alice) => request(ctx.app()).delete(`${ctx.baseUrl}/background`).set("Authorization", "jwt " + who.token);
    const image = (version: string, who = alice) =>
        request(ctx.app()).get(`${ctx.baseUrl}/background/${version}`).set("Authorization", "jwt " + who.token);
    const blobKeys = (userUid: string): string[] => [...(ctx.blobStore() as any).store.keys()].filter((key: string) => key.startsWith(`appearance/${userUid}/`));

    let published: any[];
    let sendMessage: any;
    beforeEach(async () => {
        published = [];
        sendMessage = vi.spyOn(NotificationUtils.prototype, "sendMessage").mockImplementation((uids: any, type: any, action: any, data: any) => {
            published.push({ uids, type, action, data });
        });
        (ctx.blobStore() as any).store.clear();
    });
    afterEach(() => {
        sendMessage.mockRestore();
    });

    describe("GET (the caller's preferences)", () => {
        it("answers the defaults, never a 404, for a user who has saved nothing - and writes no row", async () => {
            const result = await get();

            expect(result.status).toBe(200);
            expect(result.body).toEqual({ version: 1, mode: "system", updatedAt: new Date(0).toISOString() });
            expect(await ctx.rows()).toEqual([]);
        });

        it("refuses a caller who is not signed in", async () => {
            expect((await request(ctx.app()).get(ctx.baseUrl)).status).toBe(401);
            expect((await request(ctx.app()).put(ctx.baseUrl).send({ mode: "dark" })).status).toBe(401);
            expect((await request(ctx.app()).post(`${ctx.baseUrl}/background`).set("Content-Type", "image/png").send(PNG)).status).toBe(401);
            expect((await request(ctx.app()).get(`${ctx.baseUrl}/background/${uuid.v4()}`)).status).toBe(401);
            expect((await request(ctx.app()).delete(`${ctx.baseUrl}/background`)).status).toBe(401);
        });
    });

    describe("PUT (merge and validate)", () => {
        it("saves the mode, answers what is saved, and keeps one row per user however many saves", async () => {
            const first = await put({ mode: "dark" });
            const second = await put({ colors: { primary: "#aabbcc" } });

            expect(first.status).toBe(200);
            expect(first.body).toMatchObject({ version: 1, mode: "dark" });
            expect(Date.now() - Date.parse(first.body.updatedAt)).toBeLessThan(60_000);
            expect(second.body).toMatchObject({ mode: "dark", colors: { primary: "#aabbcc" } });
            expect((await get()).body).toEqual(second.body);
            const rows = await ctx.rows();
            expect(rows).toHaveLength(1);
            expect(rows[0].userUid).toBe(alice.uid);
        });

        it("merges colours key by key, lowercases them, and clears one with null or all with null", async () => {
            await put({ colors: { primary: "#AABBCC", accent: "#112233" } });
            const merged = await put({ colors: { accent: "#445566", text: "#000000" } });
            expect(merged.body.colors).toEqual({ primary: "#aabbcc", accent: "#445566", text: "#000000" });

            const oneCleared = await put({ colors: { primary: null } });
            expect(oneCleared.body.colors).toEqual({ accent: "#445566", text: "#000000" });

            const allCleared = await put({ colors: null });
            expect(allCleared.body.colors).toBeUndefined();
            expect((await get()).body.colors).toBeUndefined();
        });

        it("clears the last colour, leaving none", async () => {
            await put({ colors: { primary: "#aabbcc" } });

            const result = await put({ colors: { primary: null } });

            expect(result.body.colors).toBeUndefined();
        });

        it("saves a colour background with the other settings' defaults, then merges later changes into it", async () => {
            const first = await put({ background: { kind: "color", color: "#112233" } });
            expect(first.body.background).toEqual({ kind: "color", color: "#112233", dim: 0, blur: 0, fit: "cover" });

            const second = await put({ background: { dim: 0.5, blur: 20, fit: "tile" } });
            expect(second.body.background).toEqual({ kind: "color", color: "#112233", dim: 0.5, blur: 20, fit: "tile" });

            const third = await put({ background: { kind: "none", color: null } });
            expect(third.body.background).toEqual({ kind: "none", dim: 0.5, blur: 20, fit: "tile" });
        });

        it("accepts what a client read back, `version` and `updatedAt` included", async () => {
            const saved = await put({ mode: "light", colors: { primary: "#010203" } });

            const again = await put(saved.body);

            expect(again.status).toBe(200);
            expect(again.body).toMatchObject({ mode: "light", colors: { primary: "#010203" } });
        });

        it("writes no row and publishes nothing for a body with nothing in it", async () => {
            const result = await put({});

            expect(result.status).toBe(200);
            expect(result.body.mode).toBe("system");
            expect(await ctx.rows()).toEqual([]);
            expect(published).toEqual([]);
        });

        it("reads back what is saved, without a write, for a body with nothing in it", async () => {
            await put({ mode: "dark" });
            published = [];

            const result = await put({ version: 1 });

            expect(result.body.mode).toBe("dark");
            expect(published).toEqual([]);
        });

        it.each([
            ["a mode that is not offered", { mode: "sepia" }, "'mode'"],
            ["a colour that is not #rrggbb", { colors: { primary: "red" } }, "'colors.primary'"],
            ["a short hex colour", { colors: { accent: "#abc" } }, "'colors.accent'"],
            ["a colour that is a number", { colors: { surface: 123456 } }, "'colors.surface'"],
            ["a colour key that is not one of ours", { colors: { primry: "#aabbcc" } }, "'colors.primry'"],
            ["colours that are not an object", { colors: "#aabbcc" }, "'colors'"],
            ["a background that is not an object", { background: "none" }, "'background'"],
            ["a background that is null", { background: null }, "'background'"],
            ["a background kind that is not offered", { background: { kind: "video" } }, "'background.kind'"],
            ["a background colour that is not #rrggbb", { background: { kind: "color", color: "blue" } }, "'background.color'"],
            ["a dim above 0.8", { background: { dim: 0.81 } }, "'background.dim'"],
            ["a negative dim", { background: { dim: -0.1 } }, "'background.dim'"],
            ["a dim that is not a number", { background: { dim: "0.5" } }, "'background.dim'"],
            ["a blur above 20", { background: { blur: 21 } }, "'background.blur'"],
            ["a blur that is not a number", { background: { blur: true } }, "'background.blur'"],
            ["a fit that is not offered", { background: { fit: "stretch" } }, "'background.fit'"],
            ["a background key that is not one of ours", { background: { position: "top" } }, "'background.position'"],
            ["an imageVersion that is not a string", { background: { imageVersion: 7 } }, "'background.imageVersion'"],
            ["an imageVersion no upload made", { background: { imageVersion: "made-up" } }, "'background.imageVersion'"],
            ["an image background with nothing uploaded", { background: { kind: "image" } }, "'background.kind'"],
            ["a colour background with no colour", { background: { kind: "color" } }, "'background.color'"],
            ["the invertDarkMessages key, which no longer exists", { invertDarkMessages: true }, "'invertDarkMessages'"],
            ["a version that is not 1", { version: 2 }, "'version'"],
            ["a top-level key that is not one of ours", { theme: "blue" }, "'theme'"],
            ["a path key", { "colors.primary": "#aabbcc" }, "'colors.primary'"],
            ["a $ operator key", { $set: { mode: "dark" } }, "'$set'"],
        ])("refuses %s with a 400 naming the field", async (_name, body, field) => {
            const result = await put(body);

            expect(result.status).toBe(400);
            expect(result.body.message).toContain(field);
            expect(await ctx.rows()).toEqual([]);
        });

        it("refuses a body that is not an object", async () => {
            for (const body of [[], '"dark"', "7"]) {
                const result = await request(ctx.app())
                    .put(ctx.baseUrl)
                    .set("Authorization", "jwt " + alice.token)
                    .set("Content-Type", "application/json")
                    .send(body as any);
                expect(result.status).toBe(400);
            }
        });

        it("saves nothing when one field of several is wrong", async () => {
            await put({ mode: "dark" });

            const result = await put({ mode: "light", colors: { primary: "nope" } });

            expect(result.status).toBe(400);
            expect((await get()).body.mode).toBe("dark");
        });

        it("keeps every write of several at once, creating the row only once", async () => {
            const results = await Promise.all([put({ mode: "dark" }), put({ colors: { primary: "#aabbcc" } }), put({ background: { kind: "color", color: "#010203" } })]);

            expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
            expect(await ctx.rows()).toHaveLength(1);
            const final = (await get()).body;
            expect(final.mode).toBe("dark");
            expect(final.colors).toEqual({ primary: "#aabbcc" });
            expect(final.background).toMatchObject({ kind: "color", color: "#010203" });
        });
    });

    describe("whose preferences they are", () => {
        it("keeps every user's preferences separate", async () => {
            await put({ mode: "dark" }, alice);
            await put({ mode: "light" }, bob);

            expect((await get(alice)).body.mode).toBe("dark");
            expect((await get(bob)).body.mode).toBe("light");
            expect(await ctx.rows()).toHaveLength(2);
        });

        it("gives a trusted role no way to read or write another user's - it only ever sees its own", async () => {
            await put({ mode: "dark", colors: { primary: "#aabbcc" } }, alice);

            const seen = await get(admin);
            const written = await put({ mode: "light" }, admin);

            expect(seen.body).toMatchObject({ mode: "system" });
            expect(seen.body.colors).toBeUndefined();
            expect(written.body.mode).toBe("light");
            expect((await get(alice)).body).toMatchObject({ mode: "dark", colors: { primary: "#aabbcc" } });
            // A uid in the path or the query is not something a route reads.
            const attempt = await request(ctx.app())
                .get(`${ctx.baseUrl}?userUid=${alice.uid}`)
                .set("Authorization", "jwt " + admin.token);
            expect(attempt.body.mode).toBe("light");
        });
    });

    describe("POST /background (upload)", () => {
        it.each([
            ["PNG", PNG, "image/png"],
            ["JPEG", JPEG, "image/jpeg"],
            ["WebP", WEBP, "image/webp"],
            ["AVIF", AVIF, "image/avif"],
        ])("stores a %s under appearance/<userUid>/<version>, points the background at it and serves it back", async (_name, bytes, type) => {
            const result = await upload(bytes, type);

            expect(result.status).toBe(200);
            const version: string = result.body.background.imageVersion;
            expect(version).toMatch(/^[0-9a-f-]{36}$/);
            expect(result.body.background).toEqual({ kind: "image", imageVersion: version, dim: 0, blur: 0, fit: "cover" });
            expect(blobKeys(alice.uid)).toEqual([`appearance/${alice.uid}/${version}`]);
            expect(await ctx.blobStore().get(`appearance/${alice.uid}/${version}`)).toEqual(bytes);
            expect((await get()).body).toEqual(result.body);

            const served = await image(version);
            expect(served.status).toBe(200);
            expect(served.headers["content-type"]).toBe(type);
            expect(served.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
            expect(served.headers["x-content-type-options"]).toBe("nosniff");
            expect(served.headers["content-disposition"]).toBe("inline");
            expect(served.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
            // The test client decodes a body as text, so the byte count stands in for the bytes (compared in the blob store above).
            expect(Number(served.headers["content-length"])).toBe(bytes.length);
        });

        it("goes by the bytes, not the header: a JPEG sent as image/png is stored and served as image/jpeg", async () => {
            const result = await upload(JPEG, "image/png");

            expect(result.status).toBe(200);
            const served = await image(result.body.background.imageVersion);
            expect(served.headers["content-type"]).toBe("image/jpeg");
        });

        it("accepts a Content-Type with parameters and in any case", async () => {
            expect((await upload(PNG, "Image/PNG; charset=binary")).status).toBe(200);
        });

        it("refuses an SVG whatever it says it is (415) - it is a document that can carry script", async () => {
            expect((await upload(SVG, "image/svg+xml")).status).toBe(415);
            expect((await upload(SVG, "image/png")).status).toBe(415);
            expect(blobKeys(alice.uid)).toEqual([]);
            expect(await ctx.rows()).toEqual([]);
        });

        it("refuses a GIF, an unsupported type, and bytes that are not an image (415)", async () => {
            expect((await upload(GIF, "image/gif")).status).toBe(415);
            expect((await upload(GIF, "image/png")).status).toBe(415);
            expect((await upload(Buffer.from("just text"), "text/plain")).status).toBe(415);
            expect((await upload(Buffer.from("just text"), "image/png")).status).toBe(415);
            expect((await upload(PNG, "application/octet-stream")).status).toBe(415);
            expect(blobKeys(alice.uid)).toEqual([]);
        });

        it("refuses an empty body (400)", async () => {
            const result = await request(ctx.app())
                .post(`${ctx.baseUrl}/background`)
                .set("Authorization", "jwt " + alice.token)
                .set("Content-Type", "image/png");

            expect(result.status).toBe(400);
        });

        it("refuses an image above the size limit (413) and stores nothing", async () => {
            const big = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024 + 1 - PNG.length)]);
            expect(big.length).toBe(8 * 1024 * 1024 + 1);

            const result = await upload(big);

            expect(result.status).toBe(413);
            expect(blobKeys(alice.uid)).toEqual([]);
            expect(await ctx.rows()).toEqual([]);
        });

        it("accepts an image of exactly the size limit", async () => {
            const exact = Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024 - PNG.length)]);

            expect((await upload(exact)).status).toBe(200);
        });

        it("replaces the previous image - a new version, the old blob deleted, dim/blur/fit kept", async () => {
            await put({ background: { dim: 0.4, blur: 5, fit: "contain" } });
            const first = await upload(PNG);
            const second = await upload(JPEG, "image/jpeg");

            const oldVersion = first.body.background.imageVersion;
            const newVersion = second.body.background.imageVersion;
            expect(newVersion).not.toBe(oldVersion);
            expect(second.body.background).toEqual({ kind: "image", imageVersion: newVersion, dim: 0.4, blur: 5, fit: "contain" });
            expect(blobKeys(alice.uid)).toEqual([`appearance/${alice.uid}/${newVersion}`]);
            expect((await image(oldVersion)).status).toBe(404);
            expect((await image(newVersion)).status).toBe(200);
            expect(await ctx.rows()).toHaveLength(1);
        });

        it("keeps a colour chosen earlier", async () => {
            await put({ background: { kind: "color", color: "#112233" } });

            const result = await upload(PNG);

            expect(result.body.background).toMatchObject({ kind: "image", color: "#112233" });
        });

        it("leaves the image in place when the background is switched to a colour or nothing, so it can be switched back", async () => {
            const uploaded = await upload(PNG);
            const version = uploaded.body.background.imageVersion;

            const off = await put({ background: { kind: "none" } });
            expect(off.body.background).toMatchObject({ kind: "none", imageVersion: version });
            expect((await image(version)).status).toBe(200);
            const back = await put({ background: { kind: "image" } });
            expect(back.body.background).toMatchObject({ kind: "image", imageVersion: version });
            expect((await put({ background: { imageVersion: version } })).status).toBe(200);
        });

        it("keeps one row and one blob for two uploads at once", async () => {
            const results = await Promise.all([upload(PNG), upload(JPEG, "image/jpeg")]);

            expect(results.map((result) => result.status)).toEqual([200, 200]);
            expect(await ctx.rows()).toHaveLength(1);
            const current = (await get()).body.background.imageVersion;
            expect(blobKeys(alice.uid)).toEqual([`appearance/${alice.uid}/${current}`]);
        });
    });

    describe("GET /background/:version", () => {
        it("answers 404 to anyone but the owner, whatever their role, and for a version that is not the current one", async () => {
            const uploaded = await upload(PNG);
            const version = uploaded.body.background.imageVersion;

            expect((await image(version, bob)).status).toBe(404);
            expect((await image(version, admin)).status).toBe(404);
            expect((await image(uuid.v4())).status).toBe(404);
            expect((await image(version)).status).toBe(200);
        });

        it("answers 404 the same way whether or not the other user has an image, or a row at all", async () => {
            const uploaded = await upload(PNG);
            await put({ mode: "dark" }, bob);

            const withRow = await image(uploaded.body.background.imageVersion, bob);
            const noRow = await image(uploaded.body.background.imageVersion, admin);

            expect(withRow.status).toBe(404);
            expect(noRow.status).toBe(404);
            expect(withRow.body).toEqual(noRow.body);
        });

        it("answers 404 once the image is removed", async () => {
            const uploaded = await upload(PNG);
            await remove();

            expect((await image(uploaded.body.background.imageVersion)).status).toBe(404);
        });
    });

    describe("DELETE /background", () => {
        it("deletes the blob, sets the kind to none and drops the version", async () => {
            await put({ background: { dim: 0.3, blur: 2, fit: "tile" } });
            const uploaded = await upload(PNG);
            const version = uploaded.body.background.imageVersion;

            const result = await remove();

            expect(result.status).toBe(200);
            expect(result.body.background).toEqual({ kind: "none", dim: 0.3, blur: 2, fit: "tile" });
            expect(blobKeys(alice.uid)).toEqual([]);
            expect((await get()).body.background).toEqual({ kind: "none", dim: 0.3, blur: 2, fit: "tile" });
            expect((await image(version)).status).toBe(404);
            const rows = await ctx.rows();
            expect(rows[0].backgroundContentType ?? null).toBeNull();
        });

        it("answers the saved preferences when there was no image, and the defaults when there is no row", async () => {
            expect((await remove()).body).toEqual({ version: 1, mode: "system", updatedAt: new Date(0).toISOString() });
            expect(await ctx.rows()).toEqual([]);

            await put({ mode: "dark" });
            const result = await remove();

            expect(result.status).toBe(200);
            expect(result.body.mode).toBe("dark");
        });

        it("leaves another user's image alone", async () => {
            const theirs = await upload(PNG, "image/png", bob);

            await remove(alice);

            expect((await image(theirs.body.background.imageVersion, bob)).status).toBe(200);
        });
    });

    describe("live updates", () => {
        it("publishes the saved preferences on the user's own uid channel after a PUT, an upload and a delete", async () => {
            const saved = await put({ mode: "dark" });
            const uploaded = await upload(PNG);
            const removed = await remove();

            expect(published).toEqual([
                { uids: alice.uid, type: ctx.entityName, action: "update", data: saved.body },
                { uids: alice.uid, type: ctx.entityName, action: "update", data: uploaded.body },
                { uids: alice.uid, type: ctx.entityName, action: "update", data: removed.body },
            ]);
        });

        it("does not fail the write when publishing throws", async () => {
            sendMessage.mockImplementation(() => {
                throw new Error("redis is down");
            });

            const result = await put({ mode: "dark" });

            expect(result.status).toBe(200);
            expect((await get()).body.mode).toBe("dark");
        });

        it("publishes nothing for a refused change", async () => {
            await put({ mode: "sepia" });
            await upload(SVG, "image/svg+xml");

            expect(published).toEqual([]);
        });
    });

    describe("the page prop (fetchAppearanceForSSR)", () => {
        it("is the saved preferences for a user who has some, and undefined for one who has none", async () => {
            const saved = await put({ mode: "dark", colors: { primary: "#aabbcc" } });

            expect(await ctx.ssr(alice.uid)).toEqual(saved.body);
            expect(await ctx.ssr(bob.uid)).toBeUndefined();
        });
    });
}
