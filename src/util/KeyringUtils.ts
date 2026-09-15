///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { resolveFederationPolicy } from "./FederationUtils.js";
import { fetchRemoteKeys, parseKeyDiscoveryAddress, parseKeyDiscoveryResponse } from "./KeyDiscoveryClient.js";
import { Contact, EncryptionPreference, KeyDiscoveryResponse, PublicKey } from "../models/types.js";

/** The subset of `Contact` this module reads/writes - callers pass exactly this shape whether the caller has
 * a real `Contact` in hand or is synthesizing one for an address never seen before. */
export type ContactKeyState = Pick<Contact, "keys" | "encryptPreference" | "keysFirstSeen" | "keyConflict">;

/** The fields `applyDiscoveredKeys()`/`discoverAndMergeKeys()` compute - a caller persists these onto the
 * `Contact` it's tracking (creating one first if this is the first time the address has ever been seen). */
export type KeyringUpdate = Pick<Contact, "keys" | "encryptPreference" | "keysFirstSeen" | "keyConflict">;

/** Bounds how many keys one `KeyDiscoveryResponse` can contribute to a single merge - `applyDiscoveredKeys()`
 * only ever pins at most one key per `useType` ("sign"/"encrypt") regardless of how many entries a response
 * contains (see the loop below), so this exists purely to bound processing cost against a hostile/misbehaving
 * peer's oversized response, not to cap stored state (which the useType-indexed merge already bounds to 2). */
const MAX_DISCOVERED_KEYS = 8;

/**
 * Validates and normalizes one `PublicKey` from an already structurally-validated `KeyDiscoveryResponse`
 * (`parseKeyDiscoveryResponse()`) before `applyDiscoveredKeys()` ever considers pinning it - applied uniformly
 * regardless of whether the response came from a live Discovery fetch (`util/KeyDiscoveryClient.ts`'s
 * `fetchRemoteKeys()`, an untrusted remote peer's own JSON) or a parsed `RapidMX-Key` header
 * (`util/RapidMxKeyHeaderUtils.ts`, which already does this same recomputation itself - redoing it here is
 * deliberate defense in depth).
 *
 * Every certificate-derived field is taken from the parsed certificate itself, never trusted as asserted:
 * - `fingerprint` - the one field the entire TOFU trust model turns on (`specs/end-to-end_encryption.md`:
 * "Used for TOFU pinning and out-of-band verification"). A peer serving an attacker's certificate paired with
 * the real certificate's fingerprint would otherwise defeat out-of-band verification outright.
 * - `notBefore`/`notAfter` - a peer-asserted `notAfter` far in the future would otherwise keep an expired
 * certificate looking valid (or a near-zero one make a valid pinned key look expired).
 *
 * Returns `undefined` (dropped, never pinned) for anything that doesn't parse as a real X.509 certificate. Also used by
 * `POST /:id/keys/trust` (`util/SignerCertificateUtils.ts`), which pins a client-supplied certificate the same way.
 */
export function sanitizeDiscoveredKey(key: PublicKey): PublicKey | undefined {
    try {
        const cert = new crypto.X509Certificate(Buffer.from(key.publicKey, "base64"));
        const notBefore: number = new Date(cert.validFrom).getTime();
        const notAfter: number = new Date(cert.validTo).getTime();
        if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
            return undefined;
        }
        return { ...key, fingerprint: cert.fingerprint256.replace(/:/g, "").toLowerCase(), notBefore, notAfter };
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
 * - **Validation**: `discovered` is re-run through `parseKeyDiscoveryResponse()` - a structurally malformed response is treated exactly like no response at all (the Anti-Downgrade no-op below), never partially applied.
 * - **TOFU pinning**: the first key ever observed for a given `useType` (encrypt/sign) is pinned immediately, with no conflict recorded.
 * - **Key Conflict Handling**: a key observed for a `useType` that already has a *different* fingerprint pinned is always retained as-is (never silently replaced) and recorded in the returned `keyConflict`, even when the pinned key is expired/revoked. The spec allows an unprompted replacement only when "the new certificate is signed by the same issuing CA as the pinned certificate", which can only be proven by verifying the new certificate's signature against that CA's public key - and a `PublicKey` carries only the leaf certificate, never its issuer's, so that proof is never available here. Issuer-DN equality (the previous heuristic) is peer-asserted text, not proof, so it no longer auto-replaces; the user resolves the conflict explicitly instead.
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
    const validated: KeyDiscoveryResponse | undefined = discovered === undefined ? undefined : parseKeyDiscoveryResponse(discovered);
    if (!validated) {
        // Anti-Downgrade: no (or no well-formed) discoverable key at all must never touch what's already pinned.
        return { keys: existingKeys, encryptPreference: existing?.encryptPreference, keysFirstSeen: existing?.keysFirstSeen, keyConflict: existing?.keyConflict };
    }

    const resultKeys: PublicKey[] = [...existingKeys];
    let conflict: Contact["keyConflict"] = existing?.keyConflict;
    let firstPinnedNow = false;

    const sanitizedKeys: PublicKey[] = validated.keys
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
        if (resultKeys[pinnedIndex].fingerprint === discoveredKey.fingerprint) {
            continue;
        }
        conflict = { observedFingerprint: discoveredKey.fingerprint, observedAt, source };
    }

    const existingLastSeen: number = existing?.encryptPreference?.lastSeen ?? -Infinity;
    const discoveredLastSeen: number = validated.encryptPreference.lastSeen ?? -Infinity;
    const preferenceIsNewer: boolean = !existing?.encryptPreference || discoveredLastSeen > existingLastSeen;
    const encryptPreference: EncryptionPreference = preferenceIsNewer ? validated.encryptPreference : existing!.encryptPreference!;

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
    // The same parser `fetchRemoteKeys()` uses, so the policy is resolved for exactly the domain keys are fetched for
    // (e.g. `a@evil.example@victim.example` is rejected rather than split differently by each step).
    const parsed = parseKeyDiscoveryAddress(address);
    if (!parsed) {
        return undefined;
    }
    const policy = await resolveFederationPolicy(dnsResolver, parsed.domain);
    if (!policy) {
        return undefined;
    }
    const discovered = await fetchRemoteKeys(policy.host, address);
    if (!discovered) {
        return undefined;
    }
    return applyDiscoveredKeys(existing, discovered, observedAt, "discovery");
}
