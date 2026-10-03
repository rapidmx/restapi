///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for `DomainUtils`: a fake `Domain` repository for every method of the service class, plus a real ObjectFactory to
// prove the standard construction wiring, and the module's pure helpers.
import config from "../config.js";
import { Logger } from "@rapidrest/core";
import { ObjectFactory } from "@rapidrest/service-core";
import { createFederatedPeerCheck, DomainUtils, extractPublicHostname } from "../../src/util/DomainUtils.js";

function fakeRepo(domains: any[]) {
    return {
        find: vi.fn(async (query: any) => domains.filter((d) => (query.aliasOf === undefined ? true : d.aliasOf === query.aliasOf))),
        findOne: vi.fn(async (name: string) => domains.find((d) => d.name === name)),
    };
}

const DOMAINS = [
    { name: "example.com", enabled: true, verified: true },
    { name: "alias.example", enabled: true, verified: true, aliasOf: "example.com" },
    { name: "off.example", enabled: false, verified: true, aliasOf: "example.com" },
    { name: "unverified.example", enabled: true, verified: false, aliasOf: "example.com" },
    { name: "dangling.example", enabled: true, verified: true, aliasOf: "gone.example" },
    { name: "plain.example", enabled: true, verified: true },
    { name: "downalias.example", enabled: true, verified: true, aliasOf: "off.example" },
];

describe("DomainUtils Tests", () => {
    let repo: ReturnType<typeof fakeRepo>;
    let utils: DomainUtils;

    beforeEach(() => {
        repo = fakeRepo(DOMAINS);
        utils = new DomainUtils(repo as any);
    });

    it("Lists the names of every enabled and verified domain with an explicit, large limit.", async () => {
        const names = await utils.getVerifiedDomainNames();

        expect(names).toEqual(DOMAINS.map((d) => d.name));
        expect(repo.find).toHaveBeenCalledWith({ enabled: true, verified: true, limit: 10_000 }, { ignoreACL: true, limit: 10_000 });
    });

    it("Lists only the domains that are not aliases as the primary domains.", async () => {
        expect(await utils.getPrimaryDomainNames()).toEqual(["example.com", "plain.example"]);
    });

    it("Lists the alias domains of a primary, matching it case-insensitively.", async () => {
        const names = await utils.getAliasDomainNames("Example.COM");

        expect(names.sort()).toEqual(["alias.example", "off.example", "unverified.example"].sort());
        expect(repo.find).toHaveBeenCalledWith(
            { enabled: true, verified: true, aliasOf: "example.com", limit: 10_000 },
            { ignoreACL: true, limit: 10_000 },
        );
    });

    it("Resolves an alias domain name to its primary's name.", async () => {
        expect(await utils.resolveDomainAliasName("Alias.Example")).toBe("example.com");
    });

    it("Resolves nothing for a missing, disabled, unverified, non-alias or dangling domain.", async () => {
        expect(await utils.resolveDomainAliasName("missing.example")).toBeUndefined();
        expect(await utils.resolveDomainAliasName("off.example")).toBeUndefined();
        expect(await utils.resolveDomainAliasName("unverified.example")).toBeUndefined();
        expect(await utils.resolveDomainAliasName("plain.example")).toBeUndefined();
        expect(await utils.resolveDomainAliasName("dangling.example")).toBeUndefined();
        // The alias is fine but its primary is disabled.
        expect(await utils.resolveDomainAliasName("downalias.example")).toBeUndefined();
    });

    it("Rewrites an address on an alias domain onto its primary domain, keeping the local part.", async () => {
        expect(await utils.resolveDomainAlias("Jo@alias.example")).toBe("Jo@example.com");
    });

    it("Rewrites nothing for an address without an @ or on a domain that is not an alias.", async () => {
        expect(await utils.resolveDomainAlias("no-at-sign")).toBeUndefined();
        expect(await utils.resolveDomainAlias("jo@plain.example")).toBeUndefined();
        expect(repo.findOne).toHaveBeenCalledTimes(1);
    });

    it("Tells an internal address from an external one, querying the domains only when they are not passed in.", async () => {
        expect(await utils.isInternalAddress("jo@example.com")).toBe(true);
        expect(await utils.isInternalAddress("jo@elsewhere.org")).toBe(false);
        expect(repo.find).toHaveBeenCalledTimes(2);

        repo.find.mockClear();
        expect(await utils.isInternalAddress("jo@listed.test", ["listed.test"])).toBe(true);
        expect(await utils.isInternalAddress("not-an-address")).toBe(false);
        expect(repo.find).not.toHaveBeenCalled();
    });

    it("Treats the domain case-insensitively and reads no domains for an address without one.", async () => {
        expect(await utils.isInternalAddress("user@EXAMPLE.COM")).toBe(true);
        expect(await utils.resolveDomainAlias("jean-philippe@ALIAS.EXAMPLE")).toBe("jean-philippe@example.com");
    });

    it("Never asks the federation check about a same-org address.", async () => {
        const federated = vi.fn(async () => true);

        expect(await utils.classifyRecipientTier("user@example.com", federated)).toBe("same-org");
        expect(federated).not.toHaveBeenCalled();
        expect(await utils.classifyRecipientTier("user@peer.com", vi.fn(async () => false))).toBe("external");
    });

    it("Classifies a recipient as same-org, federated or external.", async () => {
        expect(await utils.classifyRecipientTier("jo@example.com")).toBe("same-org");
        expect(await utils.classifyRecipientTier("jo@elsewhere.org")).toBe("external");

        const federated = vi.fn(async () => true);
        expect(await utils.classifyRecipientTier("jo@elsewhere.org", federated, ["example.com"])).toBe("federated");
        expect(federated).toHaveBeenCalledWith("jo@elsewhere.org");
        expect(await utils.classifyRecipientTier("jo@example.com", federated, ["example.com"])).toBe("same-org");
        expect(federated).toHaveBeenCalledTimes(1);
    });

    describe("With a real ObjectFactory", () => {
        let objectFactory: ObjectFactory;

        beforeEach(() => {
            objectFactory = new ObjectFactory(config, Logger());
        });

        afterEach(async () => {
            await objectFactory.destroy();
        });

        it("Injects a logger and returns the same instance for the same name.", async () => {
            const first: any = await objectFactory.newInstance(DomainUtils, { name: "DomainMongo", args: [repo] });
            const second: any = await objectFactory.newInstance(DomainUtils, { name: "DomainMongo", args: [repo] });

            expect(first).toBeInstanceOf(DomainUtils);
            expect(second).toBe(first);
            expect(first.domainRepo).toBe(repo);
            expect(first.logger).toBeDefined();
            expect(await first.getPrimaryDomainNames()).toEqual(["example.com", "plain.example"]);
        });
    });
});

describe("createFederatedPeerCheck() Tests", () => {
    function makeResolver(txtRecords: string[][]) {
        return { resolveTxt: vi.fn().mockResolvedValue(txtRecords), resolveMx: vi.fn() };
    }

    it("Returns true for an address whose domain publishes a valid _rapidmx TXT record.", async () => {
        const resolver = makeResolver([["v=RMXv1; id=1; host=mail.peer1.example;"]]);
        const check = createFederatedPeerCheck(resolver);

        const result = await check("user@peer1.example");

        expect(result).toBe(true);
        expect(resolver.resolveTxt).toHaveBeenCalledWith("_rapidmx.peer1.example");
    });

    it("Returns false for an address whose domain publishes no _rapidmx record.", async () => {
        const resolver = { resolveTxt: vi.fn().mockRejectedValue(new Error("NXDOMAIN")), resolveMx: vi.fn() };
        const check = createFederatedPeerCheck(resolver);

        const result = await check("user@peer2.example");

        expect(result).toBe(false);
    });

    it("Returns false without querying DNS at all for an address with no @ (no domain to check).", async () => {
        const resolver = makeResolver([["v=RMXv1; id=1; host=mail.peer3.example;"]]);
        const check = createFederatedPeerCheck(resolver);

        const result = await check("not-an-address");

        expect(result).toBe(false);
        expect(resolver.resolveTxt).not.toHaveBeenCalled();
    });
});

describe("extractPublicHostname() Tests", () => {
    it("Returns the hostname of a valid https:// URL.", () => {
        expect(extractPublicHostname("https://mail.example.com")).toBe("mail.example.com");
    });

    it("Returns the hostname of a valid https:// URL with a path.", () => {
        expect(extractPublicHostname("https://mail.example.com/some/path")).toBe("mail.example.com");
    });

    it("Returns '' for an empty or whitespace-only value.", () => {
        expect(extractPublicHostname("")).toBe("");
        expect(extractPublicHostname("   ")).toBe("");
    });

    it("Returns '' for a value that isn't a parseable URL at all.", () => {
        expect(extractPublicHostname("not a url")).toBe("");
    });

    it("Returns '' for a plain http:// URL (not https).", () => {
        expect(extractPublicHostname("http://mail.example.com")).toBe("");
    });

    it("Returns '' for a URL carrying credentials.", () => {
        expect(extractPublicHostname("https://user:pass@mail.example.com")).toBe("");
    });
});
