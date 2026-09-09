///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ObjectFactory } from "@rapidrest/core";
import { RepoUtils } from "@rapidrest/service-core";

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
