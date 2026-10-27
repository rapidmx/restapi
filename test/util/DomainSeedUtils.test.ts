///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `parseSeedDomainEntries()`: the shapes `mail:domains` accepts (spec 13.1), each entry checked on its own, and duplicates. What a valid entry then
// becomes, and the rules `BaseDomainRoute.create()` applies to it, are in ./domainSeedSuite.ts against both backends.
import { parseSeedDomainEntries } from "../../src/util/DomainSeedUtils.js";

describe("parseSeedDomainEntries()", () => {
    it("seeds nothing when the key is unset or empty", () => {
        for (const value of [undefined, null, "", "  ", [], ","]) {
            expect(parseSeedDomainEntries(value)).toEqual({ entries: [], problems: [] });
        }
    });

    it("accepts a comma-separated string, trimming and lowercasing each name", () => {
        expect(parseSeedDomainEntries(" Example.com, mail.example.org ,,b.example.net").entries).toEqual([
            { name: "example.com" },
            { name: "mail.example.org" },
            { name: "b.example.net" },
        ]);
    });

    it("accepts a list of names and objects with their options", () => {
        const { entries, problems } = parseSeedDomainEntries([
            "example.com",
            { name: "Alias.Example.com", aliasOf: " EXAMPLE.com " },
            { name: "example.org", dnsProvider: "bootstrap", dmarcPolicy: "reject", dmarcReportEmail: "dmarc@example.org" },
        ]);
        expect(problems).toEqual([]);
        expect(entries).toEqual([
            { name: "example.com" },
            { name: "alias.example.com", aliasOf: "example.com" },
            { name: "example.org", dnsProvider: "bootstrap", dmarcPolicy: "reject", dmarcReportEmail: "dmarc@example.org" },
        ]);
    });

    it("accepts the list as JSON text, as a ConfigMap value that nconf left unparsed would be", () => {
        expect(parseSeedDomainEntries('[{"name":"example.com","dnsProvider":"bootstrap"},"example.org"]').entries).toEqual([
            { name: "example.com", dnsProvider: "bootstrap" },
            { name: "example.org" },
        ]);
        expect(parseSeedDomainEntries(' {"name":"example.com"} ').entries).toEqual([{ name: "example.com" }]);
    });

    it("accepts one object on its own as a list of one", () => {
        expect(parseSeedDomainEntries({ name: "example.com", dmarcPolicy: "none" }).entries).toEqual([{ name: "example.com", dmarcPolicy: "none" }]);
    });

    it("reports JSON text it can't read, and any other kind of value, and seeds nothing from it", () => {
        for (const value of ["[oops", '{"name":', 42, true]) {
            const { entries, problems } = parseSeedDomainEntries(value);
            expect(entries).toEqual([]);
            expect(problems).toHaveLength(1);
            expect(problems[0]).toMatch(/mail:domains/);
        }
    });

    it("skips each malformed entry on its own, keeping the others", () => {
        const { entries, problems } = parseSeedDomainEntries([
            "good.example.com",
            42,
            null,
            ["nested.example.com"],
            {},
            { name: "" },
            { name: 5 },
            { name: "typed.example.com", dnsProvider: 1 },
            { name: "typed2.example.com", dmarcPolicy: false },
            { name: "typed3.example.com", dmarcReportEmail: {} },
            { name: "typed4.example.com", aliasOf: ["x"] },
            { name: "typo.example.com", dnsprovider: "bootstrap" },
            { name: "also-good.example.com" },
        ]);
        expect(entries).toEqual([{ name: "good.example.com" }, { name: "also-good.example.com" }]);
        expect(problems).toHaveLength(11);
        // A misspelled option is named, so the operator can find it; the entry is skipped rather than seeded without it, since a seeded domain is never
        // changed again from config.
        expect(problems.find((problem) => problem.includes("typo.example.com"))).toMatch(/dnsprovider/);
        expect(problems.find((problem) => problem.includes("typed.example.com"))).toMatch(/dnsProvider/);
    });

    it("keeps the first of two entries naming the same domain, whatever their case", () => {
        const { entries, problems } = parseSeedDomainEntries([{ name: "example.com", dmarcPolicy: "reject" }, "EXAMPLE.COM", { name: "Example.com " }]);
        expect(entries).toEqual([{ name: "example.com", dmarcPolicy: "reject" }]);
        expect(problems).toHaveLength(2);
        expect(problems[0]).toMatch(/example\.com/);
    });

    it("leaves the rules of a domain's name and options to the create path, which applies the same ones as the console", () => {
        // Shape only here: these are skipped later, by `prepareNewDomain()`, with the same messages a console create gets.
        expect(parseSeedDomainEntries([{ name: "not a host!", dmarcPolicy: "maybe" }]).entries).toEqual([{ name: "not a host!", dmarcPolicy: "maybe" }]);
    });
});
