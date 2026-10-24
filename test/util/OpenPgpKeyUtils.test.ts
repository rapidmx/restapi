///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as openpgp from "openpgp";
import { describe, expect, it } from "vitest";
import {
    canReplaceOpenPgpKeyAutomatically,
    isOpenPgpKey,
    keyFormat,
    keySlot,
    MAX_OPENPGP_KEY_BYTES,
    OPENPGP_NO_EXPIRY,
    parseOpenPgpCertificate,
    parseOpenPgpContactKey,
    sanitizeOpenPgpKey,
} from "../../src/util/OpenPgpKeyUtils.js";
import { certifiedBy, openPgpKey, revoked } from "../openPgpTestKeys.js";

const ADDRESS = "alice@example.com";
const DAY = 86_400_000;

describe("OpenPgpKeyUtils", () => {
    it("tells OpenPGP certificates apart and names each key's slot", () => {
        expect(isOpenPgpKey({ type: "openpgp" })).toBe(true);
        expect(isOpenPgpKey({ type: "x509" })).toBe(false);
        expect(isOpenPgpKey(undefined)).toBe(false);
        expect(keyFormat({ type: "openpgp" })).toBe("openpgp");
        expect(keyFormat({})).toBe("x509");
        expect(keySlot({ useType: "encrypt", type: "openpgp" })).toBe("encrypt:openpgp");
        expect(keySlot({ useType: "sign", type: "x509" })).toBe("sign:x509");
    });

    it("parses a v6 certificate, armored or base64 binary, with every field from the certificate", async () => {
        const key = await openPgpKey(ADDRESS, { version: 6, aliases: ["ALIAS@example.com"] });
        for (const text of [key.armored, key.base64]) {
            const parsed = await parseOpenPgpCertificate(text);
            expect(parsed).toMatchObject({ emails: [ADDRESS, "alias@example.com"], canEncrypt: true, version: 6 });
            expect(parsed!.key).toEqual(key.key);
            expect(parsed!.key.fingerprint).toHaveLength(64);
            expect(parsed!.revokedAt).toBeUndefined();
        }
        const v4 = await parseOpenPgpCertificate((await openPgpKey(ADDRESS)).armored);
        expect(v4).toMatchObject({ version: 4, canEncrypt: true });
        expect(v4!.key.fingerprint).toHaveLength(40);
    });

    it("refuses what isn't a public certificate, and anything too large", async () => {
        const key = await openPgpKey(ADDRESS);
        for (const bad of [undefined, 42, "", "x".repeat(70 * 1024), "not base64!", "AAAA", key.privateKey.armor(), Buffer.from(key.privateKey.write()).toString("base64")]) {
            expect(await parseOpenPgpCertificate(bad)).toBeUndefined();
        }
        expect(await parseOpenPgpCertificate(Buffer.alloc(MAX_OPENPGP_KEY_BYTES + 1, 1).toString("base64").slice(0, 60_000))).toBeUndefined();
        // An armored key within the text cap whose binary form is over the byte cap.
        const many = await openPgpKey(ADDRESS, { aliases: Array.from({ length: 200 }, (_, i) => `alias${i}@example.com`) });
        expect(many.publicKey.write().length).toBeGreaterThan(MAX_OPENPGP_KEY_BYTES);
        expect(many.armored.length).toBeLessThan(64 * 1024);
        expect(await parseOpenPgpCertificate(many.armored)).toBeUndefined();
    }, 60_000);

    it("still parses an expired or revoked certificate, says so, and skips user IDs without an address", async () => {
        const expired = await openPgpKey(ADDRESS, { created: new Date(Date.now() - 2 * DAY), expiresIn: 3600 });
        const parsed = await parseOpenPgpCertificate(expired.armored);
        expect(parsed!.key.notAfter).toBeLessThan(Date.now());

        const gone = await revoked(await openPgpKey(ADDRESS));
        expect((await parseOpenPgpCertificate(gone.armored))!.revokedAt).toBeLessThanOrEqual(Date.now());

        const noMail = await openpgp.generateKey({ type: "curve25519", userIDs: [{ name: "No Mail" }], format: "object", config: { v6Keys: true } });
        const unnamed = await parseOpenPgpCertificate(noMail.publicKey.armor());
        expect(unnamed!.emails).toEqual([]);
        expect(unnamed!.key.notAfter).toBe(OPENPGP_NO_EXPIRY);

        // Checked before it was created: the primary key isn't valid yet, so nothing it says can be used.
        expect(await parseOpenPgpCertificate(expired.armored, Date.now() - 3 * DAY)).toBeUndefined();
        // A key without an encryption subkey parses, and says it can't encrypt.
        expect((await parseOpenPgpCertificate((await openPgpKey(ADDRESS, { signOnly: true })).armored))!.canEncrypt).toBe(false);
    });

    it("sanitizes an untrusted listing from the certificate itself, keeping a listed revocation", async () => {
        const key = await openPgpKey(ADDRESS);
        const listed = { ...key.key, fingerprint: "forged", notAfter: 1 };
        expect(await sanitizeOpenPgpKey(listed)).toEqual(key.key);
        expect(await sanitizeOpenPgpKey({ ...listed, useType: "sign" })).toBeUndefined();
        expect(await sanitizeOpenPgpKey({ ...listed, publicKey: "AAAA" })).toBeUndefined();
        expect(await sanitizeOpenPgpKey({ ...listed, revokedAt: 5, revocationReason: "superseded" })).toEqual({ ...key.key, revokedAt: 5, revocationReason: "superseded" });
        expect(await sanitizeOpenPgpKey({ ...listed, revokedAt: 5, revocationReason: "bogus" as any })).toEqual({ ...key.key, revokedAt: 5 });

        const gone = await revoked(key);
        const sanitized = await sanitizeOpenPgpKey({ ...gone.key });
        expect(sanitized).toMatchObject({ revocationReason: "compromised" });
        expect(sanitized!.revokedAt).toBeGreaterThan(0);
    });

    it("validates a contact's key: current, naming the address, able to encrypt", async () => {
        const key = await openPgpKey(ADDRESS);
        expect(await parseOpenPgpContactKey(key.armored, "ALICE@example.com")).toEqual(key.key);

        const reasons: [unknown, string, number?][] = [
            ["garbage", ADDRESS],
            [(await revoked(key)).armored, ADDRESS],
            [(await openPgpKey(ADDRESS, { created: new Date(Date.now() - 2 * DAY), expiresIn: 3600 })).armored, ADDRESS],
            [key.armored, "bob@example.com"],
            [(await openPgpKey(ADDRESS, { signOnly: true })).armored, ADDRESS],
        ];
        const messages: string[] = [];
        for (const [text, address] of reasons) {
            const err: any = await parseOpenPgpContactKey(text, address).catch((e) => e);
            expect(err.status).toBe(400);
            messages.push(err.message);
        }
        expect(new Set(messages).size).toBe(reasons.length);
    });

    it("replaces a pinned key automatically only when it is retired and certified its successor", async () => {
        const now = Date.now();
        const pinned = await openPgpKey(ADDRESS);
        const successor = await certifiedBy(await openPgpKey(ADDRESS), pinned);
        const uncertified = await openPgpKey(ADDRESS);
        const retired = { ...pinned.key, revokedAt: now - 1000 };

        expect(await canReplaceOpenPgpKeyAutomatically(retired, successor.key, ADDRESS, now)).toBe(true);
        expect(await canReplaceOpenPgpKeyAutomatically({ ...pinned.key, notAfter: now - 1 }, successor.key, ADDRESS, now)).toBe(true);
        // Still current; not certified; certified for another address; unparseable either side.
        expect(await canReplaceOpenPgpKeyAutomatically(pinned.key, successor.key, ADDRESS, now)).toBe(false);
        expect(await canReplaceOpenPgpKeyAutomatically(retired, uncertified.key, ADDRESS, now)).toBe(false);
        const otherAddress = await certifiedBy(await openPgpKey("bob@example.com", { aliases: [ADDRESS] }), pinned);
        expect(await canReplaceOpenPgpKeyAutomatically(retired, otherAddress.key, ADDRESS, now)).toBe(false);
        expect(await canReplaceOpenPgpKeyAutomatically(retired, { ...successor.key, publicKey: "AAAA" }, ADDRESS, now)).toBe(false);
        expect(await canReplaceOpenPgpKeyAutomatically({ ...retired, publicKey: "AAAA" }, successor.key, ADDRESS, now)).toBe(false);
    });
});
