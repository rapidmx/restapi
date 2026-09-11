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
        return pinned.issuer === fresh.issuer;
    } catch {
        return false;
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

    for (const discoveredKey of discovered.keys) {
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
