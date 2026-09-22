///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What the RFC 8823 provider says about itself and about how the CA is doing: the backend description (`GET /system/signing-enrollment`),
// the startup line, the health record, the phase of a failure, the administrator's read-only list, and the code of an unknown id. The CA is
// the fake ACME client of `acmeTestDoubles.ts`; the store is real, on disk.
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ScanPipeline } from "../../src/scan/ScanPipeline.js";
import { AvVerdict, SpamVerdict } from "../../src/models/types.js";
import { SIGNING_ENROLLMENT_UNKNOWN } from "../../src/pki/SigningCertificateEnrollment.js";
import { TYPICAL_DURATION_MINUTES } from "../../src/pki/Rfc8823AcmeSigningCertificateEnrollment.js";
import { FakeAcmeClient, generateCsr, TestEnrollment } from "./acmeTestDoubles.js";

describe("Rfc8823AcmeSigningCertificateEnrollment backend Tests", () => {
    let tmpDir: string;
    let storeDir: string;
    let enrollment: TestEnrollment;
    let logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

    const newEnrollment = (): TestEnrollment => {
        const instance = new TestEnrollment();
        (instance as any).storeDir = storeDir;
        const pipeline = new ScanPipeline();
        (pipeline as any).spamScanProvider = { name: "test-spam", scoreMessage: async () => ({ score: 0, verdict: SpamVerdict.CLEAN, symbols: [] }) };
        (pipeline as any).avScanProvider = { name: "test-av", scanBuffer: async () => ({ verdict: AvVerdict.CLEAN }) };
        (instance as any).scanPipeline = pipeline;
        (instance as any).mailTransport = { send: vi.fn().mockResolvedValue({ accepted: ["x"], rejected: [] }) };
        (instance as any).blobStore = { put: vi.fn().mockResolvedValue(undefined) };
        logger = { info: vi.fn(), warn: vi.fn() };
        (instance as any).logger = logger;
        return instance;
    };
    const start = async (identity: string = "alice@example.com"): Promise<string> => (await enrollment.startEnrollment(identity, await generateCsr(identity))).enrollmentId;
    const receiveChallenge = (id: string) => enrollment.recordChallengeToken(id, "token-part-1", "reply-to@acme.test", "<challenge@acme.test>", "ACME: token-part-1");

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc8823-backend-"));
    });
    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });
    beforeEach(() => {
        FakeAcmeClient.reset();
        storeDir = path.join(tmpDir, `store-${Math.random()}`);
        enrollment = newEnrollment();
    });

    describe("describeBackend()", () => {
        it("says it is automatic, names the CA's host only, the contact and the typical time, and that nobody can upload", async () => {
            (enrollment as any).directoryUrl = "https://user:pw@acme.example:8443/acme/directory?token=secret";
            (enrollment as any).contactEmail = "pki@example.com";

            const info = await enrollment.describeBackend();

            expect(enrollment.kind).toBe("rfc8823");
            expect(info).toEqual({
                backend: "rfc8823",
                automatic: true,
                ca: { host: "acme.example:8443" },
                contactEmail: "pki@example.com",
                typicalDurationMinutes: TYPICAL_DURATION_MINUTES,
                adminUpload: false,
                health: { ok: true },
            });
            expect(TYPICAL_DURATION_MINUTES).toBeGreaterThanOrEqual(10);
            expect(TYPICAL_DURATION_MINUTES).toBeLessThanOrEqual(30);
            expect(JSON.stringify(info)).not.toMatch(/secret|user|pw|\/acme\/directory/);
        });

        it("leaves out what it does not have: no contact, and no CA host for a directory URL that does not parse", async () => {
            (enrollment as any).directoryUrl = "not a url";

            const info = await enrollment.describeBackend();

            expect(info.ca).toBeUndefined();
            expect(info.contactEmail).toBeUndefined();
        });

        it("reports the health the CA contacts have left: failing, with the sanitized error, then recovered", async () => {
            await enrollment.health.record({ ok: false, error: new Error("connect ECONNREFUSED https://acme.test/x?token=1") });

            expect((await enrollment.describeBackend()).health).toEqual(
                expect.objectContaining({ ok: false, lastError: "connect ECONNREFUSED [url acme.test]", checkedAt: expect.any(String) }),
            );

            await enrollment.health.record({ ok: true });

            expect((await enrollment.describeBackend()).health).toEqual(expect.objectContaining({ ok: true, lastSuccessAt: expect.any(String) }));
            expect((await enrollment.describeBackend()).health!.lastError).toBeUndefined();
        });
    });

    describe("logStartup()", () => {
        it("logs the CA host and that no account is registered yet, without contacting the CA", async () => {
            (enrollment as any).directoryUrl = "https://acme.example/dir?x=1";

            await enrollment.logStartup();

            expect(logger.info).toHaveBeenCalledTimes(1);
            expect(logger.info.mock.calls[0][0]).toMatch(/issued automatically \(RFC 8823\) by the CA at acme\.example;.*no ACME account is registered yet/);
            expect(logger.info.mock.calls[0][0]).not.toContain("?x=1");
            expect(FakeAcmeClient.createAccountCallCount).toBe(0);
        });

        it("logs that the account is already registered once a request created it", async () => {
            await start();
            logger.info.mockClear();

            await enrollment.logStartup();

            expect(logger.info.mock.calls[0][0]).toMatch(/an ACME account is already registered/);
        });

        it("names a directory URL it cannot parse, and never throws when the store cannot be read", async () => {
            (enrollment as any).directoryUrl = "::";
            await enrollment.logStartup();
            expect(logger.info.mock.calls[0][0]).toContain("an unparsable directory URL");

            // A directory where the account URL file should be: reading it fails with something other than "not found".
            await fs.mkdir(path.join(storeDir, "account.url"), { recursive: true });
            await expect(enrollment.logStartup()).resolves.toBeUndefined();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not read the ACME account state"));
        });
    });

    describe("the health a request leaves", () => {
        it("records the CA answering as a success, and an unreachable CA as a failure that is rethrown", async () => {
            await start();
            expect((await enrollment.health.report()).lastSuccessAt).toBeTruthy();

            class Down extends TestEnrollment {
                protected createClient(opts: any): any {
                    const client = new FakeAcmeClient(opts);
                    client.createOrder = async () => {
                        throw new Error("getaddrinfo ENOTFOUND acme.example");
                    };
                    return client;
                }
            }
            const down = new Down();
            (down as any).storeDir = storeDir;

            await expect(down.startEnrollment("bob@example.com", await generateCsr("bob@example.com"))).rejects.toThrow("ENOTFOUND");

            expect(await down.health.report()).toEqual(expect.objectContaining({ ok: false, lastError: "getaddrinfo ENOTFOUND acme.example" }));
        });

        it("records a CA that offers no email-reply-00 challenge as a failure, and a CSR it refuses locally as none", async () => {
            class NoEmail extends TestEnrollment {
                protected createClient(opts: any): any {
                    const client = new FakeAcmeClient(opts);
                    client.getAuthorizations = async () => [{ url: "u", status: "pending", challenges: [{ type: "http-01", url: "c", token: "t" }] }];
                    return client;
                }
            }
            const noEmail = new NoEmail();
            (noEmail as any).storeDir = storeDir;

            await expect(noEmail.startEnrollment("bob@example.com", await generateCsr("bob@example.com"))).rejects.toThrow(/did not offer an email-reply-00/);
            expect((await noEmail.health.report()).ok).toBe(false);

            storeDir = path.join(tmpDir, "another-store");
            const fresh = newEnrollment();
            await expect(fresh.startEnrollment("bob@example.com", "not a csr")).rejects.toMatchObject({ status: 400 });
            expect(await fresh.health.report()).toEqual({ ok: true });
        });

        it("does not let a failure to write the health record fail the request", async () => {
            const id = await start();
            (enrollment.health as any).record = async () => {
                throw new Error("disk full");
            };

            await expect(start("carol@example.com")).resolves.toBeTruthy();
            expect(id).toBeTruthy();
        });

        it("still rethrows the CA's own failure when recording it as unhealthy also fails", async () => {
            class Down extends TestEnrollment {
                protected createClient(opts: any): any {
                    const client = new FakeAcmeClient(opts);
                    client.createOrder = async () => {
                        throw new Error("connect ECONNREFUSED");
                    };
                    return client;
                }
            }
            const down = new Down();
            (down as any).storeDir = storeDir;
            (down.health as any).record = async () => {
                throw new Error("disk full");
            };

            await expect(down.startEnrollment("bob@example.com", await generateCsr("bob@example.com"))).rejects.toThrow("ECONNREFUSED");
        });

        it("still rejects with 'no email-reply-00 challenge' when recording that as unhealthy also fails", async () => {
            class NoEmail extends TestEnrollment {
                protected createClient(opts: any): any {
                    const client = new FakeAcmeClient(opts);
                    client.getAuthorizations = async () => [{ url: "u", status: "pending", challenges: [] }];
                    return client;
                }
            }
            const noEmail = new NoEmail();
            (noEmail as any).storeDir = storeDir;
            (noEmail.health as any).record = async () => {
                throw new Error("disk full");
            };

            await expect(noEmail.startEnrollment("bob@example.com", await generateCsr("bob@example.com"))).rejects.toThrow(/did not offer an email-reply-00/);
        });
    });

    describe("advanceEnrollment()", () => {
        it("answers true when the CA answered and false when nothing needed it", async () => {
            const id = await start();
            // No challenge e-mail yet: nothing to ask the CA.
            expect(await enrollment.advanceEnrollment(id)).toBe(false);

            await receiveChallenge(id);
            // The reply goes out and the CA is told.
            expect(await enrollment.advanceEnrollment(id)).toBe(true);
            // Polling the order.
            expect(await enrollment.advanceEnrollment(id)).toBe(true);

            await enrollment.cancelEnrollment(id, "gone");
            expect(await enrollment.advanceEnrollment(id)).toBe(false);
        });

        it("answers false for an enrollment that expired (it fails without a CA call)", async () => {
            const id = await start();
            const file = path.join(storeDir, "enrollments.json");
            const store = JSON.parse(await fs.readFile(file, "utf-8"));
            store[id].createdAt = new Date(Date.now() - 400 * 3_600_000).toISOString();
            await fs.writeFile(file, JSON.stringify(store));

            expect(await enrollment.advanceEnrollment(id)).toBe(false);
            expect((await enrollment.describeProgress(id)).errorCode).toBe("order-expired");
        });

        it("tags a failure of the CA side, and one of the reply e-mail, so the job can tell them apart", async () => {
            const id = await start();
            await receiveChallenge(id);
            (enrollment as any).mailTransport.send = vi.fn().mockRejectedValue(new Error("relay refused"));

            const replyFailure = await enrollment.advanceEnrollment(id).catch((err) => err);
            expect(replyFailure.enrollmentPhase).toBe("reply");

            (enrollment as any).mailTransport.send = vi.fn().mockResolvedValue({ accepted: ["x"], rejected: [] });
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.getOrderError = new Error("connect ECONNREFUSED");
            const caFailure = await enrollment.advanceEnrollment(id).catch((err) => err);
            expect(caFailure.enrollmentPhase).toBe("ca");
        });

        it("does not tag a thrown value that is not an object", async () => {
            const id = await start();
            await receiveChallenge(id);
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.getOrderError = "plain string failure";

            await expect(enrollment.advanceEnrollment(id)).rejects.toBe("plain string failure");
        });

        it("stores the failure's text without URLs, tokens or key material", async () => {
            const id = await start();
            await receiveChallenge(id);
            await enrollment.advanceEnrollment(id);
            FakeAcmeClient.getOrderError = new Error(`POST https://acme.test/order/1?token=abc failed: ${"Z".repeat(60)}`);
            await enrollment.advanceEnrollment(id).catch(() => undefined);

            const progress = await enrollment.describeProgress(id);

            expect(progress.note).toBe("POST [url acme.test] failed: [removed]");
        });
    });

    describe("provider and the administrator's list", () => {
        it("puts provider on every progress it reports", async () => {
            const id = await start();

            expect((await enrollment.describeProgress(id)).provider).toBe("rfc8823");
            expect((await enrollment.checkNow(id)).provider).toBe("rfc8823");
        });

        it("lists pending requests read-only, newest first, with the stage and the last error, and leaves out finished ones", async () => {
            const first = await start("first@example.com");
            await new Promise((resolve) => setTimeout(resolve, 5));
            const second = await start("second@example.com");
            await enrollment.attachWrappedKey(second, { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" }, { mailboxUid: "mb-2", masterKeyGeneration: 0 });
            await receiveChallenge(second);
            await enrollment.advanceEnrollment(second);
            FakeAcmeClient.getOrderError = new Error("connect ECONNREFUSED");
            await enrollment.advanceEnrollment(second).catch(() => undefined);
            const cancelled = await start("cancelled@example.com");
            await enrollment.cancelEnrollment(cancelled, "x");

            const list = await enrollment.listAdminEnrollments();

            expect(list.map((row) => row.enrollmentId)).toEqual([second, first]);
            expect(list[0]).toEqual(
                expect.objectContaining({ provider: "rfc8823", status: "pending", mailboxUid: "mb-2", stage: "validating", lastError: "connect ECONNREFUSED", canUpload: false }),
            );
            expect(list[1].uploadBlockedReason).toMatch(/issued automatically/);
            expect(list[1].lastError).toBeUndefined();
            expect(JSON.stringify(list)).not.toContain("ciphertext");
        });

        it("keeps an issued but not yet installed request in the list, without the reason", async () => {
            const id = await start();
            const file = path.join(storeDir, "enrollments.json");
            const store = JSON.parse(await fs.readFile(file, "utf-8"));
            store[id].status = "issued";
            await fs.writeFile(file, JSON.stringify(store));

            const [row] = await enrollment.listAdminEnrollments();

            expect(row).toEqual(expect.objectContaining({ status: "issued", canUpload: false }));
            expect(row.uploadBlockedReason).toBeUndefined();
        });
    });

    it("answers an unknown id with the code a client clears a stale id by", async () => {
        for (const call of [
            () => enrollment.checkStatus("nope"),
            () => enrollment.describeProgress("nope"),
            () => enrollment.describeEnrollment("nope"),
            () => enrollment.checkNow("nope"),
            () => enrollment.cancelEnrollment("nope", "x"),
        ]) {
            await expect(call()).rejects.toMatchObject({ status: 404, code: SIGNING_ENROLLMENT_UNKNOWN });
        }
    });
});
