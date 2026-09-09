# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.1] - 2026-09-09

### Added
- Added an IANA's Special-Use Domain Name now skips validation and is automatically set as verified

### Changed
- Cleaning up contributors
- Updated readme

## [0.3.0] - 2026-09-09

### Added
- Added BaseMailboxRoute.autoProvision()/listDomains() and enforce the mail:domains allowlist in create()
- Added mail:auto_provision:static_aliases as a bypass for consumers with no reachable auth-server, e.g. a dev-mode server that can't self-fetch its own listening address mid-request
- Added TaskList entity (mailboxUid, name) as a direct structural copy of ContactList, with full mongo+sql CRUD routes and permission tests
- Added Task.taskListUid/assignedTo, Contact.categories, and Folder.color fields
- Added Contact.favorite/Task.myDay as optional fields instead of required-with-default, since a required boolean with only a TS-level default breaks real SQL schema migration against existing rows
- Added MailFilterRule entity (mailbox-scoped inbox rules: conditions, ordered actions, stopProcessingRules), evaluated in ScanQueueJob against newly-delivered mail with move/copy/delete/mark-as-read/forward actions
- Added Message.scheduledSendTime and a deferred-send branch in BaseMessageRoute.send() that moves the message to Outbox instead of relaying, plus a new ScheduledSendJob that relays due messages
- Added MailSignature entity (roaming, OWA-style) with a resolveDefaultSignature() helper for composing clients to share
- Added automatic out-of-office replies via resolveActiveOof(), combining Mailbox.oofEnabled with a new CalendarEvent.autoReplyEnabled/autoReplyMessage window, isAutoReplyEligible() for RFC 3834 loop prevention, and a new OofReplySuppression entity with OofReplySuppressionCleanupJob to throttle repeat replies per sender
- Added src/util/IcsUtils.ts for hand-rolled RFC 5545/5546 ICS generation and parsing (buildEventIcs/parseIcsEvent), including RRULE/EXDATE for master events, RECURRENCE-ID for single-occurrence overrides, and TZID conversion via Node's built-in Intl
- Added MeetingSchedulingJob support for sending iTIP REQUEST invites on CalendarEvent create/update (tracked via inviteSequenceSent) and CANCEL notices on cancellation/deletion (tracked via cancelNoticeSentAt), with recurring-series-aware de-duplication
- Added inbound iTIP processing to ScanQueueJob, detecting a text/calendar part and processing REQUEST (create/update the recipient's calendar entry), REPLY (update the organizer's attendee status), and CANCEL (soft-delete one occurrence or the whole series)
- Added BaseCalendarEventRoute auto-bumping of sequence on scheduling-relevant updates and a POST /:id/respond endpoint so a REST client can accept/decline/tentative without parsing email, always sending a real iTIP REPLY to the organizer
- Added a mail-enabled DistributionList entity (admin-only CRUD) whose membership can include internal mailboxes, nested lists, and genuinely external addresses
- Added recursive inbound list expansion with a cycle guard and depth cap, fanning out to internal members via one Reply-To/List-Id/List-Unsubscribe-rewritten copy and relaying directly to external members via MailTransport
- Added unsubscribe handling: a member emailing the list with Subject: unsubscribe is removed and gets a confirmation
- Added an admin-only TransportRule entity evaluated once per SMTP transaction in BaseMailIngestRoute.deliver(), before per-recipient resolution/fan-out, separate from the mailbox-scoped MailFilterRule that runs later per-recipient in ScanQueueJob
- Added TransportRule conditions mirroring MailFilterRule's substring-match model (from/subject/body/recipient contains, hasAttachment, attachment name) plus an anyRecipientExternal check against mail:domains
- Added reject, quarantine, add_header, and add_recipient transport-rule actions, with quarantine stamping IngestQueueEntry.quarantineReason so ScanQueueJob forces that verdict once scanning completes
- Added MimeHeaderUtils.ts, extracting the raw-MIME header read/rewrite primitives shared by distribution lists and transport rules
- Added isResource/resourceType/autoAcceptBookings/allowConflicts/bookingWindowDays/maxDurationMinutes fields to Mailbox so it can represent a bookable resource, mirroring Exchange's room/equipment auto-processing
- Added automatic accept/decline of inbound iTIP REQUESTs to resource mailboxes in ScanQueueJob, via a new expandOccurrences() RRULE occurrence expander that checks duration/booking-window policy and full recurring-series conflict detection
- Added BaseMessageRoute.recall(), composing an X-RapidMX-Recall-Of control message to a sent message's original recipients
- Added recall handling to ScanQueueJob, deleting the recipient's still-unread copy (leaving a read copy alone) and reporting the outcome back to the sender as a plain email
- Added Message.conversationId, computed once at creation time from References/In-Reply-To/Message-ID via a new deriveConversationId() utility, populated on both ingest (ScanQueueJob) and send (MailSendUtils)
- Added BaseMessageRoute.conversations(), a mailbox-wide endpoint that groups messages by conversationId across every folder, mirroring BaseFolderRoute.find()'s mailbox-level ACL check
- Added a durable AuditLogEntry (Mongo/SQL) recorded for DistributionList/TransportRule create/update/delete, trusted-caller Mailbox creation, and Message delete/recall, mirrored through EventUtils.record()
- Added a read-only audit-log route that blocks writes for every caller including admins, since ACLUtils.hasPermission() bypasses class ACL for trusted users and a deny-all grant alone can't stop them
- Added a DB-backed, admin-managed Domain entity with full CRUD, replacing the static mail:domains config everywhere it was consulted with one consistent enabled-and-verified definition
- Added TXT-record-token domain ownership verification, checked periodically by DomainVerificationJob and on demand via a manual verify action, both through a pluggable DnsResolver interface
- Added a read-only GET /:id/dns-setup endpoint that computes and live-checks the MX/SPF/DKIM/DMARC records a domain needs beyond ownership proof
- Added DnsResolver.resolveMx() alongside the existing resolveTxt()
- Added mail:dns:mx_hostname config, driving the MX/SPF recommendations for every domain
- Added DKIM/DMARC recommendation support without ever generating or storing key material, since an admin supplies the selector and public key from their own MTA/OpenDKIM setup
- Added MessageClassification enum (focused/other) and an optional Message.inferenceClassification field, absent meaning treat as Focused for existing mail
- Added FocusedInboxOverride entity (mailboxUid + senderAddress -> classifyAs) with a compound index and a deny-all class ACL, managed through a BaseScopedChildRoute scoped to the owning mailbox
- Added FocusedInboxUtils.classifyMessage() as a pure function with precedence explicit override, then bulk/automated indicators, then internal sender, then known correspondent, then spam score, defaulting to Focused
- Added lazy classification in ScanQueueJob.deliverMessage() that short-circuits for junk-routed and non-Inbox mail before any of the three extra lookups run
- Added a ScanPipeline raw-header reader for listUnsubscribeHeader, since mailparser folds every List-* header into one structured list key
- Added POST /messages/:id/classify with { classifyAs, applyToSender } for the Always move to Other gesture
- Added BookingType/Booking entities (Mongo + SQL) with a deny-all class ACL, since anonymous access is granted only by the public route resolving a slug or manageToken, never through the ACL system
- Added FreeBusyUtils.computeBusyWindows(), lifting the conflict-detection core out of ScanQueueJob.decideResourceBooking() into a reusable pure function that also filters cancelled/free-status events
- Added BookingUtils.generateCandidateSlots()/subtractBusy() as pure slot-math functions, converting local availability windows to UTC via the now-exported IcsUtils.convertLocalToUtc() so a 09:00 window stays 09:00 local across a DST transition
- Added BaseBookingTypeRoute as the host's ordinary mailboxUid-scoped BaseScopedChildRoute CRUD, with slug normalization/collision checking and availability validation
- Added BaseBookingRoute as the anonymous half, built in the shape of BaseMailIngestRoute with its own repos and ignoreACL: true throughout, wrapping the CalendarEvent+Booking write pair in @Transactional() and rate-limiting its three mutating endpoints
- Added Gmail-style plus-addressing so user+tag@domain.com resolves to mailbox user@domain.com at delivery time
- Added AddressUtils.stripPlusTag(), stripping everything from the first + in the local part onward without touching the domain
- Added a third fallback tier to BaseMailIngestRoute.findMailboxByAddress(): exact primarySmtpAddress, then exact aliasAddresses, then both again against the plus-stripped base address, with exact matches always winning first
- Added mail:plus_addressing:enabled config, default on
- Added an admin-managed, publicly-readable Branding record (logo, product title/company name, stylesheet, web-client UI chrome) for a downstream server or web client to render
- Added Branding as a singleton entity (fixed uid: branding), created lazily on the first admin write, with a deny-all class ACL since the public read is a route-level decision, not an ACL grant
- Added BaseBrandingRoute as a bespoke class mixing BaseBookingRoute's unauthenticated public reads with BaseDomainRoute's @RequiresTrustedRole() admin writes and recordAuditLog() usage
- Added logoUrl/stylesheetUrl support for both a plain external URL and an upload through POST /branding/logo or /branding/stylesheet, storing the file via BlobStore and cleaning up the replaced blob when switching modes
- Added a genuine RFC 3798 Message Disposition Notification implementation on both the generating and parsing sides, so the indicator mechanism works regardless of who generated the receipt
- Added util/ReceiptUtils.ts, building and parsing real multipart/report report-type=disposition-notification messages via nodemailer's MimeNode builder, using Disposition displayed for read receipts and processed for delivery receipts
- Added Message.requestReceipt and Mailbox.alwaysRequestReceiptInternal/External so send() attaches Disposition-Notification-To when it applies to any recipient and seeds one receiptStatus roster entry per recipient
- Added Mailbox.autoSendReceiptsInternal/External, classified via the new DomainUtils.isInternalAddress(), auto-sending or holding a receipt pending approval via POST /:id/receipt/approve or /decline
- Added delivery-receipt generation to ScanQueueJob at delivery time and inbound-MDN detection correlated by (mailboxUid, messageId) and Final-Recipient, never filing the MDN as a visible message
- Added BaseMessageRoute's update() override to trigger the read receipt on flags.read's first false-to-true transition

### Changed
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Change Mailbox/DistributionList uid to derive from the entity's own address instead of a random id, closing a cross-entity address-collision gap
- Upgrade @rapidrest/service-core to ^1.5.0 for @RequiresTrustedRole(), replacing hand-rolled trusted-role checks with the framework's own decorator
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Changing in-process db query filtering to use db-native query filtering
- Upgraded @rapidrest/service-core to 1.6.0
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Note known limitations: the double-booking race is narrowed but not closed, manageToken has no expiry/GC job, and recurring busy blocks inherit expandOccurrences()'s DST-naivety
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Changed `IcsUtils.formatDateUtc()` to take a `Date` or `string`. This fixes an issue with documents retrieved from MongoDB that return as strings.
- Note this is scoped to mailbox delivery-routing only, not authentication/login and not DistributionList addresses, since the delivered message's To: header is parsed independently and untouched by this routing change
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Updated claude intsructions regarding commit messages
- Updated CI build workflow
- Upgraded all dependencies

### Fixed
- Fixed ScanQueueJob hardcoding Message.subject/bodyPreview to empty strings instead of using the values ScanPipeline already parsed
- Fixed ScheduledSendJob silently failing to clear scheduledSendTime on the SQL backend, since TypeORM's Repository.update() skips undefined properties and only an explicit null clears a column
- Fixed scanAndRelay() to guarantee every message has a Message-ID before relay, generating and injecting one when the composing client didn't set it, applied consistently for both immediate sends and ScheduledSendJob
- Fixed ScanPipeline to strip angle brackets from In-Reply-To/References/Message-ID consistently, since mailparser left them bracketed unlike this library's own send-side normalization, which would have silently broken conversation grouping and recall()'s cross-mailbox Message-ID matching
- Fixed a latent case-sensitivity bug in domain matching, surfaced by moving to real lowercase-normalized Domain rows instead of static config
- Fixed CI publish job
- Fixed @rapidrest/service-core's @RateLimit decorator never calling next() on its success path, upgrading to 1.7.1
- Fixed GET /branding to never 404, returning all-empty defaults before anything has been configured
- Fixed ScanQueueJob.processReceipt() trusting an inbound MDN's claimed Final-Recipient without checking it matched the message's actual envelope sender, letting anyone who could email a mailbox forge fake delivery/read receipts for arbitrary addresses
- Fixed declining a pending receipt not durably sticking, since marking a message unread then read again re-triggered the same hold-for-approval flow it was meant to close
- Fixed a distribution list whose address contained a plus sign being silently shadowed by an unrelated mailbox via the plus-addressing fallback, since mailbox resolution ran before the distribution-list check
- Fixed the same plus-addressing fallback letting a sender evade a transport rule scoped to a specific recipient by tagging the address
- Fixed a legally-folded Original-Message-ID header corrupting MDN-to-message correlation
- Fixed duplicate recipient addresses seeding duplicate, unmergeable receipt-status rows
- Fixed a narrow TOCTOU race on the branding singleton's create-if-missing during the very first concurrent write

### Removed
- Removed a dead, unreachable !aclRepo guard in MailboxRouteMongo/SQL's findAccessibleMailboxUids(), closing a lines-coverage gap that had persisted across sessions

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

[Unreleased]: https://github.com/RapidMX/restapi/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/RapidMX/restapi/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/RapidMX/restapi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/RapidMX/restapi/compare/v0.1.0...v0.2.0
