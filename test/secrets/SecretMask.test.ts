///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { isSecretMask, maskCredentials, secretMask, toSecretPatch } from "../../src/secrets/SecretMask.js";
import { ConfigEnvelope } from "../../src/models/types.js";

/** What `call` throws, which it must. */
function thrownBy(call: () => unknown): any {
    try {
        call();
    } catch (err) {
        return err;
    }
    throw new Error("expected the call to throw");
}

describe("secretMask()", () => {
    it("is { secret: true }, a new object each time so no caller can change another's", () => {
        const first = secretMask();
        expect(first).toEqual({ secret: true });
        expect(secretMask()).not.toBe(first);
    });
});

describe("isSecretMask()", () => {
    it("matches exactly the mask", () => {
        expect(isSecretMask({ secret: true })).toBe(true);
        expect(isSecretMask(secretMask())).toBe(true);
    });

    it("matches nothing else", () => {
        for (const value of [
            undefined,
            null,
            "secret",
            true,
            0,
            [],
            Object.assign([], { secret: true }),
            {},
            { secret: false },
            { secret: "true" },
            { secret: true, value: "x" },
        ]) {
            expect(isSecretMask(value), JSON.stringify(value)).toBe(false);
        }
    });
});

describe("maskCredentials()", () => {
    const envelope = (kid: string): ConfigEnvelope => ({ $enc: 1, kid, iv: "aXY=", ct: "Y3Q=", tag: "dGFn" });

    it("shows each field that is set as the mask, and never an envelope", () => {
        const credentials = { accessKeyId: envelope("a1b2c3d4"), secretAccessKey: envelope("a1b2c3d4") };
        const masked = maskCredentials(credentials);
        expect(masked).toEqual({ accessKeyId: { secret: true }, secretAccessKey: { secret: true } });
        expect(JSON.stringify(masked)).not.toContain("a1b2c3d4");
    });

    it("gives each field a mask of its own, so no response shares one another can change", () => {
        const masked = maskCredentials({ a: envelope("k"), b: envelope("k") });
        expect(masked.a).not.toBe(masked.b);
    });

    it("shows nothing when no credentials were saved, or all were cleared", () => {
        expect(maskCredentials(undefined)).toEqual({});
        expect(maskCredentials(null)).toEqual({});
        expect(maskCredentials({})).toEqual({});
    });

    it("leaves out a field that holds nothing", () => {
        expect(maskCredentials({ apiToken: envelope("k"), cleared: null, missing: undefined })).toEqual({ apiToken: { secret: true } });
    });
});

describe("toSecretPatch()", () => {
    const FIELDS: readonly string[] = ["accessKeyId", "secretAccessKey"];

    it("keeps a new value, clears on null and leaves a field sent back as the mask, or not sent, alone", () => {
        expect(toSecretPatch({ accessKeyId: "AKIA", secretAccessKey: null }, FIELDS)).toEqual({ accessKeyId: "AKIA", secretAccessKey: null });
        expect(toSecretPatch({ accessKeyId: { secret: true }, secretAccessKey: "s3cr3t" }, FIELDS)).toEqual({ secretAccessKey: "s3cr3t" });
        expect(toSecretPatch({ accessKeyId: undefined }, FIELDS)).toEqual({});
        expect(toSecretPatch({}, FIELDS)).toEqual({});
        expect(toSecretPatch(undefined, FIELDS)).toEqual({});
    });

    it("refuses a field the form doesn't have, listing the fields it has rather than repeating the one sent", () => {
        const err: any = thrownBy(() => toSecretPatch({ accessKeyId: "AKIA", region: "us-east-1" }, FIELDS));
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(400);
        expect(err.message).toContain("accessKeyId, secretAccessKey");
        expect(err.message).not.toContain("region");
    });

    it("never repeats an unknown field's name, which may be a credential sent as a key", () => {
        for (const key of ["AKIAREALACCESSKEY0123", "x".repeat(1024 * 1024)]) {
            const err: any = thrownBy(() => toSecretPatch({ [key]: "s3cr3t-value" }, FIELDS));
            expect(err.status).toBe(400);
            expect(err.message).not.toContain(key.slice(0, 16));
            expect(err.message).not.toContain("s3cr3t-value");
            expect(err.message.length).toBeLessThan(200);
        }
        expect(thrownBy(() => toSecretPatch({ apiToken: "t" }, [])).message).toBe("These settings have no credential fields.");
    });

    it("trims surrounding whitespace, such as the newline a pasted token carries", () => {
        expect(toSecretPatch({ accessKeyId: "  AKIA\r\n", secretAccessKey: "\ts3cr3t\n" }, FIELDS)).toEqual({ accessKeyId: "AKIA", secretAccessKey: "s3cr3t" });
    });

    it("refuses a value that is only whitespace, naming the field", () => {
        for (const value of [" ", "\n", "\r\n\t  "]) {
            const err: any = thrownBy(() => toSecretPatch({ secretAccessKey: value }, FIELDS));
            expect(err.status).toBe(400);
            expect(err.message).toContain("secretAccessKey");
        }
    });

    it("refuses control characters inside a value, without repeating it", () => {
        for (const value of ["s3cr3t-value\nmore", "s3cr3t-value\r", "s3cr3t-value\u0000x", "s3cr3t\tvalue", "s3cr3t-value\u007fx", "s3cr3t-value\u0085x"]) {
            const err: any = thrownBy(() => toSecretPatch({ secretAccessKey: `${value}z` }, FIELDS));
            expect(err.status, JSON.stringify(value)).toBe(400);
            expect(err.message).toContain("secretAccessKey");
            expect(err.message).not.toContain("s3cr3t");
        }
    });

    it("allows line breaks and tabs, but no other control character, inside a multi-line field", () => {
        const json = '{\n\t"type": "service_account",\r\n\t"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n"\n}';
        expect(toSecretPatch({ serviceAccountJson: `${json}\n` }, ["serviceAccountJson"], ["serviceAccountJson"])).toEqual({ serviceAccountJson: json });
        const err: any = thrownBy(() => toSecretPatch({ serviceAccountJson: "{\u0000}" }, ["serviceAccountJson"], ["serviceAccountJson"]));
        expect(err.status).toBe(400);
        expect(err.message).toContain("serviceAccountJson");
    });

    it("refuses a value that is not a string, null or the mask, without repeating the value", () => {
        for (const value of [42, true, "", ["s3cr3t-value"], { secret: true, value: "s3cr3t-value" }, { secret: false }]) {
            const err: any = thrownBy(() => toSecretPatch({ secretAccessKey: value }, FIELDS));
            expect(err, JSON.stringify(value)).toBeInstanceOf(ApiError);
            expect(err.status).toBe(400);
            expect(err.message).toContain("secretAccessKey");
            expect(err.message).not.toContain("s3cr3t-value");
        }
    });

    it("refuses credentials that aren't an object of fields", () => {
        for (const input of [null, "s3cr3t-value", ["s3cr3t-value"], 7]) {
            const err: any = thrownBy(() => toSecretPatch(input, FIELDS));
            expect(err).toBeInstanceOf(ApiError);
            expect(err.status).toBe(400);
            expect(err.message).not.toContain("s3cr3t-value");
        }
    });

    it("refuses a prototype key from a parsed body rather than writing through it", () => {
        const parsed: unknown = JSON.parse('{"__proto__": "x", "accessKeyId": "AKIA"}');
        const err: any = thrownBy(() => toSecretPatch(parsed, FIELDS));
        expect(err.status).toBe(400);
        expect(err.message).not.toContain("__proto__");
    });
});
