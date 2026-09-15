# Release Notes

## v0.12.0

### Breaking changes

- **Booking moved to `@rapidmx/booking-plugin`.** The Calendly-style booking feature (public booking pages, booking
  types and bookings) is no longer part of this library. Install the plugin to keep `mail/booking-types` and
  `mail/bookings`. Resource and room booking (`Mailbox.autoAcceptBookings`, the booking window settings and
  `ScanQueueJob`'s auto-accept) stays here, unchanged.
  - **Removed exports:** the `Booking`, `BookingType`, `BookingAvailabilityWindow` and `BookingDateOverride` types and
    the `BookingStatus` enum; `BookingMongo`, `BookingTypeMongo`, `BookingSQL` and `BookingTypeSQL`;
    `BaseBookingRoute`, `BaseBookingTypeRoute`, `BookingRouteMongo`, `BookingTypeRouteMongo`, `BookingRouteSQL` and
    `BookingTypeRouteSQL`; and `BookingUtils` (`generateCandidateSlots`, `subtractBusy`, `normalizeSlug`,
    `validateAvailability`).
  - **`ErasureExecutionJob`** no longer has the abstract `bookingTypeClass` and `bookingClass`, and
    `ErasureExecutionJobMongo`/`ErasureExecutionJobSQL` no longer set them. A custom subclass that sets them must drop
    them. Bookings are erased through the plugin's `@MailboxScopedData()` models instead, so an erasure waits while the
    plugin is installed but not loaded. A deployment with booking data and no plugin installed leaves those rows behind
    on erasure.
  - **Existing data carries over.** The plugin keeps the entity and class names (`BookingMongo`, `BookingTypeMongo`,
    `BookingSQL`, `BookingTypeSQL`), so the same collections and tables (`booking_sql`, `booking_type_sql`), indexes
    and class ACLs are used once it's installed.
  - **Config:** `mail:booking:public_url` is now declared by the plugin.

### Exports

- **`DateCoercionUtils` is exported from the package root:** `parseClientDate()`, `coerceDateValue()`,
  `coerceDateFields()`, `coerceCalendarEventDates()`, `MATTER_DATE_FIELDS` and the `DateCoercionOptions` type.

### Plugins

- **Plugin manifests can declare UI.** `PluginManifest.ui` (types `PluginUi`, `PluginUiApp`, `PluginUiNavItem`,
  `PluginUiHost`) lists the browser apps a plugin ships as TSX sources and the navigation entries that link to them.
  `apiVersion` stays 1: the field is optional and older servers ignore it.
  ```json
  "ui": {
    "apps": [{ "id": "book", "host": "public", "mount": "/book", "dir": "apps/book" }],
    "settingsSections": [{ "id": "booking-types", "label": "Booking Links", "href": "/settings/booking-types" }],
    "adminNav": [],
    "appRail": []
  }
  ```
- **`parsePluginManifest()` validates `ui`** (through the new `parsePluginUi()`) and keeps only its known fields. A
  package with an invalid `ui` isn't a loadable plugin, so adding it is 400 as for other manifest errors.
  - **Apps** (at most 16): `id` is a lowercase slug unique among the apps; `host` is `public`, `www`, `admin` or
    `escrow`; `dir` is a relative POSIX path inside the package (no leading `/`, drive letter, backslash, empty segment,
    or segment starting with a dot).
  - **Mounts** are paths of lowercase slug segments matching the host, exactly one segment below its base: `/<name>`
    (`public`), `/<name>` or `/settings/<name>` (`www`), `/admin/<name>` (`admin`), `/escrow/<name>` (`escrow`). A
    mount can't be one of `RESERVED_PLUGIN_UI_MOUNTS` (`/api`, `/assets`, `/__rapidrest__`, the server's own routes and
    static files, and every core www, admin and escrow page) or overlap another app of the same plugin.
  - **Navigation** (`settingsSections`, `adminNav`, `appRail`, at most 8 each): `id` is a lowercase slug unique within
    its list, `label` is 1 to 64 characters and not blank, and `href` is a path under `/settings/`, under `/admin/`, or
    (app rail) outside `/admin` and `/escrow`. An optional `icon` names a `react-icons/hi2` icon.
- **Mount conflicts between plugins.** `findPluginUiMountConflicts(plugins)` reports every pair of UI apps from
  different plugins whose mounts are the same or nest, across hosts, naming the later plugin as `name` so a host can
  keep the first. `planPluginChange()` adds a conflict (`"Other Booking and Booking both serve pages at /book."`) when
  the plugin, or anything the change installs or enables, overlaps an enabled plugin. So `POST /`, `PUT /:id` enabling
  or changing version, and `GET /plan` refuse or report it. Overlaps between enabled plugins the change doesn't touch
  are ignored.
- **Races:** a plugin change that ends up overlapping a plugin enabled at the same time is undone with a 409, like an
  unmet requirement.

## v0.11.0

This release adds "Trust this signer": a user can pin the signing certificate of a validly signed message whose sender has
no signing key pinned yet.

### Breaking changes

- **`BaseKeyLookupRoute` has a new abstract `auditLogClass`.** `KeyLookupRouteMongo` and `KeyLookupRouteSQL` set it
  (`AuditLogEntryMongo`/`AuditLogEntrySQL`). A custom subclass of `BaseKeyLookupRoute` must set it too.

### Key management

- **`POST /mail/mailboxes/:id/keys/trust`** with `{ "address": "<address>", "certificate": "<base64 DER X.509>" }` pins
  the certificate as the address's signing key on the contact in the mailbox, creating the contact in Contacts if there
  is none. It returns the same `{ keys, encryptPreference?, keyConflicts?, previousKeys? }` as `GET /:id/keys/lookup`.
  - **Only the first signing key:** 409 when a different signing key is already pinned (replacing one is still
    discovery's Key Conflict Handling). The same certificate again is 200 and changes nothing.
  - **Nothing else changes:** encrypt keys, `encryptPreference` and `keyConflicts` stay as they are; `keysFirstSeen`
    is set if unset. Fingerprint and validity dates come from the certificate.
  - **400** for a body that isn't `{ address, certificate }`, an address that isn't one plain `local@domain`, and a
    certificate that doesn't parse, isn't currently valid, doesn't name the address (subjectAltName email, or subject
    emailAddress when it has none; case-insensitive), has keyUsage without `digitalSignature`, or has extKeyUsage without
    `emailProtection`.
  - **Access:** UPDATE on the mailbox (404 for a missing mailbox, 403 otherwise), plus UPDATE on the contact's folder
    or CREATE on the Contacts folder, as for the contact routes. A read-only delegate gets 403.
  - Rate limited like lookup. Each pin records a `contact.key_trusted` audit entry (`AuditAction.CONTACT_KEY_TRUSTED`)
    with the address and fingerprint.
- **One contact per address:** key lookup, the inbound `RapidMX-Key` header and trust create a server-made contact at
  a uid derived from the mailbox and address. Concurrent writers re-read the winner and merge into it, so they don't end
  with two contacts or two signing keys. A lost version race is retried instead of returned as 409.
- **Contacts folder access:** a Contacts folder created by a lookup or trust no longer gives the caller creator rights on
  it; it inherits the mailbox's access.

### Key rotation continuity (publishing side)

- **`PublicKey.issuerCertificate`** (base64 DER, at most 16 KB of base64): the certificate that directly issued the key's
  certificate. It is stored only after checking that the leaf's issuer name equals its subject and the leaf's signature
  verifies against its key. Otherwise it is dropped and the key still installs. Discovery (`/.well-known/rapidmx/keys/:hash`)
  publishes it. The `RapidMX-Key` header doesn't carry it. Peers can use it to prove that a rotated certificate comes from
  the same CA as the pinned one.
  - Encryption keys: `EncryptionCertificateAuthority.issue()` results gain an optional `issuerCertificate` (PEM).
    `LocalX509CertificateAuthority` returns its CA certificate. `OpenBaoPkiCertificateAuthority` returns `issuing_ca`, or
    the first `ca_chain` entry when that is missing. A custom authority may leave it out.
  - Signing keys: the certificate given to `POST /:id/keyvault/keys` (`useType: "sign"`), or issued to an automated
    enrollment, may be a PEM chain. The first certificate is installed, and the second is used as its issuer. Before,
    only the first certificate was read.
- **Superseded keys are revoked.** When `enrollKey()` or the ACME driver job installs a key, every older unrevoked key of
  the same `useType` gets `revokedAt` (the install time) and the new **`PublicKey.revocationReason: "superseded"`**. This
  happens in the same mailbox write, so a failed install revokes nothing. Wrapped private keys stay in the vault. A
  re-enrolled certificate replaces its earlier `Mailbox.keys` entry instead of adding a second one.
  - `revocationReason` is `"superseded"` (routine rotation: signatures and mail from before `revokedAt` stay trustworthy)
    or `"compromised"`. An absent reason on a revoked key means compromised. Discovery publishes it, and
    `parseKeyDiscoveryResponse()` keeps it. An unknown value, or a malformed `issuerCertificate`, makes the response
    malformed.
- **`PUT /:id/keyvault/rekey` key rules** (the rest of the "identical fields" check is unchanged):
  - `issuerCertificate` may be left out or null (the stored one is kept) or sent unchanged. Any other value is 400.
  - A stored revocation is kept even when the request leaves out `revokedAt`, so revocations can't be withdrawn.
  - A request may escalate `"superseded"` to `"compromised"`, but not the reverse.
  - Newly setting `revokedAt` records the request's reason, or `"compromised"` when none is given.
  - A non-numeric `revokedAt` or an unknown `revocationReason` is 400. Fields outside `PublicKey` are no longer stored.
  - After a rekey, only each `useType`'s active key stays unrevoked: the unrevoked, unexpired key with the latest
    `notBefore`. Any other unrevoked key is revoked as superseded, which cleans up mailboxes enrolled before this release.
- **Client impact:** a mailbox's older keys now show as revoked after a rotation. Clients that ignore every revoked
  signing key will stop trusting signatures made with the older key. They should keep trusting a `"superseded"` key for
  signatures made before `revokedAt`. `BaseMessageRoute`'s `RapidMX-Key` header and `ScanQueueJob`'s MDN rotation hint use
  the first unrevoked encryption key. They now announce the current key instead of the oldest.

### Key rotation continuity (receiving side)

A contact whose key changed used to be stuck: the change was recorded as a conflict and nothing could replace the pinned
key. Now a routine rotation within the same CA is applied automatically, and anything else can be accepted or rejected by
the user.

- **Automatic replacement.** When discovery or an inbound `RapidMX-Key` header shows a different key for a `useType` that
  has one pinned, the new key replaces the pinned one without prompting only when all of these hold:
  - the new key carries `issuerCertificate`, that certificate may act as a CA (basicConstraints `cA`, when present, is
    true), the new key's issuer name equals its subject, and the new key's signature verifies with its public key;
  - the pinned key verifies against that same issuer, so both come from one CA key;
  - the pinned key is expired, or revoked for either reason. A revocation counts when the pinned record has `revokedAt`,
    or when the same discovery response lists the pinned key with `revokedAt`;
  - the new key is currently valid, names the contact's address, and fits its `useType`. For `sign` that means keyUsage
    (when present) with `digitalSignature`; for `encrypt`, keyUsage (when present) with `keyAgreement` or
    `keyEncipherment`, the bits this library's CA issues. For both, extKeyUsage (when present) must include
    `emailProtection`.

  The old key moves to `previousKeys` with `replacement: "automatic"` and keeps its `revokedAt`/`revocationReason`. The
  conflict for that `useType` is cleared. Otherwise the new key is recorded as a conflict, unless the user rejected it.
- **Revocations in discovery responses.** A listed key with `revokedAt` is never pinned (not even on first use) and never
  recorded as a conflict. When it matches a pinned or previous key, that key takes the listed revocation if it is stronger:
  any revocation over none, `"compromised"` (or no reason) over `"superseded"`. A revocation is never weakened. A key
  already in `previousKeys` is not recorded as a conflict again.
- **Header conflicts refresh discovery.** The `RapidMX-Key` header carries no issuer, so a header conflict triggers a
  discovery refresh for the sender, through the same contact write as the MDN rotation hint, so the automatic rule can
  apply. It is bounded like that refresh (negative federation cache, per-address response cache, fetch timeout). A failed
  refresh is logged and doesn't affect delivery.
- **`POST /mail/mailboxes/:id/keys/resolve`** with
  `{ address, useType: "sign" | "encrypt", action: "accept" | "reject", expectedPinnedFingerprint, certificate? }`:
  - `accept` pins `certificate` (base64 DER) when given, otherwise the recorded conflict's key. Either is validated now:
    it must parse, be currently valid, name the address and fit `useType`. The old key moves to `previousKeys` with
    `replacement: "user"`, the conflict is cleared, and the key leaves `rejectedKeys`. It records a
    `contact.key_replaced` audit entry (`AuditAction.CONTACT_KEY_REPLACED`) with `{ address, useType, from, to }`.
  - `reject` clears the conflict and adds its fingerprint to `rejectedKeys`. It records a `contact.key_conflict_rejected`
    audit entry (`AuditAction.CONTACT_KEY_CONFLICT_REJECTED`) with `{ address, useType, fingerprint, pinnedFingerprint }`.
  - **200** with the lookup shape. An `accept` whose certificate is already the pinned key changes nothing.
  - **400** for a malformed body (including `certificate` with `reject`), or a certificate (given or recorded) that fails
    validation.
  - **404** for a missing mailbox, no contact, no pinned key of `useType` (`accept`), or no conflict for `useType`
    (`reject`, or `accept` without `certificate`).
  - **409** when the pinned key isn't `expectedPinnedFingerprint`, so only the key the user saw is replaced.
  - Access as for trust: UPDATE on the mailbox (403 otherwise) and UPDATE on the contact's folder. Rate limited. It uses
    the same version-checked, race-retrying contact write as lookup, trust and the scan job.
- **Contact fields**, all server-managed (the contact routes refuse them with 400, as they do the other key fields):
  - `keyConflicts?: KeyConflict[]`, where `KeyConflict` is `{ useType, observedKey: PublicKey, observedAt, source }`.
    There is at most one per `useType`, and the latest observation wins.
  - `previousKeys?: PreviousKey[]`, where `PreviousKey` is a `PublicKey` plus `replacedAt` and
    `replacement: "automatic" | "user"`. Newest first, at most 5 per `useType`. These are kept so mail signed before a
    rotation still verifies. Clients should trust a previous signing key unless it is revoked as compromised.
  - `rejectedKeys?: { useType, fingerprint, rejectedAt }[]`. Newest first, at most 10.

### Breaking changes (key rotation continuity)

- **`Contact.keyConflict` is replaced by `Contact.keyConflicts`.** The old single conflict held only a fingerprint, so it
  can't be accepted. It is dropped on read: the model no longer has the field, and SQL schema synchronization drops the
  column. The pinned key is unchanged, so the next observation of the differing key records a complete conflict.
- **The lookup and trust response** is now `{ keys, encryptPreference?, keyConflicts?, previousKeys? }`. `keyConflict`
  is gone, and `keyConflicts`/`previousKeys` are omitted when empty.
- **`applyDiscoveredKeys()` takes the contact's address** as a new fifth argument. `ContactKeyState`/`KeyringUpdate`
  carry `keyConflicts`, `previousKeys` and `rejectedKeys` instead of `keyConflict`.
- **`sanitizeDiscoveredKey()`** keeps `revocationReason` only when it's `"superseded"` or `"compromised"` on a key with
  `revokedAt`.

### Breaking changes (verification seals)

- **`BaseMessageRoute` has a new abstract `keyVaultClass`.** `MessageRouteMongo` and `MessageRouteSQL` set it
  (`KeyVaultMongo`/`KeyVaultSQL`). A custom subclass of `BaseMessageRoute` must set it too.

### Signature verification seals

- **`Message.verificationSeal?: string`**: an opaque seal a client stores after it verifies a message's S/MIME signature
  (an HMAC keyed from the user's master key), so it can still show "Verified when first opened on <date>" after the
  signer's key is replaced or revoked. The server never interprets it.
- **`Message.verificationSealGeneration?: number`**: the key vault `masterKeyGeneration` the seal was made under. SQL adds
  two nullable columns (`verificationSeal` text, `verificationSealGeneration` integer), created by schema synchronization.
- **`PUT /mail/messages/:id/verification-seal`** with `{ "seal": "<string>", "masterKeyGeneration": <number> }` returns
  the message.
  - **400** unless `seal` is a non-empty string of at most 2048 characters (`MAX_VERIFICATION_SEAL_LENGTH`) from
    `[A-Za-z0-9+/=_.:-]` and `masterKeyGeneration` is a non-negative integer. **404** for an unknown message. **403**
    without READ and UPDATE on the message's folder, so a delegate with both can set it and a read-only one can't.
  - **409** when the mailbox has no key vault, or `masterKeyGeneration` isn't the vault's current generation (a vault
    without one counts as 0). A client on a stale master key never writes.
  - **Generation-bound replacement:** with no stored seal, both fields are set. The identical seal at the current
    generation is 200 and writes nothing. A seal from an older generation (a rekey made it unopenable) is replaced. A
    different seal at the same or a newer generation is 409. A stored seal without a generation counts as generation 0.
  - The write is version-checked, so of two concurrent writers one wins and the other re-reads and gets the rules above
    (409 for a different seal, 200 for the same one).
  - Not blocked by a legal hold (a seal isn't content) and not audited (user-private metadata).
- **Server-managed everywhere else:** create, update, bulk update and `PUT /:id/:property` drop both fields, for trusted
  callers too. Rule copies, forwards, list relays, Sent Items filing, scheduled send and recall never copy them, and
  mailbox import (mbox/PST) never sets them. The JSON data export and matter export include both as-is; erasure removes
  them with the message.

## v0.10.0

This release adds plugin search, updates and dependencies, and hardens almost every part of the library after six rounds
of adversarial review. Many fixes tighten behaviour that clients relied on; read **Breaking changes** and **Upgrading**
before rolling it out.

### Breaking changes

- **Requires `@rapidrest/service-core` ^2.1.0** (peer range was `2.x`). This library now relies on 2.1.0's
  `allowExistingACL`, `ModelUtils.literal()`, duplicate-key mapping and stricter write validation. `semver` is a new
  dependency.
- **Create and update bodies:**
  - Every create route generates the record's `uid` on the server. Mailbox and distribution list uids stay
    address-derived.
  - A client `_id`, `version`, `dateCreated` or `dateModified` is ignored on create.
  - Top-level keys and `:property` names containing `.` or starting with `$` are rejected with 400.
  - Server-managed fields are ignored on client writes: blob keys, scan, receipt and search state, `hasAttachments`,
    `Attachment.messageUid`, job retry and lease fields, and `retainedBodyBlobKeys`.
- **Queries:**
  - `$`-prefixed keys are stripped from client queries, and routes force their checked scope last.
  - `?deleted=true` needs DELETE and UPDATE rights; without them the filter is ignored.
- **Sending:**
  - A PUT can no longer set `scheduledSendTime`. Schedule with `POST /mail/messages/:id/send` and a
    `{ "scheduledSendTime": "<ISO>" }` body.
  - A non-trusted caller can only send, or schedule, a message that is in Drafts (403 otherwise), and it must have at
    least one recipient (400).
  - Sending a message already in Outbox or Sent Items is 409.
  - Creating or moving a message into Outbox is 403.
- **Moves and deletes while a send is in progress:**
  - Moving a message out of Outbox, or deleting it, while its send is in flight is 409.
  - Moving a message into Drafts is allowed only from Outbox or Drafts, and never for delivered mail (403).
- **Mailboxes:**
  - Non-trusted callers can't change a mailbox's owner, quota or used bytes.
  - An owner may rename the primary address only onto their own usernames on a verified domain.
  - Addresses are stored lowercase and must be plain `local@domain`.
  - Display names containing `@`, a look-alike (`＠`, `﹫`) or a line break are rejected with 400.
  - Self-service `POST /mailboxes` follows the mailbox policy.
- **Mailbox access:**
  - Access can only be granted to user uids (not anonymous, wildcard or role ids).
  - Granting, changing or removing a manager requires full access.
  - `lookup-by-email` requires authentication, takes a single plain address and is rate limited.
- **Attachments:** listing, reading and downloading follow the owning message's current folder. `folderUid` is ignored
  when `messageUid` is given.
- **Calendar and invites:**
  - Event writes reject a non-plain organizer or attendee address, or more than 500 attendees, with 400.
  - Invites are sent from the organizer mailbox's safe display name, never the event's stored organizer name.
  - Non-plain attendees are skipped.
  - Invites to more than `mail:jobs:meeting_scheduling:max_attendees` (500) aren't sent.
  - Invites now pass through the scan pipeline.
- **Dates:** client dates must be ISO 8601 (a missing zone means UTC) or epoch milliseconds. Numeric strings, epoch
  seconds and impossible dates are rejected with 400.
- **Key vault:**
  - Every write is owner-only.
  - The last unlock wrap can't be removed.
  - A second first-time enrollment that sends `masterKeyWraps` is 409.
  - `rekey` is 409 while a signing enrollment holds a wrapped key, and must include a replacement escrow wrap for an
    escrowed mailbox (old escrow wraps are dropped).
  - Enrollment status and cancel return 404 for another mailbox's enrollment id.
- **Escrow:**
  - Deleting an escrow scope still assigned to a mailbox is 409.
  - Admins can't be escrow holders.
  - Approved escrow access expires, and is refused for closed matters or removed custodians.
- **Share links** resolve as `share:<token>` ACL records. Existing share links must be saved again.
- **Branding** accepts raster images only. Header and footer HTML is sanitized.
- **Plugins:**
  - `POST /system/plugins` returns `{ plugin, dependencies }`.
  - Disabling or removing a plugin that an enabled plugin requires is 409.
  - `POST` and `PUT` accept `expectedPlan` and return 409 when the dependencies differ from the previewed plan.
- **Inbound trust:**
  - Recall, iTIP, inbound `RapidMX-Key` headers and ACME challenges require aligned, passing DKIM under
    `mail:security:trusted_authserv_id`. `RapidMX-Key` and `X-RapidMX-Recall-Of` must also be oversigned.
  - Distribution lists with `restrictSenders` accept only a DKIM-verified member.
  - Copies relayed to list members or forward-rule targets have From rewritten unless the sender is DKIM-verified;
    trust headers and unverified calendar content are stripped.
  - Pinned contact keys are no longer replaced automatically.

### Upgrading

- **SQL column types:** Postgres and MySQL/MariaDB need a manual `ALTER` for the new `double precision` quota and
  timestamp columns before starting this version, and free-text columns are now `text`. See **Upgrading** in the
  README for the exact SQL.
- **New columns and indexes:** new nullable columns (`scheduledSendLeaseExpiresAt`, `retainedBodyBlobKeys`,
  `masterKeyGeneration` and others) are created by `synchronize`. There are new indexes on all backends, plus a unique
  Focused Inbox override per sender, which needs existing duplicates removed first (README).
- **Mail server configuration:**
  - Set `mail:security:trusted_authserv_id` to your MTA's authserv-id. Without it, members-only lists drop all mail,
    relayed and forwarded copies are rewritten, and recall, iTIP, key discovery and ACME trust is off.
  - Outbound DKIM must oversign `RapidMX-Key` and `X-RapidMX-Recall-Of` (for example OpenDKIM `OversignHeaders`).
- **Behind a proxy:** set `trusted_proxies` so per-IP rate limits see the real client address.

### Plugins

- **Search** (`GET /system/plugins/search`) finds `*-plugin` packages in one or every configured namespace, with each
  one's latest version, whether it's allowed, installed and has an update.
- **Updates** (`GET /system/plugins/updates`) reports newer published versions of installed plugins.
- **Namespaces** (`system:plugins:namespaces`, `GET /system/plugins/namespaces`): npm scopes to search, each optionally
  with its own registry and token. Packages in a configured namespace may be added.
- **Dependencies:**
  - A plugin manifest's `requires` maps other plugin packages to semver ranges.
  - Adding a plugin installs missing requirements at the highest version in range and enables disabled ones.
  - Out-of-range versions, missing versions, disallowed packages and cycles are refused.
  - `GET /system/plugins/plan` previews a change.
  - `findDependents()`, `orderByDependencies()` and `pruneUnmetRequirements()` support a host's load order.
- **Erasure:** held while an installed plugin whose manifest declares `mailboxScopedData` isn't loaded.
- **Registry hardening:**
  - package names are validated;
  - requests have timeouts, size limits and caching;
  - non-semver versions are rejected;
  - namespace credentials never appear in errors.
- **Failed changes:** a change that fails partway is undone.

### Mail flow and jobs

- **Claims and leases:**
  - Inbound delivery, scheduled send, erasure, data export, mailbox import and matter export claim their work with
    version-checked leases, count attempts at claim time and park exhausted entries.
  - Inbound delivery is idempotent, and delivery receipts are sent at most once.
- **Immediate send:** it claims the message by moving it into Outbox with a lease, and after a crash
  `ScheduledSendJob` finishes filing it.
- **Erasure:**
  - Mail for a mailbox under erasure is deferred while the request waits, and dropped once erasure runs or the mailbox
    is gone.
  - Requests older than a re-created mailbox are ignored.
  - Erasure is checked before scanning.
- **Resource bookings** are expanded in windows, so long open-ended series aren't declined wrongly.
- **Reminders and invites:** reminders are claimed per occurrence, and meeting invites are claimed per revision.
- **Legal hold:**
  - Moves to another mailbox and purges are blocked for held messages.
  - Superseded draft bodies kept under hold are recorded on the message (`retainedBodyBlobKeys`), included in matter
    exports and released after the hold.
- **Forwarding:** loop protection with envelope rewriting.
- **Search:**
  - Attachment extraction runs in worker threads with a zip-bomb guard.
  - OpenSearch bulk requests are chunked by bytes.
  - Search index entries are purged for deleted mail.
- **Indexed identifiers:** Message-ID, iCalendar UID and conversation id values longer than 255 characters are stored
  as hashes, and every sender-controlled lookup uses `ModelUtils.literal()` with an exact match.

### Security

- **Record takeover:**
  - Mongo document overwrite via a client `_id` is fixed.
  - Taking over existing ACLs by creating a record at their uid is fixed.
  - Well-known folders keep their ACL after concurrent creation races.
- **Spoofing:** send, scheduled send, recall and receipts check every composed From and Sender header, including
  duplicates, `From :`, bare CR, and address-like or look-alike display names.
- **Escrow audit:** the ledger is HMAC-chained with a head record.
- **Key discovery:** includes the domain, and the lookup is timing-balanced.
- **Content and uploads:**
  - Attachments and message content are served with safe types, `nosniff` and CSP.
  - Blob writes are atomic.
  - Shared blobs are reference-counted before deletion.
- **Rate limits:** anonymous booking and slot lookups are rate limited per client IP (IPv6 by /64) and slug; booking
  manage tokens are validated.
- **Mongo updates** are version-checked for plain rows (`asEntity`).

### New exports

`asEntity`; `LegalHoldUtils` (`findActiveHoldsFor`, `assertNotOnLegalHold`, `loadLegalHoldIndex`); `findPagesByUid`;
`RequestBodyUtils`; `DraftBodyRetentionUtils`; `boundIndexedValue`; `rateLimitKeyForIp`; `GET
/mail/mailboxes/:id/access/me`. From `MimeHeaderUtils`: `checkOriginatorHeaders`, `extractOriginatorHeaders`,
`hasAddressLikeDisplayName`, `safeDisplayName`, `isPlainAddress` and `prepareRelayCopy`. Plugins that copied these
rules inline (activesync's `RestapiCompat`/`MimeHeaderUtils`, mapi's `RestapiRules`) can import them instead once they
depend on this release.

### New config keys

- **Delivery queue:** `mail:jobs:scan_queue:{lease_seconds, max_attempts, retry_backoff_seconds, erasure_defer_seconds,
  erasure_defer_max_seconds}`.
- **Scheduled send:** `mail:jobs:scheduled_send:{lease_ms, max_attempts, retry_backoff_ms}`.
- **Meeting scheduling:** `mail:jobs:meeting_scheduling:{max_attendees, max_pages, rescan_lag_seconds}`.
- **Calendar reminders:** `mail:jobs:calendar_reminder:{initial_lookback_seconds, max_lead_minutes}`.
- **Export, import and erasure:**
  - `mail:jobs:erasure_execution:{claim_lease_seconds, purge_page_size}`
  - `mail:jobs:data_export:{lease_minutes, max_attempts}`
  - `mail:jobs:mailbox_import:{lease_minutes, max_attempts}`
  - `mail:jobs:matter_export:{lease_minutes, max_attempts}`
  - `mail:export:max_bytes`
- **Retention:** `mail:jobs:quarantine_retention:delivered_ingest_retention_days`.
- **Search and indexing:**
  - `mail:jobs:search_index:{max_attempts, retry_backoff_seconds}`
  - `mail:jobs:attachment_extraction:{max_attempts, retry_backoff_seconds}`
  - `mail:search:extraction:{isolation, max_decompressed_bytes, max_output_chars}`
  - `mail:search:extraction:worker:{idle_ms, max_old_generation_mb, max_young_generation_mb, stack_size_mb, max_tasks}`
  - `mail:search:opensearch:max_bulk_bytes`
- **Storage:** `mail:blob:s3:multipart_part_size_bytes`.
- **Plugins and network:** `system:plugins:namespaces`, `trusted_proxies`.

## v0.9.0

### Breaking changes

- **ActiveSync device state moved to `@rapidmx/activesync`**: `DeviceSyncState` (interface and Mongo/SQL models) and
  `EasDeviceStateCleanupJob` are no longer part of this library. Entity names and config keys are unchanged, so existing
  device state carries over once the ActiveSync plugin is installed.
- **`ErasureExecutionJob` no longer has `deviceSyncStateClass`**: it now erases every loaded model decorated
  `@MailboxScopedData()` in its own datastore, so plugin data is still removed with an erased mailbox. Subclasses that
  set `deviceSyncStateClass` should drop it.
- **`BaseMailboxRoute` requires `mailboxPolicyClass`**: custom subclasses must supply the `MailboxPolicy` model (the
  bundled `MailboxRouteMongo`/`MailboxRouteSQL` already do).

### Plugins

- **Plugin contract** (`src/plugins`): a plugin is an npm package with a `rapidmx.plugin` manifest (display name,
  description, `apiVersion`, and admin-editable settings mapped to config keys) whose `./mongo` and `./sql` exports
  contain its ready-to-mount routes, models and jobs. Includes manifest parsing and validation (`PLUGIN_API_VERSION` 1),
  settings validation, a package allow-list matcher, and a state hash for comparing installed plugin sets.
- **Plugin administration** (`BasePluginRoute`, trusted roles only): preview a package from the npm registry; add,
  upgrade, configure, enable, disable and remove plugins; and read each server's reported load status. Every change is
  audit-logged and announced on the `plugins` Redis channel. Removed plugins keep their row (marked removed) so a
  server's default plugin list never re-adds one an administrator removed.
- **`NpmRegistryClient`** reads package versions and manifests from a configurable, optionally authenticated registry
  (`system:plugins:registry`, `system:plugins:registry_token`); `system:plugins:allowed_packages` limits which packages
  may be added (default `@rapidmx/*`).
- **`PluginRegistry`** lets a server record which plugins it loaded and plugins check for each other.

### Shared mailboxes

- **Mailbox access management** (`BaseMailboxAccessRoute`): list, grant and revoke a delegate's access to a mailbox as
  viewer or manager. A grant covers every folder and item in the mailbox, and managers can manage access themselves.
- **`GET /mailboxes/lookup-by-email`** resolves an email address (primary or alias) to the person who owns that
  mailbox, for sharing UIs. Shared mailboxes never match.

### First-run setup and mailbox policy

- **Mailbox policy** (`BaseMailboxPolicyRoute`): an admin-editable default mailbox quota and self-service mailbox
  creation setting. It's seeded from `mail:default_quota_bytes` and `mail:auto_provision:*` on first use, and those
  config values remain the fallback for anything unset or if the policy can't be read. `autoProvision()` now reads it.
- **Setup state** (`BaseSetupRoute`, trusted roles only) tracks the admin console's first-run setup wizard: whether setup
  is required (a server with no domains, or a wizard that was started and not finished), the current step, completion
  and reopening. Servers that already have domains are never pulled into setup by upgrading.
- **`findOrCreateSingleton()`** for create-or-fetch of singleton settings rows.

## v0.8.0

* Fixed a critical send-after-cancel race in ScheduledSendJob: relayDueMessage() now claims the message via a version-checked clear of scheduledSendTime before calling scanAndRelay(), the same claim-first-work-second discipline DataExportJob/MailboxImportJob already use
* Restored scheduledSendTime (best-effort, re-fetching first) when the relay fails after a successful claim, preserving this job's own documented leave-it-for-retry behavior on failure
* Added findAllPages() row capping to DataExportJob.buildMboxBundle(), which previously had no size cap at all unlike its JSON sibling
* Fixed this repo's own broken lint gate: auto-fix six unnecessary-type-assertion errors via eslint --fix, manually fix two empty-function stubs in PstImportUtils.test.ts by giving them a real, harmless body matching their actual signature
* Added tests for the claim-before-relay race, the restore-on-failure path, and the double-failure (restore also fails) path, plus an mbox-format max_content_rows cap test mirroring the existing JSON one

## v0.7.0

### HIPAA / GDPR / eDiscovery compliance suite

- **Legal Hold**: matters can now place an active litigation/compliance hold on a mailbox, blocking any
  permanent (purge) delete or bulk truncate of held messages until the hold is lifted or the matter closes.
  Ordinary soft-deletes remain unaffected.
- **Audit logging expansion**: an admin or delegate reading another user's mailbox profile or message
  content is now recorded as its own audited event, distinct from the mailbox owner's own (unaudited)
  activity.
- **Configurable data retention engine**: org-wide retention policies for messages and audit log entries,
  enforced by a background job that respects any active Legal Hold and never touches the tamper-evident
  escrow audit ledger.
- **GDPR data export**: any user (or an admin on their behalf) can request a full export of a mailbox's
  content as a real, interoperable Mbox file or a JSON portability bundle, processed asynchronously and
  downloaded once ready.
- **GDPR mailbox import**: import historical mail from an Mbox or PST file into a mailbox, scanned for
  malware the same way inbound mail is.
- **GDPR right to erasure**: self-service erasure requests, admin approval/denial, and an asynchronous
  cascade that permanently removes a mailbox and everything in it (respecting any active Legal Hold) once
  approved.
- **eDiscovery enhancements**: matter holders can export or full-text search across every custodian
  mailbox in a matter, scoped to the matter's own date range, with results/exports logged to the existing
  tamper-evident escrow audit ledger.

### Encryption & key management

- **Escrow Scoping**: admin-defined escrow scopes with dual-control (M-of-N) approval for releasing
  escrowed key material, backed by a hash-chained, tamper-evident audit ledger.
- **RFC 8823 email-based ACME automation**: signing certificates can now be enrolled and renewed entirely
  over email (`email-reply-00`), including an automated driver job that advances and installs certificates
  with no manual intervention.

### Other additions

- **S3-compatible blob storage backend**, supporting custom endpoints and path-style addressing for
  MinIO/R2/Spaces-style deployments.
- **Message labels**, with mail-filter-rule support for applying a label automatically on delivery, and a
  new `label:` search operator.
- Messages can now be explicitly archived.

## v0.6.0
