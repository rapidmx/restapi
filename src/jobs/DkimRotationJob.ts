///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { BackgroundService, ObjectFactory, RepoUtils } from "@rapidrest/service-core";
import type { DkimKeyProvider } from "../dkim/DkimKeyProvider.js";
import { notifyDnsPublisher, resolveDnsPublisher, type DnsPublisher } from "../dns/DnsPublisher.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { AuditAction, DkimRotationState, Domain } from "../models/types.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import {
    configNumber,
    DEFAULT_DKIM_ROTATION_INTERVAL_DAYS,
    DEFAULT_DKIM_ROTATION_MAX_STARTS_PER_RUN,
    DEFAULT_DKIM_ROTATION_OVERLAP_DAYS,
    DEFAULT_DKIM_ROTATION_PUBLISH_GRACE_HOURS,
    deploymentDkimRotationBlocker,
    DKIM_SWITCH_ACK_TIMEOUT_MS,
    generateNextDkimKey,
    isConfigFlagOn,
    isDkimKeyLive,
    type DkimKeyLiveness,
    keptDkimRotationState,
    nextScheduledDkimRotation,
    resolveDkimManaged,
    retireDkimRotation,
    rotationDate,
    saveDkimRotation,
    startDkimRotation,
    type DkimRotationContext,
} from "../util/DkimRotationUtils.js";
import { findAllRows } from "../util/DnsPublishingUtils.js";
import { asEntity } from "../util/EntityUtils.js";
const { Config, Inject, Init, Logger } = ObjectDecorators;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How long the lookup of a pending rotation's new record may go unanswered before it counts as absent: six of the hourly runs. */
const DKIM_UNKNOWN_LOOKUP_TOLERANCE_MS = 6 * HOUR_MS;
/** At most this many phase changes per domain per run: a compromised key can go from "live" through the switch to retired in one run once the MTA has
 * confirmed, and nothing loops. */
const MAX_TRANSITIONS_PER_RUN = 5;

/**
 * Rotates each domain's DKIM key (spec 6.2), driving `Domain.dkimRotation` through its phases on every run (`mail:jobs:dkim_rotation:schedule`, hourly):
 *
 * 1. **idle -> pending**, once `mail:dkim:rotation:interval_days` have passed since the last rotation (or the domain's creation) for an enabled, verified
 * domain, unless paused or turned off (`mail:dkim:rotation:enabled`), at most `mail:dkim:rotation:max_starts_per_run` per run; or by "Rotate now"
 * (`BaseDomainRoute`). The new selector is recorded first, then its key generated; the new record joins the desired state. Signing is unchanged.
 * 2. **pending -> switching**, once the new record is live through the configured `DnsResolver` (`liveSince`) and has been for
 * `mail:dkim:rotation:publish_grace_hours` (a compromised key skips the grace, never the live check). A manual domain waits the same way, however long the
 * admin takes. The domain's `dkimSelector`/`dkimPublicKey` become the new key and the old one moves to `previous`; then the provider is asked to sign
 * with it (`activate()`, repeated on every run until the MTA confirms). Until then an administrator's cancel reverts the switch.
 * 3. **switching -> overlap**, once the MTA reports the new selector (`signingSelector()`): the old record stays published for
 * `mail:dkim:rotation:overlap_days` (none for a compromised key). Without that acknowledgement for an hour, `lastError` says so and both stay published.
 * 4. **overlap -> idle** at `previous.retireAt`: the old record leaves the desired state, its private key is deleted and `lastRotatedAt` is set.
 *
 * Runs on every replica: each transition is one versioned update of the domain row, so a replica that loses the race gets a version conflict and skips
 * the domain until its next run. Keys imported by hand (`dkimManaged: false`), a provider that doesn't rotate and SES (`mail:transport:provider: ses`,
 * which signs with its own Easy DKIM) are never rotated. A row from before rotation is asked about once (`resolveDkimManaged()`) and the answer recorded.
 *
 * Concrete entity classes are supplied by the Mongo/SQL subclasses (`DkimRotationJobMongo`/`DkimRotationJobSQL`).
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class DkimRotationJob<D extends Domain> extends BackgroundService {
    protected abstract domainClass: any;

    /** Supplied by the Mongo/SQL subclasses so each transition is recorded as an `AuditLogEntry`. */
    protected abstract auditLogClass: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    protected domainRepo?: RepoUtils<D>;
    protected auditLogRepo?: RepoUtils<any>;
    protected auditLogUtils?: AuditLogUtils;
    protected dnsPublisher?: DnsPublisher;

    @Config("mail:jobs:dkim_rotation:schedule", "0 0 * * * *")
    private scheduleExpr: string = "0 0 * * * *";

    /** Whether rotations start on schedule (`mail:dkim:rotation:enabled`). Off, "Rotate now" still works and a rotation in progress still finishes. */
    @Config("mail:dkim:rotation:enabled", true)
    protected rotationEnabled: unknown = true;

    @Config("mail:dkim:rotation:interval_days", DEFAULT_DKIM_ROTATION_INTERVAL_DAYS)
    protected intervalDays: unknown = DEFAULT_DKIM_ROTATION_INTERVAL_DAYS;

    @Config("mail:dkim:rotation:overlap_days", DEFAULT_DKIM_ROTATION_OVERLAP_DAYS)
    protected overlapDays: unknown = DEFAULT_DKIM_ROTATION_OVERLAP_DAYS;

    @Config("mail:dkim:rotation:publish_grace_hours", DEFAULT_DKIM_ROTATION_PUBLISH_GRACE_HOURS)
    protected publishGraceHours: unknown = DEFAULT_DKIM_ROTATION_PUBLISH_GRACE_HOURS;

    /** At most this many scheduled rotations start per run and replica (`mail:dkim:rotation:max_starts_per_run`), so a deployment whose domains all
     * fall due at once (the first run after rotation arrives) spreads their new keys, and their new records, over several runs. */
    @Config("mail:dkim:rotation:max_starts_per_run", DEFAULT_DKIM_ROTATION_MAX_STARTS_PER_RUN)
    protected maxStartsPerRun: unknown = DEFAULT_DKIM_ROTATION_MAX_STARTS_PER_RUN;

    /** The run since which the lookup of each pending rotation's new record has gone unanswered, by domain uid; only in this process, so a restart
     * begins the streak again. */
    private unknownSince: Map<string, Date> = new Map();

    /** What is left of `maxStartsPerRun` in the current run (no limit for an `advanceDomain()` outside one). */
    private startsLeft: number = Number.POSITIVE_INFINITY;

    /** `mail:transport:provider`: with `ses`, SES signs with its own Easy DKIM and these keys aren't used. */
    @Config("mail:transport:provider", "postfix")
    protected transportProvider: string = "postfix";

    @Inject("DnsResolver")
    protected dnsResolver?: DnsResolver;

    @Inject("DkimKeyProvider")
    protected dkimKeyProvider?: DkimKeyProvider;

    @Logger
    protected logger: any;

    public get schedule(): string | undefined {
        return this.scheduleExpr;
    }

    @Init
    public async init(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        if (!this.domainRepo && this.domainClass) {
            this.domainRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.domainClass.name, args: [this.domainClass] });
        }
        if (!this.auditLogRepo && this.auditLogClass) {
            this.auditLogRepo = await this._objectFactory.newInstance(RepoUtils, { name: this.auditLogClass.name, args: [this.auditLogClass] });
        }
        if (!this.auditLogUtils && this.auditLogClass) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
        if (!this.dnsPublisher) {
            this.dnsPublisher = await resolveDnsPublisher(this._objectFactory, this.logger);
        }
    }

    public async start(): Promise<void> {
        // Nothing to do at startup beyond `init()` above; processing happens entirely in `run()`.
    }

    public stop(): Promise<void> | void {
        // Do nothing
    }

    private context(): DkimRotationContext {
        return { repo: this.domainRepo!, keyProvider: this.dkimKeyProvider!, auditLogUtils: this.auditLogUtils, dnsPublisher: this.dnsPublisher, logger: this.logger };
    }

    public async run(): Promise<void> {
        if (!this.domainRepo || deploymentDkimRotationBlocker(this.dkimKeyProvider, this.transportProvider)) {
            return;
        }
        const now: Date = new Date();
        this.startsLeft = Math.floor(configNumber(this.maxStartsPerRun, DEFAULT_DKIM_ROTATION_MAX_STARTS_PER_RUN));
        for (const domain of await findAllRows<D>(this.domainRepo)) {
            await this.advanceDomain(domain, now);
        }
    }

    /** Moves `domain` through as many phases as are due now. Never throws: a lost race is logged at debug level (another replica moved it), anything else
     * as a warning, and the domain is looked at again on the next run. */
    protected async advanceDomain(domain: D, now: Date): Promise<void> {
        try {
            let current: D | undefined = domain;
            for (let i = 0; current && i < MAX_TRANSITIONS_PER_RUN; i++) {
                current = await this.step(current, now);
            }
        } catch (err: any) {
            if (err?.status === 409) {
                this.logger?.debug(`DkimRotationJob: '${domain.name}' was changed by another writer; it is looked at again on the next run.`);
                return;
            }
            this.logger?.warn(`DkimRotationJob: the DKIM rotation of '${domain.name}' could not move on: ${err?.message}`);
        }
    }

    /** One transition of `domain`, returning the updated row when another may follow at once, or `undefined` when there is nothing more to do now. */
    private async step(domain: D, now: Date): Promise<D | undefined> {
        const state: DkimRotationState | null | undefined = domain.dkimRotation;
        if (state?.phase !== "pending") {
            this.unknownSince.delete(domain.uid);
        }
        switch (state?.phase) {
            case "pending":
                return await this.stepPending(domain, state, now);
            case "switching":
                return await this.stepSwitching(domain, state, now);
            case "overlap":
                return await this.stepOverlap(domain, state, now);
            default:
                return await this.stepIdle(domain, now);
        }
    }

    /** Starts a scheduled rotation once one is due, while this run's budget of starts lasts. An unverified domain is never started: nobody may ever
     * publish its new record, and the rotation would wait in pending for good. */
    private async stepIdle(domain: D, now: Date): Promise<D | undefined> {
        if (
            !isConfigFlagOn(this.rotationEnabled, true) ||
            this.startsLeft <= 0 ||
            domain.dkimRotation?.paused ||
            !domain.enabled ||
            !domain.verified ||
            !domain.dkimSelector ||
            !domain.dkimPublicKey
        ) {
            return undefined;
        }
        const due: Date | undefined = nextScheduledDkimRotation(domain, configNumber(this.intervalDays, DEFAULT_DKIM_ROTATION_INTERVAL_DAYS));
        if (!due || due.getTime() > now.getTime()) {
            return undefined;
        }
        const managed: boolean | undefined = await resolveDkimManaged(this.dkimKeyProvider, domain);
        if (managed === false && domain.dkimManaged !== false) {
            // Recorded once, so the provider isn't asked again on every run.
            await this.domainRepo!.update({ uid: domain.uid, version: domain.version, dkimManaged: false } as any, asEntity(this.domainRepo!, domain), {
                version: domain.version,
                ignoreACL: true,
            });
        }
        if (!managed) {
            return undefined;
        }
        this.startsLeft--;
        return await startDkimRotation(this.context(), domain, "scheduled", now, {}, { dkimManaged: true });
    }

    /** Waits for the new record to be live and the grace to pass, then switches the domain's key. */
    private async stepPending(domain: D, state: DkimRotationState, now: Date): Promise<D | undefined> {
        const next = state.next;
        if (!next?.selector) {
            await saveDkimRotation(this.context(), domain, keptDkimRotationState(state));
            return undefined;
        }
        if (!next.publicKey) {
            const generated: D = await generateNextDkimKey(this.context(), domain);
            return generated.dkimRotation?.next?.publicKey ? generated : undefined;
        }
        const liveSince: Date | undefined = rotationDate(next.liveSince);
        let liveness: DkimKeyLiveness = await isDkimKeyLive(this.dnsResolver!, domain.name, next.selector, next.publicKey);
        if (liveness === "unknown") {
            // A lookup that could not be answered says nothing about the record: the grace already served stands and the run waits for the next one.
            // Not for ever, though: a resolver that reports a vanished record in a way that isn't recognised as such (no `code`) would otherwise keep the
            // grace of a record that is long gone, so a streak of unanswered lookups as long as DKIM_UNKNOWN_LOOKUP_TOLERANCE_MS counts as absent.
            const since: Date = this.unknownSince.get(domain.uid) ?? now;
            if (since === now) {
                this.unknownSince.set(domain.uid, now);
                this.logger?.warn(
                    `DkimRotationJob: the DNS lookup of the new DKIM record of '${domain.name}' (selector '${next.selector}') could not be answered; the rotation waits and the lookup is repeated on the next run.`,
                );
            }
            if (now.getTime() - since.getTime() < DKIM_UNKNOWN_LOOKUP_TOLERANCE_MS) {
                return undefined;
            }
            liveness = "absent";
        } else {
            this.unknownSince.delete(domain.uid);
        }
        if (liveness === "absent") {
            if (liveSince) {
                // The record went away again: the grace starts over once it is back.
                const { liveSince: _gone, ...rest } = next;
                await saveDkimRotation(this.context(), domain, { ...state, next: rest });
            }
            return undefined;
        }
        if (!liveSince) {
            return await saveDkimRotation(this.context(), domain, { ...state, next: { ...next, liveSince: now } });
        }
        const graceMs: number = configNumber(this.publishGraceHours, DEFAULT_DKIM_ROTATION_PUBLISH_GRACE_HOURS) * HOUR_MS;
        if (next.reason !== "compromised" && now.getTime() - liveSince.getTime() < graceMs) {
            return undefined;
        }

        const switched: D = await saveDkimRotation(
            this.context(),
            domain,
            {
                ...keptDkimRotationState(state),
                phase: "switching",
                previous: { selector: domain.dkimSelector!, publicKey: domain.dkimPublicKey! },
                reason: next.reason,
                switchedAt: now,
            },
            { dkimSelector: next.selector, dkimPublicKey: next.publicKey },
        );
        await this.auditLogUtils?.record({
            action: AuditAction.DKIM_ROTATION_SWITCHED,
            targetType: "Domain",
            targetUid: domain.uid,
            details: { name: domain.name, selector: next.selector, previousSelector: domain.dkimSelector },
        });
        await notifyDnsPublisher(this.dnsPublisher, { scope: "domain", domainUid: domain.uid }, this.logger);
        return switched;
    }

    /** Waits for the MTA to confirm it signs with the new selector, asking the provider to switch on every run until it does. */
    private async stepSwitching(domain: D, state: DkimRotationState, now: Date): Promise<D | undefined> {
        const selector: string = domain.dkimSelector!;
        if ((await this.dkimKeyProvider!.signingSelector?.(domain.name)) === selector) {
            const overlapMs: number = state.reason === "compromised" ? 0 : configNumber(this.overlapDays, DEFAULT_DKIM_ROTATION_OVERLAP_DAYS) * DAY_MS;
            const { lastError: _cleared, ...rest } = state;
            return await saveDkimRotation(this.context(), domain, {
                ...rest,
                phase: "overlap",
                previous: { ...state.previous!, retireAt: new Date(now.getTime() + overlapMs) },
            });
        }

        let lastError: string | undefined;
        try {
            await this.dkimKeyProvider!.activate!(domain.name, selector);
            // A cancel may have reverted the switch (`BaseDomainRoute.cancelDkimRotation()`) after this run read the row, its own activation of the old
            // key landing before this one: the row is the truth, so the MTA is pointed back at the row's selector.
            const current: D | undefined = await this.domainRepo!.findOne(domain.uid, { ignoreACL: true });
            if (current?.dkimSelector && current.dkimSelector !== selector) {
                await this.dkimKeyProvider!.activate!(domain.name, current.dkimSelector);
                return undefined;
            }
            const switchedAt: Date | undefined = rotationDate(state.switchedAt);
            if (switchedAt && now.getTime() - switchedAt.getTime() >= DKIM_SWITCH_ACK_TIMEOUT_MS) {
                lastError =
                    "The mail server hasn't confirmed it signs with the new DKIM selector; both selectors stay published until it does. " +
                    "An older postfix-bridge doesn't acknowledge the switch.";
            }
        } catch (err: any) {
            lastError = `Signing could not be switched to the new DKIM key: ${err?.message}`;
        }
        if (lastError !== state.lastError) {
            const { lastError: _previous, ...rest } = state;
            await saveDkimRotation(this.context(), domain, lastError ? { ...rest, lastError } : rest);
        }
        return undefined;
    }

    /** Retires the old selector at `retireAt`: its record leaves the desired state and its private key is deleted (`retireDkimRotation()`). */
    private async stepOverlap(domain: D, state: DkimRotationState, now: Date): Promise<D | undefined> {
        const retireAt: Date | undefined = rotationDate(state.previous?.retireAt);
        if (retireAt && retireAt.getTime() > now.getTime()) {
            return undefined;
        }
        await retireDkimRotation(this.context(), domain, now);
        return undefined;
    }
}
