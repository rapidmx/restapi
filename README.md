# RapidMX: REST API

[![CI](https://github.com/RapidMX/restapi/actions/workflows/build.yml/badge.svg?branch=main)](https://github.com/RapidMX/restapi/actions/workflows/build.yml)
[![Coverage Status](https://coveralls.io/repos/github/RapidMX/restapi/badge.svg?branch=main)](https://coveralls.io/github/RapidMX/restapi?branch=main)
[![npm version](https://img.shields.io/npm/v/@rapidmx/restapi)](https://www.npmjs.com/package/@rapidmx/restapi)

The core data model and standard REST API for building a mail server on RapidREST — reachable entirely over
HTTP/S. Mailboxes, folders, messages, contacts, calendar (with external sharing and scheduling), notes/tasks,
full-text search over mail/attachments, and pluggable SPAM/anti-virus scanning.

Protocol compatibility for real mail clients lives in separate, independently-versioned packages that depend
on this one:
- [`@rapidmx/activesync`](https://github.com/RapidMX/activesync) — Exchange ActiveSync (mobile clients)
- [`@rapidmx/mapi`](https://github.com/RapidMX/mapi) — MAPI over HTTP (Outlook desktop)
- [`@rapidmx/autodiscover`](https://github.com/RapidMX/autodiscover) — Autodiscover (client server-location lookup)

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
helpers `@rapidmx/activesync`/`@rapidmx/mapi` build their own protocol layers on top of, and are useful to any
other downstream consumer that needs to resolve a caller's mailbox or relay a composed message through the
scan pipeline.

## Status

This library is under active development. Phase 1 (the core data model, the standard RapidREST CRUD API, mail
ingestion/scanning/search) is complete.

This package was carved out of the former `@rapidrest/mail` monolith — see `.claude/NOTES.md` for the split's
own rationale and history.
