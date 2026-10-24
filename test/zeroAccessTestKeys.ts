///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A mailbox zero-access key for tests, and opening what the server sealed to it the way web-client does.
import { createHash, webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import * as x509 from "@peculiar/x509";
import type { ZeroAccessKey } from "../src/models/types.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ENGINE = new pkijs.CryptoEngine({ name: "test", crypto: webcrypto as unknown as Crypto }) as unknown as pkijs.ICryptoEngine;

export interface TestZeroAccessKey {
    /** What `Mailbox.zeroAccessKeys` holds. */
    key: ZeroAccessKey;
    certificate: pkijs.Certificate;
    privateKey: CryptoKey;
}

/** A P-256 zero-access key with a self-signed certificate. */
export async function testZeroAccessKey(): Promise<TestZeroAccessKey> {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=zero-access",
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        keys: keys as CryptoKeyPair,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    const der = Buffer.from(cert.rawData);
    const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
    const privateKey = await webcrypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    return {
        key: {
            publicKey: der.toString("base64"),
            type: "x509",
            useType: "zero-access",
            fingerprint: createHash("sha256").update(der).digest("hex"),
            notBefore: 1,
            notAfter: Number.MAX_SAFE_INTEGER,
        },
        certificate: new pkijs.Certificate({ schema: asn1js.fromBER(cert.rawData).result }),
        privateKey: privateKey as CryptoKey,
    };
}

/** The JSON value of a sealed field (`sealedFields[name]`), opened with `recipient`. */
export async function openSealedField(base64: string, recipient: TestZeroAccessKey): Promise<unknown> {
    const der = Buffer.from(base64, "base64");
    const contentInfo = new pkijs.ContentInfo({ schema: asn1js.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength)).result });
    const plain = await new pkijs.EnvelopedData({ schema: contentInfo.content }).decrypt(
        0,
        { recipientCertificate: recipient.certificate, recipientPrivateKey: recipient.privateKey },
        ENGINE,
    );
    return JSON.parse(Buffer.from(plain).toString("utf-8"));
}
