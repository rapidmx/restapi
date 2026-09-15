# Release Notes

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
