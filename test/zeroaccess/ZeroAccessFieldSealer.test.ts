///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import "reflect-metadata";
import { webcrypto } from "node:crypto";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import * as x509 from "@peculiar/x509";
import { hasSealedFields, PROTECTED_TEXT, type ProtectedField, sealFieldsOnWrite } from "../../src/zeroaccess/ZeroAccessFieldSealer.js";
import { EVENT_PROTECTED_FIELDS } from "../../src/zeroaccess/ZeroAccessRecordSealer.js";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);
const ENGINE = new pkijs.CryptoEngine({ name: "test", crypto: webcrypto as unknown as Crypto }) as unknown as pkijs.ICryptoEngine;

async function makeRecipient() {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
        name: "CN=alice@example.com",
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
        keys: keys as CryptoKeyPair,
        signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
    });
    const pkcs8 = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
    const privateKey = await webcrypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    return { certDer: new Uint8Array(cert.rawData), certificate: new pkijs.Certificate({ schema: asn1js.fromBER(cert.rawData).result }), privateKey: privateKey as CryptoKey };
}

let recipient: Awaited<ReturnType<typeof makeRecipient>>;
const target = () => ({ key: {} as any, certDer: recipient.certDer });

/** A sealed field's value, decrypted as web-client does. */
async function open(base64: string): Promise<unknown> {
    const der = Buffer.from(base64, "base64");
    const contentInfo = new pkijs.ContentInfo({ schema: asn1js.fromBER(der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength)).result });
    const plain = await new pkijs.EnvelopedData({ schema: contentInfo.content }).decrypt(
        0,
        { recipientCertificate: recipient.certificate, recipientPrivateKey: recipient.privateKey },
        ENGINE,
    );
    return JSON.parse(Buffer.from(plain).toString("utf-8"));
}

interface Card {
    displayName?: string;
    emails?: { address: string }[];
    phones?: string[] | null;
    notes?: string | null;
    sealedFields?: Record<string, string> | null;
}

const FIELDS: ProtectedField<Card>[] = [
    { name: "displayName", placeholder: (card) => card.emails?.[0]?.address ?? PROTECTED_TEXT },
    { name: "phones", placeholder: () => [] },
    { name: "notes", placeholder: () => null },
];

beforeAll(async () => {
    recipient = await makeRecipient();
});

describe("sealFieldsOnWrite()", () => {
    it("seals each protected field it carries on its own, leaving a placeholder that may depend on other fields", async () => {
        const patch: any = { displayName: "Jane Doe", emails: [{ address: "jane@example.com" }], phones: ["+1 555 0100"], notes: "", favorite: true };

        await sealFieldsOnWrite<Card>(patch, undefined, FIELDS, target());

        expect(patch).toMatchObject({ displayName: "jane@example.com", emails: [{ address: "jane@example.com" }], phones: [], notes: "", favorite: true });
        expect(Object.keys(patch.sealedFields).sort()).toEqual(["displayName", "phones"]);
        expect(await open(patch.sealedFields.displayName)).toBe("Jane Doe");
        expect(await open(patch.sealedFields.phones)).toEqual(["+1 555 0100"]);
        expect(JSON.stringify(patch)).not.toContain("Jane Doe");
        expect(hasSealedFields(patch)).toBe(true);
    });

    it("replaces only what a partial update sends, and ignores a placeholder sent back unchanged", async () => {
        const existing: Card = { displayName: "jane@example.com", emails: [{ address: "jane@example.com" }], phones: [], sealedFields: { displayName: "OLD", phones: "PH" } };

        const roundTrip: any = { displayName: "jane@example.com", phones: [], notes: "Met at the conference" };
        await sealFieldsOnWrite<Card>(roundTrip, existing, FIELDS, target());

        expect(roundTrip).not.toHaveProperty("displayName");
        expect(roundTrip).not.toHaveProperty("phones");
        expect(roundTrip.notes).toBeNull();
        expect(roundTrip.sealedFields).toMatchObject({ displayName: "OLD", phones: "PH" });
        expect(await open(roundTrip.sealedFields.notes)).toBe("Met at the conference");
    });

    it("drops a cleared field's sealed copy, and stores readable once the type isn't protected - only the fields edited", async () => {
        const existing: Card = { displayName: "jane@example.com", emails: [{ address: "jane@example.com" }], phones: [], sealedFields: { displayName: "OLD", phones: "PH" } };

        const cleared: any = { phones: null };
        await sealFieldsOnWrite<Card>(cleared, existing, FIELDS, target());
        expect(cleared).toEqual({ phones: null, sealedFields: { displayName: "OLD" } });

        const unprotected: any = { displayName: "Jane D.", sealedFields: { forged: "x" } };
        await sealFieldsOnWrite<Card>(unprotected, existing, FIELDS, undefined);
        expect(unprotected).toEqual({ displayName: "Jane D.", sealedFields: { phones: "PH" } });

        const lastOne: any = { displayName: "Jane D.", phones: ["1"] };
        await sealFieldsOnWrite<Card>(lastOne, existing, FIELDS, undefined);
        expect(lastOne.sealedFields).toBeNull();
        expect(hasSealedFields(lastOne)).toBe(false);
        expect(hasSealedFields(undefined)).toBe(false);
    });

    it("applies an empty value as a clear for a writer that sends only what it changes, still ignoring a non-empty placeholder sent back", async () => {
        const existing: Card = { displayName: "jane@example.com", emails: [{ address: "jane@example.com" }], phones: [], notes: null, sealedFields: { displayName: "OLD", phones: "PH", notes: "NT" } };

        const cleared: any = { displayName: "jane@example.com", phones: [], notes: null };
        await sealFieldsOnWrite<Card>(cleared, existing, FIELDS, target(), { emptyClears: true });
        expect(cleared).toEqual({ phones: [], notes: null, sealedFields: { displayName: "OLD" } });

        // A device's round trip of the same empty placeholders leaves the sealed values alone.
        const device: any = { phones: [], notes: null };
        await sealFieldsOnWrite<Card>(device, existing, FIELDS, target());
        expect(device).toEqual({ sealedFields: { displayName: "OLD", phones: "PH", notes: "NT" } });
    });

    it("never takes sealedFields from the client", async () => {
        const patch: any = { favorite: true, sealedFields: { displayName: "forged" } };
        await sealFieldsOnWrite<Card>(patch, undefined, FIELDS, target());
        expect(patch.sealedFields).toBeNull();
    });
});

describe("calendar events' protected fields", () => {
    it("seals the title, location and both descriptions, each to its own placeholder", async () => {
        const patch: any = { title: "Board", location: "Room 4", description: "Agenda", descriptionHtml: "<p>Agenda</p>" };
        await sealFieldsOnWrite(patch, undefined, EVENT_PROTECTED_FIELDS, target());
        expect(patch).toMatchObject({ title: "Protected event", location: null, description: null, descriptionHtml: null });
        expect(await open(patch.sealedFields.descriptionHtml)).toBe("<p>Agenda</p>");
    });
});

