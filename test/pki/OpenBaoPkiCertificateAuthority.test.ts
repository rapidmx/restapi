///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests - the global `fetch` is stubbed so no real Vault/OpenBao server is required, same
// convention as test/util/KeyDiscoveryClient.test.ts. A real (locally self-signed) certificate is generated
// once to stand in for "the PEM Vault/OpenBao would have returned", since the code under test parses whatever
// PEM comes back to compute a fingerprint/read notBefore-notAfter.
import "reflect-metadata";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as x509 from "@peculiar/x509";
import { OpenBaoPkiCertificateAuthority } from "../../src/pki/OpenBaoPkiCertificateAuthority.js";
import { IssuedCertificate } from "../../src/pki/EncryptionCertificateAuthority.js";

x509.cryptoProvider.set(crypto);

async function makeSignedCertPem(cn: string): Promise<{ pem: string; serialNumber: string }> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: `CN=${cn}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return { pem: cert.toString("pem"), serialNumber: cert.serialNumber };
}

function makeFetchResponse(overrides: any = {}) {
    return { ok: true, status: 200, json: vi.fn().mockResolvedValue({}), text: vi.fn().mockResolvedValue(""), ...overrides };
}

describe("OpenBaoPkiCertificateAuthority Tests", () => {
    let tmpDir: string;
    let authority: OpenBaoPkiCertificateAuthority;
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openbaopki-test-"));
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        authority = new OpenBaoPkiCertificateAuthority();
        (authority as any).address = "https://vault.example.com:8200";
        (authority as any).mount = "pki";
        (authority as any).role = "rapidmx";
        (authority as any).token = "test-token";
        (authority as any).serialMapPath = path.join(tmpDir, `serials-${Math.random()}.json`);
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    it("Reports its own name.", () => {
        expect(authority.name).toBe("openbao-pki");
    });

    it("issue() posts the CSR + common_name to POST /v1/<mount>/sign/<role> and maps the response.", async () => {
        const { pem, serialNumber } = await makeSignedCertPem("alice@example.com");
        mockFetch.mockResolvedValue(
            makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }),
        );

        const result: IssuedCertificate = await authority.issue("alice@example.com", "the-csr-pem");

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe("https://vault.example.com:8200/v1/pki/sign/rapidmx");
        expect(init.method).toBe("POST");
        expect(init.headers["X-Vault-Token"]).toBe("test-token");
        expect(JSON.parse(init.body)).toEqual({ csr: "the-csr-pem", common_name: "alice@example.com" });

        expect(result.certificate).toBe(pem);
        expect(result.serialNumber).toBe(serialNumber);
        expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it("Strips a trailing slash from a configured address before building the request URL.", async () => {
        (authority as any).address = "https://vault.example.com:8200/";
        const { pem, serialNumber } = await makeSignedCertPem("bob@example.com");
        mockFetch.mockResolvedValue(
            makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }),
        );

        await authority.issue("bob@example.com", "csr");

        expect(mockFetch.mock.calls[0][0]).toBe("https://vault.example.com:8200/v1/pki/sign/rapidmx");
    });

    it("Records the fingerprint -> serial number mapping to disk so a later revoke() can find it.", async () => {
        const { pem, serialNumber } = await makeSignedCertPem("carol@example.com");
        mockFetch.mockResolvedValue(
            makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }),
        );
        const issued: IssuedCertificate = await authority.issue("carol@example.com", "csr");

        const map = JSON.parse(await fs.readFile((authority as any).serialMapPath, "utf-8"));
        expect(map[issued.fingerprint]).toBe(serialNumber);
    });

    it("Throws a 502 when the server response is missing a certificate or serial number.", async () => {
        mockFetch.mockResolvedValue(makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: {} }) }));
        await expect(authority.issue("dave@example.com", "csr")).rejects.toThrow(/incomplete response/);
    });

    it("Throws a 502 when the server responds with a non-2xx status.", async () => {
        mockFetch.mockResolvedValue(makeFetchResponse({ ok: false, status: 403, text: vi.fn().mockResolvedValue("permission denied") }));
        await expect(authority.issue("erin@example.com", "csr")).rejects.toThrow(/rejected the request/);
    });

    it("Throws a 502 when the underlying fetch itself rejects (server unreachable).", async () => {
        mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
        await expect(authority.issue("frank@example.com", "csr")).rejects.toThrow(/could not be reached/);
    });

    it("Falls back to an empty detail string when reading the error response body itself fails.", async () => {
        mockFetch.mockResolvedValue(makeFetchResponse({ ok: false, status: 500, text: vi.fn().mockRejectedValue(new Error("stream closed")) }));
        await expect(authority.issue("gina@example.com", "csr")).rejects.toThrow(/rejected the request/);
    });

    it("Aborts the request once the configured timeout elapses, surfacing as 'could not be reached'.", async () => {
        vi.useFakeTimers();
        try {
            (authority as any).timeoutMs = 5000;
            mockFetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
                return new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
                });
            });

            const resultPromise = authority.issue("henry@example.com", "csr");
            const assertion = expect(resultPromise).rejects.toThrow(/could not be reached/);
            await vi.advanceTimersByTimeAsync(5000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });

    it("revoke() looks up the recorded serial number and posts it to POST /v1/<mount>/revoke.", async () => {
        const { pem, serialNumber } = await makeSignedCertPem("grace@example.com");
        mockFetch.mockResolvedValueOnce(
            makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }),
        );
        const issued: IssuedCertificate = await authority.issue("grace@example.com", "csr");

        mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: {} }) }));
        await authority.revoke(issued.fingerprint);

        expect(mockFetch).toHaveBeenCalledTimes(2);
        const [url, init] = mockFetch.mock.calls[1];
        expect(url).toBe("https://vault.example.com:8200/v1/pki/revoke");
        expect(JSON.parse(init.body)).toEqual({ serial_number: serialNumber });
    });

    it("revoke() throws 404 for a fingerprint this instance never recorded a serial number for.", async () => {
        await expect(authority.revoke("unknown-fingerprint")).rejects.toThrow(/No certificate with fingerprint/);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("Treats a missing serial map file as an empty map rather than throwing.", async () => {
        (authority as any).serialMapPath = path.join(tmpDir, "does-not-exist.json");
        await expect(authority.revoke("anything")).rejects.toThrow(/No certificate with fingerprint/);
    });

    it("Rethrows a filesystem error other than ENOENT while reading the serial map.", async () => {
        const dirAsFile: string = path.join(tmpDir, "a-directory-not-a-file.json");
        await fs.mkdir(dirAsFile, { recursive: true });
        (authority as any).serialMapPath = dirAsFile;

        await expect(authority.revoke("anything")).rejects.toThrow();
    });
});
