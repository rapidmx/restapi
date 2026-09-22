///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The progress an RFC 8823 enrollment reports (`describeProgress()`, `checkNow()`, `listEnrollments()`), stage by stage, against
// the real store on disk and a fake `acme-client` `Client` (`acmeTestDoubles.ts`).
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { Rfc8823AcmeSigningCertificateEnrollment } from "../../src/pki/Rfc8823AcmeSigningCertificateEnrollment.js";
import { ScanPipeline } from "../../src/scan/ScanPipeline.js";
import { AvVerdict, SpamVerdict } from "../../src/models/types.js";
import { FakeAcmeClient, generateCsr, generateSelfSignedCertificate, TestEnrollment } from "./acmeTestDoubles.js";

describe("Rfc8823AcmeSigningCertificateEnrollment progress Tests", () => {
    let tmpDir: string;
    let storeDir: string;
    let enrollment: TestEnrollment;

    const newEnrollment = (): TestEnrollment => {
        const instance = new TestEnrollment();
        (instance as any).storeDir = storeDir;
        const pipeline = new ScanPipeline();
        (pipeline as any).spamScanProvider = { name: "test-spam", scoreMessage: async () => ({ score: 0, verdict: SpamVerdict.CLEAN, symbols: [] }) };
        (pipeline as any).avScanProvider = { name: "test-av", scanBuffer: async () => ({ verdict: AvVerdict.CLEAN }) };
        (instance as any).scanPipeline = pipeline;
        (instance as any).mailTransport = { send: vi.fn().mockResolvedValue({ accepted: ["x"], rejected: [] }) };
        (instance as any).blobStore = { put: vi.fn().mockResolvedValue(undefined) };
        (instance as any).logger = { info: vi.fn(), warn: vi.fn() };
        return instance;
    };

    /** The store file, for a test that needs to read or rewrite a record the way an older version (or a clock) would. */
    const readStore = async (): Promise<Record<string, any>> => JSON.parse(await fs.readFile(path.join(storeDir, "enrollments.json"), "utf-8"));
    const writeStore = async (store: Record<string, any>): Promise<void> => {
        await fs.writeFile(path.join(storeDir, "enrollments.json"), JSON.stringify(store));
    };
    const start = async (identity: string = "alice@example.com"): Promise<string> => (await enrollment.startEnrollment(identity, await generateCsr(identity))).enrollmentId;
    const receiveChallenge = (id: string) => enrollment.recordChallengeToken(id, "token-part-1", "reply-to@acme.test", "<challenge@acme.test>", "ACME: token-part-1");
    /** An enrollment whose challenge e-mail arrived (the reply is due). */
    const startWithChallenge = async (identity?: string): Promise<string> => {
        const id = await start(identity);
        await receiveChallenge(id);
        return id;
    };
    const stageStates = async (id: string): Promise<string[]> => (await enrollment.describeProgress(id)).stages.map((stage) => `${stage.id}:${stage.state}`);

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc8823-progress-"));
    });
    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });
    beforeEach(() => {
        FakeAcmeClient.reset();
        storeDir = path.join(tmpDir, `store-${Math.random()}`);
        enrollment = newEnrollment();
    });

    describe("describeProgress(): every stage", () => {
        it("submitted: waiting for the CA's verification e-mail, with when the next check is due", async () => {
            const id = await start();

            const progress = await enrollment.describeProgress(id);

            expect(progress).toEqual(
                expect.objectContaining({
                    status: "pending",
                    stage: "awaiting-challenge",
                    progress: 15,
                    requestedAt: (await readStore())[id].createdAt,
                }),
            );
            expect(progress.updatedAt).toBe(progress.requestedAt);
            expect(progress.stages.map((stage) => stage.state)).toEqual(["done", "active", "pending", "pending", "pending", "pending"]);
            expect(progress.lastCheckedAt).toBeUndefined();
            expect(Date.parse(progress.nextCheckAt!)).toBe(Date.parse(progress.requestedAt) + 300_000);
            for (const absent of ["errorCode", "retryable", "note", "issuedAt", "installedAt", "notAfter", "serialNumber", "issuer", "subject"] as const) {
                expect(progress[absent]).toBeUndefined();
            }
        });

        it("challenge received: the reply is due, and the stage's time is kept", async () => {
            const id = await startWithChallenge();

            const progress = await enrollment.describeProgress(id);

            expect(progress.stage).toBe("challenge-answered");
            expect(progress.progress).toBe(40);
            expect(progress.stages[1]).toEqual(expect.objectContaining({ state: "done", at: (await readStore())[id].challengeReceivedAt }));
            expect(Date.parse(progress.updatedAt)).toBeGreaterThanOrEqual(Date.parse(progress.requestedAt));
        });

        it("reply sent: the CA is validating", async () => {
            const id = await startWithChallenge();

            await enrollment.advanceEnrollment(id);

            const progress = await enrollment.describeProgress(id);
            expect(progress.stage).toBe("validating");
            expect(progress.progress).toBe(60);
            expect(progress.stages[2]).toEqual(expect.objectContaining({ state: "done", at: (await readStore())[id].replySentAt }));
            expect(progress.lastCheckedAt).toBeTruthy();
            expect(Date.parse(progress.nextCheckAt!)).toBe(Date.parse(progress.lastCheckedAt!) + 300_000);
        });

        it("order ready then processing: issuing", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);

            FakeAcmeClient.orderStatus = "ready";
            await enrollment.advanceEnrollment(id);
            expect((await enrollment.describeProgress(id)).stage).toBe("issuing");
            expect((await enrollment.describeProgress(id)).progress).toBe(85);
            expect((await stageStates(id)).slice(3)).toEqual(["validating:done", "issuing:active", "issued:pending"]);

            FakeAcmeClient.orderStatus = "processing";
            await enrollment.advanceEnrollment(id);
            expect((await enrollment.describeProgress(id)).stage).toBe("issuing");
            expect(FakeAcmeClient.finalizeCallCount).toBe(1);
        });

        it("order valid: issued, with the certificate's own details and when it was issued", async () => {
            const certificate = await generateSelfSignedCertificate("alice@example.com", new Date("2027-01-01T00:00:00.000Z"));
            FakeAcmeClient.certificatePem = certificate;
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.orderStatus = "valid";

            await enrollment.advanceEnrollment(id);

            const progress = await enrollment.describeProgress(id);
            expect(progress).toEqual(
                expect.objectContaining({
                    status: "issued",
                    stage: "issued",
                    progress: 100,
                    certificate,
                    notAfter: "2027-01-01T00:00:00.000Z",
                    serialNumber: "0a1b2c",
                    subject: "CN=alice@example.com",
                    issuer: "CN=alice@example.com",
                }),
            );
            expect(progress.issuedAt).toBe((await readStore())[id].issuedAt);
            expect(progress.stages.every((stage) => stage.state === "done")).toBe(true);
            expect(progress.installedAt).toBeUndefined();
            expect(progress.nextCheckAt).toBeUndefined();
        });

        it("issued and installed: reports when the job installed it", async () => {
            FakeAcmeClient.certificatePem = await generateSelfSignedCertificate("alice@example.com");
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.orderStatus = "valid";
            await enrollment.advanceEnrollment(id);

            await enrollment.markInstalled(id);

            expect((await enrollment.describeProgress(id)).installedAt).toBe((await readStore())[id].installedAt);
        });

        it("omits the certificate's details when it can't be parsed", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.orderStatus = "valid";
            await enrollment.advanceEnrollment(id);

            const progress = await enrollment.describeProgress(id);

            expect(progress.status).toBe("issued");
            expect(progress.notAfter).toBeUndefined();
            expect(progress.serialNumber).toBeUndefined();
        });

        it("survives a restart: a new instance on the same store reports the same stage and times", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            const before = await enrollment.describeProgress(id);

            const restarted = newEnrollment();

            expect(await restarted.describeProgress(id)).toEqual(before);
        });

        it("reads a record written before the progress fields existed", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            const store = await readStore();
            for (const field of ["updatedAt", "challengeReceivedAt", "lastCheckedAt", "orderStatus", "finalizedAt"]) {
                delete store[id][field];
            }
            await writeStore(store);

            const progress = await enrollment.describeProgress(id);

            expect(progress.stage).toBe("validating");
            expect(progress.updatedAt).toBe(progress.requestedAt);
            expect(progress.stages[1].at).toBeUndefined();
            expect(Date.parse(progress.nextCheckAt!)).toBe(Date.parse(progress.requestedAt) + 300_000);
        });

        it("throws 404 for an unknown enrollment id", async () => {
            await expect(enrollment.describeProgress("nope")).rejects.toMatchObject({ status: 404 });
        });
    });

    describe("failures", () => {
        it.each([
            ["a refusal of the request", "urn:ietf:params:acme:error:rejectedIdentifier", "rejected", false],
            ["a challenge that did not validate", "urn:ietf:params:acme:error:unauthorized", "challenge-failed", true],
            ["a CA-side error", "urn:ietf:params:acme:error:serverInternal", "ca-error", true],
        ])("classifies %s", async (_name, type, errorCode, retryable) => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.orderStatus = "invalid";
            FakeAcmeClient.orderError = { type, detail: "nope" };

            await enrollment.advanceEnrollment(id);

            const progress = await enrollment.describeProgress(id);
            expect(progress).toEqual(expect.objectContaining({ status: "failed", stage: "failed", errorCode, retryable }));
            expect(progress.error).toContain("nope");
            expect(progress.stages.map((stage) => stage.state)).toEqual(["done", "done", "done", "failed", "pending", "pending"]);
            expect(progress.stages[3].at).toBe((await readStore())[id].failedAt);
            expect(progress.progress).toBe(60);
            expect(progress.nextCheckAt).toBeUndefined();
        });

        it("classifies an invalid order with no error as invalid but retryable", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.orderStatus = "invalid";

            await enrollment.advanceEnrollment(id);

            expect(await enrollment.describeProgress(id)).toEqual(
                expect.objectContaining({ status: "failed", errorCode: "order-invalid", retryable: true, error: "The certificate authority marked this order invalid." }),
            );
        });

        it("reports a cancelled enrollment as failed, retryable, and cancelled", async () => {
            const id = await start();

            await enrollment.cancelEnrollment(id, "Cancelled by the mailbox owner.");

            expect(await enrollment.describeProgress(id)).toEqual(
                expect.objectContaining({ status: "failed", stage: "failed", errorCode: "cancelled", retryable: true, error: "Cancelled by the mailbox owner." }),
            );
        });

        it("reports a failed record from before error codes existed as failed and retryable", async () => {
            const id = await start();
            const store = await readStore();
            store[id].status = "failed";
            store[id].error = "old failure";
            await writeStore(store);

            expect(await enrollment.describeProgress(id)).toEqual(expect.objectContaining({ status: "failed", errorCode: "failed", retryable: true, error: "old failure" }));
        });
    });

    describe("timeouts and expiry of the ACME order", () => {
        it("fails a request whose order expired before the challenge e-mail ever came, without asking the CA", async () => {
            FakeAcmeClient.orderExpires = new Date(Date.now() - 1000).toISOString();
            const id = await start();

            await enrollment.advanceEnrollment(id);

            const progress = await enrollment.describeProgress(id);
            expect(progress).toEqual(expect.objectContaining({ status: "failed", stage: "failed", errorCode: "order-expired", retryable: true }));
            expect(progress.error).toMatch(/expired/);
            expect(FakeAcmeClient.getOrderCallCount).toBe(0);
        });

        it("fails one that expired while the CA was validating the reply", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            const store = await readStore();
            store[id].orderExpires = new Date(Date.now() - 1000).toISOString();
            await writeStore(store);

            await enrollment.advanceEnrollment(id);

            const progress = await enrollment.describeProgress(id);
            expect(progress.errorCode).toBe("order-expired");
            expect(progress.stages.map((stage) => stage.state)).toEqual(["done", "done", "done", "failed", "pending", "pending"]);
        });

        it("falls back to a maximum age from the request when the CA didn't say when the order expires", async () => {
            const id = await start();
            const store = await readStore();
            store[id].createdAt = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString();
            await writeStore(store);

            await enrollment.advanceEnrollment(id);

            expect((await enrollment.describeProgress(id)).errorCode).toBe("order-expired");
        });

        it("leaves a request within its age alone", async () => {
            const id = await start();
            const store = await readStore();
            store[id].createdAt = new Date(Date.now() - 6 * 24 * 3_600_000).toISOString();
            await writeStore(store);

            await enrollment.advanceEnrollment(id);

            expect((await enrollment.describeProgress(id)).status).toBe("pending");
        });

        it("does not expire an order the CA is already finalizing", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.orderStatus = "ready";
            await enrollment.advanceEnrollment(id);
            const store = await readStore();
            store[id].orderExpires = new Date(Date.now() - 1000).toISOString();
            await writeStore(store);
            FakeAcmeClient.orderStatus = "processing";

            await enrollment.advanceEnrollment(id);

            expect((await enrollment.describeProgress(id)).stage).toBe("issuing");
        });

        it("never expires on an expiry it can't read", async () => {
            const id = await start();
            const store = await readStore();
            store[id].orderExpires = "not a date";
            await writeStore(store);

            await enrollment.advanceEnrollment(id);

            expect((await enrollment.describeProgress(id)).status).toBe("pending");
        });

        it("takes the order's expiry from the CA's own reports as they change", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.orderExpires = "2030-01-01T00:00:00.000Z";

            await enrollment.advanceEnrollment(id);

            expect((await readStore())[id].orderExpires).toBe("2030-01-01T00:00:00.000Z");
        });
    });

    describe("attempts that fail while the enrollment is still pending", () => {
        it("records an unreachable CA, keeps the enrollment pending and retryable, and clears it when the next step succeeds", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.getOrderError = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

            await expect(enrollment.advanceEnrollment(id)).rejects.toThrow("ECONNREFUSED");

            const failing = await enrollment.describeProgress(id);
            expect(failing).toEqual(expect.objectContaining({ status: "pending", stage: "validating", errorCode: "ca-unreachable", retryable: true, note: "connect ECONNREFUSED" }));

            FakeAcmeClient.getOrderError = undefined;
            await enrollment.advanceEnrollment(id);

            const recovered = await enrollment.describeProgress(id);
            expect(recovered.errorCode).toBeUndefined();
            expect(recovered.note).toBeUndefined();
            expect((await readStore())[id].lastError).toBeUndefined();
        });

        it("records a reply that couldn't be sent as reply-not-sent", async () => {
            const id = await startWithChallenge();
            (enrollment as any).mailTransport.send = vi.fn().mockRejectedValue(new Error("relay down"));

            await expect(enrollment.advanceEnrollment(id)).rejects.toThrow();

            expect(await enrollment.describeProgress(id)).toEqual(expect.objectContaining({ status: "pending", stage: "challenge-answered", errorCode: "reply-not-sent" }));
        });

        it("records a CA that refused the challenge notification as a CA error", async () => {
            const id = await startWithChallenge();
            FakeAcmeClient.completeChallengeError = new Error("500");

            await expect(enrollment.advanceEnrollment(id)).rejects.toThrow("500");

            expect((await enrollment.describeProgress(id)).errorCode).toBe("ca-error");
        });

        it("still rethrows the original error, and logs, when recording it fails too", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.getOrderError = new Error("CA down");
            const original = (Rfc8823AcmeSigningCertificateEnrollment.prototype as any).mutateEnrollment;
            const mutate = vi.spyOn(enrollment as any, "mutateEnrollment");
            mutate.mockImplementationOnce(function (this: any, ...args: any[]) {
                return original.apply(this, args); // the lastCheckedAt write
            });
            mutate.mockRejectedValueOnce(new Error("disk full")); // the lastError write

            await expect(enrollment.advanceEnrollment(id)).rejects.toThrow("CA down");

            expect((enrollment as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
        });
    });

    describe("checkNow()", () => {
        it("throws 404 for an unknown enrollment id", async () => {
            await expect(enrollment.checkNow("nope")).rejects.toMatchObject({ status: 404 });
        });

        it("asks the CA about a request still waiting for the challenge e-mail and stays put when the CA has nothing new", async () => {
            const id = await start();

            const progress = await enrollment.checkNow(id);

            expect(FakeAcmeClient.getOrderCallCount).toBe(1);
            expect(progress).toEqual(expect.objectContaining({ status: "pending", stage: "awaiting-challenge" }));
            expect(progress.lastCheckedAt).toBeTruthy();
            expect(progress.note).toBeUndefined();
        });

        it("notices a request the CA already gave up on before the e-mail was due", async () => {
            const id = await start();
            FakeAcmeClient.orderStatus = "invalid";
            FakeAcmeClient.orderError = { type: "urn:ietf:params:acme:error:rejectedIdentifier", detail: "no such domain" };

            const progress = await enrollment.checkNow(id);

            expect(progress).toEqual(expect.objectContaining({ status: "failed", errorCode: "rejected", retryable: false }));
        });

        it("answers the challenge and then polls the order in the one call", async () => {
            const id = await startWithChallenge();

            const progress = await enrollment.checkNow(id);

            expect((enrollment as any).mailTransport.send).toHaveBeenCalledTimes(1);
            expect(FakeAcmeClient.completeChallengeCallCount).toBe(1);
            expect(FakeAcmeClient.getOrderCallCount).toBe(1);
            expect(progress.stage).toBe("validating");
            expect(progress.stages[2].state).toBe("done");
        });

        it("finalizes a ready order", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.orderStatus = "ready";

            const progress = await enrollment.checkNow(id);

            expect(FakeAcmeClient.finalizeCallCount).toBe(1);
            expect(progress.stage).toBe("issuing");
        });

        it("downloads the certificate of a valid order", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.orderStatus = "valid";
            FakeAcmeClient.certificatePem = await generateSelfSignedCertificate("alice@example.com");

            const progress = await enrollment.checkNow(id);

            expect(progress).toEqual(expect.objectContaining({ status: "issued", stage: "issued", progress: 100 }));
            expect(progress.notAfter).toBeTruthy();
        });

        it("refuses a second check within the interval with a retry-after, and allows one after it", async () => {
            const id = await start();
            await enrollment.checkNow(id);

            const refused = await enrollment.checkNow(id).catch((err) => err);

            expect(refused).toMatchObject({ status: 429 });
            expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1);
            expect(refused.retryAfterSeconds).toBeLessThanOrEqual(10);
            expect(FakeAcmeClient.getOrderCallCount).toBe(1);

            await expect(enrollment.checkNow(id, { minIntervalMs: 0 })).resolves.toBeTruthy();
        });

        it("keeps the limit across restarts and replicas (it is in the record)", async () => {
            const id = await start();
            await enrollment.checkNow(id);

            await expect(newEnrollment().checkNow(id)).rejects.toMatchObject({ status: 429 });
        });

        it("limits each enrollment on its own", async () => {
            const first = await start("first@example.com");
            const second = await start("second@example.com");
            await enrollment.checkNow(first);

            await expect(enrollment.checkNow(second)).resolves.toBeTruthy();
        });

        it("answers a finished enrollment as it is, with no CA call and no limit", async () => {
            const id = await start();
            await enrollment.cancelEnrollment(id, "gone");

            const first = await enrollment.checkNow(id);
            const second = await enrollment.checkNow(id);

            expect(first.status).toBe("failed");
            expect(second).toEqual(first);
            expect(FakeAcmeClient.getOrderCallCount).toBe(0);
        });

        it("answers with the current state and a note when the CA is slow, and lets the check finish in the background", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.getOrderDelayMs = 300;
            FakeAcmeClient.orderStatus = "ready";

            const startedAt = Date.now();
            const progress = await enrollment.checkNow(id, { timeoutMs: 50 });

            expect(Date.now() - startedAt).toBeLessThan(250);
            expect(progress.stage).toBe("validating");
            expect(progress.note).toMatch(/still running/);

            await new Promise((resolve) => setTimeout(resolve, 600));
            expect((await enrollment.describeProgress(id)).stage).toBe("issuing");
        });

        it("answers with the failure, rather than throwing, when the CA can't be reached", async () => {
            const id = await startWithChallenge();
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.getOrderError = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });

            const progress = await enrollment.checkNow(id);

            expect(progress).toEqual(expect.objectContaining({ status: "pending", errorCode: "ca-unreachable", retryable: true, note: "connect ETIMEDOUT" }));
        });
    });

    describe("listEnrollments()", () => {
        it("lists every enrollment's binding and state, never its key material", async () => {
            const first = await start("first@example.com");
            await enrollment.attachWrappedKey(first, { ciphertext: "c", nonce: "n", algorithm: "a" }, { mailboxUid: "mbx-1", masterKeyGeneration: 0 });
            const second = await start("second@example.com");
            await enrollment.cancelEnrollment(second, "no");

            const list = await enrollment.listEnrollments();

            expect(list).toHaveLength(2);
            expect(list.find((entry) => entry.enrollmentId === first)).toEqual({
                enrollmentId: first,
                identity: "first@example.com",
                mailboxUid: "mbx-1",
                status: "pending",
                createdAt: (await readStore())[first].createdAt,
                installedAt: undefined,
            });
            expect(list.find((entry) => entry.enrollmentId === second)?.status).toBe("failed");
            expect(JSON.stringify(list)).not.toContain("csr");
        });

        it("is empty when nothing was ever started", async () => {
            expect(await enrollment.listEnrollments()).toEqual([]);
        });
    });
});
