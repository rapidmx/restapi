///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The DNS provider types registry: each type's option and credential rules, zone handling and generated uids.
import {
    assertDnsProviderCredentials,
    assertDnsProviderSecretValues,
    DNS_PROVIDER_UID_PATTERN,
    dnsProviderSecretKeys,
    getDnsProviderType,
    isDnsProviderType,
    isNameInZones,
    listDnsProviderTypes,
    MAX_DNS_PROVIDER_ZONES,
    newDnsProviderUid,
    normalizeDnsProviderOptions,
    normalizeDnsZones,
} from "../../src/dns/DnsProviderTypes.js";

const ZONE_ID = "0123456789abcdef0123456789abcdef";
const GUID = "0b1e8c4e-5f7a-4c2b-9d3e-1a2b3c4d5e6f";

/** The 400 message `fn` throws. */
function refusal(fn: () => unknown): string {
    try {
        fn();
    } catch (err: any) {
        expect(err.status).toBe(400);
        return err.message;
    }
    throw new Error("expected a 400");
}

describe("DnsProviderTypes", () => {
    describe("the registry", () => {
        it("knows the five types and nothing else", () => {
            for (const type of ["cloudflare", "route53", "rfc2136", "google", "azure"]) {
                expect(isDnsProviderType(type)).toBe(true);
                expect(getDnsProviderType(type).type).toBe(type);
            }
            expect(isDnsProviderType("digitalocean")).toBe(false);
            expect(isDnsProviderType(5)).toBe(false);
            expect(refusal(() => getDnsProviderType("digitalocean"))).toBe("'type' must be one of: cloudflare, route53, rfc2136, google, azure.");
        });

        it("lists the types without functions, as fresh copies, with only Cloudflare live-tested", () => {
            const types = listDnsProviderTypes();
            expect(JSON.parse(JSON.stringify(types))).toEqual(types);
            expect(types.filter((info) => info.tested).map((info) => info.type)).toEqual(["cloudflare"]);
            for (const info of types) {
                for (const option of info.options) {
                    expect(option).not.toHaveProperty("check");
                    expect(option).not.toHaveProperty("normalize");
                }
                for (const field of info.secretFields) {
                    expect(field).not.toHaveProperty("check");
                }
            }
            types[0].options[0].label = "changed";
            (types[2].options.find((option) => option.key === "tsigAlgorithm")!.values as string[]).push("hmac-md5");
            const again = listDnsProviderTypes();
            expect(again[0].options[0].label).toBe("Zone IDs");
            expect(again[2].options.find((option) => option.key === "tsigAlgorithm")!.values).not.toContain("hmac-md5");
        });

        it("names each type's credential fields and the multi-line ones", () => {
            expect(dnsProviderSecretKeys(getDnsProviderType("google"))).toEqual({ fields: ["serviceAccountJson"], multiLineFields: ["serviceAccountJson"] });
            expect(dnsProviderSecretKeys(getDnsProviderType("route53"))).toEqual({ fields: ["accessKeyId", "secretAccessKey"], multiLineFields: [] });
        });
    });

    describe("zones", () => {
        it("normalizes zones to lowercase names without a trailing dot, each once", () => {
            expect(normalizeDnsZones([" Example.COM. ", "example.com", "mail.example.org"])).toEqual(["example.com", "mail.example.org"]);
        });

        it.each([
            ["not a list", "example.com"],
            ["an empty list", []],
            ["too many zones", Array.from({ length: MAX_DNS_PROVIDER_ZONES + 1 }, (_v, i) => `z${i}.example.com`)],
            ["a non-string zone", [5]],
            ["an empty zone", ["  "]],
            ["a malformed zone", ["exa_mple.com"]],
            ["a top-level domain", ["com"]],
        ])("refuses %s", (_what, input) => {
            refusal(() => normalizeDnsZones(input));
        });

        it("covers a name equal to a zone or under it, and nothing else", () => {
            const zones = ["example.com", "example.org"];
            expect(isNameInZones("example.com", zones)).toBe(true);
            expect(isNameInZones("Mail.Example.ORG.", zones)).toBe(true);
            expect(isNameInZones("notexample.com", zones)).toBe(false);
            expect(isNameInZones("example.net", zones)).toBe(false);
        });
    });

    describe("uids", () => {
        it.each([
            ["Cloudflare main", /^cloudflare-main-[a-z0-9]{8}$/],
            ["  Ünïcode Zone!! ", /^unicode-zone-[a-z0-9]{8}$/],
            ["123 numbers first", /^dns-123-numbers-first-[a-z0-9]{8}$/],
            ["!!!", /^dns-[a-z0-9]{8}$/],
            ["a".repeat(80), /^a{31}-[a-z0-9]{8}$/],
            ["abcdefghij abcdefghij abcdefgh xyz", /^abcdefghij-abcdefghij-abcdefgh-[a-z0-9]{8}$/],
        ])("makes a DNS-label-safe uid of at most 40 characters from %j", (name, pattern) => {
            const uid: string = newDnsProviderUid(name);
            expect(uid).toMatch(pattern);
            expect(uid).toMatch(DNS_PROVIDER_UID_PATTERN);
            expect(uid.length).toBeLessThanOrEqual(40);
        });

        it("never makes the same uid twice for one name", () => {
            const uids = new Set(Array.from({ length: 50 }, () => newDnsProviderUid("same")));
            expect(uids.size).toBe(50);
        });
    });

    describe("options", () => {
        const cloudflare = getDnsProviderType("cloudflare");
        const route53 = getDnsProviderType("route53");
        const rfc2136 = getDnsProviderType("rfc2136");
        const google = getDnsProviderType("google");
        const azure = getDnsProviderType("azure");

        it("refuses options that aren't an object, and unknown keys, naming the allowed ones", () => {
            refusal(() => normalizeDnsProviderOptions(cloudflare, [ZONE_ID], ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(cloudflare, "x", ["example.com"]));
            expect(refusal(() => normalizeDnsProviderOptions(cloudflare, { zoneIds: [ZONE_ID], proxied: false }, ["example.com"]))).toBe(
                "Unknown option for Cloudflare. The options are: zoneIds.",
            );
            expect(refusal(() => normalizeDnsProviderOptions(cloudflare, undefined, ["example.com"]))).toBe("'zoneIds' is required for Cloudflare.");
            refusal(() => normalizeDnsProviderOptions(cloudflare, null, ["example.com"]));
        });

        it("Cloudflare: one zone ID per zone, lowercase hex, not repeated", () => {
            expect(normalizeDnsProviderOptions(cloudflare, { zoneIds: [` ${ZONE_ID.toUpperCase()} `] }, ["example.com"])).toEqual({ zoneIds: [ZONE_ID] });
            refusal(() => normalizeDnsProviderOptions(cloudflare, { zoneIds: [] }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(cloudflare, { zoneIds: ZONE_ID }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(cloudflare, { zoneIds: ["xyz"] }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(cloudflare, { zoneIds: [5] }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(cloudflare, { zoneIds: [ZONE_ID] }, ["example.com", "example.org"]));
            expect(refusal(() => normalizeDnsProviderOptions(cloudflare, { zoneIds: [ZONE_ID, ZONE_ID] }, ["example.com", "example.org"]))).toBe(
                "'zoneIds' must not repeat a zone ID.",
            );
        });

        it("Route 53: a region, the zone type defaulting to public, and an optional role ARN", () => {
            expect(normalizeDnsProviderOptions(route53, { region: "EU-West-1" }, ["example.com"])).toEqual({ region: "eu-west-1", zoneType: "public" });
            expect(
                normalizeDnsProviderOptions(route53, { region: "us-gov-west-1", zoneType: "private", assumeRoleArn: "arn:aws:iam::123456789012:role/external-dns" }, ["example.com"]),
            ).toEqual({ region: "us-gov-west-1", zoneType: "private", assumeRoleArn: "arn:aws:iam::123456789012:role/external-dns" });
            refusal(() => normalizeDnsProviderOptions(route53, { region: "nowhere" }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(route53, { region: "us-east-1", zoneType: "secret" }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(route53, { region: "us-east-1", zoneType: 1 }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(route53, { region: "us-east-1", assumeRoleArn: "arn:aws:iam::1:role/x" }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(route53, { region: "x".repeat(600) }, ["example.com"]));
        });

        it("rfc2136: servers, port, a zone among the zones, and a TSIG key unless unsigned", () => {
            expect(normalizeDnsProviderOptions(rfc2136, { hosts: ["NS1.Example.com.", "192.0.2.53", "2001:db8::53"], zone: "Example.com.", tsigKeyName: "rmx-key." }, ["example.com"])).toEqual({
                hosts: ["ns1.example.com", "192.0.2.53", "2001:db8::53"],
                port: 53,
                zone: "example.com",
                tsigKeyName: "rmx-key",
                tsigAlgorithm: "hmac-sha256",
                insecure: false,
            });
            expect(normalizeDnsProviderOptions(rfc2136, { hosts: ["ns1"], zone: "example.com", insecure: true, port: 5353 }, ["example.com"])).toEqual({
                hosts: ["ns1"],
                port: 5353,
                zone: "example.com",
                tsigAlgorithm: "hmac-sha256",
                insecure: true,
            });
            expect(refusal(() => normalizeDnsProviderOptions(rfc2136, { hosts: ["ns1"], zone: "example.com" }, ["example.com"]))).toBe(
                "'tsigKeyName' is required unless 'insecure' is on.",
            );
            expect(refusal(() => normalizeDnsProviderOptions(rfc2136, { hosts: ["ns1"], zone: "example.org", insecure: true }, ["example.com"]))).toBe("'zone' must be one of the zones.");
            refusal(() => normalizeDnsProviderOptions(rfc2136, { hosts: ["bad host"], zone: "example.com", insecure: true }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(rfc2136, { hosts: Array(11).fill("ns1"), zone: "example.com", insecure: true }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(rfc2136, { hosts: ["ns1"], zone: "example.com", insecure: true, port: 0 }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(rfc2136, { hosts: ["ns1"], zone: "example.com", insecure: true, port: 53.5 }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(rfc2136, { hosts: ["ns1"], zone: "example.com", insecure: true, port: "53" }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(rfc2136, { hosts: ["ns1"], zone: "example.com", insecure: "yes" }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(rfc2136, { hosts: ["ns1"], zone: "example.com", tsigKeyName: "k", tsigAlgorithm: "hmac-md5" }, ["example.com"]));
        });

        it("Google: a project ID", () => {
            expect(normalizeDnsProviderOptions(google, { project: "my-project-1" }, ["example.com"])).toEqual({ project: "my-project-1" });
            refusal(() => normalizeDnsProviderOptions(google, { project: "My Project" }, ["example.com"]));
        });

        it("Azure: tenant and subscription GUIDs (stored lowercase) and a resource group", () => {
            expect(normalizeDnsProviderOptions(azure, { tenantId: GUID.toUpperCase(), subscriptionId: GUID, resourceGroup: "dns-rg_(prod).1" }, ["example.com"])).toEqual({
                tenantId: GUID,
                subscriptionId: GUID,
                resourceGroup: "dns-rg_(prod).1",
            });
            refusal(() => normalizeDnsProviderOptions(azure, { tenantId: "x", subscriptionId: GUID, resourceGroup: "rg" }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(azure, { tenantId: GUID, subscriptionId: "x", resourceGroup: "rg" }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(azure, { tenantId: GUID, subscriptionId: GUID, resourceGroup: "rg." }, ["example.com"]));
            refusal(() => normalizeDnsProviderOptions(azure, { tenantId: GUID, subscriptionId: GUID, resourceGroup: "r g" }, ["example.com"]));
        });
    });

    describe("credentials", () => {
        it("requires what each type needs, given its options", () => {
            const pass = (type: string, options: Record<string, any>, keys: string[]) => assertDnsProviderCredentials(getDnsProviderType(type), options, keys);
            pass("cloudflare", {}, ["apiToken"]);
            expect(refusal(() => pass("cloudflare", {}, []))).toBe("'apiToken' is required. Credentials are saved in the secret store and never shown again.");
            pass("route53", {}, []);
            pass("route53", {}, ["accessKeyId", "secretAccessKey"]);
            refusal(() => pass("route53", {}, ["secretAccessKey"]));
            pass("rfc2136", { insecure: true }, []);
            pass("rfc2136", { insecure: false }, ["tsigSecret"]);
            refusal(() => pass("rfc2136", { insecure: false }, []));
            pass("google", {}, ["serviceAccountJson"]);
            refusal(() => pass("google", {}, []));
            pass("azure", {}, ["clientId", "clientSecret"]);
            refusal(() => pass("azure", {}, ["clientId"]));
        });

        it("checks each value's format without ever repeating it", () => {
            const check = (type: string, patch: Record<string, string | null>) => assertDnsProviderSecretValues(getDnsProviderType(type), patch);
            check("route53", { accessKeyId: "AKIAABCDEFGHIJKLMNOP", secretAccessKey: "anything/at+all" });
            check("route53", { accessKeyId: null });
            expect(refusal(() => check("route53", { accessKeyId: "secret-looking value" }))).toBe("'accessKeyId' must be an AWS access key ID (letters and digits).");
            check("rfc2136", { tsigSecret: "c2VjcmV0" });
            refusal(() => check("rfc2136", { tsigSecret: "not base64!" }));
            refusal(() => check("rfc2136", { tsigSecret: "abc" }));
            check("google", { serviceAccountJson: '{\n\t"type": "service_account"\n}' });
            for (const value of ["[1]", "null", "{oops"]) {
                const message = refusal(() => check("google", { serviceAccountJson: value }));
                expect(message).not.toContain(value);
            }
            check("azure", { clientId: GUID.toUpperCase(), clientSecret: "s" });
            refusal(() => check("azure", { clientId: "x" }));
            check("cloudflare", { apiToken: "anything" });
        });
    });
});
