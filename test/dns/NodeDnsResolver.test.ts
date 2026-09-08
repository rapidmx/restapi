///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for NodeDnsResolver - Node's own `dns` module is mocked so no real DNS lookup occurs.
vi.mock("dns", () => ({
    promises: { resolveTxt: vi.fn(), resolveMx: vi.fn() },
}));

import * as dns from "dns";
import { NodeDnsResolver } from "../../src/dns/NodeDnsResolver.js";

const mockResolveTxt = dns.promises.resolveTxt as any;
const mockResolveMx = dns.promises.resolveMx as any;

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
});
