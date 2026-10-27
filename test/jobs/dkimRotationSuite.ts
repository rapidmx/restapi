///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `DkimRotationJob` through every phase, identical on both backends: a scheduled start, the wait for the new record to be live (a manual domain waits
// the same way), the publish grace, the switch, the MTA's acknowledgement (and its absence), the overlap and the retirement, a compromised key, a key
// that can't be generated, keys imported by hand, and two replicas racing. The key provider is an in-memory fake whose MTA acknowledgement the test
// sets; the domain rows, audit entries and DNS lookups are the real database and the static resolver.
import type { DkimKeyPair, DkimKeyProvider } from "../../src/dkim/DkimKeyProvider.js";
import { NullDkimKeyProvider } from "../../src/dkim/NullDkimKeyProvider.js";
import { AuditAction, Domain } from "../../src/models/types.js";
import { rotationDate } from "../../src/util/DkimRotationUtils.js";
import { InMemoryDnsPublisher, StaticDnsResolver } from "../testDoubles.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A rotating `DkimKeyProvider` in memory: keys per domain and selector, the selector each domain is signed with, and what the MTA acknowledges. */
export class FakeRotatingDkimKeyProvider implements DkimKeyProvider {
    public readonly supportsRotation: boolean = true;
    public keys: Map<string, string> = new Map();
    public active: Map<string, string> = new Map();
    public signing: Map<string, string> = new Map();
    public failGenerate: boolean = false;
    public failActivate: boolean = false;
    public failDelete: boolean = false;
    private counter: number = 0;

    public key(domain: string, selector: string): string | undefined {
        return this.keys.get(`${domain}/${selector}`);
    }

    public async ensureKeyPair(domain: string): Promise<DkimKeyPair> {
        return await this.generateKeyPair(domain, this.active.get(domain) ?? "mail");
    }

    public async generateKeyPair(domain: string, selector: string): Promise<DkimKeyPair> {
        if (this.failGenerate) {
            throw new Error("disk full");
        }
        const id: string = `${domain}/${selector}`;
        if (!this.keys.has(id)) {
            this.keys.set(id, `KEY${++this.counter}${selector}`);
        }
        return { selector, publicKey: this.keys.get(id)! };
    }

    public async findKeyPair(domain: string, selector: string): Promise<DkimKeyPair | undefined> {
        const publicKey: string | undefined = this.key(domain, selector);
        return publicKey ? { selector, publicKey } : undefined;
    }

    public async activate(domain: string, selector: string): Promise<void> {
        if (this.failActivate) {
            throw new Error("read-only file system");
        }
        this.active.set(domain, selector);
    }

    public async signingSelector(domain: string): Promise<string | undefined> {
        return this.signing.get(domain);
    }

    public async deleteKeyPair(domain: string, selector: string): Promise<void> {
        if (this.failDelete) {
            throw new Error("EBUSY");
        }
        this.keys.delete(`${domain}/${selector}`);
    }
}

export interface DkimRotationSuiteContext {
    job: () => any;
    /** A second instance of the job, as another replica runs it. */
    newJob: () => Promise<any>;
    createDomain: (data?: Partial<Domain> & Record<string, any>) => Promise<Domain>;
    findDomain: (uid: string) => Promise<Domain>;
    auditEntries: (action: AuditAction) => Promise<any[]>;
    dnsResolver: () => StaticDnsResolver;
}

export function dkimRotationSuite(ctx: DkimRotationSuiteContext): void {
    describe("DKIM rotation", () => {
        let provider: FakeRotatingDkimKeyProvider;
        let publisher: InMemoryDnsPublisher;
        let job: any;

        const today = (): string => new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const ago = (ms: number): Date => new Date(Date.now() - ms);
        const date = (value: unknown): number => rotationDate(value)!.getTime();

        /** A domain signed with `mail` and the provider's key for it, due for a scheduled rotation unless told otherwise. */
        const managedDomain = async (name: string, rotation?: Record<string, any>, data?: Record<string, any>): Promise<Domain> => {
            const { publicKey } = await provider.generateKeyPair(name, "mail");
            return await ctx.createDomain({
                name,
                uid: name,
                verified: true,
                dkimSelector: "mail",
                dkimPublicKey: publicKey,
                dkimManaged: true,
                dkimRotation: { phase: "idle", lastRotatedAt: ago(200 * DAY), ...rotation },
                ...data,
            });
        };

        const publishNext = (domain: Domain): void => {
            const next = domain.dkimRotation!.next!;
            ctx.dnsResolver().records.set(`${next.selector}._domainkey.${domain.name}`, [[`v=DKIM1; k=rsa; p=${next.publicKey}`]]);
        };

        beforeEach(() => {
            job = ctx.job();
            provider = new FakeRotatingDkimKeyProvider();
            publisher = new InMemoryDnsPublisher();
            job.dkimKeyProvider = provider;
            job.dnsPublisher = publisher;
            job.rotationEnabled = true;
            job.intervalDays = 180;
            job.overlapDays = 7;
            job.publishGraceHours = 48;
            job.maxStartsPerRun = 10;
            job.transportProvider = "postfix";
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("Exposes the configured cron schedule, and start() and stop() do nothing.", async () => {
            expect(job.schedule).toBe("0 0 * * * *");
            await expect(job.start()).resolves.toBeUndefined();
            expect(job.stop()).toBeUndefined();
        });

        it("Starts a scheduled rotation: the new selector and its key are recorded, signing is unchanged.", async () => {
            const domain: Domain = await managedDomain("due.example.com");

            await job.run();

            const after: Domain = await ctx.findDomain(domain.uid);
            const next = after.dkimRotation!.next!;
            expect(after.dkimRotation!.phase).toBe("pending");
            expect(next.selector).toBe(`rmx${today()}`);
            expect(next.publicKey).toBe(provider.key("due.example.com", next.selector));
            expect(next.reason).toBe("scheduled");
            expect(next.liveSince).toBeUndefined();
            expect(date(next.createdAt)).toBeGreaterThan(Date.now() - 60_000);
            expect(after.dkimSelector).toBe("mail");
            expect(after.dkimPublicKey).toBe(domain.dkimPublicKey);
            expect(date(after.dkimRotation!.lastRotatedAt)).toBe(date(domain.dkimRotation!.lastRotatedAt));
            expect(provider.active.has("due.example.com")).toBe(false);
            const started: any[] = await ctx.auditEntries(AuditAction.DKIM_ROTATION_STARTED);
            expect(started).toHaveLength(1);
            expect(started[0].targetUid).toBe(domain.uid);
            expect(started[0].details).toEqual({ name: "due.example.com", selector: next.selector, reason: "scheduled" });
            expect(publisher.changes).toContainEqual({ scope: "domain", domainUid: domain.uid });
        });

        it("Counts the interval from the domain's creation when it never rotated, and doesn't start before it is due.", async () => {
            const fresh: Domain = await managedDomain("fresh.example.com", undefined, { dkimRotation: undefined });
            const recent: Domain = await managedDomain("recent.example.com", { lastRotatedAt: ago(10 * DAY) });
            const cancelled: Domain = await managedDomain("cancelled.example.com", { lastCancelledAt: ago(DAY) });

            await job.run();

            for (const domain of [fresh, recent, cancelled]) {
                expect((await ctx.findDomain(domain.uid)).dkimRotation?.phase ?? "idle").toBe("idle");
            }
            job.intervalDays = 0;
            await job.run();
            expect((await ctx.findDomain(fresh.uid)).dkimRotation!.phase).toBe("pending");
        });

        it("Starts no scheduled rotation while paused, disabled in config, for a disabled or unverified domain or one without a key.", async () => {
            const paused: Domain = await managedDomain("paused.example.com", { paused: true });
            const disabled: Domain = await managedDomain("disabled.example.com", undefined, { enabled: false });
            // Nobody may ever publish an unverified domain's new record: the rotation would wait in pending for good.
            const unverified: Domain = await managedDomain("unverified.example.com", undefined, { verified: false });
            const keyless: Domain = await ctx.createDomain({
                name: "keyless.example.com",
                uid: "keyless.example.com",
                dkimRotation: { phase: "idle", lastRotatedAt: ago(200 * DAY) },
            });

            await job.run();

            for (const domain of [paused, disabled, unverified, keyless]) {
                expect((await ctx.findDomain(domain.uid)).dkimRotation!.phase).toBe("idle");
            }
            expect((await ctx.findDomain(paused.uid)).dkimRotation!.paused).toBe(true);

            const due: Domain = await managedDomain("off.example.com");
            job.rotationEnabled = false;
            await job.run();
            expect((await ctx.findDomain(due.uid)).dkimRotation!.phase).toBe("idle");
        });

        it("Never rotates a key imported by hand, and records it as imported when the provider doesn't hold it.", async () => {
            const imported: Domain = await managedDomain("imported.example.com", undefined, { dkimManaged: false });
            const unknown: Domain = await managedDomain("unknown.example.com", undefined, { dkimManaged: undefined, dkimPublicKey: "HANDMADE" });

            await job.run();

            expect((await ctx.findDomain(imported.uid)).dkimRotation!.phase).toBe("idle");
            const after: Domain = await ctx.findDomain(unknown.uid);
            expect(after.dkimRotation!.phase).toBe("idle");
            expect(after.dkimManaged).toBe(false);
            expect(await ctx.auditEntries(AuditAction.DKIM_ROTATION_STARTED)).toHaveLength(0);
        });

        it("Records a key the provider holds as managed on a row from before rotation, and rotates it.", async () => {
            const legacy: Domain = await managedDomain("legacy.example.com", undefined, { dkimManaged: undefined });

            await job.run();

            const after: Domain = await ctx.findDomain(legacy.uid);
            expect(after.dkimManaged).toBe(true);
            expect(after.dkimRotation!.phase).toBe("pending");
        });

        it("Leaves a row from before rotation alone while the provider can't say whether it holds the key.", async () => {
            const legacy: Domain = await managedDomain("cantsay.example.com", undefined, { dkimManaged: undefined });
            (provider as any).findKeyPair = undefined;

            await job.run();

            const after: Domain = await ctx.findDomain(legacy.uid);
            expect(after.dkimManaged ?? undefined).toBeUndefined();
            expect(after.dkimRotation!.phase).toBe("idle");
        });

        it("Does nothing with a provider that doesn't rotate, on SES, or before its repositories exist.", async () => {
            const domain: Domain = await managedDomain("norotate.example.com");

            job.dkimKeyProvider = new NullDkimKeyProvider();
            await job.run();
            job.dkimKeyProvider = undefined;
            await job.run();
            job.dkimKeyProvider = provider;
            job.transportProvider = "ses";
            await job.run();
            job.transportProvider = "postfix";
            const repo = job.domainRepo;
            job.domainRepo = undefined;
            try {
                await job.run();
            } finally {
                job.domainRepo = repo;
            }

            expect((await ctx.findDomain(domain.uid)).dkimRotation!.phase).toBe("idle");
        });

        it("Waits in pending, signing unchanged, until the new record is live: a manual domain waits however long the admin takes.", async () => {
            const domain: Domain = await managedDomain("manual.example.com", undefined, { dnsProviderUid: null });
            await job.run();
            const pending: Domain = await ctx.findDomain(domain.uid);
            // Long past the grace, but never published.
            await job.domainRepo.update(
                { uid: pending.uid, version: pending.version, dkimRotation: { ...pending.dkimRotation, next: { ...pending.dkimRotation!.next, createdAt: ago(60 * DAY) } } },
                await job.domainRepo.findOne(pending.uid, { ignoreACL: true }),
                { version: pending.version, ignoreACL: true },
            );

            await job.run();

            const after: Domain = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("pending");
            expect(after.dkimRotation!.next!.liveSince).toBeUndefined();
            expect(after.dkimSelector).toBe("mail");
            expect(provider.active.has(domain.name)).toBe(false);
        });

        it("Records when the new record went live, and switches only once the publish grace has passed.", async () => {
            const domain: Domain = await managedDomain("grace.example.com");
            await job.run();
            publishNext(await ctx.findDomain(domain.uid));

            await job.run();

            let after: Domain = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("pending");
            const liveSince: number = date(after.dkimRotation!.next!.liveSince);
            expect(liveSince).toBeGreaterThan(Date.now() - 60_000);

            await job.run();
            after = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("pending");
            expect(date(after.dkimRotation!.next!.liveSince)).toBe(liveSince);
            expect(provider.active.has(domain.name)).toBe(false);

            job.publishGraceHours = 0;
            const next = after.dkimRotation!.next!;
            await job.run();

            after = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("switching");
            expect(after.dkimSelector).toBe(next.selector);
            expect(after.dkimPublicKey).toBe(next.publicKey);
            expect(after.dkimRotation!.next).toBeUndefined();
            expect(after.dkimRotation!.previous).toEqual({ selector: "mail", publicKey: domain.dkimPublicKey });
            expect(after.dkimRotation!.reason).toBe("scheduled");
            expect(date(after.dkimRotation!.switchedAt)).toBeGreaterThan(Date.now() - 60_000);
            expect(provider.active.get(domain.name)).toBe(next.selector);
            const switched: any[] = await ctx.auditEntries(AuditAction.DKIM_ROTATION_SWITCHED);
            expect(switched).toHaveLength(1);
            expect(switched[0].details).toEqual({ name: domain.name, selector: next.selector, previousSelector: "mail" });
        });

        it("Starts the wait over when the new record disappears before the switch.", async () => {
            const domain: Domain = await managedDomain("flaky.example.com");
            await job.run();
            const pending: Domain = await ctx.findDomain(domain.uid);
            publishNext(pending);
            await job.run();
            expect((await ctx.findDomain(domain.uid)).dkimRotation!.next!.liveSince).toBeDefined();

            ctx.dnsResolver().records.clear();
            await job.run();

            const after: Domain = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("pending");
            expect(after.dkimRotation!.next!.liveSince).toBeUndefined();
            expect(after.dkimRotation!.next!.selector).toBe(pending.dkimRotation!.next!.selector);
        });

        it("Moves to the overlap once the MTA acknowledges the new selector, keeping the old record until retireAt.", async () => {
            job.publishGraceHours = 0;
            const domain: Domain = await managedDomain("ack.example.com");
            await job.run();
            publishNext(await ctx.findDomain(domain.uid));
            await job.run();
            const switching: Domain = await ctx.findDomain(domain.uid);
            expect(switching.dkimRotation!.phase).toBe("switching");

            provider.signing.set(domain.name, switching.dkimSelector!);
            await job.run();

            const after: Domain = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("overlap");
            expect(after.dkimRotation!.previous!.selector).toBe("mail");
            const retireAt: number = date(after.dkimRotation!.previous!.retireAt);
            expect(Math.abs(retireAt - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
            expect(provider.key(domain.name, "mail")).toBeDefined();

            // Nothing more before retireAt.
            await job.run();
            expect((await ctx.findDomain(domain.uid)).dkimRotation!.phase).toBe("overlap");
        });

        it("Retires the old selector at retireAt: its record leaves, its key is deleted, the rotation is recorded.", async () => {
            const domain: Domain = await managedDomain("retire.example.com", {
                phase: "overlap",
                previous: { selector: "mail", publicKey: "OLD", retireAt: ago(HOUR) },
                reason: "scheduled",
                switchedAt: ago(8 * DAY),
                paused: true,
            }, { dkimSelector: "rmx20260101" });
            await provider.generateKeyPair(domain.name, "rmx20260101");

            await job.run();

            const after: Domain = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("idle");
            expect(after.dkimRotation!.previous).toBeUndefined();
            expect(after.dkimRotation!.reason).toBeUndefined();
            expect(after.dkimRotation!.switchedAt).toBeUndefined();
            expect(after.dkimRotation!.paused).toBe(true);
            expect(date(after.dkimRotation!.lastRotatedAt)).toBeGreaterThan(Date.now() - 60_000);
            expect(provider.key(domain.name, "mail")).toBeUndefined();
            expect(provider.key(domain.name, "rmx20260101")).toBeDefined();
            const retired: any[] = await ctx.auditEntries(AuditAction.DKIM_ROTATION_RETIRED);
            expect(retired).toHaveLength(1);
            expect(retired[0].details).toEqual({ name: domain.name, selector: "mail" });
            expect(publisher.changes).toContainEqual({ scope: "domain", domainUid: domain.uid });
        });

        it("Still retires when the old key can't be deleted, logging it.", async () => {
            const domain: Domain = await managedDomain("stuck.example.com", {
                phase: "overlap",
                previous: { selector: "mail", publicKey: "OLD", retireAt: ago(HOUR) },
            }, { dkimSelector: "rmx20260101" });
            provider.failDelete = true;
            const warn = vi.spyOn(job.logger, "warn");

            await job.run();

            expect((await ctx.findDomain(domain.uid)).dkimRotation!.phase).toBe("idle");
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("EBUSY"));
        });

        it("Goes back to idle from an overlap without an old selector, deleting nothing.", async () => {
            const domain: Domain = await managedDomain("noprevious.example.com", { phase: "overlap" });
            const deleteKeyPair = vi.spyOn(provider, "deleteKeyPair");

            await job.run();

            expect((await ctx.findDomain(domain.uid)).dkimRotation!.phase).toBe("idle");
            expect(deleteKeyPair).not.toHaveBeenCalled();
        });

        it("Without an acknowledgement, keeps both selectors and says so after an hour, without starting the overlap clock.", async () => {
            const domain: Domain = await managedDomain("noack.example.com", {
                phase: "switching",
                previous: { selector: "mail", publicKey: "OLD" },
                reason: "scheduled",
                switchedAt: ago(10 * 60_000),
            }, { dkimSelector: "rmx20260101" });
            await provider.generateKeyPair(domain.name, "rmx20260101");

            await job.run();
            let after: Domain = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("switching");
            expect(after.dkimRotation!.lastError).toBeUndefined();
            // Signing is (re)activated on every pass until the MTA confirms it.
            expect(provider.active.get(domain.name)).toBe("rmx20260101");

            await job.domainRepo.update(
                { uid: after.uid, version: after.version, dkimRotation: { ...after.dkimRotation, switchedAt: ago(2 * HOUR) } },
                await job.domainRepo.findOne(after.uid, { ignoreACL: true }),
                { version: after.version, ignoreACL: true },
            );
            await job.run();
            after = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("switching");
            expect(after.dkimRotation!.lastError).toMatch(/hasn't confirmed/);
            expect(after.dkimRotation!.previous!.retireAt).toBeUndefined();
            const version: number = after.version;
            await job.run();
            // The same news isn't written again.
            expect((await ctx.findDomain(domain.uid)).version).toBe(version);

            provider.signing.set(domain.name, "rmx20260101");
            await job.run();
            after = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("overlap");
            expect(after.dkimRotation!.lastError).toBeUndefined();
        });

        it("Records a failed activation while switching, and retries it on the next pass.", async () => {
            const domain: Domain = await managedDomain("activate.example.com", {
                phase: "switching",
                previous: { selector: "mail", publicKey: "OLD" },
                switchedAt: ago(60_000),
            }, { dkimSelector: "rmx20260101" });
            provider.failActivate = true;

            await job.run();
            expect((await ctx.findDomain(domain.uid)).dkimRotation!.lastError).toMatch(/read-only file system/);

            provider.failActivate = false;
            await job.run();
            const after: Domain = await ctx.findDomain(domain.uid);
            expect(provider.active.get(domain.name)).toBe("rmx20260101");
            expect(after.dkimRotation!.lastError).toBeUndefined();
        });

        it("A compromised key switches as soon as the new record is live and retires the old one as soon as signing is confirmed.", async () => {
            const domain: Domain = await managedDomain("compromised.example.com", {
                phase: "pending",
                next: { selector: "rmx20260101", publicKey: "", createdAt: new Date(), reason: "compromised" },
            });
            await job.run();
            const pending: Domain = await ctx.findDomain(domain.uid);
            expect(pending.dkimRotation!.next!.publicKey).toBe(provider.key(domain.name, "rmx20260101"));
            publishNext(pending);

            await job.run();
            let after: Domain = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("switching");
            expect(after.dkimRotation!.reason).toBe("compromised");

            provider.signing.set(domain.name, "rmx20260101");
            await job.run();
            after = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("idle");
            expect(after.dkimRotation!.previous).toBeUndefined();
            expect(provider.key(domain.name, "mail")).toBeUndefined();
            expect(await ctx.auditEntries(AuditAction.DKIM_ROTATION_RETIRED)).toHaveLength(1);
        });

        it("Generates the key of a selector recorded before a crash, and records a key that can't be generated.", async () => {
            const domain: Domain = await managedDomain("crash.example.com", {
                phase: "pending",
                next: { selector: "rmx20260101", publicKey: "", createdAt: new Date(), reason: "manual" },
            });
            provider.failGenerate = true;

            await job.run();
            let after: Domain = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.phase).toBe("pending");
            expect(after.dkimRotation!.next!.publicKey).toBe("");
            expect(after.dkimRotation!.lastError).toMatch(/could not be generated: disk full/);

            provider.failGenerate = false;
            await job.run();
            after = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.next!.publicKey).toBe(provider.key(domain.name, "rmx20260101"));
            expect(after.dkimRotation!.lastError).toBeUndefined();
            expect(publisher.changes).toContainEqual({ scope: "domain", domainUid: domain.uid });
        });

        it("Puts a pending state without a new selector back to idle, and treats an unknown phase as idle.", async () => {
            const broken: Domain = await managedDomain("broken.example.com", { phase: "pending", lastRotatedAt: ago(DAY) });
            const odd: Domain = await managedDomain("odd.example.com", { phase: "sideways", lastRotatedAt: ago(DAY) });

            await job.run();

            expect((await ctx.findDomain(broken.uid)).dkimRotation!.phase).toBe("idle");
            expect((await ctx.findDomain(odd.uid)).dkimRotation!.phase).toBe("sideways");
        });

        it("Two replicas racing start one rotation: the loser's stale write is refused and skipped quietly.", async () => {
            const domain: Domain = await managedDomain("race.example.com");
            const other: any = await ctx.newJob();
            other.dkimKeyProvider = provider;
            other.dnsPublisher = publisher;
            other.rotationEnabled = true;
            other.intervalDays = 180;
            other.transportProvider = "postfix";

            // Both replicas read the row before either writes (run sequentially: in-process SQLite can't hold two transactions at once). The second's
            // start is a version conflict, logged at debug only, and the rotation the first started is untouched.
            await job.run();
            expect(await ctx.auditEntries(AuditAction.DKIM_ROTATION_STARTED)).toHaveLength(1);
            const warn = vi.spyOn(other.logger, "warn");
            const debug = vi.spyOn(other.logger, "debug");
            const generate = vi.spyOn(provider, "generateKeyPair");
            await other.advanceDomain({ ...domain }, new Date());
            expect(await ctx.auditEntries(AuditAction.DKIM_ROTATION_STARTED)).toHaveLength(1);
            expect(generate).not.toHaveBeenCalled();
            expect(warn).not.toHaveBeenCalled();
            expect(debug).toHaveBeenCalledWith(expect.stringContaining("race.example.com"));
            const after: Domain = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.next!.selector).toBe(`rmx${today()}`);
        });

        it("Starts at most max_starts_per_run scheduled rotations per run, leaving the others for the next runs.", async () => {
            job.maxStartsPerRun = 2;
            const domains: Domain[] = [];
            for (const name of ["cap-a.example.com", "cap-b.example.com", "cap-c.example.com"]) {
                domains.push(await managedDomain(name));
            }
            const pending = async (): Promise<number> =>
                (await Promise.all(domains.map(async (domain) => (await ctx.findDomain(domain.uid)).dkimRotation!.phase))).filter((phase) => phase === "pending").length;

            await job.run();
            expect(await pending()).toBe(2);

            await job.run();
            expect(await pending()).toBe(3);
        });

        it("Never mints again a selector used earlier the same day, cancelled or retired, since receivers may still cache its record.", async () => {
            job.intervalDays = 0;
            const domain: Domain = await managedDomain("again.example.com", { mintedSelectors: [`rmx${today()}`, "rmx20200101"], lastCancelledAt: ago(1000) });

            await job.run();

            const after: Domain = await ctx.findDomain(domain.uid);
            expect(after.dkimRotation!.next!.selector).toBe(`rmx${today()}b`);
            // Only the day's selectors are kept.
            expect(after.dkimRotation!.mintedSelectors).toEqual([`rmx${today()}`, `rmx${today()}b`]);
        });

        it("Deletes a key it generated for a rotation cancelled meanwhile, and keeps one that the winning write recorded.", async () => {
            const pendingState = { phase: "pending", next: { selector: "rmx20260101", publicKey: "", createdAt: new Date(), reason: "manual" } };
            const domain: Domain = await managedDomain("orphan.example.com", pendingState);
            const stale: Domain = await ctx.findDomain(domain.uid);
            // An administrator's cancel lands while this replica generates the key.
            await job.domainRepo.update(
                { uid: stale.uid, version: stale.version, dkimRotation: { phase: "idle", lastCancelledAt: new Date() } },
                await job.domainRepo.findOne(stale.uid, { ignoreACL: true }),
                { version: stale.version, ignoreACL: true },
            );
            const debug = vi.spyOn(job.logger, "debug");

            await job.advanceDomain(stale, new Date());

            expect(provider.key(domain.name, "rmx20260101")).toBeUndefined();
            expect(debug).toHaveBeenCalledWith(expect.stringContaining(domain.name));

            // A key that can't be deleted is logged and left.
            provider.failDelete = true;
            const warn = vi.spyOn(job.logger, "warn");
            await job.advanceDomain(stale, new Date());
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("EBUSY"));
            expect(provider.key(domain.name, "rmx20260101")).toBeDefined();
            provider.failDelete = false;

            // Two replicas generating the same pending key: the loser leaves the key the winner recorded.
            const raced: Domain = await managedDomain("orphan-race.example.com", pendingState);
            const staleRace: Domain = await ctx.findDomain(raced.uid);
            await job.advanceDomain(staleRace, new Date());
            await job.advanceDomain(staleRace, new Date());
            const recorded: string = (await ctx.findDomain(raced.uid)).dkimRotation!.next!.publicKey;
            expect(recorded).not.toBe("");
            expect(provider.key(raced.name, "rmx20260101")).toBe(recorded);
        });

        it("Signs with the row's selector again when a cancel reverted the switch while the job was activating it.", async () => {
            const domain: Domain = await managedDomain("revert.example.com", undefined, { dkimSelector: "rmx20260101" });
            const { publicKey: oldKey } = await provider.generateKeyPair(domain.name, "mail");
            const row: Domain = await ctx.findDomain(domain.uid);
            await job.domainRepo.update(
                { uid: row.uid, version: row.version, dkimRotation: { phase: "switching", previous: { selector: "mail", publicKey: oldKey }, switchedAt: ago(60_000) } },
                await job.domainRepo.findOne(row.uid, { ignoreACL: true }),
                { version: row.version, ignoreACL: true },
            );
            await provider.generateKeyPair(domain.name, "rmx20260101");
            const activate = provider.activate.bind(provider);
            vi.spyOn(provider, "activate").mockImplementationOnce(async (name: string, selector: string) => {
                // The cancel reverts the row and signs with the old key again, and only then does the job's own activation land.
                const current: any = await job.domainRepo.findOne(domain.uid, { ignoreACL: true });
                await job.domainRepo.update(
                    { uid: current.uid, version: current.version, dkimSelector: "mail", dkimPublicKey: oldKey, dkimRotation: { phase: "idle", lastCancelledAt: new Date() } },
                    current,
                    { version: current.version, ignoreACL: true },
                );
                await activate(name, "mail");
                await activate(name, selector);
            });

            await job.run();

            expect(provider.active.get(domain.name)).toBe("mail");
            expect((await ctx.findDomain(domain.uid)).dkimRotation!.phase).toBe("idle");
        });

        it("A failure on one domain is logged and doesn't stop the others.", async () => {
            const failing: Domain = await managedDomain("a-fails.example.com", {
                phase: "switching",
                previous: { selector: "mail", publicKey: "OLD" },
                switchedAt: ago(60_000),
            }, { dkimSelector: "rmx20260101" });
            const due: Domain = await managedDomain("b-due.example.com");
            vi.spyOn(provider, "signingSelector").mockRejectedValueOnce(new Error("EIO"));
            const warn = vi.spyOn(job.logger, "warn");

            await job.run();

            expect(warn).toHaveBeenCalledWith(expect.stringContaining(failing.name));
            expect((await ctx.findDomain(due.uid)).dkimRotation!.phase).toBe("pending");
        });
    });
}
