# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.18.0] - 2026-09-22

### Added
- Added a default autodiscover.public_url config block and fix its plugin's stale documentation, so Autodiscover has something real to point clients at once an administrator sets it
- Added the two DNS record types EAS and Outlook clients actually need to find this server automatically, an autodiscover.<domain> CNAME and a _autodiscover._tcp.<domain> SRV record that needs no extra certificate, only shown when the Autodiscover plugin is active
- Added DnsResolver.resolveCname and resolveSrv, needed to check the new records
- Added resolving a mailbox's owner and an escrow scope's key holder before either is saved, each gated at least as strictly as the write it feeds, so an administrator confirms the actual person before typing a raw uid blind

### Changed
- Test both new record types across Mongo and SQL, including a dedicated server instance for a real configured public_url, since it binds at construction and can't vary per test otherwise
- Document the fix and the operator runbook for powerlevel.gg in the release notes and NOTES
- Lift mailbox sharing's exact-match address, username, alias or uid resolution into a shared util, so it can serve other fields that grant access by uid without repeating it
- Test both new resolve endpoints, and the shared resolution logic against mailbox sharing's own full suite to prove its behavior is unchanged
- Document the fix and what was confirmed already fine in the release notes and NOTES
- Require an elevated token, not just a trusted role, for every escrow scope management action - configuring who holds escrow keys, how many are required, and the scope's own public key
- Leave the M-of-N access request approval flow and a holder's own audit log visibility unchanged, since both are deliberately usable by non-admin holders by design
- Test every escrow scope action against an anonymous, an ordinary and an unelevated administrator caller, on both backends
- Document the fix and the design boundary it deliberately stops at in the release notes and NOTES

### Fixed
- Fixed a guard test that called updateBulk with no user at all, now refused for elevation before it ever reaches the guard it meant to test

## [0.17.0] - 2026-09-22

### Added
- Added per-user appearance preferences with a background image upload that checks the bytes and refuses SVG, served owner-only and immutable
- Added a background option to send, which answers 202 after the cheap checks and relays from a bounded in-process queue with retries and crash recovery, publishes send-succeeded, send-retrying and send-failed, and treats a permanent failure as final on the first attempt
- Added stages, progress, timestamps, a check-now endpoint and a current-enrollment lookup to the signing certificate status, and fail an enrollment the CA never answers as order-expired
- Added provider-aware signing certificate status, so every enrollment names its backend (manual or rfc8823) instead of a client assuming automatic issuance, and a stale enrollment id now answers 404 signing-enrollment-unknown on status/check with an idempotent cancel, instead of a dead end
- Added BaseSigningEnrollmentAdminRoute at /admin/signing-enrollments, so a trusted administrator with an elevated token can list pending manual requests, download a request's CSR, upload and validate a certificate against it, or reject a request with a reason its owner sees
- Added CA health tracking to AcmeEnrollmentDriverJob, logging a failing run once instead of on every tick, auditing SIGNING_ENROLLMENT_CA_UNREACHABLE after repeated failures, and surfacing it through the new GET /system/signing-enrollment for any signed-in user

### Changed
- Test the access matrix for owner, delegate, unrelated user, elevated administrator and impersonation on MongoDB and SQL with a guard for new routes, principal resolution, well-known folders, the appearance and background send routes, the enrollment stages and a corpus of 127 hostile HTML payloads
- Document the changes in the README, the release notes and NOTES, including the route audit and the rollout
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Document the changes in the README, release notes and NOTES

### Fixed
- Fixed an administrator with an elevated token reading every user's mail, by allowing a mailbox's owner or an explicit ACL grant only, with the trusted roles stripped, in every mailbox-scoped route and in live push subscriptions, and add ?scope=admin, which needs an elevated trusted token, returns administrative metadata only and is audited
- Fixed a shared mailbox granted to a username matching nobody, by resolving what is typed to a user id through a mailbox address or the auth-server's aliases, rejecting anything unresolvable, flagging existing entries that have no effect and adding accessRole to a mailbox
- Fixed new accounts missing folders until a refresh, by creating all 11 well-known folders with the mailbox, healing missing ones on read and publishing a Folder create event for every creation, and fix a race that could create a second folder of the same type
- Fixed HTML mail losing all its styling and images, by replacing the default sanitizer with one that keeps allow-listed presentation, CSS and cid images and drops scripts, forms, frames, SVG and every URL that could run or leak, and re-sanitize stored mail from its raw source when it is opened
- Fixed encrypted messages between two mailboxes on the same deployment failing key discovery, by resolving a local address (primary, alias, or plus-tagged, case-insensitively) before ever attempting DNS federation, sharing one response builder with the public discovery endpoint so the two can never disagree

## [0.16.0] - 2026-09-21

### Added
- Added the message_folder_deleted_flags_read and message_folder_deleted indexes the count query uses

### Changed
- Refresh the stored counters where a message is ingested, imported, sent or a failure notice is filed, as a cache reads never trust, and keep bumping the folder's sync key
- Publish a Folder update event with the folder's uid, mailbox uid and both counts to the folder and mailbox channels after a message's folder, read flag, deletion or send changes, once per folder for a bulk change
- Test the counts across ingest, mark read and unread, bulk changes, move, archive, delete, restore, purge, send, drafts and wrong stored counters, and that listing folders costs a bounded number of queries
- Document the counts and the event in the README, the release notes and NOTES
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed every folder's unreadCount and totalCount being wrong, by deriving them from the folder's messages with one grouped query per request on every folder read on MongoDB and SQL, since the stored counters were only ever incremented and showed 7 unread for an inbox with none, and correct a stale stored value on the read

## [0.15.0] - 2026-09-20

### Added
- Added per-recipient SMTP and transport diagnostics to TransportResult, and capture what sendmail printed and its exit status in PostfixSendmailTransport and the exception, status and request id in SesMailTransport, so a failed relay keeps the mail system's own reason
- Added DeliveryFailureNoticeUtils, which builds an RFC 3464 style delivery failure notice, and file one in the sender's Inbox, once, when a scheduled send is refused or given up on, or a transport refuses some recipients while relaying to others

### Changed
- Read each name from the alias field the auth-server returns rather than value or name
- Keep only the caller's own verified name aliases, so an elevated administrator's token can't be offered, or create a mailbox for, another user's username
- Fail a send that reached nobody with a 502 whose message is a plain sentence and whose details carry the per-recipient status codes and remote responses, and keep the message in Drafts
- Notify a local sender when the ingest drops their message for an unresolvable recipient, never for a null sender or an automatic message
- Preview a delivery status report by what it says, one entry per recipient, since the plain text preview cut the reason off after 500 characters
- Test the send failure, the notices and the bounces captured from a real Postfix (null envelope sender, expired and delayed) against real MongoDB and real SQL, and the alias lookup with a stub that answers only the real URL and response shape
- Document the changes in the README, the release notes and NOTES
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed self-service mailbox creation never offering an address, by asking the auth-server for the caller's names at GET /api/aliases?type=name&userUid=me, which exists, instead of /api/aliases/me, which reads me as an alias uid and answers 404 for everyone
- Fixed a bounce listing no sender, by falling back to the From header when the envelope sender is null

## [0.14.0] - 2026-09-20

### Added
- Added the server's config values as defaults to the responses of GET and PUT /system/mailbox-policy, so an admin console can reset a field to what a newly deployed config says, since the policy is seeded from mail:default_quota_bytes and mail:auto_provision:* only the first time it is read and an administrator who had already saved it never saw a later change

### Changed
- Read defaults from the current config on every request rather than from the saved row, and leave resetting an ordinary audited PUT of the default value, so nothing about storage changes and there is nothing to migrate
- Export MailboxPolicyResponse from the package root
- Test defaults before anything is saved, after edits, and a reset by PUT against real MongoDB and real SQL
- Document the change in the release notes and NOTES, including why a reset writes the default rather than clearing the field to follow config live
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

## [0.13.0] - 2026-09-17

### Added
- Added BaseDirectoryRoute with DirectoryRouteMongo and DirectoryRouteSQL for compose recipient suggestions, mounted by the server at mail/directory
- Added GET /mail/directory, which searches the server's user, shared, room and equipment mailboxes and distribution lists by name word and address prefix, returning only display name, address and kind
- Added GET /mail/directory/contacts, which searches the contacts folders the caller can read in the mailboxes they own and in a readable mailboxUid
- Added util/RecipientUtils.ts with parseHeaderRecipients, buildDeliveredRecipients, parseSenderDisplayName, storedAddress, storedDisplayName and MAX_MESSAGE_RECIPIENTS, capping a message at 100 recipients, addresses at 320 characters, display names at 200, group nesting at five levels and refusing control characters, over the address lists mailparser has already parsed so a huge or hostile header adds no new parsing to the ingest path
- Added server-side sorting and filtering to the mail message list through named sortBy, sortOrder and filter query parameters on GET and HEAD /mail/messages, so a client's sort and filter menus are answered by the database over the whole folder instead of over the page it already fetched
- Added util/MessageListUtils.ts with the derivation, the sort and filter vocabularies and the paging bounds, exported from the package root
- Added listQueryParams and listQueryOverrides to BaseScopedChildRoute so a route can interpret its own query parameters and merge server-built filter fragments, including an $or a client can't send, over the stripped client query
- Added GET /mail/messages/conversations/:conversationId, returning one conversation's messages oldest first across every folder in the mailbox, paged and falling back to a uid lookup for a message that belongs to no thread
- Added label filtering to the mail message list through a comma-separated labelUids query parameter on GET and HEAD /mail/messages and on GET /mail/messages/conversations, returning the messages carrying any of the named labels - OR across the set, order-insensitive, ANDed with the existing filter, and applied by the database over the whole folder so limit and page stay correct under it

### Changed
- Refuse directory searches from callers who own no mailbox on the server unless they hold a trusted role, and leave out mailboxes with an approved or running erasure and deleted lists
- Match query text literally through escaped regular expressions on Mongo and escaped LIKE patterns on SQL, require 2 to 100 characters, cap limit at 20 and rate limit each endpoint to 120 requests a minute per caller
- Export parseDirectoryQuery, matchesDirectoryTerms, directoryNameWords, rankDirectoryEntries, escapeDirectoryRegExp, escapeDirectoryLike and the DIRECTORY limits
- Test both endpoints on Mongo and SQL, and the query helpers
- Document the routes in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Record everyone a delivered message was addressed to, building Message.recipients from the message's own To and Cc headers - and a Bcc header only when the delivered copy genuinely carries one - instead of the SMTP envelope, which named only the single mailbox each copy was filed into and left Reply All, conversation participants and every server-side reader with a one-entry list
- Keep an envelope recipient no header names - bcc'd, alias-only or expanded from a distribution list - as a bcc entry, deduped case-insensitively by address, so a copy still records the mailbox it was delivered into without putting a privately addressed recipient back on a visible header
- Store the sender's display name alone on from.displayName, unquoted and RFC 2047-decoded, instead of the whole From header, which a client rendered a second time after the address it also shows
- Keep from.address as the envelope sender, which the focused-inbox sender overrides and the search index are keyed on, and keep an address-like display name as the sender wrote it, which a client's phishing warning needs to see
- Expose headerRecipients and fromDisplayName on ScanPipelineResult, leaving parsedFrom as the whole From header value mail filter conditions match
- Apply the same recipients and display name fix to a mail filter rule's folder copy and to MailboxImportJob, which imported every message with no recipients at all
- Test both fixes on Mongo and SQL - multiple To and Cc recipients, display names with commas, quotes and encoded words, a bcc'd recipient absent from the headers, a malformed header and a 5000-address one - and unit test the new utility
- Document the fixes in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Sort by date, sentDate, from, subject, importance or flagged, always with receivedDate and uid appended as tiebreakers so limit and page can't show a message twice or skip one, and refuse an unknown sortBy or sortOrder with a 400
- Filter by all, unread, read, flagged, hasAttachments, focused or other, with focused also matching a message carrying no inferenceClassification at all
- Store read, flagged, fromAddress and importanceRank as server-managed, indexed mirrors of flags, from and importance, since flags and from are one simple-json column on the SQL backend and nothing could filter or sort on a field inside them on both backends
- Derive the mirrors in the Message model constructors and re-derive them on every update patch, refuse them in a request body for every caller including a trusted one, and export deriveMessageListFields and syncMessageListFields for protocol packages that write flags themselves
- Index Message on folderUid and receivedDate, folderUid read and receivedDate, folderUid flagged and receivedDate, and mailboxUid conversationId and receivedDate, on both backends
- Accept folderUid, filter, limit and page on GET /mail/messages/conversations, scan newest first so the conversation cap drops the oldest messages rather than an arbitrary slice, and report flagged, latestMessageUid, latestFrom, latestPreview and latestFolderUid for a collapsed conversation row
- Break a receivedDate tie in a conversation summary by uid, so which message the summary calls latest no longer depends on the order the database happened to return them in
- Bound a bulk PUT on any scoped child collection at MAX_BULK_UPDATE objects, and document its fail-fast, non-atomic semantics as what a mail client's multi-select bulk actions should use
- Test every sort key, every filter, paging stability, mirror derivation and body rejection, conversation folder scoping, filtering, paging, tie-breaking and expansion, and the bulk cap, against real Mongo and real SQL
- Document the new parameters, fields, indexes and the absence of a backfill in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Apply it to a conversation list's messages before they are grouped, exactly where filter is already applied, so a conversation appears when any of its messages carries any of the labels and reports only those messages
- Match labelUids where it is already stored rather than adding another denormalized mirror: array membership on MongoDB, and one LIKE per uid against the stored simple-json text on SQL, each matching the uid with its JSON quotes so one uid can never match a substring of another
- Keep that decision deliberate - a mirror column would hide every already-labelled message until it was backfilled, would go stale for any writer that sets labelUids outside this library's update path, and would buy no index anyway, since a leading-wildcard LIKE can use none either way and the list is already narrowed to one folder first
- Build the predicate per backend through a new abstract buildLabelUidsFilter on BaseMessageRoute, implemented by MessageRouteMongo and MessageRouteSQL over buildMessageLabelFilterMongo and buildMessageLabelFilterSQL, since the same query DSL expression means different things against an array and against JSON text
- Validate every entry as a uid instead of escaping it, which by construction excludes the LIKE wildcards, the quote that would break out of the JSON string and the characters the op(value) DSL reads as syntax, and refuse a malformed entry with a 400 rather than answering with a query that matches nothing
- Cap a request at MAX_MESSAGE_LABEL_FILTER_UIDS labels with a 400, treat an absent or empty value as no filter, refuse an empty entry inside a list, and read a repeated labelUids parameter as one set
- Interpret labelUids in the route now instead of letting it fall through to the generic query DSL, where it matched a single label by array membership on MongoDB and nothing at all on SQL
- Export parseMessageLabelUids, buildMessageLabelFilterMongo, buildMessageLabelFilterSQL and MAX_MESSAGE_LABEL_FILTER_UIDS from the package root
- Test the filter against real Mongo and real SQL - one label, several ORed in either order, combined with a named filter and a sort, the HEAD count, paging stability, an unknown uid, another mailbox's uid, a legacy row carrying no labels, a uid differing only in its last character, an empty and a repeated parameter, a malformed uid, the cap, and the conversation endpoint - and unit test the parsing and both predicates
- Document the parameter, its OR semantics and the absence of any migration in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Write a reply's In-Reply-To and References headers into the MIME POST /mail/messages/:id/send relays, from the inReplyTo and references the draft records, since this server composes a reply's source from the recipients, subject and HTML a compose client sends and nothing in it named the message being replied to - so every recipient's ingest pipeline, and the sender's own Sent Items copy, filed a reply as a brand-new conversation and a mail list in conversation mode showed one row per message of a thread, each reporting one message
- Persist those bytes as the message's stored body before the send is claimed, so a scheduled send relays exactly what an immediate one would and a client reading the raw source sees the thread
- Leave MIME that already carries either header exactly as it is, including a signed or encrypted body assembled client-side through assemble-raw
- Build the relayed References as the draft's chain with the replied-to message appended, trimmed from after the thread's root to MAX_RELAYED_REFERENCES entries and MAX_RELAYED_REFERENCES_LENGTH characters, since a chain grows by one entry per reply forever and a header line may not exceed 998
- Resolve Message.conversationId against the mailbox instead of from a message's own headers alone, on delivery and on send alike - join the conversation an ancestor named in References or In-Reply-To is already filed under, and fall back to the header derivation only when the mailbox holds none of them
- Keep a message that replies to nothing in its own conversation, and never thread by subject, so a subject change mid-thread holds the conversation together and a new message sharing a thread's subject never joins it
- Look the ancestors up in one indexed messageId IN query of at most MAX_CONVERSATION_ANCESTORS ids, nearest ancestor first, which is what holds a chain deeper than one reply together when a client sets only In-Reply-To
- Record on the sent copy the In-Reply-To and References the relayed bytes actually carry, rather than only what the draft row said
- Raise the recipient-suggestion limit from 120 to 600 requests a minute per caller on GET /mail/directory and GET /mail/directory/contacts, and the address lookup from 30 to 300 a minute on GET /mail/mailboxes/lookup-by-email, because a recipient field asks both directory endpoints on every pause in typing and reached the old limit in about twenty seconds of ordinary composing, after which every further request was refused for the rest of the minute and the suggestions silently stopped
- Document on both constants that an explicit limit is what interactive use runs into, since a deployment's authenticated rate-limit tier is applied under it rather than over it
- Test the threading on delivery and on send against real MongoDB and real SQL - a two- and a three-deep chain, a reply carrying References but no In-Reply-To, a reply naming only its direct parent, a message with neither header, a subject change mid-thread, a reply whose ancestors the mailbox has never seen, a scheduled reply, and the conversation list reporting every message exactly once rather than a group alongside its own members
- Document the fix, what a compose client must now send on a reply draft, and the new rate limits in the release notes and NOTES
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

## [0.12.0] - 2026-09-15

### Added
- Added an optional ui field to plugin manifests declaring pages on the public, www, admin or escrow hosts and navigation entries for settings, the admin console and the app rail, validated when a plugin is looked up

### Changed
- Refuse plugin pages at reserved core paths, and refuse plugin changes whose pages would share or nest under another enabled plugin's pages, including changes made at the same time
- Export PluginUiUtils with the manifest ui parser, the reserved mount list and the mount conflict helpers for the server
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Export DateCoercionUtils from the package root for plugins
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

### Removed
- Removed public booking pages, booking types and bookings from core, moving them to @rapidmx/booking-plugin; resource and room booking stay
- Removed the booking class fields and purges from the erasure job, leaving bookings to the generic mailbox-scoped plugin data purge

## [0.11.0] - 2026-09-15

### Added
- Added POST /mail/mailboxes/:id/keys/trust, which pins a validated signing certificate for a sender that has no pinned signing key, refusing a different pinned key with 409 and auditing each pin
- Added POST /mail/mailboxes/:id/keys/resolve to accept or reject a key conflict against the pinned fingerprint the user saw, auditing each decision
- Added PUT /mail/messages/:id/verification-seal for client-written verification seals, set once per master key generation and replaceable only after a rekey

### Changed
- Share one version-checked, race-retrying contact key write between key lookup, trust and ScanQueueJob so concurrent writers end with one contact and one signing key
- Create the Contacts folder without granting the caller creator rights, and query contact emails literally
- Require auditLogClass on BaseKeyLookupRoute subclasses, and note the endpoint and breaking change in the unreleased release notes
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Store and publish each key's verified issuer certificate from the local CA, OpenBao, ACME and manual certificate chains
- Mark keys superseded by a newer key of the same use as revoked with revocationReason superseded, and keep rekey from clearing or weakening revocations
- Replace a contact's pinned key automatically when the new and pinned certificates verify against the same issuer and the pinned key is expired or revoked, keeping the old key in previousKeys
- Record one key conflict per use type with the full observed key, remember rejected keys, and refresh discovery when a key header conflicts
- Replace Contact.keyConflict with keyConflicts, previousKeys and rejectedKeys, and document the rules in the spec and release notes
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Store verificationSeal and verificationSealGeneration as server-managed message fields that no other write or message copy sets, and include them in data and matter exports
- Require keyVaultClass on BaseMessageRoute subclasses
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

## [0.10.0] - 2026-09-15

### Added
- Added plugin registry search at GET /plugins/search, which finds packages named *-plugin in one or every configured namespace and reports each one's latest version, whether it's allowed, whether it's installed and whether an update is available
- Added GET /plugins/updates, reporting each installed plugin's latest published version and whether it's newer than the installed one
- Added system:plugins:namespaces, a list of npm scopes to search for plugins, each optionally with its own registry and token; packages in a configured namespace are allowed to be added, and are looked up on that namespace's registry
- Added GET /plugins/namespaces, listing the configured namespaces without their tokens
- Added NpmRegistryClient.searchPlugins(), normalizePluginNamespaces(), findPluginNamespace() and isNewerVersion()
- Added requires to the plugin manifest, mapping other plugin packages to the semver ranges a plugin needs, validated by parsePluginManifest
- Added PluginDependencies with planPluginChange(), which installs missing requirements at the highest version in range (dependencies first) and enables disabled ones, refusing out-of-range installs, missing versions, disallowed packages, cycles and version changes that break an enabled dependent
- Added findDependents(), orderByDependencies() and pruneUnmetRequirements() for the server host's load order
- Added GET /plugins/plan, previewing what adding or changing a plugin also installs and enables
- Added semver as a dependency
- Added timeouts, size limits and per-client caching to registry requests, reject non-semver resolved versions, and skip search results without a version
- Added GET /mail/mailboxes/:id/access/me with the caller's effective read, create, update, delete and manage access
- Added clearing a retention period with null
- Added forwarding loop protection with envelope rewriting, per-occurrence reminder claims, HMAC escrow audit chaining with a head record, deterministic well-known folder ids, text SQL columns and missing indexes

### Changed
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Install and enable requirements when adding a plugin, returning { plugin, dependencies } from POST /plugins
- Plan requirements when enabling a plugin or changing its version, and block disabling or uninstalling a plugin that an enabled plugin requires, with a 409 naming the dependents
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Require authentication and a single plain address for mailbox lookup-by-email, querying it literally so search operators like like() or in() can't enumerate owners, and rate limit it
- Only grant mailbox access to user uids, refusing anonymous, wildcard and role ids, and require full access to grant, change or remove a manager or to change your own access
- Audit mailbox access grants and revocations, report other action sets as a custom role with their actions, read the ACL uncached before changing it, and return 409 on a concurrent change
- Store mailbox and mailbox policy quotas as doubles so 5GB+ values fit on Postgres and MySQL, require safe-integer quotas, fail self-service mailbox creation closed when the policy can't be read, and require authentication to read the policy
- Keep saving a setup step from making setup required again once it's complete, and retry concurrent step saves
- Hold data-subject erasure while an installed plugin isn't loaded, so its mailbox-scoped data isn't skipped
- Accept system:plugins:allowed_packages and namespaces as JSON or comma-separated strings, dropping unscoped wildcards and malformed entries
- Validate plugin package names against npm's rules, encode them in registry requests and refuse a registry response for a different package
- Undo a plugin change's dependency writes when it fails partway, refuse to overwrite a plugin row created while planning, check the allow-list when enabling or changing version, and report updates for disallowed plugins as unavailable
- Accept expectedPlan on POST and PUT /system/plugins, refusing with 409 when the dependencies to install or enable differ from the previewed plan
- Validate plugin setting defaults, select options, duplicate and reserved keys, and look up requirements by own keys only
- Update package names in docs to the -plugin names
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Use double precision for SQL quota and timestamp columns, which Postgres rejected as double, and document the manual ALTER needed before upgrading existing Postgres and MySQL databases
- Refuse changes to a mailbox's owner, quota or used bytes from non-trusted callers, require UUID owner uids, and lowercase mailbox addresses
- Apply the mailbox policy to non-trusted POST /mailboxes: self-service must be enabled, addresses must be the caller's own on verified domains, and the quota is the policy's
- Require full access when any other ACL record could give a member full access, check access against the same uncached ACL that is saved, store member uids lowercase, look up owners case-insensitively, and limit lookup-by-email to 30 per minute
- Hold erasure only for unloaded plugins whose manifest declares mailboxScopedData, and log the data a removed plugin leaves behind
- Check the allow-list for disabled dependencies being enabled, include the target version in expectedPlan, plan installed plugins from their stored manifest, and ignore expectedPlan when a change leaves a plugin disabled
- Delete rows a failed plugin change created instead of soft-removing them, undo PUT and DELETE writes too, and refuse with 409 and undo when a concurrent change leaves an enabled plugin's requirement unmet
- Treat dependencies with unset required settings as conflicts, reject empty or non-exact versions and repeated query values, and only report search updates for allowed packages
- Use a namespace's own token on the default registry, send registry URL credentials as a Basic header without echoing them in errors, and keep announce failures from replacing a change's result
- Include integrity in the plugin state hash
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Generate every create route's uid on the server so a client can't claim an existing ACL, strip $ keys and forced scope keys from client queries, and require real unexpired share links resolved as share:<token>
- Block client writes to blob keys, server-controlled message, attachment and folder fields, ingest queue and quarantine rows, and dates on delivered mail, and send read receipts at most once
- Validate alias changes, refuse re-creating addresses with leftover data, keep filter rule targets in the rule's mailbox, require From to be a mailbox address when sending or recalling, and serve attachments and message content with safe types, nosniff and CSP
- Search a delegated mailbox by mailboxUid, count label and types as search filters, and normalize Focused Inbox overrides
- Validate booking manage tokens, tie booking types to their mailbox's calendar folders, page busy time, and rate limit anonymous booking per IP and slug
- Guard audit, escrow audit, escrow scope and domain rows against bulk and property updates, stop admins becoming escrow holders, expire approved escrow access and refuse it for closed matters or removed custodians
- Make key vault writes owner-only and refuse removing the last unlock wrap, allow only raster branding uploads with sanitized header and footer HTML, coerce calendar and matter dates, and page request lists newest first
- Count shared blob references before deleting, purge key vaults and share links on erasure, and retry inbound mail with leases, backoff and idempotent delivery ids
- Only send invites from organizer mailboxes, require DKIM-aligned senders for iTIP, recall and ACME mail, stop scheduled sends resending after relay, and page past held or failing items in job queues
- Isolate search indexing failures per document, fix Mongo participant search, write PKI files atomically, include the domain in key discovery, and stop auto-replacing pinned keys
- Expand recurrences near the query window with ordinal BYDAY, DST-correct stepping and Windows zone names, stream mbox exports, budget PST imports, and skip scanner errors on import
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Strip client _id, version, dates and dotted or $ keys on create, and reject dotted or $ keys on update, bulk update and property routes
- Check stored From/Sender headers before any send, schedule only through POST /:id/send, and claim immediate sends with a version-checked move into Outbox
- Block moving legally held messages to another mailbox, keep the mailbox owner's ACL record in step with owner changes, and require delete and update rights for ?deleted=true
- Recompute hasAttachments server-side, coerce date fields on create and update, and require aligned DKIM before honouring list unsubscribe
- Generate Matter and EscrowScope uids server-side, version-check key vault, booking and plugin updates on Mongo, and validate rekey requests
- Bound booking types, windows, overrides and slot generation, rate-limit slot lookups per client IP, and version-check cancel and reschedule
- Return 409 for downloads from closed matters and compare escrow public keys by their fields
- Trust RapidMX-Key and recall headers only when oversigned by aligned verified DKIM
- Count ScanQueueJob attempts at claim, renew leases, park exhausted entries, and send delivery receipts exactly once after filing
- Forward before forward-and-delete returns, drop mail for mailboxes under erasure, bound resource conflict checks, and ignore stale meeting replies
- Claim and lease erasure, matter export and scheduled send jobs, page purges by keyset, and include soft-deleted mail in retention
- Bound indexed string lookups with hashes, add compound indexes and SQL column types, and purge search index entries for deleted mail
- Isolate content extraction in worker threads with zip bomb limits, chunk OpenSearch bulk requests by bytes, and write local blobs atomically
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Mark in-flight sends with a lease, refuse moving a message out of Outbox while its send is in flight, and file into Sent Items only while the claim still holds
- Require at least one recipient to send, persist the relayed marker in its own write, and bound messageId, conversationId and icalUid on every patch write
- Refuse non-trusted moves into Drafts except from Outbox or Drafts, so sent or received mail can't be rewritten through compose
- Defer instead of dropping mail for approved or hold-blocked erasures, ignore erasure requests older than the mailbox, and bound the deferral
- Rewrite unauthenticated From and strip trust headers and calendar parts when relaying through distribution lists or forward rules, and require DKIM-verified members for restricted lists
- Apply the address-like display name rule to the lexer's parsed From and Sender, also at scheduled send time, and trust only the topmost Authentication-Results
- Claim delivery receipts before sending and track auto-replies per ingest entry, and expand resource bookings in windows so long open-ended series aren't declined
- Limit owner renames of the primary address to their own usernames, move owner ACL grants before the owner field, and reject display names containing @ or line breaks
- Scope attachment listing and access by the owning message's current folder
- Refuse rekey while a sign enrollment holds a wrapped key, let owners cancel enrollments, track master key generations, replace escrow wraps on rekey, and bind enrollment ids to their mailbox
- Return 409 when first-time enrollment wraps are sent to an already initialized vault, key IPv6 booking rate limits by /64, and export asEntity, legal hold helpers and findPagesByUid
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Updated @rapidrest/service-core to ^2.1.0 as both the dev dependency and the peer range
- Pass allowExistingACL when creating well-known folders at their deterministic uids, resetting any leftover ACL there to the mailbox with no records
- Recognise service-core's IDENTIFIER_EXISTS 400 as a duplicate key so lost create races still re-read the winner
- Use ModelUtils.literal() for sender- and client-controlled lookups, including values that were previously unescaped in mail ingest, ScanQueueJob and MailboxImportJob
- Truncate scoped children, mailboxes and matters with literal in() lists in bounded batches instead of one eq() per uid
- Document which framework workarounds service-core 2.1.0 makes redundant
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Require non-trusted sends to come from Drafts, refuse deleting a message whose send is in flight, and refuse moving delivered mail from Outbox to Drafts
- Drop mail for erased mailboxes whose row is gone instead of eventually delivering it, and check erasure before scanning
- Mark relayed immediate sends so ScheduledSendJob finishes filing after a crash, and re-read soft-deleted rows when recording the relay
- Send meeting invites from the organizer mailbox's safe display name, skip non-plain attendees, refuse more than 500 and pass invites through the scan pipeline
- Validate calendar organizer and attendee addresses on REST writes, and use safe display names in booking, receipt, recall and auto-reply mail
- Keep well-known folders' ACLs after concurrent creation races, and reset leftover ACLs without wiping grants made meanwhile
- Page attachment truncate realignment by uid so moved-message attachments aren't skipped and deleted
- Undo overlapping owner ACL moves newest first and only when unchanged, and refuse look-alike @ in mailbox display names
- Accept expectedMasterKeyGeneration on key vault writes with 409 on mismatch, and refuse deleting escrow scopes still assigned to mailboxes
- Track superseded draft bodies kept under legal hold on the message, export them with matters and release them after the hold
- Parse client dates as ISO 8601 with UTC default or epoch milliseconds only
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

## [0.9.0] - 2026-09-14

### Added
- Added mailbox access management + email-lookup routes for shared mailboxes
- Added a plugin contract: the rapidmx.plugin manifest, PLUGIN_API_VERSION, settings validation, the package allow-list matcher and a state hash every server copy compares against
- Added a Plugin model (Mongo/SQL) recording each plugin's package version, integrity hash, enabled flag, settings and manifest snapshot, kept as a removed row rather than deleted so default plugins never re-add one an administrator removed
- Added BasePluginRoute (trusted-role only) to preview a package from the npm registry, add, upgrade, configure, enable, disable and remove plugins, and read each server copy's reported status, announcing every change on the plugins Redis channel
- Added NpmRegistryClient for reading package versions and manifests from a configurable, optionally authenticated registry
- Added PluginRegistry, the loaded-plugin list a host sets and plugins read, and the @MailboxScopedData() decorator
- Added tests for the mailbox access route's unknown-mailbox, missing-ACL and missing-email paths and its SQL alias query
- Added notes on the plugin contract, soft-removed plugin rows, PluginRegistry's design and the erasure hook
- Added a MailboxPolicy singleton at system/mailbox-policy for the default mailbox quota and self-service mailbox creation, seeded from the mail:default_quota_bytes and mail:auto_provision:* config on first use and falling back to that config for unset fields or a failed read
- Added a SetupState singleton at system/setup that tracks the first-run setup wizard: whether setup is required (never started on a server with domains, or started and not finished), the current step, completion and reopening
- Added findOrCreateSingleton() for create-or-fetch of singleton settings rows

### Changed
- BaseMailboxAccessRoute (mongo/sql) is a thin, purpose-built wrapper around a
- mailbox's own AccessControlList - list/grant/revoke a delegate's access via a
- simple viewer/manager vocabulary, gated at plain ACLAction.UPDATE rather than
- the literal FULL the generic BaseACLRoute requires, so a non-owner delegate
- can manage membership too. A single grant here already cascades to every
- folder and record under the mailbox (confirmed via research: parentUid
- chaining already wires every well-known folder's ACL to its mailbox, and
- CalendarEvent/Contact/Task/Message have no independent ACL of their own).
- Also adds GET /mail/mailboxes/lookup-by-email, resolving an email to the
- person who owns the Mailbox at that address (primarySmtpAddress or an alias)
- - there is no separate user/identity directory anywhere in this platform, so
- this is the only way to turn "someone's email" into a uid for a share-access
- UI. Deliberately excludes shared/ownerless mailboxes from matching.
- First piece of a larger shared-mailbox feature (booking pages already work
- for shared mailboxes with no changes needed; multi-mailbox Mail/Calendar UI
- is a separate follow-up pass).
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Test that a shared mailbox's delegate can create a booking link
- Covers the shared-mailbox booking page case end to end at the route level:
- a manager-role delegate on an ownerless mailbox can create a booking type
- for it, and a viewer-role delegate gets 403. No route change was needed -
- BookingType is already permission-checked against the mailbox's ACL.
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Move DeviceSyncState and EasDeviceStateCleanupJob out of this library and into the ActiveSync plugin
- Change ErasureExecutionJob to purge every loaded @MailboxScopedData() model in its datastore instead of DeviceSyncState specifically, so plugin data is still erased with its mailbox
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Rename the plugin config keys from plugins:* to system:plugins:*, grouping deployment-wide settings under system
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Change autoProvision() to read the mailbox policy instead of the auto-provision config directly
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
- Updated the release notes for the plugin contract, shared mailbox access, mailbox policy and setup state changes
- Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

### Fixed
- Fixed test isolation for suites that rely on auto-provisioning config now that the policy row it seeds persists across test files

## [0.8.0] - 2026-09-13

### Added
- Added findAllPages() row capping to DataExportJob.buildMboxBundle(), which previously had no size cap at all unlike its JSON sibling
- Added tests for the claim-before-relay race, the restore-on-failure path, and the double-failure (restore also fails) path, plus an mbox-format max_content_rows cap test mirroring the existing JSON one

### Changed
- Restore scheduledSendTime (best-effort, re-fetching first) when the relay fails after a successful claim, preserving this job's own documented leave-it-for-retry behavior on failure
- Investigate MatterExportJob's per-custodian-only cap and confirm it is a deliberate, already-documented design decision, not a gap - leave it unchanged
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed a critical send-after-cancel race in ScheduledSendJob: relayDueMessage() now claims the message via a version-checked clear of scheduledSendTime before calling scanAndRelay(), the same claim-first-work-second discipline DataExportJob/MailboxImportJob already use
- Fixed this repo's own broken lint gate: auto-fix six unnecessary-type-assertion errors via eslint --fix, manually fix two empty-function stubs in PstImportUtils.test.ts by giving them a real, harmless body matching their actual signature

## [0.7.0] - 2026-09-12

### Added
- Added Label entity (LabelSQL/LabelMongo) with mailbox-scoped CRUD routes
- Added Message.labelUids to reference applied labels by uid
- Added cascade cleanup removing a deleted label's uid from every referencing message
- Added MailFilterActionType.APPLY_LABEL mail filter action
- Added label: search operator to SearchProvider, BaseSearchRoute, and all three search providers
- Added S3BlobStore, an S3/S3-compatible BlobStore backend
- Added FolderType.ARCHIVE and its default display name
- Added a POST /:id/archive action on BaseMessageRoute, mirroring recall()'s shape
- Added EscrowScope entity with admin-only CRUD (holders, dual-control threshold, notify flag)
- Added Mailbox.escrowScopeId assignment, restricted to a trusted administrator
- Added BaseKeyVaultRoute.resolveAllowEscrow(), the prerequisite for a real escrow-method MasterKeyWrap
- Added Matter entity, holder-gated CRUD rather than admin-gated (separation of duties)
- Added EscrowUtils.requireEscrowHolder()/findHeldScopeIds(), shared holder-check helpers
- Added hash-chained EscrowAuditLogEntry, tamper-evident against direct DB edits
- Added EscrowAuditUtils.recordEscrowAuditEntry()/verifyEscrowAuditChain()
- Added read-only BaseEscrowAuditLogRoute, holder-scoped or unfiltered for a trusted admin
- Added EscrowAccessRequest dual-control workflow for escrow key material access
- Added create/approve/deny/material endpoints gated by EscrowScope holder status and M-of-N approval thresholds
- Added hash-chained escrow audit entries recorded atomically alongside every create/approve/material-read action
- Added a 409 guard blocking Matter deletion while EscrowAccessRequests still reference it
- Added coverage for pre-existing untested branches in BaseMatterRoute (not-found guards, bulk create, validation-skip paths)
- Added Rfc8823AcmeSigningCertificateEnrollment (F4b sub-item 1 of 4)
- Added real RFC 8823 email-reply-00 ACME automation via the acme-client package, driven through its manual API since email-reply-00 has no native support
- Added persisted ACME account key/URL and per-enrollment state, mirroring the existing local-CA disk-persistence pattern
- Added recordChallengeToken() as the seam a later inbound-mail correlator will call once the CA's challenge email arrives
- Added inbound RFC 8823 challenge-email correlation (F4b sub-item 2 of 4)
- Added ScanQueueJob.tryCorrelateAcmeChallenge(), recognizing a CA challenge email by its Auto-Submitted/Subject shape and matching it against an outstanding enrollment before ever treating it as CA plumbing
- Added ScanPipelineResult.replyToAddress, needed to address the eventual reply per RFC 8823's own Reply-To-else-From rule
- Added Rfc8823AcmeSigningCertificateEnrollment.findPendingEnrollmentId(), the reverse lookup the correlator needs since nothing in the challenge email itself carries this server's own enrollmentId
- Added outbound RFC 8823 reply and challenge-completion pipeline (F4b sub-item 3 of 4)
- Added Rfc8823AcmeSigningCertificateEnrollment.advanceEnrollment(), a single non-blocking state-machine step per call: send the reply email and complete the challenge, then poll/finalize/download the certificate once the CA validates it
- Added sendChallengeReply(), composing the exact RFC 8823 reply shape (Re:-prefixed subject, In-Reply-To, the BEGIN/END ACME RESPONSE body block) and relaying it via the same scanAndRelay() path every other real outbound message uses
- Added MailTransport/ScanPipeline/BlobStore injection to Rfc8823AcmeSigningCertificateEnrollment, needed to actually send that reply
- Added sign-enrollment REST endpoints and the ACME driver job (F4b sub-item 4 of 4)
- Added BaseKeyVaultRoute.startSignEnrollment()/checkSignEnrollmentStatus(), accepting the wrapped private key upfront alongside the CSR so the eventual install needs no further client action
- Added AcmeEnrollmentDriverJob, advancing every outstanding RFC 8823 enrollment and auto-installing the certificate into the mailbox's KeyVault once the CA issues it, idempotently via a fingerprint-collision guard
- Added AcmeEnrollmentDriverJob's expiry-check pass, flagging a mailbox's signing certificate nearing notAfter with nothing newer already enrolled
- Added Rfc8823AcmeSigningCertificateEnrollment.attachWrappedKey()/listPendingEnrollments()/getIssuedMaterial()/markInstalled(), the seams the job and route need
- Added model constructor partial-data tests closing !== undefined ternary false-branch gaps in Booking/FocusedInboxOverride/EscrowAccessRequest/Branding (SQL+Mongo)
- Added direct-call tests for BaseAuditLogRoute/BaseEscrowAuditLogRoute's rejectWrite()-guarded bodies, dead via HTTP since @Before intercepts before the handler runs
- Added real count()/findById() holder-scoping tests for BaseEscrowAuditLogRoute, previously only exercised via find()
- Added unit tests for BaseBrandingRoute's SSR-only readPublicBranding()/fetchBrandingPropsForSSR() helpers
- Added shared.ts's AWS SDK dynamic-import failure-path tests via vi.doMock
- Added PostgresFullTextSearchProvider's untested flags/before/after candidate filters
- Added BaseKeyVaultRoute's five MAX_*_EXCEEDED validation tests
- Added BaseSearchRoute's candidates() guard clause, requireCallerMailboxUid()'s !user guard, and before/after date-parsing tests
- Added verified-domain-on-rename tests for BaseMailboxRoute/BaseDistributionListRoute, and 404 tests for BaseEscrowScopeRoute's update()/delete()
- Added MailboxRouteSQL's %/_/\ ACL-role escaping test, a real wildcard-injection correctness check
- Added OpenBaoPkiCertificateAuthority's serialMapQueue self-recovery test after a write failure
- Added EscrowAuditUtils's broken-previousHash chain-detection test, distinct from a per-entry hash mismatch
- Added BaseMessageRoute.archive()'s missing guard-clause test
- Added SearchIndexJob's answered/forwarded flag coverage
- Added BaseDomainRoute's best-effort DKIM-backfill-failure test
- Added Legal Hold enforcement, extending Matter (compliance roadmap Group A)
- Added util/LegalHoldUtils.ts's findActiveHoldsFor()/assertNotOnLegalHold() - an open Matter's custodianMailboxUids/dateRangeStart/dateRangeEnd/closedAt already describe a litigation hold, just not wired to block anything until now
- Added BaseScopedChildRoute.checkLegalHold() hook (no-op default, purge-only) so a permanent delete of a held record is blocked while an ordinary soft-delete stays unaffected
- Added BaseMailboxRoute's first delete() override (Mailbox has no soft-delete of its own) blocking a whole-mailbox delete against any open hold regardless of date range
- Added AuditAction.LEGAL_HOLD_BLOCKED_DELETE, recorded whenever a hold actually blocks a destructive attempt
- Added util/AuditLogUtils.isNonOwnerAccess() - true when the caller isn't the mailbox's own owner (an admin reaching in via a trusted-role grant, or a delegate), the one signal distinguishing a compliance-relevant access from a user's own ordinary, unaudited activity
- Added AuditAction.MESSAGE_CONTENT_ACCESSED, recorded on GET /messages/:id/content only for a non-owner read
- Added AuditAction.MAILBOX_ACCESSED via a new BaseMailboxRoute.findById() override, recorded only for a non-owner mailbox profile view
- Added configurable data-retention engine, legal-hold-aware (compliance roadmap Group C)
- Added RetentionPolicy singleton settings entity + BaseRetentionPolicyRoute, modeled directly on BaseEncryptionPolicyRoute/BaseBrandingRoute - GET open to any authenticated user, PUT trusted-role-only, every field unset by default (no automatic purge configured until an admin opts in)
- Added MIN_AUDIT_LOG_RETENTION_DAYS floor (2190 days / 6 years) - auditLogRetentionDays cannot be configured below it, approximating HIPAA's typical audit-trail retention expectation
- Added RetentionEnforcementJob (cron, mirrors QuarantineRetentionJob's single-page-per-run shape) enforcing messageRetentionDays/auditLogRetentionDays - a Message purge checks LegalHoldUtils.assertNotOnLegalHold() first and skips (not errors) a held record, naturally retried once its Matter closes
- Added GDPR data export (JSON + Mbox), self-service and admin-mediated (compliance roadmap Group D1)
- Added DataExportRequest entity + BaseDataExportRoute (bespoke, same shape as BaseEscrowAccessRequestRoute) - create() is both the self-service and admin-mediated endpoint, mirroring BaseMailboxRoute.create()'s "trusted caller may act for someone else, an ordinary caller's own identity always wins" idiom for mailboxUid
- Added util/MboxUtils.ts's buildMboxEntry()/parseMbox() - a real, interoperable mailbox export (Thunderbird/Apple Mail/Gmail Takeout all read it), hand-rolled since Mbox is a simple documented text format needing no dependency
- Added DataExportJob (cron) building either format: mbox concatenates each Message.bodyBlobKey's raw source; json aggregates every entity type that denormalizes mailboxUid (Mailbox/Message/Contact/ContactList/CalendarEvent/Task/Note/Attachment) as newline-delimited JSON
- Added mailbox import (Mbox + PST): Group D2
- Added GDPR right-to-erasure workflow: Group E
- Added eDiscovery enhancements (Matter export + search): Group F
- Added Unreleased section to RELEASE_NOTES.md

### Changed
- Wire APPLY_LABEL label application into ScanQueueJob's delivery and copy paths
- Document label: operator in specs/search.md
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Support custom endpoint and forcePathStyle for MinIO/R2/Spaces targets
- Support an optional key prefix for sharing one bucket across environments
- Support an explicit access key pair, falling back to the standard AWS credential chain
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Block archiving a message currently in Drafts or Outbox
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Guard the escrow-scope-assignment check against a harmless round-tripped SQL null
- Wire resolveAllowEscrow() into enrollKey()/addMasterKeyWrap(), leaving rekey() unchanged by design
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Block deleting an EscrowScope while a Matter still references it
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Restrict chain verification to a trusted admin, since the chain is global across scopes
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Extract BaseKeyVaultRoute's certificate-parsing/identity-binding logic into util/CertificateInstallUtils.ts, shared by the manual install path and the new automated one
- This completes the entire CASTLE/RFC 8823 automated signing-certificate enrollment feature (item 4 of the 4-item batch).
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Close the pre-existing coverage gap (100%/96.31%/100%/100% stmt/branch/fn/line)
- Mark 6 genuinely untestable/tool-quirk branches with justified /* v8 ignore */ comments (LocalX509CertificateAuthority and Rfc8823AcmeSigningCertificateEnrollment's TOCTOU retries, BaseMatterRoute/BaseEscrowScopeRoute's framework-shadowed name validation, S3BlobStore's v8-coverage-provider statement/branch miscount, MeetingSchedulingJob's query-shadowed status recheck)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Override checkLegalHold() on BaseMessageRoute against its own mailboxUid/sentDate - the one entity a Matter's custodian list actually protects
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Audit non-owner access to mailbox content/profile (compliance roadmap Group B)
- An owner reading their own inbox/profile - the overwhelming majority of traffic - stays deliberately unaudited, matching this repo's existing audit-scope boundary
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Deliberately does NOT apply retention to EscrowAuditLogEntry - it's a hash-chained tamper-evident ledger where deleting any entry would break verifyEscrowAuditChain() for everything after it; permanent retention is by design, not an oversight
- Records one AuditAction.RETENTION_PURGE_EXECUTED summary entry per entity type per run (count, not one per record) to avoid flooding the audit trail
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Deliberately does NOT offer PST export - confirmed via research that no free/open Node library can write valid PST bytes, only paid SDKs; Mbox already satisfies the portability need without a new paid dependency
- GET /:id/download streams the finished bundle directly (BlobStore-backed), gated to the requester, the target mailbox's owner, or a trusted admin
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- MailboxImportRequest entity + BaseMailboxImportRoute (self/admin-mediated
- upload via req.rawBody, mirrors BaseDataExportRoute's create() idiom) and
- MailboxImportJob, completing the GDPR portability pair started by D1's export.
- Mbox import reuses D1's parseMbox(); PST import adds the free pst-extractor
- dependency and a new util/PstImportUtils.ts that reconstructs each PST mail
- item into a raw RFC 5322 buffer via nodemailer's MimeNode, so both formats
- feed the same ScanPipeline-based persistence step in MailboxImportJob (deliberately
- not ScanQueueJob.deliverMessage(), which is entangled with live-mail-only
- concerns). An infected attachment or message causes the whole item to be
- skipped and counted in failedCount, never partially imported.
- silently drops the From header for a non-address-shaped sender (common in
- older PST data), now synthesized into a valid address; and an optimistic-lock
- version mismatch that left a request stuck at "processing" forever if work
- failed after that status transition.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- DataSubjectErasureRequest + BaseDataSubjectErasureRequestRoute implements the
- create/approve/deny review workflow (mirrors BaseEscrowAccessRequestRoute's
- shape). create() is self-service only (no admin-on-behalf-of path, unlike the
- export/import routes) and rejects a duplicate pending request for the same
- mailbox. approve() checks LegalHoldUtils.assertNotOnLegalHold() synchronously
- (409 if held) and only transitions status to "approved" - the actual cascade
- is performed asynchronously by ErasureExecutionJob so a large mailbox can't
- time out the admin's request, the same instant-transition/async-job split
- already used for export and import.
- ErasureExecutionJob re-checks the legal hold immediately before cascading
- (skip and retry later if a hold appeared in the interim), then purges every
- mailboxUid-scoped entity plus Folder and the Mailbox row itself, explicitly
- deleting each row's own BlobStore content (message bodies, attachment blobs,
- contact photos) so no orphaned bytes survive the erasure. Every row purge is
- best-effort - one failure doesn't abort the rest of the cascade.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Group F closes the two remaining eDiscovery gaps beyond what Escrow Scoping
- already shipped, completing the HIPAA/GDPR/eDiscovery compliance roadmap
- (Groups A-F).
- MatterExportRequest + BaseMatterExportRequestRoute lets any holder of a
- Matter's EscrowScope (no dual-control approval needed, unlike
- EscrowAccessRequest - exporting at-rest content is a different risk than
- releasing key material) trigger an eDiscovery export spanning every
- custodian mailbox. MatterExportJob reuses DataExportJob's own aggregation
- step, now genuinely extracted into util/MailboxContentUtils.ts so both share
- it, narrowing only Message rows to the matter's date range. Each custodian
- mailbox actually exported is logged as its own hash-chained
- EscrowAuditLogEntry.
- BaseMatterSearchRoute adds holder-only full-text search across a Matter's
- custodian mailboxes, reusing the existing SearchProvider unchanged (one call
- per mailbox, keyed results, no merged cross-mailbox cursor invented) and
- always clamping before/after to the matter's own date range so a holder can
- never search outside the litigation hold's defined scope.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Two parallel adversarial agents (correctness/concurrency, security/perf)
- reviewed the full A-F diff; every finding was independently re-verified
- against source before fixing.
- - MboxUtils: parseMbox() truncated the last byte of every non-final
- message on round-trip, not just the last one.
- - MailboxImportJob: imported mail was stamped with import time instead
- of its real Date: header, silently breaking Legal Hold and Matter
- date-range narrowing for historical mail.
- - ErasureExecutionJob: cascade missed 13 of 25 mailboxUid-scoped entity
- types; added a final legal-hold re-check before the mailbox's own
- delete to close a TOCTOU window.
- - MailboxContentUtils/DataExportJob/MatterExportJob: unbounded
- in-memory aggregation now capped via a configurable max_content_rows.
- - PstImportUtils: Buffer.alloc(attachment.filesize) trusted an
- unverified PST property; now bounded against the PST file's own size.
- - MatterExportJob/BaseMatterSearchRoute: any escrow holder could list
- an arbitrary mailbox as a matter "custodian" and read/search its full
- content, bypassing the dual-control EscrowAccessRequest workflow -
- now requires the mailbox's own escrowScopeId to match the matter's,
- mirroring the check BaseEscrowAccessRequestRoute already enforced.
- Full suite: 205/205 files, 3237/3237 tests, 100%/96.37%/100%/100%.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Same two-agent methodology (correctness/concurrency, security/perf)
- run again after committing round one's fixes (1d4f713).
- - BaseScopedChildRoute/BaseMailboxRoute: Legal Hold was only wired
- into the singular delete() path under purge:true. The inherited
- bulk truncate() endpoint (DELETE /messages?folderUid=X, DELETE
- /mailboxes) is unconditionally a hard, permanent delete with no
- purge option at all, and had no hold check - a caller could destroy
- held records simply by using the bulk endpoint instead. Fixed by
- having truncate() check every matched record before deleting.
- - BaseMatterRoute: updateBulk/updateProperty/truncate were left
- un-overridden and fell through to the framework's generic ACL,
- which unconditionally grants any trusted-role (admin) caller access
- before consulting a record ACL - bypassing the holder-only
- separation-of-duties model this class exists to enforce, including
- truncate()'s ability to wipe every Matter (and thus every active
- legal hold) in one call. Fixed by overriding all three.
- - ErasureExecutionJob.markCompleted() refetched the request row
- immediately before its final update(), defeating its own optimistic
- lock against two job instances racing on the same request. Fixed by
- using the originally-fetched version, matching its sibling jobs.
- - MatterExportJob recorded a hash-chained escrow audit entry per
- mailbox inside the collection loop, before the export bundle was
- written/marked ready - a later custodian's failure left an earlier
- mailbox's entry permanently attesting to an export that never
- completed. Fixed by recording entries only after the bundle is
- ready. Applied the same escrowScopeId-match check (from round one)
- to BaseMatterExportRequestRoute.create()'s own audit loop.
- - RetentionEnforcementJob.purgeExpiredAuditLogEntries() had no
- legal-hold check, unlike its sibling purgeExpiredMessages() - a
- years-old investigation's own audit trail could be purged out from
- under it. Fixed with the identical per-entry hold check.
- - BaseDataExportRoute/BaseMailboxImportRoute find() only checked
- requestedByUserUid, so an admin-mediated request was invisible to
- the actual mailbox owner it was made for. Fixed to also include
- requests for mailboxes the caller owns.
- Full suite: 205/205 files, 3288/3288 tests, 100%/96.33%/100%/100%.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Round two's security agent had already named exists() alongside
- updateBulk/updateProperty/truncate as left un-overridden and thus
- falling through to the framework's generic ACL - I only fixed the
- other three. RepoUtils.exists() checks Matter's class-level ACL
- (deny-all, since holder-ness lives in EscrowScope.holderUserUids,
- not an ACL record) before any per-record check, and unconditionally
- bypasses that for a trusted role - letting a non-holder admin probe
- arbitrary matter uids for existence via HEAD /matters/:id.
- Mirrors findById()'s own holder check, translated into
- BaseScopedChildRoute.exists()'s found/not-found response shape
- (404 either way, so a non-holder can't distinguish "doesn't exist"
- from "exists, not yours").
- Full suite: 205/205 files, 3291/3291 tests, 100%/96.33%/100%/100%.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Same two-agent methodology, run again at the user's request after two
- prior rounds (1d4f713, 678b945, 723da84). Found real bugs even after
- an exhaustive per-method authorization sweep confirmed the "un-overridden
- CRUD method" bug class was otherwise closed:
- - BaseScopedChildRoute/BaseMatterRoute/BaseMailboxRoute: truncate()'s
- own round-2 fix checked a snapshot of matched records for legal-hold/
- reference violations, but then let the actual delete re-run the
- ORIGINAL query live via RepoUtils.truncate() - which re-executes its
- own search independently of that snapshot. A record matching the same
- filter that starts existing in the gap between the snapshot and the
- delete (e.g. mail delivered mid-request) would be deleted having
- never been checked at all. Fixed by re-scoping the actual delete to
- exactly the snapshotted/checked uids in all three copies.
- - RetentionEnforcementJob purged expired Messages but never their
- Attachment rows or either entity's own BlobStore content - PHI/PII a
- RetentionPolicy represents as deleted stayed fully stored and
- independently downloadable indefinitely, since Attachment has no
- DB-level cascade from Message (the same reason ErasureExecutionJob
- already treats this as an explicit step). Fixed with the identical
- cleanup that job already established.
- - MatterExportJob could get stuck at "ready" with a silently incomplete
- escrow audit trail: recordEscrowAuditEntry() genuinely throws after
- exhausting its own retry budget under real sequence contention, and
- that throw reached markFailed(), which tried to write a stale
- pre-"ready" version and failed silently - leaving an already-disclosed
- export with a permanently incomplete hash-chained ledger and no path
- to retry. Fixed by making the per-mailbox audit-recording loop
- best-effort (log loudly, continue) instead of re-entering the
- request's own state machine.
- - BaseDataSubjectErasureRequestRoute.create()'s pending-request check
- is a genuine TOCTOU (no transaction, and this codebase has no
- existing partial-unique-index precedent that wouldn't also block a
- legitimate resubmission after an earlier denial). Mitigated (narrowed,
- documented as not fully eliminated) via a post-create race check that
- auto-supersedes the losing side instead of leaving two pending rows.
- Full suite: 206/206 files, 3309/3309 tests, 100%/96.34%/100%/100%.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Fourth adversarial review round found and fixed:
- - LegalHoldUtils.findActiveHoldsFor() used a bare, unpaginated find() that
- silently truncates at the framework's 100-row default (confirmed against
- RepoUtils.js source) - once the global Matter table exceeds that count,
- assertNotOnLegalHold() (the choke point every irreversible-purge path
- depends on) could miss a real, active hold. Fixed with the same
- findAllPages()-style pagination already used elsewhere in this codebase.
- - Message/Attachment/Contact/CalendarEvent/Task/Note all let a client set an
- independent, unverified mailboxUid via create()/update(), completely
- divorced from the record's real folderUid-derived mailbox - none of these
- entities' scopeProperty is mailboxUid, so the existing re-parent permission
- check never fired on it. Every compliance job this roadmap shipped trusts
- mailboxUid as authoritative (ErasureExecutionJob, RetentionEnforcementJob,
- LegalHoldUtils), so this let a record silently evade or be wrongly swept
- into an erasure/retention-purge/legal-hold scoped to a mailbox it was never
- really in. Fixed at the root: BaseScopedChildRoute.resolveMailboxUidFor()
- now force-resolves mailboxUid from the actual target folder on every
- affected route, via a new util/FolderUtils.getMailboxUidForFolder() helper.
- - DataExportJob had no claim/processing state (unlike its sibling
- MailboxImportJob), so two overlapping runs could both build a bundle and
- race a non-transactional BlobStore.put() under the same deterministic key.
- - BaseMessageRoute.content() skipped its non-owner-access audit entirely
- when the message's mailbox couldn't be resolved (a dangling mailboxUid,
- e.g. after a mailbox delete with no cascade), even though content was
- still served. Fixed to audit defensively on unresolved ownership.
- - MailboxImportJob's folder-counter bump shared a try/catch with message
- persistence and the final "completed" write, so a benign version conflict
- there reported a fully-successful import as failed, inviting a duplicate
- re-run. Isolated it into its own try/catch.
- - MboxUtils.buildMboxEntry() interpolated fromAddress into the mbox
- separator line unsanitized, allowing an embedded CR/LF to inject a fake
- From separator and corrupt later re-parsing. Stripped CR/LF, matching the
- existing sanitizeFilename() convention.
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>

### Fixed
- Fixed two bugs surfaced by testing against a real PST fixture: MimeNode
- Fixed bugs found in adversarial review of compliance roadmap (Groups A-F)
- Fixed bugs found in second adversarial review round
- Fixed BaseMatterRoute.exists() bypassing separation of duties
- Fixed bugs found in third adversarial review round
- Fixed legal-hold pagination, mailboxUid integrity, and export/import races (round 4 adversarial review)
- Fixed with the same claim-then-work pattern MailboxImportJob already uses.

## [0.6.0] - 2026-09-11

### Added
- Added Mailbox.alwaysRequestReceiptFederated/autoSendReceiptsFederated (both default false, matching the existing External defaults) alongside the existing Internal/External settings, in both SQL and Mongo backends
- Added util/DomainUtils.ts's classifyRecipientTier(), built around an injectable isFederatedPeer seam that defaults to always-false until real _rapidmx federation discovery exists (a later roadmap item) - this keeps observable behavior identical to today's internal/external classification for now while giving BaseMessageRoute.send()/maybeSendReadReceipt() and ScanQueueJob.maybeSendDeliveryReceipt() a stable three-way switch to call into
- Added util/SmimeUtils.ts's isEncryptedBody() detecting application/pkcs7-mime; smime-type=enveloped-data and multipart/encrypted from an already-parsed message, excluding opaque S/MIME signing (smime-type=signed-data) which still carries real content
- Added ScanPipelineResult.encrypted and skip sanitizedHtml/bodyPreview derivation for an encrypted body; AV/spam scoring is unaffected since both already operate on the raw buffer
- Added federation discovery infrastructure (roadmap Group B): DNS policy resolution and the remote key-endpoint HTTP client, the shared groundwork both A5's real federated-peer detection and the eventual discovery-protocol routes build on
- Added util/FederationUtils.ts's resolveFederationPolicy(), resolving a domain's _rapidmx TXT record (v=RMXv1; id=...; host=...;), structurally mirroring DomainVerificationUtils.checkDomainVerification()'s never-throws/chunk-rejoin conventions, caching both positive and negative results via @rapidrest/core's SimpleStore (a plain MemoryStore, no new cache utility needed)
- Added util/KeyDiscoveryClient.ts's fetchRemoteKeys(), fetching a peer's GET /.well-known/rapidmx/keys/:hash endpoint and honoring ETag/Cache-Control/304 against its own separate SimpleStore instance, kept distinct from the DNS-policy cache per the spec's explicit separation of per-user key freshness from domain-policy caching; TLS certificate/hostname verification needs no extra code since Node's fetch() already refuses a certificate that doesn't chain to a trusted root or cover the hostname; includes a hand-rolled z-base32 encoder (computeKeyDiscoveryHash()) since no dependency exists for it and there is exactly one call site
- Added the shared PublicKey/EncryptionPreference/KeyDiscoveryResponse types to models/types.ts, pulled forward from the data-model group since the discovery client's return type needs them
- Added a compact nav-header icon to Branding, independent of the full logo
- Added util/DomainUtils.ts's createFederatedPeerCheck(dnsResolver), bridging classifyRecipientTier()'s FederatedPeerCheck seam to FederationUtils.resolveFederationPolicy() - a federated peer is any domain publishing a valid _rapidmx TXT record
- Added @Inject("DnsResolver") to BaseMessageRoute.ts and ScanQueueJob.ts (the same DI token BaseDomainRoute/DomainVerificationJob already register/consume, so every deployment and test environment already has one) and pass a real check into every classifyRecipientTier() call site instead of relying on the default stub
- Added real end-to-end tests (SQL + Mongo, both the send()-time request-attachment path and ScanQueueJob's delivery-receipt auto-send path) proving a federated peer registered via StaticDnsResolver actually activates the Federated tier, not just that the stub correctly does nothing - caught and fixed a genuine test-authoring bug in the process: envelopeTo in send() comes from Message.recipients (a structured field), not parsed from the raw MIME blob's own To: header, so both need to point at the test peer address
- Added CalendarEvent.encrypted provenance flag and wire it through ScanQueueJob's iTIP processing (roadmap items I2/I3 - Derived Entities inheritance)
- Added EncryptionPolicy singleton settings entity + route (roadmap Group H1) - the system-wide, per-recipient-tier encryption policy from specs/end-to-end_encryption.md's "Encryption Policy States" section
- Added EncryptionCertificateAuthority abstraction (F1-F3): pluggable internal-CA interface, mandatory NullEncryptionCertificateAuthority default, and LocalX509CertificateAuthority zero-infrastructure implementation
- Added OpenBaoPkiCertificateAuthority (F3b): recommended production EncryptionCertificateAuthority backend
- Added an optional IssuedCertificate.serialNumber field (populated by both LocalX509CertificateAuthority and this new adapter) - generic, useful X.509 metadata, additive to the interface introduced in the previous commit
- Added SigningCertificateEnrollment abstraction (F4): pluggable public-CA enrollment interface, mandatory Null default, and CA-agnostic ManualSigningCertificateEnrollment implementation
- Added Key/Keyring data model (Group C): WrappedPrivateKey/MasterKeyWrap/KeyVault types, Mailbox/Contact extensions, and a Contact write-protection fix
- Added WrappedPrivateKey and MasterKeyWrap (with an escrowScopeId seed field for the still-deferred Escrow Scoping follow-up) alongside the already-shipped PublicKey/EncryptionPreference types (C1)
- Added Mailbox.encryptPreference/keys (required, safe universal defaults) and keyDiscoveryHash (optional, deliberately NOT backfilled with a shared default under a uniqueness constraint - that would collide across every pre-existing row the moment a second one is saved, the same class of bug as this session's earlier alwaysRequestReceiptFederated NOT NULL incident); BaseMailboxRoute now computes/recomputes keyDiscoveryHash alongside primarySmtpAddress on create and update (C2)
- Added Contact.encryptPreference/keys/keysFirstSeen/lastMessageSeen/keyConflict, discovery-managed fields that trust-on-first-use pinning and the spec's Anti-Downgrade rule depend on never being writable via an ordinary client edit; Contact previously had no dedicated Base*Route class (unlike every other folder-scoped entity) and used BaseScopedChildRoute's generic create()/update() directly, which would have let any caller PATCH these fields freely - fixed by introducing BaseContactRoute, which rejects (400) any request attempting to set them directly (C3)
- Added the KeyVault entity (own table/collection, keyed by mailboxUid, no per-record ACL) holding wrappedKeys/masterKeyWraps, deliberately separate from Mailbox so private key material can never leak via an ordinary Mailbox fetch - no route yet, Group D wires up GET /mailbox/:id/keyvault and enrollment against it (C4)
- Added Key Vault Endpoints (Group D): GET/enroll/wrap-CRUD/re-key under /mailbox/:id/keyvault
- Added GET /mailbox/:id/keyvault (D1), deliberately checking the owning mailbox's own AccessControlList directly via ACLUtils.getRecord() rather than hasPermission(), since the latter has an unconditional "trusted users always have permission" bypass (confirmed by reading ACLUtils.js) that would give any admin blanket read access to every mailbox's private key material - a system admin gets 403 unless they are the mailbox owner or hold an explicit delegate ACLRecord
- Added POST /mailbox/:id/keyvault/keys (D2) to enroll a new key: for useType "encrypt" it calls the injected EncryptionCertificateAuthority.issue() itself against the caller's CSR, wiring up Group F's abstraction as anticipated; for useType "sign" it validates an already-issued certificate instead, since signing-cert enrollment against a public CA is a separate, asynchronous flow (SigningCertificateEnrollment) that has already completed by the time this call is made; the new PublicKey (Mailbox.keys) and WrappedPrivateKey/initial MasterKeyWraps (KeyVault) are written atomically via @Transactional()
- Added POST/DELETE .../keyvault/wraps (D3) to add or remove one MasterKeyWrap independent of key enrollment, identified by method + optional methodId
- Added PUT .../keyvault/rekey (D4), an atomic full replacement of wrappedKeys/masterKeyWraps/keys and the only real revocation mechanism for a captured wrap
- Added public key discovery endpoint (E1): GET /.well-known/rapidmx/keys/:hash
- Added server-side Discovery proxy (E2): GET /mailbox/:id/keys/lookup?addr= and util/KeyringUtils.ts
- Added util/KeyringUtils.ts's applyDiscoveredKeys(), implementing the Trust Model in one shared place: TOFU-pins the first key seen per useType; on a later different key, retains the pinned one and records Contact.keyConflict unless the pinned key is expired/revoked and the new one shares its issuer (sameIssuingCa(), an issuer-DN heuristic, not full chain verification, documented as such); and never lets a lookup that finds nothing regress keys/encryptPreference already on file (Anti-Downgrade) - this same function is designed to be reused by Group E3's inbound RapidMX-Key header processing, which has a KeyDiscoveryResponse-shaped payload already in hand rather than needing discoverAndMergeKeys()'s own DNS/HTTP lookup
- Added inbound RapidMX-Key header processing (E3): AuthenticationResultsUtils, RapidMxKeyHeaderUtils, wired into ScanQueueJob
- Added util/AuthenticationResultsUtils.ts's hasAlignedPassingDkim() as new territory for this codebase - nothing parses Authentication-Results today, since this app otherwise trusts whatever the upstream MTA hands it - as the specific gate specs/end-to-end_encryption.md requires before an inbound RapidMX-Key header may be acted on ("Receiving servers MUST verify DKIM before acting on the header and MUST treat an unverified header as absent"), failing closed on anything short of an aligned dkim=pass result
- Added util/RapidMxKeyHeaderUtils.ts's parseRapidMxKeyHeader(), implementing the header's own processing rules verbatim: exactly one header (all copies ignored otherwise), addr must match From, unknown non-_-prefixed attributes invalidate the whole header, keydata must parse as a real certificate; the signing certificate is never carried here per the spec, so the resulting PublicKey.useType is always "encrypt"
- Added extractHeaders() (plural) to MimeHeaderUtils.ts alongside the existing extractHeader(), needed since the ">1 RapidMX-Key header" and "Authentication-Results may repeat per hop" rules both require seeing every occurrence, not just the first
- Added outbound RapidMX-Key header attachment (E4)
- Added RapidMxKeyHeaderUtils.buildRapidMxKeyHeader(), the inverse of the existing parseRapidMxKeyHeader() used by E3's inbound processing
- Added Rotation Notification MDN extension fields (E5)
- Added optional rotatedKeyFingerprint/policyId fields to ReceiptUtils's build/parse functions, carried as RFC 8098 extension fields (X-RapidMX-Key-Fingerprint/X-RapidMX-Policy-Id) in the message/disposition-notification part - per spec these are a cache-invalidation hint only, never a trusted key source
- Added a new maybeRefreshRotatedKey(), called by processReceipt() whenever either extension field is present, which re-runs real Discovery (KeyringUtils.discoverAndMergeKeys()) against the authoritative endpoint rather than trusting the MDN's own claimed value - an MDN is only hop-authenticated, so installing its claimed fingerprint directly would let a forged MDN force a key change
- Added E2E feature specs
- Added DKIM+alignment checking, Disposition-Notification-To must-equal-From, and replay/uniqueness protection to MDN/receipt verification
- Added SSRF hardening in KeyDiscoveryClient: hostname validation, IP-literal rejection, redirect: "error", bounded-size streamed reads
- Added cert.checkEmail() validation against the mailbox address for signing-cert enrollment
- Added basicConstraints/keyUsage to leaf certs and build the subject DN structurally (no injection) in the PKI layer
- Added a regression test to ContactRoute.test.ts proving BaseContactRoute.create() actually rejects an empty displayName (400) - @Validate metadata cascades through every override via prototype-chain inheritance without needing to be redeclared, which a prior audit incorrectly flagged as broken
- Added validation-rejection integration tests across route classes
- Added a matching create-rejection test for both SQL and Mongo backends to every genuine gap found: TransportRule, ContactList, MailFilterRule, MailSignature, Note, TaskList, Task, Folder, CalendarShareLink, DistributionList
- Added validateWrappedPrivateKey() plus MAX_ENROLLED_KEYS/MAX_MASTER_KEY_WRAPS bounds, closing an unbounded-storage-growth DoS from wrappedKey/wrappedKeys having no field-shape validation at all
- Added a real HTTP/DB-backed regression test proving the specific failure scenario for every fix above, for both SQL and Mongo backends where applicable
- Added search operator grammar, Tier 3 candidates, and schema per specs/search.md - the mechanical, unambiguous server-side portion of the doc (companion to end-to-end_encryption.md's deferred search design), groups J/K/L/M of the scoping breakdown; client-side work (local FTS5 index, progressive-results UI, client-side re-scoring/merge) is out of scope for this repo
- Added folderUid, flags[], hasAttachments to SearchDocument, powering the in:/is:/has:attachment operators
- Added SearchDocument.metadataOnly / SearchResult.metadataOnly, set by SearchIndexJob when a message is encrypted (subject/body/attachmentText intentionally excluded), so a client can tell a participants-only score apart from a full-content one
- Added structured filter fields to SearchQuery (from/to/cc/subject/hasAttachment/before/after/folderUid/flags) per §14's query operator grammar - already parsed by the caller per the spec ("parsing happens once, client-side"), not raw operator text; all three providers (Mongo/Postgres/OpenSearch) translate these into real filter predicates
- Added CandidateQuery/CandidateResultPage types and SearchProvider.candidates(), implemented by all three providers, returning identifiers only ranked on server-visible metadata (participants/dates/folder/flags), never content, per §6/§12's Tier 3 design
- Added GET /search/candidates to BaseSearchRoute for the new Tier 3 candidate query
- Added CalendarEvent encryption provenance and skip auto-send for encrypted invites
- Added MTA impl for AWS SES

### Changed
- Update NOTES.md noting the 0.4.0 publish and that @rapidmx/server has dropped its yarn patch for a plain semver dependency on it
- Refine delivery/read receipts to a three-tier same-organisation/federated-peer/external scoping model instead of the previous binary internal/external one, per specs/end-to-end_encryption.md's Scoping Principle (receipts are a disclosing capability and MUST default to same-organisation only, not lumping a federated peer in with plain external correspondents)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Stop feeding S/MIME-encrypted mail's ciphertext into server-side pipelines that assumed a readable body - a standing correctness gap independent of the rest of the E2E encryption feature, since any externally-received encrypted mail already hits these code paths today
- Stop indexing body/attachment text in SearchIndexJob for an encrypted message (subject/participants/dates are unaffected - they're outer RFC 5322 headers, never encrypted by CMS EnvelopedData)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Note (not silently resolved): the spec's own worked example for the discovery hash is SHA-1-length (32 z-base32 chars) while its prose and formula both say SHA-256 (which produces 52) - implemented per the twice-repeated explicit SHA-256 statements, documented in computeKeyDiscoveryHash()'s doc comment for whoever corrects the spec's example
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Split the single logoUrl asset into a full logo (watermark/sign-in-style use) and a separate, independently configurable iconUrl for compact nav-header use, mirroring the existing logo upload/URL/delete plumbing end to end: BrandingMongo/BrandingSQL gain iconUrl/iconBlobKey/iconContentType columns, and BaseBrandingRoute gains POST/GET/DELETE /branding/icon mirroring the logo endpoints, plus PUT /branding now clears and deletes an orphaned icon blob the same way it already does for the logo
- Export readPublicBranding()/fetchBrandingPropsForSSR() so a downstream server's own wwwRoute/AdminConsoleRoute-style routes can read current branding in-process (no HTTP round trip) to render it server-side on the very first byte of the response, needed by rapidmx/server's own SSR title/favicon/stylesheet work
- Bump to 0.5.0
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Wire real federation detection into the three-tier receipt classification (roadmap item A5), replacing the always-false stub A2 shipped with - closes out Group A now that Group B's resolveFederationPolicy() exists
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Persist Message.encrypted (a prerequisite Group G's ScanPipelineResult.encrypted never made durable) and use it for roadmap item I1: stop AttachmentExtractionJob from running text extraction against an encrypted message's attachments
- Stamp Message.encrypted from ScanPipelineResult.encrypted at every point a Message is actually created or persisted from a scan: ScanQueueJob's two inbound delivery sites (primary + rule-copy), and BaseMessageRoute.send()'s outbound path via a new field on MailSendUtils.ScanAndRelayResult - needed because AttachmentExtractionJob and the eventual iTIP-to-CalendarEvent propagation (roadmap item I3) run well after the original ScanPipelineResult is gone, so Message itself has to carry the signal forward
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Set CalendarEvent.encrypted from the source message's own Message.encrypted (ScanQueueJob.processItipRequest()'s create branch only) when a REQUEST first materializes an event, deliberately never touched by the update branch - encryption state is sticky per the spec, preserved across every later resend/update/recurrence instance rather than recomputed from whatever message triggered that particular mutation
- Note this is currently the only part of the spec's "Derived Entities" section implemented: it's a provenance flag only, not actual field-level encryption of title/location/attachments, since today's iTIP pipeline only ever reads a text/calendar part that's already plaintext-visible to the server - a genuinely S/MIME-encrypted invitation has no such separately-visible part at all (the whole point of util/SmimeUtils.ts's isEncryptedBody() check), so this flag is set defensively for forward-compatibility rather than something the current pipeline exercises in the common case; real field-level encryption awaits the deferred client-side E2E composition/decryption work
- Defer I4 (an admin setting for automatic same-org derived-entity protection) - there is no code in this pass that ever applies derived-entity field-level encryption, so a toggle would have nothing to gate; revisit alongside the real encryption work
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Use three states (automatic/optional/prohibited), not a boolean, configured independently for encryptSameOrg/encryptFederated/encryptExternal - deliberately three because "not by default" (optional) and "not allowed" (prohibited) are materially different administrative intents a plain on/off toggle can't distinguish; defaults to "optional" for all three tiers since encryption is a protective capability with no reason to default more restrictively for federated/external than the spec's stated same-organisation default
- Model this directly on BaseBrandingRoute.ts, the one existing precedent in this codebase for a runtime-editable admin setting rather than static @Config: a singleton row at a fixed uid, the same TOCTOU-tolerant findOrCreate(), PUT gated by @RequiresTrustedRole() plus recordAuditLog(); differs from Branding in one deliberate way - GET requires authentication (any logged-in user, not just admins, since a compose UI needs this to decide what controls to offer) rather than being fully public
- Leave the separate digital-signing enable/disable toggle as a plain @Config boolean, unaffected - the spec only requires tri-state granularity for encryption, not signing
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Upgrade @rapidrest/service-core to ^2.0.0 (2.x peer range) for its query-string DSL overhaul: regex()/exists() operators, nested $or on SQL, tree-shaped query forms, sort-field validation, and fixes to MongoDB not()/ne() compilation and in()/nin()/range() type coercion
- Audit restapi's own query-DSL usage against the documented breaking changes (like() now uses glob syntax, unrecognized operators reject with 400) and confirm no impact: this codebase never uses the DSL's like() at all (the one alias-substring-match call site deliberately bypasses it with a raw TypeORM Raw() operator instead, for %/_ escaping the DSL didn't support), and every operator actually used (gte/gt/lte/lt/ne) is a recognized name unaffected by the stricter rejection rule
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Simplify BaseBookingRoute.countBookingsOnDay() back to a single range() count now that @rapidrest/service-core 2.0 fixes range()'s Date-coercion bug
- Confirm by reading the installed package's ModelUtils.coerceOperand() that both range() operands now go through the same Date-aware coercion gte()/lte() already used, resolving the exact bug the old two-subtracted-counts workaround existed for
- Keep range() inclusive on both ends (TypeORM Between() / Mongo $gte+$lte) by setting the upper bound to dayEnd minus one millisecond, preserving the exact same half-open [dayStart, dayEnd) window the workaround computed - otherwise a booking starting at exactly the next day's midnight would double-count into both days; existing maxPerDay same-day/next-day tests pass unchanged
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Mirror the DkimKeyProvider/SearchProvider pattern rather than hand-rolling certificate issuance inline: issue(identity, csr) takes a client-generated PKCS#10 CSR (proof of possession, and Vault/OpenBao-API-compatible from day one) rather than a bare public key
- Implement LocalX509CertificateAuthority to generate and persist a self-signed P-256 CA root on local disk (0600 key) using @peculiar/x509, verify each CSR's self-signature before issuing, and treat revoke() as a no-op since it has no CRL/OCSP responder - that's left to a production backend such as the still-to-come OpenBaoPkiCertificateAuthority
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement a thin adapter to a self-hosted OpenBao/Vault Community Edition PKI secrets engine's HTTP API - a genuinely free, self-hosted, no-contract backend, the same category as PostfixSendmailTransport being the recommended MailTransport; issue() posts the CSR to POST /v1/<mount>/sign/<role>, and revoke() identifies the certificate by serial number rather than fingerprint (Vault/OpenBao's own addressing scheme), so this class persists a small local fingerprint -> serialNumber map on issue() rather than pushing that translation onto callers
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Keep this a separate interface from EncryptionCertificateAuthority, not a variant of it - enrollment against a publicly-trusted CA is inherently asynchronous (startEnrollment()/checkStatus()), and the spec allows disabling signing certificates entirely for closed deployments, which this gives a clean "don't register a second token" story for
- Implement ManualSigningCertificateEnrollment to work with any public CA an admin chooses by hand: it validates the CSR's self-signature on startEnrollment(), persists pending enrollments to a small local JSON file (matching OpenBaoPkiCertificateAuthority's serial-map precedent from the previous commit), and verifies an uploaded certificate's public key actually matches the original CSR before accepting it via uploadCertificate()
- Defer the REST admin route for the certificate-upload step - startEnrollment() has no caller yet until Group D's key-vault enrollment endpoint exists, so a route with nothing driving traffic to it would be premature infrastructure
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Audit-log every mutating action, and add a FakeEncryptionCertificateAuthority test double (in-memory, real @peculiar/x509 issuance) since the default NullEncryptionCertificateAuthority throws
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement the server side of the federation discovery protocol whose client half (util/KeyDiscoveryClient.ts) shipped in Group B - unauthenticated, @RateLimit()-decorated per the spec's per-source-IP requirement (no new infrastructure, @RateLimit() already keys an independent per-IP counter)
- Look up Mailbox by its indexed keyDiscoveryHash column; the not-found and no-keys-published cases are byte-for-byte identical (200, not 404) by construction, both reducing to the same NOT_PUBLISHED_RESPONSE built from Mailbox.encryptPreference/keys' own class-level defaults, so there's no hand-maintained "make these two responses match" logic to drift out of sync
- Compute escrow from whether the mailbox's KeyVault holds any MasterKeyWrap with method "escrow" - the boolean disclosure the spec's Public Endpoint section already requires, unaffected by the deferred full Escrow Scoping work; ETag is a SHA-256 of the response body, and If-None-Match is honored with a 304
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Implement Discovery server-side as specs/end-to-end_encryption.md requires - browsers have no DNS TXT API and would hit CORS fetching an arbitrary third-party domain directly - so this endpoint performs the _rapidmx TXT lookup (util/FederationUtils.ts) and discovery-endpoint fetch (util/KeyDiscoveryClient.ts) itself and persists the result onto a Contact in the caller's own address book
- Use ordinary ACLUtils.hasPermission() (with its usual trusted-role bypass) here, deliberately unlike BaseKeyVaultRoute, since this only ever touches the address book, never private key material
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Wire this into ScanQueueJob.deliverMessage() via a new processInboundRapidMxKeyHeader() step that runs for every inbound message regardless of filtering/filing outcome, reusing Group E2's KeyringUtils.applyDiscoveredKeys() for the same TOFU/conflict/anti-downgrade merge logic; Contact.lastMessageSeen is stamped for an existing Contact even when nothing new was found, but a brand-new Contact is only created when a key was actually discovered, since lastMessageSeen alone isn't reason enough to add every random sender to the address book
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Make BaseMessageRoute.send() announce the sending mailbox's active encryption key alongside the existing Disposition-Notification-To attachment, mirroring that same pattern: only a non-revoked, non-expired "encrypt" key is ever announced (a "sign"-only key never produces a header)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Make sendDispositionNotification() announce the reporting mailbox's own active encrypt-key fingerprint on the sending side, mirroring E4's outbound RapidMX-Key logic
- Refactor the Contact create-or-update persistence tail shared by E3's processInboundRapidMxKeyHeader() and the new maybeRefreshRotatedKey() into persistContactKeyUpdate()
- Complete Groups C/D/E of the DS/E2E encryption roadmap
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Require a configured, trusted authserv-id for Authentication-Results and fail closed when unset, closing forged-DKIM key-pinning
- Reject Mailbox.keys/keyDiscoveryHash outright on a client PUT (value-aware, so empty-array bodies still work), closing CA-bypass and discovery impersonation
- Move ContactSQL's epoch-ms columns to type "double", fixing silent mail-drop on Postgres/MySQL ("integer out of range" on the old 32-bit int mapping)
- Close escrow wraps being addable/removable/fakeable through the owner/delegate endpoints
- Scope the discovery endpoint by Host header and close its timing oracle
- Reject sending the OpenBao token over plaintext HTTP off-loopback
- Key RapidMX-Key on the From header instead of envelope-from
- Hoist N+1 domain/DNS queries in BaseMessageRoute.send() out of the per-recipient loop
- Make encrypted-attachment handling consistent between ScanQueueJob and TransportRuleUtils
- Document Escrow RBAC, CRL/OCSP infra, DKIM-oversigning automation, and DNSSEC validation as required deployment configuration in README - intentionally out of scope as net-new features, not bugs
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Apply RapidREST conventions to close several route-convention gaps found in an audit, with a regression test
- Move BaseEncryptionPolicyRoute.update()'s inline enum validation into a @Validate("validateUpdate") method, run by the framework strictly before the handler instead of inline at the top of it
- Move BaseBookingRoute.book()'s bookerName/bookerEmail shape checks into a @Validate("validateBook") method, leaving slot-availability checks that need a DB lookup in the handler as business-rule checks
- Apply @Before("rejectWrite") to BaseAuditLogRoute's create/update/delete/truncate, matching BaseACLRoute's own @Before-guard convention, with handlers keeping a defensive direct call to rejectWrite() too
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Leave AuditLogRoute (writes are blocked outright, 403 not 400), KeyDiscoveryRoute and DomainRoute.dkim (no rejectable input by design/scope), Attachment (upload path, not model-validated JSON create), DistributionListDomains (already has a real, narrowly-scoped domain-verification test), and EncryptionPolicyRoute (already has a real enum-rejection test) untouched after confirming each doesn't have a real gap
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Validate BaseKeyVaultRoute.enrollKey()'s body.masterKeyWraps instead of passing it straight to persistence unvalidated, unlike its sibling addMasterKeyWrap()/rekey() endpoints - closes the exact escrow-spoofing gap validateMasterKeyWrap() exists to prevent, just on the third call site that was missed
- Sanitize BaseAttachmentRoute's filename at upload and escape it at download, closing a Content-Disposition injection where an embedded quote could break out of the quoted value and spoof the saved filename
- Make BaseMailIngestRoute.deliver() share one blob per deliver() call for direct-mailbox recipients instead of writing a fresh copy per recipient, matching the distribution-list branch a few lines down which already does this
- Batch MailboxQuotaRecalcJob's attachment queries via the query DSL's in() operator in chunks of 100 instead of issuing one query per message with attachments (N+1)
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Split SearchDocument's participants[] into from/to[]/cc[], keeping participants[] as the union for existing free-text ranking, per §14's "Required Schema Changes"
- Wire all of the above into SearchIndexJob.buildDocument() for Message, the only entity type this job indexes today
- Switch PostgresFullTextSearchProvider from plainto_tsquery to websearch_to_tsquery for the free-text portion, and add an ALTER TABLE ADD COLUMN IF NOT EXISTS step so an upgrading deployment picks up the new columns (CREATE TABLE IF NOT EXISTS alone is a no-op against an existing table)
- Match subject: as an additional AND predicate scoped to the subject field alone, not a replacement for full-field free-text ranking
- Make BaseSearchRoute's q optional, gated on "at least one of q or a structured filter" instead of requiring q unconditionally, so a pure structured-filter query like subject:budget is valid
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Replace CalendarEvent.encrypted (a flat boolean) with encryptionOrigin: EncryptionOrigin ("none"/"derived"/"originated") per specs/search.md §3 "Provenance", so a client can explain why an event is encrypted ("received encrypted from bob@orgb.com" vs. "you chose to encrypt this") rather than collapsing both into one indistinguishable flag
- Set "derived" on create and "none" otherwise in ScanQueueJob's inbound iTIP pipeline (the only place that sets this today), continuing to never touch it on update so encryption state stays sticky per the spec; "originated" is for a client explicitly marking its own outbound invite as encrypted via ordinary CRUD, not specially protected since this field only gates indexing/send behavior, not access
- Make MeetingSchedulingJob skip composing/sending a plaintext iTIP REQUEST/CANCEL entirely for an encryptionOrigin: "originated" event, since that's the client's own responsibility end to end (compose, encrypt, send), matching this repo's scope boundary that real crypto only ever happens client-side; still stamps inviteSequenceSent/cancelNoticeSentAt so the job doesn't keep re-visiting an event it will never actually send, the same "skip the send, still mark handled" shape isRedundantOccurrenceCancel already used
- Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
- Moving Ses transport impl to this repo

### Fixed
- Fixed TransportRuleUtils.bodyContains to cleanly never-match an encrypted body's empty preview; also fixes a real bug found along the way - mailparser folds an encrypted body's own ciphertext into parsed.attachments as a synthetic node (a real EnvelopedData message has no separate visible attachment inside it), which was making hasAttachment/attachmentNameContains false-positive for encrypted mail
- Fixed AttachmentExtractionJob.processAttachment() to look up the parent message first and skip straight to stamping an empty extractedTextBlobKey (exactly like today's unsupported-MIME-type path) when it's encrypted, never handing ciphertext to ExtractorRegistry - mirrors the same encrypted-body gate already applied to ScanPipeline/SearchIndexJob/TransportRuleUtils in the earlier Group G commit
- Fixed two bugs caught during testing: EncryptionPolicySQL's PolicyState (string-literal-union) columns needed an explicit @Column({ type: "varchar" }) since TypeScript's emitDecoratorMetadata can't reflect a union type into a primitive constructor better-sqlite3 can resolve on its own (the same gotcha CalendarEventSQL.status already documents for real enums), and update() validated incoming policy values after findOrCreate() had already materialized the singleton row so a rejected (400) request still had the side effect of creating it on what should have been its first write - validation now runs first
- Fixed critical/high security findings from two adversarial reviewers auditing the E2E encryption feature (v0.4.0..HEAD) plus the service-core 2.0 migration
- Fixed sameIssuingCa() to use real signature-based self-signed detection instead of DN-string comparison, and always recompute discovered-key fingerprints from the actual certificate rather than trusting them as asserted
- Fixed rekey() to validate against already-enrolled fingerprints instead of publishing arbitrary unvalidated certificates
- Fixed the CA key generation race to be atomic
- Fixed EncryptionPolicyMongo to extend BaseMongoEntity instead of BaseEntity, a copy-paste bug that lost _id mapping and the uid/version unique index
- Fixed anti-downgrade to use the message Date instead of wall-clock
- Fixed findings from a second adversarial review pass, covering the codebase again post-convention-fixes: one reviewer focused on the E2E encryption/key-vault surface, ACL correctness, and concurrency; the other on the remaining routes, jobs, and utilities
- Fixed removeMasterKeyWrap() to reject an ambiguous request instead of silently deleting every wrap of a method when methodId was omitted and more than one existed
- Fixed MeetingSchedulingJob.sendInvites()'s unfiltered, unsorted query, which could permanently starve a genuinely new event out of the fetch window once CalendarEvent rows exceeded batch_size - added a status filter and sort: -dateModified so a new/edited event always surfaces first
- Fixed BaseMailboxRoute/BaseDistributionListRoute to re-validate a changed primarySmtpAddress on update (including the dedicated updateProperty() rename endpoint, which bypasses the @Validate dispatch pipeline entirely since it calls update() in-process) - previously let a caller silently point their own mailbox/list at another entity's address, hijacking its mail flow; now re-runs the same verified-domain/collision checks create() applies, only when the address is genuinely changing
- Fixed OpenSearchProvider.search() to populate SearchResult.snippet via a highlight block, closing a pre-existing gap the spec calls out explicitly (§1) where the interface declared the field but no provider ever set it

### Removed
- Removed @rapidrest/cli as a dep

## [0.4.0] - 2026-09-09

### Added
- Added a DkimKeyProvider abstraction (FsDkimKeyProvider/NullDkimKeyProvider) so a deployment can opt into automatic per-domain DKIM key generation instead of the previous admin-fills-it-in-by-hand-only model
- Added GET /internal/mta/domain to BaseMailIngestRoute so an MTA's relay-domain acceptance check can stay in sync with this app's own Domain database dynamically, with no MTA restart needed
- Added test/dkim/FsDkimKeyProvider.test.ts, test/routes/{mongo,sql}/DomainRoute.dkim.test.ts, new /internal/mta/domain cases in the existing MailIngestRoute tests, and a real-DI regression test for the ScanPipeline config-default fix

### Changed
- Wire DkimKeyProvider into BaseDomainRoute.create() (auto-fills dkimSelector/dkimPublicKey unless the caller already supplied both) and dnsSetup() (lazily backfills a pre-existing domain missing them)
- Register NullDkimKeyProvider as the default test double, required because @Inject throws when nothing at all is registered under a token
- Document the new /internal/mta/domain endpoint in transport/MTAIngestAdapter.ts alongside the existing resolve/deliver contract
- Update Domain.dkimSelector/dkimPublicKey doc comments, which previously asserted this library never generates or stores DKIM key material

### Fixed
- Fixed ScanPipeline's allowedTags @Config field having no default, which made ObjectFactory.initialize() throw for any deployment that never explicitly sets mail:scan:sanitize:allowed_tags, silently disabling all spam/AV scanning

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

[Unreleased]: https://github.com/RapidMX/restapi/compare/v0.18.0...HEAD
[0.18.0]: https://github.com/RapidMX/restapi/compare/v0.17.0...v0.18.0
[0.17.0]: https://github.com/RapidMX/restapi/compare/v0.16.0...v0.17.0
[0.16.0]: https://github.com/RapidMX/restapi/compare/v0.15.0...v0.16.0
[0.15.0]: https://github.com/RapidMX/restapi/compare/v0.14.0...v0.15.0
[0.14.0]: https://github.com/RapidMX/restapi/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/RapidMX/restapi/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/RapidMX/restapi/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/RapidMX/restapi/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/RapidMX/restapi/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/RapidMX/restapi/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/RapidMX/restapi/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/RapidMX/restapi/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/RapidMX/restapi/compare/v0.4.0...v0.6.0
[0.4.0]: https://github.com/RapidMX/restapi/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/RapidMX/restapi/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/RapidMX/restapi/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/RapidMX/restapi/compare/v0.1.0...v0.2.0
