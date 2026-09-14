# RapidMX: REST API

[![CI](https://github.com/RapidMX/restapi/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/RapidMX/restapi/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/RapidMX/restapi/badge.svg?branch=main)](https://coveralls.io/github/RapidMX/restapi?branch=main)
[![npm version](https://img.shields.io/npm/v/@rapidmx/restapi)](https://www.npmjs.com/package/@rapidmx/restapi)

The core data model and standard REST API for building a mail server on RapidREST. Mailboxes, folders, messages,
contacts, calendar (with external sharing and scheduling), notes/tasks, full-text search over mail/attachments,
and pluggable SPAM/anti-virus scanning.

Protocol compatibility for real mail clients lives in separate, independently-versioned packages that depend
on this one:
- [`@rapidmx/activesync-plugin`](https://github.com/RapidMX/activesync) — Exchange ActiveSync (mobile clients)
- [`@rapidmx/mapi-plugin`](https://github.com/RapidMX/mapi) — MAPI over HTTP (Outlook desktop)
- [`@rapidmx/autodiscover-plugin`](https://github.com/RapidMX/autodiscover) — Autodiscover (client server-location lookup)

This split lets each protocol evolve and version independently, and lets a deployment that only needs one of
them (e.g. just the REST API for a webmail client) skip the others' dependencies entirely.

Internet mail transport (inbound/outbound SMTP) is intentionally out of scope for this library — it hands off
to a dedicated MTA (Postfix recommended) via a narrow internal HTTP ingestion boundary. No client (Outlook/EAS/
webmail) ever speaks SMTP/IMAP/POP to this library directly.

## Usage

Pick a persistence backend by importing the matching subpath — `@rapidmx/restapi/mongo` or
`@rapidmx/restapi/sql` — alongside the protocol-agnostic root import:

```ts
import { MailboxRouteMongo, FolderRouteMongo, MessageRouteMongo } from "@rapidmx/restapi/mongo";
```

Register a `BlobStore`, `SearchProvider`, `SpamScanProvider`, `AvScanProvider`, and `MailTransport`
implementation with your application's dependency injection container before starting the server — see
`src/blob/BlobStore.ts`, `src/search/SearchProvider.ts`, `src/scan/SpamScanProvider.ts`/`AvScanProvider.ts`,
and `src/transport/MailTransport.ts` for the interfaces and their default implementations.

`@rapidmx/restapi` also exports a small set of REST-layer helpers (`resolveCallerMailboxUid`,
`sendComposedMime`, folder-tree utilities, `RecoverableRepoUtils`) from its root import — these are the same
helpers `@rapidmx/activesync-plugin`/`@rapidmx/mapi-plugin` build their own protocol layers on top of, and are useful to any
other downstream consumer that needs to resolve a caller's mailbox or relay a composed message through the
scan pipeline.

## Required deployment configuration

A handful of settings are required for correct operation and are easy to miss because nothing fails loudly
until a specific code path is hit:

- **`datastores.<name>.invalidWhereValuesBehavior: { null: "sql-null" }`** — required on every SQL (TypeORM)
  datastore. Several jobs (`AttachmentExtractionJob`, `SearchIndexJob`, `EasDeviceStateCleanupJob`) query a
  nullable "not yet processed" marker column via a literal `{ field: null }` value; without this setting,
  TypeORM throws on every run of those jobs against a SQL backend. See `test/config-defaults.ts`'s
  `sqlDatastoreConfig()` for the exact shape.
- **`mail:security:trusted_authserv_id`** — the `authserv-id` your MTA/milter (e.g. OpenDKIM) is configured to
  stamp on its own `Authentication-Results` header (RFC 8601). Required for the E2E encryption feature's
  inbound `RapidMX-Key` header processing and MDN receipt verification to trust anything at all — both fail
  closed (treat every message as unverified) when this is unset. **Your MTA MUST also be configured to delete
  any `Authentication-Results` header already present on an inbound message (which a remote sender can forge)
  before adding its own** (RFC 8601 §5) — without that, this setting alone does not prevent forgery, since a
  sender could simply also forge a matching `authserv-id`.
- **DKIM `h=` oversigning of `RapidMX-Key` and `Disposition-Notification-To`** — `specs/
  end-to-end_encryption.md` requires both headers to be included twice in your outbound DKIM signature's `h=`
  tag (RFC 6376 "oversigning") wherever this library attaches them, so a header can't be injected into a
  message that didn't originally carry one. This is a DKIM-signer configuration concern (outside this
  library's own code, which only attaches the headers) — configure your outbound MTA/DKIM signer accordingly.

## Status

This library is under active development. Phase 1 (the core data model, the standard RapidREST CRUD API, mail
ingestion/scanning/search) is complete.

This package was carved out of the former `@rapidrest/mail` monolith — see `.claude/NOTES.md` for the split's
own rationale and history.
