# RapidMX: End-to-End Encryption

The purpose of this document is to lay out a technical plan for implementing the following two major new features to RapidMX.

1. Digital Signatures (DS)
2. End-to-End Encryption (E2E)

## Overview

The goal is for RapidMX to be the first mail system to offer true end-to-end encryption built-in with a _near zero_ frictionless experience. To achieve this goal RapidMX will do the following:

1. Generate signing and encryption keypairs on the client's device on first sign-in
2. The client will sign every composed message by default
3. Private keys are securely stored on the RapidMX server, encrypted on the client device using a secret only the user knows
4. Allow discovery of public keys and encryption preferences via the unauthenticated `GET /.well-known/rapidmx/keys/:hash` endpoint
5. Automatically attach a user's public encryption key and preference to every outgoing e-mail (Autocrypt-style header)

### Message Format

RapidMX MUST use **S/MIME (CMS)** as the on-the-wire message format for both signatures and encryption.

This is a deliberate choice over OpenPGP. S/MIME is natively supported by Outlook for Windows, Outlook mobile, Apple Mail and Exchange ActiveSync; OpenPGP requires a COM add-in in Outlook, which the new Outlook for Windows does not support at all, and has no implementation on Outlook mobile. Because RapidMX commits to supporting existing clients, encrypted mail MUST remain readable by them.

All key material described in this document is therefore X.509.

**Certificate issuance is two-tier:**

- **Encryption certificates** are issued by the RapidMX server's internal CA. Trust between RapidMX servers is anchored in the domain (DNSSEC and TLS on the discovery endpoint), not in a public root, so a public CA adds nothing.
- **Signing certificates** MUST be enrolled against a publicly trusted CA by default. A signature from an internal CA displays to external recipients as _unverified_ rather than _verified_, which is worse than not signing at all. Administrators MAY disable public enrolment for closed deployments.

Public enrolment MUST be automated. RFC 8823 defines an ACME `email-reply-00` challenge for S/MIME issuance, and the CA/Browser Forum S/MIME Baseline Requirements permit it as a mailbox-control validation method. Certificate lifetimes are capped at 825 days under those requirements and are shortening, so unattended reissue is a launch requirement, not a later feature.

> **Non-goal:** forward secrecy. Ratcheting protocols (MLS, Signal) derive their strength from deleting old keys, which is incompatible with a mailbox users expect to keep and search for a decade.

### Scoping Principle

RapidMX features fall into two categories, and they MUST NOT share a scope.

- **Protective capabilities** reduce what third parties can learn. They disclose nothing and impose nothing on the recipient. These MUST be scoped as widely as possible — to any capable peer.
- **Disclosing capabilities** reveal something about a user to another party. These MUST be scoped to the administrative boundary, because users outside that boundary never agreed to the originating organisation's norms.

| Capability                                               | Category   | Scope             |
| -------------------------------------------------------- | ---------- | ----------------- |
| Signing, encryption, key discovery                       | Protective | Federated peer    |
| Delivery / read receipt requests                         | Disclosing | Same-organisation |
| Free/busy, presence, directory search, typing indicators | Disclosing | Same-organisation |

New features MUST be classified under this principle before a default scope is chosen.

#### Terminology

These two terms are distinct and MUST NOT be used interchangeably. Earlier drafts used "internal" for both, which is ambiguous.

- **Same-organisation** — the specific RapidMX server and the domains it controls. A single administrative boundary, one policy, one administrator.
- **Federated peer** — any remote domain that publishes a valid `_rapidmx` TXT record and serves a valid key endpoint. A different organisation with different administrators and different norms.
- **External** — everything else.

## Technical Design

The features of `Digital Signatures` (DS) and `End-to-End Encryption` (E2E) are optional for all RapidMX servers. The server MUST provide system-wide settings giving administrators control over both features.

### Encryption Policy States

Encryption policy MUST be expressed as **three** states, configurable independently per recipient tier (§Scoping Principle):

| State        | Meaning                                                                         |
| ------------ | ------------------------------------------------------------------------------- |
| `automatic`  | Encrypt by default where both parties advertise `mutual`.                       |
| `optional`   | Not applied automatically. A user MAY encrypt a specific message or invitation. |
| `prohibited` | Users cannot encrypt. Attempts are blocked with an explanation.                 |

**Two states are not sufficient**, and conflating `optional` with `prohibited` fails in both directions.

An organisation that does not want routine internal encryption still has legitimate cases requiring it — privileged communication between counsel and a client, HR investigations, board material. Under a two-state setting labelled "internal encryption: off," those become impossible. Conversely, an organisation with supervisory review obligations, where correspondence must remain reviewable, genuinely needs `prohibited` and would be misled by a setting that merely defaults it off.

The default for same-organisation traffic SHOULD be `optional`, not `prohibited`. The administrative UI MUST make the distinction between the two unmistakable rather than expressing it in a tooltip.

When policy is `prohibited` for a tier, the client MUST explain why encryption is unavailable rather than silently omitting the control.

### Keypair Generation & Storage

When the user first signs in to their RapidMX mailbox, the client MUST create two new X.509 keypairs automatically. The first keypair MUST be used for digitally signing outgoing messages. The second keypair MUST be used for encrypting message contents. The public keys MUST be stored on the server for discovery by other parties. The private keys MUST be encrypted on the client device and then uploaded to the RapidMX server.

Keypairs MUST default to ECC (P-256), not RSA. A P-256 certificate is approximately 510 bytes DER against 907 bytes for RSA-2048, which roughly halves the size of the Autocrypt-style header carried on every outgoing message.

The two keypairs MUST have different lifecycles:

|             | Signing key                               | Encryption key                                      |
| ----------- | ----------------------------------------- | --------------------------------------------------- |
| Escrow      | MUST NOT be escrowed                      | MUST be escrowed                                    |
| Rotation    | Rotates on schedule                       | Long-lived                                          |
| On rotation | Old private key destroyed                 | Old private key retained indefinitely               |
| Rationale   | A copy elsewhere destroys non-repudiation | Discarding it makes old mail permanently unreadable |

When a user logs in to their account, the private keys MUST be downloaded from the server, decrypted, and stored locally on the device in a secure location. When the user explicitly logs out on the device, the private keys MUST be destroyed until the next log in attempt.

Private keys MUST NOT be destroyed on access-token expiry. Token expiry is routine and destroying keys on expiry would force a re-unlock prompt many times a day. Keys MUST be destroyed on explicit logout, on session revocation, and SHOULD be destroyed after a configurable idle period.

#### Master Key Wrapping

Private keys MUST be encrypted before they are sent to the server for storage. The client accomplishes this using two layers of encryption, so that changing an unlock method re-wraps 32 bytes rather than re-encrypting all key material:

1. Generate a random 32-byte **master key** (MK) using a CSPRNG.
2. Encrypt each private key with MK using an AEAD cipher.
3. Encrypt MK separately with a key derived from **each** enabled unlock method.
4. Send the encrypted private keys and each wrapped copy of MK to the server.

```
MK = random 32 bytes                       <- never leaves the client unwrapped
     |
     +-- AEAD encrypts --> signing private key      -+
     +-- AEAD encrypts --> encryption private key   -+--> stored on server

MK is wrapped once per unlock method:
     wrap_password  = AEAD(HKDF(Argon2id(password, salt), "wrap"), MK)
     wrap_passkey_N = AEAD(HKDF(WebAuthn-PRF(credential_N, salt)),  MK)
     wrap_recovery  = AEAD(HKDF(recovery_code, salt),               MK)
     wrap_escrow    = AEAD(escrow scope public key,                MK)   [OPTIONAL]
```

The server stores the wrapped blobs, salts and KDF parameters. Every one of them is opaque to the server.

**Permitted unlock methods:**

- **Password.** The client MUST derive a single Argon2id output and split it with HKDF into two independent values: an authentication proof sent to the server, and a wrapping key that never leaves the device. The plaintext password MUST NOT be transmitted.
- **Passkey.** The client MUST use the WebAuthn **PRF extension** to obtain a stable per-credential secret. The WebAuthn credential private key itself is non-extractable and cannot be used directly. Each registered device SHOULD register its own passkey and receive its own wrap of the same MK.
- **Recovery codes.** A set of high-entropy single-use codes generated client-side and displayed to the user once, at enrolment.

**TOTP MUST NOT be used as an unlock method.** The server necessarily stores the TOTP shared secret in order to verify codes, so any key derived from it is derivable by the server. A 6-digit code additionally carries only ~20 bits of entropy.

**Escrow** MUST be optional and disabled by default. When enabled, a holder can unwrap MK and therefore decrypt the user's mail. Administrators enabling it MUST be shown this consequence explicitly, and the client MUST display escrow status to the user in account settings. A server with escrow enabled does not provide end-to-end encryption against the escrow holder, and the product MUST NOT claim otherwise.

Escrow MUST NOT be a single organisation-wide key held by whoever administers the server. See _Escrow Scoping_ below.

#### Escrow Scoping

The boundary for escrow access is the **eDiscovery and compliance role**, not server administration and not group membership as such.

**Separation of duties.** Holding an escrow key MUST be a distinct role from operating the server. A user with root on the host, or with the administrative role in RapidMX, MUST NOT thereby be able to decrypt mail. Escrow access is granted explicitly and independently.

The motivating failure is privileged communication. If counsel encrypts to protect attorney–client material and a single organisation-wide escrow key is held by IT, counsel is protected against outsiders but not against the party they may most need protection from — in an internal investigation, IT may report to the people being investigated.

**Escrow scopes.** A deployment MAY define multiple escrow scopes, each covering a set of mailboxes and each with its own key and its own role holders. A mailbox belongs to at most one scope.

```
scope: default        key: K1   holders: Compliance Officer
scope: legal          key: K2   holders: General Counsel
scope: executive      key: K3   holders: Board Secretary  (dual control)
scope: none           —         no escrow; recovery by user codes only
```

A scope MAY be configured with no escrow at all, accepting that mail in that scope is unrecoverable if the user loses every unlock method. This is the correct configuration for some legal and journalistic contexts and MUST be available.

**Dual control.** A scope MAY require M-of-N holders to act together. Where configured, no single holder can decrypt.

**Matter scoping.** Escrow access SHOULD be exercised against a defined matter — a named investigation or legal hold with an explicit custodian list and date range — rather than as blanket decryption authority. Access outside a matter's custodians or date range MUST be a separate, separately authorised act.

**Audit.** Every escrow use MUST be recorded in a tamper-evident log capturing the holder, the matter, the mailboxes and date range accessed, and the time. The log MUST NOT be suppressible or editable by escrow holders or by server administrators.

**Subject notification** MUST be configurable per scope. Notifying the mailbox owner is often legally prohibited during an investigation or litigation hold, so it cannot be mandatory — but the audit record persists regardless of whether notification occurs.

**Membership and rotation.** Moving a mailbox between scopes, or rotating a scope key, requires re-wrapping MK for the affected mailboxes. This is a background operation and MUST NOT require the user to be online, since the wrap operates on MK's ciphertext under a public key.

**Implementation requirements:**

- All wrapping MUST use an AEAD construction (AES-256-GCM or XChaCha20-Poly1305), so tampering is detected rather than yielding garbage plaintext.
- KDF parameters and a scheme version MUST be stored alongside each wrap, so costs can be raised over time without breaking existing accounts.
- The user ID and the wrap purpose MUST be bound as additional authenticated data, preventing a blob from being replayed against another account.
- Removing a wrap prevents future unlocks by that method but does not revoke access for anyone who captured the blob and holds the secret. **True revocation** requires generating a fresh MK, re-encrypting the private keys, and re-wrapping for all remaining methods. The client MUST perform full re-keying on device removal, not merely delete the wrap.

#### Data Model

```ts
/**
 * Describes a cryptographic public key used to sign or encrypt messages between parties.
 * This type MUST NOT ever carry private key material.
 */
export interface PublicKey {
    /** The base64 encoded public key (DER-encoded X.509 certificate). */
    publicKey: string;
    /** The key's type and format (e.g. `x509`). */
    type: string;
    /** The purpose type that this key will be used for. */
    useType: "sign" | "encrypt";
    /** SHA-256 fingerprint of the certificate, hex encoded. Used for TOFU pinning and out-of-band verification. */
    fingerprint: string;
    /** UTC timestamp at which this key becomes valid. */
    notBefore: number;
    /** UTC timestamp at which this key expires. */
    notAfter: number;
    /** UTC timestamp at which this key was revoked, if applicable. */
    revokedAt?: number;
}

/**
 * A private key encrypted under the mailbox master key (MK).
 * Only ever returned from authenticated endpoints.
 */
export interface WrappedPrivateKey {
    /** AEAD ciphertext of the private key, base64 encoded. */
    ciphertext: string;
    /** Base64 encoded AEAD nonce. */
    nonce: string;
    /** AEAD algorithm identifier (e.g. `AES-256-GCM`). */
    algorithm: string;
    /** Fingerprint of the corresponding PublicKey. */
    fingerprint: string;
    /** The purpose type that this key will be used for. */
    useType: "sign" | "encrypt";
}

/**
 * One wrapped copy of the mailbox master key, per unlock method.
 */
export interface MasterKeyWrap {
    /** Unlock method used to derive the wrapping key. */
    method: "password" | "passkey" | "recovery" | "escrow";
    /** Opaque identifier for the method instance (e.g. WebAuthn credential ID). */
    methodId?: string;
    /** For method `escrow`: the escrow scope this wrap belongs to. Re-wrapped on scope change or key rotation. */
    escrowScopeId?: string;
    /** AEAD ciphertext of the master key, base64 encoded. */
    ciphertext: string;
    /** Base64 encoded AEAD nonce. */
    nonce: string;
    /** Base64 encoded KDF salt. */
    salt: string;
    /** KDF identifier and parameters (e.g. `argon2id:m=65536,t=3,p=4`). */
    kdf: string;
    /** Wrapping scheme version, so parameters can be upgraded over time. */
    schemeVersion: number;
    /** UTC timestamp of creation. */
    createdAt: number;
}

/**
 * Describes the encryption preferences of the user or Contact.
 */
export interface EncryptionPreference {
    /** The UTC timestamp of the most recent effective date that the last encryption preference was provided. */
    lastSeen?: number;
    /** The encryption preference of the user or contact to apply to outgoing messages. */
    preferEncrypt: "mutual" | "nopreference";
}

export interface Mailbox extends BaseEntity {
    /** The encryption preference of the mailbox. */
    encryptPreference: EncryptionPreference;
    /** Public keys associated with this mailbox. Safe to expose publicly. */
    keys: PublicKey[];
}

/**
 * Returned only from GET /mailbox/:id/keyvault (authenticated).
 * Deliberately a separate type from Mailbox so that private material
 * cannot be leaked by serialising a Mailbox.
 */
export interface KeyVault {
    wrappedKeys: WrappedPrivateKey[];
    masterKeyWraps: MasterKeyWrap[];
}
```

### Keyring

The server MUST store the signing public key, encryption public key and encryption preference of each third-party contact in that user's address book. Each time a new e-mail address is encountered (either through received mail or the user enters it into a draft message), the client MUST request Discovery for that third party.

The following new properties MUST be added to the `Contact` data model.

```ts
export interface Contact extends RecoverableBaseEntity {
    /** The known encryption preferences of the contact. */
    encryptPreference?: EncryptionPreference;
    /** The list of public keys that this contact has published. */
    keys?: PublicKey[];
    /** UTC timestamp at which the contact's keys were first observed (TOFU anchor). */
    keysFirstSeen?: number;
    /** UTC timestamp of the most recent message observed from this contact, with or without a key header. */
    lastMessageSeen?: number;
    /** Set when an observed key conflicts with the stored key. Blocks silent acceptance. */
    keyConflict?: {
        observedFingerprint: string;
        observedAt: number;
        source: "header" | "discovery";
    };
}
```

#### Trust Model

Key trust is **trust-on-first-use (TOFU)**. The first key observed for an address is pinned, and the guarantee thereafter is continuity — that this is the same correspondent as before — not verified identity.

The client MUST surface certificate fingerprints in the contact UI so users can verify out of band. The key store MUST be designed so that a transparency-log verification layer (see IETF KEYTRANS) can be added later without migrating users.

#### Key Conflict Handling

When an observed key for a contact differs from the stored key, the client MUST NOT silently accept the new key and MUST NOT silently reject the message. It MUST:

1. Retain the previously stored key.
2. Record the conflict in `Contact.keyConflict`.
3. Present the change to the user with both fingerprints and the date each was first seen.
4. Require explicit user action to replace the pinned key.

Key changes are routine (rotation, reinstall, new device) and are also exactly what an attack looks like. The distinction cannot be made automatically.

A key MUST be replaced without prompting only when the new certificate is signed by the same issuing CA as the pinned certificate **and** the pinned certificate is expired or revoked.

#### Anti-Downgrade

A message arriving **without** a key header or with no discoverable keys MUST NOT downgrade a stored `encryptPreference` or remove stored keys. The client MUST record `lastMessageSeen` but leave the preference intact.

This is the anti-stripping property. An active attacker who can remove headers in transit would otherwise be able to silently force both parties back to plaintext.

Preference updates MUST be applied only from messages whose effective date is newer than the stored `lastSeen`.

### Discovery

Discovery occurs when a message is received from an unknown third party, or when the user addresses a new message to a recipient.

Discovery, signing and encryption are **protective** capabilities under the Scoping Principle and are therefore scoped to any **federated peer** — every domain publishing a valid `_rapidmx` record, regardless of which organisation operates it. There is no same-organisation restriction on any part of this section.

#### Discovery is Server-Side

Discovery MUST be performed by the client's own RapidMX server, not by the client itself.

The client MUST call `GET /keys/lookup?addr=<addr>` on its own server. That server performs the DNS lookup, fetches the remote endpoint, validates it, caches the result, and returns the keys and preference.

This is a requirement, not an optimisation. Web clients cannot perform DNS TXT lookups — no browser API exists — and cross-origin requests to arbitrary third-party domains will be blocked by CORS. Server-side discovery also allows the cache to be shared across all users of the server.

Discovery MUST be performed lazily at **compose time**, not on message receipt. Fetching keys when a message arrives reveals to the sender's server exactly when the message was read, reproducing the behaviour of a tracking pixel.

#### Public Endpoint

The server MUST expose a publicly accessible endpoint `GET /.well-known/rapidmx/keys/:hash` where `:hash` identifies a mailbox on the server. The server MUST respond with a JSON formatted object containing the `EncryptionPreference` and list of `PublicKey`s.

**The local part MUST be hashed**, following WKD. The requesting server lowercases the local part, hashes it with SHA-256, and encodes the result with z-base32. Plaintext addresses MUST NOT appear in the request path.

This prevents an observer — and the serving domain's own access logs, CDN and TLS terminator — from accumulating a plaintext list of valid addresses. Hashing does not prevent a determined attacker from testing candidate addresses, which is why rate limiting and mutual TLS below remain required; it raises the cost of bulk harvesting and keeps addresses out of logs.

```ts
{
  encryptPreference: EncryptionPreference;
  keys: PublicKey[];
  /** Whether the serving domain holds an escrow key capable of decrypting this mailbox. */
  escrow: boolean;
}
```

**Escrow disclosure.** The `escrow` attribute MUST be present and MUST accurately reflect whether the mailbox belongs to an escrow scope with a key capable of decrypting it. Scope names and holder identities MUST NOT be disclosed — only whether escrow applies.

When composing to a recipient whose domain reports `escrow: true`, the client MUST display a **soft indicator** in the compose UI — passive, non-blocking, and not requiring dismissal. It MUST NOT interrupt the send by default.

The client MUST provide a user setting to escalate this to an explicit confirmation prompt before sending. The setting defaults to off.

The rationale for defaulting to passive: escrow is a normal configuration in regulated industries, and a blocking prompt on every message to such a domain would fire constantly and be dismissed reflexively, teaching users to ignore it. Users with a genuine need for the stronger signal can opt in.

This is an honesty signal, not a security control. It is self-reported and unverifiable — a dishonest operator can simply report `false`. Making it a MUST means omission or misreporting is a specification violation rather than a permitted choice, but clients MUST NOT present it as a guarantee.

In the event that the mailbox queried does not exist on the server, the server MUST return the following response:

```json
{
    "encryptPreference": {
        "preferEncrypt": "nopreference"
    },
    "keys": [],
    "escrow": false
}
```

The response for a non-existent mailbox MUST be indistinguishable in status code, body shape and response time from a mailbox that exists but has no keys published. This endpoint is otherwise a directory-harvesting oracle.

The server MUST rate-limit this endpoint per source IP and SHOULD support mutual TLS between RapidMX servers as a stronger alternative to unauthenticated access.

Responses MUST carry an `ETag` and a `Cache-Control: max-age` directive. Requesting servers MUST issue conditional requests with `If-None-Match` and honour `304 Not Modified`. Per-user key freshness is handled at this layer, **not** by the DNS record.

#### Domain Lookup

For the address `john.smith@domain.com`, the requesting server MUST:

1. Perform a DNS lookup for a `TXT` record at `_rapidmx.<domain>`:

```txt
TYPE    HOST                    VALUE
TXT     _rapidmx.domain.com     v=RMXv1; id=1; host=mail.domain.com;
```

| Attribute | Meaning                                                       |
| --------- | ------------------------------------------------------------- |
| `v`       | Policy version. `RMXv1`.                                      |
| `id`      | Opaque policy version token. Changes when the policy changes. |
| `host`    | Hostname of the RapidMX server serving the key endpoint.      |

2. Query the key endpoint at that host:

```http
GET /.well-known/rapidmx/keys/bxzwhqjtnkr8yfp3mc6dsg91ae4v7unj
Host: mail.domain.com
```

where the path segment is `zbase32(sha256("john.smith"))` and the domain is carried by the `Host` header.

The result MUST be stored in a new or existing `Contact` in the mailbox's address book, subject to the Key Conflict Handling rules above.

**The `id` attribute is a cache token, following MTA-STS.** Requesting servers MUST cache the resolved policy (the `host` value and any future policy attributes) and MUST NOT refetch it while `id` is unchanged. The DNS record MUST NOT change when an individual user's keys change; per-user freshness is handled by HTTP `ETag`. Changing the TXT record on every key rotation would make account provisioning wait on DNS propagation, invalidate every peer's cache for every user in the domain, and leak organisational churn to observers.

**Transport trust.** The requesting server MUST verify that the TLS certificate presented by `host` is valid and covers `host`. Requesting servers SHOULD validate DNSSEC on the TXT lookup where available. Without this, control of the delegated host is sufficient to impersonate every user in the domain.

**Negative caching.** A domain with no `_rapidmx` TXT record MUST be cached as non-participating for a configurable period (default 24 hours). Most correspondents will not run RapidMX and the common path must not incur a failed DNS lookup plus a failed HTTPS connection on every send.

#### In-Band Key Attachment

In addition to the discovery endpoint, every outgoing message MUST carry the sender's encryption certificate and preference in a header, following the Autocrypt pattern:

```
RapidMX-Key: addr=alice@example.com; prefer-encrypt=mutual;
 type=x509; keydata=MIIB9jCCAZ2gAwIBAgIU...
```

The **signing** certificate is not carried in this header. It is already present in the `certificates` field of the CMS `SignedData` structure on every signed message.

Processing rules:

- A message containing more than one `RapidMX-Key` header MUST have all of them ignored.
- The `addr` attribute MUST match the `From` address, or the header MUST be ignored.
- Only inbound messages are processed, keyed on the `From` address.
- Unknown attributes prefixed with `_` MUST be ignored. Unknown attributes without the prefix MUST invalidate the whole header. This permits forward-compatible extension.
- The header MUST be included in the sending server's DKIM `h=` tag and **oversigned** (listed twice), so that a header cannot be injected into a message that did not carry one. Receiving servers MUST verify DKIM before acting on the header and MUST treat an unverified header as absent.

The header is a hop-authenticated routing hint, not an end-to-end assertion. For RapidMX-to-RapidMX correspondence the discovery endpoint is authoritative, because it is authenticated by TLS and works before any message has been exchanged. The header exists to reach non-participating correspondents and to propagate rotations to active correspondents ahead of cache expiry.

#### Rotation Notification

Between federated peers, key rotation MAY additionally be pushed using the same RFC 8098 extension-field mechanism adopted for receipts. When a peer's key has rotated, an outgoing MDN MAY carry the sender's current key fingerprint and policy `id` as extension fields in the `message/disposition-notification` part.

This is a **cache invalidation hint only**. On receiving one, the peer MUST re-run Discovery against the authoritative endpoint. It MUST NOT install a key or update a preference from the notification itself.

The reason is trust asymmetry: MDN extension fields are hop-authenticated at best, whereas the discovery endpoint is authenticated by TLS. A push mechanism that installed keys directly would be a weaker path to the same outcome, and an attacker able to forge MDNs could force key changes. Treating it purely as an invalidation signal means a forged notification costs a wasted lookup and nothing more.

Push is an optimisation over `ETag` polling, not a replacement. Peers MUST continue to honour `Cache-Control` expiry independently.

### Digital Signatures

The client SHOULD digitally sign all mail composed from the user's device with the user's signing key. The client MUST provide a setting to the user allowing them to toggle message signing, which can be overridden by the system-wide policy.

Signatures MUST use detached `multipart/signed` with `application/pkcs7-signature`. Opaque signing (`application/pkcs7-mime; smime-type=signed-data`) MUST NOT be used for signature-only messages, because clients that do not understand S/MIME would render nothing at all.

The `micalg` parameter MUST match the digest algorithm actually used.

Signing MUST be the final step before submission. The signed content is byte-exact; any downstream process that normalises whitespace, re-wraps lines or re-encodes the body will invalidate the signature.

When a new message is received by the client that contains a digital signature, the client MUST validate it against the known public key in the `Contact`'s record. If no signing key exists for the `Contact`, the client MUST request Discovery to retrieve it. A mismatch MUST be handled under Key Conflict Handling.

**Mailing lists.** Any list that appends a footer will invalidate the signature, causing legitimate mail to display a tampering warning. The client SHOULD detect list traffic (via `List-Id` or `List-Unsubscribe`) and MAY suppress signing for those messages, subject to user preference.

#### Header Protection

Signed messages MUST use header protection as defined in **RFC 9788**, so that `From`, `To`, `Cc`, `Date`, `Subject` and `Message-ID` are covered by the signature.

Without this, a signed message still has a forgeable subject line and a forgeable display name, both of which recipient clients render trustingly. This is a genuine differentiator: most S/MIME deployments protect only the body.

RFC 9788 updates RFC 8551 specifically because the original §3.1 `message/rfc822` wrapping caused rendering and security problems in legacy clients. Implementations MUST follow RFC 9788's outer-header handling rules rather than the naive wrapping, so that clients unaware of header protection still render the message correctly.

When header protection is in use, the client MUST render the _protected_ header values, and MUST visually distinguish a message whose outer and protected headers disagree.

### Encryption

The client SHOULD encrypt an outgoing message to a recipient whose encryption preference is `mutual`. The client MUST provide a setting to the user allowing them to toggle sending of encrypted messages, regardless of the recipient's preference. This setting may be overridden by the system-wide preferences of the administrator.

Encryption MUST default to on only when **both** parties advertise `mutual`. A one-sided preference is an offer, not an imposition.

#### Encrypt to Self

Every encrypted message MUST additionally be encrypted to the sender's own encryption key. Without this the sender's stored copy in Sent is unreadable to the sender.

#### Multiple Recipients

CMS `EnvelopedData` encrypts the body once under a random content-encryption key, and encrypts that key separately per recipient. Adding a recipient after the fact is not possible without re-encrypting.

When a message has multiple recipients and only some have usable keys, the client MUST NOT split the message into an encrypted copy and a plaintext copy. It MUST present the user with the choice to send the entire message in plaintext, or to remove the recipients who cannot receive it.

#### Revocation

Key revocation MUST use the X.509 mechanisms already available: the issuing CA publishes a CRL and/or operates an OCSP responder. Clients MUST check revocation status before encrypting to a key. Revocation is therefore immediate and does not depend on any peer's cache expiring.

### Delivery and Read Receipts

Receipt **requests** are a disclosing capability and are scoped to **same-organisation** recipients. Receipt **responses** are never generated automatically for messages that did not originate from a RapidMX user on this server, so an inbound marketing message never produces a response.

#### Default Scope

| Recipient tier    | Automatic request attached |
| ----------------- | -------------------------- |
| Same-organisation | Yes                        |
| Federated peer    | No                         |
| External          | No                         |

Federated peers are deliberately excluded. A peer is a different organisation whose users have not agreed to this organisation's norms around read tracking, and the mutual-consent assumption that makes the messaging-app experience acceptable does not hold across an administrative boundary.

The user MUST be able to request a receipt on an individual message to any recipient. Administrators MUST be able to change the default per tier. When a request is attached, the compose UI MUST indicate it, so the user is aware that read tracking is being requested rather than having it applied invisibly.

#### Transport

All receipts, at every tier, use standard RFC 8098 MDN messages. RapidMX does not define a separate receipt channel.

RFC 8098 permits extension fields in the `message/disposition-notification` part. Between RapidMX peers, additional fields MAY be included to carry richer semantics than the base specification provides. Clients that do not recognise them ignore them, so the message remains fully compliant for every recipient.

Receipt responses MUST be stored as hidden messages, not delivered to the user's inbox. The client surfaces them as message state.

Receipt responses MUST NOT be generated automatically for any message that did not originate from a RapidMX user on this server.

#### Receipt Verification

An MDN is an ordinary message and can be forged by anyone. Before a receipt is stored or reflected in the UI, the server MUST verify all of the following, and MUST discard the receipt if any check fails:

1. **DKIM.** The MDN carries a valid DKIM signature from the responding domain.
2. **Alignment.** The signing domain aligns with the domain of the recipient the original message was addressed to.
3. **Correlation.** `Original-Message-ID` matches a message this server actually sent, from this user, to that recipient.
4. **Uniqueness.** No receipt of the same disposition type has already been recorded for that message and recipient, so a replayed MDN cannot alter stored state.

Without these checks the delivery and read indicators are attacker-controllable, and a forged MDN can assert that a message was read when it was not.

#### Header Integrity

`Disposition-Notification-To` MUST be included in the sending server's DKIM `h=` tag and **oversigned** (listed twice), for the same reason as `RapidMX-Key`. Without oversigning, an attacker can inject the header into a message that did not carry one and redirect the resulting receipt to an address of their choosing.

Receiving servers MUST verify DKIM before acting on the header and MUST treat an unverified `Disposition-Notification-To` as absent.

The address in `Disposition-Notification-To` MUST be compared against the `From` address before a response is generated. A mismatch MUST cause the request to be ignored.

#### UI Semantics

MDN support in the wider mail ecosystem is inconsistent — consumer Gmail ignores requests entirely, Apple Mail defaults to not responding, and Thunderbird prompts. Absence of a receipt therefore does not mean the message was unread.

The client MUST distinguish three states and MUST NOT render the third as an unfilled "unread" checkmark:

| State                     | Meaning                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| Delivered / Read          | A receipt was received.                                             |
| Awaiting                  | A receipt was requested and may still arrive.                       |
| No confirmation available | The recipient's system does not support or did not honour receipts. |

### Derived Entities

An entity materialised from an encrypted message — most importantly a calendar event created from an encrypted meeting invitation — reintroduces the sender's plaintext into server-visible storage unless handled.

- Entities materialised from a message encrypted by a **federated peer or external sender** MUST be encrypted under the same mailbox master key as the message they derive from, and MUST carry a provenance flag.
- **Origination.** A user MUST be able to send an encrypted calendar invitation. When an invitation is sent encrypted, the organiser's own copy of the event MUST also be encrypted — encrypt-to-self applied to calendar. An explicit user choice to encrypt MUST be honoured regardless of tier, including same-organisation invitations; a deliberate decision outranks the default scoping below.
- Entities derived from **same-organisation** messages are not _automatically_ protected. The administrator can already read the mailbox, so no new exposure is created. **However, inheritance follows the message's actual encryption state, not its tier**: if a message arrived encrypted for any reason — including a same-organisation sender who chose to encrypt — its derived entities MUST be encrypted. Tier scoping governs whether protection is applied automatically, never whether existing protection is inherited.
- **Encrypted events are partially encrypted.** Title, notes, location and attachments are encrypted. Start, end, duration, busy status, recurrence pattern, organiser, attendee list and RSVP status remain plaintext. Free/busy MUST report busy time without title or location. Attendees stay plaintext because a meeting invitation travels as a message whose `To`/`Cc` headers already name them and RFC 9788 retains outer headers by default; encrypting the list would protect data the server already holds while breaking RSVP tracking and delegate access. This rule MUST be revisited if HP-Obscured outer-header handling is ever adopted.
- **Encryption state is sticky.** Updates, cancellations and every instance of a recurring series MUST share the original's encryption state. Adding an attendee who cannot receive encrypted mail follows the multi-recipient rule above: present the choice, never split into encrypted and plaintext copies.
- **Contacts are never encrypted.** A contact is a record the user authored, not content the correspondent sent. `prefer-encrypt` is a statement about messages in transit and MUST NOT be interpreted as changing how an existing contact is stored. Contacts MUST NOT be auto-enriched from decrypted message content; envelope-derived address and display name only.
- Files saved out of encrypted attachments MUST NOT be submitted for server-side text extraction.
- This behaviour MUST be an administrator setting, defaulting to protective.

Because derived entities use the same master key, escrow covers them with no extension — within whichever escrow scope the mailbox belongs to.

The search consequences of this rule are specified in the companion encrypted search design document.

### Server-Side Feature Impact

Encrypting message bodies removes the server's ability to read them. The following features are affected and each server operator MUST be able to see which are degraded when E2E is enabled:

| Feature                           | Impact                                                                     |
| --------------------------------- | -------------------------------------------------------------------------- |
| Server-side full-text search      | Encrypted bodies are not indexable. See **Search** below.                  |
| Content-based spam filtering      | Operates on envelope and headers only for encrypted mail.                  |
| Rules matching on body text       | Cannot be evaluated server-side. Header and envelope rules are unaffected. |
| Archiving / compliance retention  | Archives ciphertext. Full-text search over the archive is not possible.    |
| Antivirus scanning of attachments | Cannot inspect encrypted attachments.                                      |

The product documentation MUST state plainly which of these are traded away. Capturing plaintext at delivery to preserve them means the server can read user mail, and any deployment doing so MUST NOT be described as end-to-end encrypted.

### Search

RapidMX currently performs all search server-side via the REST API, with no client-side index. E2E invalidates that architecture for encrypted mail and the replacement requires its own design document. This section records the constraints that document must satisfy.

#### Rejected: Deterministic Encrypted Keyword Index

Having the client hash each token on decryption and upload the hashes for server-side matching MUST NOT be used. It appears to preserve server-side search but leaks substantially:

- **Frequency analysis.** Natural-language word frequencies are public. The distribution of uploaded hashes maps back onto the distribution of words with high accuracy, and leakage-abuse attacks against this construction recover a large fraction of keywords. A per-user HMAC key prevents cross-user correlation but not within-user frequency analysis.
- **Query and access-pattern leakage.** The server learns which hash was searched and which messages matched, which is the basis of most practical attacks on searchable encryption.
- **Capability loss.** Only exact token match survives. Prefix matching, phrase queries, stemming and relevance ranking do not.

#### Required Shape: Hybrid Search

- **Server-side** over everything the server can still see: envelope, participants, dates, folders, flags, and any message that is not encrypted.
- **Client-side** over decrypted content, using a local index built as messages are decrypted.
- **Merged** in the client, so the user sees one result set.

#### Constraints the Design Must Address

1. **Initial index build.** A new device starts unable to search encrypted history. Specify whether the index builds eagerly on first unlock or incrementally, and what the user sees while it is incomplete.
2. **Index persistence and its own encryption.** The index is derived from plaintext and MUST be protected at rest under the same master key as the private keys.
3. **Header protection interacts here.** With RFC 9788 in use, `Subject` is inside the signed and encrypted structure, so server-side search degrades further than the table above implies — subject lines of encrypted mail are not server-searchable.
4. **Outlook cannot hold a client-side index.** Encrypted mail is therefore not searchable from Outlook at all. This is a documented limitation of using an existing client, not a defect, and MUST be stated in user-facing documentation rather than discovered.
5. **Storage budget.** A mailbox large enough to matter produces an index large enough to matter, on devices with quota limits.

### Recovery

Loss of every unlock method means the user's encrypted mail is permanently unreadable. This MUST be addressed explicitly:

- Recovery codes MUST be generated and displayed at enrolment, with confirmation that the user has stored them.
- The client MUST warn the user, at enrolment, that losing all unlock methods results in permanent loss of encrypted mail.
- Mailboxes in an escrow scope MAY be recovered by that scope's holders, at the cost described above. Mailboxes in a scope configured with no escrow are unrecoverable if every unlock method is lost, which is the intended trade for privileged contexts.

### Message Security Indicators

The client MUST display the security status of every message. Encryption and signing are **separate guarantees** and MUST NOT be collapsed into a single indicator — a message can be encrypted but unsigned, or signed but plaintext.

| State                | Meaning                                                                    |
| -------------------- | -------------------------------------------------------------------------- |
| Encrypted            | Body was encrypted to the recipient's key. Says nothing about who sent it. |
| Signed & verified    | Signature validates against the pinned key for this contact.               |
| Encrypted & verified | Both of the above.                                                         |
| Signature failed     | A signature was present and did not validate.                              |
| Unprotected          | Neither.                                                                   |

**Signature failure MUST be visually distinct from unprotected**, not a muted variant of verified. A failed signature is a stronger negative signal than no signature at all, and rendering it as a lesser shade of success inverts its meaning.

An unprotected message MUST NOT be styled as an error state. Most legitimate mail will be unprotected for the foreseeable future, and alarming users about ordinary correspondence trains them to ignore the indicator entirely.

These indicators also serve the enablement migration: a user who enables E2E after using RapidMX in plaintext will see prior mail marked unprotected, making the boundary self-evident rather than requiring explanation.

## Resolved Decisions

| #   | Question                                      | Decision                                                                                                                               |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Public CA enrolment for signing keys          | Yes, by default, automated via RFC 8823. Encryption keys stay on the internal CA.                                                      |
| 2   | RFC 9788 header protection                    | Yes. `Subject` and `From` covered by the signature.                                                                                    |
| 3   | Hash the local part on the discovery endpoint | Yes, SHA-256 + z-base32, following WKD.                                                                                                |
| 4   | Migration for users enabling E2E later        | Handled by per-message security indicators rather than a migration process.                                                            |
| 5   | Receipt transport between peers               | Standard RFC 8098 MDN with extension fields. No separate channel.                                                                      |
| 6   | Encrypted search                              | Hybrid, server-side plus client-side index. Deterministic keyword hashing rejected. Separate design document required.                 |
| 7   | Escrow disclosure to correspondents           | Yes, as a MUST on the discovery endpoint, documented as an honesty signal rather than a guarantee.                                     |
| 8   | Key rotation push to federated peers          | Yes, via MDN extension fields, as a cache invalidation hint only. Never installs keys directly.                                        |
| 9   | Escrow warning severity                       | Soft passive indicator by default; user-configurable escalation to a confirmation prompt.                                              |
| 10  | Encryption policy granularity                 | Three states per tier — `automatic`, `optional`, `prohibited`. Two states conflate "not by default" with "not allowed".                |
| 11  | Escrow boundary                               | eDiscovery/compliance role, not server administration. Multiple scopes, each with its own key and holders; a scope may have no escrow. |
| 12  | Derived-entity inheritance vs. tier           | Inheritance follows the message's actual encryption state. Tier scoping governs automatic application only.                            |
