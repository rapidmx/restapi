///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The contract with the DNS controller. `test/fixtures/dns-api/v1/*.json` are byte-identical copies of rapidmx/dns-controller's
// `test/fixtures/api/v1/*.json`, which that repository's own contract test reads: change both repositories together, never one copy.
import { readFileSync } from "node:fs";
import {
    API_VERSION_V1,
    ApiVersionError,
    DnsApiPayloadError,
    expectV1,
    negotiateHandshake,
    parseStatusReport,
    SUPPORTED_API_VERSIONS,
    versionPath,
    type DesiredStateV1,
} from "../../src/dns/DnsDesiredStateApiV1.js";

function fixture(name: string): any {
    return JSON.parse(readFileSync(new URL(`../fixtures/dns-api/v1/${name}.json`, import.meta.url), "utf8"));
}

describe("DNS desired-state API v1 (contract)", () => {
    it("speaks exactly dns.rapidmx.io/v1, served under /v1", () => {
        expect(API_VERSION_V1).toBe("dns.rapidmx.io/v1");
        expect(SUPPORTED_API_VERSIONS).toEqual(["dns.rapidmx.io/v1"]);
        expect(versionPath(API_VERSION_V1)).toBe("/v1");
        expect(versionPath("dns.rapidmx.io/v2")).toBe("/v2");
    });

    describe("handshake", () => {
        it("answers the controller's handshake fixture with the compatible fixture", () => {
            expect(negotiateHandshake(fixture("handshake"), "1.0.0-beta.47")).toEqual(fixture("handshake-result-compatible"));
        });

        it("answers with the incompatible fixture when the two share no version, giving the reason", () => {
            expect(negotiateHandshake(fixture("handshake"), "2.0.0", ["dns.rapidmx.io/v2"])).toEqual(fixture("handshake-result-incompatible"));
        });

        it("selects the best version both speak, in the server's order", () => {
            const result = negotiateHandshake({ kind: "Handshake", controllerVersion: "0.2.0", apiVersions: ["dns.rapidmx.io/v1", "dns.rapidmx.io/v2"] }, "3.0.0", [
                "dns.rapidmx.io/v2",
                "dns.rapidmx.io/v1",
            ]);
            expect(result).toEqual({ kind: "HandshakeResult", serverVersion: "3.0.0", apiVersions: ["dns.rapidmx.io/v2", "dns.rapidmx.io/v1"], compatible: true, selected: "dns.rapidmx.io/v2" });
        });

        it("refuses a body that isn't a Handshake", () => {
            for (const bad of [null, "x", {}, { kind: "Handshake" }, { kind: "Handshake", apiVersions: "v1", controllerVersion: "1" }, { kind: "Other", apiVersions: [], controllerVersion: "1" }]) {
                expect(() => negotiateHandshake(bad, "1.0.0"), JSON.stringify(bad)).toThrow(DnsApiPayloadError);
            }
            expect(() => negotiateHandshake({ kind: "Handshake", controllerVersion: "1", apiVersions: Array(21).fill("v") }, "1")).toThrow(DnsApiPayloadError);
            expect(() => negotiateHandshake({ kind: "Handshake", controllerVersion: "x".repeat(101), apiVersions: [] }, "1")).toThrow(DnsApiPayloadError);
        });
    });

    describe("desired state", () => {
        it("accepts the desired-state fixture, ignoring fields it does not know", () => {
            const state = expectV1<DesiredStateV1>(fixture("desired-state"), "DesiredState");
            expect(state.version).toBe(42);
            expect(state.endpointSets[0].records.map((r) => r.dnsName)).toContain("_rapidmx-verify.example.com");
            // An option value may be a list.
            expect(state.providers[0].options.zoneIds).toEqual(["0123456789abcdef0123456789abcdef"]);
        });
    });

    describe("status report", () => {
        it("accepts the status-report fixture", () => {
            const report = parseStatusReport(fixture("status-report"));
            expect(report).toEqual({
                apiVersion: "dns.rapidmx.io/v1",
                kind: "StatusReport",
                controllerVersion: "0.1.0",
                desiredStateVersion: 42,
                lease: { holder: true, identity: "mail-dns-controller-7c9f8-abcde" },
                providers: [{ providerUid: "cloudflare-main", readyReplicas: 1, lastSyncAt: "2026-10-27T10:00:00Z" }],
                endpoints: [{ endpointSetId: "domain-example-com", generation: 3, observedGeneration: 3 }],
                operations: [],
            });
        });

        it("refuses another apiVersion or kind, naming what it received", () => {
            const v2 = { ...fixture("status-report"), apiVersion: "dns.rapidmx.io/v2" };
            let err: unknown;
            try {
                parseStatusReport(v2);
            } catch (e) {
                err = e;
            }
            expect(err).toBeInstanceOf(ApiVersionError);
            expect(err).toMatchObject({ received: "dns.rapidmx.io/v2" });
            expect(() => parseStatusReport(fixture("desired-state"))).toThrow(ApiVersionError);
            expect(() => parseStatusReport(null)).toThrow(ApiVersionError);
        });

        it("refuses a malformed report rather than storing half of it", () => {
            const base = fixture("status-report");
            const bad = [
                { ...base, controllerVersion: 1 },
                { ...base, lease: { holder: "yes", identity: "x" } },
                { ...base, providers: [{ providerUid: 3, readyReplicas: 1 }] },
                { ...base, providers: [{ providerUid: "p", readyReplicas: -1 }] },
                { ...base, endpoints: [{ endpointSetId: "e", generation: "3" }] },
                { ...base, operations: [{ id: "o", state: "done" }] },
                { ...base, providers: "none" },
                { ...base, desiredStateVersion: "42" },
            ];
            for (const report of bad) {
                expect(() => parseStatusReport(report), JSON.stringify(report)).toThrow(DnsApiPayloadError);
            }
        });

        it("keeps only the fields it knows, and shortens an over-long message", () => {
            const report = parseStatusReport({
                ...fixture("status-report"),
                providers: [{ providerUid: "p", readyReplicas: 0, lastError: "e".repeat(5000), extra: true }],
                operations: [{ id: "o", state: "failed", message: "m".repeat(5000), extra: 1 }],
            });
            expect(report.providers[0]).toEqual({ providerUid: "p", readyReplicas: 0, lastError: "e".repeat(2000) });
            expect(report.operations[0]).toEqual({ id: "o", state: "failed", message: "m".repeat(2000) });
        });
    });

    it("expectV1() refuses a payload without an apiVersion, of another kind, or not an object", () => {
        expect(() => expectV1({ kind: "DesiredState" }, "DesiredState")).toThrow("unsupported apiVersion undefined");
        expect(() => expectV1(fixture("status-report"), "DesiredState")).toThrow('expected kind DesiredState, got "StatusReport"');
        expect(() => expectV1(null, "DesiredState")).toThrow("expected a DesiredState object");
    });
});
