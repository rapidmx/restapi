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

## Delivery failures

A sender is always told when mail they sent did not go out, with the mail system's own words:

- **A send the transport refuses** (`POST /messages/:id/send`, EAS/MAPI `sendComposedMime()`) is a **502** whose
  `message` is a plain-language sentence and whose `details` object (`MailRelayFailureDetails`) carries the per-recipient
  SMTP/enhanced status codes and responses, the transport error and what `sendmail` printed. The draft stays in Drafts.
  `MailTransport.send()` reports these through the optional `TransportResult.failures` and `.error`.
- **A failure nobody is waiting on** - `ScheduledSendJob` giving up on or refusing a message, or a transport relaying to only
  some recipients - is filed in the sender's **Inbox** as an RFC 3464 delivery status notification from
  `Mail Delivery System <postmaster@DOMAIN>`, once per failure (`util/DeliveryFailureNoticeUtils.ts`).
- **A bounce from the MTA** (Postfix accepts the message, then cannot deliver it) arrives as any inbound mail - null
  envelope sender, `From: MAILER-DAEMON@host` - at `POST /internal/mta/deliver`, and is filed in the Inbox (the MTA must hand
  such bounces to it like any other inbound mail). A message a local mailbox sent to a local address that resolves to nothing
  is dropped at the same endpoint and gets the same kind of notice.

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

## Upgrading

### SQL: 64-bit byte counts and timestamps (Postgres and MySQL/MariaDB)

`mailbox_sql.quotaBytes`/`usedBytes`, `mailbox_policy_sql.defaultQuotaBytes`/`autoProvisionQuotaBytes` and
`contact_sql.keysFirstSeen`/`lastMessageSeen` are `double precision` columns (a 32-bit `integer` can't hold a 5 GB
quota or an epoch-millisecond timestamp). With `synchronize: true`, TypeORM applies a column **type** change on
Postgres and MySQL by dropping the column and adding it again — every stored quota, used-byte count and key timestamp
is lost, and on Postgres adding the `NOT NULL` mailbox columns to a non-empty table fails at startup. SQLite rebuilds
the table with its data, so it needs nothing.

Before starting a version with these column types on an existing Postgres or MySQL database whose columns are still
integers, change them in place (TypeORM then finds nothing to change):

```sql
-- Postgres
ALTER TABLE mailbox_sql ALTER COLUMN "quotaBytes" TYPE double precision, ALTER COLUMN "usedBytes" TYPE double precision;
ALTER TABLE mailbox_policy_sql ALTER COLUMN "defaultQuotaBytes" TYPE double precision, ALTER COLUMN "autoProvisionQuotaBytes" TYPE double precision;
ALTER TABLE contact_sql ALTER COLUMN "keysFirstSeen" TYPE double precision, ALTER COLUMN "lastMessageSeen" TYPE double precision;

-- MySQL / MariaDB
ALTER TABLE mailbox_sql MODIFY `quotaBytes` DOUBLE NOT NULL, MODIFY `usedBytes` DOUBLE NOT NULL;
ALTER TABLE mailbox_policy_sql MODIFY `defaultQuotaBytes` DOUBLE NULL, MODIFY `autoProvisionQuotaBytes` DOUBLE NULL;
ALTER TABLE contact_sql MODIFY `keysFirstSeen` DOUBLE NULL, MODIFY `lastMessageSeen` DOUBLE NULL;
```

Skip any table that doesn't exist yet (it's created with the right types). A MySQL column already created as `double`
is left alone.

### SQL: long free-text columns are `text` (Postgres and MySQL/MariaDB)

A plain string column is `varchar(255)`, which MySQL rejects (strict mode) or truncates for a longer subject, preview,
note, DKIM key or error message. These columns are now `text`:

| Table | Columns |
| --- | --- |
| `message_sql` | `subject`, `bodyPreview` |
| `calendar_event_sql` | `title`, `location` |
| `note_sql` | `body` |
| `task_sql` | `body` |
| `contact_sql` | `notes` |
| `domain_sql` | `dkimPublicKey` |
| `branding_sql` | `logoUrl`, `iconUrl`, `stylesheetUrl`, `headerHtml`, `footerHtml` |
| `booking_sql` | `bookerNotes` (a `@rapidmx/booking-plugin` table since 0.12) |
| `booking_type_sql` | `description` (a `@rapidmx/booking-plugin` table since 0.12) |
| `matter_sql` | `description` |
| `escrow_scope_sql` | `description` |
| `data_export_request_sql` | `errorMessage` |
| `mailbox_import_request_sql` | `errorMessage` |
| `matter_export_request_sql` | `errorMessage` |
| `ingest_queue_entry_sql` | `errorMessage` |
| `data_subject_erasure_request_sql` | `reason` |

As with the numeric columns above, `synchronize: true` applies a `varchar` -> `text` change on Postgres and MySQL by
dropping and re-adding the column: every stored subject, preview, note body, etc. is lost, and re-adding a `NOT NULL`
column (`subject`, `bodyPreview`, `title`, note `body`) fails on a non-empty Postgres table. SQLite needs nothing.
Before starting this version on an existing Postgres or MySQL database, change the types in place:

```sql
-- Postgres
ALTER TABLE message_sql ALTER COLUMN "subject" TYPE text, ALTER COLUMN "bodyPreview" TYPE text;
ALTER TABLE calendar_event_sql ALTER COLUMN "title" TYPE text, ALTER COLUMN "location" TYPE text;
ALTER TABLE note_sql ALTER COLUMN "body" TYPE text;
ALTER TABLE task_sql ALTER COLUMN "body" TYPE text;
ALTER TABLE contact_sql ALTER COLUMN "notes" TYPE text;
ALTER TABLE domain_sql ALTER COLUMN "dkimPublicKey" TYPE text;
ALTER TABLE branding_sql ALTER COLUMN "logoUrl" TYPE text, ALTER COLUMN "iconUrl" TYPE text,
    ALTER COLUMN "stylesheetUrl" TYPE text, ALTER COLUMN "headerHtml" TYPE text, ALTER COLUMN "footerHtml" TYPE text;
ALTER TABLE booking_sql ALTER COLUMN "bookerNotes" TYPE text;
ALTER TABLE booking_type_sql ALTER COLUMN "description" TYPE text;
ALTER TABLE matter_sql ALTER COLUMN "description" TYPE text;
ALTER TABLE escrow_scope_sql ALTER COLUMN "description" TYPE text;
ALTER TABLE data_export_request_sql ALTER COLUMN "errorMessage" TYPE text;
ALTER TABLE mailbox_import_request_sql ALTER COLUMN "errorMessage" TYPE text;
ALTER TABLE matter_export_request_sql ALTER COLUMN "errorMessage" TYPE text;
ALTER TABLE ingest_queue_entry_sql ALTER COLUMN "errorMessage" TYPE text;
ALTER TABLE data_subject_erasure_request_sql ALTER COLUMN "reason" TYPE text;

-- MySQL / MariaDB
ALTER TABLE message_sql MODIFY `subject` TEXT NOT NULL, MODIFY `bodyPreview` TEXT NOT NULL;
ALTER TABLE calendar_event_sql MODIFY `title` TEXT NOT NULL, MODIFY `location` TEXT NULL;
ALTER TABLE note_sql MODIFY `body` TEXT NOT NULL;
ALTER TABLE task_sql MODIFY `body` TEXT NULL;
ALTER TABLE contact_sql MODIFY `notes` TEXT NULL;
ALTER TABLE domain_sql MODIFY `dkimPublicKey` TEXT NULL;
ALTER TABLE branding_sql MODIFY `logoUrl` TEXT NULL, MODIFY `iconUrl` TEXT NULL, MODIFY `stylesheetUrl` TEXT NULL,
    MODIFY `headerHtml` TEXT NULL, MODIFY `footerHtml` TEXT NULL;
ALTER TABLE booking_sql MODIFY `bookerNotes` TEXT NULL;
ALTER TABLE booking_type_sql MODIFY `description` TEXT NULL;
ALTER TABLE matter_sql MODIFY `description` TEXT NULL;
ALTER TABLE escrow_scope_sql MODIFY `description` TEXT NULL;
ALTER TABLE data_export_request_sql MODIFY `errorMessage` TEXT NULL;
ALTER TABLE mailbox_import_request_sql MODIFY `errorMessage` TEXT NULL;
ALTER TABLE matter_export_request_sql MODIFY `errorMessage` TEXT NULL;
ALTER TABLE ingest_queue_entry_sql MODIFY `errorMessage` TEXT NULL;
ALTER TABLE data_subject_erasure_request_sql MODIFY `reason` TEXT NULL;
```

Skip any table that doesn't exist yet. None of these columns is indexed, so no index has to be dropped first.

### New indexes, and a unique Focused Inbox override per sender (all backends)

New indexes are created automatically at startup (TypeORM `synchronize` / `MongoSchemaSync`); on a large `message_sql` /
`message_mongo` table expect the first start to take a while. One existing index changes meaning:
`focusedinboxoverride_mailbox` on (`mailboxUid`, `senderAddress`) is now **unique**. If a mailbox already has two
overrides for the same sender, index creation fails at startup. Remove the duplicates first (keeps the most recently
modified row per sender):

```sql
-- Postgres
DELETE FROM focused_inbox_override_sql a USING focused_inbox_override_sql b
 WHERE a."mailboxUid" = b."mailboxUid" AND a."senderAddress" = b."senderAddress"
   AND (a."dateModified" < b."dateModified" OR (a."dateModified" = b."dateModified" AND a.uid < b.uid));

-- MySQL / MariaDB
DELETE a FROM focused_inbox_override_sql a JOIN focused_inbox_override_sql b
    ON a.`mailboxUid` = b.`mailboxUid` AND a.`senderAddress` = b.`senderAddress`
   AND (a.`dateModified` < b.`dateModified` OR (a.`dateModified` = b.`dateModified` AND a.uid < b.uid));

-- SQLite
DELETE FROM focused_inbox_override_sql WHERE EXISTS (
    SELECT 1 FROM focused_inbox_override_sql b
     WHERE b.mailboxUid = focused_inbox_override_sql.mailboxUid
       AND b.senderAddress = focused_inbox_override_sql.senderAddress
       AND (b.dateModified > focused_inbox_override_sql.dateModified
            OR (b.dateModified = focused_inbox_override_sql.dateModified AND b.uid > focused_inbox_override_sql.uid)));
```

```js
// MongoDB (mongosh)
db.focused_inbox_override_mongo.aggregate([
    { $sort: { dateModified: -1 } },
    { $group: { _id: { m: "$mailboxUid", s: "$senderAddress" }, ids: { $push: "$_id" } } },
    { $match: { "ids.1": { $exists: true } } },
]).forEach((g) => db.focused_inbox_override_mongo.deleteMany({ _id: { $in: g.ids.slice(1) } }));
```

MySQL's default collation compares case-insensitively, so there `Sender@x` and `sender@x` also count as duplicates;
overrides written by the server itself are already lowercased.

## Status

This library is under active development. Phase 1 (the core data model, the standard RapidREST CRUD API, mail
ingestion/scanning/search) is complete.

This package was carved out of the former `@rapidrest/mail` monolith — see `.claude/NOTES.md` for the split's
own rationale and history.
