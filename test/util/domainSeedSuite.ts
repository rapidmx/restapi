///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `DomainSeeder` (spec 13.3), identical on both backends: each `mail:domains` entry is created once through the console's create path and marked seeded,
// never again after the admin deleted it, never over an existing domain, never removed when it leaves the list; invalid entries and unknown providers are
// logged and skipped; two replicas seeding at once create each domain once; a deployment from before seeding has its list adopted, not created; nothing
// here ever fails the server's start.
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { NullDkimKeyProvider } from "../../src/dkim/NullDkimKeyProvider.js";
import { AuditAction } from "../../src/models/types.js";
import { FakeRotatingDkimKeyProvider } from "../jobs/dkimRotationSuite.js";
import { InMemoryDnsPublisher } from "../testDoubles.js";

export interface DomainSeedSuiteContext {
    config: any;
    /** Whether the backend takes writes from several replicas at once in this process. In-process SQLite can't hold two transactions at once, so there the
     * replicas' race is staged in turn instead. */
    parallelWrites: boolean;
    /** A new seeder, as the server builds one at startup (or another replica does). */
    newSeeder: () => Promise<any>;
    /** Saves a domain row with these fields (and defaults for the rest), as a domain made in the console before. */
    saveDomain: (fields: Record<string, unknown>) => Promise<void>;
    /** The stored domain row, or `undefined`. */
    domainRow: (uid: string) => Promise<any>;
    domainRows: () => Promise<any[]>;
    /** Removes the domain row for good, as `DELETE ?purge=true` does. */
    deleteDomain: (uid: string) => Promise<void>;
    /** Saves a DNS provider config with these fields (and defaults for the rest). */
    saveProvider: (fields: Record<string, unknown>) => Promise<void>;
    /** The stored setup state row, or `undefined`. */
    setupRow: () => Promise<any>;
    saveSetupState: (fields: Record<string, unknown>) => Promise<void>;
    auditEntries: () => Promise<any[]>;
}

export function domainSeedSuite(ctx: DomainSeedSuiteContext): void {
    describe("DomainSeeder", () => {
        let seeder: any;
        let keys: FakeRotatingDkimKeyProvider;
        let publisher: InMemoryDnsPublisher;

        /** A seeder for `domains`, sharing this test's key provider and publisher. */
        const replica = async (domains: unknown): Promise<any> => {
            const other: any = await ctx.newSeeder();
            other.domains = domains;
            other.dkimKeyProvider = keys;
            other.dnsPublisher = publisher;
            return other;
        };
        const creates = async () => (await ctx.auditEntries()).filter((entry) => entry.action === AuditAction.DOMAIN_CREATE);
        const seeded = async (): Promise<string[]> => [...((await ctx.setupRow())?.seededDomains ?? [])].sort();

        beforeEach(async () => {
            keys = new FakeRotatingDkimKeyProvider();
            publisher = new InMemoryDnsPublisher();
            seeder = await replica([]);
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("creates each listed domain once, as the console would, marked as seeded and announced", async () => {
            seeder.domains = ["example.com", { name: "Example.org", dmarcPolicy: "reject", dmarcReportEmail: "dmarc@example.org" }, "mail.local"];

            const result = await seeder.run();

            expect(result).toEqual({ created: ["example.com", "example.org", "mail.local"], recorded: [], skipped: 0, adopted: [] });
            const row = await ctx.domainRow("example.com");
            expect(row).toEqual(expect.objectContaining({ name: "example.com", enabled: true, verified: false, origin: "seed", dkimSelector: "mail", dkimManaged: true }));
            expect(row.dkimPublicKey).toBe(keys.key("example.com", "mail"));
            expect(row.verificationToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
            expect(row.dnsProviderUid ?? undefined).toBeUndefined();
            expect(await ctx.domainRow("example.org")).toEqual(expect.objectContaining({ dmarcPolicy: "reject", dmarcReportEmail: "dmarc@example.org", origin: "seed" }));
            // A reserved TLD starts verified, as it does from the console.
            expect(await ctx.domainRow("mail.local")).toEqual(expect.objectContaining({ verified: true, origin: "seed" }));

            expect(await seeded()).toEqual(["example.com", "example.org", "mail.local"]);
            // Seeding doesn't start the setup wizard: only an administrator does.
            const setup = await ctx.setupRow();
            expect(setup.startedAt ?? undefined).toBeUndefined();
            expect(setup.completedAt ?? undefined).toBeUndefined();

            const audits = await creates();
            expect(audits.map((entry) => [entry.targetUid, entry.details, entry.actorUserUid ?? undefined]).sort()).toEqual([
                ["example.com", { name: "example.com", origin: "seed" }, undefined],
                ["example.org", { name: "example.org", origin: "seed" }, undefined],
                ["mail.local", { name: "mail.local", origin: "seed" }, undefined],
            ]);
            expect(publisher.changes).toEqual(expect.arrayContaining(["example.com", "example.org", "mail.local"].map((domainUid) => ({ scope: "domain", domainUid }))));
        });

        it("never creates a domain again once seeded: not on the next start, and not after the admin deleted it", async () => {
            seeder.domains = ["example.com", "example.org"];
            await seeder.run();
            const setupVersion: number = (await ctx.setupRow()).version;

            // The next start finds nothing to do and writes nothing.
            expect(await (await replica(["example.com", "example.org"])).run()).toEqual({ created: [], recorded: [], skipped: 0, adopted: [] });
            expect((await ctx.setupRow()).version).toBe(setupVersion);

            // A domain the admin deleted (for good) stays deleted, though the configuration still lists it.
            await ctx.deleteDomain("example.com");
            expect(await (await replica(["example.com", "example.org"])).run()).toEqual({ created: [], recorded: [], skipped: 0, adopted: [] });
            expect(await ctx.domainRow("example.com")).toBeUndefined();
            expect((await creates()).map((entry) => entry.targetUid).sort()).toEqual(["example.com", "example.org"]);
        });

        it("records an existing domain as seeded without changing it, and leaves a domain that left the list alone", async () => {
            await ctx.saveDomain({ name: "example.com", dmarcPolicy: "quarantine", verificationToken: "made-by-hand", origin: "console" });
            seeder.domains = [{ name: "example.com", dmarcPolicy: "reject" }, "example.org"];

            expect(await seeder.run()).toEqual({ created: ["example.org"], recorded: ["example.com"], skipped: 0, adopted: [] });
            const row = await ctx.domainRow("example.com");
            expect(row).toEqual(expect.objectContaining({ dmarcPolicy: "quarantine", verificationToken: "made-by-hand" }));
            expect(row.origin).toBe("console");
            expect(await seeded()).toEqual(["example.com", "example.org"]);
            expect((await creates()).map((entry) => entry.targetUid)).toEqual(["example.org"]);

            // Deleted after it was recorded: never created again either.
            await ctx.deleteDomain("example.com");
            expect((await (await replica(["example.com"])).run()).created).toEqual([]);

            // Dropped from the list: not deleted.
            expect(await (await replica([])).run()).toEqual({ created: [], recorded: [], skipped: 0, adopted: [] });
            expect(await ctx.domainRow("example.org")).toBeDefined();
        });

        it("skips invalid entries with a warning and seeds the rest; a corrected entry is seeded on a later start", async () => {
            const warn = vi.spyOn(seeder.logger, "warn");
            seeder.domains = [
                "not_a_host!.com",
                { name: "policy.example.com", dmarcPolicy: "maybe" },
                { name: "dangling.example.com", aliasOf: "nope.example.com" },
                { name: "self.example.com", aliasOf: "self.example.com" },
                { name: "typo.example.com", dnsprovider: "bootstrap" },
                42,
                "ok.example.com",
            ];

            expect(await seeder.run()).toEqual({ created: ["ok.example.com"], recorded: [], skipped: 6, adopted: [] });
            expect(warn).toHaveBeenCalledTimes(6);
            for (const name of ["not_a_host!.com", "policy.example.com", "dangling.example.com", "self.example.com", "typo.example.com"]) {
                expect(warn.mock.calls.some(([message]) => String(message).includes(name))).toBe(true);
            }
            expect((await ctx.domainRows()).map((row) => row.uid)).toEqual(["ok.example.com"]);
            expect(await seeded()).toEqual(["ok.example.com"]);

            const fixed = await replica([{ name: "policy.example.com", dmarcPolicy: "none" }, "ok.example.com"]);
            expect(await fixed.run()).toEqual({ created: ["policy.example.com"], recorded: [], skipped: 0, adopted: [] });
        });

        it("assigns the provider named, or the installer's for 'bootstrap', only when its zones cover the domain", async () => {
            await ctx.saveProvider({ uid: "cf-main", name: "Cloudflare", zones: ["example.com"], origin: "console" });
            await ctx.saveProvider({ uid: "cf-boot", name: "Installer", zones: ["example.org"], origin: "installer" });
            const warn = vi.spyOn(seeder.logger, "warn");
            seeder.domains = [
                { name: "mail.example.com", dnsProvider: "cf-main" },
                { name: "example.org", dnsProvider: "bootstrap" },
                { name: "example.net", dnsProvider: "cf-main" },
                { name: "other.example.com", dnsProvider: "nope" },
            ];

            const result = await seeder.run();

            expect(result).toEqual({ created: ["mail.example.com", "example.org", "example.net", "other.example.com"], recorded: [], skipped: 0, adopted: [] });
            expect((await ctx.domainRow("mail.example.com")).dnsProviderUid).toBe("cf-main");
            expect((await ctx.domainRow("example.org")).dnsProviderUid).toBe("cf-boot");
            // Outside the provider's zones, or an unknown provider: created as manual, with a warning naming both.
            expect((await ctx.domainRow("example.net")).dnsProviderUid ?? undefined).toBeUndefined();
            expect((await ctx.domainRow("other.example.com")).dnsProviderUid ?? undefined).toBeUndefined();
            expect(warn).toHaveBeenCalledTimes(2);
            expect(warn.mock.calls.some(([message]) => String(message).includes("example.net") && String(message).includes("cf-main"))).toBe(true);
            expect(warn.mock.calls.some(([message]) => String(message).includes("other.example.com") && String(message).includes("nope"))).toBe(true);

            const audits = await creates();
            expect(audits.find((entry) => entry.targetUid === "mail.example.com").details).toEqual({ name: "mail.example.com", origin: "seed", dnsProviderUid: "cf-main" });
            expect(audits.find((entry) => entry.targetUid === "example.net").details).toEqual({ name: "example.net", origin: "seed" });
        });

        it("seeds a domain as manual when another config's zones cover it more specifically, as the console's assignment refuses it", async () => {
            await ctx.saveProvider({ uid: "cf-boot", name: "Installer", zones: ["example.com"], origin: "installer" });
            await ctx.saveProvider({ uid: "cf-eu", name: "Europe", zones: ["eu.example.com"], origin: "console", enabled: false });
            const warn = vi.spyOn(seeder.logger, "warn");
            seeder.domains = [
                { name: "eu.example.com", dnsProvider: "bootstrap" },
                { name: "www.example.com", dnsProvider: "bootstrap" },
                { name: "mail.eu.example.com", dnsProvider: "cf-eu" },
            ];

            expect((await seeder.run()).created).toEqual(["eu.example.com", "www.example.com", "mail.eu.example.com"]);

            expect((await ctx.domainRow("eu.example.com")).dnsProviderUid ?? undefined).toBeUndefined();
            expect((await ctx.domainRow("www.example.com")).dnsProviderUid).toBe("cf-boot");
            expect((await ctx.domainRow("mail.eu.example.com")).dnsProviderUid).toBe("cf-eu");
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("more specifically"));
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("cf-eu"));
        });

        it("seeds a 'bootstrap' domain as manual when there is no installer provider, or more than one", async () => {
            const warn = vi.spyOn(seeder.logger, "warn");
            seeder.domains = [{ name: "example.com", dnsProvider: "bootstrap" }];
            expect((await seeder.run()).created).toEqual(["example.com"]);
            expect((await ctx.domainRow("example.com")).dnsProviderUid ?? undefined).toBeUndefined();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("bootstrap"));

            await ctx.saveProvider({ uid: "boot-a", name: "A", zones: ["example.org"], origin: "installer" });
            await ctx.saveProvider({ uid: "boot-b", name: "B", zones: ["example.org"], origin: "installer" });
            const twice = await replica([{ name: "example.org", dnsProvider: "bootstrap" }]);
            expect((await twice.run()).created).toEqual(["example.org"]);
            expect((await ctx.domainRow("example.org")).dnsProviderUid ?? undefined).toBeUndefined();
        });

        it("seeds a domain as manual on a server without DNS provider configs", async () => {
            await ctx.saveProvider({ uid: "cf-main", name: "Cloudflare", zones: ["example.com"], origin: "installer" });
            const warn = vi.spyOn(seeder.logger, "warn");
            seeder.dnsProviderRepo = undefined;
            seeder.domains = [{ name: "example.com", dnsProvider: "cf-main" }];

            expect((await seeder.run()).created).toEqual(["example.com"]);
            expect((await ctx.domainRow("example.com")).dnsProviderUid ?? undefined).toBeUndefined();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
        });

        it("creates an alias after the domain it aliases, wherever the list puts it", async () => {
            await ctx.saveDomain({ name: "existing.example.com", origin: "console" });
            seeder.domains = [{ name: "alias.example.com", aliasOf: "example.com" }, { name: "alias2.example.com", aliasOf: "existing.example.com" }, "example.com"];

            expect(await seeder.run()).toEqual({ created: ["example.com", "alias.example.com", "alias2.example.com"], recorded: [], skipped: 0, adopted: [] });
            expect((await ctx.domainRow("alias.example.com")).aliasOf).toBe("example.com");
            expect((await ctx.domainRow("alias2.example.com")).aliasOf).toBe("existing.example.com");
        });

        it("creates a domain without a DKIM key when the key provider makes none", async () => {
            seeder.dkimKeyProvider = new NullDkimKeyProvider();
            seeder.domains = ["example.com"];
            await seeder.run();
            const row = await ctx.domainRow("example.com");
            expect(row.dkimSelector ?? undefined).toBeUndefined();
            expect(row.dkimManaged ?? undefined).toBeUndefined();
        });

        it("does nothing at all without entries: no setup row is written", async () => {
            for (const domains of [[], undefined, "", ["bad name"]]) {
                const quiet = await replica(domains);
                await quiet.run();
            }
            expect(await ctx.setupRow()).toBeUndefined();
            expect(await ctx.domainRows()).toEqual([]);
        });

        it("reads mail:domains from the configuration, a comma-separated string included", async () => {
            ctx.config.set("mail:domains", "Example.com, example.org");
            try {
                const configured: any = await ctx.newSeeder();
                configured.dkimKeyProvider = keys;
                configured.dnsPublisher = publisher;
                expect((await configured.run()).created).toEqual(["example.com", "example.org"]);
            } finally {
                ctx.config.clear("mail:domains");
            }
        });

        it("keeps the setup wizard's progress when it records the names, retrying a save that lost a race", async () => {
            const startedAt = new Date("2026-10-01T00:00:00Z");
            await ctx.saveSetupState({ startedAt, currentStep: "domain", seededDomains: ["earlier.example.com"] });
            const update = vi
                .spyOn(seeder.setupStateRepo, "update")
                .mockRejectedValueOnce(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale"))
                .mockRejectedValueOnce(new ApiError(ApiErrors.INTERNAL_ERROR, 500, "moved on"));
            seeder.domains = ["example.com"];

            await seeder.run();

            expect(update).toHaveBeenCalledTimes(3);
            const setup = await ctx.setupRow();
            expect(new Date(setup.startedAt).getTime()).toBe(startedAt.getTime());
            expect(setup.currentStep).toBe("domain");
            expect(await seeded()).toEqual(["earlier.example.com", "example.com"]);
        });

        it("seeds each domain once when replicas start together", async () => {
            await ctx.saveProvider({ uid: "cf-main", name: "Cloudflare", zones: ["example.com"], origin: "installer" });
            const domains = ["example.com", { name: "mail.example.com", dnsProvider: "bootstrap" }, { name: "alias.example.com", aliasOf: "example.com" }, "example.org"];
            const replicas = [await replica(domains), await replica(domains), await replica(domains)];

            let results: any[];
            if (ctx.parallelWrites) {
                results = await Promise.all(replicas.map((one) => one.run()));
            } else {
                // In turn, each later replica having read the seeded names before the first recorded any: every domain is already there for them.
                results = [];
                for (const [index, one] of replicas.entries()) {
                    if (index > 0) {
                        vi.spyOn(one.setupStateRepo, "findOne").mockResolvedValueOnce(undefined);
                    }
                    results.push(await one.run());
                }
            }

            const created: string[] = results.flatMap((result) => result.created).sort();
            expect(created).toEqual(["alias.example.com", "example.com", "example.org", "mail.example.com"]);
            for (const result of results) {
                expect(result.skipped).toBe(0);
                // A name another replica had recorded by the time this one was about to create it is neither created nor recorded again here.
                expect(created).toEqual(expect.arrayContaining([...result.created, ...result.recorded]));
            }
            expect((await ctx.domainRows()).map((row) => row.uid).sort()).toEqual(created);
            expect((await creates()).map((entry) => entry.targetUid).sort()).toEqual(created);
            expect((await ctx.setupRow()).seededDomains).toHaveLength(4);
            expect(await seeded()).toEqual(created);
            expect((await ctx.domainRow("mail.example.com")).dnsProviderUid).toBe("cf-main");
        });

        it("keeps the names another replica records between its read and its write", async () => {
            const first = await replica(["first.example.com"]);
            const second = await replica(["second.example.com"]);
            const original = first.setupStateRepo.update.bind(first.setupStateRepo);
            // The other replica records its name after this one read the setup row and before it writes: its write is stale and refused (409), and the
            // retry builds on the row with both names.
            const update = vi.spyOn(first.setupStateRepo, "update").mockImplementationOnce(async (...args: any[]) => {
                await second.run();
                return await original(...args);
            });

            await first.run();

            expect(update.mock.calls.length).toBeGreaterThanOrEqual(2);
            expect(await seeded()).toEqual(["first.example.com", "second.example.com"]);
        });

        it("reads the seeded names again before each create, so a domain another replica seeded and the admin deleted meanwhile isn't created", async () => {
            const setupStateRepo = seeder.setupStateRepo;
            const findOne = setupStateRepo.findOne.bind(setupStateRepo);
            vi.spyOn(setupStateRepo, "findOne").mockImplementationOnce(async (...args: any[]) => {
                const row = await findOne(...args);
                // Right after this replica read the list: another replica seeds late.example.com and records it, and the admin deletes it.
                await ctx.saveSetupState({ seededDomains: ["late.example.com"] });
                return row;
            });
            seeder.domains = ["early.example.com", "late.example.com"];

            expect(await seeder.run()).toEqual({ created: ["early.example.com"], recorded: [], skipped: 0, adopted: [] });
            expect(await ctx.domainRow("late.example.com")).toBeUndefined();
            expect((await creates()).map((entry) => entry.targetUid)).toEqual(["early.example.com"]);
            expect(await seeded()).toEqual(["early.example.com", "late.example.com"]);
        });

        it("adopts the list on a deployment from before seeding: records every name, creates none, and seeds names added later", async () => {
            // A domain without an origin was made before seeding existed: the admin may have deleted listed domains back then, or never added one.
            await ctx.saveDomain({ name: "example.com" });
            await ctx.saveProvider({ uid: "cf-boot", name: "Installer", zones: ["example.org"], origin: "installer" });
            await ctx.saveSetupState({ completedAt: new Date("2026-01-01T00:00:00Z"), startedAt: new Date("2026-01-01T00:00:00Z") });
            const warn = vi.spyOn(seeder.logger, "warn");
            seeder.domains = ["example.com", { name: "deleted.example.org", dnsProvider: "bootstrap" }, "base.example.net"];

            expect(await seeder.run()).toEqual({ created: [], recorded: [], skipped: 0, adopted: ["example.com", "deleted.example.org", "base.example.net"] });
            expect((await ctx.domainRows()).map((row) => row.uid)).toEqual(["example.com"]);
            expect(await creates()).toEqual([]);
            expect(publisher.changes).toEqual([]);
            expect(await seeded()).toEqual(["base.example.net", "deleted.example.org", "example.com"]);
            expect((await ctx.setupRow()).completedAt).toBeTruthy();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("before domain seeding"));

            // From then on it seeds as usual: the adopted names never, a name added to the list later yes.
            const later = await replica(["example.com", "deleted.example.org", "base.example.net", "new.example.org"]);
            expect(await later.run()).toEqual({ created: ["new.example.org"], recorded: [], skipped: 0, adopted: [] });
            expect(await ctx.domainRow("deleted.example.org")).toBeUndefined();
        });

        it("seeds as usual a deployment whose domains were all made since seeding exists", async () => {
            await ctx.saveDomain({ name: "console.example.com", origin: "console" });
            await ctx.saveDomain({ name: "seeded.example.com", origin: "seed" });
            seeder.domains = ["example.com"];
            expect(await seeder.run()).toEqual({ created: ["example.com"], recorded: [], skipped: 0, adopted: [] });
        });

        it("seeds nothing when it can't tell whether the deployment predates seeding, and adopts again when the adoption can't be recorded", async () => {
            await ctx.saveDomain({ name: "example.com" });
            const error = vi.spyOn(seeder.logger, "error");
            vi.spyOn(seeder.domainRepo, "count").mockRejectedValueOnce(new Error("count failed"));
            seeder.domains = ["example.com", "example.org"];
            expect(await seeder.run()).toEqual({ created: [], recorded: [], skipped: 0, adopted: [] });
            expect(error).toHaveBeenCalledWith(expect.stringContaining("count failed"));

            const unsaved = await replica(["example.com", "example.org"]);
            const unsavedError = vi.spyOn(unsaved.logger, "error");
            vi.spyOn(unsaved.setupStateRepo, "update").mockRejectedValue(new Error("disk full"));
            expect(await unsaved.run()).toEqual({ created: [], recorded: [], skipped: 0, adopted: [] });
            expect(unsavedError).toHaveBeenCalledWith(expect.stringContaining("disk full"));

            vi.restoreAllMocks();
            expect((await (await replica(["example.com", "example.org"])).run()).adopted).toEqual(["example.com", "example.org"]);
            expect(await ctx.domainRow("example.org")).toBeUndefined();
        });

        it("treats a create that loses to another replica as already there", async () => {
            const domainRepo = seeder.domainRepo;
            const create = domainRepo.create.bind(domainRepo);
            vi.spyOn(domainRepo, "create").mockImplementationOnce(async (obj: any, options: any) => {
                await ctx.saveDomain({ name: obj.name, verificationToken: "the-other-replica" });
                return await create(obj, options);
            });
            seeder.domains = ["example.com"];

            expect(await seeder.run()).toEqual({ created: [], recorded: ["example.com"], skipped: 0, adopted: [] });
            expect((await ctx.domainRow("example.com")).verificationToken).toBe("the-other-replica");
            expect(await creates()).toEqual([]);
            expect(await seeded()).toEqual(["example.com"]);
        });

        it("skips a domain it can't create, without recording it, so a later start tries again", async () => {
            const warn = vi.spyOn(seeder.logger, "warn");
            vi.spyOn(seeder.domainRepo, "create").mockRejectedValueOnce(new Error("disk full"));
            seeder.domains = ["example.com", "example.org"];

            expect(await seeder.run()).toEqual({ created: ["example.org"], recorded: [], skipped: 1, adopted: [] });
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
            expect(await seeded()).toEqual(["example.org"]);

            vi.restoreAllMocks();
            expect((await (await replica(["example.com", "example.org"])).run()).created).toEqual(["example.com"]);
        });

        it("skips a domain whose row can't even be looked up, without failing the others", async () => {
            const warn = vi.spyOn(seeder.logger, "warn");
            const findOne = seeder.domainRepo.findOne.bind(seeder.domainRepo);
            vi.spyOn(seeder.domainRepo, "findOne").mockImplementation(async (uid: string, options: any) => {
                if (uid === "example.com") {
                    throw new Error("connection reset");
                }
                return await findOne(uid, options);
            });
            seeder.domains = ["example.com", "example.org"];

            expect(await seeder.run()).toEqual({ created: ["example.org"], recorded: [], skipped: 1, adopted: [] });
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
            expect(await seeded()).toEqual(["example.org"]);
        });

        it("never fails the server's start: a setup state it can't read seeds nothing, and one it can't save is caught up on the next start", async () => {
            const error = vi.spyOn(seeder.logger, "error");
            vi.spyOn(seeder.setupStateRepo, "findOne").mockRejectedValueOnce(new Error("database down"));
            seeder.domains = ["example.com"];

            await expect(seeder.run()).resolves.toEqual({ created: [], recorded: [], skipped: 0, adopted: [] });
            expect(error).toHaveBeenCalledWith(expect.stringContaining("database down"));
            expect(await ctx.domainRows()).toEqual([]);

            // The domain is created but the name can't be recorded: the next start finds it and records it.
            const unsaved = await replica(["example.com"]);
            const unsavedError = vi.spyOn(unsaved.logger, "error");
            vi.spyOn(unsaved.setupStateRepo, "update").mockRejectedValue(new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale"));
            await expect(unsaved.run()).resolves.toEqual({ created: ["example.com"], recorded: [], skipped: 0, adopted: [] });
            expect(unsavedError).toHaveBeenCalled();
            expect(await seeded()).toEqual([]);

            vi.restoreAllMocks();
            expect(await (await replica(["example.com"])).run()).toEqual({ created: [], recorded: ["example.com"], skipped: 0, adopted: [] });
            expect(await seeded()).toEqual(["example.com"]);
        });
    });
}
