///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as x509 from "@peculiar/x509";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { EncryptionCertificateAuthority, IssuedCertificate } from "./EncryptionCertificateAuthority.js";
import { readFileIfExists, updateJsonFile } from "./FileStoreUtils.js";
const { Config, Logger } = ObjectDecorators;

/** Default HTTP request timeout (ms) for calls to the PKI server. */
const DEFAULT_TIMEOUT_MS = 10_000;

interface SignResponse {
    data?: {
        certificate?: string;
        serial_number?: string;
    };
}

/**
 * `EncryptionCertificateAuthority` backed by a self-hosted [OpenBao](https://openbao.org/) (or Vault
 * Community Edition - the two share an identical public PKI HTTP API) instance's PKI secrets engine - the
 * recommended production backend for this interface, the same way `PostfixSendmailTransport` is the
 * recommended real `MailTransport`. Genuinely free and self-hosted, deliberately steering clear of a paid
 * vendor-contract dependency: `issue()` posts the CSR straight through to `POST /v1/<mount>/sign/<role>`
 * (request takes `csr` + `common_name`, response returns `certificate`/`serial_number`, per Vault/OpenBao's
 * public PKI API reference) and `revoke()` calls `POST /v1/<mount>/revoke` - the server's own CRL/OCSP
 * responder then reflects the revocation automatically, with no bespoke revocation-list code needed here.
 *
 * **Fingerprint-to-serial-number bookkeeping**: this interface's `revoke()` identifies a certificate by SHA-256
 * fingerprint (the identifier a discovery response uses), but Vault/OpenBao's own revoke endpoint identifies
 * a certificate by serial number instead. Rather than pushing that translation onto every caller of this
 * interface (Group C/D, the eventual key-vault data model/route, haven't landed yet and shouldn't need to know
 * this backend's own addressing scheme), this class persists a small local `fingerprint -> serialNumber` map
 * to disk itself, written on every successful `issue()` - the same "own a small piece of local state on disk"
 * shape `LocalX509CertificateAuthority` already uses for its CA key, just for a different purpose here.
 *
 * This app never manages the PKI server's own auth lifecycle (token renewal, AppRole, etc.) any more than
 * `PostfixSendmailTransport` manages Postfix's - a deployment's existing secrets-management story is
 * responsible for keeping `mail:pki:openbao:token` current.
 *
 * @author Jean-Philippe Steinmetz
 */
export class OpenBaoPkiCertificateAuthority implements EncryptionCertificateAuthority {
    public readonly name: string = "openbao-pki";

    @Config("mail:pki:openbao:address", "http://127.0.0.1:8200")
    private address: string = "http://127.0.0.1:8200";

    @Config("mail:pki:openbao:mount", "pki")
    private mount: string = "pki";

    @Config("mail:pki:openbao:role", "rapidmx")
    private role: string = "rapidmx";

    @Config("mail:pki:openbao:token", "")
    private token: string = "";

    @Config("mail:pki:openbao:timeout_ms", DEFAULT_TIMEOUT_MS)
    private timeoutMs: number = DEFAULT_TIMEOUT_MS;

    @Config("mail:pki:openbao:serial_map_path", "/var/lib/rapidmx/pki/openbao-serials.json")
    private serialMapPath: string = "/var/lib/rapidmx/pki/openbao-serials.json";

    @Logger
    private logger: any;

    /** `mail:pki:openbao:address` defaults to loopback, which is a safe default, but nothing previously
     * stopped it from being pointed at a remote, non-TLS address - `request()` always sends `X-Vault-Token`
     * (a live PKI-signing credential) as a plain header, so a plaintext `http://` address anywhere off
     * loopback would leak that token to the network on every call. Rejects anything else: a non-`https://`
     * scheme is only ever acceptable talking to this same host. */
    private assertSafeAddress(): void {
        let parsed: URL;
        try {
            parsed = new URL(this.address);
        } catch {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 500, `mail:pki:openbao:address ('${this.address}') is not a valid URL.`);
        }
        if (parsed.protocol === "https:") {
            return;
        }
        const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
        if (parsed.protocol === "http:" && loopbackHosts.has(parsed.hostname)) {
            return;
        }
        throw new ApiError(
            ApiErrors.INTERNAL_ERROR,
            500,
            "mail:pki:openbao:address must use https:// unless it targets loopback - refusing to send the " +
                "configured Vault token over plaintext HTTP to a non-loopback host.",
        );
    }

    private async request<T>(urlPath: string, body: Record<string, unknown>): Promise<T> {
        this.assertSafeAddress();
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
        let response: Response;
        try {
            response = await fetch(`${this.address.replace(/\/+$/, "")}/v1/${urlPath}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Vault-Token": this.token,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
        } catch (err: any) {
            this.logger?.error(`OpenBaoPkiCertificateAuthority: request to '${urlPath}' failed: ${err.message}`);
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "The configured PKI server could not be reached.");
        } finally {
            clearTimeout(timeoutHandle);
        }

        if (!response.ok) {
            const detail: string = await response.text().catch(() => "");
            this.logger?.error(`OpenBaoPkiCertificateAuthority: '${urlPath}' returned ${response.status}: ${detail}`);
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "The configured PKI server rejected the request.");
        }
        return (await response.json()) as T;
    }

    private async loadSerialMap(): Promise<Record<string, string>> {
        const raw: string | undefined = await readFileIfExists(this.serialMapPath);
        return raw === undefined ? {} : JSON.parse(raw);
    }

    /**
     * Read-modify-write against the serial map file via `FileStoreUtils.updateJsonFile()`: serialized by a
     * process-wide lock keyed on the file's resolved path (not per-instance, so two instances configured with
     * the same `serial_map_path` can't race either), and written atomically (temp file + rename) so a crash
     * mid-write can't truncate the map and a concurrent `revoke()` read never observes a torn file. Without
     * this, two `issue()` calls completing concurrently could drop one another's entry - which would later make
     * `revoke()` 404 for a certificate that really was issued. A failed write never blocks the next call. This
     * does not protect against two separate OS processes (e.g. replicas sharing a volume) racing on the same
     * path - that would need real file locking or a database-backed map.
     */
    private async recordSerial(fingerprint: string, serialNumber: string): Promise<void> {
        // Parent directory mode 0o777 (umask-filtered) matches this map's historical `mkdir` behavior.
        await updateJsonFile<Record<string, string>, void>(
            this.serialMapPath,
            0o600,
            (map) => {
                map[fingerprint] = serialNumber;
            },
            0o777,
        );
    }

    public async issue(identity: string, csr: string): Promise<IssuedCertificate> {
        const result: SignResponse = await this.request<SignResponse>(`${this.mount}/sign/${this.role}`, {
            csr,
            common_name: identity,
        });
        const certificatePem: string | undefined = result.data?.certificate;
        const serialNumber: string | undefined = result.data?.serial_number;
        if (!certificatePem || !serialNumber) {
            throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "The configured PKI server returned an incomplete response.");
        }

        const certificate = new x509.X509Certificate(certificatePem);
        const fingerprint: string = Buffer.from(await certificate.getThumbprint("SHA-256")).toString("hex");
        await this.recordSerial(fingerprint, serialNumber);

        return {
            certificate: certificatePem,
            fingerprint,
            notBefore: certificate.notBefore,
            notAfter: certificate.notAfter,
            serialNumber,
        };
    }

    public async revoke(fingerprint: string): Promise<void> {
        const map: Record<string, string> = await this.loadSerialMap();
        const serialNumber: string | undefined = map[fingerprint];
        if (!serialNumber) {
            throw new ApiError(
                ApiErrors.NOT_FOUND,
                404,
                `No certificate with fingerprint '${fingerprint}' was issued by this OpenBaoPkiCertificateAuthority instance.`,
            );
        }
        await this.request(`${this.mount}/revoke`, { serial_number: serialNumber });
    }
}
