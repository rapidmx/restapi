///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import * as net from "net";
import { MemoryStore, SimpleStore } from "@rapidrest/core";
import { KeyDiscoveryResponse } from "../models/types.js";

/**
 * z-base32's alphabet (Zooko Wilcox-O'Hearn's human-oriented base32 variant) - the encoding
 * `specs/end-to-end_encryption.md`'s discovery-endpoint path segment uses, following WKD. Deliberately
 * hand-rolled rather than adding a dependency: the algorithm is ~15 lines and there is exactly one call
 * site's worth of use for it in this codebase.
 */
const ZBASE32_ALPHABET = "ybndrfg8ejkmcpqxot1uwisza345h769";

/**
 * Encodes `data` as z-base32 - 5 bits of input per output character, most-significant-bit first, no
 * padding character (a final partial group is padded with zero bits, not a literal `=`, since z-base32 has
 * no defined padding character).
 */
export function zBase32Encode(data: Buffer): string {
    let bitBuffer = 0;
    let bitCount = 0;
    let output = "";
    for (const byte of data) {
        bitBuffer = (bitBuffer << 8) | byte;
        bitCount += 8;
        while (bitCount >= 5) {
            output += ZBASE32_ALPHABET[(bitBuffer >>> (bitCount - 5)) & 0x1f];
            bitCount -= 5;
        }
    }
    if (bitCount > 0) {
        output += ZBASE32_ALPHABET[(bitBuffer << (5 - bitCount)) & 0x1f];
    }
    return output;
}

/**
 * Computes the discovery-endpoint path segment for `localPart` (the portion of an address before the `@`) -
 * `zbase32(sha256(lowercase(localPart)))`, per the spec's "Public Endpoint" section. Lowercasing first
 * means the same mailbox always hashes to the same path regardless of how a caller happened to capitalize
 * the address it was addressing.
 *
 * **Spec inconsistency, noted rather than silently resolved:** the spec's own worked example
 * (`bxzwhqjtnkr8yfp3mc6dsg91ae4v7unj`, 32 characters) is SHA-1-length (160 bits / 5 = 32 z-base32 characters
 * exactly), not SHA-256-length (256 bits would produce 52 characters) - real WKD, which this section says
 * it follows, does use SHA-1. This implementation follows the spec's explicit, twice-repeated prose and
 * formula (`zbase32(sha256(...))`, and Resolved Decision #3) over its example, on the theory that the
 * example is the stale artifact (likely copied from real WKD documentation and never regenerated after the
 * hash function was intentionally strengthened to SHA-256) rather than the repeated, explicit statements of
 * intent. Both sides of this protocol are implemented in this same codebase, so this is internally
 * consistent regardless of which was "meant" - but the spec document's example should be corrected to a
 * real SHA-256-based hash for any future implementer relying on it instead of the prose.
 */
export function computeKeyDiscoveryHash(localPart: string): string {
    const digest: Buffer = crypto.createHash("sha256").update(localPart.toLowerCase()).digest();
    return zBase32Encode(digest);
}

/** One cached discovery response, alongside the `ETag` it was served with (if any) so a later request can
 * issue a conditional `If-None-Match` and treat a `304` as "still this". */
interface CachedKeyDiscoveryResult {
    response: KeyDiscoveryResponse;
    etag?: string;
}

/**
 * Per-user key-freshness cache - deliberately a separate `SimpleStore` instance from
 * `util/FederationUtils.ts`'s domain-policy `policyCache`, per the spec's explicit statement that "per-user
 * key freshness is handled at this layer, not by the DNS record" (i.e. the two caches serve different
 * invalidation semantics and must not be conflated into one). See `FederationUtils.ts`'s identical
 * module-level cache for the full rationale on why this is a plain `MemoryStore` rather than something
 * `@Inject`-ed.
 */
const keyCache: SimpleStore = new MemoryStore();

const CACHE_KEY_PREFIX = "key-discovery:";

/** Default cache lifetime (seconds) used only when a response carries no `Cache-Control: max-age` at all -
 * the spec requires the server to always set one, so this is a defensive fallback, not the normal path. */
const DEFAULT_TTL_SECONDS = 60 * 60;

/** Default HTTP request timeout (ms) for the discovery fetch itself. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Extracts the `max-age` directive (seconds) from a `Cache-Control` header value, if present and valid. */
function parseMaxAgeSeconds(cacheControl: string | null): number | undefined {
    if (!cacheControl) {
        return undefined;
    }
    const match: RegExpMatchArray | null = cacheControl.match(/max-age=(\d+)/i);
    // `\d+` guarantees a non-empty digit string, so `parseInt` can never return `NaN` here - no further
    // validation needed.
    return match ? parseInt(match[1], 10) : undefined;
}

export interface FetchRemoteKeysOptions {
    /** Request timeout in milliseconds. Default 10s. */
    timeoutMs?: number;
}

/** A syntactically valid DNS hostname label sequence - letters/digits/hyphens per label, joined by single
 * dots, no leading/trailing dot, no `/`, `?`, `#`, `@`, whitespace, or any other character that could turn
 * `host` into more than just an authority once interpolated into a URL. */
const HOSTNAME_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

/** Maximum bytes read from a discovery response body - a well-formed `KeyDiscoveryResponse` (a handful of
 * certificates plus preference metadata) is at most a few KB; this bounds a malicious/misbehaving peer's
 * ability to stream an unbounded body into this process's memory. */
const MAX_RESPONSE_BYTES = 1_000_000;

/**
 * Validates that `host` (the `host` attribute of a remote domain's `_rapidmx` TXT record - attacker-influenced,
 * since it comes from a DNS record the requesting server does not control) is safe to interpolate directly
 * into a fetch URL and connect to.
 *
 * Two things are enforced:
 * 1. **Syntax** - `host` must be nothing more than a bare hostname (optionally with `:port`). Without this, a
 * TXT value like `host=evil.com/admin/purge?x=` or `host=internal.corp:9200/_cluster/state#` lets the
 * record's author choose the request's path/port/query, not just its authority.
 * 2. **Not an IP literal** - the spec documents `host` as "Hostname of the RapidMX server serving the key
 * endpoint", never a bare address; rejecting an IP literal closes the most direct SSRF vector (a TXT
 * record pointing straight at `127.0.0.1` or a cloud metadata address like `169.254.169.254`).
 *
 * **Known residual gap, not silently glossed over**: this does not resolve DNS itself and inspect the
 * resulting address before connecting, so a syntactically valid public hostname whose own DNS record points
 * at a private/loopback address (classic DNS-rebinding SSRF) is not caught here - `fetch()` performs its own
 * resolution internally, and `DnsResolver` (this codebase's pluggable DNS abstraction) exposes no A/AAAA
 * lookup to check against before that happens. Closing that residual requires either extending `DnsResolver`
 * with an address-lookup method this function could pre-validate against, or a custom low-level connect hook
 * - both larger, separate changes from the syntax/redirect/IP-literal hardening this function and
 * `fetchRemoteKeys()`'s `redirect: "error"` provide today.
 */
function isSafeDiscoveryHost(host: string): boolean {
    const withoutPort: string = host.split(":")[0];
    if (net.isIP(withoutPort) !== 0) {
        return false;
    }
    return HOSTNAME_PATTERN.test(host);
}

/**
 * Reads `response`'s body as JSON, aborting once more than `maxBytes` have been read rather than buffering an
 * unbounded stream - `Response.json()`/`.text()` have no built-in size cap, so a malicious/misbehaving peer
 * could otherwise stream gigabytes into this process's heap in response to a single discovery lookup.
 */
async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) {
        // No streamable `.body` (every real `fetch()` Response has one - this only happens against a test
        // double that stubs `json()` directly without a real stream). Falls back to the ordinary, unbounded
        // parse rather than assuming a `.text()` method the double may not have either.
        return response.json();
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            total += value.byteLength;
            if (total > maxBytes) {
                throw new Error("Discovery response body exceeded the maximum allowed size.");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf-8"));
}

/**
 * Fetches `address`'s published keys/preference from `host`'s discovery endpoint
 * (`GET https://<host>/.well-known/rapidmx/keys/<hash>`), honoring `ETag`/`Cache-Control` per the spec.
 *
 * **TLS verification is handled entirely by Node's default `fetch()` behavior** - an `https://` URL is
 * rejected by the platform itself if the presented certificate doesn't chain to a trusted root or doesn't
 * cover `host`, with no additional code needed here. This satisfies the spec's "the requesting server MUST
 * verify that the TLS certificate presented by `host` is valid and covers `host`" requirement by
 * construction; the one thing a caller must never do is pass a custom `dispatcher`/agent that disables
 * certificate validation.
 *
 * Never throws. A network failure, timeout, unsafe `host`, or non-2xx/304 response falls back to the last
 * cached response for this address (if any, since a transient failure shouldn't erase an otherwise-valid
 * cached key), or `undefined` if nothing has ever been cached for it - the caller's own key-conflict/
 * anti-downgrade logic (Group E) is responsible for deciding what "no result" means for a stored `Contact`,
 * not this function.
 *
 * `host` is attacker-influenced (it comes from a remote domain's own `_rapidmx` TXT record) and is hardened
 * against being used as an SSRF primitive three ways: rejected outright if it isn't a bare, syntactically
 * valid hostname (`isSafeDiscoveryHost()` - see its own doc comment, including the residual gap it does NOT
 * close); fetched with `redirect: "error"` rather than the default `"follow"`, so a TLS-valid domain can't
 * 302 the request to an internal target over a different protocol/host - a legitimate discovery server has no
 * reason to redirect this request at all; and read via `readBoundedJson()` rather than `response.json()`, so
 * a misbehaving/malicious peer can't stream an unbounded body into this process.
 */
export async function fetchRemoteKeys(
    host: string,
    address: string,
    options: FetchRemoteKeysOptions = {},
): Promise<KeyDiscoveryResponse | undefined> {
    const localPart: string = address.split("@")[0];
    const hash: string = computeKeyDiscoveryHash(localPart);
    const cacheKey: string = `${CACHE_KEY_PREFIX}${host.toLowerCase()}:${hash}`;
    const cached: CachedKeyDiscoveryResult | undefined = (await keyCache.load(cacheKey)) as CachedKeyDiscoveryResult | undefined;

    if (!isSafeDiscoveryHost(host)) {
        return cached?.response;
    }

    const headers: Record<string, string> = {};
    if (cached?.etag) {
        headers["If-None-Match"] = cached.etag;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
        const response = await fetch(`https://${host}/.well-known/rapidmx/keys/${hash}`, {
            headers,
            signal: controller.signal,
            redirect: "error",
        });

        if (response.status === 304 && cached) {
            const refreshedTtl: number | undefined = parseMaxAgeSeconds(response.headers.get("cache-control"));
            if (refreshedTtl !== undefined) {
                await keyCache.save(cacheKey, cached, refreshedTtl);
            }
            return cached.response;
        }
        if (!response.ok) {
            return cached?.response;
        }

        const body: KeyDiscoveryResponse = (await readBoundedJson(response, MAX_RESPONSE_BYTES)) as KeyDiscoveryResponse;
        const etag: string | undefined = response.headers.get("etag") ?? undefined;
        const ttl: number = parseMaxAgeSeconds(response.headers.get("cache-control")) ?? DEFAULT_TTL_SECONDS;
        await keyCache.save(cacheKey, { response: body, etag }, ttl);
        return body;
    } catch {
        return cached?.response;
    } finally {
        clearTimeout(timeoutHandle);
    }
}
