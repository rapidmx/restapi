///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { JWTUser } from "@rapidrest/core";
import type { HttpRequest, RepoUtils } from "@rapidrest/service-core";
import type { DkimKeyProvider } from "../dkim/DkimKeyProvider.js";
import { notifyDnsPublisher, type DnsPublisher } from "../dns/DnsPublisher.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { AuditAction, type DkimRotationReason, type DkimRotationState, type Domain } from "../models/types.js";
import type { AuditLogUtils } from "./AuditLogUtils.js";
import { asEntity } from "./EntityUtils.js";

/** A rotation's new selector is `rmx<yyyymmdd>`, with `b`, `c`, ... after it on a same-day collision. */
export const DKIM_ROTATION_SELECTOR_PREFIX = "rmx";
/** `mail:dkim:rotation:interval_days`: how long a key is used before a scheduled rotation replaces it. */
export const DEFAULT_DKIM_ROTATION_INTERVAL_DAYS = 180;
/** `mail:dkim:rotation:overlap_days`: how long the old selector stays published after signing switched, for mail still in queues. */
export const DEFAULT_DKIM_ROTATION_OVERLAP_DAYS = 7;
/** `mail:dkim:rotation:publish_grace_hours`: how long the new record must have been live before signing switches to it, so receivers' resolvers have
 * dropped any negative-cached answer. */
export const DEFAULT_DKIM_ROTATION_PUBLISH_GRACE_HOURS = 48;
/** `mail:dkim:rotation:max_starts_per_run`: how many scheduled rotations one run of the job starts at most. */
export const DEFAULT_DKIM_ROTATION_MAX_STARTS_PER_RUN = 10;
/** How long after the switch the MTA's acknowledgement is waited for before the rotation says it is missing. */
export const DKIM_SWITCH_ACK_TIMEOUT_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why a domain's DKIM key can't rotate: the provider doesn't rotate (`NullDkimKeyProvider`), SES signs with its own Easy DKIM, the domain has no key,
 * an administrator imported the key by hand, or the provider can't say whether it holds the key. */
export type DkimRotationBlocker = "unsupported" | "ses" | "no_key" | "imported" | "unknown_key";

/** `name` and `version` are all the rotation needs of a domain row beyond the DKIM fields. */
type RotatingDomain = Pick<Domain, "uid" | "name" | "version" | "dkimSelector" | "dkimPublicKey" | "dkimManaged" | "dkimRotation">;

/** `rmx<yyyymmdd>` for `now` (UTC): the start of every selector minted that day. */
function dkimSelectorBase(now: Date): string {
    return `${DKIM_ROTATION_SELECTOR_PREFIX}${now.toISOString().slice(0, 10).replace(/-/g, "")}`;
}

/** A new rotation's selector for `now` (UTC): `rmx<yyyymmdd>`, or with `b`, `c`, ... `z`, `aa`, ... after it while that is one of `taken`. */
export function newDkimSelector(now: Date, taken: Iterable<string | null | undefined>): string {
    const used: Set<string> = new Set([...taken].filter((selector): selector is string => !!selector));
    const base: string = dkimSelectorBase(now);
    for (let i = 0; ; i++) {
        const candidate: string = i === 0 ? base : base + String.fromCharCode(97 + (i % 26)).repeat(Math.floor(i / 26) + 1);
        if (!used.has(candidate)) {
            return candidate;
        }
    }
}

/** A rotation date as it comes back from either backend: a `Date` on Mongo, an ISO string from SQL's JSON column. `undefined` for anything else. */
export function rotationDate(value: unknown): Date | undefined {
    if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") {
        return undefined;
    }
    const date: Date = new Date(value);
    return isNaN(date.getTime()) ? undefined : date;
}

/** A switch from configuration: `defaultValue` when unset, off for `false`, `0` and the text `"false"`, `"0"`, `"no"` or `"off"` (a value set through the
 * environment arrives as text, where `"false"` is truthy), on for anything else. */
export function isConfigFlagOn(value: unknown, defaultValue: boolean): boolean {
    if (value === undefined || value === null) {
        return defaultValue;
    }
    if (typeof value === "string") {
        return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
    }
    return value !== false && value !== 0;
}

/** A non-negative number from configuration (or its text), else `defaultValue`. */
export function configNumber(value: unknown, defaultValue: number): number {
    const parsed: number = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : NaN;
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

/** When `domain`'s next scheduled rotation is due: `intervalDays` after the latest of its last rotation and its last cancelled one, or after its creation
 * before either. `undefined` without any of them. */
export function nextScheduledDkimRotation(domain: { dateCreated?: Date; dkimRotation?: DkimRotationState | null }, intervalDays: number): Date | undefined {
    const anchors: number[] = [domain.dkimRotation?.lastRotatedAt, domain.dkimRotation?.lastCancelledAt]
        .map((value) => rotationDate(value)?.getTime())
        .filter((time): time is number => time !== undefined);
    const anchor: number | undefined = anchors.length > 0 ? Math.max(...anchors) : rotationDate(domain.dateCreated)?.getTime();
    return anchor === undefined ? undefined : new Date(anchor + intervalDays * DAY_MS);
}

/** Whether `<selector>._domainkey.<domainName>` carries `publicKey` live: a TXT record there whose strings, rejoined and without spaces, hold
 * `p=<publicKey>`. A failed lookup is not live. */
export async function isDkimKeyLive(dnsResolver: DnsResolver, domainName: string, selector: string, publicKey: string): Promise<boolean> {
    if (!publicKey) {
        return false;
    }
    try {
        const values: string[] = (await dnsResolver.resolveTxt(`${selector}._domainkey.${domainName}`)).map((chunks) => chunks.join("").replace(/\s+/g, ""));
        return values.some((value) => value.includes(`p=${publicKey}`));
    } catch {
        return false;
    }
}

/** Why no key of this deployment can rotate (the provider doesn't rotate, or SES signs instead), or `undefined` when keys can. `transportProvider` is
 * `mail:transport:provider`. A provider without `signingSelector()` doesn't rotate: a switch could never be confirmed. */
export function deploymentDkimRotationBlocker(keyProvider: DkimKeyProvider | undefined, transportProvider: string | undefined): DkimRotationBlocker | undefined {
    if (!keyProvider?.supportsRotation || !keyProvider.generateKeyPair || !keyProvider.activate || !keyProvider.signingSelector) {
        return "unsupported";
    }
    return String(transportProvider ?? "").trim().toLowerCase() === "ses" ? "ses" : undefined;
}

/** Why `domain`'s key can't rotate, in this order, or `undefined` when it can. `managed` is `resolveDkimManaged()`'s answer; `transportProvider` is
 * `mail:transport:provider`. */
export function dkimRotationBlocker(
    keyProvider: DkimKeyProvider | undefined,
    domain: Pick<Domain, "dkimSelector" | "dkimPublicKey">,
    managed: boolean | undefined,
    transportProvider: string | undefined,
): DkimRotationBlocker | undefined {
    const deployment: DkimRotationBlocker | undefined = deploymentDkimRotationBlocker(keyProvider, transportProvider);
    if (deployment) {
        return deployment;
    }
    if (!domain.dkimSelector || !domain.dkimPublicKey) {
        return "no_key";
    }
    if (managed === false) {
        return "imported";
    }
    return managed === undefined ? "unknown_key" : undefined;
}

/** Whether `domain`'s key is the provider's: `dkimManaged` when the row records it, else whether the provider holds a key for the domain's selector equal
 * to its public key (rows from before rotation). `undefined` when that can't be told: no key on the row, a provider without `findKeyPair()`, or one that
 * failed. */
export async function resolveDkimManaged(
    keyProvider: DkimKeyProvider | undefined,
    domain: Pick<Domain, "name" | "dkimSelector" | "dkimPublicKey" | "dkimManaged">,
): Promise<boolean | undefined> {
    if (typeof domain.dkimManaged === "boolean") {
        return domain.dkimManaged;
    }
    if (!domain.dkimSelector || !domain.dkimPublicKey || !keyProvider?.findKeyPair) {
        return undefined;
    }
    try {
        const held = await keyProvider.findKeyPair(domain.name, domain.dkimSelector);
        return held?.publicKey === domain.dkimPublicKey;
    } catch {
        return undefined;
    }
}

/** An idle state keeping only what outlives a rotation: when the last one finished or was cancelled, the pause and the selectors minted that day. */
export function keptDkimRotationState(state: DkimRotationState | null | undefined): DkimRotationState {
    const kept: DkimRotationState = { phase: "idle" };
    for (const key of ["lastRotatedAt", "lastCancelledAt", "paused", "mintedSelectors"] as const) {
        if (state?.[key] !== undefined) {
            (kept as any)[key] = state[key];
        }
    }
    return kept;
}

/** What the rotation writes with: the domain repository, the key provider, and the audit log and DNS publisher it reports to. */
export interface DkimRotationContext {
    repo: RepoUtils<any>;
    keyProvider: DkimKeyProvider;
    auditLogUtils?: AuditLogUtils;
    dnsPublisher?: DnsPublisher;
    logger?: any;
}

/** Who asked, for the audit entry: a request's caller, or nobody for the job. */
export interface DkimRotationCaller {
    req?: HttpRequest;
    user?: JWTUser;
}

/** Saves `state` (and `fields`) on `domain` as one versioned update: a write racing another (a second replica, an admin's cancel) fails with a 409. */
export async function saveDkimRotation<T extends RotatingDomain>(
    ctx: DkimRotationContext,
    domain: T,
    state: DkimRotationState,
    fields: Partial<Domain> = {},
    user?: JWTUser,
): Promise<T> {
    return await ctx.repo.update({ uid: domain.uid, version: domain.version, ...fields, dkimRotation: state } as any, asEntity(ctx.repo, domain), {
        user,
        version: domain.version,
        ignoreACL: true,
    });
}

/**
 * Starts a rotation of `domain`: records the new selector first (one versioned update, so of two replicas only one starts it), audits
 * `DKIM_ROTATION_STARTED`, then generates its key (`generateNextDkimKey()`). Signing is unchanged. `fields` are saved with the start (the job records
 * `dkimManaged` it has just resolved).
 */
export async function startDkimRotation<T extends RotatingDomain>(
    ctx: DkimRotationContext,
    domain: T,
    reason: DkimRotationReason,
    now: Date,
    caller: DkimRotationCaller = {},
    fields: Partial<Domain> = {},
): Promise<T> {
    const state: DkimRotationState | null | undefined = domain.dkimRotation;
    // A selector cancelled or retired earlier the same day is never minted again: a receiver may still cache its record.
    const base: string = dkimSelectorBase(now);
    const mintedToday: string[] = (Array.isArray(state?.mintedSelectors) ? state.mintedSelectors : []).filter(
        (minted) => typeof minted === "string" && minted.startsWith(base),
    );
    const selector: string = newDkimSelector(now, [domain.dkimSelector, state?.previous?.selector, state?.next?.selector, ...mintedToday]);
    const started: T = await saveDkimRotation(
        ctx,
        domain,
        {
            ...keptDkimRotationState(state),
            phase: "pending",
            next: { selector, publicKey: "", createdAt: now, reason },
            mintedSelectors: [...mintedToday, selector],
        },
        fields,
        caller.user,
    );
    await ctx.auditLogUtils?.record(
        { action: AuditAction.DKIM_ROTATION_STARTED, targetType: "Domain", targetUid: domain.uid, details: { name: domain.name, selector, reason } },
        caller,
    );
    return await generateNextDkimKey(ctx, started);
}

/**
 * Generates the key of `domain`'s pending selector and records its public key, after which the new record is published (or shown for the admin to
 * add). A key that can't be generated is recorded as `lastError` and the row is returned as it is; the job tries again on its next run.
 */
export async function generateNextDkimKey<T extends RotatingDomain>(ctx: DkimRotationContext, domain: T): Promise<T> {
    const state: DkimRotationState = domain.dkimRotation!;
    const next = state.next!;
    let publicKey: string;
    try {
        publicKey = (await ctx.keyProvider.generateKeyPair!(domain.name, next.selector)).publicKey;
    } catch (err: any) {
        ctx.logger?.warn(`DKIM rotation: the key of selector '${next.selector}' of '${domain.name}' could not be generated: ${err?.message}`);
        return await saveDkimRotation(ctx, domain, { ...state, lastError: `The new DKIM key could not be generated: ${err?.message}` });
    }
    const { lastError: _lastError, ...rest } = state;
    let updated: T;
    try {
        updated = await saveDkimRotation(ctx, domain, { ...rest, next: { ...next, publicKey } });
    } catch (err: any) {
        if (err?.status === 409) {
            await deleteUnrecordedDkimKey(ctx, domain, next.selector);
        }
        throw err;
    }
    await notifyDnsPublisher(ctx.dnsPublisher, { scope: "domain", domainUid: domain.uid }, ctx.logger);
    return updated;
}

/** After a lost race to record `selector`'s new key (an administrator's cancel, another replica): deletes the key unless the row that won names that
 * selector, so a cancel racing the generation leaves no private key behind. A key that can't be deleted is logged. */
async function deleteUnrecordedDkimKey(ctx: DkimRotationContext, domain: RotatingDomain, selector: string): Promise<void> {
    try {
        const current: RotatingDomain | undefined = await ctx.repo.findOne(domain.uid, { ignoreACL: true });
        const state: DkimRotationState | null | undefined = current?.dkimRotation;
        if ([current?.dkimSelector, state?.next?.selector, state?.previous?.selector].includes(selector)) {
            return;
        }
        await ctx.keyProvider.deleteKeyPair?.(domain.name, selector);
    } catch (err: any) {
        ctx.logger?.warn(`DKIM rotation: the unrecorded key of selector '${selector}' of '${domain.name}' could not be deleted: ${err?.message}`);
    }
}

/**
 * Ends the overlap of `domain`'s rotation now: the row goes back to idle with `lastRotatedAt`, so the old record leaves the desired state (announced),
 * then the old private key is deleted (audited `DKIM_ROTATION_RETIRED`; a key that can't be deleted is logged and left). Run by the job at
 * `previous.retireAt`, and at once by "Rotate now" for a compromised key during the overlap.
 */
export async function retireDkimRotation<T extends RotatingDomain>(
    ctx: DkimRotationContext,
    domain: T,
    now: Date,
    caller: DkimRotationCaller = {},
): Promise<T> {
    const state: DkimRotationState | null | undefined = domain.dkimRotation;
    const retired: T = await saveDkimRotation(ctx, domain, { ...keptDkimRotationState(state), lastRotatedAt: now }, {}, caller.user);
    const selector: string | undefined = state?.previous?.selector;
    if (selector) {
        await ctx.auditLogUtils?.record(
            { action: AuditAction.DKIM_ROTATION_RETIRED, targetType: "Domain", targetUid: domain.uid, details: { name: domain.name, selector } },
            caller,
        );
        try {
            await ctx.keyProvider.deleteKeyPair?.(domain.name, selector);
        } catch (err: any) {
            ctx.logger?.warn(`DKIM rotation: the retired DKIM key '${selector}' of '${domain.name}' could not be deleted: ${err?.message}`);
        }
    }
    await notifyDnsPublisher(ctx.dnsPublisher, { scope: "domain", domainUid: domain.uid }, ctx.logger);
    return retired;
}
