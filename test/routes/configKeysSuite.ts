///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// HTTP behaviour of `system/config-keys` (spec 10.5), identical on both backends: the console's view of the keyring (never key material), starting a
// rotation (202; one at a time, 409 with the progress; `compromised` upgrading a running normal one), and "Activate anyway" (409 unless the rotation is
// `activating` and the kid is its key; audited with the copies that hadn't loaded the key). Writes need a trusted role AND elevation.
import { request } from "@rapidrest/service-core/test";
import { JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import type { LocalConfigKeyChannel } from "../../src/secrets/ConfigKeyChannel.js";
import { CONFIG_KEY_STATE_UID } from "../../src/secrets/ConfigKeyring.js";
import { TEST_CONFIG_KEYRING } from "../config-defaults.js";

export interface ConfigKeysSuiteContext {
    config: any;
    app: () => any;
    prefix: string;
    /** The channel the route talks to its server copies through (registered as `ConfigKeyChannel`). */
    channel: () => LocalConfigKeyChannel;
    /** Saves the key state row with these fields, replacing what was there. */
    saveState: (fields: Record<string, unknown>) => Promise<void>;
    /** The key state row as the database holds it (`undefined`/`null` when there is none). */
    state: () => Promise<any>;
    clearState: () => Promise<void>;
    auditEntries: (action: AuditAction) => Promise<any[]>;
    clearAudit: () => Promise<void>;
}

const TEST_KID: string = TEST_CONFIG_KEYRING.keys[0].kid;
const NEW_KID = "n3wk3y02";
const MINUTE = 60_000;

export function configKeysSuite(ctx: ConfigKeysSuiteContext): void {
    let adminUid: string;
    let userToken: string;
    let adminToken: string;
    let unelevatedToken: string;
    beforeAll(() => {
        adminUid = uuid.v4();
        userToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: uuid.v4(), roles: [], elevated: Date.now() });
        adminToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: adminUid, roles: ["admin"], elevated: Date.now() });
        unelevatedToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: uuid.v4(), roles: ["admin"] });
    });

    beforeEach(async () => {
        await ctx.clearState();
        await ctx.clearAudit();
        ctx.channel().reset();
    });

    const path = (suffix = "") => `${ctx.prefix}/config-keys${suffix}`;
    const as = (token: string, req: any) => req.set("Authorization", "jwt " + token);
    const get = (token = adminToken) => as(token, request(ctx.app()).get(path()));
    const post = (suffix: string, body: unknown, token = adminToken) => as(token, request(ctx.app()).post(path(suffix))).send(body as any);

    const requested = (extra: Record<string, unknown> = {}, phase = "adding"): Record<string, unknown> => ({
        previousKids: [],
        compromised: false,
        requestedBy: "admin-0",
        requestedAt: new Date(Date.now() - MINUTE),
        phase,
        ...extra,
    });
    const activating = async (extra: Record<string, unknown> = {}): Promise<void> => {
        await ctx.saveState({
            uid: CONFIG_KEY_STATE_UID,
            rotation: requested({ kid: NEW_KID, previousKids: [TEST_KID], activationStartedAt: new Date(), ...extra }, "activating"),
        });
    };
    const beat = (copy: string, loaded: string[], encrypting: string | undefined = loaded[0]) =>
        ctx.channel().putHeartbeat({ copy, kids: loaded, encrypting, at: new Date().toISOString() }, 90_000);

    describe("GET /", () => {
        it("answers a trusted role with the ring's keys and no rotation, and writes nothing", async () => {
            const result = await get();
            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body).toEqual({
                available: true,
                activeKid: TEST_KID,
                keys: [{ kid: TEST_KID, createdAt: TEST_CONFIG_KEYRING.keys[0].createdAt, active: true }],
                countedAt: null,
                rotation: null,
                reencryption: null,
                pluginSecrets: null,
            });
            expect(await ctx.state()).toBeFalsy();
        });

        it("never answers with key material", async () => {
            const result = await get();
            expect(JSON.stringify(result.body)).not.toContain(TEST_CONFIG_KEYRING.keys[0].key);
        });

        it("refuses a caller without a trusted role", async () => {
            expect((await get(userToken)).status).toBe(403);
            expect([401, 403]).toContain((await request(ctx.app()).get(path())).status);
        });

        it("shows the envelope counts of the last pass, the re-encryption's progress and the plugin secrets' state", async () => {
            await ctx.saveState({
                uid: CONFIG_KEY_STATE_UID,
                kidUsage: { [TEST_KID]: 3 },
                countedAt: new Date("2026-10-28T10:00:00.000Z"),
                reencryption: {
                    targetKid: TEST_KID,
                    complete: true,
                    startedAt: new Date("2026-10-28T09:59:00.000Z"),
                    unreadable: [{ record: "Plugin", uid: "p1", field: "settings.token", kid: "dead0001" }],
                },
                pluginSecrets: { encryptedAt: new Date("2026-10-28T08:00:00.000Z") },
            });
            const body = (await get()).body;
            expect(body.keys[0].envelopes).toBe(3);
            expect(body.countedAt).toBe("2026-10-28T10:00:00.000Z");
            expect(body.reencryption.complete).toBe(true);
            expect(body.reencryption.unreadable).toEqual([{ record: "Plugin", uid: "p1", field: "settings.token", kid: "dead0001" }]);
            expect(body.pluginSecrets.encryptedAt).toBe("2026-10-28T08:00:00.000Z");
        });

        it("shows a rotation with the copies it waits for, and a warning once that has taken too long", async () => {
            await activating({ waitingFor: ["pod-b:2"], activationStartedAt: new Date(Date.now() - 20 * MINUTE) });
            const body = (await get()).body;
            expect(body.rotation.phase).toBe("activating");
            expect(body.rotation.kid).toBe(NEW_KID);
            expect(body.rotation.waitingFor).toEqual(["pod-b:2"]);
            expect(body.rotation.warning).toContain("pod-b:2");
            expect(body.rotation.warning).toContain("restarting");
        });

        it("shows no warning before that time, or when no copy is missing the key", async () => {
            await activating({ waitingFor: ["pod-b:2"], activationStartedAt: new Date(Date.now() - 2 * MINUTE) });
            expect((await get()).body.rotation.warning).toBeUndefined();
            await activating({ waitingFor: [], activationStartedAt: new Date(Date.now() - 20 * MINUTE) });
            expect((await get()).body.rotation.warning).toBeUndefined();
        });

        it("shows that a key was activated anyway", async () => {
            await ctx.saveState({
                uid: CONFIG_KEY_STATE_UID,
                activeKid: NEW_KID,
                rotation: requested(
                    { kid: NEW_KID, activationForced: { by: "admin-0", at: new Date(), staleCopies: ["pod-b:2"] }, waitingFor: ["pod-b:2"] },
                    "reencrypting",
                ),
            });
            expect((await get()).body.rotation.activationForced.staleCopies).toEqual(["pod-b:2"]);
        });
    });

    describe("POST /rotate", () => {
        it("refuses a caller without a trusted role or without elevation (403), and records nothing", async () => {
            expect((await post("/rotate", {}, userToken)).status).toBe(403);
            expect((await post("/rotate", {}, unelevatedToken)).status).toBe(403);
            expect(await ctx.state()).toBeFalsy();
            expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATION_REQUESTED)).toEqual([]);
        });

        it("starts a rotation: records the request, audits it with who asked and tells every copy", async () => {
            const noticed = vi.fn();
            await ctx.channel().onChanged(noticed);

            const result = await post("/rotate", {});

            expect(result.status, JSON.stringify(result.body)).toBe(202);
            expect(result.body.rotation).toMatchObject({ phase: "adding", compromised: false, requestedBy: adminUid, previousKids: [] });
            const row = await ctx.state();
            expect(row.uid).toBe(CONFIG_KEY_STATE_UID);
            expect(row.rotation.phase).toBe("adding");
            expect(row.rotation.requestedBy).toBe(adminUid);
            const audits = await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATION_REQUESTED);
            expect(audits).toHaveLength(1);
            expect(audits[0].details).toEqual({ compromised: false });
            expect(audits[0].actorUserUid).toBe(adminUid);
            expect(noticed).toHaveBeenCalled();
        });

        it("takes no body at all, as a routine rotation", async () => {
            const result = await as(adminToken, request(ctx.app()).post(path("/rotate")));
            expect(result.status, JSON.stringify(result.body)).toBe(202);
            expect(result.body.rotation.compromised).toBe(false);
        });

        it("records a suspected compromise", async () => {
            const result = await post("/rotate", { compromised: true });
            expect(result.status).toBe(202);
            expect(result.body.rotation.compromised).toBe(true);
            expect((await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATION_REQUESTED))[0].details).toEqual({ compromised: true });
        });

        it("refuses a request that isn't a plain object with a true-or-false compromised (400)", async () => {
            expect((await post("/rotate", { compromised: "yes" })).status).toBe(400);
            expect((await post("/rotate", [])).status).toBe(400);
            expect((await post("/rotate", { "a.b": 1 })).status).toBe(400);
            expect(await ctx.state()).toBeFalsy();
        });

        it("answers 409 with the progress while a rotation is running, and changes nothing", async () => {
            expect((await post("/rotate", {})).status).toBe(202);
            const before = await ctx.state();
            const again = await post("/rotate", {});
            expect(again.status).toBe(409);
            expect(again.body.rotation.phase).toBe("adding");
            expect((await ctx.state()).version).toBe(before.version);
            expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATION_REQUESTED)).toHaveLength(1);
        });

        it("marks a running normal rotation compromised instead (200), audited, and refuses it again once it is", async () => {
            await post("/rotate", {});
            const upgraded = await post("/rotate", { compromised: true });
            expect(upgraded.status, JSON.stringify(upgraded.body)).toBe(200);
            expect(upgraded.body.rotation.compromised).toBe(true);
            expect(upgraded.body.rotation.phase).toBe("adding");
            expect((await ctx.state()).rotation.compromised).toBe(true);
            const audits = await ctx.auditEntries(AuditAction.CONFIG_KEY_ROTATION_REQUESTED);
            expect(audits).toHaveLength(2);
            expect(audits.map((entry) => entry.details.compromised).sort()).toEqual([false, true]);
            expect((await post("/rotate", { compromised: true })).status).toBe(409);
        });

        it("starts a new rotation once the last one is done or has failed", async () => {
            for (const phase of ["done", "failed"]) {
                await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, rotation: requested({ kid: NEW_KID, lastError: "old error", finishedAt: new Date() }, phase) });
                const result = await post("/rotate", {});
                expect(result.status, JSON.stringify(result.body)).toBe(202);
                expect(result.body.rotation.phase).toBe("adding");
                expect(result.body.rotation.kid).toBeUndefined();
                expect(result.body.rotation.lastError).toBeUndefined();
            }
        });
    });

    describe("POST /activate", () => {
        it("refuses a caller without a trusted role or without elevation (403), and changes nothing", async () => {
            await activating();
            expect((await post("/activate", { kid: NEW_KID }, userToken)).status).toBe(403);
            expect((await post("/activate", { kid: NEW_KID }, unelevatedToken)).status).toBe(403);
            expect((await ctx.state()).activeKid).toBeFalsy();
            expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_ACTIVATION_FORCED)).toEqual([]);
        });

        it("refuses a body without the kid (400)", async () => {
            await activating();
            expect((await post("/activate", {})).status).toBe(400);
            expect((await post("/activate", { kid: 7 })).status).toBe(400);
            expect((await post("/activate", { kid: "" })).status).toBe(400);
            expect((await post("/activate", [])).status).toBe(400);
        });

        it("answers 409 with the progress when no rotation exists, is activating, or is for another key", async () => {
            expect((await post("/activate", { kid: NEW_KID })).status).toBe(409);
            await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, rotation: requested({ kid: NEW_KID }, "adding") });
            expect((await post("/activate", { kid: NEW_KID })).status).toBe(409);
            await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: NEW_KID, rotation: requested({ kid: NEW_KID }, "reencrypting") });
            expect((await post("/activate", { kid: NEW_KID })).status).toBe(409);
            await activating();
            const other = await post("/activate", { kid: "0th3r000" });
            expect(other.status).toBe(409);
            expect(other.body.rotation.phase).toBe("activating");
            expect((await ctx.state()).activeKid).toBeFalsy();
            expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_ACTIVATION_FORCED)).toEqual([]);
        });

        it("activates the key at once, records who forced it and which copies hadn't loaded it, audits and tells every copy", async () => {
            await activating({ waitingFor: ["pod-b:2"] });
            await beat("pod-a:1", [TEST_KID, NEW_KID], TEST_KID);
            await beat("pod-b:2", [TEST_KID], TEST_KID);
            const noticed = vi.fn();
            await ctx.channel().onChanged(noticed);

            const result = await post("/activate", { kid: NEW_KID });

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            const row = await ctx.state();
            expect(row.activeKid).toBe(NEW_KID);
            expect(row.rotation.phase).toBe("reencrypting");
            expect(row.rotation.activationForced.by).toBe(adminUid);
            expect(row.rotation.activationForced.staleCopies).toEqual(["pod-b:2"]);
            expect(new Date(row.rotation.activatedAt).getTime()).toBeGreaterThan(0);
            // Both copies still encrypt with the old key, so re-encryption waits for them.
            expect(row.rotation.waitingFor.sort()).toEqual(["pod-a:1", "pod-b:2"]);
            expect(result.body.rotation.phase).toBe("reencrypting");
            const audits = await ctx.auditEntries(AuditAction.CONFIG_KEY_ACTIVATION_FORCED);
            expect(audits).toHaveLength(1);
            expect(audits[0].details).toEqual({ kid: NEW_KID, staleCopies: ["pod-b:2"] });
            expect(audits[0].actorUserUid).toBe(adminUid);
            expect(noticed).toHaveBeenCalled();
            expect(await ctx.auditEntries(AuditAction.CONFIG_KEY_ACTIVATED)).toEqual([]);
        });

        it("records no stale copy when every one has the key, and still activates", async () => {
            await activating();
            await beat("pod-a:1", [TEST_KID, NEW_KID], NEW_KID);
            const result = await post("/activate", { kid: NEW_KID });
            expect(result.status).toBe(200);
            expect((await ctx.state()).rotation.activationForced.staleCopies).toEqual([]);
        });

        it("activates even when the heartbeats can't be read, recording no stale copy", async () => {
            await activating();
            vi.spyOn(ctx.channel(), "heartbeats").mockRejectedValueOnce(new Error("redis down"));
            const result = await post("/activate", { kid: NEW_KID });
            expect(result.status).toBe(200);
            expect((await ctx.state()).rotation.activationForced.staleCopies).toEqual([]);
        });
    });
}
