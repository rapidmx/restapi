///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MemoryStore } from "@rapidrest/core";
import type { PublicKey } from "../models/types.js";
import { isSafeDiscoveryHost, parseKeyDiscoveryAddress, readBoundedBytes, resolvesToPublicAddresses } from "./KeyDiscoveryClient.js";
import { selectOpenPgpKeysFor } from "./OpenPgpKeyUtils.js";
import { computeWkdHash } from "./WkdUtils.js";

/** How long a found key, and a miss, are kept. */
const FOUND_TTL_SECONDS = 60 * 60;
const MISSING_TTL_SECONDS = 10 * 60;

/** The largest WKD answer read (a directory may concatenate a few certificates). */
const MAX_WKD_RESPONSE_BYTES = 128 * 1024;

const DEFAULT_TIMEOUT_MS = 10_000;

const wkdCache: MemoryStore = new MemoryStore();

export interface FetchWkdKeyOptions {
    timeoutMs?: number;
}

/** Forgets every cached WKD answer (tests). */
export function clearWkdCache(): void {
    wkdCache.clear();
}

/** The certificates a WKD `url` answers for `address` (`selectOpenPgpKeysFor()`), or none (an unsafe host, a failure, 404, nothing usable). */
async function fetchFrom(host: string, url: string, address: string, timeoutMs: number): Promise<PublicKey[]> {
    if (!isSafeDiscoveryHost(host) || !(await resolvesToPublicAddresses(host))) {
        return [];
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // As for RapidMX discovery: no redirects (a directory has no reason to send this request elsewhere), and a bounded read.
        const response = await fetch(url, { signal: controller.signal, redirect: "error" });
        if (!response.ok) {
            return [];
        }
        return await selectOpenPgpKeysFor(new Uint8Array(await readBoundedBytes(response, MAX_WKD_RESPONSE_BYTES)), address);
    } catch {
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Looks `address`'s OpenPGP certificates up in its domain's Web Key Directory (draft-koch-openpgp-webkey-service) - how this
 * server finds the key of a Proton Mail user, or of anyone else whose domain publishes one. The advanced method
 * (`https://openpgpkey.<domain>/.well-known/openpgpkey/<domain>/hu/<hash>?l=<local>`) is tried first and the direct method
 * (`https://<domain>/.well-known/openpgpkey/hu/<hash>?l=<local>`) when it yields no key that is `address`'s now. What both answer
 * is `OpenPgpKeyUtils.selectOpenPgpKeysFor()`'s: the certificate that is `address`'s now first, then any its holder revoked - the
 * revocation evidence a contact that pins one needs, since for an address outside RapidMX this is the one discovery channel. HTTPS
 * only, with the RapidMX discovery client's SSRF guards (`isSafeDiscoveryHost()`, public addresses only, no redirects, a bounded
 * read). Answers and misses are cached.
 *
 * Never throws; empty when there is nothing usable.
 */
export async function fetchWkdKeys(address: string, options: FetchWkdKeyOptions = {}): Promise<PublicKey[]> {
    const parsed = parseKeyDiscoveryAddress(address);
    if (!parsed) {
        return [];
    }
    const { localPart, domain } = parsed;
    const cacheKey = `wkd:${localPart.toLowerCase()}@${domain}`;
    const cached = wkdCache.load(cacheKey) as { keys: PublicKey[] } | undefined;
    if (cached) {
        return cached.keys;
    }
    const hash: string = computeWkdHash(localPart);
    const l: string = encodeURIComponent(localPart);
    const timeoutMs: number = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const advancedHost = `openpgpkey.${domain}`;
    const advanced: PublicKey[] = await fetchFrom(advancedHost, `https://${advancedHost}/.well-known/openpgpkey/${domain}/hu/${hash}?l=${l}`, address, timeoutMs);
    const keys: PublicKey[] = advanced.some((key) => key.revokedAt === undefined)
        ? advanced
        : [...(await fetchFrom(domain, `https://${domain}/.well-known/openpgpkey/hu/${hash}?l=${l}`, address, timeoutMs)), ...advanced];
    wkdCache.save(cacheKey, { keys }, keys.length > 0 ? FOUND_TTL_SECONDS : MISSING_TTL_SECONDS);
    return keys;
}
