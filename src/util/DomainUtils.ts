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
