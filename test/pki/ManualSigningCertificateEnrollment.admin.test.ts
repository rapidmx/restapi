///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The manual provider's administrator side: keeping the mailbox's wrapped key with a request so an uploaded certificate can be installed by the
// driver job, the validated upload, the rejection, and what the administrator's list shows. Real filesystem and real certificates.
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { ManualSigningCertificateEnrollment } from "../../src/pki/ManualSigningCertificateEnrollment.js";
import { SIGNING_ENROLLMENT_UNKNOWN } from "../../src/pki/SigningCertificateEnrollment.js";
import { createTestCa, generateCsrWithKeys, type TestCa } from "./signingCertTestUtils.js";

const WRAPPED_KEY = { ciphertext: "ct", nonce: "n", algorithm: "AES-256-GCM" } as any;

describe("ManualSigningCertificateEnrollment administrator Tests", () => {
    let tmpDir: string;
    let enrollment: ManualSigningCertificateEnrollment;
    let ca: TestCa;
    let logger: { info: ReturnType<typeof vi.fn> };

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "manualsigning-admin-"));
        ca = await createTestCa();
    });
    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });
    beforeEach(() => {
        enrollment = new ManualSigningCertificateEnrollment();
        (enrollment as any).storePath = path.join(tmpDir, `store-${Math.random()}.json`);
        logger = { info: vi.fn() };
        (enrollment as any).logger = logger;
    });

    /** A request with the mailbox's wrapped key attached (what `BaseKeyVaultRoute.startSignEnrollment()` makes). */
    const request = async (identity: string = "alice@example.com", withKey: boolean = true) => {
        const { csr } = await generateCsrWithKeys(identity);
        const { enrollmentId } = await enrollment.startEnrollment(identity, csr);
        if (withKey) {
            await enrollment.attachWrappedKey(enrollmentId, WRAPPED_KEY, { mailboxUid: "mailbox-1", masterKeyGeneration: 2 });
        }
        return { enrollmentId, csr, identity };
    };

    it("says what it is: manual, an administrator uploads, no CA - and logs that once at startup", async () => {
        expect(enrollment.kind).toBe("manual");
        expect(await enrollment.describeBackend()).toEqual({ backend: "manual", automatic: false, adminUpload: true });

        enrollment.logStartup();

        expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/issued manually.*Admin > Signing Certificates/));
    });

    it("answers an unknown id with the code a client clears a stale id by", async () => {
        for (const call of [
            () => enrollment.checkStatus("nope"),
            () => enrollment.describeProgress("nope"),
            () => enrollment.getRequest("nope"),
            () => enrollment.rejectEnrollment("nope", "x"),
            () => enrollment.markInstalled("nope"),
            () => enrollment.attachWrappedKey("nope", WRAPPED_KEY),
        ]) {
            await expect(call()).rejects.toMatchObject({ status: 404, code: SIGNING_ENROLLMENT_UNKNOWN });
        }
    });

    it("keeps the wrapped key with the mailbox binding, reports the binding, and never shows the key", async () => {
        const { enrollmentId } = await request();

        expect(await enrollment.describeEnrollment(enrollmentId)).toEqual({ identity: "alice@example.com", mailboxUid: "mailbox-1" });
        expect(await enrollment.listEnrollments()).toEqual([expect.objectContaining({ enrollmentId, mailboxUid: "mailbox-1", status: "pending" })]);
        expect(await enrollment.listPendingEnrollments()).toEqual([{ enrollmentId, identity: "alice@example.com", status: "pending", mailboxUid: "mailbox-1", hasWrappedKey: true }]);
        expect(await enrollment.getRequest(enrollmentId)).toEqual(expect.objectContaining({ mailboxUid: "mailbox-1", hasWrappedKey: true, status: "pending" }));
        expect(JSON.stringify(await enrollment.listAdminEnrollments())).not.toContain("ciphertext");
        expect(JSON.stringify(await enrollment.getRequest(enrollmentId))).not.toContain("ciphertext");

        // A binding is optional: the key alone is kept.
        const { csr } = await generateCsrWithKeys("bob@example.com");
        const bare = (await enrollment.startEnrollment("bob@example.com", csr)).enrollmentId;
        await enrollment.attachWrappedKey(bare, WRAPPED_KEY);
        expect(await enrollment.describeEnrollment(bare)).toEqual({ identity: "bob@example.com" });
    });

    it("lists what an administrator can act on, newest first, and why one cannot be uploaded to", async () => {
        const older = await request("old@example.com");
        await new Promise((resolve) => setTimeout(resolve, 5));
        const keyless = await request("keyless@example.com", false);
        const failed = await request("failed@example.com");
        await enrollment.rejectEnrollment(failed.enrollmentId, "no");

        const list = await enrollment.listAdminEnrollments();

        expect(list.map((row) => row.enrollmentId)).toEqual([keyless.enrollmentId, older.enrollmentId]);
        expect(list[0]).toEqual(expect.objectContaining({ provider: "manual", status: "pending", stage: "submitted", canUpload: false, uploadBlockedReason: expect.stringMatching(/cancel it in Settings > Encryption/) }));
        expect(list[1]).toEqual(expect.objectContaining({ identity: "old@example.com", mailboxUid: "mailbox-1", canUpload: true }));
        expect(list[1].uploadBlockedReason).toBeUndefined();
    });

    it("accepts a valid upload, then reports issued, hands the driver job the certificate and key, and stops listing it once installed", async () => {
        const { enrollmentId, csr } = await request();
        const certificate = await ca.issue(csr);
        expect(await enrollment.advanceEnrollment(enrollmentId)).toBe(false);
        expect(await enrollment.getIssuedMaterial(enrollmentId)).toBeUndefined();

        const validated = await enrollment.uploadValidatedCertificate(enrollmentId, `${certificate}\n${ca.pem}`);

        expect(validated.chainLength).toBe(2);
        expect(await enrollment.checkStatus(enrollmentId)).toEqual({ status: "issued", certificate: `${certificate}\n${ca.pem}`, error: undefined });
        expect(await enrollment.getIssuedMaterial(enrollmentId)).toEqual({ certificate: `${certificate}\n${ca.pem}`, wrappedKey: WRAPPED_KEY, mailboxUid: "mailbox-1", masterKeyGeneration: 2 });
        expect((await enrollment.listAdminEnrollments())[0]).toEqual(expect.objectContaining({ status: "issued", stage: "issued", canUpload: false }));
        expect((await enrollment.listPendingEnrollments()).map((row) => row.status)).toEqual(["issued"]);

        await enrollment.markInstalled(enrollmentId);

        expect(await enrollment.listAdminEnrollments()).toEqual([]);
        expect(await enrollment.listPendingEnrollments()).toEqual([]);
        expect(await enrollment.describeProgress(enrollmentId)).toEqual(expect.objectContaining({ status: "issued", installedAt: expect.any(String) }));
        expect(await enrollment.listEnrollments()).toEqual([expect.objectContaining({ installedAt: expect.any(String) })]);
    });

    it("refuses an upload that would not work, and changes nothing", async () => {
        const { enrollmentId, csr } = await request();
        const before: string = await fs.readFile((enrollment as any).storePath, "utf-8");

        await expect(enrollment.uploadValidatedCertificate(enrollmentId, await ca.issue(csr, { email: "other@example.com" }))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/not for alice@example.com/) });
        await expect(enrollment.uploadValidatedCertificate(enrollmentId, await ca.issue(csr, { eku: false }))).rejects.toMatchObject({ status: 400 });
        await expect(enrollment.uploadValidatedCertificate(enrollmentId, undefined)).rejects.toMatchObject({ status: 400 });
        await expect(enrollment.uploadValidatedCertificate("nope", "x")).rejects.toMatchObject({ status: 404, code: SIGNING_ENROLLMENT_UNKNOWN });

        expect(await fs.readFile((enrollment as any).storePath, "utf-8")).toBe(before);
    });

    it("refuses an upload for a request that holds no key (made before keys were kept) or is no longer pending", async () => {
        const keyless = await request("keyless@example.com", false);
        await expect(enrollment.uploadValidatedCertificate(keyless.enrollmentId, await ca.issue(keyless.csr))).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/cancel it in Settings/) });

        const done = await request("done@example.com");
        await enrollment.uploadValidatedCertificate(done.enrollmentId, await ca.issue(done.csr));
        await expect(enrollment.uploadValidatedCertificate(done.enrollmentId, await ca.issue(done.csr))).rejects.toMatchObject({ status: 409, message: "This request is already issued." });
        await expect(enrollment.uploadCertificate(done.enrollmentId, await ca.issue(done.csr))).rejects.toMatchObject({ status: 409, message: "This enrollment is already issued." });

        const gone = await request("gone@example.com");
        await enrollment.rejectEnrollment(gone.enrollmentId, "no");
        await expect(enrollment.uploadValidatedCertificate(gone.enrollmentId, await ca.issue(gone.csr))).rejects.toMatchObject({ status: 409, message: "This request is already closed." });
        await expect(enrollment.uploadCertificate(gone.enrollmentId, await ca.issue(gone.csr))).rejects.toMatchObject({ status: 409, message: "This enrollment is already closed." });
    });

    it("rejects a pending request with a reason the owner reads, once", async () => {
        const { enrollmentId } = await request();

        await enrollment.rejectEnrollment(enrollmentId, "Rejected by an administrator: not our employee");

        expect(await enrollment.describeProgress(enrollmentId)).toEqual(
            expect.objectContaining({ provider: "manual", status: "failed", error: "Rejected by an administrator: not our employee", errorCode: "rejected", retryable: true }),
        );
        await expect(enrollment.rejectEnrollment(enrollmentId, "again")).rejects.toMatchObject({ status: 409, message: "This request is already closed." });
        const uploaded = await request("up@example.com");
        await enrollment.uploadValidatedCertificate(uploaded.enrollmentId, await ca.issue(uploaded.csr));
        await expect(enrollment.rejectEnrollment(uploaded.enrollmentId, "late")).rejects.toMatchObject({ status: 409, message: "This request is already issued." });
    });

    it("cancels an uploaded certificate that is not installed yet (so nothing is installed from it), but not one that is, nor one with no key to install", async () => {
        const waiting = await request("waiting@example.com");
        await enrollment.uploadValidatedCertificate(waiting.enrollmentId, await ca.issue(waiting.csr));
        await enrollment.cancelEnrollment(waiting.enrollmentId, "Cancelled by the mailbox owner.");
        expect(await enrollment.describeProgress(waiting.enrollmentId)).toEqual(expect.objectContaining({ status: "failed", errorCode: "cancelled" }));
        expect(await enrollment.getIssuedMaterial(waiting.enrollmentId)).toBeUndefined();

        const installed = await request("installed@example.com");
        await enrollment.uploadValidatedCertificate(installed.enrollmentId, await ca.issue(installed.csr));
        await enrollment.markInstalled(installed.enrollmentId);
        await enrollment.cancelEnrollment(installed.enrollmentId, "late");
        expect((await enrollment.describeProgress(installed.enrollmentId)).status).toBe("issued");

        const keyless = await request("keyless@example.com", false);
        await enrollment.uploadCertificate(keyless.enrollmentId, await ca.issue(keyless.csr));
        await enrollment.cancelEnrollment(keyless.enrollmentId, "late");
        expect((await enrollment.describeProgress(keyless.enrollmentId)).status).toBe("issued");
    });
});
