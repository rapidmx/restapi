///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real filesystem, real CSR crypto (mirroring test/pki/ManualSigningCertificateEnrollment.test.ts's own
// convention) - only the `acme-client` `Client` itself is faked, since driving a real ACME CA over the
// network is neither deterministic nor appropriate for a unit test.
import "reflect-metadata";
// Node's `crypto` module (for `createHash`) is imported under its own name, NOT `crypto` - the
// ambient global `crypto` (WebCrypto) is what `x509.cryptoProvider.set()`/`crypto.subtle` below need -
// see `Rfc8823AcmeSigningCertificateEnrollment.ts`'s identical note.
import * as nodeCrypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as x509 from "@peculiar/x509";
import { Rfc8823AcmeSigningCertificateEnrollment } from "../../src/pki/Rfc8823AcmeSigningCertificateEnrollment.js";
import { EnrollmentResult } from "../../src/pki/SigningCertificateEnrollment.js";

x509.cryptoProvider.set(crypto);

async function generateCsr(identity: string): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
        name: `CN=${identity}`,
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return csr.toString("pem");
}

/** A fake `acme-client` `Client` - enough of its surface for `Rfc8823AcmeSigningCertificateEnrollment`
 * to drive an entire enrollment without any real network call. `createAccountCallCount` lets tests
 * assert a persisted account is reused rather than re-registered. */
class FakeAcmeClient {
    public static createAccountCallCount = 0;
    public static challengeOverride: any = undefined;

    constructor(public opts: any) {}

    public getAccountUrl(): string {
        return "https://acme.test/acct/1";
    }

    public async createAccount(_data?: any): Promise<any> {
        FakeAcmeClient.createAccountCallCount++;
        return { status: "valid", orders: "https://acme.test/acct/1/orders" };
    }

    public async createOrder(data: any): Promise<any> {
        return {
            url: "https://acme.test/order/1",
            status: "pending",
            identifiers: data.identifiers,
            authorizations: ["https://acme.test/authz/1"],
            finalize: "https://acme.test/order/1/finalize",
        };
    }

    public async getAuthorizations(_order: any): Promise<any[]> {
        const challenge = FakeAcmeClient.challengeOverride ?? {
            type: "email-reply-00",
            url: "https://acme.test/chall/1",
            status: "pending",
            from: "acme-challenge+abc123@acme.test",
            token: "token-part-2-value",
        };
        return [
            {
                url: "https://acme.test/authz/1",
                status: "pending",
                identifier: { type: "email", value: "alice@example.com" },
                challenges: [challenge],
            },
        ];
    }

    public async getChallengeKeyAuthorization(challenge: any): Promise<string> {
        if (challenge.type !== "http-01") {
            throw new Error(`Unable to produce key authorization, unknown challenge type: ${challenge.type}`);
        }
        return `${challenge.token}.test-account-thumbprint`;
    }
}

class TestEnrollment extends Rfc8823AcmeSigningCertificateEnrollment {
    protected createClient(opts: any): any {
        return new FakeAcmeClient(opts);
    }
}

describe("Rfc8823AcmeSigningCertificateEnrollment Tests", () => {
    let tmpDir: string;
    let enrollment: TestEnrollment;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfc8823-test-"));
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        FakeAcmeClient.createAccountCallCount = 0;
        FakeAcmeClient.challengeOverride = undefined;
        enrollment = new TestEnrollment();
        (enrollment as any).storeDir = path.join(tmpDir, `store-${Math.random()}`);
    });

    it("Reports its own name.", () => {
        expect(enrollment.name).toBe("rfc8823-acme");
    });

    it("startEnrollment() persists a pending enrollment for a valid CSR and returns an id.", async () => {
        const csr: string = await generateCsr("alice@example.com");

        const { enrollmentId } = await enrollment.startEnrollment("alice@example.com", csr);

        expect(enrollmentId).toBeTruthy();
        const status: EnrollmentResult = await enrollment.checkStatus(enrollmentId);
        expect(status).toEqual({ status: "pending", certificate: undefined, error: undefined });
        expect(FakeAcmeClient.createAccountCallCount).toBe(1);
    });

    it("Rejects a CSR that cannot be parsed.", async () => {
        await expect(enrollment.startEnrollment("bad@example.com", "not a csr")).rejects.toThrow(/could not be parsed/);
    });

    it("Rejects a CSR whose self-signature does not verify.", async () => {
        const csrPem: string = await generateCsr("tampered@example.com");
        const tamperedBytes = Buffer.from(x509.PemConverter.decodeFirst(csrPem));
        tamperedBytes[tamperedBytes.length - 5] ^= 0xff;
        const tamperedPem: string = x509.PemConverter.encode(tamperedBytes, "CERTIFICATE REQUEST");

        await expect(enrollment.startEnrollment("tampered@example.com", tamperedPem)).rejects.toThrow(
            /self-signature does not verify/,
        );
    });

    it("Rejects an order whose authorization offers no email-reply-00 challenge.", async () => {
        FakeAcmeClient.challengeOverride = { type: "http-01", url: "https://acme.test/chall/1", status: "pending", token: "x" };
        const csr: string = await generateCsr("nofallback@example.com");

        await expect(enrollment.startEnrollment("nofallback@example.com", csr)).rejects.toThrow(
            /did not offer an email-reply-00 challenge/,
        );
    });

    it("checkStatus() throws 404 for an unknown enrollment id.", async () => {
        await expect(enrollment.checkStatus("does-not-exist")).rejects.toThrow(/No enrollment found/);
    });

    it("Reuses a persisted ACME account across enrollments instead of re-registering.", async () => {
        const csrA: string = await generateCsr("a@example.com");
        const csrB: string = await generateCsr("b@example.com");

        await enrollment.startEnrollment("a@example.com", csrA);
        await enrollment.startEnrollment("b@example.com", csrB);

        expect(FakeAcmeClient.createAccountCallCount).toBe(1);
    });

    it("Reuses a persisted ACME account across separate instances pointed at the same store.", async () => {
        const csr: string = await generateCsr("carried@example.com");
        await enrollment.startEnrollment("carried@example.com", csr);

        const other = new TestEnrollment();
        (other as any).storeDir = (enrollment as any).storeDir;
        await other.startEnrollment("carried2@example.com", await generateCsr("carried2@example.com"));

        expect(FakeAcmeClient.createAccountCallCount).toBe(1);
    });

    describe("recordChallengeToken()", () => {
        it("Computes and persists the RFC 8823 digest from token-part1 + token-part2.", async () => {
            const csr: string = await generateCsr("digest@example.com");
            const { enrollmentId } = await enrollment.startEnrollment("digest@example.com", csr);

            await enrollment.recordChallengeToken(
                enrollmentId,
                "token-part-1-value",
                "reply-to@acme.test",
                "<challenge-message-id@acme.test>",
                "ACME: token-part-1-value",
            );

            const expectedKeyAuthorization = "token-part-1-valuetoken-part-2-value.test-account-thumbprint";
            const expectedDigest: string = nodeCrypto.createHash("sha256").update(expectedKeyAuthorization).digest("base64url");

            const storePath: string = path.join((enrollment as any).storeDir, "enrollments.json");
            const store = JSON.parse(await fs.readFile(storePath, "utf-8"));
            expect(store[enrollmentId].digest).toBe(expectedDigest);
            expect(store[enrollmentId].tokenPart1).toBe("token-part-1-value");
            expect(store[enrollmentId].replyTo).toBe("reply-to@acme.test");
            expect(store[enrollmentId].challengeMessageId).toBe("<challenge-message-id@acme.test>");
            expect(store[enrollmentId].challengeSubject).toBe("ACME: token-part-1-value");
        });

        it("Is idempotent - a second call with a different token-part1 leaves the first recorded value untouched.", async () => {
            const csr: string = await generateCsr("idempotent@example.com");
            const { enrollmentId } = await enrollment.startEnrollment("idempotent@example.com", csr);

            await enrollment.recordChallengeToken(enrollmentId, "first-token", "reply@acme.test", "<id1@acme.test>", "ACME: first-token");
            await enrollment.recordChallengeToken(enrollmentId, "second-token", "other@acme.test", "<id2@acme.test>", "ACME: second-token");

            const storePath: string = path.join((enrollment as any).storeDir, "enrollments.json");
            const store = JSON.parse(await fs.readFile(storePath, "utf-8"));
            expect(store[enrollmentId].tokenPart1).toBe("first-token");
            expect(store[enrollmentId].replyTo).toBe("reply@acme.test");
        });

        it("Throws 404 for an unknown enrollment id.", async () => {
            await expect(
                enrollment.recordChallengeToken("does-not-exist", "token", "reply@acme.test", "<id@acme.test>", "ACME: token"),
            ).rejects.toThrow(/No enrollment found/);
        });
    });

    it("Creates the store directory if it doesn't exist yet.", async () => {
        const nestedDir: string = path.join(tmpDir, "nested", "dir", "store");
        const nested = new TestEnrollment();
        (nested as any).storeDir = nestedDir;

        await nested.startEnrollment("nested@example.com", await generateCsr("nested@example.com"));

        await expect(fs.access(path.join(nestedDir, "enrollments.json"))).resolves.toBeUndefined();
    });

    it("Rethrows a filesystem error other than ENOENT while reading the enrollment store.", async () => {
        const storeDir: string = path.join(tmpDir, `store-nonenoent-${Math.random()}`);
        // A directory at the exact path `loadStore()` tries to `readFile()` gives EISDIR, not ENOENT -
        // unlike a merely-missing file (which the "happy path" tests already cover via plain ENOENT).
        await fs.mkdir(path.join(storeDir, "enrollments.json"), { recursive: true });
        (enrollment as any).storeDir = storeDir;

        await expect(enrollment.checkStatus("anything")).rejects.toThrow();
    });

    it("Rethrows a filesystem error other than ENOENT while reading a persisted ACME account.", async () => {
        const storeDir: string = path.join(tmpDir, `store-account-nonenoent-${Math.random()}`);
        // Directories at both exact paths `ensureAccount()` tries to `readFile()` give EISDIR on both
        // sides of its `Promise.all()`, not ENOENT - unlike the "neither file exists yet" happy path
        // the other tests already cover.
        await Promise.all([
            fs.mkdir(path.join(storeDir, "account.key.pem"), { recursive: true }),
            fs.mkdir(path.join(storeDir, "account.url"), { recursive: true }),
        ]);
        (enrollment as any).storeDir = storeDir;

        await expect(enrollment.startEnrollment("x@example.com", await generateCsr("x@example.com"))).rejects.toThrow();
    });

    it("Passes a configured contact email through to account registration as a mailto: URI.", async () => {
        const captured: any[] = [];
        class CapturingClient extends FakeAcmeClient {
            public async createAccount(data?: any): Promise<any> {
                captured.push(data);
                return super.createAccount(data);
            }
        }
        class CapturingEnrollment extends Rfc8823AcmeSigningCertificateEnrollment {
            protected createClient(opts: any): any {
                return new CapturingClient(opts);
            }
        }
        const capturing = new CapturingEnrollment();
        (capturing as any).storeDir = (enrollment as any).storeDir;
        (capturing as any).contactEmail = "admin@example.com";

        await capturing.startEnrollment("contact@example.com", await generateCsr("contact@example.com"));

        expect(captured).toHaveLength(1);
        expect(captured[0].contact).toEqual(["mailto:admin@example.com"]);
    });

    it("createClient() constructs a real acme-client Client instance.", () => {
        const real = new Rfc8823AcmeSigningCertificateEnrollment();
        const client: any = (real as any).createClient({ directoryUrl: "https://example.test/directory", accountKey: "dummy-key" });

        expect(client).toBeDefined();
        expect(typeof client.createOrder).toBe("function");
    });

    it("Recovers when two enrollments race to register the shared ACME account for the first time.", async () => {
        const csrA: string = await generateCsr("race-a@example.com");
        const csrB: string = await generateCsr("race-b@example.com");

        const [resultA, resultB] = await Promise.all([
            enrollment.startEnrollment("race-a@example.com", csrA),
            enrollment.startEnrollment("race-b@example.com", csrB),
        ]);

        expect(resultA.enrollmentId).toBeTruthy();
        expect(resultB.enrollmentId).toBeTruthy();
        await expect(fs.access(path.join((enrollment as any).storeDir, "account.key.pem"))).resolves.toBeUndefined();
        await expect(fs.access(path.join((enrollment as any).storeDir, "account.url"))).resolves.toBeUndefined();
    });
});
