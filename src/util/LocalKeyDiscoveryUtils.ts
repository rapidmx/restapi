///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ModelUtils, type RepoUtils } from "@rapidrest/service-core";
import type { EncryptionPreference, KeyDiscoveryResponse, KeyVault, Mailbox, PublicKey } from "../models/types.js";
import { normalizeAddress, stripPlusTag } from "./AddressUtils.js";
import { parseKeyDiscoveryAddress } from "./KeyDiscoveryClient.js";

/** The all-defaults response served for a mailbox that either doesn't exist, or exists but has published
 * nothing - `specs/end-to-end_encryption.md` requires these to be byte-for-byte indistinguishable, since the public
 * endpoint is otherwise a directory-harvesting oracle. Reuses `Mailbox.encryptPreference`/`Mailbox.keys`'s own
 * class-level defaults, so a real mailbox that has simply never enrolled a key produces this exact object with no
 * special-casing - the "indistinguishable" property falls out of the data model rather than being maintained by hand. */
export const NOT_PUBLISHED_RESPONSE: KeyDiscoveryResponse = {
    encryptPreference: { preferEncrypt: "nopreference" },
    keys: [],
    escrow: false,
};

/**
 * The `KeyDiscoveryResponse` for `mailbox` (`undefined` for an address that has none) - THE one definition of what a
 * mailbox of this deployment publishes: `BaseKeyDiscoveryRoute` serves it to remote peers, and `discoverLocalKeys()`
 * feeds it to `GET /mailbox/:id/keys/lookup` for a local recipient, so the two can never drift.
 *
 * `escrow` is whether the mailbox's own `KeyVault` (read server-side with `ignoreACL: true`; nothing else from it is ever
 * returned) holds any `MasterKeyWrap` with `method: "escrow"`.
 *
 * Always performs exactly one `KeyVault` lookup, even when there is no mailbox (a `mailboxUid` no real mailbox can have),
 * so the not-found and no-keys-published cases cost the same number of round trips - the timing side channel the public
 * endpoint's "Timing" note closes.
 */
export async function buildKeyDiscoveryResponse(keyVaultRepo: RepoUtils<any>, mailbox: Mailbox | undefined): Promise<KeyDiscoveryResponse> {
    const vaults: KeyVault[] = await keyVaultRepo.find({ mailboxUid: mailbox?.uid ?? "" } as any, {
        ignoreACL: true,
        limit: 1,
    });
    if (!mailbox) {
        return NOT_PUBLISHED_RESPONSE;
    }
    const escrow: boolean = !!vaults[0]?.masterKeyWraps.some((w) => w.method === "escrow");
    return { encryptPreference: mailbox.encryptPreference ?? NOT_PUBLISHED_RESPONSE.encryptPreference, keys: mailbox.keys ?? [], escrow };
}

/** What `discoverLocalKeys()` needs from its caller - the concrete (Mongo/SQL) repos and query shapes. */
export interface LocalKeyDiscovery {
    mailboxRepo: RepoUtils<any>;
    keyVaultRepo: RepoUtils<any>;
    /** The names of this deployment's own domains (`DomainUtils.getVerifiedDomainNames()`). */
    domainNames: () => Promise<string[]>;
    /** The query value matching one element of `aliasAddresses` (`BaseMailIngestRoute.aliasQueryValue()`'s Mongo/SQL split). */
    aliasQueryValue: (address: string) => any;
    /** Whether `user+tag@domain` delivers to `user@domain` (`mail:plus_addressing:enabled`), so it is looked up as it. */
    plusAddressing: boolean;
}

/** The answer of `discoverLocalKeys()` for an address that lives on this deployment. */
export interface LocalKeys {
    /** The address the keys belong to: the mailbox's primary address, which its certificates name (an alias or a
     * plus-tagged address is only another way to reach that mailbox), or the normalized address when there is none. */
    address: string;
    /** What the mailbox publishes, or `undefined` for an address of this deployment's own domain that no mailbox has. */
    response?: KeyDiscoveryResponse;
}

/** The mailbox with exactly this (normalized) primary address or alias, the way inbound delivery resolves a recipient
 * (`BaseMailIngestRoute.findMailboxByAddress()`): exact primary, then exact alias, then - when `address` has a `+tag` and
 * plus-addressing is on - the same two exact matches against the untagged address. */
async function findMailbox(local: LocalKeyDiscovery, address: string): Promise<Mailbox | undefined> {
    const exact = async (candidate: string): Promise<Mailbox | undefined> =>
        (await local.mailboxRepo.find({ primarySmtpAddress: ModelUtils.literal(candidate), limit: 1 } as any, { ignoreACL: true, limit: 1 }))[0] ??
        (await local.mailboxRepo.find({ aliasAddresses: local.aliasQueryValue(candidate), limit: 1 } as any, { ignoreACL: true, limit: 1 }))[0];
    const untagged: string = stripPlusTag(address);
    return (await exact(address)) ?? (local.plusAddressing && untagged !== address ? await exact(untagged) : undefined);
}

/**
 * Discovers the keys of `address` when it lives on THIS deployment - before, and instead of, any DNS or HTTP: the mailbox
 * is right here, and a deployment whose own domain publishes no `_rapidmx` record (nothing needs it to) must still be
 * able to encrypt between its own accounts.
 *
 * `address` is local when it is a mailbox's primary address or alias (case-insensitively, plus-tags resolved as delivery
 * does), or an address of one of this deployment's own domains (then `response` is `undefined`: this deployment is the
 * only authority for those domains, so there is nothing to ask anyone else). Returns `undefined` for an address that is
 * neither, which the caller resolves through federation as before.
 */
export async function discoverLocalKeys(local: LocalKeyDiscovery, address: string): Promise<LocalKeys | undefined> {
    const parsed = parseKeyDiscoveryAddress(address);
    if (!parsed) {
        return undefined;
    }
    const normalized: string = normalizeAddress(`${parsed.localPart}@${parsed.domain}`);
    const mailbox: Mailbox | undefined = await findMailbox(local, normalized);
    if (mailbox) {
        return { address: normalizeAddress(mailbox.primarySmtpAddress), response: await buildKeyDiscoveryResponse(local.keyVaultRepo, mailbox) };
    }
    return (await local.domainNames()).includes(parsed.domain) ? { address: normalized } : undefined;
}
