///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { DkimKeyProvider } from "../dkim/DkimKeyProvider.js";
import { isNameInZones } from "../dns/DnsProviderTypes.js";
import { notifyDnsPublisher, resolveDnsPublisher, type DnsPublisher } from "../dns/DnsPublisher.js";
import { AuditAction, DnsProvider, Domain, SetupState } from "../models/types.js";
import { normalizeAddress } from "./AddressUtils.js";
import { AuditLogUtils } from "./AuditLogUtils.js";
import { prepareNewDomain } from "./DomainUtils.js";
import { asEntity } from "./EntityUtils.js";
import { SETUP_STATE_UID, updateSetupState } from "./SetupStateUtils.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

/** What a `mail:domains` entry's `dnsProvider` says to mean the provider config the installer created (`DnsProvider.origin: "installer"`). */
export const BOOTSTRAP_DNS_PROVIDER = "bootstrap";

/** One domain the deployment is installed for: an entry of `mail:domains`, either its name alone or an object with these options. */
export interface SeedDomainEntry {
    name: string;
    /** The `DnsProvider` to assign: its `uid`, or `"bootstrap"` for the installer's provider config. */
    dnsProvider?: string;
    dmarcPolicy?: "none" | "quarantine" | "reject";
    dmarcReportEmail?: string;
    /** Another seeded or existing domain this one aliases. */
    aliasOf?: string;
}

/** The entries `mail:domains` holds, and why each one it holds that isn't among them was left out. */
export interface SeedDomainEntries {
    entries: SeedDomainEntry[];
    problems: string[];
}

/** What one `DomainSeeder.run()` did. */
export interface DomainSeedResult {
    /** The domains it created. */
    created: string[];
    /** The domains that were already there (made in the console, or by another replica just now), recorded as seeded without any change. */
    recorded: string[];
    /** How many entries it skipped (each logged): malformed or repeated ones, ones the create path refused, and ones it couldn't create. */
    skipped: number;
    /** The names recorded as seeded without being created, present or not, because the deployment predates seeding (`DomainSeeder.adopt()`). */
    adopted: string[];
}

const SEED_ENTRY_OPTIONS: readonly (keyof SeedDomainEntry)[] = ["dnsProvider", "dmarcPolicy", "dmarcReportEmail", "aliasOf"];

const SEED_ENTRY_KEYS: ReadonlySet<string> = new Set(["name", ...SEED_ENTRY_OPTIONS]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One entry of the list, or why it isn't one. `label` names it in the problem: its name when it has one, else its position. */
function parseSeedDomainEntry(item: unknown, position: number): SeedDomainEntry | string {
    if (typeof item === "string") {
        return { name: normalizeAddress(item) };
    }
    const label = (): string => (isPlainObject(item) && typeof item.name === "string" && item.name.trim() ? `'${normalizeAddress(item.name)}'` : `${position}`);
    if (!isPlainObject(item)) {
        return `mail:domains entry ${label()} is neither a domain name nor an object with one; it is skipped.`;
    }
    // A misspelled option skips the entry rather than seeding the domain without it: a seeded domain is never changed again from the configuration.
    const unknown: string[] = Object.keys(item).filter((key) => !SEED_ENTRY_KEYS.has(key));
    if (unknown.length > 0) {
        return `mail:domains entry ${label()} has an unknown option ${unknown.map((key) => `'${key}'`).join(", ")} (the options are ${[...SEED_ENTRY_KEYS].join(", ")}); it is skipped.`;
    }
    if (typeof item.name !== "string" || !item.name.trim()) {
        return `mail:domains entry ${label()} has no domain name; it is skipped.`;
    }
    const entry: SeedDomainEntry = { name: normalizeAddress(item.name) };
    for (const option of SEED_ENTRY_OPTIONS) {
        const value: unknown = item[option];
        if (value === undefined || value === null) {
            continue;
        }
        if (typeof value !== "string") {
            return `mail:domains entry ${label()}: '${option}' must be text; it is skipped.`;
        }
        (entry as any)[option] = option === "aliasOf" ? normalizeAddress(value) : value.trim();
    }
    return entry;
}

/**
 * Reads `mail:domains` (spec 13.1): a list whose entries are domain names or `SeedDomainEntry` objects, the same list as JSON text (the chart renders it
 * into the service ConfigMap that way), one object on its own, or a comma-separated string of names (`mail__domains=a.com,b.com`). Each entry is checked
 * on its own, for its shape only: a malformed one, or one repeating a name already listed (the first wins), is left out with a problem saying why, and the
 * rest stand. What the console's create path refuses (a name that isn't a host name, an unknown DMARC policy, a dangling alias) is left to it, so a seeded
 * domain obeys exactly the console's rules. Names are trimmed and lowercased, as `Domain.uid` is.
 */
export function parseSeedDomainEntries(value: unknown): SeedDomainEntries {
    const result: SeedDomainEntries = { entries: [], problems: [] };
    let items: unknown[];
    if (value === undefined || value === null) {
        return result;
    } else if (typeof value === "string" && /^\s*[[{]/.test(value)) {
        try {
            return parseSeedDomainEntries(JSON.parse(value));
        } catch {
            result.problems.push("mail:domains is neither a list of domains nor valid JSON; no domain is seeded from it.");
            return result;
        }
    } else if (typeof value === "string") {
        items = value.split(",");
    } else if (Array.isArray(value)) {
        items = value;
    } else if (isPlainObject(value)) {
        items = [value];
    } else {
        result.problems.push("mail:domains must be a list of domains (names or objects), or a comma-separated string of names; no domain is seeded from it.");
        return result;
    }

    const names: Set<string> = new Set();
    items.forEach((item: unknown, index: number) => {
        // An empty name in a comma-separated string (`a.com,,b.com`, or a trailing comma) is nothing, not a mistake.
        if (typeof item === "string" && !item.trim()) {
            return;
        }
        const entry: SeedDomainEntry | string = parseSeedDomainEntry(item, index + 1);
        if (typeof entry === "string") {
            result.problems.push(entry);
        } else if (names.has(entry.name)) {
            result.problems.push(`mail:domains lists '${entry.name}' more than once; only its first entry is used.`);
        } else {
            names.add(entry.name);
            result.entries.push(entry);
        }
    });
    return result;
}

/**
 * Seeds the domains the deployment is installed for (`mail:domains`, spec 13) at startup, so they exist from the server's first start instead of being
 * added again by hand. Run once by the server after its datastores are up (`await seeder.run()`); it never throws, so it never stops the server.
 *
 * - **A domain is created only when it is absent and was never seeded before.** Every name seeded so far is in `SetupState.seededDomains`, append-only,
 * so a seeded domain the admin deleted (purged or not) stays deleted while the configuration still lists it.
 * - **An existing domain is never changed**: one made in the console is recorded as seeded as it is. A name that leaves the list is never deleted.
 * - Each domain is created through the console's own create path (`prepareNewDomain()`: the same validation, a new verification token, the DKIM key pair
 * from the `DkimKeyProvider`, the reserved-TLD carve-out), with `origin: "seed"`, audited as `DOMAIN_CREATE` with `details.origin: "seed"` and no user,
 * and announced to the `DnsPublisher`. Its `dnsProvider` is assigned directly, when that provider config exists and its zones cover the domain; otherwise
 * the domain is created manual, with a warning. An alias is created after the domains it may alias, wherever the list puts it.
 * - An invalid entry is logged as a warning and skipped, and isn't recorded, so the corrected entry is seeded on a later start.
 * - **A deployment that predates seeding is adopted, not seeded**: while nothing is recorded yet and a domain from before `Domain.origin` exists, the
 * listed names are recorded as seeded without creating any (`adopt()`), since which of them the admin deleted, or never wanted (the chart lists
 * `global.domain`), can't be known. Names added to the list afterwards are seeded as usual.
 * - **Multi-replica safety without a lock**: a create racing another replica's fails on the `uid` (the domain's name) and is taken as "already there";
 * `seededDomains` is appended to with the setup row's optimistic version, retried on a lost race (`updateSetupState()`); and `seededDomains` is read
 * again right before each create, so a domain another replica seeded and the admin deleted while this one was busy with earlier entries isn't created.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`DomainSeederMongo`/`DomainSeederSQL`).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class DomainSeeder<D extends Domain, S extends SetupState> {
    protected abstract domainClass: any;

    protected abstract setupStateClass: any;

    /** Supplied by the Mongo/SQL subclasses so each created domain is recorded as an `AuditLogEntry`. */
    protected abstract auditLogClass: any;

    /** Supplied by the Mongo/SQL subclasses so an entry's `dnsProvider` can be checked and assigned. */
    protected abstract dnsProviderClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected domainRepo?: RepoUtils<D>;
    protected setupStateRepo?: RepoUtils<S>;
    protected dnsProviderRepo?: RepoUtils<DnsProvider>;
    protected auditLogUtils?: AuditLogUtils;
    protected dnsPublisher?: DnsPublisher;

    /** The domains the deployment is installed for (`mail:domains`), as `parseSeedDomainEntries()` reads them. */
    @Config("mail:domains", [])
    protected domains: unknown = [];

    @Inject("DkimKeyProvider")
    protected dkimKeyProvider?: DkimKeyProvider;

    @Logger
    protected logger: any;

    @Init
    public async init(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.domainRepo && this.domainClass) {
            this.domainRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.domainClass.name, args: [this.domainClass] });
        }
        if (!this.setupStateRepo && this.setupStateClass) {
            this.setupStateRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.setupStateClass.name, args: [this.setupStateClass] });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            const auditLogRepo: RepoUtils<any> = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [auditLogRepo] });
        }
        if (!this.dnsProviderRepo && this.dnsProviderClass) {
            try {
                this.dnsProviderRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.dnsProviderClass.name, args: [this.dnsProviderClass] });
            } catch (err: any) {
                // As in `BaseDomainRoute`: a server that doesn't register the model yet still seeds its domains, only without a provider.
                this.logger?.warn(`DomainSeeder: DNS provider configs are unavailable, so seeded domains get none: ${err?.message}`);
            }
        }
        if (!this.dnsPublisher) {
            this.dnsPublisher = await resolveDnsPublisher(this._objectFactory, this.logger);
        }
    }

    /** Seeds every entry of `mail:domains` not seeded before. Never throws: what goes wrong is logged, and the next start tries again. */
    public async run(): Promise<DomainSeedResult> {
        const result: DomainSeedResult = { created: [], recorded: [], skipped: 0, adopted: [] };
        const { entries, problems } = parseSeedDomainEntries(this.domains);
        for (const problem of problems) {
            this.logger?.warn(`DomainSeeder: ${problem}`);
        }
        result.skipped += problems.length;
        if (entries.length === 0) {
            return result;
        }

        let seeded: Set<string>;
        try {
            const state: S | undefined = (await this.setupStateRepo!.findOne(SETUP_STATE_UID, { ignoreACL: true })) ?? undefined;
            seeded = new Set(state?.seededDomains ?? []);
        } catch (err: any) {
            // Without the list, a domain the admin deleted could come back: nothing is seeded until a start that can read it.
            this.logger?.error(`DomainSeeder: the domains seeded before can't be read, so none is seeded on this start: ${err?.message}`);
            return result;
        }
        if (seeded.size === 0) {
            let legacy: number;
            try {
                legacy = await this.countLegacyDomains();
            } catch (err: any) {
                // Whether this deployment predates seeding can't be told: seeding it anyway could bring back a domain deleted before the upgrade.
                this.logger?.error(`DomainSeeder: the existing domains can't be counted, so none is seeded on this start: ${err?.message}`);
                return result;
            }
            if (legacy > 0) {
                await this.adopt(entries, result);
                return result;
            }
        }

        // Aliases last, so one may alias a domain listed after it.
        const ordered: SeedDomainEntry[] = [...entries.filter((entry) => !entry.aliasOf), ...entries.filter((entry) => entry.aliasOf)];
        for (const entry of ordered) {
            if (seeded.has(entry.name)) {
                continue;
            }
            const outcome: "created" | "recorded" | "seeded" | undefined = await this.seed(entry);
            if (!outcome) {
                result.skipped++;
                continue;
            } else if (outcome === "seeded") {
                continue;
            }
            result[outcome].push(entry.name);
            await this.recordSeeded(entry.name);
        }
        return result;
    }

    /** Creates `entry`'s domain unless it is already there: `"created"`, `"recorded"` (it was there), `"seeded"` (another replica seeded the name since
     * `run()` read the list: nothing to do), or `undefined` when it was skipped (logged). */
    private async seed(entry: SeedDomainEntry): Promise<"created" | "recorded" | "seeded" | undefined> {
        const repo: RepoUtils<D> = this.domainRepo!;
        try {
            if (await repo.findOne(entry.name, { ignoreACL: true })) {
                return "recorded";
            }
            const domain: Partial<Domain> = { name: entry.name, enabled: true };
            for (const option of ["dmarcPolicy", "dmarcReportEmail", "aliasOf"] as const) {
                if (entry[option] !== undefined) {
                    (domain as any)[option] = entry[option];
                }
            }
            await prepareNewDomain(domain, repo, this.dkimKeyProvider);
            // The list `run()` read may be long out of date by now (each earlier entry's key took a while): another replica may have seeded this name
            // meanwhile, and the admin deleted it since.
            if (await this.wasSeeded(entry.name)) {
                return "seeded";
            }
            const dnsProviderUid: string | undefined = await this.providerFor(entry, domain.uid!);
            if (dnsProviderUid) {
                domain.dnsProviderUid = dnsProviderUid;
            }
            domain.origin = "seed";
            const created: D = await repo.create(asEntity(repo, domain) as D, { ignoreACL: true });
            await this.auditLogUtils?.record({
                action: AuditAction.DOMAIN_CREATE,
                targetType: "Domain",
                targetUid: created.uid,
                details: { name: created.name, origin: "seed", ...(dnsProviderUid ? { dnsProviderUid } : {}) },
            });
            await notifyDnsPublisher(this.dnsPublisher, { scope: "domain", domainUid: created.uid }, this.logger);
            return "created";
        } catch (err: any) {
            // Another replica created it meanwhile (the create path's 409, or the insert's duplicate key): it is there, which is all that was wanted.
            if (await repo.findOne(entry.name, { ignoreACL: true }).catch(() => undefined)) {
                return "recorded";
            }
            this.logger?.warn(`DomainSeeder: '${entry.name}' from mail:domains is not seeded: ${err?.message}`);
            return undefined;
        }
    }

    /** Whether `name` is in `SetupState.seededDomains` now. Throws when the row can't be read, which skips the entry: seeding it blind could bring back a
     * domain the admin deleted. */
    private async wasSeeded(name: string): Promise<boolean> {
        const state: S | undefined = (await this.setupStateRepo!.findOne(SETUP_STATE_UID, { ignoreACL: true })) ?? undefined;
        return (state?.seededDomains ?? []).includes(name);
    }

    /** How many domains are older than seeding: neither `origin: "seed"` nor `"console"`. Counted as a difference, as `BaseSetupRoute.toStatus()` does,
     * since an `origin` filter on SQL leaves out the rows without one. The total is read first, so a domain created between the reads (another replica
     * seeding a fresh install) only lowers the difference, never making a fresh install look like an old one. */
    private async countLegacyDomains(): Promise<number> {
        const repo: RepoUtils<D> = this.domainRepo!;
        const all: number = await repo.count({}, { ignoreACL: true });
        if (all === 0) {
            return 0;
        }
        const seeded: number = await repo.count({ origin: "seed" } as any, { ignoreACL: true });
        const fromConsole: number = await repo.count({ origin: "console" } as any, { ignoreACL: true });
        return all - seeded - fromConsole;
    }

    /**
     * Records every listed name as seeded without creating any, on a deployment that has domains from before seeding and has recorded none yet: an
     * upgrade, where a listed name may be a domain the admin deleted before seeding existed, or one never added on purpose (the chart's default list
     * includes `global.domain`, often only the hosts' base domain). Creating those would give them DKIM keys and, with a provider, publish their records.
     * A listed domain that is missing is left for the admin to add in the console. A failure is logged, and the next start adopts again.
     */
    private async adopt(entries: SeedDomainEntry[], result: DomainSeedResult): Promise<void> {
        const names: string[] = entries.map((entry) => entry.name);
        try {
            await updateSetupState(this.setupStateRepo!, async (current: S) => {
                const seeded: string[] = current.seededDomains ?? [];
                const added: string[] = names.filter((name) => !seeded.includes(name));
                return added.length > 0 ? { seededDomains: [...seeded, ...added] } : undefined;
            });
        } catch (err: any) {
            this.logger?.error(`DomainSeeder: this deployment predates domain seeding, but its listed domains can't be recorded; the next start tries again: ${err?.message}`);
            return;
        }
        result.adopted.push(...names);
        this.logger?.warn(
            `DomainSeeder: this deployment has domains from before domain seeding, so mail:domains (${names.join(", ")}) is recorded as seeded without ` +
                "creating any domain; add any it still needs in the admin console. Domains added to mail:domains from now on are seeded.",
        );
    }

    /** The provider config `entry` names, when it exists and its zones cover `name`; otherwise `undefined`, with a warning saying why. */
    private async providerFor(entry: SeedDomainEntry, name: string): Promise<string | undefined> {
        if (!entry.dnsProvider) {
            return undefined;
        }
        const manual: string = "it is created without a DNS provider (manual)";
        if (!this.dnsProviderRepo) {
            this.logger?.warn(`DomainSeeder: '${name}' names DNS provider '${entry.dnsProvider}', but DNS provider configs are unavailable; ${manual}.`);
            return undefined;
        }
        let provider: DnsProvider | undefined;
        if (entry.dnsProvider === BOOTSTRAP_DNS_PROVIDER) {
            const installers: DnsProvider[] = await this.dnsProviderRepo.find({ origin: "installer", limit: 2 } as any, { ignoreACL: true, limit: 2 });
            if (installers.length !== 1) {
                const found: string = installers.length === 0 ? "there is none" : "there is more than one";
                this.logger?.warn(`DomainSeeder: '${name}' names the installer's DNS provider ('${BOOTSTRAP_DNS_PROVIDER}'), but ${found}; ${manual}.`);
                return undefined;
            }
            provider = installers[0];
        } else {
            provider = (await this.dnsProviderRepo.findOne(entry.dnsProvider, { ignoreACL: true })) ?? undefined;
            if (!provider) {
                this.logger?.warn(`DomainSeeder: '${name}' names DNS provider '${entry.dnsProvider}', which doesn't exist; ${manual}.`);
                return undefined;
            }
        }
        if (!isNameInZones(name, provider.zones)) {
            this.logger?.warn(`DomainSeeder: '${name}' is not in the zones of DNS provider '${provider.uid}' (${provider.zones.join(", ")}); ${manual}.`);
            return undefined;
        }
        return provider.uid;
    }

    /** Appends `name` to `SetupState.seededDomains`, keeping what any other writer saved meanwhile. A failure is logged, never thrown: the domain is there,
     * and the next start records it as an existing one. */
    private async recordSeeded(name: string): Promise<void> {
        try {
            await updateSetupState(this.setupStateRepo!, async (current: S) => {
                const seeded: string[] = current.seededDomains ?? [];
                return seeded.includes(name) ? undefined : { seededDomains: [...seeded, name] };
            });
        } catch (err: any) {
            this.logger?.error(`DomainSeeder: '${name}' was seeded but couldn't be recorded as such; the next start records it: ${err?.message}`);
        }
    }
}
