///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { MAX_HEALTH_ERROR_LENGTH, sanitizeErrorText, SigningEnrollmentHealth } from "../../src/pki/SigningEnrollmentHealth.js";

describe("sanitizeErrorText() Tests", () => {
    it("keeps an ordinary network error as it is", () => {
        expect(sanitizeErrorText(new Error("connect ECONNREFUSED 10.0.0.5:443"))).toBe("connect ECONNREFUSED 10.0.0.5:443");
        expect(sanitizeErrorText("getaddrinfo ENOTFOUND acme.castle.cloud")).toBe("getaddrinfo ENOTFOUND acme.castle.cloud");
    });

    it("reduces a URL to its host, dropping the path, query, fragment and credentials", () => {
        expect(sanitizeErrorText("POST https://user:pw@acme.castle.cloud:8443/acme/order/abc123?token=secret#frag failed")).toBe("POST [url acme.castle.cloud:8443] failed");
        expect(sanitizeErrorText("see http:///x")).toBe("see [url]");
    });

    it("removes PEM blocks (including one that is cut off), bearer credentials and long token-like runs", () => {
        expect(sanitizeErrorText("bad key -----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY----- here")).toBe("bad key [key material removed] here");
        expect(sanitizeErrorText("-----BEGIN CERTIFICATE-----\nMIIabc")).toBe("[key material removed]");
        expect(sanitizeErrorText("Authorization: Bearer abc.def-ghi rejected")).toBe("Authorization: Bearer [removed] rejected");
        expect(sanitizeErrorText(`nonce ${"A".repeat(43)} was replayed`)).toBe("nonce [removed] was replayed");
    });

    it("collapses whitespace, caps the length with an ellipsis and never returns nothing", () => {
        expect(sanitizeErrorText("a\n\n  b\tc")).toBe("a b c");
        const long = sanitizeErrorText(Array(200).fill("word").join(" "));
        expect(long).toHaveLength(MAX_HEALTH_ERROR_LENGTH);
        expect(long.endsWith("…")).toBe(true);
        for (const nothing of [undefined, null, {}, "", 42]) {
            expect(sanitizeErrorText(nothing)).toBe("The certificate authority could not be reached.");
        }
    });
});

describe("SigningEnrollmentHealth Tests", () => {
    let dir: string;
    let file: string;
    let health: SigningEnrollmentHealth;

    beforeAll(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), "signing-health-"));
    });
    afterAll(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });
    beforeEach(() => {
        file = path.join(dir, `store-${Math.random()}`, "health.json");
        health = new SigningEnrollmentHealth(() => file);
    });

    it("reports nothing wrong before the CA was ever contacted", async () => {
        expect(await health.report()).toEqual({ ok: true });
    });

    it("records a success, and a failure that then names the sanitized error and the times", async () => {
        await health.record({ ok: true }, { now: new Date("2026-09-21T10:00:00Z") });
        expect(await health.report()).toEqual({ ok: true, checkedAt: "2026-09-21T10:00:00.000Z", lastSuccessAt: "2026-09-21T10:00:00.000Z" });

        const update = await health.record({ ok: false, error: new Error("boom at https://acme.example/order/1?t=x") }, { now: new Date("2026-09-21T10:05:00Z") });

        expect(update).toEqual({
            consecutiveFailures: 1,
            newFailure: true,
            recovered: false,
            auditDue: false,
            error: "boom at [url acme.example]",
            firstFailureAt: "2026-09-21T10:05:00.000Z",
        });
        expect(await health.report()).toEqual({
            ok: false,
            checkedAt: "2026-09-21T10:05:00.000Z",
            lastSuccessAt: "2026-09-21T10:00:00.000Z",
            lastError: "boom at [url acme.example]",
        });
    });

    it("flags a failure as new only when it starts a run or its text changes, and a success after failures as a recovery", async () => {
        expect((await health.record({ ok: false, error: "a" })).newFailure).toBe(true);
        expect((await health.record({ ok: false, error: "a" })).newFailure).toBe(false);
        expect((await health.record({ ok: false, error: "b", code: "ca-error" })).newFailure).toBe(true);
        const recovered = await health.record({ ok: true });
        expect(recovered).toEqual({ consecutiveFailures: 0, newFailure: false, recovered: true, auditDue: false });
        expect((await health.record({ ok: true })).recovered).toBe(false);
        expect((await health.record({ ok: false, error: "a" })).newFailure).toBe(true);
    });

    it("says an audit entry is due once per run of failures, when the run reaches the threshold", async () => {
        const due: boolean[] = [];
        for (let i = 0; i < 5; i++) {
            due.push((await health.record({ ok: false, error: "down" }, { auditAfter: 3 })).auditDue);
        }
        expect(due).toEqual([false, false, true, false, false]);
        await health.record({ ok: true });
        expect((await health.record({ ok: false, error: "down" }, { auditAfter: 1 })).auditDue).toBe(true);
        // A caller that never audits never causes one.
        expect((await new SigningEnrollmentHealth(() => path.join(dir, "other.json")).record({ ok: false, error: "x" })).auditDue).toBe(false);
    });

    it("survives a restart (a new instance reads the file) and falls back to memory when the file is unreadable or not an object", async () => {
        await health.record({ ok: false, error: "down" });
        expect(await new SigningEnrollmentHealth(() => file).report()).toEqual(expect.objectContaining({ ok: false, lastError: "down" }));

        await fs.writeFile(file, "{ not json");
        expect(await health.report()).toEqual(expect.objectContaining({ ok: false, lastError: "down" }));
        await fs.writeFile(file, "42");
        expect(await health.report()).toEqual(expect.objectContaining({ ok: false }));
        // A record with a text that predates the sanitizer is sanitized again when reported.
        await fs.writeFile(file, JSON.stringify({ lastCheckedAt: "2026-01-01T00:00:00.000Z", consecutiveFailures: 1, lastError: { message: "see https://x.example/secret", at: "2026-01-01T00:00:00.000Z" } }));
        expect((await health.report()).lastError).toBe("see [url x.example]");
    });

    it("keeps working when the file cannot be written", async () => {
        const blocked = path.join(dir, "blocked");
        await fs.writeFile(blocked, "a file where a directory is needed");
        const unwritable = new SigningEnrollmentHealth(() => path.join(blocked, "health.json"));

        await expect(unwritable.record({ ok: false, error: "down" })).resolves.toEqual(expect.objectContaining({ consecutiveFailures: 1 }));
        expect(await unwritable.report()).toEqual(expect.objectContaining({ ok: false, lastError: "down" }));
    });
});
