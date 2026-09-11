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
 * Returns the names of every `Domain` that is both `enabled` and `verified` - the one definition of
 * "this server's domains" consumed by `BaseMailboxRoute`, `BaseDistributionListRoute`, and
 * `BaseMailIngestRoute` alike. An empty result means "unconfigured, no restriction" everywhere it's
 * consumed, matching this library's previous empty-`mail:domains` behavior.
 */
export async function getVerifiedDomainNames(objectFactory: ObjectFactory, domainClass: any): Promise<string[]> {
    const repo = await getDomainRepo(objectFactory, domainClass);
    const domains = await repo.find({ enabled: true, verified: true }, { ignoreACL: true });
    return domains.map((d: any) => d.name);
}

/**
 * `true` if `address`'s domain is one of "this server's domains" (see `getVerifiedDomainNames()`) - the same
 * "internal sender" signal `ScanQueueJob.classifyForInbox()` already computes for Focused Inbox, reused as-is
 * for the delivery/read receipt design's own internal-vs-external mailbox settings (`ScanQueueJob.
 * maybeSendReceipt()`/`BaseMessageRoute.send()`/its `update()` override - see `Mailbox.
 * alwaysRequestReceiptInternal`/`autoSendReceiptsInternal` et al.).
 */
export async function isInternalAddress(objectFactory: ObjectFactory, domainClass: any, address: string): Promise<boolean> {
    const domain: string | undefined = address.split("@")[1]?.toLowerCase();
    if (!domain) {
        return false;
    }
    const domains = await getVerifiedDomainNames(objectFactory, domainClass);
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
): Promise<RecipientTier> {
    if (await isInternalAddress(objectFactory, domainClass, address)) {
        return "same-org";
    }
    return (await isFederatedPeer(address)) ? "federated" : "external";
}
