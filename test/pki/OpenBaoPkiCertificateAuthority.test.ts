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

/** A certificate for `identity` (a self-signed stand-in for what the CA returns) and the CSR for the same key. */
async function makeSignedCertPem(
    cn: string,
    options: { names?: x509.JsonGeneralName[]; subject?: string; otherKey?: boolean } = {},
): Promise<{ pem: string; serialNumber: string; csr: string }> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const names: x509.JsonGeneralName[] = options.names ?? [{ type: "email", value: cn }];
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: options.subject ?? `CN=${cn}`,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions: names.length > 0 ? [new x509.SubjectAlternativeNameExtension(names)] : [],
    });
    const requestKeys: CryptoKeyPair = options.otherKey ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) : keys;
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({ name: `CN=${cn}`, keys: requestKeys, signingAlgorithm: { name: "ECDSA", hash: "SHA-256" } });
    return { pem: cert.toString("pem"), serialNumber: cert.serialNumber, csr: csr.toString("pem") };
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
        const { pem, serialNumber, csr } = await makeSignedCertPem("alice@example.com");
        mockFetch.mockResolvedValue(
            makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }),
        );

        const result: IssuedCertificate = await authority.issue("alice@example.com", csr);

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe("https://vault.example.com:8200/v1/pki/sign/rapidmx");
        expect(init.method).toBe("POST");
        expect(init.headers["X-Vault-Token"]).toBe("test-token");
        expect(JSON.parse(init.body)).toEqual({ csr, common_name: "alice@example.com" });

        expect(result.certificate).toBe(pem);
        expect(result.serialNumber).toBe(serialNumber);
        expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    it("issue() maps the issuing CA from issuing_ca, else the first ca_chain entry, and omits it when neither is present.", async () => {
        const { pem, serialNumber, csr } = await makeSignedCertPem("dave@example.com");
        const { pem: issuingCa } = await makeSignedCertPem("Issuing CA");
        const { pem: rootCa } = await makeSignedCertPem("Root CA");
        const respond = (data: Record<string, unknown>) =>
            mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber, ...data } }) }));

        respond({ issuing_ca: issuingCa, ca_chain: [rootCa] });
        expect((await authority.issue("dave@example.com", csr)).issuerCertificate).toBe(issuingCa);

        respond({ ca_chain: [issuingCa, rootCa] });
        expect((await authority.issue("dave@example.com", csr)).issuerCertificate).toBe(issuingCa);

        respond({ issuing_ca: "", ca_chain: [] });
        const none: IssuedCertificate = await authority.issue("dave@example.com", csr);
        expect(none.issuerCertificate).toBeUndefined();
        expect("issuerCertificate" in none).toBe(false);

        respond({ ca_chain: "not-a-list" });
        expect((await authority.issue("dave@example.com", csr)).issuerCertificate).toBeUndefined();
    });

    it("Strips a trailing slash from a configured address before building the request URL.", async () => {
        (authority as any).address = "https://vault.example.com:8200/";
        const { pem, serialNumber, csr } = await makeSignedCertPem("bob@example.com");
        mockFetch.mockResolvedValue(
            makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }),
        );

        await authority.issue("bob@example.com", csr);

        expect(mockFetch.mock.calls[0][0]).toBe("https://vault.example.com:8200/v1/pki/sign/rapidmx");
    });

    it("Records the fingerprint -> serial number mapping to disk so a later revoke() can find it.", async () => {
        const { pem, serialNumber, csr } = await makeSignedCertPem("carol@example.com");
        mockFetch.mockResolvedValue(
            makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }),
        );
        const issued: IssuedCertificate = await authority.issue("carol@example.com", csr);

        const map = JSON.parse(await fs.readFile((authority as any).serialMapPath, "utf-8"));
        expect(map[issued.fingerprint]).toBe(serialNumber);
    });

    it("Concurrent issue() calls across two instances sharing a serial map never lose an entry.", async () => {
        const other = new OpenBaoPkiCertificateAuthority();
        Object.assign(other as any, {
            address: (authority as any).address,
            mount: "pki",
            role: "rapidmx",
            token: "test-token",
            serialMapPath: (authority as any).serialMapPath,
        });
        const certs = await Promise.all(Array.from({ length: 10 }, (_, i) => makeSignedCertPem(`bulk${i}@example.com`)));
        let next = 0;
        mockFetch.mockImplementation(async () => {
            const cert = certs[next++];
            return makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: cert.pem, serial_number: cert.serialNumber } }) });
        });

        const issued: IssuedCertificate[] = await Promise.all(certs.map((_, i) => (i % 2 ? other : authority).issue(`bulk${i}@example.com`, certs[i].csr)));

        const map = JSON.parse(await fs.readFile((authority as any).serialMapPath, "utf-8"));
        expect(Object.keys(map)).toHaveLength(10);
        for (const result of issued) {
            expect(map[result.fingerprint]).toBe(result.serialNumber);
        }
    });

    it("A failed recordSerial() write doesn't block the next issue() call.", async () => {
        const dirAsFile: string = path.join(tmpDir, `a-directory-not-a-file-${Math.random()}.json`);
        await fs.mkdir(dirAsFile, { recursive: true });
        (authority as any).serialMapPath = dirAsFile;

        const first = await makeSignedCertPem("ivy@example.com");
        mockFetch.mockResolvedValue(
            makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: first.pem, serial_number: first.serialNumber } }) }),
        );
        await expect(authority.issue("ivy@example.com", first.csr)).rejects.toThrow();

        const validPath: string = path.join(tmpDir, `serials-recovered-${Math.random()}.json`);
        (authority as any).serialMapPath = validPath;
        const second = await makeSignedCertPem("jack@example.com");
        mockFetch.mockResolvedValue(
            makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: second.pem, serial_number: second.serialNumber } }) }),
        );
        const issued: IssuedCertificate = await authority.issue("jack@example.com", second.csr);

        const map = JSON.parse(await fs.readFile(validPath, "utf-8"));
        expect(map[issued.fingerprint]).toBe(second.serialNumber);
    });

    describe("a certificate that is not the one asked for", () => {
        const respond = (cert: { pem: string; serialNumber: string }) =>
            mockFetch.mockResolvedValueOnce(makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: cert.pem, serial_number: cert.serialNumber } }) }));

        it.each([
            ["another address in its subjectAltName", { names: [{ type: "email", value: "victim@example.com" } as x509.JsonGeneralName] }],
            ["an extra address beside the right one", { names: [{ type: "email", value: "mallory@example.com" }, { type: "email", value: "victim@example.com" }] as x509.JsonGeneralName[] }],
            ["a DNS name beside the right address", { names: [{ type: "email", value: "mallory@example.com" }, { type: "dns", value: "evil.example.com" }] as x509.JsonGeneralName[] }],
            ["only a DNS name", { names: [{ type: "dns", value: "mallory@example.com" }] as x509.JsonGeneralName[] }],
            ["another common name", { subject: "CN=victim@example.com" }],
            ["a different key from the CSR's", { otherKey: true }],
            ["no name at all", { names: [], subject: "CN=someone else" }],
        ])("Revokes and refuses a certificate with %s, recording nothing.", async (_label, options) => {
            const cert = await makeSignedCertPem("mallory@example.com", options);
            respond(cert);
            mockFetch.mockResolvedValueOnce(makeFetchResponse());
            await expect(authority.issue("mallory@example.com", cert.csr)).rejects.toThrow(/does not match the request/);
            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(mockFetch.mock.calls[1][0]).toBe("https://vault.example.com:8200/v1/pki/revoke");
            expect(JSON.parse(mockFetch.mock.calls[1][1].body)).toEqual({ serial_number: cert.serialNumber });
            await expect(fs.readFile((authority as any).serialMapPath)).rejects.toThrow();
        });

        it("Refuses a CSR that does not parse, and still refuses when the revocation itself fails.", async () => {
            const cert = await makeSignedCertPem("mallory@example.com");
            respond(cert);
            mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
            await expect(authority.issue("mallory@example.com", "not a csr")).rejects.toThrow(/does not match the request/);
        });

        it("Accepts the right address in any case, and a certificate without subjectAltNames that names it as its common name or e-mail field.", async () => {
            const upper = await makeSignedCertPem("Alice@Example.com");
            respond(upper);
            await expect(authority.issue("alice@example.com", upper.csr)).resolves.toBeDefined();
            const bare = await makeSignedCertPem("bare@example.com", { names: [] });
            respond(bare);
            await expect(authority.issue("bare@example.com", bare.csr)).resolves.toBeDefined();
            const emailField = await makeSignedCertPem("mail@example.com", { names: [], subject: "E=mail@example.com" });
            respond(emailField);
            await expect(authority.issue("mail@example.com", emailField.csr)).resolves.toBeDefined();
        });
    });

    it("Sends no redirect-following request, and takes the bracketed IPv6 loopback as loopback.", async () => {
        (authority as any).address = "http://[::1]:8200";
        const { pem, serialNumber, csr } = await makeSignedCertPem("v6@example.com");
        mockFetch.mockResolvedValue(makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }));
        await authority.issue("v6@example.com", csr);
        expect(mockFetch.mock.calls[0][1].redirect).toBe("error");
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
        const { pem, serialNumber, csr } = await makeSignedCertPem("grace@example.com");
        mockFetch.mockResolvedValueOnce(
            makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }),
        );
        const issued: IssuedCertificate = await authority.issue("grace@example.com", csr);

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

    describe("assertSafeAddress()", () => {
        it("Rejects a configured address that isn't a valid URL at all.", async () => {
            (authority as any).address = "not a url";
            await expect(authority.issue("x@example.com", "csr")).rejects.toThrow(/is not a valid URL/);
            expect(mockFetch).not.toHaveBeenCalled();
        });

        it("Accepts an https:// address unconditionally.", async () => {
            const { pem, serialNumber, csr } = await makeSignedCertPem("https-ok@example.com");
            mockFetch.mockResolvedValue(
                makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }),
            );
            await expect(authority.issue("https-ok@example.com", csr)).resolves.toBeDefined();
        });

        it("Accepts a plaintext http:// address only when it targets loopback (127.0.0.1/::1/localhost).", async () => {
            const { pem, serialNumber, csr } = await makeSignedCertPem("loopback-ok@example.com");
            mockFetch.mockResolvedValue(
                makeFetchResponse({ json: vi.fn().mockResolvedValue({ data: { certificate: pem, serial_number: serialNumber } }) }),
            );
            (authority as any).address = "http://127.0.0.1:8200";
            await expect(authority.issue("loopback-ok@example.com", csr)).resolves.toBeDefined();
        });

        it("Rejects a plaintext http:// address pointed at a non-loopback host - refuses to leak the Vault token over the network.", async () => {
            (authority as any).address = "http://vault.internal.example.com:8200";
            await expect(authority.issue("x@example.com", "csr")).rejects.toThrow(/must use https/);
            expect(mockFetch).not.toHaveBeenCalled();
        });
    });
});
