///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `POST /plugins/upload` (install a plugin from an `npm pack` file) and how the other plugin routes treat an uploaded
// plugin, identical on both backends - `test/routes/{mongo,sql}/PluginRoute.test.ts` supply the context. The runners
// configure `system:plugins:uploads:max_bytes` as `UPLOAD_TEST_MAX_BYTES`.
import { request } from "@rapidrest/service-core/test";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import * as zlib from "zlib";
import { AuditAction } from "../../src/models/types.js";
import { BasePluginRoute } from "../../src/routes/BasePluginRoute.js";
import {
    computePluginStateHash,
    packIntegrity,
    PLUGIN_API_VERSION,
    pluginUploadBlobKey,
} from "../../src/plugins/PluginUtils.js";
import { InMemoryBlobStore } from "../testDoubles.js";
import { publishedHashes, publishFakePackage, registryReads, resetPluginTestDoubles } from "./pluginTestDoubles.js";
import { PluginRouteSuiteContext } from "./pluginRouteSuite.js";
import { gzipTar, packOf, TarEntry } from "./tarFixtures.js";

export const UPLOAD_TEST_MAX_BYTES = 400_000;

export interface PluginUploadSuiteContext extends PluginRouteSuiteContext {
    blobStore: () => InMemoryBlobStore;
    /** Every audit log entry's action and details. */
    auditEntries: () => Promise<{ action: string; details?: any }[]>;
}

const CRM = "@acme/crm-plugin";
const CRM_MANIFEST = {
    apiVersion: PLUGIN_API_VERSION,
    displayName: "CRM",
    settings: [
        { key: "mail:crm:api_key", label: "API key", type: "string", secret: true },
        { key: "mail:crm:note", label: "Note", type: "string", default: "hello" },
        { key: "mail:crm:old", label: "Old", type: "string", default: "old" },
    ],
};
const EAS_MANIFEST = {
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Exchange ActiveSync",
    settings: [
        { key: "mail:eas:sync_window_size", label: "Sync window size", type: "number", default: 100, min: 1, max: 512 },
    ],
};

export function pluginUploadSuite(ctx: PluginUploadSuiteContext): void {
    describe("plugin uploads", () => {
        const usedKeys: Set<string> = new Set();
        let user: any;

        /** A pack for `name` at `version`; `over.pkg` replaces package.json fields. */
        function pack(
            version = "1.0.0",
            over: { name?: string; manifest?: any; pkg?: any; extra?: TarEntry[] } = {},
        ): Buffer {
            const bytes: Buffer = packOf(
                { name: over.name ?? CRM, version, rapidmx: { plugin: over.manifest ?? CRM_MANIFEST }, ...over.pkg },
                over.extra,
            );
            usedKeys.add(pluginUploadBlobKey(bytes));
            return bytes;
        }

        /** A token for a new elevated administrator: the upload route is rate limited per user. */
        const adminToken = (claims: any = {}): string =>
            JWTUtils.createTokenSync(ctx.config.get("auth"), {
                uid: uuid.v4(),
                roles: ["admin"],
                elevated: Date.now(),
                ...claims,
            });

        const upload = (bytes: Buffer | string, options: { query?: string; token?: string; type?: string } = {}) =>
            request(ctx.app())
                .post(`${ctx.baseUrl}/upload${options.query ?? ""}`)
                .set("Authorization", "jwt " + (options.token ?? adminToken()))
                .set("Content-Type", options.type ?? "application/gzip")
                .send(bytes);

        const asAdmin = (req: any) => req.set("Authorization", "jwt " + adminToken());

        beforeEach(async () => {
            await ctx.clear();
            resetPluginTestDoubles();
            publishFakePackage("@rapidmx/activesync", "1.0.0", { plugin: EAS_MANIFEST });
            user = { uid: uuid.v4(), roles: [], elevated: Date.now() };
        });

        afterEach(async () => {
            for (const key of usedKeys) {
                await ctx.blobStore().delete(key);
            }
            usedKeys.clear();
            vi.restoreAllMocks();
        });

        describe("POST /upload", () => {
            it("installs an uploaded pack, outside the allow-list, and stores the exact bytes", async () => {
                const bytes = pack("1.0.0", { name: "@unlisted/crm-plugin" });
                // The registry route would refuse this name.
                expect(
                    (await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@unlisted/crm-plugin" })).status,
                ).toBe(400);

                const adminUid = uuid.v4();
                const result = await upload(bytes, {
                    token: adminToken({ uid: adminUid }),
                    query: "?filename=C%3A%5Cdownloads%5Cmy%20pack.tgz",
                });
                expect(result.status).toBe(201);
                expect(result.body).toMatchObject({
                    name: "@unlisted/crm-plugin",
                    packageVersion: "1.0.0",
                    integrity: packIntegrity(bytes),
                    enabled: true,
                    source: "upload",
                    uploadFilename: "my pack.tgz",
                    uploadedByUserUid: adminUid,
                    settings: { "mail:crm:note": "hello", "mail:crm:old": "old" },
                    manifest: { displayName: "CRM" },
                });
                expect(result.body.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
                expect(result.body.uploadedAt).toBeDefined();
                expect(result.body).not.toHaveProperty("uploadBlobKey");

                const rows = await ctx.rows();
                expect(rows).toHaveLength(1);
                const key = pluginUploadBlobKey(bytes);
                expect(key).toMatch(/^plugins\/uploads\/[0-9a-f]{64}\.tgz$/);
                expect(rows[0].uploadBlobKey).toBe(key);
                expect(Buffer.compare(await ctx.blobStore().get(key), bytes)).toBe(0);

                const audit = (await ctx.auditEntries()).filter((entry) => entry.action === AuditAction.PLUGIN_UPLOAD);
                expect(audit).toHaveLength(1);
                expect(audit[0].details).toMatchObject({
                    name: "@unlisted/crm-plugin",
                    packageVersion: "1.0.0",
                    integrity: packIntegrity(bytes).slice(0, 19),
                    bytes: bytes.length,
                    filename: "my pack.tgz",
                    replaced: false,
                });
                expect(audit[0].details.integrity).toHaveLength(19);

                // Every server copy is told, and the state hash they compare covers the new plugin.
                expect(publishedHashes).toEqual([computePluginStateHash(rows)]);
                expect(publishedHashes[0]).not.toBe(computePluginStateHash([]));
            });

            it("names the file after the package when none is given, and never returns where the pack is stored", async () => {
                const result = await upload(pack(), { type: "application/octet-stream" });
                expect(result.status).toBe(201);
                expect(result.body.uploadFilename).toBe("acme-crm-plugin-1.0.0.tgz");
                const list = await asAdmin(request(ctx.app()).get(ctx.baseUrl));
                expect(list.body[0]).toMatchObject({ source: "upload", uploadFilename: "acme-crm-plugin-1.0.0.tgz" });
                expect(JSON.stringify(list.body)).not.toContain("uploadBlobKey");
                expect(JSON.stringify(list.body)).not.toContain("plugins/uploads");
                // An empty filename is the same as none, and a long one is cut.
                expect((await upload(pack("1.0.1"), { query: "?filename=%20%0A&replace=1" })).body.uploadFilename).toBe(
                    "acme-crm-plugin-1.0.1.tgz",
                );
                expect(
                    (await upload(pack("1.0.2"), { query: `?filename=${"n".repeat(400)}&replace=true` })).body
                        .uploadFilename,
                ).toHaveLength(255);
            });

            it("refuses a plugin that is installed unless replace=true, naming the installed version and source", async () => {
                const first = await upload(pack("1.0.0"));
                expect(first.status).toBe(201);
                const again = await upload(pack("1.1.0"));
                expect(again.status).toBe(409);
                expect(again.body.message).toMatch(
                    /^@acme\/crm-plugin 1\.0\.0 is already installed \(uploaded pack\).*replace=true/,
                );
                expect((await ctx.rows())[0].packageVersion).toBe("1.0.0");

                const eas = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/activesync" });
                expect(eas.status).toBe(200);
                const easPack = pack("2.0.0", { name: "@rapidmx/activesync", manifest: EAS_MANIFEST });
                const refused = await upload(easPack);
                expect(refused.status).toBe(409);
                expect(refused.body.message).toMatch(
                    /^@rapidmx\/activesync 1\.0\.0 is already installed \(plugin registry\)/,
                );
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(easPack))).toBe(false);
            });

            it("replaces an uploaded plugin keeping its settings and enabled flag, and deletes the old pack", async () => {
                const v1 = pack("1.0.0");
                const created = await upload(v1);
                const saved = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.body.uid}`)).send({
                    settings: { "mail:crm:api_key": "hunter2", "mail:crm:note": "mine", "mail:crm:old": "kept?" },
                    enabled: false,
                });
                expect(saved.status).toBe(200);
                publishedHashes.length = 0;

                const v2 = pack("1.1.0", {
                    manifest: { ...CRM_MANIFEST, settings: CRM_MANIFEST.settings.slice(0, 2) },
                });
                const replaced = await upload(v2, { query: "?replace=true&filename=crm-1.1.0.tgz" });
                expect(replaced.status).toBe(200);
                expect(replaced.body).toMatchObject({
                    uid: created.body.uid,
                    packageVersion: "1.1.0",
                    integrity: packIntegrity(v2),
                    enabled: false,
                    source: "upload",
                    uploadFilename: "crm-1.1.0.tgz",
                });
                // The secret is masked, the setting the new manifest dropped is gone, the others are kept.
                expect(replaced.body.settings).toEqual({
                    "mail:crm:api_key": { secret: true },
                    "mail:crm:note": "mine",
                });
                expect(JSON.stringify(replaced.body)).not.toContain("hunter2");

                const [row] = await ctx.rows();
                expect(row.settings["mail:crm:api_key"]).toBe("hunter2");
                expect(row.uploadBlobKey).toBe(pluginUploadBlobKey(v2));
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(v1))).toBe(false);
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(v2))).toBe(true);
                expect(publishedHashes).toHaveLength(1);

                const audit = (await ctx.auditEntries()).filter((entry) => entry.action === AuditAction.PLUGIN_UPLOAD);
                expect(audit.map((entry) => entry.details.replaced)).toEqual([false, true]);
                expect(audit[1].details).toMatchObject({ packageVersion: "1.1.0", previousVersion: "1.0.0" });
            });

            it("fills in a host-named default a replacement declares, and refuses one that needs a setting nobody gave", async () => {
                await upload(pack("1.0.0"));
                const withUrl = pack("1.1.0", {
                    manifest: {
                        ...CRM_MANIFEST,
                        settings: [
                            ...CRM_MANIFEST.settings,
                            { key: "mail:crm:public_url", label: "URL", type: "string", default: "https://<host>/crm" },
                        ],
                    },
                });
                const filled = await upload(withUrl, { query: "?replace=true" });
                expect(filled.status).toBe(200);
                expect(filled.body.settings["mail:crm:public_url"]).toMatch(/^https:\/\/[^<]+\/crm$/);

                const needy = pack("1.2.0", {
                    manifest: {
                        ...CRM_MANIFEST,
                        settings: [
                            ...CRM_MANIFEST.settings,
                            { key: "mail:crm:token_url", label: "Token URL", type: "string", required: true },
                        ],
                    },
                });
                const refused = await upload(needy, { query: "?replace=true" });
                expect(refused.status).toBe(400);
                expect((await ctx.rows())[0].packageVersion).toBe("1.1.0");
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(needy))).toBe(false);
            });

            it("changes the plugin state hash when a replaced pack's integrity changes", async () => {
                await upload(pack("1.0.0"));
                const before = computePluginStateHash(await ctx.rows());
                const replaced = await upload(
                    pack("1.0.0", { extra: [{ name: "package/other.js", content: "different bytes" }] }),
                    { query: "?replace=true" },
                );
                expect(replaced.status).toBe(200);
                expect(computePluginStateHash(await ctx.rows())).not.toBe(before);
                expect(publishedHashes.at(-1)).toBe(computePluginStateHash(await ctx.rows()));
            });

            it("accepts the same bytes again, keeping the one stored pack", async () => {
                const bytes = pack();
                expect((await upload(bytes)).status).toBe(201);
                const hash = computePluginStateHash(await ctx.rows());
                const again = await upload(bytes, { query: "?replace=true" });
                expect(again.status).toBe(200);
                expect(computePluginStateHash(await ctx.rows())).toBe(hash);
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(bytes))).toBe(true);
                expect(await ctx.rows()).toHaveLength(1);
            });

            it("replaces a registry plugin, and a registry update switches an uploaded one back", async () => {
                const added = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/activesync" });
                const easPack = pack("1.0.0", { name: "@rapidmx/activesync", manifest: EAS_MANIFEST });
                const replaced = await upload(easPack, { query: "?replace=true" });
                expect(replaced.status).toBe(200);
                expect(replaced.body).toMatchObject({
                    uid: added.body.plugin.uid,
                    source: "upload",
                    integrity: packIntegrity(easPack),
                });
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(easPack))).toBe(true);

                // Naming the same version still goes to the registry.
                const back = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${added.body.plugin.uid}`)).send({
                    packageVersion: "1.0.0",
                });
                expect(back.status).toBe(200);
                expect(back.body).toMatchObject({ source: "registry", integrity: "sha512-@rapidmx/activesync@1.0.0" });
                expect(back.body.uploadFilename ?? null).toBeNull();
                expect(back.body.uploadedAt ?? null).toBeNull();
                expect(back.body.uploadedByUserUid ?? null).toBeNull();
                expect(back.body).not.toHaveProperty("uploadBlobKey");
                const [row] = await ctx.rows();
                expect(row.source).toBe("registry");
                expect(row.uploadBlobKey ?? null).toBeNull();
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(easPack))).toBe(false);
            });

            it("refuses a switch back to the registry for a package the allow-list doesn't allow, and keeps the pack", async () => {
                const bytes = pack("1.0.0", { name: "@unlisted/crm-plugin" });
                const created = await upload(bytes);
                const refused = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.body.uid}`)).send({
                    packageVersion: "1.0.0",
                });
                expect(refused.status).toBe(400);
                expect(refused.body.message).toMatch(/not an allowed plugin package/);
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(bytes))).toBe(true);
                expect((await ctx.rows())[0].source).toBe("upload");
            });

            it("deletes the pack when the plugin is removed, unless another row still names it", async () => {
                const bytes = pack();
                const created = await upload(bytes);
                await ctx.insertPlugin({
                    name: "@acme/twin-plugin",
                    packageVersion: "1.0.0",
                    enabled: false,
                    source: "upload",
                    uploadBlobKey: pluginUploadBlobKey(bytes),
                    manifest: CRM_MANIFEST,
                });
                expect((await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${created.body.uid}`))).status).toBe(
                    204,
                );
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(bytes))).toBe(true);

                const [twin] = (await ctx.rows()).filter((row) => row.name === "@acme/twin-plugin");
                expect((await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${twin.uid}`))).status).toBe(204);
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(bytes))).toBe(false);

                // A removed uploaded plugin comes back from the registry as a registry plugin.
                const easPack = pack("1.0.0", { name: "@rapidmx/activesync", manifest: EAS_MANIFEST });
                const easUp = await upload(easPack);
                expect((await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${easUp.body.uid}`))).status).toBe(204);
                const revived = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({
                    name: "@rapidmx/activesync",
                });
                expect(revived.status).toBe(200);
                expect(revived.body.plugin).toMatchObject({
                    uid: easUp.body.uid,
                    source: "registry",
                    integrity: "sha512-@rapidmx/activesync@1.0.0",
                });
                expect(revived.body.plugin.uploadFilename ?? null).toBeNull();
            });

            it("revives a removed plugin from an uploaded pack", async () => {
                const first = await upload(pack("1.0.0"));
                await asAdmin(request(ctx.app()).delete(`${ctx.baseUrl}/${first.body.uid}`));
                const again = await upload(pack("2.0.0"));
                expect(again.status).toBe(201);
                expect(again.body).toMatchObject({
                    uid: first.body.uid,
                    packageVersion: "2.0.0",
                    source: "upload",
                    enabled: true,
                });
                expect(await ctx.rows()).toHaveLength(1);
            });

            it("refuses a pack whose manifest requires a plugin that isn't installed and enabled in range", async () => {
                const needy = (range = "^1.0.0") =>
                    pack("1.0.0", { manifest: { ...CRM_MANIFEST, requires: { "@rapidmx/activesync": range } } });
                const missing = await upload(needy());
                expect(missing.status).toBe(409);
                expect(missing.body.message).not.toContain("already installed");
                expect(missing.body.message).toMatch(/requires @rapidmx\/activesync \^1\.0\.0, which isn't enabled/);
                expect(await ctx.rows()).toHaveLength(0);
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(needy()))).toBe(false);

                const eas = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({ name: "@rapidmx/activesync" });
                expect((await upload(needy("^2.0.0"))).status).toBe(409);
                expect((await upload(needy())).status).toBe(201);

                // A replacement that leaves an enabled dependent without what it requires is refused too.
                const easV2 = pack("2.0.0", { name: "@rapidmx/activesync", manifest: EAS_MANIFEST });
                const breaking = await upload(easV2, { query: "?replace=true" });
                expect(breaking.status).toBe(409);
                expect(breaking.body.message).toMatch(/but 2\.0\.0 is installed/);
                expect((await ctx.rows()).find((row) => row.name === "@rapidmx/activesync").packageVersion).toBe(
                    "1.0.0",
                );
                expect(eas.status).toBe(200);
            });

            it("refuses what isn't a valid pack with a 400, naming the problem, and stores nothing", async () => {
                const cases: [string, Buffer | string, RegExp][] = [
                    ["text", "this is not a pack", /not a gzip archive/],
                    ["empty tar", zlib.gzipSync(Buffer.alloc(0)), /truncated/],
                    ["no package.json", zlib.gzipSync(Buffer.alloc(1024)), /no package\/package\.json/],
                    [
                        "package.json that is not JSON",
                        gzipTar([{ name: "package/package.json", content: "{nope" }]),
                        /not valid JSON/,
                    ],
                    [
                        "package.json that is an array",
                        gzipTar([{ name: "package/package.json", content: "[]" }]),
                        /must be a JSON object/,
                    ],
                    [
                        "path traversal",
                        pack("1.0.0", { extra: [{ name: "package/../../evil.js", content: "x" }] }),
                        /unsafe name/,
                    ],
                    [
                        "absolute path",
                        pack("1.0.0", { extra: [{ name: "/etc/cron.d/evil", content: "x" }] }),
                        /unsafe name/,
                    ],
                    [
                        "outside package/",
                        pack("1.0.0", { extra: [{ name: "evil/index.js", content: "x" }] }),
                        /outside the package\/ directory/,
                    ],
                    [
                        "symlink",
                        pack("1.0.0", { extra: [{ name: "package/link", type: "2", linkname: "/etc/passwd" }] }),
                        /symbolic link/,
                    ],
                    [
                        "hard link",
                        pack("1.0.0", {
                            extra: [{ name: "package/link", type: "1", linkname: "package/package.json" }],
                        }),
                        /hard link/,
                    ],
                    ["device", pack("1.0.0", { extra: [{ name: "package/dev", type: "3" }] }), /device/],
                    ["invalid name", pack("1.0.0", { pkg: { name: "Not A Name" } }), /not a valid npm package name/],
                    ["missing name", pack("1.0.0", { pkg: { name: undefined } }), /not a valid npm package name/],
                    ["inexact version", pack("^1.0.0"), /not an exact version/],
                    ["v-prefixed version", pack("v1.0.0"), /not an exact version/],
                    ["not a plugin", pack("1.0.0", { pkg: { rapidmx: undefined } }), /not a RapidMX plugin/],
                    [
                        "unsupported API version",
                        pack("1.0.0", { manifest: { ...CRM_MANIFEST, apiVersion: PLUGIN_API_VERSION + 1 } }),
                        /plugin API version/,
                    ],
                    [
                        "protected setting key",
                        pack("1.0.0", {
                            manifest: {
                                ...CRM_MANIFEST,
                                settings: [{ key: "auth:secret", label: "x", type: "string" }],
                            },
                        }),
                        /server's own configuration/,
                    ],
                ];
                for (const [label, body, message] of cases) {
                    const result = await upload(body);
                    expect([label, result.status]).toEqual([label, 400]);
                    expect([label, result.body.message]).toEqual([label, expect.stringMatching(message)]);
                }
                expect(await ctx.rows()).toHaveLength(0);
                expect(publishedHashes).toEqual([]);
                expect((await ctx.auditActions()).filter((action) => action === AuditAction.PLUGIN_UPLOAD)).toEqual([]);
            });

            it("refuses an empty body and a malformed query", async () => {
                const empty = await upload(Buffer.alloc(0));
                expect(empty.status).toBe(400);
                expect(empty.body.message).toMatch(/body is empty/);
                expect((await upload(pack(), { query: "?replace=maybe" })).body.message).toMatch(
                    /'replace' must be true or false/,
                );
                expect((await upload(pack(), { query: "?filename=a&filename=b" })).body.message).toMatch(
                    /'filename' must be a single file name/,
                );
                expect(await ctx.rows()).toHaveLength(0);
            });

            it("refuses a gzip bomb", async () => {
                const bomb = zlib.gzipSync(Buffer.alloc(257 * 1024 * 1024), { level: 9 });
                expect(bomb.length).toBeLessThan(UPLOAD_TEST_MAX_BYTES);
                const result = await upload(bomb);
                expect(result.status).toBe(400);
                expect(result.body.message).toMatch(/unpacks to more than/);
                expect(await ctx.rows()).toHaveLength(0);
            });

            it("refuses a pack larger than system:plugins:uploads:max_bytes with a 413 before reading it", async () => {
                const result = await upload(Buffer.alloc(UPLOAD_TEST_MAX_BYTES + 1000, 1));
                expect(result.status).toBe(413);
                expect(result.body.message).toMatch(new RegExp(`larger than the ${UPLOAD_TEST_MAX_BYTES} bytes`));
                expect(await ctx.rows()).toHaveLength(0);
            });

            // The framework answers an unauthenticated, non-admin or rate limited request to a streaming route before it
            // has the body, and then closes the connection: the client sees the status or a reset, never a success.
            const refusal = async (call: PromiseLike<any>): Promise<number | "reset"> => {
                try {
                    return (await call).status;
                } catch (err: any) {
                    if (err?.code === "ECONNRESET") {
                        return "reset";
                    }
                    throw err;
                }
            };

            it("takes an elevated administrator only", async () => {
                const bytes = pack();
                expect([403, "reset"]).toContain(
                    await refusal(upload(bytes, { token: JWTUtils.createTokenSync(ctx.config.get("auth"), user) })),
                );
                const unelevated = await upload(bytes, { token: adminToken({ elevated: undefined }) });
                expect([unelevated.status, unelevated.body.code]).toEqual([403, "api-104"]);
                const stale = await upload(bytes, { token: adminToken({ elevated: Date.now() - 24 * 3600 * 1000 }) });
                expect([stale.status, stale.body.code]).toEqual([403, "api-104"]);
                expect([401, 403, "reset"]).toContain(
                    await refusal(
                        request(ctx.app())
                            .post(`${ctx.baseUrl}/upload`)
                            .set("Content-Type", "application/gzip")
                            .send(bytes),
                    ),
                );
                expect(await ctx.rows()).toHaveLength(0);
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(bytes))).toBe(false);
            });

            it("is rate limited per user", async () => {
                const token = adminToken();
                const statuses: (number | "reset")[] = [];
                for (let attempt = 0; attempt < 11; attempt++) {
                    statuses.push(await refusal(upload("not a pack", { token })));
                }
                expect(statuses.slice(0, 10)).toEqual(Array(10).fill(400));
                expect([429, "reset"]).toContain(statuses[10]);
                // Another administrator isn't affected.
                expect((await upload("not a pack")).status).toBe(400);
            });

            it("stores nothing when the row can't be written, but keeps a pack another row still names", async () => {
                const bytes = pack();
                vi.spyOn(BasePluginRoute.prototype as any, "audit").mockRejectedValueOnce(new Error("database down"));
                const failed = await upload(bytes);
                expect(failed.status).toBe(500);
                expect(await ctx.rows()).toHaveLength(0);
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(bytes))).toBe(false);

                expect((await upload(bytes)).status).toBe(201);
                vi.spyOn(BasePluginRoute.prototype as any, "audit").mockRejectedValueOnce(new Error("database down"));
                const replaceFailed = await upload(bytes, { query: "?replace=true" });
                expect(replaceFailed.status).toBe(500);
                const [row] = await ctx.rows();
                expect([row.packageVersion, row.source]).toEqual(["1.0.0", "upload"]);
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(bytes))).toBe(true);

                // A failed replacement by a different pack puts the old row back and takes the new pack out.
                const v2 = pack("2.0.0");
                vi.spyOn(BasePluginRoute.prototype as any, "audit").mockRejectedValueOnce(new Error("database down"));
                expect((await upload(v2, { query: "?replace=true" })).status).toBe(500);
                const [restored] = await ctx.rows();
                expect([restored.packageVersion, restored.integrity, restored.uploadBlobKey]).toEqual([
                    "1.0.0",
                    packIntegrity(bytes),
                    pluginUploadBlobKey(bytes),
                ]);
                expect(await ctx.blobStore().exists(pluginUploadBlobKey(v2))).toBe(false);
            });
        });

        describe("an uploaded plugin in the other routes", () => {
            it("is never checked against the registry, and isn't offered an update", async () => {
                publishFakePackage("@rapidmx/mapi-plugin", "9.0.0", { plugin: EAS_MANIFEST });
                const mapi = pack("1.0.0", { name: "@rapidmx/mapi-plugin", manifest: EAS_MANIFEST });
                const created = await upload(mapi);
                const crm = await upload(pack());
                registryReads.length = 0;

                const updates = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/updates`));
                expect(updates.status).toBe(200);
                expect(updates.body).toEqual([
                    {
                        uid: crm.body.uid,
                        name: CRM,
                        installedVersion: "1.0.0",
                        allowed: true,
                        updateAvailable: false,
                        source: "upload",
                    },
                    {
                        uid: created.body.uid,
                        name: "@rapidmx/mapi-plugin",
                        installedVersion: "1.0.0",
                        allowed: true,
                        updateAvailable: false,
                        source: "upload",
                    },
                ]);
                expect(registryReads).toEqual([]);

                const search = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/search?namespace=%40rapidmx`));
                expect(search.body).toEqual([
                    {
                        name: "@rapidmx/mapi-plugin",
                        version: "9.0.0",
                        allowed: true,
                        installedUid: created.body.uid,
                        installedVersion: "1.0.0",
                        installedSource: "upload",
                        updateAvailable: false,
                    },
                ]);
            });

            it("plans enabling as it is without the registry, and the allow-list for a switch back", async () => {
                const created = await upload(pack("1.0.0", { name: "@unlisted/crm-plugin" }));
                registryReads.length = 0;
                const plan = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/plan?name=%40unlisted%2Fcrm-plugin`));
                expect(plan.status).toBe(200);
                expect(plan.body.plugin).toMatchObject({ name: "@unlisted/crm-plugin", version: "1.0.0" });
                expect(registryReads).toEqual([]);
                const other = await asAdmin(
                    request(ctx.app()).get(`${ctx.baseUrl}/plan?name=%40unlisted%2Fcrm-plugin&packageVersion=2.0.0`),
                );
                expect(other.status).toBe(400);

                // Disabling and enabling it again isn't held to the allow-list either.
                const off = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.body.uid}`)).send({
                    enabled: false,
                });
                expect(off.status).toBe(200);
                const on = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.body.uid}`)).send({
                    enabled: true,
                });
                expect(on.status).toBe(200);
                expect(on.body.source).toBe("upload");
            });

            it("can't have its source or upload fields set by a client", async () => {
                const created = await upload(pack());
                const put = await asAdmin(request(ctx.app()).put(`${ctx.baseUrl}/${created.body.uid}`)).send({
                    source: "registry",
                    uploadBlobKey: "attachments/steal-me",
                    uploadFilename: "x.tgz",
                    uploadedAt: "2020-01-01T00:00:00.000Z",
                    uploadedByUserUid: "someone-else",
                    enabled: false,
                });
                expect(put.status).toBe(200);
                const [row] = await ctx.rows();
                expect([row.source, row.uploadBlobKey, row.uploadFilename, row.uploadedByUserUid, row.enabled]).toEqual(
                    [
                        "upload",
                        pluginUploadBlobKey(pack()),
                        "acme-crm-plugin-1.0.0.tgz",
                        created.body.uploadedByUserUid,
                        false,
                    ],
                );

                const added = await asAdmin(request(ctx.app()).post(ctx.baseUrl)).send({
                    name: "@rapidmx/activesync",
                    source: "upload",
                    uploadBlobKey: "plugins/uploads/x.tgz",
                    uploadFilename: "x.tgz",
                });
                expect(added.status).toBe(200);
                const eas = (await ctx.rows()).find((r) => r.name === "@rapidmx/activesync");
                expect(eas.source ?? null).toBeNull();
                expect(eas.uploadBlobKey ?? null).toBeNull();
                expect(added.body.plugin).not.toHaveProperty("uploadBlobKey");
            });

            it("reports whether uploads are on, and their size limit, in GET /status", async () => {
                const status = await asAdmin(request(ctx.app()).get(`${ctx.baseUrl}/status`));
                expect(status.body.uploads).toEqual({ enabled: true, maxBytes: UPLOAD_TEST_MAX_BYTES });
            });
        });
    });
}
