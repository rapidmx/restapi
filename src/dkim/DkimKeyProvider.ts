///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** A DKIM selector plus the public-key half of its key pair - exactly the two pieces of information
 * `Domain.dkimSelector`/`Domain.dkimPublicKey` store (see `util/DnsSetupUtils.ts`'s `checkDkim()`), and
 * everything an admin console needs to render the `<selector>._domainkey.<domain>` TXT record. */
export interface DkimKeyPair {
    selector: string;
    /** Base64-encoded DER SubjectPublicKeyInfo - the exact value a DKIM TXT record's `p=` tag expects,
     * with no PEM header/footer/newlines. */
    publicKey: string;
}

/**
 * Generates and persists the DKIM signing key pair the deployment's MTA (Postfix/rspamd) uses to sign
 * outbound mail for a given domain, keeping `Domain.dkimSelector`/`Domain.dkimPublicKey` (and so the DNS
 * setup checklist's recommended TXT record) in sync with whatever key material actually gets signed with.
 *
 * A real, security-relevant choice a deployment makes knowingly, not a silent default - registering
 * `FsDkimKeyProvider` (or a custom implementation) crosses a boundary this library previously drew
 * deliberately (see the now-superseded doc comments on `Domain.dkimSelector`/`dkimPublicKey`, which said
 * this app would never generate or hold DKIM key material). `@Inject("DkimKeyProvider")` has no notion of
 * "nothing registered, skip it" - some class must always be registered under this token - so
 * `NullDkimKeyProvider` (always resolving `undefined`) is the default, preserving the original
 * admin-fills-it-in-by-hand model until a deployment deliberately opts into `FsDkimKeyProvider` instead.
 *
 * Kept behind an interface - like `DnsResolver`/`BlobStore`/`MailTransport` - so tests never touch the
 * real filesystem/key material, and so a deployment can swap in a different custody model (e.g. an HSM-
 * or KMS-backed implementation) without touching `BaseDomainRoute` itself.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface DkimKeyProvider {
    /**
     * Returns `domain`'s DKIM key pair, generating and persisting a new one first if none exists yet, or
     * `undefined` if this provider doesn't manage key material at all (see `NullDkimKeyProvider`, the
     * default registration - a deployment that wants the original manual model, where an admin fills in
     * `dkimSelector`/`dkimPublicKey` by hand, registers that instead of `FsDkimKeyProvider`). Idempotent
     * and safe to call on every `Domain` create/verify/dns-setup pass when it DOES manage key material - an
     * existing key pair is never regenerated or rotated by this call (a `Domain`'s DKIM key, once minted,
     * is stable for that domain's lifetime; rotation, if ever needed, is a deliberately separate,
     * not-yet-built operation).
     *
     * @param domain The verified domain name (`Domain.name`) to ensure a key pair for.
     */
    ensureKeyPair(domain: string): Promise<DkimKeyPair | undefined>;
}
