///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Default and copy construction of the DNS publishing models, and the DNS fields of `Domain`, on both backends.
import { DeploymentIdentityMongo } from "../../src/models/mongo/DeploymentIdentityMongo.js";
import { DnsControllerStateMongo } from "../../src/models/mongo/DnsControllerStateMongo.js";
import { DnsOperationMongo } from "../../src/models/mongo/DnsOperationMongo.js";
import { DnsProviderMongo } from "../../src/models/mongo/DnsProviderMongo.js";
import { DomainMongo } from "../../src/models/mongo/DomainMongo.js";
import { DeploymentIdentitySQL } from "../../src/models/sql/DeploymentIdentitySQL.js";
import { DnsControllerStateSQL } from "../../src/models/sql/DnsControllerStateSQL.js";
import { DnsOperationSQL } from "../../src/models/sql/DnsOperationSQL.js";
import { DnsProviderSQL } from "../../src/models/sql/DnsProviderSQL.js";
import { DomainSQL } from "../../src/models/sql/DomainSQL.js";

describe.each([
    ["Mongo", DnsProviderMongo, DeploymentIdentityMongo, DomainMongo],
    ["SQL", DnsProviderSQL, DeploymentIdentitySQL, DomainSQL],
])("DNS publishing models (%s)", (_backend, Provider: any, Identity: any, Domain: any) => {
    it("constructs a provider config with safe defaults: enabled, no takeover, no credentials", () => {
        const provider = new Provider();
        expect(provider).toEqual(expect.objectContaining({ name: "", type: "cloudflare", zones: [], options: {}, enabled: true, allowTakeover: false }));
        expect(provider.secretRef).toBeUndefined();
        expect(provider.origin).toBeUndefined();
        expect(provider.status).toBeUndefined();
        expect(new Provider({}).enabled).toBe(true);
    });

    it("copies every field of a provider config, including a cleared reference", () => {
        const fields = {
            name: "AWS",
            type: "route53",
            zones: ["example.com"],
            options: { region: "us-east-1" },
            secretRef: { backend: "openbao", path: "dns/aws-x", keys: ["accessKeyId"], generation: 3 },
            origin: "installer",
            enabled: false,
            allowTakeover: true,
            status: { readyReplicas: 1 },
        };
        expect(new Provider(fields)).toEqual(expect.objectContaining(fields));
        expect(new Provider({ secretRef: null, status: null })).toEqual(expect.objectContaining({ secretRef: null, status: null }));
    });

    it("keys a provider config's name in lowercase for its unique index, unless given the key", () => {
        expect(new Provider().nameKey).toBe("");
        expect(new Provider({ name: "Cloudflare Main" }).nameKey).toBe("cloudflare main");
        expect(new Provider({ name: "Cloudflare Main", nameKey: "kept" }).nameKey).toBe("kept");
    });

    it("constructs and copies the deployment identity", () => {
        expect(new Identity().installationId).toBe("");
        expect(new Identity({}).installationId).toBe("");
        expect(new Identity({ installationId: "abcdefghijklmnop" }).installationId).toBe("abcdefghijklmnop");
    });

    it("leaves a domain manual until assigned, and copies the assignment and publication status", () => {
        const domain = new Domain({ name: "example.com" });
        expect(domain.dnsProviderUid).toBeUndefined();
        expect(domain.dnsPublication).toBeUndefined();
        const publication = { endpoints: [{ name: "e", generation: 1 }], records: [] };
        expect(new Domain({ dnsProviderUid: "cf-x", dnsPublication: publication })).toEqual(expect.objectContaining({ dnsProviderUid: "cf-x", dnsPublication: publication }));
        expect(new Domain({ dnsProviderUid: null }).dnsProviderUid).toBeNull();
    });
});

describe.each([
    ["Mongo", DnsOperationMongo, DnsControllerStateMongo, DomainMongo],
    ["SQL", DnsOperationSQL, DnsControllerStateSQL, DomainSQL],
])("DNS desired-state models (%s)", (_backend, Operation: any, ControllerState: any, Domain: any) => {
    it("constructs a queued operation, and copies every field of one", () => {
        expect(new Operation()).toEqual(expect.objectContaining({ type: "test", providerUid: "", state: "queued" }));
        expect(new Operation({}).records).toBeUndefined();
        const fields = {
            type: "takeover",
            providerUid: "cf-x",
            domainUid: "example.com",
            endpointSetId: "domain-example-com",
            records: [{ dnsName: "example.com", recordType: "MX", targets: ["10 mail.example.com"], ttl: 300 }],
            state: "failed",
            message: "zone not found",
            requestedBy: "admin-uid",
            startedAt: new Date(1),
            finishedAt: new Date(2),
        };
        expect(new Operation(fields)).toEqual(expect.objectContaining(fields));
    });

    it("constructs and copies the controller state", () => {
        expect(new ControllerState().handshake).toBeUndefined();
        const handshake = { controllerVersion: "0.1.0", apiVersions: ["dns.rapidmx.io/v2"], compatible: false, reason: "no API version in common", at: new Date() };
        const lastReport = { controllerVersion: "0.1.0", leaseHolder: true, leaseIdentity: "pod", at: new Date() };
        expect(new ControllerState({ handshake, lastReport })).toEqual(expect.objectContaining({ handshake, lastReport }));
        expect(new ControllerState({ handshake: null }).handshake).toBeNull();
    });

    it("leaves a domain's apex TXT set unmanaged and no rotation until set, and copies both", () => {
        const domain = new Domain({ name: "example.com" });
        expect(domain.apexTxt).toBeUndefined();
        expect(domain.dkimRotation).toBeUndefined();
        const apexTxt = { managed: true, keep: ["ms=1"], spf: "v=spf1 mx ~all" };
        const dkimRotation = { phase: "pending", next: { selector: "rmx20261027", publicKey: "K", createdAt: new Date(), reason: "manual" } };
        expect(new Domain({ apexTxt, dkimRotation })).toEqual(expect.objectContaining({ apexTxt, dkimRotation }));
        expect(new Domain({ apexTxt: null }).apexTxt).toBeNull();
    });
});
