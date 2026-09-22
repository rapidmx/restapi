///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ObjectFactory } from "@rapidrest/core";
import { RepoUtils } from "@rapidrest/service-core";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { resolveFederationPolicy } from "./FederationUtils.js";

/** Caches one `RepoUtils` per concrete `Domain` class (Mongo vs SQL) - shared across every calling route
 * rather than each maintaining its own lazy-repo field/getter, mirroring `AuditLogUtils.ts`'s
 * `getAuditLogRepo()` exactly, for the same reason: the repo here is keyed only by which concrete class
 * is in play, never by which route/job instance is calling. */
const domainRepoCache = new WeakMap<any, Promise<RepoUtils<any>>>();

function getDomainRepo(objectFactory: ObjectFactory, domainClass: any): Promise<RepoUtils<any>> {
    let cached = domainRepoCache.get(domainClass);
    if (!cached) {
        cached = Promise.resolve(objectFactory.newInstance(RepoUtils, { name: domainClass.name, args: [domainClass] }));
        domainRepoCache.set(domainClass, cached);
    }
    return cached;
}

/** IANA's Special-Use Domain Names registry (RFC 6761/6762/2606/8375/9476) - hostnames under any of these
 * are reserved for local/private resolution (mDNS, home-router discovery, etc.) and are never resolvable
 * via public DNS, so a `Domain` under one of these can never have its ownership proven by
 * `checkDomainVerification()`'s public TXT lookup. Registering one is a legitimate, common setup for an
 * internal-only mail system (e.g. `mail.local`) - since the admin adding it is themselves the only
 * authority over that namespace, `BaseDomainRoute.create()` treats the TLD itself as sufficient proof and
 * skips the DNS-proof workflow entirely rather than leaving it permanently stuck unverified. */
const RESERVED_TLDS = new Set(["local", "localhost", "test", "example", "invalid", "internal", "onion"]);

/** `true` if `name` (a `Domain.name` candidate) is or ends with one of `RESERVED_TLDS` - e.g. both
 * `"local"` and `"mail.local"` match on the `local` label. */
export function isReservedDomainName(name: string): boolean {
    const labels: string[] = name.toLowerCase().split(".");
    return RESERVED_TLDS.has(labels[labels.length - 1]);
}

/**
 * Extracts just the hostname to recommend for the Autodiscover DNS setup checklist entries
 * (`util/DnsSetupUtils.ts`'s `checkAutodiscoverCname()`/`checkAutodiscoverSrv()`, called from
 * `BaseDomainRoute.dnsSetup()`) from a `mail:autodiscover:public_url` value, or `""` when it's unset or not
 * a safe `https://` URL to advertise. This intentionally duplicates only the narrow https-only/
 * no-credentials shape of `BaseAutodiscoverRoute`'s own (stricter) `baseUrl` validation in the
 * `@rapidmx/autodiscover-plugin` package - this value is never used to answer a client here, only to
 * display a DNS recommendation, so a simple hostname extraction is enough.
 */
export function extractPublicHostname(value: string): string {
    const trimmed: string = value.trim();
    if (!trimmed) {
        return "";
    }
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return "";
    }
    if (url.protocol !== "https:" || url.username || url.password) {
        return "";
    }
    return url.hostname;
}

/**
 * Returns the names of every `Domain` that is both `enabled` and `verified` - the one definition of
 * "this server's domains" consumed by `BaseMailboxRoute`, `BaseDistributionListRoute`, and
 * `BaseMailIngestRoute` alike. An empty result means "unconfigured, no restriction" everywhere it's
 * consumed, matching this library's previous empty-`mail:domains` behavior.
 */
/** Well above any real deployment's domain count - `RepoUtils.find()` defaults to a 100-row page otherwise
 * (`ModelUtils.buildSearchQuerySQL`'s own default, which ignores `options.limit` and must be baked into the
 * query object itself - see the identical note on `ScanQueueJob`'s own queries), which would otherwise
 * silently drop every domain past the 100th from "this server's domains" everywhere that list gates mailbox
 * creation and recipient-tier classification. */
const MAX_VERIFIED_DOMAINS = 10_000;

export async function getVerifiedDomainNames(objectFactory: ObjectFactory, domainClass: any): Promise<string[]> {
    const repo = await getDomainRepo(objectFactory, domainClass);
    const domains = await repo.find({ enabled: true, verified: true, limit: MAX_VERIFIED_DOMAINS } as any, {
        ignoreACL: true,
        limit: MAX_VERIFIED_DOMAINS,
    });
    return domains.map((d: any) => d.name);
}

/**
 * Returns the names of every `Domain` that is both `enabled` and `verified` AND is not a pure alias of
 * another domain (`Domain.aliasOf` unset) - the domain list a `Mailbox`/`DistributionList` address is
 * actually restricted to (`BaseMailboxRoute`/`BaseDistributionListRoute`). An alias domain (see
 * `Domain.aliasOf`'s own doc comment) is deliberately excluded here even though it's a real, verified
 * domain this server accepts mail on (`getVerifiedDomainNames()` still includes it) - it has no mailboxes
 * of its own by design, only ever reached through `resolveDomainAlias()`.
 */
export async function getPrimaryDomainNames(objectFactory: ObjectFactory, domainClass: any): Promise<string[]> {
    const repo = await getDomainRepo(objectFactory, domainClass);
    // Filtered client-side rather than pushing `aliasOf` into the query itself - an "is unset" filter doesn't
    // translate identically across the Mongo/SQL backends (a SQL `NULL` column vs. a Mongo missing field), and
    // this list is already capped at `MAX_VERIFIED_DOMAINS` rows, the same trade-off `isReservedDomainName()`'s
    // caller-side checks elsewhere in this module already make.
    const domains = await repo.find({ enabled: true, verified: true, limit: MAX_VERIFIED_DOMAINS } as any, {
        ignoreACL: true,
        limit: MAX_VERIFIED_DOMAINS,
    });
    return domains.filter((d: any) => !d.aliasOf).map((d: any) => d.name);
}

/**
 * Returns the names of every currently enabled-and-verified `Domain` whose `aliasOf` names
 * `primaryDomainName` (case-insensitive) - the alias domains a mailbox on `primaryDomainName` may also
 * send as (`BaseMessageRoute.assertSenderAllowed()`). Not cached like `getVerifiedDomainNames()`/
 * `getPrimaryDomainNames()`'s own full-table scan - callers only ever need this for one specific domain at
 * a time, so a narrow query is cheaper than filtering the whole list client-side.
 */
export async function getAliasDomainNames(objectFactory: ObjectFactory, domainClass: any, primaryDomainName: string): Promise<string[]> {
    const repo = await getDomainRepo(objectFactory, domainClass);
    const domains = await repo.find(
        { enabled: true, verified: true, aliasOf: primaryDomainName.toLowerCase(), limit: MAX_VERIFIED_DOMAINS } as any,
        { ignoreACL: true, limit: MAX_VERIFIED_DOMAINS },
    );
    return domains.map((d: any) => d.name);
}

/**
 * Rewrites `address` from an alias domain onto its primary domain, for inbound address resolution
 * (`BaseMailIngestRoute.findExactMailboxByAddress()`/`findDistributionListByAddress()`) and local key
 * discovery (`util/LocalKeyDiscoveryUtils.ts`). Returns `undefined` when no rewrite applies: `address` has
 * no `@`, its domain isn't a currently enabled-and-verified alias `Domain`, or the `Domain` it names via
 * `aliasOf` isn't itself currently enabled-and-verified (a dangling/disabled reference resolves to nothing
 * rather than silently misrouting mail) - the caller falls back to treating `address` as-is in every case.
 * A single point (indexed `findOne` lookups, not a full domain scan) so every caller pays for at most two
 * lookups regardless of how many domains exist. `domainClass` itself is falsy only for a lightweight test
 * double that never wires one up (every real Mongo/SQL route subclass always supplies it) - treated the
 * same as "nothing to rewrite" rather than throwing, matching this module's `DkimKeyProvider`-style
 * tolerance of an unwired optional dependency elsewhere in this library.
 */
export async function resolveDomainAlias(objectFactory: ObjectFactory, domainClass: any, address: string): Promise<string | undefined> {
    if (!domainClass) {
        return undefined;
    }
    const atIndex: number = address.lastIndexOf("@");
    if (atIndex < 0) {
        return undefined;
    }
    const domainName: string = address.slice(atIndex + 1).toLowerCase();
    const repo = await getDomainRepo(objectFactory, domainClass);
    const domain = await repo.findOne(domainName, { ignoreACL: true });
    if (!domain?.enabled || !domain.verified || !domain.aliasOf) {
        return undefined;
    }
    const primary = await repo.findOne(domain.aliasOf.toLowerCase(), { ignoreACL: true });
    if (!primary?.enabled || !primary.verified) {
        return undefined;
    }
    return `${address.slice(0, atIndex)}@${primary.name.toLowerCase()}`;
}

/**
 * `true` if `address`'s domain is one of "this server's domains" (see `getVerifiedDomainNames()`) - the same
 * "internal sender" signal `ScanQueueJob.classifyForInbox()` already computes for Focused Inbox, reused as-is
 * for the delivery/read receipt design's own internal-vs-external mailbox settings (`ScanQueueJob.
 * maybeSendReceipt()`/`BaseMessageRoute.send()`/its `update()` override - see `Mailbox.
 * alwaysRequestReceiptInternal`/`autoSendReceiptsInternal` et al.).
 */
export async function isInternalAddress(
    objectFactory: ObjectFactory,
    domainClass: any,
    address: string,
    verifiedDomainNames?: string[],
): Promise<boolean> {
    const domain: string | undefined = address.split("@")[1]?.toLowerCase();
    if (!domain) {
        return false;
    }
    // `verifiedDomainNames`, when passed, skips the `Domain` query entirely - a caller classifying several
    // addresses in the same operation (e.g. `BaseMessageRoute.send()` over every recipient) can fetch it once
    // and reuse it, rather than this function re-querying "this server's domains" from scratch per address.
    const domains = verifiedDomainNames ?? (await getVerifiedDomainNames(objectFactory, domainClass));
    return domains.includes(domain);
}

/** The three receipt-scoping tiers a recipient/requester address classifies into, per the Scoping Principle
 * in `specs/end-to-end_encryption.md` (disclosing capabilities like receipts scope to same-organisation by
 * default, unlike protective capabilities which scope to any federated peer): `"same-org"` is exactly
 * `isInternalAddress()`'s existing check; `"federated"` is a remote domain publishing a valid `_rapidmx`
 * policy record - a different organisation that has still opted into RapidMX's federated protocols;
 * `"external"` is everything else. */
export type RecipientTier = "same-org" | "federated" | "external";

/** Checks whether `address`'s domain is a federated RapidMX peer. `classifyRecipientTier()` calls through
 * this seam rather than hard-coding a check, keeping this module free of a hard dependency on any one
 * `DnsResolver` - see `createFederatedPeerCheck()` below for the real implementation. */
export type FederatedPeerCheck = (address: string) => Promise<boolean>;

/** The default `FederatedPeerCheck` - always `false`, so every non-`same-org` address classifies as
 * `"external"` for a caller that hasn't wired in `createFederatedPeerCheck()`'s real implementation as
 * `classifyRecipientTier()`'s `isFederatedPeer` argument. */
const neverFederated: FederatedPeerCheck = async () => false;

/**
 * Builds a real `FederatedPeerCheck` backed by `util/FederationUtils.ts`'s `resolveFederationPolicy()` - a
 * federated peer is any domain publishing a valid `_rapidmx` TXT record, regardless of which organisation
 * operates it. `classifyRecipientTier()` only ever consults this for a domain that's already failed the
 * same-org check, so there's no need to special-case "this server's own domain" here too.
 */
export function createFederatedPeerCheck(dnsResolver: DnsResolver): FederatedPeerCheck {
    return async (address: string): Promise<boolean> => {
        const domain: string | undefined = address.split("@")[1]?.toLowerCase();
        if (!domain) {
            return false;
        }
        const policy = await resolveFederationPolicy(dnsResolver, domain);
        return policy !== undefined;
    };
}

/**
 * Classifies `address` into one of the three `RecipientTier`s above - the shared basis for the receipt
 * feature's `Mailbox.alwaysRequestReceipt*`/`autoSendReceipts*` three-way settings. `isFederatedPeer`
 * defaults to `neverFederated`; callers pass a real federation check once one exists.
 */
export async function classifyRecipientTier(
    objectFactory: ObjectFactory,
    domainClass: any,
    address: string,
    isFederatedPeer: FederatedPeerCheck = neverFederated,
    verifiedDomainNames?: string[],
): Promise<RecipientTier> {
    if (await isInternalAddress(objectFactory, domainClass, address, verifiedDomainNames)) {
        return "same-org";
    }
    return (await isFederatedPeer(address)) ? "federated" : "external";
}
