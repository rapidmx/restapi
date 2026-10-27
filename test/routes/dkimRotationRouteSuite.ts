///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// HTTP behaviour of DKIM rotation on `mail/domains`, identical on both backends: `dkimManaged` on create, update and backfill; `GET /:id/dkim/rotation`;
// "Rotate now" (`POST /:id/dkim/rotate`, also for a compromised key); `POST /:id/dkim/rotation/cancel`; and pausing scheduled rotation
// (`PUT /:id/dkim/rotation`). The server registers the real `FsDkimKeyProvider` over a temporary directory, so the keys are real files.
import * as fs from "fs/promises";
import * as path from "path";
import { ApiErrors } from "@rapidrest/service-core";
import { request } from "@rapidrest/service-core/test";
import { ApiError, JWTUtils } from "@rapidrest/core";
import * as uuid from "uuid";
import { AuditAction } from "../../src/models/types.js";
import { rotationDate } from "../../src/util/DkimRotationUtils.js";
import type { FsDkimKeyProvider } from "../../src/dkim/FsDkimKeyProvider.js";
import type { InMemoryDnsPublisher, StaticDnsResolver } from "../testDoubles.js";

export interface DkimRotationRouteSuiteContext {
    config: any;
    app: () => any;
    /** The domain route's base path, e.g. `/mongo/domains`. */
    baseUrl: string;
    keyDir: () => string;
    provider: () => FsDkimKeyProvider;
    /** The server's own domain route instance, for the configuration it read at start-up. */
    route: () => any;
    publisher: () => InMemoryDnsPublisher;
    resolver: () => StaticDnsResolver;
    clear: () => Promise<void>;
    saveDomain: (fields: Record<string, unknown>) => Promise<void>;
    domainRow: (uid: string) => Promise<any>;
    auditEntries: () => Promise<{ action: string; targetUid: string; details?: any }[]>;
}

export function dkimRotationRouteSuite(ctx: DkimRotationRouteSuiteContext): void {
    let userToken: string;
    let adminToken: string;
    let unelevatedToken: string;

    const today = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const as = (token: string, req: any) => req.set("Authorization", "jwt " + token);
    const url = (suffix: string) => `${ctx.baseUrl}${suffix}`;
    const audit = async (action: string) => (await ctx.auditEntries()).filter((entry) => entry.action === action);
    const rotate = (uid: string, body: unknown = {}, token = adminToken) => as(token, request(ctx.app()).post(url(`/${uid}/dkim/rotate`))).send(body as any);
    const cancel = (uid: string, token = adminToken) => as(token, request(ctx.app()).post(url(`/${uid}/dkim/rotation/cancel`))).send({});
    const pause = (uid: string, body: unknown, token = adminToken) => as(token, request(ctx.app()).put(url(`/${uid}/dkim/rotation`))).send(body as any);
    const view = (uid: string, token = adminToken) => as(token, request(ctx.app()).get(url(`/${uid}/dkim/rotation`)));

    /** A domain created through the API, so its key is the provider's (`dkimManaged: true`). */
    const createDomain = async (name: string): Promise<any> => {
        const result = await as(adminToken, request(ctx.app()).post(url(""))).send({ name });
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        return result.body;
    };

    /** A verified domain signed with the provider's `mail` key, with any other `fields`. */
    const verifiedDomain = async (name: string, fields: Record<string, unknown> = {}): Promise<any> => {
        const { publicKey } = await ctx.provider().ensureKeyPair(name);
        await ctx.saveDomain({ name, dkimSelector: "mail", dkimPublicKey: publicKey, dkimManaged: true, ...fields });
        return await ctx.domainRow(name);
    };

    /** A verified domain whose rotation from `mail` to `rmx1` has switched (`phase`), with both keys on disk and `rmx1` the one signed with. */
    const switchedDomain = async (name: string, phase: "switching" | "overlap", rotation: Record<string, unknown> = {}): Promise<{ oldKey: string; newKey: string }> => {
        const { publicKey: oldKey } = await ctx.provider().ensureKeyPair(name);
        const { publicKey: newKey } = await ctx.provider().generateKeyPair(name, "rmx1");
        await ctx.provider().activate(name, "rmx1");
        await ctx.saveDomain({
            name,
            dkimSelector: "rmx1",
            dkimPublicKey: newKey,
            dkimManaged: true,
            dkimRotation: { phase, previous: { selector: "mail", publicKey: oldKey }, reason: "scheduled", switchedAt: new Date(), ...rotation },
        });
        return { oldKey, newKey };
    };

    beforeAll(() => {
        userToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: uuid.v4(), roles: [], elevated: Date.now() });
        adminToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() });
        unelevatedToken = JWTUtils.createTokenSync(ctx.config.get("auth"), { uid: uuid.v4(), roles: ["admin"] });
    });

    beforeEach(async () => {
        await ctx.clear();
        ctx.publisher().reset();
        ctx.resolver().records.clear();
        (ctx.provider() as any).supportsRotation = true;
        ctx.route().transportProvider = "postfix";
        ctx.route().dkimRotationEnabled = true;
        ctx.route().dkimRotationIntervalDays = 180;
    });

    describe("dkimManaged", () => {
        it("is true for a key the provider made and false for one the caller imported", async () => {
            const made = await createDomain("made.example.com");
            expect(made.dkimManaged).toBe(true);

            const imported = await as(adminToken, request(ctx.app()).post(url("")))
                .send({ name: "imported.example.com", dkimSelector: "s1", dkimPublicKey: "HANDMADE", dkimManaged: true });
            expect(imported.status).toBe(200);
            expect(imported.body.dkimManaged).toBe(false);
        });

        it("becomes false when an update imports another key, and is left alone by a round-trip or a client sending it", async () => {
            const domain = await createDomain("update.example.com");

            const roundTrip = await as(adminToken, request(ctx.app()).put(url(`/${domain.uid}`))).send({ ...domain, dkimManaged: false });
            expect(roundTrip.status, JSON.stringify(roundTrip.body)).toBe(200);
            expect(roundTrip.body.dkimManaged).toBe(true);

            const imported = await as(adminToken, request(ctx.app()).put(url(`/${domain.uid}`)))
                .send({ uid: domain.uid, version: roundTrip.body.version, dkimSelector: "s2", dkimPublicKey: "HANDMADE" });
            expect(imported.status).toBe(200);
            expect(imported.body.dkimManaged).toBe(false);

            const property = await as(adminToken, request(ctx.app()).put(url(`/${domain.uid}/dkimManaged`))).send({ value: true });
            expect(property.status).toBe(403);
        });

        it("is set when dns-setup backfills a key", async () => {
            await ctx.saveDomain({ name: "backfill.example.com" });

            const result = await as(adminToken, request(ctx.app()).get(url("/backfill.example.com/dns-setup")));

            expect(result.status).toBe(200);
            expect((await ctx.domainRow("backfill.example.com")).dkimManaged).toBe(true);
        });

        it("refuses another key while a rotation is in progress", async () => {
            const domain = await createDomain("busy.example.com");
            const started = await rotate(domain.uid);
            expect(started.status).toBe(200);

            const result = await as(adminToken, request(ctx.app()).put(url(`/${domain.uid}`)))
                .send({ uid: domain.uid, version: started.body.version, dkimPublicKey: "HANDMADE" });

            expect(result.status).toBe(409);
            expect(result.body.message).toMatch(/rotation/);
        });
    });

    describe("POST /:id/dkim/rotate", () => {
        it("starts a rotation now: a new selector and key, published next to the active one, signing unchanged", async () => {
            const domain = await createDomain("rotate.example.com");

            const result = await rotate(domain.uid);

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            const next = result.body.dkimRotation.next;
            expect(result.body.dkimRotation.phase).toBe("pending");
            expect(next.selector).toBe(`rmx${today()}`);
            expect(next.reason).toBe("manual");
            expect(result.body.dkimSelector).toBe("mail");
            expect(result.body.dkimPublicKey).toBe(domain.dkimPublicKey);
            const found = await ctx.provider().findKeyPair("rotate.example.com", next.selector);
            expect(next.publicKey).toBe(found!.publicKey);
            await expect(fs.access(path.join(ctx.keyDir(), "rotate.example.com.selector"))).rejects.toThrow();

            const [entry] = await audit(AuditAction.DKIM_ROTATION_STARTED);
            expect(entry.targetUid).toBe(domain.uid);
            expect(entry.details).toEqual({ name: "rotate.example.com", selector: next.selector, reason: "manual" });
            expect(ctx.publisher().changes).toContainEqual({ scope: "domain", domainUid: domain.uid });

            const checks = (await as(adminToken, request(ctx.app()).get(url(`/${domain.uid}/dns-setup`)))).body;
            expect(checks.find((check: any) => check.type === "dkim_next")).toEqual(
                expect.objectContaining({ recordName: `${next.selector}._domainkey.rotate.example.com`, configured: true }),
            );
        });

        it("marks a compromised key, and turns a pending rotation into a compromised one", async () => {
            const domain = await createDomain("compromised.example.com");
            const compromised = await rotate(domain.uid, { compromised: true });
            expect(compromised.status).toBe(200);
            expect(compromised.body.dkimRotation.next.reason).toBe("compromised");

            const other = await createDomain("escalate.example.com");
            const manual = await rotate(other.uid);
            const escalated = await rotate(other.uid, { compromised: true });
            expect(escalated.status, JSON.stringify(escalated.body)).toBe(200);
            expect(escalated.body.dkimRotation.next.reason).toBe("compromised");
            expect(escalated.body.dkimRotation.next.selector).toBe(manual.body.dkimRotation.next.selector);
            const entries = (await audit(AuditAction.DKIM_ROTATION_STARTED)).filter((entry) => entry.targetUid === other.uid);
            expect(entries.map((entry) => entry.details.reason).sort()).toEqual(["compromised", "manual"]);
        });

        it("refuses a second rotation while one is in progress, or after it switched", async () => {
            const domain = await createDomain("twice.example.com");
            await rotate(domain.uid);

            const again = await rotate(domain.uid);
            expect(again.status).toBe(409);
            const escalatedAgain = await rotate(domain.uid, { compromised: true });
            expect(escalatedAgain.status).toBe(200);
            expect((await rotate(domain.uid, { compromised: true })).status).toBe(409);

            await switchedDomain("switched.example.com", "switching");
            expect((await rotate("switched.example.com")).status).toBe(409);
            await switchedDomain("overlapping.example.com", "overlap", { previous: { selector: "mail", publicKey: "OLD", retireAt: new Date(Date.now() + 86_400_000) } });
            expect((await rotate("overlapping.example.com")).status).toBe(409);
        });

        it("marks a switched rotation compromised, so the old key is retired as soon as the MTA confirms the switch", async () => {
            await switchedDomain("switching-leak.example.com", "switching");

            const result = await rotate("switching-leak.example.com", { compromised: true });

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body.dkimRotation.phase).toBe("switching");
            expect(result.body.dkimRotation.reason).toBe("compromised");
            expect(result.body.dkimRotation.previous.selector).toBe("mail");
            const [entry] = await audit(AuditAction.DKIM_ROTATION_STARTED);
            expect(entry.details).toEqual({ name: "switching-leak.example.com", selector: "rmx1", reason: "compromised" });
            // Reported once; again is a 409.
            expect((await rotate("switching-leak.example.com", { compromised: true })).status).toBe(409);
        });

        it("retires the old key at once when it is reported compromised during the overlap", async () => {
            const { newKey } = await switchedDomain("overlap-leak.example.com", "overlap", {
                previous: { selector: "mail", publicKey: "OLD", retireAt: new Date(Date.now() + 6 * 86_400_000) },
            });
            ctx.publisher().reset();

            const result = await rotate("overlap-leak.example.com", { compromised: true });

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body.dkimRotation.phase).toBe("idle");
            expect(result.body.dkimRotation.previous).toBeUndefined();
            expect(rotationDate(result.body.dkimRotation.lastRotatedAt)!.getTime()).toBeGreaterThan(Date.now() - 60_000);
            expect(result.body.dkimSelector).toBe("rmx1");
            expect(result.body.dkimPublicKey).toBe(newKey);
            expect(await ctx.provider().findKeyPair("overlap-leak.example.com", "mail")).toBeUndefined();
            expect(await ctx.provider().findKeyPair("overlap-leak.example.com", "rmx1")).toBeDefined();
            expect((await audit(AuditAction.DKIM_ROTATION_STARTED)).map((entry) => entry.details)).toEqual([
                { name: "overlap-leak.example.com", selector: "rmx1", reason: "compromised" },
            ]);
            expect((await audit(AuditAction.DKIM_ROTATION_RETIRED)).map((entry) => entry.details)).toEqual([{ name: "overlap-leak.example.com", selector: "mail" }]);
            expect(ctx.publisher().changes).toContainEqual({ scope: "domain", domainUid: "overlap-leak.example.com" });
            const checks = (await as(adminToken, request(ctx.app()).get(url("/overlap-leak.example.com/dns-setup")))).body;
            expect(checks.find((check: any) => check.type === "dkim_previous")).toBeUndefined();
        });

        it("never mints again a selector cancelled earlier the same day", async () => {
            const domain = await createDomain("remint.example.com");
            const first = await rotate(domain.uid);
            await cancel(domain.uid);

            const second = await rotate(domain.uid);

            expect(second.status, JSON.stringify(second.body)).toBe(200);
            expect(first.body.dkimRotation.next.selector).toBe(`rmx${today()}`);
            expect(second.body.dkimRotation.next.selector).toBe(`rmx${today()}b`);
            expect(second.body.dkimRotation.next.publicKey).not.toBe(first.body.dkimRotation.next.publicKey);
        });

        it("refuses a key imported by hand, a domain without a key, a provider that doesn't rotate and SES", async () => {
            await ctx.saveDomain({ name: "imported.example.com", dkimSelector: "s1", dkimPublicKey: "HANDMADE", dkimManaged: false });
            expect((await rotate("imported.example.com")).body.message).toMatch(/imported/);
            // A row from before rotation whose key the provider doesn't hold is imported too; nothing is written for the refusal.
            await ctx.saveDomain({ name: "legacy.example.com", dkimSelector: "mail", dkimPublicKey: "HANDMADE" });
            const legacy = await rotate("legacy.example.com");
            expect(legacy.status).toBe(409);
            expect((await ctx.domainRow("legacy.example.com")).dkimManaged ?? undefined).toBeUndefined();

            await ctx.saveDomain({ name: "keyless.example.com" });
            const keyless = await rotate("keyless.example.com");
            expect(keyless.status).toBe(409);
            expect(keyless.body.message).toMatch(/no DKIM key/);

            const domain = await createDomain("blocked.example.com");
            ctx.route().transportProvider = "ses";
            const ses = await rotate(domain.uid);
            expect(ses.status).toBe(409);
            expect(ses.body.message).toMatch(/SES/);
            ctx.route().transportProvider = "postfix";
            (ctx.provider() as any).supportsRotation = false;
            const unsupported = await rotate(domain.uid);
            expect(unsupported.status).toBe(409);
            expect(unsupported.body.message).toMatch(/doesn't rotate/);

            expect(await audit(AuditAction.DKIM_ROTATION_STARTED)).toHaveLength(0);
        });

        it("rotates a row from before rotation whose key the provider holds, recording it as managed", async () => {
            const { publicKey } = await ctx.provider().ensureKeyPair("legacy-held.example.com");
            await ctx.saveDomain({ name: "legacy-held.example.com", dkimSelector: "mail", dkimPublicKey: publicKey });

            const result = await rotate("legacy-held.example.com");

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body.dkimManaged).toBe(true);
            expect(result.body.dkimRotation.phase).toBe("pending");
        });

        it("answers the pending rotation with the error when the key can't be generated, for the job to retry", async () => {
            const domain = await createDomain("nokey.example.com");
            const spy = vi.spyOn(ctx.provider(), "generateKeyPair").mockRejectedValueOnce(new Error("disk full"));

            const result = await rotate(domain.uid);

            expect(result.status).toBe(200);
            expect(result.body.dkimRotation.phase).toBe("pending");
            expect(result.body.dkimRotation.next.publicKey).toBe("");
            expect(result.body.dkimRotation.lastError).toMatch(/disk full/);
            spy.mockRestore();
        });

        it("needs a trusted role, an elevated token, a known domain and a boolean compromised", async () => {
            const domain = await createDomain("guard.example.com");
            expect((await rotate(domain.uid, {}, userToken)).status).toBe(403);
            expect((await rotate(domain.uid, {}, unelevatedToken)).status).toBe(403);
            expect((await rotate("missing.example.com")).status).toBe(404);
            expect((await rotate(domain.uid, { compromised: "yes" })).status).toBe(400);
            expect((await rotate(domain.uid, [])).status).toBe(200);
        });
    });

    describe("POST /:id/dkim/rotation/cancel", () => {
        it("abandons a rotation that hasn't switched: the new key and its record go, the schedule restarts from now", async () => {
            const domain = await createDomain("cancel.example.com");
            const started = await rotate(domain.uid);
            const selector: string = started.body.dkimRotation.next.selector;
            ctx.publisher().reset();

            const result = await cancel(domain.uid);

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body.dkimRotation.phase).toBe("idle");
            expect(result.body.dkimRotation.next).toBeUndefined();
            expect(rotationDate(result.body.dkimRotation.lastCancelledAt)!.getTime()).toBeGreaterThan(Date.now() - 60_000);
            expect(await ctx.provider().findKeyPair("cancel.example.com", selector)).toBeUndefined();
            expect(await ctx.provider().findKeyPair("cancel.example.com", "mail")).toBeDefined();
            const [entry] = await audit(AuditAction.DKIM_ROTATION_CANCELLED);
            expect(entry.details).toEqual({ name: "cancel.example.com", selector });
            expect(ctx.publisher().changes).toContainEqual({ scope: "domain", domainUid: domain.uid });
            const checks = (await as(adminToken, request(ctx.app()).get(url(`/${domain.uid}/dns-setup`)))).body;
            expect(checks.find((check: any) => check.type === "dkim_next")).toBeUndefined();
        });

        it("still cancels when the new key can't be deleted, logging it", async () => {
            const domain = await createDomain("cancel-stuck.example.com");
            await rotate(domain.uid);
            const spy = vi.spyOn(ctx.provider(), "deleteKeyPair").mockRejectedValueOnce(new Error("EBUSY"));
            const warn = vi.spyOn(ctx.route().logger, "warn");

            const result = await cancel(domain.uid);

            expect(result.status).toBe(200);
            expect(result.body.dkimRotation.phase).toBe("idle");
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("EBUSY"));
            spy.mockRestore();
            warn.mockRestore();
        });

        it("changes nothing without a rotation, and refuses one whose switch the MTA has confirmed", async () => {
            const domain = await createDomain("idle.example.com");
            const idle = await cancel(domain.uid);
            expect(idle.status).toBe(200);
            expect(idle.body.version).toBe(domain.version);

            await switchedDomain("overlap.example.com", "overlap");
            const switched = await cancel("overlap.example.com");
            expect(switched.status).toBe(409);
            expect(await audit(AuditAction.DKIM_ROTATION_CANCELLED)).toHaveLength(0);
        });

        it("reverts a switch the MTA hasn't confirmed: signing goes back to the old key and the new one is deleted", async () => {
            const { oldKey } = await switchedDomain("unconfirmed.example.com", "switching", { lastError: "The mail server hasn't confirmed it" });
            ctx.publisher().reset();

            const result = await cancel("unconfirmed.example.com");

            expect(result.status, JSON.stringify(result.body)).toBe(200);
            expect(result.body.dkimSelector).toBe("mail");
            expect(result.body.dkimPublicKey).toBe(oldKey);
            expect(result.body.dkimRotation.phase).toBe("idle");
            expect(result.body.dkimRotation.previous).toBeUndefined();
            expect(result.body.dkimRotation.lastError).toBeUndefined();
            expect(rotationDate(result.body.dkimRotation.lastCancelledAt)!.getTime()).toBeGreaterThan(Date.now() - 60_000);
            expect(await fs.readFile(path.join(ctx.keyDir(), "unconfirmed.example.com.selector"), "utf-8")).toBe("mail\n");
            expect(await ctx.provider().findKeyPair("unconfirmed.example.com", "rmx1")).toBeUndefined();
            expect((await ctx.provider().ensureKeyPair("unconfirmed.example.com")).publicKey).toBe(oldKey);
            expect((await audit(AuditAction.DKIM_ROTATION_CANCELLED)).map((entry) => entry.details)).toEqual([
                { name: "unconfirmed.example.com", selector: "rmx1", reverted: true },
            ]);
            expect(ctx.publisher().changes).toContainEqual({ scope: "domain", domainUid: "unconfirmed.example.com" });
            // The domain can take another key, or rotate again, at once.
            expect((await rotate("unconfirmed.example.com")).status).toBe(200);
        });

        it("changes nothing when the provider can't sign with the old key again, and keeps the provider on the switch a job confirmed meanwhile", async () => {
            await switchedDomain("cantrevert.example.com", "switching");
            const activate = vi.spyOn(ctx.provider(), "activate").mockRejectedValueOnce(new Error("read-only file system"));

            const refused = await cancel("cantrevert.example.com");

            expect(refused.status).toBe(503);
            expect(refused.body.message).toMatch(/read-only file system/);
            expect((await ctx.domainRow("cantrevert.example.com")).dkimSelector).toBe("rmx1");
            activate.mockRestore();

            // The job confirms the switch between the route's read and its write: the write loses and the provider signs with the new key again.
            const update = vi
                .spyOn(ctx.route().repoUtils, "update")
                .mockRejectedValueOnce(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "The object has been modified."));
            const lost = await cancel("cantrevert.example.com");
            update.mockRestore();

            expect(lost.status).toBe(409);
            expect(await fs.readFile(path.join(ctx.keyDir(), "cantrevert.example.com.selector"), "utf-8")).toBe("rmx1\n");
            expect((await ctx.domainRow("cantrevert.example.com")).dkimRotation.phase).toBe("switching");
            expect(await ctx.provider().findKeyPair("cantrevert.example.com", "rmx1")).toBeDefined();
            expect(await audit(AuditAction.DKIM_ROTATION_CANCELLED)).toHaveLength(0);

            // Pointing the provider back can fail too: logged for an administrator.
            const real = ctx.provider().activate.bind(ctx.provider());
            const again = vi.spyOn(ctx.provider(), "activate").mockImplementationOnce(real).mockRejectedValueOnce(new Error("EROFS"));
            const update2 = vi
                .spyOn(ctx.route().repoUtils, "update")
                .mockRejectedValueOnce(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "The object has been modified."));
            const error = vi.spyOn(ctx.route().logger, "error");
            expect((await cancel("cantrevert.example.com")).status).toBe(409);
            expect(error).toHaveBeenCalledWith(expect.stringContaining("EROFS"));
            again.mockRestore();
            update2.mockRestore();
            error.mockRestore();
        });

        it("still reverts when the second activation of the old key fails, logging it", async () => {
            await switchedDomain("halfrevert.example.com", "switching");
            const real = ctx.provider().activate.bind(ctx.provider());
            const activate = vi
                .spyOn(ctx.provider(), "activate")
                .mockImplementationOnce(real)
                .mockRejectedValueOnce(new Error("EIO"));
            const error = vi.spyOn(ctx.route().logger, "error");

            const result = await cancel("halfrevert.example.com");

            expect(result.status).toBe(200);
            expect(result.body.dkimSelector).toBe("mail");
            expect(error).toHaveBeenCalledWith(expect.stringContaining("EIO"));
            activate.mockRestore();
            error.mockRestore();
        });

        it("refuses to revert a switch when the old key is gone, changing nothing", async () => {
            await switchedDomain("oldgone.example.com", "switching");
            await ctx.provider().deleteKeyPair("oldgone.example.com", "mail");
            await ctx.saveDomain({ name: "noprevious.example.com", dkimSelector: "rmx1", dkimPublicKey: "K", dkimManaged: true, dkimRotation: { phase: "switching" } });

            const gone = await cancel("oldgone.example.com");
            const noPrevious = await cancel("noprevious.example.com");

            expect(gone.status).toBe(409);
            expect(gone.body.message).toMatch(/previous DKIM key/);
            expect(noPrevious.status).toBe(409);
            expect((await ctx.domainRow("oldgone.example.com")).dkimRotation.phase).toBe("switching");
            expect(await fs.readFile(path.join(ctx.keyDir(), "oldgone.example.com.selector"), "utf-8")).toBe("rmx1\n");
            expect(await audit(AuditAction.DKIM_ROTATION_CANCELLED)).toHaveLength(0);
        });

        it("needs a trusted role, an elevated token and a known domain", async () => {
            const domain = await createDomain("cancel-guard.example.com");
            expect((await cancel(domain.uid, userToken)).status).toBe(403);
            expect((await cancel(domain.uid, unelevatedToken)).status).toBe(403);
            expect((await cancel("missing.example.com")).status).toBe(404);
        });
    });

    describe("PUT /:id/dkim/rotation", () => {
        it("pauses and resumes scheduled rotation, audited once per change", async () => {
            const domain = await createDomain("pause.example.com");

            const paused = await pause(domain.uid, { paused: true });
            expect(paused.status, JSON.stringify(paused.body)).toBe(200);
            expect(paused.body.dkimRotation).toEqual(expect.objectContaining({ phase: "idle", paused: true }));
            const again = await pause(domain.uid, { paused: true });
            expect(again.body.version).toBe(paused.body.version);
            const resumed = await pause(domain.uid, { paused: false });
            expect(resumed.body.dkimRotation.paused).toBe(false);

            const entries = await audit(AuditAction.DKIM_ROTATION_PAUSED);
            expect(entries.map((entry) => entry.details)).toEqual(
                expect.arrayContaining([
                    { name: "pause.example.com", paused: true },
                    { name: "pause.example.com", paused: false },
                ]),
            );
            expect(entries).toHaveLength(2);
        });

        it("keeps a rotation in progress going", async () => {
            const domain = await createDomain("pause-pending.example.com");
            const started = await rotate(domain.uid);

            const paused = await pause(domain.uid, { paused: true });

            expect(paused.body.dkimRotation.phase).toBe("pending");
            expect(paused.body.dkimRotation.next.selector).toBe(started.body.dkimRotation.next.selector);
        });

        it("needs a trusted role, an elevated token, a known domain and a boolean paused", async () => {
            const domain = await createDomain("pause-guard.example.com");
            expect((await pause(domain.uid, { paused: true }, userToken)).status).toBe(403);
            expect((await pause(domain.uid, { paused: true }, unelevatedToken)).status).toBe(403);
            expect((await pause("missing.example.com", { paused: true })).status).toBe(404);
            expect((await pause(domain.uid, { paused: "yes" })).status).toBe(400);
            expect((await pause(domain.uid, [])).status).toBe(400);
        });
    });

    describe("GET /:id/dkim/rotation", () => {
        it("says when the next scheduled rotation is due", async () => {
            const domain = await verifiedDomain("view.example.com");

            const result = await view(domain.uid);

            expect(result.status).toBe(200);
            expect(result.body.rotatable).toBe(true);
            expect(result.body.blocker).toBeUndefined();
            expect(result.body.rotation).toBeNull();
            const due: number = new Date(result.body.nextScheduledAt).getTime();
            expect(Math.abs(due - (new Date(domain.dateCreated).getTime() + 180 * 86_400_000))).toBeLessThan(1000);
        });

        it("says nothing is scheduled while paused, in progress, turned off in config, or for a disabled or unverified domain", async () => {
            const domain = await verifiedDomain("view-paused.example.com");
            await pause(domain.uid, { paused: true });
            expect((await view(domain.uid)).body.nextScheduledAt).toBeUndefined();

            const other = await verifiedDomain("view-pending.example.com");
            await rotate(other.uid);
            const pending = (await view(other.uid)).body;
            expect(pending.rotation.phase).toBe("pending");
            expect(pending.nextScheduledAt).toBeUndefined();

            // The job never starts one on these; "Rotate now" still can.
            const disabled = await verifiedDomain("view-disabled.example.com", { enabled: false });
            const unverified = await createDomain("view-unverified.example.com");
            for (const uid of [disabled.uid, unverified.uid]) {
                const body = (await view(uid)).body;
                expect(body.rotatable).toBe(true);
                expect(body.nextScheduledAt).toBeUndefined();
            }

            const third = await verifiedDomain("view-off.example.com");
            expect((await view(third.uid)).body.nextScheduledAt).toBeDefined();
            ctx.route().dkimRotationEnabled = false;
            expect((await view(third.uid)).body.nextScheduledAt).toBeUndefined();
        });

        it("says why a domain can't rotate, without writing anything", async () => {
            await ctx.saveDomain({ name: "view-legacy.example.com", dkimSelector: "mail", dkimPublicKey: "HANDMADE" });
            const legacy = (await view("view-legacy.example.com")).body;
            expect(legacy).toEqual(expect.objectContaining({ rotatable: false, blocker: "imported" }));
            expect((await ctx.domainRow("view-legacy.example.com")).dkimManaged ?? undefined).toBeUndefined();

            const domain = await createDomain("view-ses.example.com");
            ctx.route().transportProvider = "ses";
            expect((await view(domain.uid)).body).toEqual(expect.objectContaining({ rotatable: false, blocker: "ses" }));
        });

        it("needs a trusted role and a known domain", async () => {
            const domain = await createDomain("view-guard.example.com");
            expect((await view(domain.uid, userToken)).status).toBe(403);
            expect((await view("missing.example.com")).status).toBe(404);
        });
    });
}
