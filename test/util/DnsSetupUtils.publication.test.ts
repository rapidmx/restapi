///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `buildDesiredDnsRecords()` is the one source of the records a domain needs: the DNS checklist (`checkDnsSetup()`) and the desired state the DNS
// controller publishes are both built from it, so they can't drift. These tests pin that, the records a rotation adds, the reasons a record stays
// manual, and the publication state the checklist shows next to the live check.
import { buildDesiredDnsRecords, checkDnsSetup, DEFAULT_SPF_VALUE, dnsManualReason, type DnsRecordCheck } from "../../src/util/DnsSetupUtils.js";
import type { DnsProvider, Domain } from "../../src/models/types.js";

function makeDomain(overrides?: Partial<Domain>): Domain {
    return { uid: "example.com", name: "example.com", enabled: true, verified: false, verificationToken: "abc123", ...overrides } as Domain;
}

/** A resolver answering from maps; any other name is NXDOMAIN. */
function resolverFor(records: { txt?: Record<string, string[][]>; mx?: Record<string, any[]>; cname?: Record<string, string[]>; srv?: Record<string, any[]> } = {}) {
    const from = (map: Record<string, any> | undefined) =>
        vi.fn(async (hostname: string) => {
            if (!map || !(hostname in map)) {
                throw new Error(`NXDOMAIN ${hostname}`);
            }
            return map[hostname];
        });
    return { resolveTxt: from(records.txt), resolveMx: from(records.mx), resolveCname: from(records.cname), resolveSrv: from(records.srv) };
}

const rotation = {
    phase: "pending" as const,
    next: { selector: "rmx20261027", publicKey: "NEXTKEY", createdAt: new Date(), reason: "manual" as const },
    previous: { selector: "mail", publicKey: "OLDKEY" },
};

const cloudflare: Pick<DnsProvider, "type" | "zones"> = { type: "cloudflare", zones: ["example.com"] };
const rfc2136: Pick<DnsProvider, "type" | "zones"> = { type: "rfc2136", zones: ["example.com"] };

const shape = (records: { type: string; recordKind: string; recordName: string; configured: boolean; recommendedValue?: string }[]) =>
    records.map(({ type, recordKind, recordName, configured, recommendedValue }) => ({ type, recordKind, recordName, configured, recommendedValue }));

describe("buildDesiredDnsRecords()", () => {
    const combinations: [string, Partial<Domain>, string, string | undefined][] = [
        ["no DKIM key, no mx host, autodiscover off", {}, "", undefined],
        ["a DKIM key, an mx host", { dkimSelector: "mail", dkimPublicKey: "KEY" }, "mail.example.com", undefined],
        ["autodiscover active without a public URL", { dkimSelector: "mail", dkimPublicKey: "KEY" }, "mail.example.com", ""],
        ["autodiscover active with a host", { dkimSelector: "mail", dkimPublicKey: "KEY" }, "mail.example.com", "mail.example.com"],
        ["a rotation in progress", { dkimSelector: "mail", dkimPublicKey: "KEY", dkimRotation: rotation }, "mail.example.com", "mail.example.com"],
        ["an alias with a DMARC report address", { aliasOf: "primary.com", dmarcPolicy: "reject", dmarcReportEmail: "d@example.com" }, "mail.example.com", undefined],
        ["a managed apex TXT set", { apexTxt: { managed: true, keep: ["google-site-verification=x"], spf: "v=spf1 mx include:_spf.example.net ~all" } }, "m.example.com", undefined],
    ];

    it.each(combinations)("recommends exactly what the checklist recommends: %s", async (_name, fields, mxHostname, autodiscover) => {
        const domain = makeDomain(fields);
        const checks: DnsRecordCheck[] = await checkDnsSetup(resolverFor(), domain, mxHostname, autodiscover);
        expect(shape(buildDesiredDnsRecords(domain, { mxHostname, autodiscoverHostname: autodiscover }))).toEqual(shape(checks));
    });

    it("builds every record with the value it is published with", () => {
        const records = buildDesiredDnsRecords(makeDomain({ dkimSelector: "mail", dkimPublicKey: "KEY", dmarcPolicy: "quarantine" }), {
            mxHostname: "mail.example.com",
            autodiscoverHostname: "auto.example.com",
        });
        const byType = Object.fromEntries(records.map((r) => [r.type, r]));
        expect(byType.ownership).toMatchObject({ recordKind: "TXT", recordName: "_rapidmx-verify.example.com", values: ["rapidmx-domain-verification=abc123"] });
        expect(byType.mx).toMatchObject({ recordKind: "MX", recordName: "example.com", values: ["10 mail.example.com"] });
        expect(byType.spf).toMatchObject({ recordKind: "TXT", recordName: "example.com", values: [DEFAULT_SPF_VALUE] });
        expect(byType.dkim).toMatchObject({ recordKind: "TXT", recordName: "mail._domainkey.example.com", values: ["v=DKIM1; k=rsa; p=KEY"] });
        expect(byType.dmarc).toMatchObject({ recordKind: "TXT", recordName: "_dmarc.example.com", values: ["v=DMARC1; p=quarantine;"] });
        expect(byType.openpgpkey_cname).toMatchObject({ recordKind: "CNAME", recordName: "openpgpkey.example.com", values: ["mail.example.com"] });
        expect(byType.autodiscover_cname).toMatchObject({ recordKind: "CNAME", values: ["auto.example.com"] });
        // An SRV target ends with a dot when published; the checklist shows it without.
        expect(byType.autodiscover_srv).toMatchObject({ recordKind: "SRV", recordName: "_autodiscover._tcp.example.com", values: ["0 0 443 auto.example.com."], recommendedValue: "0 0 443 auto.example.com" });
    });

    it("publishes no value for a record that isn't configured yet", () => {
        const records = buildDesiredDnsRecords(makeDomain(), { mxHostname: "", autodiscoverHostname: "" });
        for (const record of records.filter((r) => !r.configured)) {
            expect(record.values).toEqual([]);
        }
        expect(records.filter((r) => !r.configured).map((r) => r.type).sort()).toEqual(["autodiscover_cname", "autodiscover_srv", "dkim", "mx", "openpgpkey_cname"]);
    });

    it("adds the next and previous selectors during a rotation, after the active one", () => {
        const records = buildDesiredDnsRecords(makeDomain({ dkimSelector: "mail", dkimPublicKey: "KEY", dkimRotation: rotation }), { mxHostname: "m.example.com" });
        expect(records.map((r) => r.type)).toEqual(["ownership", "mx", "spf", "dkim", "dkim_next", "dkim_previous", "dmarc", "openpgpkey_cname"]);
        expect(records.find((r) => r.type === "dkim_next")).toMatchObject({ recordName: "rmx20261027._domainkey.example.com", values: ["v=DKIM1; k=rsa; p=NEXTKEY"], configured: true });
        expect(records.find((r) => r.type === "dkim_previous")).toMatchObject({ recordName: "mail._domainkey.example.com", values: ["v=DKIM1; k=rsa; p=OLDKEY"] });
        // Only the half that exists: an idle rotation adds nothing.
        expect(buildDesiredDnsRecords(makeDomain({ dkimRotation: { phase: "idle" } }), { mxHostname: "" }).map((r) => r.type)).not.toContain("dkim_next");
        expect(buildDesiredDnsRecords(makeDomain({ dkimRotation: { phase: "overlap", previous: rotation.previous } }), { mxHostname: "" }).map((r) => r.type)).toEqual(
            expect.arrayContaining(["dkim_previous"]),
        );
    });

    it("publishes SPF with the kept values in one set while the apex TXT set is managed", () => {
        const managed = makeDomain({ apexTxt: { managed: true, keep: ["google-site-verification=x", "ms=y"], spf: "v=spf1 mx include:_spf.example.net ~all" } });
        const spf = buildDesiredDnsRecords(managed, { mxHostname: "" }).find((r) => r.type === "spf")!;
        expect(spf.values).toEqual(["v=spf1 mx include:_spf.example.net ~all", "google-site-verification=x", "ms=y"]);
        expect(spf.recommendedValue).toBe("v=spf1 mx include:_spf.example.net ~all");
        // Opted out: back to the plain recommendation, the kept values no longer in RapidMX's set.
        const optedOut = makeDomain({ apexTxt: { managed: false, keep: ["ms=y"], spf: "v=spf1 mx ~all" } });
        expect(buildDesiredDnsRecords(optedOut, { mxHostname: "" }).find((r) => r.type === "spf")!.values).toEqual([DEFAULT_SPF_VALUE]);
    });
});

describe("dnsManualReason()", () => {
    const records = buildDesiredDnsRecords(makeDomain({ dkimSelector: "mail", dkimPublicKey: "KEY" }), { mxHostname: "mail.example.com", autodiscoverHostname: "m.example.com" });
    const record = (type: string) => records.find((r) => r.type === type)!;

    it("is no_provider for every record of a domain no provider publishes", () => {
        for (const r of records) {
            expect(dnsManualReason(r, makeDomain(), undefined)).toBe("no_provider");
            expect(dnsManualReason(r, makeDomain(), null)).toBe("no_provider");
        }
    });

    it("is outside_zones when the provider's zones don't cover the name", () => {
        expect(dnsManualReason(record("mx"), makeDomain(), { type: "cloudflare", zones: ["other.com"] })).toBe("outside_zones");
    });

    it("is kind_unsupported for MX and SRV on rfc2136, which can't update or delete them", () => {
        expect(dnsManualReason(record("mx"), makeDomain(), rfc2136)).toBe("kind_unsupported");
        expect(dnsManualReason(record("autodiscover_srv"), makeDomain(), rfc2136)).toBe("kind_unsupported");
        expect(dnsManualReason(record("openpgpkey_cname"), makeDomain(), rfc2136)).toBeUndefined();
        expect(dnsManualReason(record("mx"), makeDomain(), cloudflare)).toBeUndefined();
    });

    it("is kind_unsupported for a TXT value rfc2136 can't update or delete: anything but one plain character-string", () => {
        const txt = (...values: string[]) => ({ type: "dmarc" as const, recordKind: "TXT" as const, recordName: "_dmarc.example.com", values });
        // Plain values read back as written: the ownership value and an unquoted word.
        expect(dnsManualReason(record("ownership"), makeDomain(), rfc2136)).toBeUndefined();
        expect(dnsManualReason(txt("ms=1", "google-site-verification=abc_DEF-1.2"), makeDomain(), rfc2136)).toBeUndefined();
        // A space, `;`, a quote, a backslash, parentheses, `$`, `@`, a control or non-ASCII character, a value over 255 bytes, or an empty one.
        for (const value of ["v=DMARC1; p=none;", "a b", "a;b", 'a"b', "a\\b", "a(b", "a)b", "a$b", "a@b", "a\tb", "café","x".repeat(256), ""]) {
            expect(dnsManualReason(txt(value), makeDomain(), rfc2136), JSON.stringify(value)).toBe("kind_unsupported");
        }
        expect(dnsManualReason(txt("x".repeat(255)), makeDomain(), rfc2136)).toBeUndefined();
        // One value that isn't plain makes the whole record manual.
        expect(dnsManualReason(txt("ms=1", "v=spf1 mx ~all"), makeDomain(), rfc2136)).toBe("kind_unsupported");
        // DKIM, SPF and DMARC are never plain.
        for (const type of ["dkim", "spf", "dmarc"]) {
            expect(dnsManualReason(record(type), makeDomain({ apexTxt: { managed: true, keep: [] } }), rfc2136), type).toBe("kind_unsupported");
        }
        // Other providers keep them, and a value that isn't text (an MX) is no TXT.
        for (const provider of [cloudflare, { type: "route53" as const, zones: ["example.com"] }, { type: "google" as const, zones: ["example.com"] }]) {
            expect(dnsManualReason(txt("v=DMARC1; p=none;"), makeDomain(), provider), provider.type).toBeUndefined();
        }
    });

    it("is kind_unsupported for an Azure TXT name with several values, which it writes and reads only the first of", () => {
        const azure: Pick<DnsProvider, "type" | "zones"> = { type: "azure", zones: ["example.com"] };
        const spf = (...values: string[]) => ({ type: "spf" as const, recordKind: "TXT" as const, recordName: "example.com", values });
        const managed = makeDomain({ apexTxt: { managed: true, keep: [] } });
        expect(dnsManualReason(spf("v=spf1 mx ~all", "ms=1"), managed, azure)).toBe("kind_unsupported");
        expect(dnsManualReason(spf("v=spf1 mx ~all"), managed, azure)).toBeUndefined();
        // A value with spaces, quotes or a long one is fine for Azure: one value, written as it is.
        expect(dnsManualReason({ ...spf('v=spf1 "x"'), type: "dmarc" }, makeDomain(), azure)).toBeUndefined();
        expect(dnsManualReason(spf("x".repeat(300)), managed, azure)).toBeUndefined();
        // Several values of another kind don't matter to the TXT rule (an MX set).
        expect(dnsManualReason({ type: "mx", recordKind: "MX", recordName: "example.com", values: ["10 a.example.com", "20 b.example.com"] }, managed, azure)).toBeUndefined();
        expect(dnsManualReason(spf("v=spf1 mx ~all", "ms=1"), managed, cloudflare)).toBeUndefined();
    });

    it("reports the reasons in order: no provider, outside the zones, a kind the provider can't keep, then the unmanaged apex", () => {
        const spf = record("spf");
        // rfc2136 can't keep SPF whatever the opt-in says, so that reason comes before the apex one.
        expect(dnsManualReason(spf, makeDomain(), rfc2136)).toBe("kind_unsupported");
        expect(dnsManualReason(spf, makeDomain(), { type: "rfc2136", zones: ["other.com"] })).toBe("outside_zones");
        expect(dnsManualReason(spf, makeDomain(), cloudflare)).toBe("apex_txt_unmanaged");
    });

    it("is apex_txt_unmanaged for SPF until the domain opts into apex TXT management", () => {
        expect(dnsManualReason(record("spf"), makeDomain(), cloudflare)).toBe("apex_txt_unmanaged");
        expect(dnsManualReason(record("spf"), makeDomain({ apexTxt: { managed: false, keep: [] } }), cloudflare)).toBe("apex_txt_unmanaged");
        expect(dnsManualReason(record("spf"), makeDomain({ apexTxt: { managed: true, keep: [] } }), cloudflare)).toBeUndefined();
        // Ownership verification lives at its own name, so it publishes without the opt-in.
        expect(dnsManualReason(record("ownership"), makeDomain(), cloudflare)).toBeUndefined();
    });
});

describe("checkDnsSetup() publication and the legacy ownership location", () => {
    const domain = makeDomain({ dkimSelector: "mail", dkimPublicKey: "KEY" });
    const ownerId = "rapidmx-k3x9q2m7a1b4c8d0";
    const owned = [[`heritage=external-dns,external-dns/owner=${ownerId},external-dns/resource=crd/mail/x`]];

    it("leaves publication out unless asked, so direct callers see the old shape", async () => {
        const checks = await checkDnsSetup(resolverFor(), domain, "mail.example.com");
        expect(checks.every((c) => c.publication === undefined && c.manualReason === undefined)).toBe(true);
    });

    it("shows every configured record as manual without a provider", async () => {
        const checks = await checkDnsSetup(resolverFor(), domain, "mail.example.com", undefined, { publication: { provider: null } });
        for (const check of checks) {
            expect(check).toMatchObject({ publication: "manual", manualReason: "no_provider" });
        }
    });

    it("is pending until external-dns observed the endpoint and the live check sees the record, then published", async () => {
        const live = resolverFor({ mx: { "example.com": [{ priority: 10, exchange: "mail.example.com" }] }, txt: { "rmx-mx.example.com": owned } });
        const pending = await checkDnsSetup(live, domain, "mail.example.com", undefined, { publication: { provider: cloudflare, observed: false, ownerId } });
        expect(pending.find((c) => c.type === "mx")).toMatchObject({ publication: "pending" });
        expect(pending.find((c) => c.type === "dmarc")).toMatchObject({ publication: "pending" });
        expect(pending.find((c) => c.type === "spf")).toMatchObject({ publication: "manual", manualReason: "apex_txt_unmanaged" });

        const published = await checkDnsSetup(live, domain, "mail.example.com", undefined, { publication: { provider: cloudflare, observed: true, ownerId } });
        expect(published.find((c) => c.type === "mx")).toMatchObject({ publication: "published" });
        expect(published.find((c) => c.type === "mx")!.manualReason).toBeUndefined();
    });

    it("stays pending, though observed and working, until the live values are exactly the desired ones", async () => {
        const ours = (name: string) => ({ [name]: owned });
        const strict = makeDomain({ dkimSelector: "mail", dkimPublicKey: "KEY", dmarcPolicy: "reject", apexTxt: { managed: true, keep: ["ms=1"], spf: "v=spf1 mx ~all" } });
        // The old policy and SPF set are still live: external-dns observed the previous generation, not yet the changed one.
        const before = resolverFor({
            txt: { "_dmarc.example.com": [["v=DMARC1; p=none;"]], "example.com": [["v=spf1 mx ~all"]], ...ours("rmx-txt._dmarc.example.com"), ...ours("rmx-txt.example.com") },
        });
        let checks = await checkDnsSetup(before, strict, "mail.example.com", undefined, { publication: { provider: cloudflare, observed: true, ownerId } });
        expect(checks.find((c) => c.type === "dmarc")).toMatchObject({ found: true, matches: true, publication: "pending" });
        expect(checks.find((c) => c.type === "spf")).toMatchObject({ found: true, matches: true, publication: "pending" });

        const after = resolverFor({
            txt: {
                "_dmarc.example.com": [["v=DMARC1; p=reject;"]],
                "example.com": [["ms=1"], ["v=spf1 mx ~all"]],
                ...ours("rmx-txt._dmarc.example.com"),
                ...ours("rmx-txt.example.com"),
                ...ours("rmx-cname.openpgpkey.example.com"),
            },
            mx: { "example.com": [{ priority: 10, exchange: "MAIL.example.com." }] },
            cname: { "openpgpkey.example.com": ["mail.example.com."] },
        });
        checks = await checkDnsSetup(after, strict, "mail.example.com", undefined, { publication: { provider: cloudflare, observed: true, ownerId } });
        expect(checks.find((c) => c.type === "dmarc")).toMatchObject({ publication: "published" });
        expect(checks.find((c) => c.type === "spf")).toMatchObject({ publication: "published" });
        // Host names compare without case or the final dot.
        expect(checks.find((c) => c.type === "openpgpkey_cname")).toMatchObject({ publication: "published" });
        // Another MX next to ours is not what is published.
        const extraMx = resolverFor({ mx: { "example.com": [{ priority: 10, exchange: "mail.example.com" }, { priority: 20, exchange: "backup.example.net" }] }, txt: { "rmx-mx.example.com": owned } });
        checks = await checkDnsSetup(extraMx, strict, "mail.example.com", undefined, { publication: { provider: cloudflare, observed: true, ownerId } });
        expect(checks.find((c) => c.type === "mx")).toMatchObject({ matches: true, publication: "pending" });
    });

    it("compares a published SRV record's target and a DKIM key exactly", async () => {
        const srv = resolverFor({
            srv: { "_autodiscover._tcp.example.com": [{ priority: 0, weight: 0, port: 443, target: "Auto.example.com." }] },
            txt: { "rmx-srv._autodiscover._tcp.example.com": owned, "mail._domainkey.example.com": [["v=DKIM1; k=rsa; p=KEY; t=s"]], "rmx-txt.mail._domainkey.example.com": owned },
        });
        const checks = await checkDnsSetup(srv, domain, "mail.example.com", "auto.example.com", { publication: { provider: cloudflare, observed: true, ownerId } });
        expect(checks.find((c) => c.type === "autodiscover_srv")).toMatchObject({ matches: true, publication: "published" });
        // Carries the key, but isn't the value published.
        expect(checks.find((c) => c.type === "dkim")).toMatchObject({ matches: true, publication: "pending" });
    });

    it("is a conflict when a record is there that this deployment doesn't own", async () => {
        const foreign = resolverFor({
            mx: { "example.com": [{ priority: 10, exchange: "mx.elsewhere.net" }] },
            txt: { "_dmarc.example.com": [["v=DMARC1; p=none;"]], "rmx-txt._dmarc.example.com": [["heritage=external-dns,external-dns/owner=rapidmx-someoneelse0000"]] },
        });
        const checks = await checkDnsSetup(foreign, domain, "mail.example.com", undefined, { publication: { provider: cloudflare, observed: true, ownerId } });
        expect(checks.find((c) => c.type === "mx")).toMatchObject({ found: true, matches: false, publication: "conflict" });
        // Another deployment's ownership record is not ours, even where the value happens to match.
        expect(checks.find((c) => c.type === "dmarc")).toMatchObject({ found: true, matches: true, publication: "conflict" });
        // Nothing there yet is no conflict.
        expect(checks.find((c) => c.type === "openpgpkey_cname")).toMatchObject({ found: false, publication: "pending" });
    });

    it("does not report a conflict while the owner id isn't known", async () => {
        const foreign = resolverFor({ mx: { "example.com": [{ priority: 10, exchange: "mx.elsewhere.net" }] } });
        const checks = await checkDnsSetup(foreign, domain, "mail.example.com", undefined, { publication: { provider: cloudflare, observed: true } });
        expect(checks.find((c) => c.type === "mx")).toMatchObject({ publication: "pending" });
    });

    it("shows MX and SRV as manual on rfc2136", async () => {
        const checks = await checkDnsSetup(resolverFor(), domain, "mail.example.com", "auto.example.com", { publication: { provider: rfc2136, ownerId } });
        expect(checks.find((c) => c.type === "mx")).toMatchObject({ publication: "manual", manualReason: "kind_unsupported" });
        expect(checks.find((c) => c.type === "autodiscover_srv")).toMatchObject({ publication: "manual", manualReason: "kind_unsupported" });
        expect(checks.find((c) => c.type === "autodiscover_cname")).toMatchObject({ publication: "pending" });
    });

    it("says a token is still at the domain's root, the old location, while recommending only _rapidmx-verify", async () => {
        const token = [["rapidmx-domain-verification=abc123"]];
        const apexOnly = (await checkDnsSetup(resolverFor({ txt: { "example.com": token } }), domain, "")).find((c) => c.type === "ownership")!;
        expect(apexOnly).toMatchObject({ recordName: "_rapidmx-verify.example.com", found: false, matches: false, legacyApex: true });

        const both = (await checkDnsSetup(resolverFor({ txt: { "example.com": token, "_rapidmx-verify.example.com": token } }), domain, "")).find((c) => c.type === "ownership")!;
        expect(both).toMatchObject({ found: true, matches: true, legacyApex: true });

        const moved = (await checkDnsSetup(resolverFor({ txt: { "_rapidmx-verify.example.com": token } }), domain, "")).find((c) => c.type === "ownership")!;
        expect(moved).toMatchObject({ found: true, matches: true });
        expect(moved.legacyApex).toBeUndefined();
    });

    it("is a conflict when another value than the token is at _rapidmx-verify and the registry record isn't ours, as for every other record", async () => {
        // A hand-made record of an earlier token (the domain was deleted and added again), or one a rebuilt installation owned.
        const stale = [["rapidmx-domain-verification=old999"]];
        const foreign = resolverFor({ txt: { "_rapidmx-verify.example.com": stale } });
        let checks = await checkDnsSetup(foreign, domain, "", undefined, { publication: { provider: cloudflare, observed: true, ownerId } });
        expect(checks.find((c) => c.type === "ownership")).toMatchObject({ found: true, matches: false, publication: "conflict", conflictReason: "not_owned" });

        const oursStale = resolverFor({ txt: { "_rapidmx-verify.example.com": stale, "rmx-txt._rapidmx-verify.example.com": owned } });
        checks = await checkDnsSetup(oursStale, domain, "", undefined, { publication: { provider: cloudflare, observed: true, ownerId } });
        expect(checks.find((c) => c.type === "ownership")).toMatchObject({ found: true, matches: false, publication: "pending" });

        // A lookup that fails is no record.
        const nothing = resolverFor();
        checks = await checkDnsSetup(nothing, domain, "", undefined, { publication: { provider: cloudflare, observed: true, ownerId } });
        expect(checks.find((c) => c.type === "ownership")).toMatchObject({ found: false, matches: false, publication: "pending" });
    });

    it("live-checks the next and previous DKIM selectors during a rotation", async () => {
        const rotating = makeDomain({ dkimSelector: "mail", dkimPublicKey: "KEY", dkimRotation: rotation });
        const live = resolverFor({ txt: { "rmx20261027._domainkey.example.com": [["v=DKIM1; k=rsa; p=NEXTKEY"]] } });
        const checks = await checkDnsSetup(live, rotating, "");
        expect(checks.find((c) => c.type === "dkim_next")).toMatchObject({ configured: true, found: true, matches: true });
        expect(checks.find((c) => c.type === "dkim_previous")).toMatchObject({ configured: true, found: false, matches: false });
    });
});
