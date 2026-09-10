///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MemoryStore, SimpleStore } from "@rapidrest/core";
import type { DnsResolver } from "../dns/DnsResolver.js";

/**
 * The resolved `_rapidmx.<domain>` federation policy for a remote domain - see
 * `specs/end-to-end_encryption.md`'s "Domain Lookup" section. `id` is an opaque cache-invalidation token
 * this module never interprets beyond "same value as last time = don't refetch".
 */
export interface FederationPolicy {
    /** Hostname of the peer's RapidMX server, serving its `.well-known/rapidmx/keys/:hash` endpoint. */
    host: string;
    /** Opaque policy version token - changes only when the domain's federation policy itself changes, not
     * on every individual user's key rotation (per-user freshness is a separate, HTTP-`ETag`-based concern -
     * see the discovery client this module's `FederationPolicy` feeds into). */
    id: string;
}

/**
 * Module-level cache shared by every caller, matching `util/DomainUtils.ts`'s own module-level
 * `domainRepoCache` convention for the same reason: a plain `MemoryStore` (`@rapidrest/core`) needs no
 * construction arguments, so there is no reason to route it through `@Inject` or make every caller pass
 * one in. A deployment that needs this cache shared across multiple server instances can swap this
 * constant for a `RedisStore` later - nothing about this module's public functions depends on which
 * `SimpleStore` implementation backs them.
 */
const policyCache: SimpleStore = new MemoryStore();

/** Cache-key prefix - keeps this module's entries from ever colliding with an unrelated cache, should this
 * `SimpleStore` instance ever be shared with one (it isn't today). */
const CACHE_KEY_PREFIX = "federation-policy:";

/** Cached in place of a `FederationPolicy` for a domain confirmed to publish no `_rapidmx` TXT record at
 * all - the spec's "negative caching", so the common case (most correspondents don't run RapidMX) doesn't
 * repeat a failed DNS lookup on every send. Never structurally confusable with a real `FederationPolicy`,
 * which never carries a `participating` key. */
const NOT_PARTICIPATING: Record<string, any> = { participating: false };

/** Default cache lifetime (seconds) for both positive and negative results - 24 hours, matching the spec's
 * explicit default for negative caching. The spec gives no concrete number for positive caching, only the
 * requirement to not refetch while the TXT record's `id` is unchanged; absent a background revalidation
 * job, bounding it to the same 24h default is the simplest safe choice - a caller wiring this up behind its
 * own `@Config` field (Group E's discovery route) can widen either independently via `options`. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export interface ResolveFederationPolicyOptions {
    /** How long (seconds) a resolved policy is cached before being re-resolved. Default 24h. */
    positiveTtlSeconds?: number;
    /** How long (seconds) a confirmed non-participating domain is cached. Default 24h. */
    negativeTtlSeconds?: number;
}

/**
 * Parses a `_rapidmx` TXT record's value - `v=RMXv1; id=<id>; host=<host>;` (attribute order and the
 * trailing `;` are not significant) - into its `id`/`host` attributes. Returns `undefined` for anything
 * that isn't a recognized RapidMX policy record (wrong/missing `v=`, or missing either attribute) - callers
 * treat that identically to "no `_rapidmx` record published at all", per the spec's own framing of an
 * unparseable record as simply not participating.
 */
function parsePolicyRecord(value: string): FederationPolicy | undefined {
    const attrs = new Map<string, string>();
    for (const part of value.split(";")) {
        const trimmed: string = part.trim();
        if (!trimmed) {
            continue;
        }
        const eq: number = trimmed.indexOf("=");
        if (eq < 0) {
            continue;
        }
        attrs.set(trimmed.slice(0, eq).trim().toLowerCase(), trimmed.slice(eq + 1).trim());
    }
    if (attrs.get("v") !== "RMXv1") {
        return undefined;
    }
    const host: string | undefined = attrs.get("host");
    const id: string | undefined = attrs.get("id");
    return host && id ? { host, id } : undefined;
}

/**
 * Resolves `domain`'s federation policy via its `_rapidmx.<domain>` TXT record, caching both positive and
 * negative results in `policyCache`. Never throws - a DNS failure, NXDOMAIN, or a record that doesn't parse
 * as a recognized RapidMX policy are all treated as "not a federated peer", exactly mirroring
 * `checkDomainVerification()`'s own never-throws contract in `util/DomainVerificationUtils.ts`.
 *
 * A DNS name can carry more than one TXT record; every record returned is checked and the first one that
 * parses as a valid `RMXv1` policy wins, so an unrelated TXT record coincidentally present at the same name
 * doesn't prevent a real policy record from being found.
 */
export async function resolveFederationPolicy(
    dnsResolver: DnsResolver,
    domain: string,
    options: ResolveFederationPolicyOptions = {},
): Promise<FederationPolicy | undefined> {
    const normalizedDomain: string = domain.toLowerCase();
    const cacheKey: string = `${CACHE_KEY_PREFIX}${normalizedDomain}`;

    const cached: Record<string, any> | undefined = await policyCache.load(cacheKey);
    if (cached) {
        return cached.participating === false ? undefined : (cached as unknown as FederationPolicy);
    }

    let resolved: FederationPolicy | undefined;
    try {
        const records: string[][] = await dnsResolver.resolveTxt(`_rapidmx.${normalizedDomain}`);
        for (const chunks of records) {
            const parsed: FederationPolicy | undefined = parsePolicyRecord(chunks.join(""));
            if (parsed) {
                resolved = parsed;
                break;
            }
        }
    } catch {
        resolved = undefined;
    }

    if (resolved) {
        await policyCache.save(cacheKey, resolved, options.positiveTtlSeconds ?? DEFAULT_TTL_SECONDS);
    } else {
        await policyCache.save(cacheKey, NOT_PARTICIPATING, options.negativeTtlSeconds ?? DEFAULT_TTL_SECONDS);
    }
    return resolved;
}
