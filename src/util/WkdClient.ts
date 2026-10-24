///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MemoryStore } from "@rapidrest/core";
import type { PublicKey } from "../models/types.js";
import { isSafeDiscoveryHost, parseKeyDiscoveryAddress, readBoundedBytes, resolvesToPublicAddresses } from "./KeyDiscoveryClient.js";
import { selectOpenPgpKeyFor } from "./OpenPgpKeyUtils.js";
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

/** The certificate a WKD `url` answers for `address`, or `undefined` (an unsafe host, a failure, 404, nothing usable). */
async function fetchFrom(host: string, url: string, address: string, timeoutMs: number): Promise<PublicKey | undefined> {
    if (!isSafeDiscoveryHost(host) || !(await resolvesToPublicAddresses(host))) {
        return undefined;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        // As for RapidMX discovery: no redirects (a directory has no reason to send this request elsewhere), and a bounded read.
        const response = await fetch(url, { signal: controller.signal, redirect: "error" });
        if (!response.ok) {
            return undefined;
        }
        return await selectOpenPgpKeyFor(new Uint8Array(await readBoundedBytes(response, MAX_WKD_RESPONSE_BYTES)), address);
    } catch {
        return undefined;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Looks `address`'s OpenPGP certificate up in its domain's Web Key Directory (draft-koch-openpgp-webkey-service) - how this
 * server finds the key of a Proton Mail user, or of anyone else whose domain publishes one. The advanced method
 * (`https://openpgpkey.<domain>/.well-known/openpgpkey/<domain>/hu/<hash>?l=<local>`) is tried first and the direct method
 * (`https://<domain>/.well-known/openpgpkey/hu/<hash>?l=<local>`) when it yields nothing. The answer must hold a certificate
 * that is `address`'s now (`OpenPgpKeyUtils.selectOpenPgpKeyFor()`). HTTPS only, with the RapidMX discovery client's SSRF
 * guards (`isSafeDiscoveryHost()`, public addresses only, no redirects, a bounded read). Found keys and misses are cached.
 *
 * Never throws; `undefined` when there is no usable key.
 */
export async function fetchWkdKey(address: string, options: FetchWkdKeyOptions = {}): Promise<PublicKey | undefined> {
    const parsed = parseKeyDiscoveryAddress(address);
    if (!parsed) {
        return undefined;
    }
    const { localPart, domain } = parsed;
    const cacheKey = `wkd:${localPart.toLowerCase()}@${domain}`;
    const cached = wkdCache.load(cacheKey) as { key?: PublicKey } | undefined;
    if (cached) {
        return cached.key;
    }
    const hash: string = computeWkdHash(localPart);
    const l: string = encodeURIComponent(localPart);
    const timeoutMs: number = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const advancedHost = `openpgpkey.${domain}`;
    const key: PublicKey | undefined =
        (await fetchFrom(advancedHost, `https://${advancedHost}/.well-known/openpgpkey/${domain}/hu/${hash}?l=${l}`, address, timeoutMs)) ??
        (await fetchFrom(domain, `https://${domain}/.well-known/openpgpkey/hu/${hash}?l=${l}`, address, timeoutMs));
    wkdCache.save(cacheKey, key ? { key } : {}, key ? FOUND_TTL_SECONDS : MISSING_TTL_SECONDS);
    return key;
}
