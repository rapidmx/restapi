///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// How a DNS provider config's credentials are sealed to its row and field, and read back for the DNS controller: what each envelope is bound to, which
// fields count as saved, and that a field that can't be read is named while any other failure is a bug and surfaces.
import {
    DNS_PROVIDER_RECORD,
    dnsCredentialContext,
    noConfigCipher,
    openDnsCredentials,
    savedCredentialKeys,
    sealDnsCredentials,
} from "../../src/dns/DnsProviderCredentials.js";
import { ConfigSecretUnavailableError } from "../../src/secrets/ConfigCipher.js";

const envelope = (ct: string) => ({ $enc: 1 as const, kid: "k1", iv: "aXY=", ct, tag: "dGFn" });

describe("DNS provider credentials", () => {
    it("binds a credential to the DnsProvider record, the row's uid and credentials.<field>", () => {
        expect(DNS_PROVIDER_RECORD).toBe("DnsProvider");
        expect(dnsCredentialContext("aws-x", "secretAccessKey")).toEqual({ record: "DnsProvider", uid: "aws-x", field: "credentials.secretAccessKey" });
    });

    it("counts a credential as saved when it holds a value, listing them in order", () => {
        expect(savedCredentialKeys({ secretAccessKey: envelope("a"), accessKeyId: envelope("b") })).toEqual(["accessKeyId", "secretAccessKey"]);
        expect(savedCredentialKeys({ accessKeyId: envelope("b"), cleared: null, unset: undefined })).toEqual(["accessKeyId"]);
        expect(savedCredentialKeys(null)).toEqual([]);
        expect(savedCredentialKeys(undefined)).toEqual([]);
    });

    it("answers 503 for a server without a cipher", () => {
        expect(noConfigCipher()).toMatchObject({ status: 503, message: expect.stringContaining("Configuration encryption isn't available") });
        expect(noConfigCipher().message).toContain("DNS provider credentials");
        expect(noConfigCipher("integration secrets").message).toBe("Configuration encryption isn't available on this server, so integration secrets can't be handled.");
    });

    it("seals each value for the row and field it belongs to", () => {
        const cipher: any = { encrypt: vi.fn((value: string, context: any) => envelope(`${context.uid}:${context.field}:${value}`)) };
        expect(sealDnsCredentials(cipher, "aws-x", { accessKeyId: "AKIA", secretAccessKey: "s" })).toEqual({
            accessKeyId: envelope("aws-x:credentials.accessKeyId:AKIA"),
            secretAccessKey: envelope("aws-x:credentials.secretAccessKey:s"),
        });
        expect(cipher.encrypt).toHaveBeenCalledWith("AKIA", { record: "DnsProvider", uid: "aws-x", field: "credentials.accessKeyId" });
    });

    describe("openDnsCredentials()", () => {
        const unavailable = new ConfigSecretUnavailableError("DnsProvider", "aws-x", "credentials.secretAccessKey", "unknown_key", "its key 'k9' isn't in the keyring");

        it("decrypts every saved credential as text, for the row it is on", () => {
            const cipher: any = { decryptString: vi.fn((e: any) => `plain-${e.ct}`) };
            const opened = openDnsCredentials(cipher, { uid: "aws-x", credentials: { accessKeyId: envelope("a"), secretAccessKey: envelope("b") } });
            expect(opened).toEqual({ values: { accessKeyId: "plain-a", secretAccessKey: "plain-b" }, unreadable: [] });
            expect(cipher.decryptString).toHaveBeenCalledWith(envelope("a"), { record: "DnsProvider", uid: "aws-x", field: "credentials.accessKeyId" });
        });

        it("opens nothing for a config without credentials", () => {
            const cipher: any = { decryptString: vi.fn() };
            expect(openDnsCredentials(cipher, { uid: "a" })).toEqual({ values: {}, unreadable: [] });
            expect(openDnsCredentials(cipher, { uid: "a", credentials: null })).toEqual({ values: {}, unreadable: [] });
            expect(cipher.decryptString).not.toHaveBeenCalled();
        });

        it("leaves out a credential that can't be read and names it, the others still opened", () => {
            const cipher: any = {
                decryptString: vi.fn((e: any) => {
                    if (e.ct === "b") {
                        throw unavailable;
                    }
                    return `plain-${e.ct}`;
                }),
            };
            const opened = openDnsCredentials(cipher, { uid: "aws-x", credentials: { accessKeyId: envelope("a"), secretAccessKey: envelope("b") } });
            expect(opened).toEqual({ values: { accessKeyId: "plain-a" }, unreadable: ["secretAccessKey"] });
            expect(JSON.stringify(opened)).not.toContain("keyring");
        });

        it("doesn't hide any other failure: that is a bug, not a credential to enter again", () => {
            const cipher: any = {
                decryptString: vi.fn(() => {
                    throw new TypeError("cipher is broken");
                }),
            };
            expect(() => openDnsCredentials(cipher, { uid: "aws-x", credentials: { accessKeyId: envelope("a") } })).toThrow("cipher is broken");
        });
    });
});
