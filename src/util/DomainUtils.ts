///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import type { RepoUtils } from "@rapidrest/service-core";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { addressDomainOf } from "./AddressUtils.js";
import { resolveFederationPolicy } from "./FederationUtils.js";

const { Logger } = ObjectDecorators;

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

/** Well above any real deployment's domain count - `RepoUtils.find()` defaults to a 100-row page otherwise
 * (`ModelUtils.buildSearchQuerySQL`'s own default, which ignores `options.limit` and must be baked into the
 * query object itself - see the identical note on `ScanQueueJob`'s own queries), which would otherwise
 * silently drop every domain past the 100th from "this server's domains" everywhere that list gates mailbox
 * creation and recipient-tier classification. */
const MAX_VERIFIED_DOMAINS = 10_000;

/** The three receipt-scoping tiers a recipient/requester address classifies into, per the Scoping Principle
 * in `specs/end-to-end_encryption.md` (disclosing capabilities like receipts scope to same-organisation by
 * default, unlike protective capabilities which scope to any federated peer): `"same-org"` is exactly
 * `DomainUtils.isInternalAddress()`'s existing check; `"federated"` is a remote domain publishing a valid `_rapidmx`
 * policy record - a different organisation that has still opted into RapidMX's federated protocols;
 * `"external"` is everything else. */
export type RecipientTier = "same-org" | "federated" | "external";

/** Checks whether `address`'s domain is a federated RapidMX peer. `DomainUtils.classifyRecipientTier()` calls through
 * this seam rather than hard-coding a check, keeping this module free of a hard dependency on any one
 * `DnsResolver` - see `createFederatedPeerCheck()` below for the real implementation. */
export type FederatedPeerCheck = (address: string) => Promise<boolean>;

/** The default `FederatedPeerCheck` - always `false`, so every non-`same-org` address classifies as
 * `"external"` for a caller that hasn't wired in `createFederatedPeerCheck()`'s real implementation as
 * `DomainUtils.classifyRecipientTier()`'s `isFederatedPeer` argument. */
const neverFederated: FederatedPeerCheck = async () => false;

/**
 * Builds a real `FederatedPeerCheck` backed by `util/FederationUtils.ts`'s `resolveFederationPolicy()` - a
 * federated peer is any domain publishing a valid `_rapidmx` TXT record, regardless of which organisation
 * operates it. `DomainUtils.classifyRecipientTier()` only ever consults this for a domain that's already failed the
 * same-org check, so there's no need to special-case "this server's own domain" here too.
 */
export function createFederatedPeerCheck(dnsResolver: DnsResolver): FederatedPeerCheck {
    return async (address: string): Promise<boolean> => {
        const domain: string | undefined = addressDomainOf(address);
        if (!domain) {
            return false;
        }
        const policy = await resolveFederationPolicy(dnsResolver, domain);
        return policy !== undefined;
    };
}

/**
 * This module's `Domain` queries, built once by the consuming route/job's `@Init` hook through the `ObjectFactory` with
 * the (already built) `Domain` repository -
 * `await objectFactory.newInstance(DomainUtils, { name: DomainClass.name, args: [domainRepo] })`. The pure helpers above
 * stay plain functions.
 */
export class DomainUtils {
    @Logger
    protected logger: any;

    constructor(protected readonly domainRepo: RepoUtils<any>) {}

    /**
     * Returns the names of every `Domain` that is both `enabled` and `verified` - the one definition of "this server's
     * domains" consumed by `BaseMailboxRoute`, `BaseDistributionListRoute`, and `BaseMailIngestRoute` alike. An empty result
     * means "unconfigured, no restriction" everywhere it's consumed. Read with an explicit limit of `MAX_VERIFIED_DOMAINS`
     * (the repository's own default page is 100 rows, which would silently drop every domain past the 100th).
     */
    public async getVerifiedDomainNames(): Promise<string[]> {
        const domains = await this.domainRepo.find({ enabled: true, verified: true, limit: MAX_VERIFIED_DOMAINS } as any, {
            ignoreACL: true,
            limit: MAX_VERIFIED_DOMAINS,
        });
        return domains.map((d: any) => d.name);
    }

    /**
     * Returns the names of every `Domain` that is both `enabled` and `verified` AND is not a pure alias of another domain
     * (`Domain.aliasOf` unset) - the domain list a `Mailbox`/`DistributionList` address is actually restricted to
     * (`BaseMailboxRoute`/`BaseDistributionListRoute`). An alias domain (see `Domain.aliasOf`'s own doc comment) is
     * deliberately excluded here even though it's a real, verified domain this server accepts mail on
     * (`getVerifiedDomainNames()` still includes it) - it has no mailboxes of its own by design, only ever reached through
     * `resolveDomainAlias()`.
     */
    public async getPrimaryDomainNames(): Promise<string[]> {
        // Filtered client-side rather than pushing `aliasOf` into the query itself - an "is unset" filter doesn't
        // translate identically across the Mongo/SQL backends (a SQL `NULL` column vs. a Mongo missing field), and
        // this list is already capped at `MAX_VERIFIED_DOMAINS` rows.
        const domains = await this.domainRepo.find({ enabled: true, verified: true, limit: MAX_VERIFIED_DOMAINS } as any, {
            ignoreACL: true,
            limit: MAX_VERIFIED_DOMAINS,
        });
        return domains.filter((d: any) => !d.aliasOf).map((d: any) => d.name);
    }

    /**
     * Returns the names of every currently enabled-and-verified `Domain` whose `aliasOf` names `primaryDomainName`
     * (case-insensitive) - the alias domains a mailbox on `primaryDomainName` may also send as
     * (`BaseMessageRoute.assertSenderAllowed()`). A narrow query, since callers only ever need this for one specific domain
     * at a time.
     */
    public async getAliasDomainNames(primaryDomainName: string): Promise<string[]> {
        const domains = await this.domainRepo.find(
            { enabled: true, verified: true, aliasOf: primaryDomainName.toLowerCase(), limit: MAX_VERIFIED_DOMAINS } as any,
            { ignoreACL: true, limit: MAX_VERIFIED_DOMAINS },
        );
        return domains.map((d: any) => d.name);
    }

    /**
     * Resolves a bare domain name (no local part) to its primary domain name, when `domainName` is a currently
     * enabled-and-verified alias `Domain` whose `aliasOf` target is itself currently enabled-and-verified. Returns
     * `undefined` when there's nothing to resolve - `domainName` isn't an alias, or its `aliasOf` reference is
     * dangling/disabled (never silently misroutes) - the caller then treats `domainName` as-is. The domain-name-only half
     * of `resolveDomainAlias()`, for callers (like `BaseKeyDiscoveryRoute`'s public federation endpoint) that only ever
     * have a bare domain in hand.
     */
    public async resolveDomainAliasName(domainName: string): Promise<string | undefined> {
        const domain = await this.domainRepo.findOne(domainName.toLowerCase(), { ignoreACL: true });
        if (!domain?.enabled || !domain.verified || !domain.aliasOf) {
            return undefined;
        }
        const primary = await this.domainRepo.findOne(domain.aliasOf.toLowerCase(), { ignoreACL: true });
        if (!primary?.enabled || !primary.verified) {
            return undefined;
        }
        return primary.name.toLowerCase();
    }

    /**
     * Rewrites `address` from an alias domain onto its primary domain, for inbound address resolution
     * (`BaseMailIngestRoute.findExactMailboxByAddress()`/`findDistributionListByAddress()`) and local key discovery
     * (`util/LocalKeyDiscoveryUtils.ts`). Returns `undefined` when no rewrite applies: `address` has no `@`, or its
     * domain doesn't resolve via `resolveDomainAliasName()` - the caller falls back to treating `address` as-is.
     */
    public async resolveDomainAlias(address: string): Promise<string | undefined> {
        const atIndex: number = address.lastIndexOf("@");
        if (atIndex < 0) {
            return undefined;
        }
        const primaryDomainName: string | undefined = await this.resolveDomainAliasName(address.slice(atIndex + 1));
        if (!primaryDomainName) {
            return undefined;
        }
        return `${address.slice(0, atIndex)}@${primaryDomainName}`;
    }

    /**
     * `true` if `address`'s domain is one of "this server's domains" (see `getVerifiedDomainNames()`) - the same
     * "internal sender" signal `ScanQueueJob.classifyForInbox()` computes for Focused Inbox, reused for the delivery/read
     * receipt design's own internal-vs-external mailbox settings. `verifiedDomainNames`, when passed, skips the `Domain`
     * query entirely - a caller classifying several addresses in the same operation can fetch it once and reuse it.
     */
    public async isInternalAddress(address: string, verifiedDomainNames?: string[]): Promise<boolean> {
        const domain: string | undefined = addressDomainOf(address);
        if (!domain) {
            return false;
        }
        const domains = verifiedDomainNames ?? (await this.getVerifiedDomainNames());
        return domains.includes(domain);
    }

    /**
     * Classifies `address` into one of the three `RecipientTier`s - the shared basis for the receipt feature's
     * `Mailbox.alwaysRequestReceipt*`/`autoSendReceipts*` three-way settings. `isFederatedPeer` defaults to
     * `neverFederated`; callers pass a real federation check (`createFederatedPeerCheck()`).
     */
    public async classifyRecipientTier(
        address: string,
        isFederatedPeer: FederatedPeerCheck = neverFederated,
        verifiedDomainNames?: string[],
    ): Promise<RecipientTier> {
        if (await this.isInternalAddress(address, verifiedDomainNames)) {
            return "same-org";
        }
        return (await isFederatedPeer(address)) ? "federated" : "external";
    }
}
