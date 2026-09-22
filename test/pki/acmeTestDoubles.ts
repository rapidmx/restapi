///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A fake `acme-client` `Client` and an `Rfc8823AcmeSigningCertificateEnrollment` that uses it, shared by the enrollment
// progress tests (the class itself, and the key-vault routes on both backends). Nothing here touches a network: the CA is
// whatever `FakeAcmeClient`'s statics say it is, so a test drives an enrollment through every stage by changing them.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { Rfc8823AcmeSigningCertificateEnrollment } from "../../src/pki/Rfc8823AcmeSigningCertificateEnrollment.js";

x509.cryptoProvider.set(crypto);

export async function generateCsr(identity: string): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const csr = await x509.Pkcs10CertificateRequestGenerator.create({
        name: `CN=${identity}`,
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    return csr.toString("pem");
}

/** A real self-signed certificate for `identity`, so the parts of a progress report read from the certificate are real. */
export async function generateSelfSignedCertificate(identity: string, notAfter: Date = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)): Promise<string> {
    const keys: CryptoKeyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: "0a1b2c",
        name: `CN=${identity}`,
        notBefore: new Date(Date.now() - 60_000),
        notAfter,
        keys,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
        extensions: [new x509.SubjectAlternativeNameExtension([{ type: "email", value: identity }])],
    });
    return certificate.toString("pem");
}

export class FakeAcmeClient {
    public static createAccountCallCount = 0;
    public static completeChallengeCallCount = 0;
    public static finalizeCallCount = 0;
    public static getOrderCallCount = 0;
    /** What `getOrder()` reports; a test moves the CA along by changing it. */
    public static orderStatus: string = "pending";
    /** The `error` of an `invalid` order (an ACME problem document), when the CA gave one. */
    public static orderError: any = undefined;
    /** The `expires` a new order (and every `getOrder()`) carries, when the CA says. */
    public static orderExpires: string | undefined = undefined;
    public static certificatePem: string = "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n";
    /** When set, `getOrder()` waits this long first (a slow CA). */
    public static getOrderDelayMs: number = 0;
    /** When set, `getOrder()`/`completeChallenge()` reject with it (an unreachable or failing CA). */
    public static getOrderError: any = undefined;
    public static completeChallengeError: any = undefined;

    public static reset(): void {
        FakeAcmeClient.createAccountCallCount = 0;
        FakeAcmeClient.completeChallengeCallCount = 0;
        FakeAcmeClient.finalizeCallCount = 0;
        FakeAcmeClient.getOrderCallCount = 0;
        FakeAcmeClient.orderStatus = "pending";
        FakeAcmeClient.orderError = undefined;
        FakeAcmeClient.orderExpires = undefined;
        FakeAcmeClient.certificatePem = "-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n";
        FakeAcmeClient.getOrderDelayMs = 0;
        FakeAcmeClient.getOrderError = undefined;
        FakeAcmeClient.completeChallengeError = undefined;
    }

    constructor(public opts: any) {}

    public getAccountUrl(): string {
        return "https://acme.test/acct/1";
    }

    public async createAccount(_data?: any): Promise<any> {
        FakeAcmeClient.createAccountCallCount++;
        return { status: "valid" };
    }

    public async createOrder(data: any): Promise<any> {
        return {
            url: "https://acme.test/order/1",
            status: "pending",
            identifiers: data.identifiers,
            authorizations: ["https://acme.test/authz/1"],
            finalize: "https://acme.test/order/1/finalize",
            expires: FakeAcmeClient.orderExpires,
        };
    }

    public async getAuthorizations(_order: any): Promise<any[]> {
        return [
            {
                url: "https://acme.test/authz/1",
                status: "pending",
                identifier: { type: "email", value: "alice@example.com" },
                challenges: [
                    { type: "email-reply-00", url: "https://acme.test/chall/1", status: "pending", from: "acme-challenge+abc123@acme.test", token: "token-part-2-value" },
                ],
            },
        ];
    }

    public async getChallengeKeyAuthorization(challenge: any): Promise<string> {
        return `${challenge.token}.test-account-thumbprint`;
    }

    public async completeChallenge(challenge: any): Promise<any> {
        FakeAcmeClient.completeChallengeCallCount++;
        if (FakeAcmeClient.completeChallengeError) {
            throw FakeAcmeClient.completeChallengeError;
        }
        return { ...challenge, status: "processing" };
    }

    public async getOrder(order: any): Promise<any> {
        FakeAcmeClient.getOrderCallCount++;
        if (FakeAcmeClient.getOrderDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, FakeAcmeClient.getOrderDelayMs));
        }
        if (FakeAcmeClient.getOrderError) {
            throw FakeAcmeClient.getOrderError;
        }
        return {
            url: order.url,
            status: FakeAcmeClient.orderStatus,
            error: FakeAcmeClient.orderStatus === "invalid" ? FakeAcmeClient.orderError : undefined,
            expires: FakeAcmeClient.orderExpires,
            certificate: FakeAcmeClient.orderStatus === "valid" ? "https://acme.test/cert/1" : undefined,
        };
    }

    public async finalizeOrder(order: any, _csr: any): Promise<any> {
        FakeAcmeClient.finalizeCallCount++;
        return { url: order.url, status: "processing" };
    }

    public async getCertificate(_order: any): Promise<string> {
        return FakeAcmeClient.certificatePem;
    }
}

export class TestEnrollment extends Rfc8823AcmeSigningCertificateEnrollment {
    protected createClient(opts: any): any {
        return new FakeAcmeClient(opts);
    }
}
