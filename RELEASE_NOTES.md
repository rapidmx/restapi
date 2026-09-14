# Release Notes

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
