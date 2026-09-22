///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `@peculiar/x509` requires a `reflect-metadata` polyfill loaded before it is imported (see
// `pki/LocalX509CertificateAuthority.ts`).
import "reflect-metadata";
import * as crypto from "crypto";
import * as x509 from "@peculiar/x509";
import type { DnsResolver } from "../dns/DnsResolver.js";
import { resolveFederationPolicy } from "./FederationUtils.js";
import { fetchRemoteKeys, parseKeyDiscoveryAddress, parseKeyDiscoveryResponse } from "./KeyDiscoveryClient.js";
import { discoverLocalKeys, type LocalKeyDiscovery } from "./LocalKeyDiscoveryUtils.js";
import { parseContactKey } from "./SignerCertificateUtils.js";
import { Contact, EncryptionPreference, KeyConflict, KeyDiscoveryResponse, PreviousKey, PublicKey, RejectedKey } from "../models/types.js";

/** The subset of `Contact` this module reads/writes - callers pass exactly this shape whether the caller has
 * a real `Contact` in hand or is synthesizing one for an address never seen before. */
export type ContactKeyState = Pick<Contact, "keys" | "encryptPreference" | "keysFirstSeen" | "keyConflicts" | "previousKeys" | "rejectedKeys">;

/** The fields `applyDiscoveredKeys()`/`discoverAndMergeKeys()` compute - a caller persists these onto the
 * `Contact` it's tracking (creating one first if this is the first time the address has ever been seen). */
export type KeyringUpdate = ContactKeyState;

/** Bounds how many keys one `KeyDiscoveryResponse` can contribute to a single merge - `applyDiscoveredKeys()`
 * only ever pins at most one key per `useType` ("sign"/"encrypt") regardless of how many entries a response
 * contains (see the loop below), so this exists purely to bound processing cost against a hostile/misbehaving
 * peer's oversized response, not to cap stored state (which the useType-indexed merge already bounds to 2). */
const MAX_DISCOVERED_KEYS = 8;

/** How many replaced keys `Contact.previousKeys` keeps per `useType`. */
export const MAX_PREVIOUS_KEYS_PER_USE_TYPE = 5;

/** How many rejected keys `Contact.rejectedKeys` keeps. */
export const MAX_REJECTED_KEYS = 10;

type UseType = PublicKey["useType"];

function isUseType(value: unknown): value is UseType {
    return value === "sign" || value === "encrypt";
}

function isObject(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
 * `revocationReason` is kept only when it's `"superseded"` or `"compromised"` on a key that has `revokedAt`; anything
 * else is dropped (a revoked key without a reason counts as compromised).
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
        const { revocationReason, ...rest } = key;
        const sanitized: PublicKey = { ...rest, fingerprint: cert.fingerprint256.replace(/:/g, "").toLowerCase(), notBefore, notAfter };
        if (key.revokedAt !== undefined && (revocationReason === "superseded" || revocationReason === "compromised")) {
            sanitized.revocationReason = revocationReason;
        }
        return sanitized;
    } catch {
        return undefined;
    }
}

/**
 * `Contact.keyConflicts` as stored, keeping only well-formed entries (a `useType`, an `observedKey` of that `useType`
 * with a certificate and fingerprint, a finite `observedAt` and a known `source`), at most one per `useType` (the latest
 * `observedAt`). This is also the read-time migration of the former single `Contact.keyConflict` (a fingerprint without
 * the observed key): it isn't a model field any more, so it never reaches here and is dropped, and an entry shaped like
 * it inside the array is dropped too. Neither can be accepted, and the pinned key is unchanged, so the next observation
 * of the differing key records a complete conflict.
 */
export function normalizeKeyConflicts(conflicts: unknown): KeyConflict[] {
    const byUseType = new Map<UseType, KeyConflict>();
    for (const conflict of Array.isArray(conflicts) ? conflicts : []) {
        const observedKey: unknown = conflict?.observedKey;
        if (
            !isObject(conflict) ||
            !isUseType(conflict.useType) ||
            !isObject(observedKey) ||
            observedKey.useType !== conflict.useType ||
            typeof observedKey.publicKey !== "string" ||
            typeof observedKey.fingerprint !== "string" ||
            typeof conflict.observedAt !== "number" ||
            !Number.isFinite(conflict.observedAt) ||
            (conflict.source !== "header" && conflict.source !== "discovery")
        ) {
            continue;
        }
        const current: KeyConflict | undefined = byUseType.get(conflict.useType);
        if (!current || conflict.observedAt >= current.observedAt) {
            byUseType.set(conflict.useType, conflict as KeyConflict);
        }
    }
    return [...byUseType.values()];
}

/** `previousKeys` with `replaced` added first (replacing an entry of the same `useType` and fingerprint), bounded to
 * `MAX_PREVIOUS_KEYS_PER_USE_TYPE` per `useType`. */
export function addPreviousKey(previousKeys: PreviousKey[] | undefined, replaced: PreviousKey): PreviousKey[] {
    const result: PreviousKey[] = [replaced];
    const counts: Record<UseType, number> = { sign: 0, encrypt: 0 };
    counts[replaced.useType] = 1;
    for (const key of previousKeys ?? []) {
        if (key.useType === replaced.useType && key.fingerprint === replaced.fingerprint) {
            continue;
        }
        if (counts[key.useType] < MAX_PREVIOUS_KEYS_PER_USE_TYPE) {
            counts[key.useType]++;
            result.push(key);
        }
    }
    return result;
}

/** `rejectedKeys` with `rejected` added first (replacing an entry of the same `useType` and fingerprint), bounded to
 * `MAX_REJECTED_KEYS`. */
export function addRejectedKey(rejectedKeys: RejectedKey[] | undefined, rejected: RejectedKey): RejectedKey[] {
    const others: RejectedKey[] = (rejectedKeys ?? []).filter((key) => key.useType !== rejected.useType || key.fingerprint !== rejected.fingerprint);
    return [rejected, ...others].slice(0, MAX_REJECTED_KEYS);
}

/** `list` without entries of `useType` and `fingerprint`. */
export function withoutKey<T extends { useType: UseType; fingerprint: string }>(list: T[] | undefined, useType: UseType, fingerprint: string): T[] {
    return (list ?? []).filter((key) => key.useType !== useType || key.fingerprint !== fingerprint);
}

/** A list field to write: the new list when it has entries, `[]` when it's empty but the stored field had a value (so the
 * write clears it - an `undefined` would leave the stored value in place on SQL), otherwise `undefined`. */
export function listField<T>(next: T[], stored: T[] | undefined): T[] | undefined {
    return next.length > 0 || stored !== undefined ? next : undefined;
}

/** Whether `issuer` issued `leaf`: the leaf's issuer name equals the issuer's subject, OpenSSL's `checkIssued()` agrees
 * (name, key identifiers, and `keyCertSign` when the issuer has a keyUsage extension), and the leaf's signature verifies
 * with the issuer's public key - the same proof `util/CertificateInstallUtils.ts` requires before publishing one. */
function issuedBy(leaf: crypto.X509Certificate, issuer: crypto.X509Certificate): boolean {
    return leaf.issuer === issuer.subject && leaf.checkIssued(issuer) && leaf.verify(issuer.publicKey);
}

/**
 * Whether `observed` may replace `pinned` without prompting (`specs/end-to-end_encryption.md`'s Key Conflict Handling:
 * "signed by the same issuing CA as the pinned certificate and the pinned certificate is expired or revoked"). All of:
 *
 * - (a) `observed.issuerCertificate` parses as a CA-capable certificate (a basicConstraints extension, when present,
 * has `cA` true), and issued `observed` (`issuedBy()`).
 * - (b) That same certificate issued `pinned`, so both come from one issuing CA key.
 * - (c) `pinned` is expired at `observedAt`, or revoked (`revokedAt`). `applyDiscoveredKeys()` first copies a revocation
 * the same response lists for the pinned key onto it (`escalateRevocation()`). Either revocation reason counts
 * (`"superseded"` for a routine rotation, `"compromised"` or none otherwise).
 * - (d) `observed` is valid at `observedAt`, names `address`, and its usage fits its `useType`
 * (`SignerCertificateUtils.parseContactKey()`).
 *
 * Never throws: anything that doesn't parse is simply not proof.
 */
export function canReplaceAutomatically(pinned: PublicKey, observed: PublicKey, address: string, observedAt: number): boolean {
    if (!observed.issuerCertificate) {
        return false;
    }
    try {
        // Every parse below throws on malformed input, and `parseContactKey()` throws for (d); all of it is "no proof".
        const issuerDer: Buffer = Buffer.from(observed.issuerCertificate, "base64");
        const issuer = new crypto.X509Certificate(issuerDer);
        // basicConstraints decoded by `@peculiar/x509`, so a malformed extension is refused too.
        const basicConstraints: x509.BasicConstraintsExtension | null = new x509.X509Certificate(new Uint8Array(issuerDer)).getExtension(
            x509.BasicConstraintsExtension,
        );
        const observedCert = new crypto.X509Certificate(Buffer.from(observed.publicKey, "base64"));
        const pinnedCert = new crypto.X509Certificate(Buffer.from(pinned.publicKey, "base64"));
        if ((basicConstraints && !basicConstraints.ca) || !issuedBy(observedCert, issuer) || !issuedBy(pinnedCert, issuer)) {
            return false;
        }
        const pinnedExpired: boolean = observedAt > new Date(pinnedCert.validTo).getTime();
        if (!pinnedExpired && pinned.revokedAt === undefined) {
            return false;
        }
        parseContactKey(observed.publicKey, address, observed.useType, observedAt);
        return true;
    } catch {
        return false;
    }
}

/** How strongly `key` is revoked: 0 not revoked, 1 superseded, 2 compromised (a `revokedAt` without a reason counts as
 * compromised). */
function revocationSeverity(key: PublicKey): number {
    if (key.revokedAt === undefined) {
        return 0;
    }
    return key.revocationReason === "superseded" ? 1 : 2;
}

/**
 * `key` with the revocation an authenticated response listed for it (`listed`, same `useType` and fingerprint), when that
 * revocation is stronger than the stored one: an unrevoked key takes any listed revocation, a superseded one takes a
 * compromised one. A listing never weakens a stored revocation (compromised back to superseded, or revoked back to not).
 */
export function escalateRevocation<K extends PublicKey>(key: K, listed: PublicKey | undefined): K {
    if (!listed || revocationSeverity(listed) <= revocationSeverity(key)) {
        return key;
    }
    const { revocationReason: _stored, ...rest } = key;
    return { ...rest, revokedAt: listed.revokedAt, ...(listed.revocationReason ? { revocationReason: listed.revocationReason } : {}) } as K;
}

/**
 * Merges a freshly discovered `KeyDiscoveryResponse` into `existing`'s key state, implementing
 * `specs/end-to-end_encryption.md`'s Trust Model (TOFU), Key Conflict Handling, and Anti-Downgrade rules in
 * one place so both Discovery-driven callers (`GET /keys/lookup`, rotation refreshes) and inbound-header-driven callers
 * (`RapidMX-Key` processing) apply identical logic regardless of which authenticated source
 * (`"discovery"` vs `"header"`) triggered it.
 *
 * - **Validation**: `discovered` is re-run through `parseKeyDiscoveryResponse()` - a structurally malformed response is treated exactly like no response at all (the Anti-Downgrade no-op below), never partially applied. Each key goes through `sanitizeDiscoveredKey()`.
 * - **Revocation evidence**: a listed key with `revokedAt` is never pinned or recorded as a conflict. When it matches a pinned or previous key (same `useType` and fingerprint), that key takes its `revokedAt`/`revocationReason` if they're stronger than the stored ones (`escalateRevocation()`), which also feeds the automatic replacement below. A non-revoked key already in `previousKeys` for its `useType` is ignored (it was replaced before).
 * - **TOFU pinning**: the first key ever observed for a given `useType` (encrypt/sign) is pinned immediately, with no conflict recorded.
 * - **Automatic replacement**: a different key for a `useType` that has one pinned replaces it when `canReplaceAutomatically()` holds (same issuing CA, proven with the published `issuerCertificate`; pinned key expired or revoked; new key valid for the address). The old key moves to `previousKeys` (`replacement: "automatic"`, keeping its `revokedAt`/`revocationReason`) and the `useType`'s conflict is cleared.
 * - **Key Conflict Handling**: otherwise the pinned key is retained and the observed key is recorded in `keyConflicts` (one per `useType`, the latest observation replacing an earlier one), unless the user rejected that fingerprint (`rejectedKeys`).
 * - **Anti-Downgrade**: a `discovered` of `undefined` (no key header, or Discovery found nothing) makes this function a no-op on `keys`/`encryptPreference` - the caller still decides separately whether to stamp `Contact.lastMessageSeen`. Keys are never removed. A present `discovered.encryptPreference` only replaces the stored one when its `lastSeen` is strictly newer than what's on file, per the spec's explicit anti-downgrade rule for preference updates.
 *
 * `keyConflicts` in the result is always normalized (`normalizeKeyConflicts()`), which drops a legacy conflict.
 *
 * @param existing The contact's current key state, or `undefined` for an address never seen before.
 * @param discovered The just-fetched discovery response, or `undefined` if no header/Discovery result exists
 * for this observation at all.
 * @param observedAt UTC timestamp (epoch ms) this observation occurred - usually `Date.now()`, exposed as a
 * parameter so tests (and any future replay/backfill tooling) can pin it.
 * @param source Whether this observation came from the in-band `RapidMX-Key` header or a live Discovery call.
 * @param address The contact's address, which a key replacing a pinned one automatically must name.
 */
export function applyDiscoveredKeys(
    existing: ContactKeyState | undefined,
    discovered: KeyDiscoveryResponse | undefined,
    observedAt: number,
    source: "header" | "discovery",
    address: string,
): KeyringUpdate {
    const storedConflicts: KeyConflict[] = normalizeKeyConflicts(existing?.keyConflicts);
    const unchanged: KeyringUpdate = {
        keys: existing?.keys ?? [],
        encryptPreference: existing?.encryptPreference,
        keysFirstSeen: existing?.keysFirstSeen,
        keyConflicts: listField(storedConflicts, existing?.keyConflicts),
        previousKeys: existing?.previousKeys,
        rejectedKeys: existing?.rejectedKeys,
    };
    const validated: KeyDiscoveryResponse | undefined = discovered === undefined ? undefined : parseKeyDiscoveryResponse(discovered);
    if (!validated) {
        // Anti-Downgrade: no (or no well-formed) discoverable key at all must never touch what's already pinned.
        return unchanged;
    }

    const sanitizedKeys: PublicKey[] = validated.keys
        .slice(0, MAX_DISCOVERED_KEYS)
        .map(sanitizeDiscoveredKey)
        .filter((k): k is PublicKey => k !== undefined);
    const listedRevocations = new Map<string, PublicKey>(
        sanitizedKeys.filter((k) => k.revokedAt !== undefined).map((k) => [`${k.useType}:${k.fingerprint}`, k]),
    );
    const listedRevocation = (key: PublicKey): PublicKey | undefined => listedRevocations.get(`${key.useType}:${key.fingerprint}`);

    // Revocations the response lists for keys already on file (pinned or previous) are recorded first.
    const resultKeys: PublicKey[] = unchanged.keys!.map((k) => escalateRevocation(k, listedRevocation(k)));
    let previousKeys: PreviousKey[] | undefined = existing?.previousKeys?.map((k) => escalateRevocation(k, listedRevocation(k)));
    let conflicts: KeyConflict[] = storedConflicts;
    let firstPinnedNow = false;

    for (const discoveredKey of sanitizedKeys) {
        const { useType, fingerprint } = discoveredKey;
        if (discoveredKey.revokedAt !== undefined || previousKeys?.some((k) => k.useType === useType && k.fingerprint === fingerprint)) {
            continue;
        }
        const pinnedIndex: number = resultKeys.findIndex((k) => k.useType === useType);
        if (pinnedIndex === -1) {
            resultKeys.push(discoveredKey);
            firstPinnedNow = true;
            continue;
        }
        const pinned: PublicKey = resultKeys[pinnedIndex];
        if (pinned.fingerprint === fingerprint) {
            continue;
        }
        if (canReplaceAutomatically(pinned, discoveredKey, address, observedAt)) {
            resultKeys[pinnedIndex] = discoveredKey;
            previousKeys = addPreviousKey(previousKeys, {
                ...pinned,
                replacedAt: observedAt,
                replacement: "automatic",
            });
            conflicts = conflicts.filter((c) => c.useType !== useType);
            continue;
        }
        if (existing?.rejectedKeys?.some((k) => k.useType === useType && k.fingerprint === fingerprint)) {
            continue;
        }
        conflicts = [...conflicts.filter((c) => c.useType !== useType), { useType, observedKey: discoveredKey, observedAt, source }];
    }

    const existingLastSeen: number = existing?.encryptPreference?.lastSeen ?? -Infinity;
    const discoveredLastSeen: number = validated.encryptPreference.lastSeen ?? -Infinity;
    const preferenceIsNewer: boolean = !existing?.encryptPreference || discoveredLastSeen > existingLastSeen;
    const encryptPreference: EncryptionPreference = preferenceIsNewer ? validated.encryptPreference : existing!.encryptPreference!;

    return {
        keys: resultKeys,
        encryptPreference,
        keysFirstSeen: existing?.keysFirstSeen ?? (firstPinnedNow ? observedAt : undefined),
        keyConflicts: listField(conflicts, existing?.keyConflicts),
        previousKeys,
        rejectedKeys: existing?.rejectedKeys,
    };
}

/**
 * Server-side Discovery (`specs/end-to-end_encryption.md`'s "Discovery is Server-Side" section): finds `address`'s
 * published keys and merges them into `existing` via `applyDiscoveredKeys()`.
 *
 * An address that lives on THIS deployment (`local`, see `discoverLocalKeys()`) is answered from its own mailbox - the
 * same `KeyDiscoveryResponse` the public endpoint serves, with no DNS lookup and no HTTP request. Anything else resolves
 * `address`'s domain federation policy (`util/FederationUtils.ts`) and fetches that peer's discovery endpoint
 * (`util/KeyDiscoveryClient.ts`).
 *
 * Returns `undefined` - not a "no-op" `KeyringUpdate` - when there is nothing to merge: the domain isn't a federated peer
 * at all (no `_rapidmx` record), the fetch failed with nothing cached, or the address is of this deployment's own domain
 * but no mailbox has it. A caller can thereby distinguish "nothing to update" from "this address isn't running
 * RapidMX", which `GET /keys/lookup` (Group E2) surfaces differently (e.g. a `404`) than "found the peer, no conflict".
 *
 * @param source `"discovery"` for `GET /keys/lookup` (Group E2); `"header"` callers (Group E3) call
 * `applyDiscoveredKeys()` directly instead, since they already have a `KeyDiscoveryResponse`-shaped payload
 * from the `RapidMX-Key` header rather than needing this function's own DNS/HTTP lookup.
 * @param local How to reach this deployment's own mailboxes. Omitted, every address is resolved through federation.
 */
export async function discoverAndMergeKeys(
    dnsResolver: DnsResolver,
    address: string,
    existing: ContactKeyState | undefined,
    observedAt: number = Date.now(),
    local?: LocalKeyDiscovery,
): Promise<KeyringUpdate | undefined> {
    if (local) {
        const found = await discoverLocalKeys(local, address);
        if (found) {
            // The mailbox's primary address is what its certificates name, whichever alias or plus-tagged form was asked for.
            return found.response ? applyDiscoveredKeys(existing, found.response, observedAt, "discovery", found.address) : undefined;
        }
    }
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
    return applyDiscoveredKeys(existing, discovered, observedAt, "discovery", address);
}
