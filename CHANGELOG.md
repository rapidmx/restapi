# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-07

### Added
- Added EAS Sync multi-collection, RemoteWipe, and OOF fields to models

### Changed
- Eagerly provision Inbox/Drafts folders when a mailbox is created
- - BaseMailboxRoute.create() now creates the Inbox and Drafts folders immediately, since a brand-new mailbox with neither is unusable in a webmail client (MailShell/Compose both require them to exist)
- - MailboxRouteMongo/MailboxRouteSQL supply the concrete Folder class for the new provisioning step
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- DeviceSyncState gains folderCollectionClasses (remembers a synced
- collection's Class so it can be omitted on later Sync requests, per
- MS-ASCMD) and remoteWipeRequested/remoteWipeAccountOnly/
- remoteWipeAcknowledgedAt (MS-ASPROV RemoteWipe). Mailbox gains
- oofEnabled/oofMessage/oofStartTime/oofEndTime (MS-ASSettings Oof).
- oofMessage needed @Nullable despite being a required string: this
- framework's ObjectUtils.validate() treats an empty string as
- equivalent to null/undefined for any non-nullable field, and this
- field's natural default (no OOF message configured) is "". Also fixes
- a related test-helper gap in MailboxRoute.test.ts (SQL): an unset
- nullable Date column round-trips as null, not undefined, which a
- strict toEqual was treating as a real mismatch.
- These fields are consumed by the in-progress @rapidmx/activesync work
- (client-Class-omission on Sync, Provision RemoteWipe flow, Settings
- Oof) via a local portal: link, not a version bump.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Eagerly provision Calendar, Contacts, and Tasks folders when a mailbox is created
- - BaseMailboxRoute.create() now also creates the calendar/contacts/tasks well-known folders alongside the existing inbox/drafts, since the webmail client now has permanent nav destinations for each
- - Update MailboxRoute integration tests' expected folder list accordingly
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

[Unreleased]: https://github.com/RapidMX/restapi/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/RapidMX/restapi/compare/v0.1.0...v0.2.0
