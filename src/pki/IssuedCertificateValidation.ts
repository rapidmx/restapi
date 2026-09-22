///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// See LocalX509CertificateAuthority.ts's identical note: `@peculiar/x509` requires `reflect-metadata` loaded before it is imported.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { splitPemCertificates } from "../util/CertificateInstallUtils.js";
import { certificateEmailIdentities } from "../util/SignerCertificateUtils.js";

/** The longest certificate text an administrator may upload (a leaf and a few intermediates are a few KB). */
export const MAX_UPLOADED_CERTIFICATE_LENGTH = 64 * 1024;

/** How many certificates a pasted chain may hold. */
const MAX_CHAIN_LENGTH = 8;

/** How far in the future a certificate's `notBefore` may be and still count as valid now (clock skew between the CA and this server). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** What a valid uploaded certificate says about itself, for the audit entry and the response. */
export interface ValidatedCertificate {
    /** The certificates found in the PEM, leaf first. */
    chainLength: number;
    subject: string;
    issuer: string;
    serialNumber: string;
    notBefore: string;
    notAfter: string;
}

function refuse(message: string): ApiError {
    return new ApiError(ApiErrors.INVALID_REQUEST, 400, message);
}

/**
 * Checks a certificate (chain) an administrator uploads for a pending signing request, before it is stored and installed into the
 * mailbox. Refuses (400, with a message a person can act on) when: the text is not PEM certificates, or one of them does not parse; the
 * first (the end-entity certificate) does not carry the public key of the request's CSR - the wrong file, or one issued for another key,
 * which would leave the mailbox unable to sign with the key it holds; it is not for e-mail (an extended key usage without
 * `emailProtection`, or none at all, or a key usage without `digitalSignature`); it does not name `identity` (subjectAltName `rfc822Name`,
 * else the subject's `emailAddress`, compared case-insensitively); or it is expired or not yet valid.
 *
 * @param csrPem The CSR of the request.
 * @param identity The mailbox address the request is for.
 * @param certificatePem The certificate, or the chain (leaf first) a CA hands out.
 * @param now The time to check validity at.
 */
export async function validateIssuedCertificate(csrPem: string, identity: string, certificatePem: unknown, now: number = Date.now()): Promise<ValidatedCertificate> {
    if (typeof certificatePem !== "string" || certificatePem.trim() === "") {
        throw refuse("Paste or upload the certificate (PEM) the certificate authority issued.");
    }
    if (certificatePem.length > MAX_UPLOADED_CERTIFICATE_LENGTH) {
        throw refuse("The certificate text is too large - upload the certificate and its chain only.");
    }
    const blocks: string[] = splitPemCertificates(certificatePem);
    if (blocks.length === 0) {
        throw refuse("No PEM certificate was found. It must start with -----BEGIN CERTIFICATE-----.");
    }
    if (blocks.length > MAX_CHAIN_LENGTH) {
        throw refuse(`The chain has ${blocks.length} certificates - at most ${MAX_CHAIN_LENGTH} are accepted.`);
    }
    const chain: x509.X509Certificate[] = blocks.map((block, index) => {
        try {
            return new x509.X509Certificate(block);
        } catch {
            throw refuse(`${blocks.length === 1 ? "The certificate" : `Certificate ${index + 1} of the chain`} could not be parsed.`);
        }
    });
    const leaf: x509.X509Certificate = chain[0];

    const csr = new x509.Pkcs10CertificateRequest(csrPem);
    const [leafKey, csrKey] = await Promise.all([leaf.publicKey.getThumbprint("SHA-256"), csr.publicKey.getThumbprint("SHA-256")]);
    if (Buffer.compare(Buffer.from(leafKey), Buffer.from(csrKey)) !== 0) {
        throw refuse(
            chain.length > 1 && (await matchesAnyOther(chain, csr))
                ? "The first certificate in the file is not the one for this request. Put the end-entity certificate first, then its issuers."
                : "The certificate's public key does not match this request's CSR - it was issued for a different key. Upload the certificate issued for this request.",
        );
    }

    const extKeyUsage: x509.ExtendedKeyUsageExtension | null = leaf.getExtension(x509.ExtendedKeyUsageExtension);
    if (!extKeyUsage || !extKeyUsage.usages.includes(x509.ExtendedKeyUsage.emailProtection)) {
        throw refuse("The certificate is not an e-mail (S/MIME) certificate: its extended key usage does not include emailProtection.");
    }
    const keyUsage: x509.KeyUsagesExtension | null = leaf.getExtension(x509.KeyUsagesExtension);
    if (keyUsage && (keyUsage.usages & x509.KeyUsageFlags.digitalSignature) === 0) {
        throw refuse("The certificate's key usage does not allow digital signatures.");
    }

    const identities: string[] = certificateEmailIdentities(leaf);
    if (!identities.some((candidate) => candidate.toLowerCase() === identity.toLowerCase())) {
        throw refuse(
            identities.length > 0
                ? `The certificate is for ${identities.join(", ")}, not for ${identity}.`
                : `The certificate names no e-mail address, so it cannot be for ${identity}.`,
        );
    }

    if (leaf.notAfter.getTime() <= now) {
        throw refuse(`The certificate expired on ${leaf.notAfter.toISOString()}.`);
    }
    if (leaf.notBefore.getTime() > now + CLOCK_SKEW_MS) {
        throw refuse(`The certificate is not valid until ${leaf.notBefore.toISOString()}.`);
    }

    return {
        chainLength: chain.length,
        subject: leaf.subject,
        issuer: leaf.issuer,
        serialNumber: leaf.serialNumber,
        notBefore: leaf.notBefore.toISOString(),
        notAfter: leaf.notAfter.toISOString(),
    };
}

/** Whether any certificate after the first carries the CSR's key (a chain pasted the wrong way round). */
async function matchesAnyOther(chain: x509.X509Certificate[], csr: x509.Pkcs10CertificateRequest): Promise<boolean> {
    const wanted: ArrayBuffer = await csr.publicKey.getThumbprint("SHA-256");
    for (const other of chain.slice(1)) {
        if (Buffer.compare(Buffer.from(await other.publicKey.getThumbprint("SHA-256")), Buffer.from(wanted)) === 0) {
            return true;
        }
    }
    return false;
}
