///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// judgeConflict(): what is live at the name of a record RapidMX publishes, against the record published there.
import { judgeConflict } from "../../src/util/DnsSetupUtils.js";
import { StaticDnsResolver } from "../testDoubles.js";

const OWNER = "rapidmx-0123456789abcdef";
const registry = (owner: string = OWNER): string[][] => [[`heritage=external-dns,external-dns/owner=${owner},external-dns/resource=crd/mail/x`]];

describe("judgeConflict()", () => {
    let resolver: StaticDnsResolver;

    beforeEach(() => {
        resolver = new StaticDnsResolver();
    });

    const judge = (subject: Partial<Parameters<typeof judgeConflict>[1]>) =>
        judgeConflict(resolver, { recordKind: "CNAME", recordName: "autodiscover.example.com", found: false, ownerId: OWNER, ...subject });

    it("judges nothing while the owner id is unknown", async () => {
        resolver.addressRecords.set("autodiscover.example.com", ["192.0.2.1"]);

        expect(await judge({ ownerId: undefined })).toBeUndefined();
    });

    it("names the MX and TXT records a CNAME can't stand next to, with the priority of an MX", async () => {
        resolver.mxRecords.set("autodiscover.example.com", [{ priority: 10, exchange: "mx.old.example.net" }]);
        resolver.records.set("autodiscover.example.com", [["v=spf1 ", "-all"]]);

        expect(await judge({})).toEqual({
            conflictReason: "type_mismatch",
            existing: [
                { type: "MX", value: "10 mx.old.example.net" },
                { type: "TXT", value: "v=spf1 -all" },
            ],
        });
    });

    it("leaves out the types this deployment owns and judges the others", async () => {
        resolver.mxRecords.set("autodiscover.example.com", [{ priority: 10, exchange: "mx.old.example.net" }]);
        resolver.records.set("autodiscover.example.com", [["v=spf1 -all"]]);
        resolver.records.set("rmx-mx.autodiscover.example.com", registry());
        resolver.records.set("rmx-txt.autodiscover.example.com", registry("rapidmx-someoneelse"));

        expect(await judge({})).toEqual({ conflictReason: "type_mismatch", existing: [{ type: "TXT", value: "v=spf1 -all" }] });
    });

    it("never looks next to a CNAME that is there, only at whose it is", async () => {
        resolver.cnameRecords.set("autodiscover.example.com", ["elsewhere.example.net"]);
        resolver.addressRecords.set("autodiscover.example.com", ["192.0.2.1"]);

        expect(await judge({ found: true })).toEqual({ conflictReason: "not_owned" });
        resolver.records.set("rmx-cname.autodiscover.example.com", registry());
        expect(await judge({ found: true })).toBeUndefined();
    });

    it("reads a lookup that can't be answered as no record, for the records next to a CNAME and for a CNAME in the way", async () => {
        resolver.failing.add("autodiscover.example.com");

        expect(await judge({})).toBeUndefined();
        expect(await judge({ recordKind: "TXT", recordName: "autodiscover.example.com", found: false })).toBeUndefined();
    });

    it("looks for a CNAME in the way of every other kind of record, unless told it can't be there", async () => {
        resolver.cnameRecords.set("_dmarc.example.com", ["_dmarc.provider.example.net"]);

        for (const recordKind of ["TXT", "MX", "SRV", "A", "AAAA"] as const) {
            expect(await judge({ recordKind, recordName: "_dmarc.example.com" }), recordKind).toEqual({
                conflictReason: "type_mismatch",
                existing: [{ type: "CNAME", value: "_dmarc.provider.example.net" }],
            });
        }
        expect(await judge({ recordKind: "MX", recordName: "_dmarc.example.com", checkCname: false })).toBeUndefined();
        resolver.records.set("rmx-cname._dmarc.example.com", registry());
        expect(await judge({ recordKind: "TXT", recordName: "_dmarc.example.com" })).toEqual({ replacing: true });
    });

    it("tells a CNAME wanted next to addresses from a resolver that can't look addresses up: it sees none", async () => {
        const blind = { resolveTxt: resolver.resolveTxt.bind(resolver), resolveMx: resolver.resolveMx.bind(resolver), resolveCname: resolver.resolveCname.bind(resolver), resolveSrv: resolver.resolveSrv.bind(resolver) };
        resolver.addressRecords.set("autodiscover.example.com", ["192.0.2.1"]);

        expect(await judgeConflict(blind, { recordKind: "CNAME", recordName: "autodiscover.example.com", found: false, ownerId: OWNER })).toBeUndefined();
    });

    describe("a wildcard record of the zone", () => {
        it("is not a CNAME in the way: it is not at the name, so the admin can't delete it there", async () => {
            resolver.cnameRecords.set("_dmarc.example.com", ["wild.example.net"]);
            resolver.cnameRecords.set("*.example.com", ["wild.example.net"]);
            const answering = Object.create(resolver, {
                resolveCname: { value: async (name: string) => (name.startsWith("rmx-probe-") ? ["wild.example.net"] : resolver.resolveCname(name)) },
            });

            expect(await judgeConflict(answering, { recordKind: "TXT", recordName: "_dmarc.example.com", found: false, ownerId: OWNER })).toBeUndefined();
            // A CNAME that differs from the wildcard's is at the name.
            resolver.cnameRecords.set("_dmarc.example.com", ["own.example.net"]);
            expect(await judgeConflict(answering, { recordKind: "TXT", recordName: "_dmarc.example.com", found: false, ownerId: OWNER })).toEqual({
                conflictReason: "type_mismatch",
                existing: [{ type: "CNAME", value: "own.example.net" }],
            });
        });

        it("is not a record next to a wanted CNAME, while the name's own records still are", async () => {
            resolver.addressRecords.set("autodiscover.example.com", ["192.0.2.1", "192.0.2.2"]);
            const answering = Object.create(resolver, {
                resolveAddresses: { value: async (name: string) => (name.startsWith("rmx-probe-") ? ["192.0.2.1"] : resolver.resolveAddresses(name)) },
            });

            expect(await judgeConflict(answering, { recordKind: "CNAME", recordName: "autodiscover.example.com", found: false, ownerId: OWNER })).toEqual({
                conflictReason: "type_mismatch",
                existing: [{ type: "A", value: "192.0.2.2" }],
            });
            resolver.addressRecords.set("autodiscover.example.com", ["192.0.2.1"]);
            expect(await judgeConflict(answering, { recordKind: "CNAME", recordName: "autodiscover.example.com", found: false, ownerId: OWNER })).toBeUndefined();
        });
    });
});
