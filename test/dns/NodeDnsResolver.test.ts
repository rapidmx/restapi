///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for NodeDnsResolver - Node's own `dns` module is mocked so no real DNS lookup occurs.
vi.mock("dns", () => ({
    promises: { resolveTxt: vi.fn(), resolveMx: vi.fn(), resolveCname: vi.fn(), resolveSrv: vi.fn(), resolve4: vi.fn(), resolve6: vi.fn() },
}));

import * as dns from "dns";
import { NodeDnsResolver } from "../../src/dns/NodeDnsResolver.js";

const mockResolveTxt = dns.promises.resolveTxt as any;
const mockResolveMx = dns.promises.resolveMx as any;
const mockResolveCname = dns.promises.resolveCname as any;
const mockResolveSrv = dns.promises.resolveSrv as any;
const mockResolve4 = dns.promises.resolve4 as any;
const mockResolve6 = dns.promises.resolve6 as any;

describe("NodeDnsResolver Tests", () => {
    it("Delegates to dns.promises.resolveTxt() and returns its result.", async () => {
        mockResolveTxt.mockResolvedValue([["rapidmx-domain-verification=abc123"]]);
        const resolver = new NodeDnsResolver();

        const result = await resolver.resolveTxt("example.com");

        expect(mockResolveTxt).toHaveBeenCalledWith("example.com");
        expect(result).toEqual([["rapidmx-domain-verification=abc123"]]);
    });

    it("Propagates a rejection from dns.promises.resolveTxt() (e.g. NXDOMAIN).", async () => {
        mockResolveTxt.mockRejectedValue(new Error("queryTxt ENOTFOUND example.com"));
        const resolver = new NodeDnsResolver();

        await expect(resolver.resolveTxt("example.com")).rejects.toThrow(/ENOTFOUND/);
    });

    it("Delegates to dns.promises.resolveMx() and returns its result.", async () => {
        mockResolveMx.mockResolvedValue([{ priority: 10, exchange: "mail.example.com" }]);
        const resolver = new NodeDnsResolver();

        const result = await resolver.resolveMx("example.com");

        expect(mockResolveMx).toHaveBeenCalledWith("example.com");
        expect(result).toEqual([{ priority: 10, exchange: "mail.example.com" }]);
    });

    it("Propagates a rejection from dns.promises.resolveMx() (e.g. NXDOMAIN).", async () => {
        mockResolveMx.mockRejectedValue(new Error("queryMx ENOTFOUND example.com"));
        const resolver = new NodeDnsResolver();

        await expect(resolver.resolveMx("example.com")).rejects.toThrow(/ENOTFOUND/);
    });

    it("Delegates to dns.promises.resolveCname() and returns its result.", async () => {
        mockResolveCname.mockResolvedValue(["mail.example.com"]);
        const resolver = new NodeDnsResolver();

        const result = await resolver.resolveCname("autodiscover.example.com");

        expect(mockResolveCname).toHaveBeenCalledWith("autodiscover.example.com");
        expect(result).toEqual(["mail.example.com"]);
    });

    it("Propagates a rejection from dns.promises.resolveCname() (e.g. NXDOMAIN).", async () => {
        mockResolveCname.mockRejectedValue(new Error("queryCname ENOTFOUND autodiscover.example.com"));
        const resolver = new NodeDnsResolver();

        await expect(resolver.resolveCname("autodiscover.example.com")).rejects.toThrow(/ENOTFOUND/);
    });

    it("Delegates to dns.promises.resolveSrv() and renames its `name` field to `target`.", async () => {
        mockResolveSrv.mockResolvedValue([{ priority: 0, weight: 0, port: 443, name: "mail.example.com" }]);
        const resolver = new NodeDnsResolver();

        const result = await resolver.resolveSrv("_autodiscover._tcp.example.com");

        expect(mockResolveSrv).toHaveBeenCalledWith("_autodiscover._tcp.example.com");
        expect(result).toEqual([{ priority: 0, weight: 0, port: 443, target: "mail.example.com" }]);
    });

    it("Propagates a rejection from dns.promises.resolveSrv() (e.g. NXDOMAIN).", async () => {
        mockResolveSrv.mockRejectedValue(new Error("querySrv ENOTFOUND _autodiscover._tcp.example.com"));
        const resolver = new NodeDnsResolver();

        await expect(resolver.resolveSrv("_autodiscover._tcp.example.com")).rejects.toThrow(/ENOTFOUND/);
    });

    it("Resolves a name's A and AAAA records together.", async () => {
        mockResolve4.mockResolvedValue(["203.0.113.7"]);
        mockResolve6.mockResolvedValue(["2001:db8::7"]);

        expect(await new NodeDnsResolver().resolveAddresses("mail.example.com")).toEqual(["203.0.113.7", "2001:db8::7"]);
    });

    it("Resolves the addresses of the family a name has when the other has none (NODATA).", async () => {
        mockResolve4.mockResolvedValue(["203.0.113.7"]);
        mockResolve6.mockRejectedValue(Object.assign(new Error("queryAaaa ENODATA mail.example.com"), { code: "ENODATA" }));

        expect(await new NodeDnsResolver().resolveAddresses("mail.example.com")).toEqual(["203.0.113.7"]);
    });

    it("Rejects with the no-records error when the name has no address at all.", async () => {
        mockResolve4.mockRejectedValue(Object.assign(new Error("queryA ENODATA x.example.com"), { code: "ENODATA" }));
        mockResolve6.mockRejectedValue(Object.assign(new Error("queryAaaa ENOTFOUND x.example.com"), { code: "ENOTFOUND" }));

        await expect(new NodeDnsResolver().resolveAddresses("x.example.com")).rejects.toMatchObject({ code: "ENODATA" });
    });

    it("Rejects with the unanswered lookup, not a no-records error, when one family could not be asked (nothing is known then).", async () => {
        mockResolve4.mockRejectedValue(Object.assign(new Error("queryA ENODATA x.example.com"), { code: "ENODATA" }));
        mockResolve6.mockRejectedValue(Object.assign(new Error("queryAaaa ETIMEOUT x.example.com"), { code: "ETIMEOUT" }));

        await expect(new NodeDnsResolver().resolveAddresses("x.example.com")).rejects.toMatchObject({ code: "ETIMEOUT" });
    });
});
