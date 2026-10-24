///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { isEndToEndFormat, messageEndToEndFormat, newerObservation, resolvePreferredFormat } from "../../src/util/PreferredFormatUtils.js";

describe("PreferredFormatUtils", () => {
    it("knows the two formats", () => {
        expect(isEndToEndFormat("smime")).toBe(true);
        expect(isEndToEndFormat("openpgp")).toBe(true);
        expect(isEndToEndFormat("pgp")).toBe(false);
        expect(isEndToEndFormat(undefined)).toBe(false);
    });

    it("resolves the contact's own choice first, then what the address advertises, then what it was seen using", () => {
        const advertised = { preferEncrypt: "mutual" as const, preferFormat: "smime" as const };
        const observed = { format: "openpgp" as const, at: 5 };
        expect(resolvePreferredFormat({ preferredFormat: "openpgp", encryptPreference: advertised, observedFormat: observed })).toEqual({ format: "openpgp", source: "contact" });
        expect(resolvePreferredFormat({ encryptPreference: advertised, observedFormat: observed })).toEqual({ format: "smime", source: "advertised" });
        expect(resolvePreferredFormat({ encryptPreference: { preferEncrypt: "mutual" }, observedFormat: observed })).toEqual({ format: "openpgp", source: "observed" });
        expect(resolvePreferredFormat({ encryptPreference: { preferEncrypt: "mutual" } })).toBeUndefined();
        // Junk stored before validation existed is ignored at every level.
        expect(resolvePreferredFormat({ preferredFormat: "x" as never, observedFormat: { format: "y" as never, at: 1 } })).toBeUndefined();
    });

    it.each([
        ['multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="b"', "smime"],
        ["multipart/signed; protocol=application/x-pkcs7-signature; boundary=b", "smime"],
        ["application/pkcs7-mime; smime-type=enveloped-data; name=smime.p7m", "smime"],
        ["Application/X-PKCS7-MIME", "smime"],
        ['multipart/signed;\r\n\tprotocol="application/pgp-signature"; micalg=pgp-sha256; boundary="b"', "openpgp"],
        ['multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"', "openpgp"],
        ['multipart/signed; protocol="application/other"; boundary="b"', undefined],
        ["multipart/encrypted; boundary=b", undefined],
        ["text/plain; charset=utf-8", undefined],
        [undefined, undefined],
    ])("tells the format of a %s message", (contentType, expected) => {
        expect(messageEndToEndFormat(contentType)).toBe(expected);
    });

    it("keeps only a newer observation", () => {
        const old = { format: "smime" as const, at: 10 };
        expect(newerObservation(undefined, old)).toBe(old);
        expect(newerObservation(old, { format: "openpgp", at: 11 })).toEqual({ format: "openpgp", at: 11 });
        expect(newerObservation(old, { format: "openpgp", at: 10 })).toBeUndefined();
        expect(newerObservation(old, undefined)).toBeUndefined();
    });
});
