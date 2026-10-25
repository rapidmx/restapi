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

    it("clears only the fields a writer names, so a client that couldn't open the record wipes nothing it sends back", async () => {
        const existing: Card = { displayName: "jane@example.com", emails: [{ address: "jane@example.com" }], phones: [], notes: null, sealedFields: { displayName: "OLD", phones: "PH", notes: "NT" } };

        // A locked client's whole form: every placeholder sent back, nothing named.
        const locked: any = { displayName: "jane@example.com", phones: [], notes: null };
        await sealFieldsOnWrite<Card>(locked, existing, FIELDS, target(), { emptyClears: [] });
        expect(locked).toEqual({ sealedFields: { displayName: "OLD", phones: "PH", notes: "NT" } });

        const named: any = { displayName: "jane@example.com", phones: [], notes: null };
        await sealFieldsOnWrite<Card>(named, existing, FIELDS, target(), { emptyClears: ["notes"] });
        expect(named).toEqual({ notes: null, sealedFields: { displayName: "OLD", phones: "PH" } });
    });

    it("seals what a record still holds readable on its first protected write, whatever the write carries", async () => {
        // Not reached by the backfill yet: one field sent, the others readable.
        const existing: Card = { displayName: "Jane Doe", emails: [{ address: "jane@example.com" }], phones: ["+1 555 0100"], notes: "CANARY notes" };
        const patch: any = { phones: ["+1 555 0199"] };
        await sealFieldsOnWrite<Card>(patch, existing, FIELDS, target());
        expect(patch).toMatchObject({ displayName: "jane@example.com", phones: [], notes: null });
        expect(Object.keys(patch.sealedFields).sort()).toEqual(["displayName", "notes", "phones"]);
        expect(await open(patch.sealedFields.notes)).toBe("CANARY notes");
        expect(await open(patch.sealedFields.phones)).toEqual(["+1 555 0199"]);
        expect(JSON.stringify(patch)).not.toContain("CANARY");

        // A field already sealed, or empty, is left alone; and so is everything while the type isn't protected.
        const partly: any = { phones: [] };
        await sealFieldsOnWrite<Card>(partly, { ...existing, notes: "", sealedFields: { displayName: "OLD" } }, FIELDS, target());
        // (its column shows its placeholder)
        expect(partly).toEqual({ phones: [], displayName: "jane@example.com", sealedFields: { displayName: "OLD" } });
        const off: any = { phones: [] };
        await sealFieldsOnWrite<Card>(off, existing, FIELDS, undefined);
        expect(off).toEqual({ phones: [], sealedFields: null });

        // Content sealed whole (an event's sealedContent) leaves its placeholder columns to that sealing.
        const whole: any = { phones: [] };
        await sealFieldsOnWrite<Card>(whole, { ...existing, sealedContent: { keyFingerprint: "fp" } } as any, FIELDS, target());
        expect(whole).toEqual({ phones: [], sealedFields: null });
    });

    it("keeps a sealed name's placeholder in step with a changed first address, whether the write leaves the name out or echoes it", async () => {
        const existing: Card = { displayName: "a@x", emails: [{ address: "a@x" }], phones: [], sealedFields: { displayName: "ALICE", phones: "PH" } };

        const left: any = { emails: [{ address: "b@x" }] };
        await sealFieldsOnWrite<Card>(left, existing, FIELDS, target());
        expect(left).toEqual({ emails: [{ address: "b@x" }], displayName: "b@x", sealedFields: { displayName: "ALICE", phones: "PH" } });

        // A device sends back the name it was shown with the new address.
        const echoed: any = { displayName: "a@x", emails: [{ address: "b@x" }] };
        await sealFieldsOnWrite<Card>(echoed, existing, FIELDS, target());
        expect(echoed).toEqual({ emails: [{ address: "b@x" }], displayName: "b@x", sealedFields: { displayName: "ALICE", phones: "PH" } });
    });

    it("never seals a stale name column sent back over the sealed name, and repairs the column on the next write", async () => {
        // Written before the placeholder followed the address: the column still names the old first address.
        const stale: Card = { displayName: "a@x", emails: [{ address: "b@x" }], phones: [], sealedFields: { displayName: "ALICE", phones: "PH" } };

        const echo: any = { displayName: "a@x", phones: [] };
        await sealFieldsOnWrite<Card>(echo, stale, FIELDS, target());
        expect(echo).toEqual({ displayName: "b@x", sealedFields: { displayName: "ALICE", phones: "PH" } });

        const untouched: any = { notes: null };
        await sealFieldsOnWrite<Card>(untouched, stale, FIELDS, target());
        expect(untouched).toEqual({ notes: null, displayName: "b@x", sealedFields: { displayName: "ALICE", phones: "PH" } });

        // A name the writer really changes is sealed as always.
        const renamed: any = { displayName: "Alice Smith-Jones" };
        await sealFieldsOnWrite<Card>(renamed, stale, FIELDS, target());
        expect(renamed.displayName).toBe("b@x");
        expect(await open(renamed.sealedFields.displayName)).toBe("Alice Smith-Jones");

        // An empty stored column named as cleared is a clear, not an echo.
        const cleared: any = { notes: null };
        await sealFieldsOnWrite<Card>(cleared, { emails: [], notes: null, sealedFields: { notes: "NT" } }, FIELDS, target(), { emptyClears: ["notes"] });
        expect(cleared).toEqual({ notes: null, sealedFields: null });
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

