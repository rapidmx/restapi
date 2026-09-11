///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { resolveFederationPolicy } from "./FederationUtils.js";
import { fetchRemoteKeys } from "./KeyDiscoveryClient.js";
import { Contact, EncryptionPreference, KeyDiscoveryResponse, PublicKey } from "../models/types.js";

/** The subset of `Contact` this module reads/writes - callers pass exactly this shape whether the caller has
 * a real `Contact` in hand or is synthesizing one for an address never seen before. */
export type ContactKeyState = Pick<Contact, "keys" | "encryptPreference" | "keysFirstSeen" | "keyConflict">;

/** The fields `applyDiscoveredKeys()`/`discoverAndMergeKeys()` compute - a caller persists these onto the
 * `Contact` it's tracking (creating one first if this is the first time the address has ever been seen). */
export type KeyringUpdate = Pick<Contact, "keys" | "encryptPreference" | "keysFirstSeen" | "keyConflict">;

/**
 * Reports whether `pinnedCertDer`/`newCertDer` (base64-encoded DER X.509 certificates - `PublicKey.publicKey`'s
 * own format) share the same issuer, per the Key Conflict Handling rule that a key may be replaced without
 * prompting only when "the new certificate is signed by the same issuing CA as the pinned certificate".
 *
 * **Deliberately an issuer-DN comparison, not full cryptographic chain verification**: the actual issuing CA
 * certificate for an arbitrary federated peer's key is not something this server has on hand to verify
 * against (unlike `LocalX509CertificateAuthority.issue()`'s own leaf certs, verified directly against a CA
 * this server itself controls) - issuer-DN equality is the same heuristic this class of check reduces to in
 * practice without a full PKIX path-building implementation, and is treated here as a permissive fast-path,
 * never as a security boundary: the safe default when this returns `false` (or either certificate fails to
 * parse) is always to record a conflict and require explicit user action, never to silently trust a key.
 */
function sameIssuingCa(pinnedCertDer: string, newCertDer: string): boolean {
    try {
        const pinned = new crypto.X509Certificate(Buffer.from(pinnedCertDer, "base64"));
        const fresh = new crypto.X509Certificate(Buffer.from(newCertDer, "base64"));
        // A self-signed certificate's `issuer` field is just an attacker-chosen string in a certificate the
        // attacker minted themselves - equal to a pinned certificate's own `issuer` proves nothing. Reject
        // that case cryptographically (not by comparing `issuer`/`subject` strings, which is the same class
        // of naive check being replaced here) via `checkIssued()` - Node's binding to OpenSSL's
        // `X509_check_issued`, which for `cert.checkIssued(cert)` is `true` only when the certificate
        // genuinely, verifiably signed itself. This is the concrete attack this function exists to stop: wait
        // for (or induce) the pinned key to expire, mint a self-signed replacement with a copied `issuer` DN,
        // and get silently substituted with no conflict recorded.
        if (fresh.checkIssued(fresh) || pinned.checkIssued(pinned)) {
            return false;
        }
        return pinned.issuer === fresh.issuer;
    } catch {
        return false;
    }
}

/** Bounds how many keys one `KeyDiscoveryResponse` can contribute to a single merge - `applyDiscoveredKeys()`
 * only ever pins at most one key per `useType` ("sign"/"encrypt") regardless of how many entries a response
 * contains (see the loop below), so this exists purely to bound processing cost against a hostile/misbehaving
 * peer's oversized response, not to cap stored state (which the useType-indexed merge already bounds to 2). */
const MAX_DISCOVERED_KEYS = 8;

/** Generous upper bound, in characters, for a base64-encoded DER certificate - a real P-256 certificate is a
 * few hundred bytes (~700 base64 characters); this is wide enough for an RSA-4096 certificate with a large
 * extension set and small enough to block a deliberately oversized blob. */
const MAX_PUBLIC_KEY_BASE64_LENGTH = 8192;

/**
 * Validates and normalizes one `PublicKey` from a `KeyDiscoveryResponse` before `applyDiscoveredKeys()` ever
 * considers pinning it - applied uniformly regardless of whether the response came from a live Discovery
 * fetch (`util/KeyDiscoveryClient.ts`'s `fetchRemoteKeys()`, an untrusted remote peer's own JSON) or a parsed
 * `RapidMX-Key` header (`util/RapidMxKeyHeaderUtils.ts`, which already does this same recomputation itself -
 * redoing it here is deliberate defense in depth for the one call path, Discovery, that didn't).
 *
 * `fingerprint` is always recomputed from the certificate itself, never trusted as asserted - it's the one
 * field the entire TOFU trust model turns on (`specs/end-to-end_encryption.md`: "Used for TOFU pinning and
 * out-of-band verification"). A peer that serves an attacker's certificate paired with the real certificate's
 * fingerprint would otherwise defeat out-of-band verification outright: the user reads out a fingerprint that
 * matches what they were told to expect, while the key actually pinned and used to encrypt is a different one.
 *
 * Returns `undefined` (dropped, never pinned) for anything that doesn't parse as a real X.509 certificate,
 * whose `useType` isn't `"sign"`/`"encrypt"`, or whose `notBefore`/`notAfter` aren't finite numbers.
 */
function sanitizeDiscoveredKey(key: PublicKey): PublicKey | undefined {
    if (key.useType !== "sign" && key.useType !== "encrypt") {
        return undefined;
    }
    if (typeof key.publicKey !== "string" || key.publicKey.length === 0 || key.publicKey.length > MAX_PUBLIC_KEY_BASE64_LENGTH) {
        return undefined;
    }
    if (!Number.isFinite(key.notBefore) || !Number.isFinite(key.notAfter)) {
        return undefined;
    }
    try {
        const cert = new crypto.X509Certificate(Buffer.from(key.publicKey, "base64"));
        return { ...key, fingerprint: cert.fingerprint256.replace(/:/g, "").toLowerCase() };
    } catch {
        return undefined;
    }
}

/**
 * Merges a freshly discovered `KeyDiscoveryResponse` into `existing`'s key state, implementing
 * `specs/end-to-end_encryption.md`'s Trust Model (TOFU), Key Conflict Handling, and Anti-Downgrade rules in
 * one place so both Discovery-driven callers (`GET /keys/lookup`, Group E2) and inbound-header-driven callers
 * (`RapidMX-Key` processing, Group E3) apply identical logic regardless of which authenticated source
 * (`"discovery"` vs `"header"`) triggered it.
 *
 * - **TOFU pinning**: the first key ever observed for a given `useType` (encrypt/sign) is pinned immediately, with no conflict recorded.
 * - **Key Conflict Handling**: a key observed for a `useType` that already has a *different* fingerprint pinned is retained as-is (never silently replaced) and recorded in the returned `keyConflict`, UNLESS the pinned key is already expired/revoked AND the new one shares its issuer (`sameIssuingCa()`) - the one case the spec allows replacing without prompting.
 * - **Anti-Downgrade**: a `discovered` of `undefined` (no key header, or Discovery found nothing) makes this function a no-op on `keys`/`encryptPreference` - the caller still decides separately whether to stamp `Contact.lastMessageSeen` (a `"message observed"` concept `KeyringUtils` itself has no opinion on; Group E2's proactive lookup has no message to have observed, only Group E3's inbound processing does). A present `discovered.encryptPreference` only replaces the stored one when its `lastSeen` is strictly newer than what's on file, per the spec's explicit anti-downgrade rule for preference updates.
 *
 * @param existing The contact's current key state, or `undefined` for an address never seen before.
 * @param discovered The just-fetched discovery response, or `undefined` if no header/Discovery result exists
 * for this observation at all.
 * @param observedAt UTC timestamp (epoch ms) this observation occurred - usually `Date.now()`, exposed as a
 * parameter so tests (and any future replay/backfill tooling) can pin it.
 * @param source Whether this observation came from the in-band `RapidMX-Key` header or a live Discovery call.
 */
export function applyDiscoveredKeys(
    existing: ContactKeyState | undefined,
    discovered: KeyDiscoveryResponse | undefined,
    observedAt: number,
    source: "header" | "discovery",
): KeyringUpdate {
    const existingKeys: PublicKey[] = existing?.keys ?? [];
    if (!discovered) {
        // Anti-Downgrade: no discoverable key at all must never touch what's already pinned.
        return { keys: existingKeys, encryptPreference: existing?.encryptPreference, keysFirstSeen: existing?.keysFirstSeen, keyConflict: existing?.keyConflict };
    }

    const resultKeys: PublicKey[] = [...existingKeys];
    let conflict: Contact["keyConflict"] = existing?.keyConflict;
    let firstPinnedNow = false;

    const sanitizedKeys: PublicKey[] = (discovered.keys ?? [])
        .slice(0, MAX_DISCOVERED_KEYS)
        .map(sanitizeDiscoveredKey)
        .filter((k): k is PublicKey => k !== undefined);

    for (const discoveredKey of sanitizedKeys) {
        const pinnedIndex: number = resultKeys.findIndex((k) => k.useType === discoveredKey.useType);
        if (pinnedIndex === -1) {
            resultKeys.push(discoveredKey);
            firstPinnedNow = true;
            continue;
        }
        const pinned: PublicKey = resultKeys[pinnedIndex];
        if (pinned.fingerprint === discoveredKey.fingerprint) {
            continue;
        }
        const pinnedExpiredOrRevoked: boolean = !!pinned.revokedAt || pinned.notAfter <= observedAt;
        if (pinnedExpiredOrRevoked && sameIssuingCa(pinned.publicKey, discoveredKey.publicKey)) {
            resultKeys[pinnedIndex] = discoveredKey;
            continue;
        }
        conflict = { observedFingerprint: discoveredKey.fingerprint, observedAt, source };
    }

    const existingLastSeen: number = existing?.encryptPreference?.lastSeen ?? -Infinity;
    const discoveredLastSeen: number = discovered.encryptPreference.lastSeen ?? -Infinity;
    const preferenceIsNewer: boolean = !existing?.encryptPreference || discoveredLastSeen > existingLastSeen;
    const encryptPreference: EncryptionPreference = preferenceIsNewer ? discovered.encryptPreference : existing!.encryptPreference!;

    return {
        keys: resultKeys,
        encryptPreference,
        keysFirstSeen: existing?.keysFirstSeen ?? (firstPinnedNow ? observedAt : undefined),
        keyConflict: conflict,
    };
}

/**
 * Server-side Discovery (`specs/end-to-end_encryption.md`'s "Discovery is Server-Side" section): resolves
 * `address`'s domain federation policy (`util/FederationUtils.ts`), fetches its discovery endpoint
 * (`util/KeyDiscoveryClient.ts`), and merges the result into `existing` via `applyDiscoveredKeys()`.
 *
 * Returns `undefined` - not a "no-op" `KeyringUpdate` - when the domain isn't a federated peer at all (no
 * `_rapidmx` record) or the fetch failed with nothing cached, so a caller can distinguish "nothing to update"
 * from "this address isn't running RapidMX", which `GET /keys/lookup` (Group E2) surfaces differently (e.g. a
 * `404`) than "found the peer, no conflict".
 *
 * @param source `"discovery"` for `GET /keys/lookup` (Group E2); `"header"` callers (Group E3) call
 * `applyDiscoveredKeys()` directly instead, since they already have a `KeyDiscoveryResponse`-shaped payload
 * from the `RapidMX-Key` header rather than needing this function's own DNS/HTTP lookup.
 */
export async function discoverAndMergeKeys(
    dnsResolver: DnsResolver,
    address: string,
    existing: ContactKeyState | undefined,
    observedAt: number = Date.now(),
): Promise<KeyringUpdate | undefined> {
    const domain: string | undefined = address.split("@")[1];
    if (!domain) {
        return undefined;
    }
    const policy = await resolveFederationPolicy(dnsResolver, domain);
    if (!policy) {
        return undefined;
    }
    const discovered = await fetchRemoteKeys(policy.host, address);
    if (!discovered) {
        return undefined;
    }
    return applyDiscoveredKeys(existing, discovered, observedAt, "discovery");
}
