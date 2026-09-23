# Release Notes

## Unreleased

## v0.20.0

### Security

- **Closed a federation key-discovery SSRF bypass via decimal/octal/hex IP notation.** `util/KeyDiscoveryClient.ts`'s `isSafeDiscoveryHost()` rejected an IP-literal `host` (from a remote domain's
  `_rapidmx` TXT record) using `net.isIP()` alone, which doesn't recognize non-dotted-quad encodings (e.g. the decimal form `2852039166` for `169.254.169.254`, the cloud metadata address) that
  Node's `fetch()`/the WHATWG `URL` parser still normalize to the real address with no DNS lookup. The check now also re-validates the URL-parser-normalized hostname, closing the bypass regardless
  of encoding, and restricts the port a discovery host may specify to a small allow-list (443/8443) instead of the full 1-65535 range. The existing DNS-rebinding residual gap (a public hostname
  whose own DNS answer resolves to a private address) remains open and documented - it needs a separate DNS-pinning mechanism, out of scope for this fix.
- **Fixed a mail hijack via alias-domain addresses.** `BaseMailboxRoute.validateAliasChange()` still checked a new `aliasAddresses` entry against `getVerifiedDomainNames()` (which includes pure
  alias domains) instead of `getPrimaryDomainNames()` (which excludes them, matching every other address check in this file) - a caller could add e.g. `boss@plc.gg` (a pure alias of
  `powerlevel.gg`) directly to their own mailbox's `aliasAddresses`, hijacking mail/send-as/key-discovery for whatever mailbox `boss@powerlevel.gg` actually resolves to. `createMailboxes()` now
  applies the same non-alias-domain restriction to `aliasAddresses` supplied at create time (previously only checked on `primarySmtpAddress`), for both trusted and self-service callers.
- **The public federation key-discovery endpoint now resolves alias domains.** `GET /.well-known/rapidmx/keys/:hash` matched a candidate mailbox's domain against the requester's `?domain=`
  literally, with no way to resolve an alias domain to its primary - since no mailbox is ever addressed on a pure alias domain, a remote peer querying for `you@plc.gg` always got a false "key not
  published" even though `you@powerlevel.gg` has one published, which could cause a compose client to send unencrypted. The route now falls back to resolving `?domain=` via `Domain.aliasOf`
  (`resolveDomainAliasName()`, a new `util/DomainUtils.ts` export factored out of `resolveDomainAlias()`) and re-matching against the primary domain when the literal match misses.
- **Mailbox storage quota is now enforced at write time on attachment upload and inbound mail delivery, not just reconciled hourly after the fact.** New `util/MailboxQuotaUtils.ts`
  (`chargeMailboxQuota()`/`refundMailboxQuota()`) extracts and generalizes `MailboxImportJob`'s own version-checked charge/refund loop; `BaseAttachmentRoute.upload()` now charges an attachment's
  size against its mailbox before writing to the `BlobStore`, rejecting (413) once the mailbox's quota would be exceeded and refunding the charge if the write then fails, and also rejects (413)
  a single upload above a new configurable `mail:attachments:max_bytes` ceiling before ever touching the blob store or the quota. `ScanQueueJob`'s inbound-delivery path (`deliverMessage()`) now
  charges the same way before filing an inbound message - previously the exact same unauthenticated-sender vector `BaseAttachmentRoute.upload()`'s own fix closes for an authenticated caller was
  left wide open on the inbound side, where no authentication is required at all and any external sender could flood a mailbox past quota. An inbound message that would exceed quota is
  quarantined (new `QuarantineReason.QUOTA_EXCEEDED`) rather than silently dropped or filed over quota; a `mailboxUid` with no current `Mailbox` row (a handful of ingest paths never required
  one before this) skips quota enforcement gracefully instead of failing delivery outright, logged at `debug`. `MailboxImportJob` itself is refactored onto the shared utility with no behavior
  change.
- **A mailbox import upload is now actually capped in size before any processing starts.** `BaseMailboxImportRoute.create()` accepted an uploaded PST/mbox file of any size (only a non-empty
  check). A new configurable `mail:import:max_bytes` ceiling now rejects (413) an oversized upload up front - but the first version of this fix shipped a default (500 MiB) comfortably ABOVE
  the reference `server` deployment's own framework-level `max_body_size` (100 MiB), which is enforced on every request's raw body before this route's own check - or any route code at all -
  ever runs; every upload large enough to hit the 500 MiB check would already have been rejected by that coarser, generic 413 first, making the new check protect against nothing in the shipped
  default configuration. `BaseMailboxImportRoute.init()` logs a one-time warning if an operator's own `mail:import:max_bytes` override ends up at or above whatever `max_body_size` is actually
  configured, so this class of misconfiguration doesn't go silently unnoticed. The default is now 200 MiB - an interim, deliberately round number, not a fix for the underlying constraint: see
  the new "Known Issues" entry below on the upload itself still being fully buffered into memory regardless of this value.
- **`MailboxImportJob`'s own memory footprint for a large PST/Mbox import is fixed - separately from the upload issue above.** `MailboxImportJob.run()` used to `blobStore.get()` the WHOLE
  source file into one `Buffer`, then `PstImportUtils.extractPstMessages()`/`MboxUtils.parseMbox()` eagerly reconstructed and collected EVERY extracted message into a second, often-larger
  `Buffer[]` before importing any of them - untenable for a genuinely large real-world PST (tens of GB is not unusual for a never-archived mailbox). `extractPstMessages()`/`parseMbox()` are now
  `AsyncGenerator`s, `for await`-ed one message at a time and immediately persisted-or-discarded rather than collected; both now read directly off a real file path instead of a `Buffer`
  (`pst-extractor`'s own `PSTFile` already supports random-access reads straight off a file descriptor - confirmed by reading its source, not assumed) via a new `BlobStore.localPath()` (optional;
  `LocalFsBlobStore` returns the blob's own real path directly, `S3BlobStore` returns `undefined`, falling back to one streamed-to-a-temp-file pass instead of a full buffer either way). A
  multi-GB *stored* import file no longer needs a correspondingly large amount of memory resident at once to process - only the getting of the file into storage in the first place remains
  memory-bound, tracked separately (see "Known Issues").
- **The mailbox import upload itself is now genuinely streamed, closing out the PST-import size limitation for good.** Bumped `@rapidrest/service-core` to `^2.2.0`, which adds opt-in streaming
  request bodies (`{ streamingBody: true }`/`@StreamingBody()`, exposing the raw body as a backpressure-aware `req.bodyStream` instead of buffering it into `req.body`/`req.rawBody` first).
  `BaseMailboxImportRoute.create()` is now decorated `@StreamingBody()` and pipes `req.bodyStream` straight into `BlobStore.put()` (both `LocalFsBlobStore` and `S3BlobStore` already stream a
  `NodeJS.ReadableStream` argument to their own backing store) - the upload is never buffered into a Node `Buffer` at any point, for either backend. Size is enforced against the actual streamed
  byte count rather than a post-buffering check that no longer exists: a `Content-Length` header, when the client sends one, is checked up front (before `req.bodyStream` is touched or any
  mailbox/folder lookup runs, the same ordering this check has always had); independently, a running byte count kept while consuming the stream aborts the upload - cleaning up the partial blob -
  the moment it exceeds `mail:import:max_bytes`, so a client that lies about (or omits) `Content-Length` is still bounded. `DEFAULT_MAX_IMPORT_BYTES` is raised from 200 MiB to 50 GiB now that the
  memory-safety reason for a small number no longer applies - a genuine 20GB+, never-archived PST is not unusual, and this ceiling now exists only to cap disk usage and upload duration, not to
  protect process memory. This route never used `@Validate`/`before`/`after` (which don't see `req.body` on a streaming route), so no validation needed to move.
- **The uploaded source blob behind a mailbox import request is now actually deleted once the request is done being processed, on every outcome.** `MailboxImportJob` read the blob back
  (`resolveLocalSourcePath()`) but never deleted it - success, failure, or quota rejection all left it permanently orphaned in blob storage forever (the only other caller that ever deletes a
  `sourceBlobKey` blob is `ErasureExecutionJob`, on GDPR erasure alone). Raising `mail:import:max_bytes` to 50 GiB in the streaming-upload fix above made this dramatically worse in the same
  change that fixed the memory problem: an authenticated self-service user could already fire off unbounded concurrent uploads with no per-user pending-request cap, and each one now permanently
  consumed up to 50 GiB of real storage regardless of what happened to the request. `processRequest()` now deletes the source blob in a `finally` block covering every outcome (mailbox/folder
  gone, success, per-message failure, quota rejection); `reclaimAbandonedRequests()`'s own separate "gave up after max_attempts" terminal path - the one outcome that never calls
  `processRequest()` at all - deletes it the same way at its own call site.
- **Mailbox storage quota is no longer bypassed entirely at import-upload time.** `BaseMailboxImportRoute.create()` only ever enforced the flat `mail:import:max_bytes` ceiling - never the
  target mailbox's own `quotaBytes`/`usedBytes` - so a mailbox already at or near its quota could still have up to 50 GiB streamed into blob storage (consuming real disk/S3/egress/wall-clock
  time) before `MailboxImportJob.persistImportedMessage()`'s own per-message quota check got its first chance to reject even one message, potentially not for another ~30 seconds (this job's own
  schedule). `create()` now rejects outright (413) when the target mailbox has already reached its quota, and separately rejects a declared `Content-Length` that exceeds the mailbox's remaining
  quota, both before `req.bodyStream` is ever touched; a running byte count during the stream itself aborts (cleaning up the partial blob) the moment it would clearly exceed what remains. This
  is deliberately a coarse, read-only sanity gate against the mailbox's already-fetched row, not a real charge - `MailboxImportJob`'s own per-message charge remains the one accurate place
  `Mailbox.usedBytes` is actually written for an import, since a raw PST's upload byte count has no fixed relationship to its eventual reconstructed message sizes.
- **Note for operators:** `S3BlobStore`'s streamed `put()` (used for both attachment/message blobs and, since the change above, mailbox imports) uses S3's multipart upload, capped by S3 itself
  at 10,000 parts per object. At the default 8 MiB `mail:blob:s3:multipart_part_size_bytes`, that's an 80 GiB object before hitting it - comfortably above the new 50 GiB `mail:import:max_bytes`
  default - but an operator who lowers the part size well below its default while also raising `mail:import:max_bytes` further could still hit the 10,000-part ceiling on a large upload; neither
  value is cross-validated against the other.
- **Closed an `in(...)`-operand injection in `BaseDataExportRoute.find()`/`BaseMailboxImportRoute.find()`.** Both built their own visible-mailbox filter as a raw `` `in(${ownedMailboxUids.join(",")})` `` -
  unlike every sibling route in this family (`BaseMatterRoute`, `BaseEscrowAccessRequestRoute.find()`, `BaseEscrowAuditLogRoute`, `BaseMatterExportRequestRoute.find()`), which all use
  `exactInFilter()`/`isQuerySafeUid()` specifically because `ModelUtils.splitListOperand()` splits an `in(...)` operand on unescaped commas. Confirmed exploitable, not just defense-in-depth:
  `BaseMailboxRoute.create()` doesn't strip a client-supplied `uid` field, so a self-service caller could create their own mailbox with `uid: ",<victim-mailbox-uid>"`, then `GET
  /data-export-requests` (or `/mailbox-import-requests`) - the resulting filter parses as `["", "<victim-uid>"]`, matching the victim's mailbox exactly and leaking every export/import request
  made for it (status, format, dates, `blobKey` included). Both routes now build this filter with `exactInFilter()`, the same guard the sibling routes already use. Not fixed in this pass (flagged
  as the bigger, separate root enabler): `BaseMailboxRoute.create()` still doesn't strip a client-supplied `uid` the way `BaseMatterRoute.create()`/`BaseEscrowScopeRoute.create()` do.
- **Fixed an authorization-ordering bug in `BaseEscrowAccessRequestRoute`** where `create()`/`approve()`/`material()` checked request/matter STATE (closed/pending/approved) BEFORE calling
  `requireEscrowHolder()`, unlike `deny()`/`findById()` in the same class and every sibling class (`BaseMatterRoute`, `BaseMatterExportRequestRoute`, `BaseMatterSearchRoute` - all holder-check-
  then-state-check). This turned all three into oracles for anyone who knew or guessed a request/matter id, holder or not: `create()` revealed a matter's open/closed state via 400-vs-proceeding,
  `approve()` revealed a request's pending/not-pending status via a distinguishable 409, and `material()` revealed precisely when someone else's mailbox met its dual-control key-release threshold
  via a distinguishable 403 message - all before any holder check ran. All three now call `requireMatter()`/`requireEscrowHolder()` first, matching `deny()`/`findById()`'s already-correct order -
  a non-holder now gets the exact same uniform 403 regardless of the underlying state. (`deny()` itself deliberately still allows denying a request under a closed matter - "holders can clean up
  stragglers" - a pre-existing, intentional inconsistency with the other three, not a bug; left as-is.)
- **`MailPushRoute.send()` no longer republishes a message's own `from` field unchecked.** `BasePushRoute.send()` (`@rapidrest/service-core`) forwards a published message to every channel
  subscriber completely verbatim once the publisher holds `CREATE` on the channel - nothing validates the message BODY itself. At least one real consumer of this shared push channel (a WebRTC-
  signaling plugin) trusts a message's own `from` field as the identity of whoever sent it, with no check of its own - letting any channel participant (including a low-trust anonymous guest)
  forge a `bye`/presenter-claim/offer "from" another participant, with every other client applying it as genuine (e.g. silently dropping the victim from a call). `send()` now rejects (400) a
  message whose `from` field (when present at all) doesn't equal the authenticated caller's own uid - property-agnostic (checks `from` alone, never any consumer-specific field or message
  `type`), so it protects every current and future consumer of this route, not just that one.
- **Permanently-deleted mail no longer stays searchable forever.** `BaseScopedChildRoute`'s `delete()` (on `?purge=true`) and `truncate()` (always a hard delete) never removed the deleted
  record from the full-text search index - `util/SearchIndexUtils.ts`'s own doc comment already says every hard-delete/purge path must do this (erasure/retention/quarantine-retention/recall
  already did), but the two most ordinary paths, an individual route-level delete and a bulk truncate, didn't. A purged message's subject/body/attachment text/participants stayed a live search
  hit indefinitely, with OpenSearch even serving a snippet built from content that no longer existed - nothing ever revisited it. New opt-in `BaseScopedChildRoute.searchEntityType` (set by
  `BaseMessageRoute` to `"message"`, the one entity type actually indexed today; every other `BaseScopedChildRoute` subclass leaves it unset and is unaffected) drives a
  `removeFromSearchIndex()` call from both paths. An ordinary (non-purge) `delete()` is deliberately left alone - it's still recoverable, so it stays indexed too.
- **Search results no longer go stale after a message is moved, flagged, or labeled.** `Message.searchIndexedAt` was only ever cleared by `AttachmentExtractionJob` (new attachment text to
  index) - `BaseScopedChildRoute.update()`/`BaseMessageRoute.prepareUpdate()` never touched it, and `SearchIndexJob` only re-indexes a message once, on `searchIndexedAt: null`. Since each
  provider's index document embeds `folderUid`/`flags`/`labelUids` directly rather than re-reading them live at query time, moving a message to another folder left it findable under `in:<old
  folder>` and invisible under `in:<new folder>` forever, and marking read/unread/flagged or changing labels left `is:unread`/`is:flagged`/`label:` permanently wrong. `prepareUpdate()` now
  clears `searchIndexedAt` whenever `folderUid`/`flags`/`labelUids` actually change, so `SearchIndexJob` picks the message back up on its next pass.
- **eDiscovery review search (`BaseMatterSearchRoute.search()`) no longer silently drops messages dated exactly on a legal hold's boundary day.** It clamps a caller's `before`/`after` to the
  matter's own `dateRangeStart`/`dateRangeEnd`, but every `SearchProvider` treats `before`/`after` as EXCLUSIVE (`< before`, `> after`), while this codebase's own authoritative definition of
  matter coverage (`LegalHoldUtils.matterCovers()`) is INCLUSIVE on both ends - a message dated exactly at the boundary was silently excluded from a holder's review search even though it was
  genuinely within scope. The clamp now nudges 1ms past each boundary before handing it to the provider, compensating for the exclusive comparison without changing what a caller's own
  (already-narrower) `before`/`after` means.
- **`BaseSearchRoute`/`BaseMatterSearchRoute` no longer 500 on a repeated structured-filter query key.** `?types=a&types=b` (or `is=`/`label=`/`participants=`) parses to a real array at runtime
  regardless of these routes' own `string | undefined` parameter types, and every one of them was immediately handed to `.split(",")`, throwing an uncaught `TypeError`. Both routes now reject
  (400) a structured filter param that isn't a single string, the same `typeof x !== "string"` guard `BaseScopedChildRoute.ts` already uses elsewhere for the identical mismatch.
- **A `DistributionList`'s `aliasAddresses` are now validated exactly like a `Mailbox`'s.** `BaseDistributionListRoute` accepted `aliasAddresses` with no domain check, no alias-domain check and
  no collision check at all, even though `BaseMailIngestRoute` resolves and trusts a distribution list's `aliasAddresses` identically to a mailbox's - a caller could add any address on any
  domain (including another mailbox's or list's existing address, or a pure alias domain that should never carry its own addresses) to a distribution list's `aliasAddresses` with no
  validation whatsoever. `create()`/`update()` now apply the same `getPrimaryDomainNames()`-based domain restriction and cross-mailbox/cross-list collision check `BaseMailboxRoute` already
  applies to its own `aliasAddresses`.
- **Fixed a `RetentionEnforcementJob` pagination bug that could silently skip a due row.** `purgeSortedBatches()`'s offset-based pagination (`page = floor(skipped/pageSize)`, slicing away
  `skipped % pageSize` rows assumed still at the front of the result set) broke when a `delete()` call threw AFTER its write had actually committed (e.g. a network timeout post-commit): the next
  page's leading fresh row got sliced away as if it were the phantom skip, so it was never examined that run. Switched to keyset pagination on `uid` (the same cursor pattern
  `util/MailboxContentUtils.ts`'s `findPagesByUid()` already uses elsewhere in this file), which has no such assumption to get wrong.
- **An iTIP REPLY/CANCEL/REQUEST-update version conflict is now significantly less likely to be silently dropped under contention.** Two attendees replying to the same invite near-simultaneously
  (an ordinary race) meant the optimistic-lock loser's 409 on a plain `update()` was only ever `logger.warn()`'d - the RSVP/cancellation was silently lost even though the ingest entry closed
  `DELIVERED`. `ScanQueueJob`'s `processItipReply()`, `processItipCancel()` (including `deleteReceivedEventCopy()`) and the REQUEST-update branch of `processItipRequest()` now re-fetch and retry
  (up to 3 attempts) on a version conflict, the same shape `claimDeliveryReceipt()`/`writeContactKeys()` already use elsewhere in this file for exactly this race - this closes the common case but
  not the underlying possibility: sustained contention that exhausts all 3 attempts still ends in the same outcome as before (the ingest entry still closes `DELIVERED`, the update is still
  lost), now logged at `logger.error()` instead of `logger.warn()` so it's operator-visible/alertable rather than silent, but not otherwise different in effect.
- **A duplicate-delivered iTIP REQUEST can no longer create two `CalendarEvent` rows.** The new-event branch of `processItipRequest()` used a random `uid`, unlike the ordinary message-delivery
  path's deterministic `nameBasedUuid('ingest:' + entry.uid + ':target')` - a duplicate-delivered REQUEST (ordinary SMTP at-least-once retry semantics), processed concurrently as two
  `IngestQueueEntry` rows, could create two `CalendarEvent` rows for the same meeting and double-fire booking accept/decline replies. The uid is now derived deterministically from
  `(mailboxUid, icalUid, recurrenceId)`, so a second concurrent create collides on the unique index instead of succeeding twice.
- **`isPathKey()` (and so `assertNoPathKeys()`/`stripClientCreateFields()`) now also flags `__proto__`/`constructor`/`prototype`** as unsafe keys, defense-in-depth against its own documented
  contract - not currently exploitable (every write path here uses object spread, not `Object.assign`), but closed against a future write path that wouldn't be.
- **Three routes' own client-query `$`-operator stripping is now segment-aware, matching the rest of the codebase.** `BaseMatterRoute.stripClientQuery()`, `BaseEscrowAccessRequestRoute.find()`
  and `BaseEscrowAuditLogRoute.buildFilter()` used a top-level-only `!key.startsWith("$")` check instead of the segment-aware `!key.split(".").some((s) => s.startsWith("$"))` already used in
  `BaseScopedChildRoute`/`BaseFolderRoute`/`BaseMailboxRoute`/`BaseAttachmentRoute` - a nested operator key like `escrowScopeId.$where` could slip past these three routes' own filtering
  unstripped. Not currently exploitable (`service-core` 2.1.0's `ModelUtils` independently re-validates with the same segment-aware check before it could reach a real query), but a real
  inconsistency, now fixed to match.
- **`X-Envelope-From`/`X-Envelope-To` are now percent-decoded**, matching the MTA-side ingest client's own new encoding of each envelope address before joining them into these headers (see
  `transport/MTAIngestAdapter.ts`'s updated contract doc). Without this, a `,` occurring inside a quoted local part could be mistaken for the header's own comma-separated-list delimiter,
  corrupting the recipient list `BaseMailIngestRoute.deliver()` parses back out. Backward compatible: a plain ASCII address with nothing to decode round-trips unchanged.

### Known Issues

- An iTIP REPLY/CANCEL/REQUEST-update that loses the optimistic-lock race on all 3 retry attempts (sustained contention) still closes its ingest entry `DELIVERED` with the update itself
  silently lost - now logged at `logger.error()` (operator-visible/alertable) rather than `logger.warn()`, but the outcome for the RSVP/cancellation/update itself is unchanged. Actually fixing
  this outcome (rather than just its visibility) would need e.g. a dead-letter/reprocess queue for exhausted iTIP retries, out of scope for this pass.
- `decideResourceBooking()` has a TOCTOU window that can double-book a resource mailbox under genuine concurrent processing (two iTIP REQUESTs for overlapping times, processed by two workers at
  once, can both read "no conflict" before either commits). Closing it needs a short-lived advisory lock keyed on the resource mailbox, which has no existing reusable primitive in this codebase
  today - deferred as its own follow-up rather than introducing a new schema-level lock construct in this pass.
- `BaseAttachmentRoute.ts` (email attachment upload) still reads the fully-buffered `req.rawBody`, the same class of problem the mailbox-import streaming work above solved, just not yet applied
  here. Default cap is `mail:attachments:max_bytes` (50 MiB) - unlike PST import (rare, admin-gated bulk op), attachment upload is routine and high-frequency/multi-tenant, so many concurrent
  uploads near the ceiling create real cumulative memory pressure. Migrating it to `@StreamingBody()`/`req.bodyStream` the same way `BaseMailboxImportRoute.create()` was migrated is a real,
  scoped follow-up - deferred from this pass for time, not for any technical blocker.
- A few lower-priority search-subsystem findings from the same review round were deferred for time, not fixed: no secondary sort key (e.g. `uid`) in any of the three `SearchProvider`
  implementations' `search()`/`candidates()` cursor sorting, so bulk-imported mail sharing a timestamp (or hits tying on relevance score) can duplicate/skip results across a paged search
  (message listing already has this exact fix - `receivedDate`+`uid` tiebreakers - documented elsewhere in this file); `from:`/`to:`/`cc:` search filters are case-sensitive in all three
  providers, against this codebase's established case-insensitive-address convention everywhere else; `BaseMatterSearchRoute.search()`'s per-custodian-mailbox loop is sequential
  (`findOne`+`search()` one custodian at a time, no `Promise.all`, no cap on `custodianMailboxUids.length`) rather than parallelized.

## v0.19.0

### Features

- **A `Domain` can now be a pure alias of another domain, with no mailboxes of its own.** New optional `Domain.aliasOf` names an existing, non-alias domain: e.g. `plc.gg` aliasing `powerlevel.gg`
  lets `jean-philippe@powerlevel.gg` receive mail addressed to `jean-philippe@plc.gg` and send as it too, with no per-mailbox configuration and no `Mailbox`/`DistributionList` ever created at
  `plc.gg` itself. An alias domain still proves DNS ownership and gets its own DKIM key pair exactly like any other domain (`BaseDomainRoute`'s existing verification/DNS-setup flow is unchanged) -
  only address *resolution* is special: `util/DomainUtils.ts`'s new `resolveDomainAlias()` rewrites `local@<alias>` onto `local@<aliasOf>` wherever `BaseMailIngestRoute` resolves an inbound
  recipient to a `Mailbox`/`DistributionList`, and new `getAliasDomainNames()` lets `BaseMessageRoute.assertSenderAllowed()` treat every alias domain of a mailbox's own domain as an equally valid
  `From` for that mailbox's own addresses. New `getPrimaryDomainNames()` (verified, enabled, non-alias domains) is the list `BaseMailboxRoute`/`BaseDistributionListRoute` actually restrict a new
  address to - an alias domain is deliberately excluded, matching "no mailboxes of its own". `BaseDomainRoute` validates `aliasOf` on create/update (must name an existing non-alias domain, no
  self-alias, no chains) and refuses deleting a domain other domains still alias. `util/LocalKeyDiscoveryUtils.ts`'s local key discovery (`BaseKeyLookupRoute`/`ScanQueueJob`'s contact-key refresh)
  resolves the same alias so federation discovery for an alias address finds the primary mailbox's own published keys.
- **A meeting invite can now carry a different link for every attendee, without this library knowing which plugin produced them.** New `CalendarEvent.videoMeetingUid` (optional, unindexed,
  no foreign key) marks an event as having a linked video meeting, and a new generic entity `CalendarEventAttendeeLink` (`CalendarEventAttendeeLinkMongo`/`CalendarEventAttendeeLinkSQL`,
  exported from `@rapidmx/restapi/mongo` and `/sql`) holds one row per attendee: `mailboxUid`, `calendarEventUid`, `attendeeAddress`, `url` and an optional `label`. It has no route and its
  `AccessControlList` denies everything to everyone - a plugin writes it through a `RepoUtils` of its own, the way it already does for `Mailbox`. `MeetingSchedulingJob` reads those rows
  generically at send time: for an iTIP `REQUEST` on an event with a `videoMeetingUid`, it composes, scans and relays **one message per attendee**, each carrying that attendee's own `url`
  as the iCalendar `LOCATION` and naming it in the body, instead of one shared message fanned out by envelope. Nothing about this names or imports a plugin - the dependency direction is
  unchanged, and any future plugin needing per-attendee invite content can use the same table.
- Every fallback is graceful and per attendee: an attendee with no row (and everyone, when the lookup fails or the meeting is gone) gets the event's own plain stored `location` and today's
  invite text, and one attendee's refused scan or rejected relay is logged and skipped while the rest still go out. An event **without** a `videoMeetingUid` - the overwhelming majority -
  takes exactly the path it always did and issues no extra query at all, and a cancellation (`CANCEL`) is unaffected in every case: it never needs a join link and never looks one up.
- **A meeting reminder now carries the event's own `location`.** `CalendarReminderJob`'s `"reminder"` push event gains `location` alongside `eventUid`/`title`/`startDate` - plain, undecorated
  text (not actually encrypted today regardless of `encryptionOrigin` - see that field's own doc comment), so a client already free to show `location` as-is elsewhere can also read it as a
  join link when it looks like one, e.g. offering a one-click way into a video call from the reminder pop-up itself.

## v0.18.0

## v0.17.0

### Security

- **Every escrow scope action now requires a trusted role AND an elevated token, not a trusted role alone.** Configuring who holds escrow keys, how many are required, and the scope's own public key -
  `create`/`update`/`updateBulk`/`updateProperty`/`delete`/`truncate`/`find`/`count`/`findById`/`resolve-holder` on `BaseEscrowScopeRoute` - previously only checked `@RequiresTrustedRole()`, the state most
  of an administrator's session is in; a merely trusted, unelevated token could already read, create or change a scope's holder list. Every action now also calls `assertAdminScope()` (403 `api-104`
  without elevation), the same gate `BaseSigningEnrollmentAdminRoute` uses. Deliberately unchanged: the M-of-N access-request approval flow (`BaseEscrowAccessRequestRoute`) still runs on holder
  membership, not a trusted role or elevation - holders are meant to be a check on admin power, not administrators themselves - and a holder's own read of `BaseEscrowAuditLogRoute`'s audit trail for
  scopes they hold is still open to them unelevated, for their own accountability.
- **An administrator could read everybody's mail through the ordinary mail API - fixed: no role sees another user's mailbox any more.** Any signed-in administrator holding an *elevated* token (the
  admin console asks every administrator to elevate) was treated by `@rapidrest/service-core`'s `ACLUtils.hasPermission()` - and so by `RepoUtils`, `BaseACLRoute` and `BasePushRoute` - as a
  superuser: `GET /mail/mailboxes` listed every mailbox, and `GET /mail/folders`, `/mail/messages`, `/messages/:id/content`, attachments, contacts, events, tasks, notes, labels, filter
  rules, signatures, search, the mailbox key vault's reads and the live push channels answered for any mailbox. The web client's mailbox switcher and Settings "Mailbox" dropdown then listed
  everyone's mailbox. A sign-in that did not elevate (roles empty) never had this. Now nothing scoped to a mailbox is reachable through a trusted role, an elevated token or `ignoreACL`: a caller
  needs to **own** the mailbox or hold an **explicit ACL grant** on it, and an administrator sees their own mailbox and the mailboxes shared with them - to see anybody else's they impersonate
  that user (whose token is simply that user's own identity). Every mailbox-scoped check goes through one helper, `util/MailAccessUtils.ts` (`hasMailAccess()`, `stripTrustedRoles()`), and
  `MailPushRoute` no longer grants a channel (a mailbox's or folder's live payloads - subject, sender, `bodyPreview`) or a publish to a trusted role either. A mailbox or message the caller
  can't see answers 404 exactly as one that doesn't exist (mailbox lookups by address answer 403 for both).
  - `GET /mail/mailboxes` (list and count) is the caller's own and shared-with-them mailboxes for **every** caller. New `?scope=admin` on `GET`/`HEAD /mail/mailboxes` and `GET`/`HEAD /mail/mailboxes/:id`
    (a trusted role AND an elevated token, else 403 `api-103`/`api-104`) answers **administrative metadata only** for every mailbox (`uid`, addresses, display name, `ownerUserUid`, `shared`,
    quota/usage, timestamps, resource flags, escrow scope, encryption preference - no keys, out-of-office text, settings or anything per folder), filterable and sortable by those fields only, and
    writes one audit entry per call (`mailbox.admin-list`, `mailbox.admin-read`).
  - An administrator still manages mailboxes they hold no grant on - create, rename, aliases, owner, quota, resource settings, delete - but only those administrative fields are writable that way (the
    rest of a body is dropped), the answer is the metadata above, and each change is audited (`mailbox.admin-update`, `mailbox.admin-delete`).
  - A shared (ownerless) mailbox an administrator creates gets an explicit `FULL` grant for its creator. An existing ownerless mailbox (`hello@`) is not visible in the mail client until an administrator
    adds themselves through the mailbox Sharing action (`PUT /mail/mailboxes/:id/access/:uid`), an audited act. Sharing is also the one place an administrator (trusted + elevated) reaches a mailbox
    with no grant: they may list any mailbox's members (`mailbox_access.admin-list`), revoke any member, and grant on an ownerless mailbox - not grant access to a mailbox that has an owner (403).
  - Quarantine and the ingest queue keep their review pages with `?scope=admin` (trusted + elevated, every call audited as `mail_queue.admin_access`); without it they are the mailbox's own. Importing
    into a mailbox needs a grant on it; `GET /mail/mailboxes/:id/access/me` answers all-false for an administrator with no grant.
  - **Unchanged by design (compliance workflows that cross mailboxes, each with its own authorization and audit):** a trusted caller can still request a GDPR data export of any mailbox and download it
    (the request and every download by somebody other than the owner are audited - `data_export.downloaded` is new), approve an erasure, and read the escrow audit; eDiscovery search/export and
    escrow access stay with escrow-scope holders (a trusted role never counted). Impersonation is unchanged and needs no special handling.
  - Rollout: an administrator's **existing elevated session** keeps working until it expires, but it no longer shows other people's mail once this version runs. Nothing else needs changing; sign out
    and back in only if a browser tab still shows another user's mailbox from before.
  - Breaking for code built on the base routes: `aclUtils.hasPermission()` must not be called directly on mailbox-scoped data (a source-scan test enforces it in this package); use `hasMailAccess()`.
    `BaseScopedChildRoute` has new `adminScope`/`auditLogClass` fields (off by default), `BaseFolderRoute`/`BaseMailboxRoute` new `hasMailAccess()`/`mailUser()` methods, and `MailPushRoute` overrides
    `connect()` and `send()`. New `AuditAction` values: `MAILBOX_ADMIN_LIST`, `MAILBOX_ADMIN_READ`, `MAILBOX_ADMIN_UPDATE`, `MAILBOX_ADMIN_DELETE`, `MAIL_QUEUE_ADMIN_ACCESS`,
    `MAILBOX_ACCESS_ADMIN_LIST`, `DATA_EXPORT_DOWNLOADED`.

### Fixes

- **Autodiscover never actually worked on any deployment.** `mail:autodiscover:public_url` - the setting `@rapidmx/autodiscover-plugin` needs to answer a client at all - had no server-side default and no
  mapping into `DnsSetupUtils`'s checklist, so even a deployment with perfect DNS got a silent 404/warning. The domain DNS setup checklist now recommends the two records that actually make a real client
  succeed once the plugin's own setting is configured: an `autodiscover.<domain>` `CNAME`/`A` record (`autodiscover_cname`, needs its own TLS coverage) and a `_autodiscover._tcp.<domain>` `SRV` record
  (`autodiscover_srv`, points at the same already-certed host, so it needs no second certificate - the one to prefer on a Let's-Encrypt-rate-limited deployment). Both are omitted entirely when the
  Autodiscover plugin isn't active. New `DnsResolver.resolveCname()`/`resolveSrv()`.
- **Granting a mailbox's ownership or an escrow scope's key holders took a raw user uid with no way to know whose it was.** New `GET /mail/mailboxes/resolve-owner` and `GET /escrow/scopes/resolve-holder`
  (exact-match only, same address/username/alias/uid resolution `mail/mailboxes/:id/access/resolve` already used - now shared via `util/PrincipalResolutionUtils.ts` - never a fuzzy directory search),
  each gated at least as strictly as the write it feeds (`ownerUserUid`: a trusted role; escrow `holderUserUids`: a trusted role, matching `create()`/`update()`). A typed uid was previously only checked
  for being UUID-shaped, never resolved to a real person.
- **Encrypted messages between accounts on the same server failed with "the client shows the error that it failed to discover the recipient's key" even with both keys published.** `GET /mailbox/:id/keys/lookup`
  only ever performed remote federation (DNS `_rapidmx` lookup + a peer's public discovery endpoint) - a recipient on this same deployment (any domain it hosts, including a plain same-server, same-domain
  pair) had no path at all and always 404'd. It's now answered from the local mailbox first (its primary address, an alias, or a plus-tagged address, case-insensitively), with the exact response shape the
  public `.well-known/rapidmx/keys` endpoint would serve - built from one shared function (`util/LocalKeyDiscoveryUtils.ts`) so the two can never disagree - merged into the caller's contact identically to a
  remote result (TOFU pinning, conflict recording, Anti-Downgrade). No DNS or HTTP call is made for a local address, so a deployment whose own domain publishes no `_rapidmx` record still encrypts between its
  own accounts. A remote recipient's discovery is unaffected.
- **A signing-certificate request had nowhere to go wrong visibly - now every status names its provider, and a stale id is answered so a client can recover from it.** With the default `manual`
  backend a request sat `pending` forever with no admin route to complete it (`ManualSigningCertificateEnrollment`'s upload step was never wired to a route); the Encryption settings page still said a
  public CA issues it automatically, which was only true for the (separately shippable) `rfc8823` backend. Every `EnrollmentProgress` now carries `provider: "manual" | "rfc8823"`, so a client words a
  request truthfully instead of assuming automation. An enrollment id the active backend does not know (typically one left over from a backend a deployment used before switching) now answers `404`
  `signing-enrollment-unknown` on `GET .../sign-enrollment/:id` and `.../check` - not a 500 or a wrong-mailbox 404 that looks the same as someone else's request - and `DELETE` (cancel) on such an id
  succeeds idempotently (a cancelled, retryable answer with nothing further to show), so a client clears the id and lets the user request again rather than getting stuck.
- **The manual backend can now actually be completed - `BaseSigningEnrollmentAdminRoute` (`/admin/signing-enrollments`, trusted role AND an elevated token, audited).** `GET /` lists pending requests
  (address, mailbox, when, status, provider - metadata only, never a key); `GET /:id/csr` downloads the CSR; `POST /:id/certificate` validates an uploaded certificate (or chain) against the request -
  it is for this CSR's key, for e-mail (`emailProtection` EKU, `digitalSignature` key usage), for this address, and currently valid - with a plain-English refusal otherwise, then stores it for
  `AcmeEnrollmentDriverJob` to install (with the mailbox's own wrapped key, submitted upfront and now kept by the manual store too) on its next run; `POST /:id/reject` fails a request with a reason
  its owner sees. For the `rfc8823` backend the same list is read-only (`canUpload: false`) - a way to see an automatic request that has stalled, not a second way to complete one.
- **An unreachable certificate authority was silent beyond a debug log line - it now surfaces.** `AcmeEnrollmentDriverJob` records every contact with the CA (`SigningEnrollmentHealth`, persisted
  alongside the enrollment store so it survives a restart): a warning is logged once when a run of failures starts and again only if the error text changes (not every 5-minute tick), an info line once
  the CA answers again, and after `mail:jobs:acme_enrollment_driver:failure_audit_after` (default 3) checks fail in a row, one `SIGNING_ENROLLMENT_CA_UNREACHABLE` audit entry for the run (`details`:
  `consecutiveFailures`, `firstFailureAt`, a sanitized `error` - no URLs, tokens or key material, length-capped). The RFC 8823 provider also records a health outcome for `startEnrollment()` itself
  (opening the account/order) and logs the CA's host and whether an ACME account is already registered once at startup (from the local store, no network call).
- **A grant on a shared mailbox typed as a username never applied to anyone - sharing now resolves who it grants to.** On a live host the shared mailbox `hello@` ("Support") was granted to `jean-philippe`: the console's Sharing form stored the text typed, and an ACL record matches only a token's user uid or a role of that name, so the mailbox appeared for nobody (it only ever showed up to a
  token that bypassed ACLs, which the privacy fix above removes). `PUT /mail/mailboxes/:id/access/:principal` now takes a mailbox address (its owner), an auth-server username or e-mail alias, or a user uid the server knows, and stores only the resolved uid; a name that resolves to nobody is 400 `No user found for "<x>".` and nothing is stored, an unreachable identity service is 502. New
  `GET /mail/mailboxes/:id/access/resolve?principal=` answers who a principal is (`{ userUid, displayName?, address? }`) for a sharing screen to confirm; the member list marks an entry that is not a user uid with `noEffect: true`; `GET /mail/mailboxes` and `GET /:id` carry `accessRole: "owner" | "delegate"` to label shared mailboxes. Usernames are deliberately never matched against uids: they can be released and claimed
  by someone else, which would silently move the access - so an existing bad grant (like the live one) must be re-created through the fixed flow: add the person again and revoke the old entry (the admin console's "Replace with a user" does both). Sharing needs `mail:auth_server_url` (already used by self-service mailbox creation) for usernames and aliases; addresses and uids need nothing.
- **A new mailbox showed only some of its folders (Outbox and Sent Items appeared at the first send, unannounced; a shared mailbox never had them) - every mailbox now has every well-known folder from
  the start, and every folder creation is announced live.** On a live host a brand-new account listed only Inbox, Drafts and Deleted Items after its first e-mail was sent - Outbox and Sent Items were
  created lazily at that send and the open client was never told - and the shared mailbox `hello@` had only `calendar, contacts, drafts, inbox, tasks`. `POST /mailboxes` now creates the whole set in one
  idempotent, race-safe step (`ensureWellKnownFolders()`): Inbox, Drafts, Outbox, Sent Items, Deleted Items, Junk Email, Archive, Calendar, Contacts, Tasks and Notes (`WELL_KNOWN_FOLDER_TYPES`, deterministic
  uids as before). An **existing** mailbox heals on read, with no migration: `GET /folders?mailboxUid=` and `GET /folders/:id` check for the whole set with one existence query (nothing is written when it is
  complete) and create what is missing - only for a caller who may list that mailbox (owner or explicit grant, never a role), granting them nothing on the new folders, and never failing the read.
  - Every folder creation is now published as `{ type: "FolderMongo" | "FolderSQL", action: "create", data: <the folder> }` on the folder's channel and its mailbox's channel - the mailbox create, the heal, a
    client's `POST /folders` and the lazy paths (`findOrCreateWellKnownFolder()` at a send, a delivery, an import) - one event per folder, best-effort. A folder a client renames or moves publishes
    `{ action: "update", data: <the whole folder> }` and a deleted one `{ action: "delete", data: { uid, mailboxUid, version } }`, both on the mailbox's channel; the counts-only `update`
    (`{ uid, mailboxUid, unreadCount, totalCount }`) is unchanged.
  - `findOrCreateWellKnownFolder()` could leave a mailbox with two folders of one type when two servers created it at the same moment and one saw the other's row late; it now uses the row that won.
  - Behaviour change: `GET /folders` for a mailbox with no folders is no longer `[]` - it provisions and lists the eleven. A client that creates its own Deleted Items/Junk/Archive folder when none is listed
    should stop: they exist. New exports `ensureWellKnownFolders`, `WELL_KNOWN_FOLDER_TYPES`, `WellKnownFolderType`.

- **HTML mail lost all its styling and images - it is now stored and served the way the sender designed it, sanitized.** The sanitizer behind `Message.sanitizedHtmlBlobKey` (`sanitize-html` with its default
  allow-lists) kept only a bare skeleton: no `<img>` (an inline `cid:` image vanished entirely), no `<style>`, no `style` attribute, no `class`, `bgcolor`, `color`, `face`, `width`, `cellpadding`... - every
  newsletter, invoice and Word/Outlook mail arrived as unstyled text. The new sanitizer (`scan/HtmlSanitizer.ts`, `scan/CssSanitizer.ts`, `scan/MailUrlRules.ts`) parses the HTML and writes a complete document from
  allow-lists, keeping the design - colours, backgrounds, fonts, table layout, `<style>` blocks with `@media` queries (`prefers-color-scheme` too), `<body>` attributes, `<meta name="color-scheme">`, inline
  images (`cid:` by the attachment, small `data:` images, `http(s)` URLs as written) - and dropping everything that can run, navigate, submit, overlay or load: scripts, `on*`, `javascript:`/`data:` links,
  frames, objects, forms, `<svg>`/`<math>`, `<meta refresh>`, `<base>`, `<link>`, Outlook conditional comments, `position: fixed|absolute|sticky`, `expression()`, `@import`, `@font-face`, `url()` that is not an
  image, and more (the README's "HTML mail" section lists every one). Proven against a corpus of 127 hostile payloads (OWASP evasions, mXSS, entity and CSS-escape obfuscation, 5 MB of CSS, 50,000-deep nesting)
  in the unit tests and rendered in a real browser (Edge) with scripts allowed and no CSP: nothing executes, navigates or opens.
  - **Existing mail needs no migration.** Every sanitized blob now starts with a version stamp (`SANITIZER_VERSION`, 2). `GET /messages/:id/content` re-sanitizes a message whose blob has no stamp or an older one
    from its raw MIME on first read (parse + sanitize only - no spam or virus scan), overwrites the blob, and serves the result; concurrent readers share one run, a failure or a run over
    `mail:scan:sanitize:lazy_timeout_ms` serves the HTML already stored, and a raw message over `lazy_max_raw_bytes` is left alone.
  - **Inline images:** the stored HTML refers to them as `cid:` (mailparser no longer copies each into the HTML as a `data:` URI) and `GET /messages/:id/content` points each at the message's attachment,
    `<mail:scan:sanitize:attachment_url_prefix>/<uid>/content` (default `/api/mail/attachments`) - or leaves known ones as `cid:` for `?cid=keep` and for `fetch()` requests
    (`Sec-Fetch-Dest: empty`), which is what the reading pane resolves itself; a reference to a part the message does not have loses its `src` and keeps its `alt`. The response's CSP is now
    `default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; sandbox` (was `img-src data: cid:`). `Attachment.contentId` is stored without its angle brackets (`<logo@x>` -> `logo@x`) on new mail.
  - **The body preview no longer starts with a stylesheet or a hidden preheader:** for an HTML-only message `bodyPreview` is now the message's text (`<style>`, the head and `display:none` / `mso-hide:all` /
    zero-size preheaders left out) and takes a fraction of the time (200 KB of HTML: ~5 ms with `html-to-text` before, under 1 ms now).
  - **Settings** (`mail:scan:sanitize:*`, all optional): `allowed_tags` (an **empty list now means "all", not "none"**), `max_data_image_bytes`, `max_css_bytes`, `max_css_rules`, `max_input_length`,
    `max_depth`, `max_elements`, `attachment_url_prefix`, `lazy_max_raw_bytes`, `lazy_timeout_ms`. New dependency: `htmlparser2` (already installed through `html-to-text` and `sanitize-html`).

### Features

- **Appearance preferences, per user.** New `BaseAppearanceRoute` (`AppearanceRouteMongo`/`AppearanceRouteSQL`, models `AppearancePreferencesMongo`/`AppearancePreferencesSQL`, one row
  per user keyed by the JWT's `uid`, not per mailbox): `GET` answers the caller's `{ version: 1, mode, colors?, background?, updatedAt }` or the defaults (never a 404), `PUT` merges
  a partial body and rejects anything invalid with a 400 naming the field (`#rrggbb` colours, `dim` 0..0.8, `blur` 0..20, enums, unknown keys), and a caller can only ever touch
  their own row - a trusted role gets no exception. After every write the preferences are published on the user's own uid channel
  (`{ type: "AppearancePreferencesMongo" | "AppearancePreferencesSQL", action: "update", data }`) so other tabs and devices update live. `fetchAppearanceForSSR()` reads the row for a
  server-rendered page's props and never fails the page. Mounted by the server at `/api/mail/preferences/appearance`.
- **A background image per user.** `POST /background` takes the raw image, decides what it is from its bytes (PNG, JPEG, WebP and AVIF; an SVG or a GIF is a 415 whatever the header
  says), refuses one above `mail:preferences:background_max_bytes` (8 MiB by default) with a 413, stores it in the `BlobStore` under `appearance/<userUid>/<version>` (a new random version per
  upload, the previous blob deleted) and answers the saved preferences. `GET /background/:version` serves it with `Cache-Control: private, max-age=31536000, immutable`,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` and `Content-Security-Policy: default-src 'none'; sandbox`, to its owner only (a 404 for anyone else, so another user's
  image is never revealed); `DELETE /background` removes it.
- **Send in the background.** `POST /messages/:id/send` with `{ "background": true }` does only the cheap checks (sender allowed, has recipients, still a draft, permission, not already
  sent), moves the message into Outbox and answers `202 { status: "queued", message }` at once; the scan, relay and filing into Sent Items follow in the same process, started right away
  by `ScheduledSendJob.enqueue()` (a bounded number at a time, `mail:jobs:scheduled_send:concurrency`, default 4). A queued message is an ordinary due message in Outbox, so a process
  that dies at any point leaves it for the job's next run - `start()` now sweeps at once - and it is never relayed twice (the version-checked claim and `scheduledSendRelayedAt`).
  `stop()` waits up to `mail:jobs:scheduled_send:drain_ms` (15 s) for relays in flight. A repeated request answers the same 202 (or the usual 409 once it has been filed) and sends once. `send()` takes the response as a new parameter before the user, for the 202.
- **The outcome of a send is an event.** `ScheduledSendJob` publishes `{ type: "MessageMongo" | "MessageSQL", action: "send-succeeded" | "send-retrying" | "send-failed", data: { uid, mailboxUid,
  subject, recipients, attempt, nextAttemptAt?, error?: { message, details? } } }` on the sender's mailbox channel and the Outbox and Sent Items folder channels - for a background send, a
  scheduled send and a send the job finishes after a restart alike. `send-retrying` carries when the next attempt is due; `send-failed` leaves the message in Outbox with
  `scheduledSendError` set and nothing due (the delivery failure notice is still filed once), and asking again with `{ background: true }` queues it afresh with a new retry budget.
- **A failure no retry can fix is final at once.** A message that fails spam/malware scanning, or that the mail system refuses for every recipient with an SMTP 5xx (`isPermanentRelayFailure()`),
  used to be tried `max_attempts` times over `attempts x 60 s` before the sender heard anything; it is now `send-failed` on the first attempt, with the notice in the Inbox at once.
  Anything else (a 4xx, a transport that threw, a failure that says nothing either way) is still retried.
- **A background or scheduled send is relayed the way an immediate send is.** `prepareOutboundMime()` (shared with `send()`) adds `Disposition-Notification-To` when a receipt is requested and the
  `RapidMX-Key` announcement, and the job files the Sent Items copy with the receipt tracking rows (`seedReceiptStatus()`), `encrypted`, `inReplyTo` and `references`, which a scheduled send
  did not before. `ScheduledSendJobMongo`/`ScheduledSendJobSQL` gain a `domainClass` for it; `MessageRouteMongo`/`MessageRouteSQL` gain a `sendJobClass` (a route class without one answers a
  background send with a 501).
- **A send no longer derives a body preview it never uses.** `ScanPipeline.run()` takes `{ skipPreview: true }`, which `scanAndRelay()` passes: converting the whole HTML body to text cost about
  as much as sanitizing it (about 40 ms per 200 KB on the main thread).
- **Signing-certificate status and progress, and a check-now button's endpoint.** `GET /mailboxes/:id/keyvault/keys/sign-enrollment/:enrollmentId` used to say only `pending`, `issued` or `failed`; it now
  also answers `stage` (`submitted`, `awaiting-challenge`, `challenge-answered`, `validating`, `issuing`, `issued`, `failed`), `stages` (the RFC 8823 sequence this server really runs, each `done`, `active`,
  `pending` or `failed`, with when it happened), `progress` (0..100), `requestedAt`, `updatedAt`, `lastCheckedAt`, `nextCheckAt`, `errorCode` and `retryable` for a failure (or for a pending request whose last
  attempt failed and will be retried: `ca-unreachable`, `reply-not-sent`, `rate-limited`, `ca-error`), and once issued `issuedAt`, `installedAt`, `notAfter`, `serialNumber`, `issuer` and `subject` - all
  optional additions, so a client reading `status`/`certificate`/`error` is unaffected. The stage timestamps are stored on the enrollment record (they survive a restart), and the stage machine is explicit
  (`pki/EnrollmentStages.ts`, unit-tested transition by transition). A request whose ACME order has expired - or, when the CA gave no expiry, outlived `mail:pki:rfc8823:max_pending_hours` (168) - is
  now failed (`order-expired`, retryable) instead of pending forever, and a CA refusal (`rejected`) is marked not retryable.
  - New `POST .../sign-enrollment/:enrollmentId/check` takes the step the background job would take now (answer the CA's challenge, poll the order, finalize, download) and answers with the same object.
    Rate limited per enrollment (a second check within about 10 seconds is a 429 with `Retry-After`, stored with the enrollment so it holds across servers), it never waits on the CA for more than 8 seconds
    (a slow CA leaves the check running; the answer is the current state with a `note`), and reports an unreachable CA in the answer rather than as an error. The owner or a delegate with READ may call it.
  - New `GET .../sign-enrollment` (no id) answers the mailbox's current enrollment - one in flight, else its most recent - in the same shape plus `enrollmentId`, or 404: how a client on another device finds one
    it never saw start.
  - `SigningCertificateEnrollment` gained the optional `describeProgress()`, `checkNow()` and `listEnrollments()`; the manual-CA implementation reports a single stage, the default one has no enrollments.
    New config `mail:pki:rfc8823:poll_interval_seconds` (300, only what `nextCheckAt` is computed from - keep it equal to the driver job's schedule) and `mail:pki:rfc8823:max_pending_hours`.
- **A new `GET /system/signing-enrollment` (any signed-in user) says which backend issues signing certificates and how it is doing** - `{ backend: "manual"|"rfc8823"|"none", automatic, ca?: { host },
  contactEmail?, typicalDurationMinutes?, adminUpload, health? }`. `ca.host` is the ACME directory URL's host only, never a path or query; `health` (`rfc8823` only) is the background job's last contact
  with the CA - `ok`, `checkedAt`, `lastSuccessAt`, a sanitized `lastError` - from the same persisted record `AcmeEnrollmentDriverJob` writes. `adminUpload` says whether an administrator can complete a
  request by hand right now (`true` for `manual`). What the Encryption settings page needs to word a request's status truthfully instead of assuming automatic issuance.
- **`AuditAction` gains `SIGNING_ENROLLMENT_CA_UNREACHABLE`, `SIGNING_ENROLLMENT_ADMIN_LIST`, `SIGNING_ENROLLMENT_ADMIN_CSR`, `SIGNING_ENROLLMENT_ADMIN_UPLOAD` and `SIGNING_ENROLLMENT_ADMIN_REJECT`**
  for the health alert and the new admin route above.

## v0.16.0

### Fixes

- **A folder's unread and total counts were wrong from the moment anything but a delivery touched the folder, and never changed
  again.** `Folder.unreadCount`/`totalCount` were stored counters that were only ever incremented (by `ScanQueueJob` and the
  delivery failure notice) - never decremented or recomputed when a message was marked read or unread, moved, deleted, sent, saved as a
  draft, imported or retained away - so every badge built on `GET /folders` was stale (a live mailbox showed an Inbox of 7 unread
  messages that held 3, none unread, and Sent Items and Deleted Items at 0 over 7 and 4 messages). `GET /folders`, `GET /folders/:id` and
  the responses of `PUT` now **derive** both numbers from the messages, from one grouped query per request rather than one per folder:
  `totalCount` is the folder's messages that are not soft-deleted (exactly what the message list shows) and `unreadCount` those whose
  `flags.read` is not `true`. Existing data needs no migration: a stored value that disagrees is answered with the right one and
  repaired on the way out. `MessageMongo` gains a covering index (`message_folder_deleted_flags_read`) and `MessageSQL` a
  `(folderUid, deleted)` index for the query.
  - **New live event.** After any write that changes a folder's counts, `{ type: "FolderMongo" | "FolderSQL", action: "update", data:
    { uid, mailboxUid, unreadCount, totalCount } }` is published on the folder's channel and its mailbox's channel, so a client can
    update its badge without re-reading: a message created (ingest, draft, import, delivery failure notice), marked read or unread,
    moved, deleted or purged (retention included), archived, a scheduled or immediate send. A bulk update, a send or a truncate
    publishes each folder once, when it finishes. See `util/FolderCountUtils.ts`.
  - `FolderRouteMongo`/`FolderRouteSQL` (and any `BaseFolderRoute` subclass) derive counts through a new optional `messageClass`; a
    subclass that does not set it keeps answering with the stored values. `RetentionEnforcementJob` gains an optional `folderClass` so a
    purge can publish (set by both concrete jobs). The counters remain server-managed: a client can neither create nor update them.
  - `refreshFolderCounts()`, `countMessagesByFolder()`, `coalesceFolderCounts()` and `notifyFolderCounts()` are exported for a protocol
    package that writes messages itself. `@rapidmx/mapi-plugin` reads the stored `Folder` counts directly; they are now a cache kept
    current at each of the points above and repaired by any `GET /folders`, but a change made through its own repositories is
    not published or cached until it calls `refreshFolderCounts()`.
  - Ingest, the delivery failure notice and `MailboxImportJob` no longer add to the stored counters; they recompute them (still
    bumping `syncKeyVersion`) and can no longer fail a delivery over a folder-row write.

## v0.15.0

### Fixes

- **Self-service mailbox creation (`POST /mail/mailboxes/auto-provision`, and the `POST /mail/mailboxes` and address/alias
  changes a non-administrator makes for their own mailbox) could never work against a real auth-server.** `BaseMailboxRoute`
  listed the caller's usernames with `GET /api/aliases/me?type=name`, which is not a list endpoint - auth-server reads `me`
  there as an alias id (the caller's uid), finds none and answers 404 for **every** caller, one with a username included -
  and, had it answered, read each entry's `value`/`name` where an auth-server `Alias` names itself in `alias`. The 404
  surfaced as a 502 "Could not reach the identity service to determine your mailbox address", which a client shows as "No
  mailbox available". It now calls `GET /api/aliases?type=name&userUid=me` (auth-server lists a non-administrator's own aliases only, and
  `userUid=me` keeps an administrator's elevated token to their own too) and reads the `alias` of each entry that is a `name`
  and not marked unverified - **and that belongs to the caller**: entries whose `userUid` is missing or another user's are dropped
  here whatever auth-server answered, so an unscoped listing can never make `autoProvision()` offer, or accept, someone else's
  username.
  - Nothing else changes: a caller with no username still gets a 404 "No username is registered for this account.", any
    non-2xx answer, network error or timeout is still a 502, and a caller can still only create a mailbox at one of their
    own usernames. The request path is the one thing a deployment could have depended on: an auth-server stand-in must
    answer `GET /api/aliases?type=name&userUid=me` with a JSON array of `{ alias, type: "name", userUid, verified }` records, instead of
    `GET /api/aliases/me?type=name`.

### Features

- **A failed send now says what happened, in the mail system's own words, and nothing fails silently.** A reply to an
  external address was accepted by Postfix and then vanished: the sender got neither an error nor a message. Delivery
  problems are now reported on every path:
  - **`MailTransport` results carry diagnostics.** `TransportResult` gains two optional, additive fields: `failures`
    (`TransportFailure[]`: `address`, `code`, `enhancedCode`, `response`, `command`, `stderr`, `temporary`) and `error`
    (`TransportError`: `message`, `code`, `response`, `responseCode`, `command`, `stderr`, `exitCode`, `requestId`).
    `PostfixSendmailTransport` fills them from nodemailer's error plus what `sendmail` printed on stderr and its exit status
    (nodemailer reports neither; they are captured off the child process it spawns), marking `sendmail`'s temporary exit codes
    (EX_TEMPFAIL, EX_UNAVAILABLE, ...) temporary. `SesMailTransport` reports the SES exception name, message, HTTP status and
    request id per recipient, throttling and server faults temporary. Diagnostic text is cleaned and capped, never a message body
    or a credential. `sendOrThrow()`'s `TransportRejectedError` now appends the transport's error message.
  - **`POST /messages/:id/send` (and any `scanAndRelay()` caller) answers a refused send with a `MailRelayError`:** status
    **502**, the same `api-500` code as before, a `message` such as "This message could not be sent: the mail system refused it for
    bob@example.net. Reason given: 554 5.7.1 <bob@example.net>: Recipient address rejected: Access denied", and a new **`details`**
    object (`MailRelayFailureDetails`: `transport`, `recipients`, `accepted`, `rejected`, `failures`, `error`) in the response body,
    which the framework serializes like `code`/`status`/`message`. The draft is moved back to Drafts as before. `MailRelayError`,
    `MailRelayFailureDetails`, `relayFailureDetails()`, `transportFailuresOf()`, `describeRelayFailure()`, `parseSmtpStatus()` and
    `cleanDiagnosticText()` are exported, and so is `util/DeliveryFailureNoticeUtils.ts` (`buildDeliveryFailureNotice()`,
    `fileDeliveryFailureNotice()`, `tryFileDeliveryFailureNotice()`, `describeOriginal()`, `deliveryFailureKey()`) for a protocol package that
    relays through `scanAndRelay()` and wants to report the `undelivered` recipients it now returns.
  - **A failure notice is filed in the sender's Inbox for failures nobody is waiting on.** `util/DeliveryFailureNoticeUtils.ts`
    composes an RFC 3464 delivery status notification - `multipart/report; report-type=delivery-status` with a plain-language
    summary, a `message/delivery-status` part (per recipient: `Action`, `Status`, `Diagnostic-Code`, `Last-Attempt-Date`) and the
    original's headers (not its body, and without `Bcc`) - from `Mail Delivery System <postmaster@DOMAIN>` (the identity
    `BaseMailIngestRoute` already gives its rejection notices), marked `Auto-Submitted: auto-replied` (as Postfix marks its own
    bounces), `X-Auto-Response-Suppress: All` and a null `Return-Path` so it cannot start a loop, and threaded onto the original.
    It is filed unread and announced to connected clients exactly like a delivered message. `ScheduledSendJob` files one when it
    refuses a message or gives up on it (after the write that takes it out of the queue succeeds), and both it and
    `POST /messages/:id/send` file one for the recipients a transport refused while relaying to the others.
  - **Idempotent by construction:** the notice's uid derives from the mailbox and a per-failure key
    (`deliveryFailureKey()`/`deliveryFailureUid()`), so a retried job or a replayed request files one notice - and one a user
    deleted is not filed back. Filing is best-effort: a failure to file is logged and never changes what happens to the message.
  - **A message a local mailbox sent to a local address that resolves to nothing** is no longer dropped without a word: it used to
    be logged and answered `queued: false` to an MTA that had already told the sender it was delivered. `POST /internal/mta/deliver`
    now queues a notice of the same kind for the sender, as an ordinary null-sender ingest entry, once per message and recipient.
    Nothing is sent for a null sender, an `Auto-Submitted` message, or a sender that is not one of this server's mailboxes.
  - **Bounces from the MTA are filed like any inbound mail.** A Postfix DSN (null envelope sender, `From: MAILER-DAEMON@host`,
    `multipart/report; report-type=delivery-status`) is now covered end to end - ingest, the scan pipeline, the Inbox - on MongoDB
    and SQL, including an HTML notification surviving sanitization. One fix came of it: a bounce's `Message.from.address` was the
    empty envelope sender, so the message list showed no sender; it is now the address of its `From` header
    (`MAILER-DAEMON@host`) when the envelope sender is null. Ordinary mail is unaffected.
  - **A bounce's list preview says why it bounced.** `ScanPipeline` used to preview a delivery status notification by its first 500
    characters, which are Postfix's boilerplate ("This is the mail system at host ...") - the reason for the failure never fit. A
    `multipart/report; report-type=delivery-status` message is now previewed by what its RFC 3464 report says, one entry per
    recipient: `nobody@x.example: failed (5.1.1) - 550 5.1.1 <nobody@x.example>: Recipient address rejected: User unknown` (a
    deferral reads `delayed (4.2.0)`). The stored source, and so what a client renders, is untouched. Verified against genuine
    Postfix bounces (unknown recipient 550, expired 450, delayed 450) captured by `@rapidmx/postfix-bridge`, on MongoDB and SQL.
  - No migration and nothing to configure. `RecordingMailTransport` (the test double) refuses `partial-reject@...` alone and
    reports Postfix-style diagnostics for `reject@example.com`.

## v0.14.0

### Features

- **`GET`/`PUT /system/mailbox-policy` report the server's config values as `defaults`:** the mailbox policy is seeded
  from `mail:default_quota_bytes` and `mail:auto_provision:*` the first time it is read and is admin-editable after that,
  so a deployment that ships new config never reached an administrator who had already saved the policy. Both responses now
  carry `defaults` (`defaultQuotaBytes`, `autoProvisionEnabled`, `autoProvisionQuotaBytes`) alongside the values in
  effect, always read from the current config and never from the saved row, which is what an admin console's "reset"
  puts a field back to. Resetting is an ordinary `PUT` of the default (audited like any other edit), so nothing about
  storage changes and there is nothing to migrate. Additive: the existing fields are untouched.
  `MailboxPolicyResponse` is exported.

## v0.13.0

### Features

- **Replies actually thread now.** A reply composed through this server was relayed with no `In-Reply-To` or
  `References` header at all - the MIME is composed from the recipients, subject and HTML a compose client sends, none
  of which say anything about what is being replied to - so every recipient's ingest pipeline, and the sender's own
  Sent Items copy, filed it as a brand-new conversation. A mail list in conversation mode showed one row per message
  of a thread, each reporting "1 message".
  - `POST /mail/messages/:id/send` (and `ScheduledSendJob`, which relays the same bytes) now writes `In-Reply-To` and
    `References` into the MIME it relays, from the `inReplyTo`/`references` the draft records, and persists those
    bytes as the message's stored body. MIME that already carries threading headers of its own - a client that
    composed them, an `assemble-raw` signed/encrypted body - is never rewritten.
  - **A compose client must set `inReplyTo` and `references` on the draft it creates for a reply** (neither is
    server-managed, so an ordinary `POST /mail/messages` body carries them). `@rapidmx/react-shared`'s
    `createDraft(mailboxUid, folderUid, threading)` and `buildReplyThreading(message)` do this.
  - `Message.conversationId` is no longer derived from a message's own headers alone: on delivery *and* on send it
    first looks for an ancestor named in `References`/`In-Reply-To` that this mailbox already holds, and joins that
    message's conversation (`resolveConversationId()`/`findThreadConversationId()`, one indexed `messageId IN (...)`
    query of at most `MAX_CONVERSATION_ANCESTORS` (20) ids). This is what holds a chain deeper than one reply
    together when a client sets only `In-Reply-To`, and it is the same resolution on both sides, so the sender's Sent
    Items copy and each recipient's delivered copy carry the same `conversationId` as the rest of their thread.
    A message whose ancestors this mailbox has never seen still falls back to the thread root its own headers name,
    and a message that replies to nothing still starts its own conversation. Threading is by header only - a subject
    change mid-thread keeps the conversation, and a new message sharing a thread's subject never joins it.
  - The sent copy also records the `inReplyTo`/`references` the relayed bytes actually carry.
  - No migration: mail already delivered keeps the `conversationId` it was given. `conversationAncestorIds()`,
    `findThreadConversationId()`, `resolveConversationId()`, `MAX_CONVERSATION_ANCESTORS`, `threadHeaders()`,
    `applyThreadHeaders()`, `MAX_RELAYED_REFERENCES` and `MAX_RELAYED_REFERENCES_LENGTH` are exported from the
    package root.
- **Filter the mail list by label.** `GET /mail/messages` (and `HEAD`) and `GET /mail/messages/conversations` now take
  `?labelUids=<uid>,<uid>,...`, a comma-separated set of `Label.uid`s, and return the messages carrying **any** of
  them - OR between the labels, order-insensitive, duplicates ignored - which is then ANDed with `?filter=` and with
  anything else in the query. Applied by the database over the whole folder (or, for conversations, over the whole
  mailbox scan) before `?limit=`/`?page=`, so paging stays correct under it, and applied to the messages *before* they
  are grouped into conversations, exactly as `?filter=` already was.
  - At most `MAX_MESSAGE_LABEL_FILTER_UIDS` (20) uids per request; more is a 400, as is an entry that isn't a uid (an
    empty one included, so `a,,b` is refused rather than silently narrowed). An absent, empty or whitespace-only value
    is no filter at all, and a repeated `?labelUids=a&labelUids=b` is read as one set.
  - A uid naming no label - or naming a label in another mailbox - simply matches nothing; it can't widen a list,
    which is already scoped to one permission-checked folder or mailbox.
  - This is a behavior change for `?labelUids=`, which used to fall through to the generic query DSL: on MongoDB that
    happened to match a single label by array membership, and on SQL it compared the whole serialized JSON column and
    matched nothing. The same request now means the same thing on both backends.
- **No new column and no backfill for it.** `Message.labelUids` is matched where it is stored: by array membership
  (`$in`) on MongoDB, and against the stored `simple-json` text on SQL, one `LIKE` per uid matching `"<uid>"` with its
  JSON quotes so one uid can never match a substring of another (a uid is validated as a UUID before it reaches the
  predicate, so the pattern carries no wildcard, quote or query-DSL syntax). Deliberately *not* another denormalized
  mirror of the kind the list's `read`/`flagged`/`fromAddress`/`importanceRank` fields are: a mirror would hide every
  already-labelled message until it was backfilled, and would go stale for any writer that sets `labelUids` outside
  this library's own update path. It is a scan either way - a leading-wildcard `LIKE` can use no index, and neither
  could a mirror column - and the list is already narrowed to one folder by `message_folder_received` first. Existing
  deployments need no migration and no re-indexing: mail labelled before this release is filterable immediately.
  `parseMessageLabelUids()`, `buildMessageLabelFilterMongo()`, `buildMessageLabelFilterSQL()` and
  `MAX_MESSAGE_LABEL_FILTER_UIDS` are exported from the package root. A concrete `BaseMessageRoute` subclass must now
  implement `buildLabelUidsFilter()` (both of this package's own do).
- **Server-side sorting and filtering for the mail list.** `GET /mail/messages` (and `HEAD`, so a count matches the
  list it labels) now take a named vocabulary on top of the generic query DSL:
  - `?sortBy=` one of `date` (the default, `receivedDate`), `sentDate`, `from`, `subject`, `importance` or `flagged`,
    with `?sortOrder=asc|desc`. Left off, `sortOrder` picks the direction that reads naturally for the key (newest,
    highest or flagged first; A-Z for `from`/`subject`). `receivedDate` and `uid` are always appended as tiebreakers,
    so `limit`/`page` can't show the same message twice or skip one. An unknown `sortBy`/`sortOrder` is a 400; an
    explicit generic `?sort=` still wins when neither is named.
  - `?filter=` one of `all` (the default), `unread`, `read`, `flagged`, `hasAttachments`, `focused` or `other`.
    `focused` matches a message with no `inferenceClassification` at all, which is what absent means.
  - Both are also accepted by `GET /mail/messages/conversations`, where the filter applies to the messages before
    they are grouped.
- **Four denormalized, indexed `Message` fields make that possible**: `read` and `flagged` (mirrors of
  `flags.read`/`flags.flagged`), `fromAddress` (`from.address`, normalized and length-bounded) and `importanceRank`
  (`importance` as 0/1/2, since the stored enum strings sort alphabetically). `flags` and `from` are a single
  `simple-json` column on SQL, so nothing could filter or sort on a field inside them on both backends - which is why
  "every flagged message" previously meant reading a mailbox's whole message list into the client. All four are
  server-managed: derived by the model constructors and re-derived on every update, never accepted from a request
  body. New `util/MessageListUtils.ts` (exported from the package root) carries the derivation
  (`deriveMessageListFields()`, `syncMessageListFields()`) and the vocabulary (`MESSAGE_LIST_SORTS`,
  `MESSAGE_LIST_FILTERS`, `buildMessageListSort()`, `buildMessageListFilter()`).
- **Nested conversation view.** `GET /mail/messages/conversations` now takes `?folderUid=` (restricting both the scan
  and the grouping to one folder), `?filter=` and `?limit=`/`?page=`, and its scan is ordered newest first so the
  `mail:conversations:scan_limit` cap drops the oldest messages rather than an arbitrary slice. Each
  `ConversationSummary` gains `flagged`, `latestMessageUid`, `latestFrom`, `latestPreview` and `latestFolderUid` - the
  fields a collapsed parent row shows. New `GET /mail/messages/conversations/:conversationId?mailboxUid=` returns that
  conversation's messages oldest first across every folder (the expanded child rows), paged with `?limit=` (default
  100, capped at 500) and `?page=`; a `conversationId` that matches nothing falls back to a single-message lookup by
  uid, which is how a message belonging to no thread is keyed.
- **New indexes** on `Message`, both backends: `message_folder_received`, `message_folder_read_received`,
  `message_folder_flagged_received` and `message_mailbox_conversation_received`.

### Changed

- **Rate limits sized for interactive use, not for the theoretical minimum.** The recipient-suggestion endpoints
  (`GET /mail/directory` and `GET /mail/directory/contacts`) go from 120 to **600 requests a minute per caller,
  each**, and `GET /mail/mailboxes/lookup-by-email` from 30 to **300 a minute per caller**. A recipient field asks
  both directory endpoints on every pause in typing, so a compose window with a few recipients reached the old limit
  in about twenty seconds of ordinary composing and then got a 429 for the rest of the minute - which a client can
  only show as suggestions that silently stopped working. The new numbers are 10 and 5 requests a second sustained
  per caller: far above what a person can drive a text field at, and still a hard bound on using either endpoint as a
  bulk enumeration source. Note that an explicit `@RateLimit()` limit like these is *not* raised by a deployment's
  own "authenticated" rate-limit tier - it is applied on top of it - so these constants, not that tier, are what
  interactive use runs into. Nothing else in this library is rate limited at all: a mail client's folder, label,
  policy, message and count requests consume no rate-limit budget.

### Fixes

- **A bulk `PUT /mail/messages` (and every other `BaseScopedChildRoute` collection `PUT`) is now bounded** at
  `MAX_BULK_UPDATE` (100) objects - it applies one full `update()` per element, so an unbounded array was an unbounded
  write loop on one request. A longer body is a 400. The endpoint's semantics are unchanged otherwise, and they are
  what a mail client's multi-select bulk actions (mark read/unread, flag, move, archive, report junk, relabel) should
  use: sequential, fail-fast, not atomic, with the elements before a failure left applied.
- **`ConversationSummary` now breaks a `receivedDate` tie by `uid`.** Two messages of one conversation can share a
  millisecond (a reply filed into Sent Items in the tick its original was delivered, an mbox import), and which one
  the summary called "latest" - and so its subject, sender and preview - depended on the order the database returned
  them in.
- **No migration** (pre-release): the four new `Message` fields are nullable and derived on write, so a row last
  written before this change reads back with none of them - which the filters treat as unread, unflagged, no sender
  and normal importance. Already-read or flagged mail delivered before upgrading therefore sorts and filters wrong
  until it is next written. Re-derive it with `deriveMessageListFields()` over each mailbox's messages if that
  matters; a plain re-delivery or any update to a message fixes that message.
- **Protocol packages that write `Message.flags` themselves** (`@rapidmx/activesync-plugin`'s flag sync,
  `@rapidmx/mapi-plugin`'s property writes) must call `syncMessageListFields()` on their update patch, or a message
  marked read over EAS/MAPI will still show as unread in a webmail Unread filter.

- **A delivered message now records everyone it was addressed to, not just the envelope recipient.** `ScanQueueJob`
  stored `Message.recipients` from the SMTP envelope, so each recipient's own copy listed only that one mailbox -
  nothing server-side (or in a client) could tell who else the message went to, which broke Reply All and conversation
  participant lists. `recipients` is now built from the message's own `To` and `Cc` headers (and a `Bcc` header only
  when the delivered copy genuinely carries one - no bcc entry is ever invented for another recipient), RFC
  2047-decoded with display names preserved, typed `to`/`cc`/`bcc` by the header each came from and de-duplicated
  case-insensitively by address. An envelope recipient no header names - bcc'd, reached through an alias, or expanded
  from a distribution list - is kept as a `bcc` entry, so a copy always still records the mailbox it was delivered to.
  At most `MAX_MESSAGE_RECIPIENTS` (100) recipients are stored per message, and envelope recipients are never the ones
  dropped to that cap. The same fix applies to a mail filter rule's `copyToFolderUids` copy, and to
  `MailboxImportJob`, which imported every message with an empty `recipients` list.
- **A delivered message's sender display name is now the name alone.** `Message.from.displayName` was the *whole*
  parsed `From` header, so a client showing the name and the address rendered
  `"Bob Allen" <bob@partner.test> <bob@partner.test>`. It now stores the unquoted, RFC 2047-decoded display name on
  its own, with the address unchanged (`from.address` stays the SMTP envelope sender - what a focused-inbox sender
  override and the search index are keyed on). An address-like display name is stored as the sender wrote it: a
  client's "this sender's name looks like an address" phishing check needs to see it. Same fix in `MailboxImportJob`.
- **New `util/RecipientUtils.ts`** (exported from the package root): `parseHeaderRecipients()`,
  `buildDeliveredRecipients()`, `parseSenderDisplayName()`, `storedAddress()`, `storedDisplayName()` and
  `MAX_MESSAGE_RECIPIENTS`. `ScanPipelineResult` gains `headerRecipients: Recipient[]` and `fromDisplayName?: string`
  (additive - `parsedFrom` still carries the whole `From` header value for mail filter `from` conditions).
- **No migration** (pre-release): messages delivered or imported before this change keep their old single-recipient
  list and combined display name. Mail delivered from now on is correct immediately.

### Routes

- **Recipient suggestions: `BaseDirectoryRoute`** (`DirectoryRouteMongo`, `DirectoryRouteSQL`). Mount it with
  `@ApiRoute("mail/directory")`:
  - `GET /mail/directory?q=<text>&limit=<n>` searches the server's mailboxes (people, shared mailboxes, rooms and
    equipment) and distribution lists. Mailboxes with an approved or running erasure and soft-deleted lists are left
    out; aliases aren't matched. Only callers who own a mailbox on the server, or hold a trusted role, may search (403
    otherwise).
  - `GET /mail/directory/contacts?q=<text>&limit=<n>&mailboxUid=<uid>` searches the caller's contacts: the contacts
    folders of the mailboxes they own, plus `mailboxUid`'s when they may read it, keeping only folders they may read.
  - Both return `DirectoryEntry[]` (`{ displayName, address, kind }`, kind `user`, `shared`, `room`, `equipment`, `list`
    or `contact`) and nothing else. Every word of `q` must match the start of a name word (split on spaces and hyphens;
    contacts also match given name and surname) or the start of the address, case-insensitively. Entries starting with
    the whole query come first, then by name; addresses are de-duplicated.
  - `q` must be 2 to 100 characters (at most 5 words are used); `limit` defaults to 8 and is capped at 20. Each
    endpoint allows 120 requests a minute per caller. Query text is always matched literally (escaped for a regular
    expression on Mongo and for `LIKE` on SQL, never parsed as search operators).
  - Exports `parseDirectoryQuery()`, `matchesDirectoryTerms()`, `directoryNameWords()`, `rankDirectoryEntries()`,
    `escapeDirectoryRegExp()`, `escapeDirectoryLike()` and the `DIRECTORY_*` limits.

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
