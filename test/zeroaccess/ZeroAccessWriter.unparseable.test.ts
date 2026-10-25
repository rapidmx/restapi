///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `ZeroAccessWriter.sealRaw()` on a message mailparser can't read at all: still sealed whole, never left readable. Its own file, since
// it replaces mailparser for the whole module.
import "reflect-metadata";
import { createHash, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { ZeroAccessWriter } from "../../src/zeroaccess/ZeroAccessWriter.js";

vi.mock("mailparser", async (importOriginal) => ({
    ...(await importOriginal<typeof import("mailparser")>()),
    simpleParser: vi.fn().mockRejectedValue(new Error("Failed to parse")),
}));

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

it("seals a message it can't parse whole, with nothing summarized or indexed", async () => {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=za",
        notBefore: new Date(Date.now() - 1000),
        notAfter: new Date(Date.now() + 86_400_000),
        keys: keys as CryptoKeyPair,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    const der = Buffer.from(cert.rawData);
    const key = { publicKey: der.toString("base64"), type: "x509", useType: "zero-access" as const, fingerprint: createHash("sha256").update(der).digest("hex"), notBefore: 1, notAfter: 2 };
    const blobs = new Map<string, Buffer>();
    const created: any[] = [];
    const writer = new ZeroAccessWriter({ findOne: vi.fn().mockResolvedValue(undefined) } as any, { findOne: vi.fn().mockResolvedValue(undefined), create: vi.fn(async (e: any) => created.push(e)) } as any, class {
        constructor(props: any) {
            Object.assign(this, props);
        }
    });
    Object.assign(writer, {
        aclUtils: { findACL: vi.fn().mockResolvedValue(undefined) },
        blobStore: { exists: async (k: string) => blobs.has(k), put: async (k: string, v: Buffer) => void blobs.set(k, v) },
    });

    const sealed = await writer.sealRaw({ uid: "mbx", ownerUserUid: "u", zeroAccessKeys: [key] }, Buffer.from("Subject: CANARY\r\n\r\nCANARY body"), "m1", new Date());

    expect(sealed).toMatchObject({ subject: "[...]", bodyPreview: "", bodyBlobKey: "za/mbx/m1" });
    expect(blobs.get("za/mbx/m1")!.toString("latin1")).not.toContain("CANARY");
    expect(created).toHaveLength(1);
});
