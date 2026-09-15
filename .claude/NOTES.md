# restapi — Design Decisions & Session Notes

This file exists so that Claude sessions working in this repo don't re-litigate settled
decisions or re-discover the same issues from scratch. It is local to this repo (not tied to
any one machine's global Claude memory), so it travels with the code.

**Maintenance rule:** when a standing decision changes, update the section below in place
(don't just append a contradiction lower down). When a new investigation/session produces a
decision, finding, or reverted approach worth remembering, add a dated entry under Session Log.
Keep entries terse — this is a reference, not a transcript.

## Standing design decisions & constraints

- **Vulnerability/review threat model: externally-exploitable only.** This library is a power
  tool for developers building their own services, not a hardened black box. When reviewing for
  "vulnerabilities," only count issues reachable from a downstream, untrusted HTTP/WebSocket
  client hitting a service built on the framework (anonymous or low-privilege caller). Do NOT
  flag: developer-only footguns (misusing an API, a decorator applied wrong in your own code),
  internal utilities only the operator touches (build/CLI/startup wiring), or purely theoretical
  races with no concrete external trigger path. Every finding should be able to name the actual
  HTTP route/method or WS message type that reaches the code in question.

- **Commit discipline.** Don't `git commit` unless explicitly asked for *that specific piece of
  work*. An autonomous-execution/"commit as you go" approval given for one approved plan (e.g. via
  plan mode) is scoped to that plan only — it does not carry forward to later, separate requests in
  the same session, even ones that look similar in kind (a follow-up review-and-fix pass, a
  refactor, a new feature), and even after a full review-and-fix cycle with passing tests. Default
  to leaving changes staged/unstaged and saying so; only commit automatically within the exact
  scope of a plan that was explicitly approved as autonomous. If unsure whether new work falls
  inside that scope, treat it as outside and ask.

- **Commit message style: a flat list of one-line, verb-led items — no summary/title line, no
  `-`/`*` bullet markers.** This isn't just a style preference — it's dictated by how `release`
  (`@rapidrest/cli`) actually builds `CHANGELOG.md`. `collectChangelogBullets`/
  `classifyChangelogLine` (that repo's `src/lib/release.ts`) parse `git log --pretty=format:%B` and
  treat **every non-blank line of a commit's full message as its own changelog bullet** — there is
  no subject/body distinction. A conventional "short imperative subject + blank line + prose body"
  commit therefore leaks one changelog bullet per body sentence, and a `-`/`*`-prefixed line breaks
  `classifyChangelogLine`'s verb detection (it reads the line's first whitespace-delimited word as
  the verb; a leading `-` defeats that lookup and the dash leaks into the changelog text as
  `"- - Added foo"`). Correct format:
  - No separate summary/title line — if a commit needs an overview, that overview is itself just
    one more flat line, not a heading distinct from the rest.
  - No bullet-marker prefix of any kind — write bare lines.
  - Lead each line with an imperative verb where it fits: `Add`/`Fix`/`Remove` (and `-ing` forms)
    are recognized and become `Added`/`Fixed`/`Removed` entries; `Configuring`/`Converting`/
    `Refactoring`/`Updating`/etc. become `Changed`. Anything else still works, defaulting to
    `Changed` verbatim — see `CHANGELOG_VERB_REWRITES` in that repo's `src/lib/release.ts` for the
    full map.
  - A blank line before a trailing git trailer (`Co-Authored-By:`, `Signed-off-by:`, etc.) is fine
    — trailers matching `CHANGELOG_NOISE_PATTERNS` are dropped from the changelog — but nothing
    else should follow the item list.
  This mirrors JP's standing convention across his other repos; copy this exact rule verbatim into
  each sibling repo's own NOTES.md rather than paraphrasing it, since the paraphrase is what caused
  this to be gotten wrong in the first place (see `@rapidrest/cli`'s own NOTES.md, 2026-09-07 entry,
  for the full incident writeup and the `CHANGELOG_NOISE_PATTERNS` fix that accompanied it).

## Session Log

### 2026-09-06 — Repo split: `@rapidrest/mail` → four RapidMX packages

- **This repo is `@rapidmx/restapi`**, carved out of the former monolith `@rapidrest/mail`
  (`d:\github\rapidrest\mail`, still present there for reference/history — nothing was deleted from
  it as part of this split). It keeps everything **except** Exchange ActiveSync, MAPI over HTTP, and
  Autodiscover, which became their own independently-versioned sibling packages:
  `@rapidmx/activesync`, `@rapidmx/mapi`, `@rapidmx/autodiscover`. All three depend on this package
  for models, REST-layer utilities (`FolderUtils`/`MailSendUtils`/`MailboxScopeUtils`/
  `RecoverableRepoUtils`), blob storage, and the scan pipeline.
- **New public surface added specifically to support the split**: `src/util/index.ts` (a barrel for
  the four utilities named above) is now re-exported from the package root. It didn't exist before
  the split — `src/util/*` was previously internal-only, but `activesync`/`mapi` both import these
  files directly, so they needed to become real exports.
  `src/util/OptionalDeps.ts` (`importOptional()`) was deliberately **not** added to this barrel — it's
  an internal helper for this package's own optional peer dependencies (PDF/DOCX extraction,
  OpenSearch), nothing downstream needs it.
  Dropped instead: `./eas`, `./mapi`, `./autodiscover` `package.json` export subpaths and their
  backing `src/eas.ts`/`src/mapi.ts`/`src/autodiscover.ts` flat barrels, and the corresponding
  `export * from "./eas/mongo.js"` (etc.) lines in `src/mongo.ts`/`src/sql.ts` — that source moved out
  entirely, not just its export path.
- **`ical.js`/`vcard4` dropped as dependencies** — confirmed via an exhaustive grep across the entire
  former monolith's `src/`/`test/` that neither package was imported anywhere. Dead dependency debt
  from an earlier design, not something removed by the split itself; simply not carried forward.
- **Local dev linking for the three add-on packages**: each depends on this package via Yarn Berry's
  `portal:../restapi` in their own `devDependencies` (plus a real `peerDependencies` semver range for
  when this package is actually published) — no publish needed for local development, since all four
  repos live as siblings under `d:\github\rapidmx\`.
- If you're investigating something that touches EAS/MAPI/Autodiscover-specific behavior, it isn't
  here anymore — check the relevant sibling repo's own `.claude/NOTES.md` first, and the original
  monolith's `.claude/NOTES.md` (`d:\github\rapidrest\mail`) for the original design rationale behind
  code that predates the split.
- **Inherited, pre-existing coverage gap (not introduced by the split)**: a full `vitest run --coverage`
  lands at 99.65%/98.03%/99.54%/99.71% (stmt/branch/func/line), just under the 100% stmt/func/line
  threshold, in the exact same handful of files the original monolith already carried this gap in
  (`CalendarStorageRecalcJob.ts`, `ScanQueueJob.ts`, `CalendarShareLinkRoute.ts`, `FolderRoute.ts`,
  `MailIngestRoute.ts`, `MailboxRoute.ts`, `MessageRoute.ts`, `ChildRoute.ts`, `MailboxRouteMongo.ts`/
  `SQL.ts`, `ScanPipeline.ts`, `PlainTextExtractor.ts`). This code moved unchanged from the monolith - it's
  the same debt, not a new one. A full suite run also hit one confirmed-transient
  `MongoNetworkError: ECONNRESET` in `test/routes/mongo/FolderRoute.test.ts` under load, reproduced passing
  20/20 in isolation immediately after - a `mongodb-memory-server` flakiness issue, not a real regression
  (same pattern the monolith's own NOTES.md already documented for a different test file).

### 2026-09-06 — Fixed: a brand-new mailbox had zero folders, breaking both the webmail inbox and Compose

JP reported (via `@rapidmx/server`'s admin console) that a mailbox he'd just created showed a
"no mailbox available" error the moment he tried to access it in webmail. Root cause traced here,
not in `server`.

- **`findOrCreateWellKnownFolder`'s well-known folders (Inbox, Junk, Sent Items, ...) are all
  provisioned lazily** (see its own doc comment) — the only callers were `ScanQueueJob` (Inbox/Junk,
  on first delivered message) and `BaseMessageRoute.send()` (Sent Items, on first send).
  `BaseMailboxRoute.create()` never created any folder at all. A mailbox that has never received or
  sent mail therefore has **zero** folders, including no Inbox — genuinely correct for Junk/Sent
  Items (an unused mailbox shouldn't have an empty Junk folder cluttering its tree), but Inbox is
  load-bearing: any webmail client built expecting `folders.find(f => f.type === "inbox")` to exist
  (as `@rapidmx/server`'s `MailShell` does) has nothing to select and shows an empty/broken state,
  even though the mailbox itself was created successfully. Drafts has the identical problem one step
  later: `server`'s Compose page reads `folders.find(f => f.type === "drafts")` before it will create
  a new draft at all.
- **Fix, in `BaseMailboxRoute.create()`**: after creating the mailbox (single or bulk), eagerly call
  `findOrCreateWellKnownFolder()` for `FolderType.INBOX` and `FolderType.DRAFTS` only — every other
  well-known folder stays lazy, unchanged. `folderClass` is now an abstract field on
  `BaseMailboxRoute` (mirroring `BaseMessageRoute`'s existing pattern exactly), supplied by
  `MailboxRouteMongo`/`MailboxRouteSQL` as `FolderMongo`/`FolderSQL`. Any other subclass of
  `BaseMailboxRoute` (none exist outside this package today) will fail to compile until it supplies
  one too — deliberate, not an oversight.
  New coverage: `test/routes/{mongo,sql}/MailboxRoute.test.ts` each gained a test asserting
  `GET /folders?mailboxUid=` returns exactly `["drafts", "inbox"]` immediately after `POST
  /mailboxes`. `test/routes/BaseMailboxRoute.test.ts`'s bare `TestMailboxRoute` needed a dummy
  `folderClass = Object` added purely to satisfy the new abstract member (its tests never reach
  `create()` — they're `repoUtils`-guard-clause-only, per that file's own header comment).
- **Verification**: this package's own `yarn build`/full `yarn vitest run` both clean (820/820). Then
  verified the actual end-to-end symptom is gone via `@rapidmx/server`: `yarn patch
  @rapidmx/restapi` + replace the extracted copy's `dist/` with this package's freshly-built one +
  `yarn patch-commit` (temporary, for verification only — this package's own version was **not**
  bumped or published; JP still needs to publish a real new version and `server` will then move off
  the patch back onto a plain registry range), `yarn dev` in `server`, then `curl`'d a real
  `POST /api/mail/mailboxes` followed by `GET /api/mail/folders?mailboxUid=...` and confirmed both
  Inbox and Drafts come back immediately, plus `GET /admin/mailboxes/detail?uid=...` and
  `GET /?mailboxUid=...` both `200`. See `@rapidmx/server`'s own NOTES.md for the patch-application
  side of this if picking the follow-up (moving off the patch once published) back up later.

### 2026-09-06 — Extended the same fix to Calendar/Contacts/Tasks folders

`@rapidmx/server` started building real Calendar/Contacts/Tasks views (a persistent nav rail to all
three, alongside Mail) — each is a permanent, always-visible destination now, not an opt-in feature,
so the same reasoning from the Inbox/Drafts fix above applies to their well-known folders too.
`BaseMailboxRoute.create()`'s eager-provisioning loop now also creates `FolderType.CALENDAR`,
`FolderType.CONTACTS`, and `FolderType.TASKS` (five total: `calendar, contacts, drafts, inbox,
tasks`). Every *other* well-known folder (Junk, Sent Items, Deleted Items) is still lazy — only
folders a permanent nav destination depends on to render anything are eager. Updated both
`test/routes/{mongo,sql}/MailboxRoute.test.ts`'s folder-list assertions to match.

- **Ran into (and ruled out) a red herring while verifying this**: mid-session, `git status` showed
  unrelated uncommitted changes in this repo — new `oofEnabled`/`oofMessage`/`oofStartTime`/
  `oofEndTime` fields on `MailboxMongo`/`MailboxSQL` plus `DeviceSyncStateMongo`/`SQL` changes (JP's
  own in-progress MS-ASSettings Out-of-Office work, unrelated to this session). A full suite run
  briefly showed `BULK_UPDATE_FAILURE` (`api-022`) on every mailbox-creation test while that work
  was mid-edit, and a separate run showed 43 failures concentrated in `ContactRoute.test.ts`
  immediately after. Confirmed both were transient/unrelated to this fix, not caused by it: a
  same-suite rerun a few minutes later (after JP confirmed he'd finished that work) was clean
  (822/822), with `git status` back to showing only this session's own three files. **Lesson**: this
  repo can have a real human actively editing it concurrently with a Claude session — an
  unexplained failure is worth a `git status` check for surprise unstaged changes before assuming
  your own edit caused it, and worth a plain rerun before spending time root-causing what might be
  transient/someone-else's mid-edit state.
- **Verification**: this package's own `yarn build`/full `yarn vitest run` both clean (822/822).
  Re-refreshed `@rapidmx/server`'s `yarn patch @rapidmx/restapi` the same way as the entry above
  (still not a real version bump/publish).

### 2026-09-07 — Found (not fixed here): `CalendarEvent.startDate`/`endDate` persist as strings, not `Date`

While finishing the Calendar view in `@rapidmx/server` (see that repo's own NOTES.md, same date),
smoke-testing against a real running server found that `CalendarEventMongo`'s `startDate`/`endDate`
— declared `public startDate: Date = new Date();` — are actually stored in Mongo as plain strings.
Confirmed by inspecting a created document directly via the `mongodb` driver:
`doc.startDate.constructor.name === "String"`. Consequence: `ModelUtils.getQueryParamValueMongo`'s
`lte`/`gte` operators build a query against a real `Date` operand (`new Date(matches[2])`), and a
Mongo range comparison between a `Date` operand and a string-typed field matches nothing — verified
with `curl`, where even a trivially-true `endDate=gte(1970-01-01T00:00:00.000Z)` (no other filters)
returned `[]` for a folder that has an event. This isn't calendar-event-specific in principle — it's
whatever code path handles `create()`/`update()` for `Date`-typed fields not coercing an incoming
JSON string to a real `Date` before the record is persisted (TS's `Date` type annotation has no
runtime effect on its own) — but Calendar's date-range querying is the first place in either
consuming repo that actually exercises `lte`/`gte` against a `Date` field, so nothing else surfaced
it yet. Likely affects every `Date`-typed column across every model, mongo and SQL both (not
verified for SQL). **Not investigated further or fixed** — out of scope for the session that found
it (a `server`-side feature, not a restapi task) and needs someone who knows whether the intended
fix is in the base entity's `create`/`update` (a general coercion) or somewhere more specific.
`@rapidmx/server` worked around the *symptom* by dropping server-side date-range filtering for
calendar events entirely (fetches the flat list, filters client-side) rather than depending on this
until it's fixed at the source.

### 2026-09-07 — Added self-service mailbox auto-provisioning to `BaseMailboxRoute`

`@rapidmx/server` needed a way for a brand-new auth-server user with no mailbox yet to get one
without an admin manually creating it first. Started as a `server`-side route; JP redirected it here
mid-session — general backend capability any consumer of this library might want, same reasoning as
`create()` itself already living here, not webmail-client-specific glue.

- **`BaseMailboxRoute.autoProvision()`** (`POST .../auto-provision`, `@Auth(["jwt"])`): this system
  has no email registered anywhere for a brand-new user by definition, so the address has to be
  derived from identity auth-server already has — calls auth-server's own `GET /api/aliases/me?
  type=name`, forwarding the caller's `jwt` cookie (so it only ever sees *their* aliases), then
  offers the full cross product of those aliases against the new `mail:domains` config as the set of
  addresses the caller could register. A caller can have more than one alias and a deployment can
  serve more than one domain — deliberately **never auto-creates on the first call**, even when
  there's only one possible combination; the client always gets a `needs_selection` response to
  confirm from, and only a follow-up call with an explicit `{alias, domain}` (re-validated against
  the real alias list and domain list, never trusted blindly) actually creates anything. Idempotent:
  a caller who already owns a mailbox gets it back (`status: "existing"`) before ever contacting
  auth-server at all.
- **`mail:domains` (string[], default `[]`) is new and is *not* auto-provision-specific** — JP's own
  correction mid-session: this is the one source of truth for every domain this mail server accepts
  mail on, for a deployment that serves more than one domain. `create()` itself now rejects *any*
  caller's `primarySmtpAddress` (trusted admin included — "even when explicit by an admin" was JP's
  exact framing) whose domain isn't in this list, once it's non-empty; empty stays today's
  unrestricted behavior for backward compatibility. New sibling config:
  `mail:auto_provision:enabled` (bool, default `false` — deliberately opt-in, silently minting
  mailboxes is a real behavior change), `mail:auto_provision:quota_bytes`/`timeout_ms`. Reuses the
  already-existing `mail:auth_server_url` for a genuine server-to-server HTTP call this time (no
  prior precedent for that in this package — see `RspamdSpamScanProvider.ts` for the only other
  `fetch`-with-timeout example, followed here for the `AbortController` pattern).
- **New**: `GET .../domains`, returning the configured list — lets a client (e.g. `server`'s admin
  "New mailbox" form) constrain the domain half of an address to what this server actually accepts
  without duplicating the list.
- **Every `@Config` field here has a real (non-`undefined`) fallback default**, including
  `authServerUrl` (`""`), unlike the pre-existing `WwwRoute.ts` pattern in `server` that has no
  default at all — that one gets away with it only because `server`'s own config defaults always set
  the key. This package's own route classes get instantiated broadly across its test suite without
  that guarantee: a `@Config` field with no default throws `"No configuration variable is defined at
  path: ..."` at DI-instantiation time the moment the key is genuinely absent — confirmed the hard
  way here (broke 28 unrelated test files at once) before adding the fallback.
- **Verification note for future coverage work**: this route's own two "authenticated user with zero
  ACL grants" branches in `find()`/`count()` (pre-existing code, present before this session, unowned
  by this change) turned out uncovered too, confirmed via a controlled before/after comparison (moving
  the new test files aside and re-running) that it wasn't something this session's own tests caused.
  Closed anyway with two small additions to `MailboxRoute.test.ts` (mongo + sql) since they were
  trivial and directly adjacent — not scope creep, just tidying a gap found while already in the file.
- Full suite: 858/858 passing, 100% coverage on every file this change touched (branches held to this
  package's own 95% floor — see `vitest.config.ts`'s comment on why, unrelated to this work).

### 2026-09-07 — Follow-up: `mail:auto_provision:static_aliases` bypass, for a consumer with no
real auth-server to call at all

`@rapidmx/server` needed this feature to also work under its own plain `yarn dev` (no auth-server
running, no stand-in for one either) — the original design above assumed `mail:auth_server_url`
always points at a real, separate, reachable HTTP service. Attempting to point it at the *consuming
server's own address* (a same-process dev-mode shortcut, tried first in `server`) surfaced a real
uWebSockets.js limitation: a Node `fetch()` call targeting a server's own listening address, issued
from *inside a request handler already executing on that same process*, is refused at the TCP level
(`ECONNREFUSED`) — confirmed the identical endpoint works fine called from curl or a separate Node
process, isolating the failure specifically to same-process self-connection mid-request. Not
fixable by adjusting the fetch call itself; see `server`'s own NOTES.md (2026-09-07 follow-up entry)
for the full diagnostic trail.

- **Fix**: new `@Config("mail:auto_provision:static_aliases", [])` field on `BaseMailboxRoute`
  (`string[]`, default `[]`). When non-empty, `fetchNameAliases()` returns it directly — no
  `authServerUrl`/`fetch()` call at all, real or otherwise. `autoProvision()`'s enabled-guard
  (`hasAliasSource = staticAliases.length > 0 || !!authServerUrl`) now accepts either as a valid
  alias source, so a deployment can use this instead of `authServerUrl` entirely, not just as a
  dev-only fallback — same category as `mail:domains`, a plain config override, not a "dev mode"
  concept from this class's own point of view.
- Covered by a new, separate test file (`test/routes/mongo/MailboxAutoProvisionStatic.test.ts`)
  rather than added to the existing `MailboxAutoProvision.test.ts` — that file deliberately exercises
  the *real* `authServerUrl`+mocked-`fetch` path at module-level config, and mutating
  `mail:auto_provision:static_aliases` in the same file would either conflict with that or need
  awkward per-test config toggling that this framework's `@Config`-at-DI-time resolution doesn't
  support anyway (config must be set before the route/`Server` is constructed). The new test asserts
  `fetch` is never even called, not just that the right aliases come back.
- Full suite: 859/859 passing, restored to 100% statement/function/line coverage (branches still
  held to the 95% floor) after this addition.

### 2026-09-07 — Phase 0 of an Outlook-parity redesign: new `TaskList` entity, `Contact`/`Task`/
`Folder` field additions

First phase of a large, multi-phase `@rapidmx/server` UX overhaul (see that repo's own NOTES.md for
the full plan) — this session only touched backend surface, no frontend.

- **New entity `TaskList`** (`{mailboxUid, name}`) — a direct structural copy of `ContactList`:
  `src/models/{mongo,sql}/TaskList{Mongo,SQL}.ts`, `src/routes/{mongo,sql}/TaskListRoute{Mongo,SQL}.ts`
  (each just an 11-line `BaseScopedChildRoute<TaskListX>` subclass with `scopeProperty: "mailboxUid"`),
  plus barrel-export lines in all four `index.ts` files. Full CRUD + permission test coverage mirrored
  1:1 from `ContactListRoute.test.ts` (mongo+sql) into new `TaskListRoute.test.ts` files.
- **New fields**: `Task.taskListUid?`/`assignedTo?` (both plain optional strings, no migration
  concerns), `Contact.categories?: string[]` (Mongo: plain array column; SQL: `{type: "simple-json",
  nullable: true}`, mirroring `Message.references`'s SQL pattern rather than any Mongo-only array
  column, since those aren't a valid SQL precedent), `Folder.color?: string` (same shape as the
  pre-existing `Note.color`).
- **Real bug found and fixed via a genuine SQL schema-migration failure, not just a test artifact**:
  the first attempt at `Contact.favorite`/`Task.myDay` declared them as required `boolean` fields with
  a TypeScript-level default (`= false`), the same pattern `completed`/`unreadCount` etc. already use.
  This compiled and typechecked fine, but **broke real SQL schema sync**: `@rapidrest/service-core`'s
  own `@Column()` decorator wrapper's `ColumnOptions` type has no `default` option at all (only `name`/
  `nullable`/`primary`/`isObjectId`/`type` — confirmed by reading `PersistenceDecorators.d.ts`
  directly), so there's no way to give a new NOT NULL boolean column a SQL-level default through this
  framework today. Reproduced directly: TypeORM's `synchronize`-driven `ALTER TABLE ADD COLUMN` against
  an existing (locally persisted, `rrst-test*`) SQLite table failed with `NOT NULL constraint failed`,
  since old rows have nothing to populate the new column with and no default was declared. **This is a
  real production-upgrade hazard**, not a local-dev-only quirk — any real SQL deployment upgrading past
  this change with existing `Contact`/`Task` rows would hit the identical failure. **Fix**: made both
  fields optional (`favorite?: boolean`, `myDay?: boolean`, `undefined` treated as `false` by
  consumers) instead of required-with-default — nullable columns don't have this problem, and this
  matches the codebase's own extensive existing precedent for "absence means the default" optional
  fields. **Did not** extend `@rapidrest/service-core`'s `ColumnOptions` to add real `default` support
  (the more "correct" fix, since TypeORM itself supports it natively) — that's a separate sibling-repo
  change with its own build/patch/test cycle, out of proportion to what this pass needed; worth doing
  if a future field genuinely can't be modeled as optional.
- **Removed a small piece of genuinely dead code found while in the area**: `MailboxRouteMongo`/
  `MailboxRouteSQL`'s `findAccessibleMailboxUids()` had an `if (!this.aclRepo) return [];` guard that
  was never reachable in practice (`@Repository`-injected, and the `acl` datastore is a hard
  requirement of the entire library — if it were ever actually missing, every other permission check
  everywhere else would already be broken first). Simplified to a non-null assertion (`this.aclRepo!`),
  matching this codebase's own established pattern for the same class of always-injected dependency
  (`BaseFolderRoute.aclUtils!`) — this closed the `lines` coverage gap this exact branch had been
  causing across at least two separate sessions now (see the 2026-09-07 "self-service mailbox
  auto-provisioning" follow-up entry above), though a separate, unrelated, much deeper one-function gap
  remains in `MailboxRouteSQL.ts` (a `Raw((alias) => ...)` TypeORM query-builder callback whose exact
  invocation timing wasn't worth chasing further this session — flagged, not fixed).
- Full suite: 885/885 passing. Coverage: statements 99.93%, functions 99.56% (both just the one
  pre-existing `Raw()`-callback gap short of 100%), lines 100%, branches 98.52% (comfortably above the
  95% floor). `yarn build` clean.

### 2026-09-07 — Added four new features: mail filters (inbox rules), scheduled send, mail
signatures, automatic replies (OOF)

Full implementation plan lives at (session-local) `i-d-like-your-help-polymorphic-eagle.md`. All four
follow this repo's existing structural conventions (interfaces in `types.ts`, paired `*Mongo`/`*SQL`
entities, `BaseScopedChildRoute` subclasses scoped by `mailboxUid`, `BackgroundService` jobs).

- **`MailFilterRule`** (MAPI inbox-rule pragmatic subset: conditions + ordered actions +
  `stopProcessingRules`) and **`MailSignature`** (OWA-style roaming signature, resolved via new
  `resolveDefaultSignature()`) are new mailbox-scoped entities with full CRUD (`BaseScopedChildRoute`,
  same shape as `ContactList`/`TaskList`) — no custom endpoints needed for either.
- **Scheduled send**: `Message.scheduledSendTime?: Date` (optional, no SQL migration hazard). `BaseMessageRoute.send()`
  gained one branch: a future `scheduledSendTime` moves the message to the mailbox's (previously
  defined but never used) `FolderType.OUTBOX` instead of relaying — no new endpoint, the client just
  `PUT`s the field first. New `ScheduledSendJob` polls for due messages and relays them via the same
  `scanAndRelay()` `send()` itself uses.
- **Automatic replies**: evaluated inline in `ScanQueueJob` (same place mail filters run) for any
  "deliver"-verdict message. `resolveActiveOof()` (`util/OofUtils.ts`) combines the existing
  `Mailbox.oofEnabled` toggle with a new, independent trigger — a `CalendarEvent.autoReplyEnabled`/
  `autoReplyMessage` window (e.g. a vacation) — without merging them into one record; the event's
  message wins when both are active. `isAutoReplyEligible()` (`util/AutoReplyUtils.ts`) implements RFC
  3834 loop prevention (refuses on empty envelope-from, a present non-"no" `Auto-Submitted` header, or
  `Precedence: bulk/list/junk`). A new `OofReplySuppression` entity throttles repeat replies to the same
  sender within a rolling `mail:oof:resuppress_after_hours` window (a deliberate simplification of
  Exchange's own per-OOF-period suppression, since this library has no "OOF turned on at" timestamp to
  reset a cache against) — purged once stale by a new `OofReplySuppressionCleanupJob` (direct structural
  copy of `QuarantineRetentionJob`).
- **Necessary prerequisite fix, not scope creep**: `ScanQueueJob` had *always* hardcoded
  `Message.subject`/`bodyPreview` to `""` on ingestion — `ScanPipeline.run()` already ran `simpleParser()`
  but only returned `spam`/`av`/`attachments`/`sanitizedHtml`, discarding everything else. Extended
  `ScanPipelineResult` with `subject`/`bodyPreview`/`parsedFrom`/`autoSubmittedHeader`/
  `precedenceHeader`/`messageIdHeader`, and `ScanQueueJob` now uses them — both fixes the dormant bug
  and gives mail filters/auto-replies real data to match against.
- **Real bug found and fixed via a genuine cross-backend behavior difference, not just a test
  artifact**: `ScheduledSendJob`'s final `update()` originally tried to clear `scheduledSendTime` by
  setting it to `undefined` in the update payload (the pattern used elsewhere in this codebase, e.g.
  `BaseMessageRoute.send()`'s `sanitizedHtmlBlobKey` handling). This works fine on the Mongo backend
  but **silently does nothing on SQL**: TypeORM's `Repository.update()` skips any property with an
  `undefined` value (leaving the column unchanged) and only treats an explicit `null` as "set this
  column to NULL." Confirmed via a real SQLite round-trip test failing with the *old* scheduled time
  still present after "successful" relay. **Fix**: pass `null` instead of `undefined` when the intent
  is to clear a nullable field in an `update()` payload — `null` clears reliably on both backends,
  `undefined` only reliably does so on Mongo. Worth checking any other `update()` call in this codebase
  that tries to clear an optional field via `undefined` for the same latent bug.
- Mail filter rule evaluation (`util/MailFilterUtils.ts`) tracks `moveToFolderUid` (last matching
  `MOVE_TO_FOLDER` wins) separately from `copyToFolderUids[]` (every matching `COPY_TO_FOLDER`
  accumulates) — a `DELETE` action discards the primary delivery but any `COPY_TO_FOLDER` copies from
  the same rule set are still created, matching MAPI's per-action (not mutually-exclusive) action-list
  semantics.
- Auto-reply composition (a narrow, entirely system-generated exception to "this repo doesn't compose
  MIME" — see `MailSignature`'s doc comment for why that boundary exists) uses `nodemailer`'s
  `MailComposer` (`import MailComposer from "nodemailer/lib/mail-composer/index.js"`), the exact same
  import path/API `@rapidmx/server`'s `BaseMailComposeRoute` already uses — confirmed by reading that
  file first rather than guessing at nodemailer's API shape.
- `jsdoc/check-indentation` (this repo's lint config) rejects a JSDoc continuation line with more than
  one space after the `*` — easy to introduce when hand-aligning multi-line doc comments; `yarn lint`
  (via `yarn build`) catches it immediately.
- Full suite: 1022/1022 passing. New code at 100% statement/function/line coverage; the only
  remaining gap is the same pre-existing `MailboxRouteSQL.ts` one-function gap noted in the entry
  above (confirmed untouched via `git diff`). `yarn build`/`yarn tsc --noEmit` clean. Not committed —
  left staged/unstaged per the standing commit-discipline rule.

### 2026-09-09 — New `dkim/` module (opt-in DKIM key generation) + `GET /internal/mta/domain`, driven by `@rapidmx/server`'s docker-compose deploy-wiring session

This session's actual driver was `@rapidmx/server`'s own NOTES.md 2026-09-09 entry ("Deploy wiring:
docker-compose... dynamic per-domain DKIM, real inbound MTA bridge") — read that entry for the full
narrative (docker-compose/Postfix/mta-bridge design); this entry covers only what changed *in this repo*.

- **New `src/dkim/` module**: `DkimKeyProvider` interface (`ensureKeyPair(domain): Promise<DkimKeyPair |
  undefined>`), `FsDkimKeyProvider` (generates+persists a 2048-bit RSA key pair straight into rspamd's own
  `dkim_signing` module's expected `<key_dir>/<domain>.<selector>.key` path — confirmed via
  `docs.rspamd.com/modules/dkim_signing`, not guessed), `NullDkimKeyProvider` (always resolves `undefined`
  — the default). Exported from the package root (`src/index.ts`), same as `dns/`.
- **This crosses a boundary this library previously drew deliberately**: `Domain.dkimSelector`/
  `dkimPublicKey`'s doc comments (`models/types.ts` + both Mongo/SQL model files) used to say this app
  "never generates or stores DKIM key material" — an admin was expected to run their own OpenDKIM keygen
  and paste in the selector/public key. Confirmed with JP before crossing it (this is real custody of
  MTA-signing private key material, a security-relevant choice, not a pure implementation detail) — see
  the `@rapidmx/server` NOTES.md entry for how that confirmation was obtained. Doc comments updated
  accordingly; the manual model still works exactly as before when `NullDkimKeyProvider` (the default) is
  registered.
- **Found the hard way: `@Inject("...")` throws if *nothing at all* is registered under that token — there
  is no "leave it undefined" optional-injection mode in `@rapidrest/core`'s `ObjectFactory`.** Adding
  `@Inject("DkimKeyProvider")` to `BaseDomainRoute` broke every existing integration test in this repo
  (`No class found with name: DkimKeyProvider`) the instant `Server.start()` tried to construct
  `DomainRoute`/`MailIngestRoute`, because nothing had ever registered anything under that brand-new token.
  Fixed by making `NullDkimKeyProvider` the always-registered default (`test/testDoubles.ts`) and having
  `ensureKeyPair()` itself return `undefined` for "not managed," rather than `BaseDomainRoute` trying to
  detect "is anything registered at all" (there's no clean way to ask that once *something* always is).
  **A downstream consumer of this library now MUST register something under `"DkimKeyProvider"`** (even if
  it's just `NullDkimKeyProvider`) or `Server.start()` will throw — this is a breaking addition for any
  app built on this library, `@rapidmx/server` included (it now registers `FsDkimKeyProvider`). Worth
  calling out explicitly in this package's next release notes.
- **A second, related gotcha, worth remembering for any future optional-but-overridable DI token**:
  `ObjectFactory.register(clazz, fqn)` is **first-registration-wins**, not last -
  `if (!this.classes.has(name)) { this.classes.set(name, clazz); }` in `@rapidrest/core`'s own source. A
  test file that wants a different implementation than `testDoubles.ts`'s default must register it
  **before** calling `registerTestDoubles()`, not after, or the default silently wins and the override is a
  no-op. Cost real debugging time this session (`test/routes/{mongo,sql}/DomainRoute.dkim.test.ts` failed
  with "expected 'mail' but got null" until the registration order was flipped).
- **`BaseDomainRoute.create()`** auto-fills `dkimSelector`/`dkimPublicKey` from the registered provider
  unless the caller already supplied both explicitly (an admin importing their own key pair is never
  silently overwritten). **`dnsSetup()`** backfills the same, lazily, for a domain created before this
  feature existed (or before a key-generating provider was registered) — best-effort, a generation failure
  there doesn't break the rest of that otherwise read-only diagnostic call.
- **New `GET /internal/mta/domain?name=<domain>` on `BaseMailIngestRoute`**: 200 if the domain is
  `enabled && verified` (reuses `getVerifiedDomainNames()`, already used by `applyTransportRules()` — no
  new query logic), 404 otherwise. Lets an MTA's relay-domain acceptance check
  (`relay_domains`/`tcp_table`, see `transport/MTAIngestAdapter.ts`'s updated doc comment) stay in sync with
  this app's own `Domain` database dynamically, with no MTA restart needed for a newly-added domain — the
  other two endpoints (`resolve`/`deliver`) were already dynamic this way; this one had been the missing
  piece.
- New tests: `test/dkim/FsDkimKeyProvider.test.ts` (real filesystem I/O against a temp dir, mirrors
  `test/blob/LocalFsBlobStore.test.ts`'s own convention for the same reason), new
  `test/routes/{mongo,sql}/DomainRoute.dkim.test.ts` (a deliberately separate `Server`/`ObjectFactory` per
  backend with `FsDkimKeyProvider` registered, rather than changing the existing `DomainRoute.test.ts`
  files — those keep registering nothing, proving the `NullDkimKeyProvider` default is unaffected), and new
  `/internal/mta/domain` cases added directly to the existing `test/routes/{mongo,sql}/MailIngestRoute.test.ts`.
- Verification: full suite re-run after all of the above — 130 files / 1912 tests passing (up from
  1022/1022 at the last entry above — that jump also reflects unrelated work between sessions, not just
  this entry's additions). `yarn tsc --noEmit` and `eslint ./src ./test` both clean. Not committed — left
  staged/unstaged per the standing commit-discipline rule; `@rapidmx/server` consumed this via `yarn patch`
  ahead of a real publish for the rest of that session.
- **Published as `0.4.0` the same day** (JP, after the ScanPipeline fix above landed) — the new required
  `DkimKeyProvider` DI registration (`NullDkimKeyProvider` is the default; nothing needs to change for an
  existing consumer that never registers one itself) should be called out in that release's own notes if
  it wasn't already. `@rapidmx/server` has since dropped its `yarn patch` and moved to a plain `"^0.4.0"`
  constraint, re-verified clean against the real published package.

- **Real, previously-undiscovered bug found and fixed via `@rapidmx/server`'s live docker-compose boot
  (not by reading code): `ScanPipeline` could never actually be constructed via real DI in any deployment
  that doesn't explicitly set `mail:scan:sanitize:allowed_tags`.** `@Config("mail:scan:sanitize:allowed_tags")`
  (`src/scan/ScanPipeline.ts`) had no default value — unlike every other `@Config` usage in this codebase.
  `@rapidrest/core`'s `ObjectFactory.initialize()` throws `"No configuration variable is defined at path:
  ..."` synchronously for any `@Config` field with neither a live config value nor an explicit default, so
  every attempt to construct a `ScanPipeline` (as `ScanQueueJob`'s/`MessageRoute`'s own `@Inject`-ed
  dependency) failed outright and was silently swallowed by the caller's injection-resolution `.catch()` —
  **no scanning ever actually ran**, with only an unassertedly-logged error to show for it. Never caught by
  this repo's own test suite because `test/config.ts`/`config.sql.ts` happen to always set this key (to
  `[]`), papering over the exact absence that broke `@rapidmx/server`'s own `config.mongo.ts`/`config.sql.ts`
  (which never set it at all). Fixed by giving the `@Config` call a real default (the same
  `sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== "script")` list `sanitize()`'s own `??`
  fallback already computed) — `sanitize()`'s fallback itself is left in place as defensive belt-and-suspenders
  for the isolated `new ScanPipeline()`-without-DI construction this repo's existing tests already use
  throughout. New regression test in `test/scan/ScanPipeline.test.ts` constructs a `ScanPipeline` through a
  **real** `ObjectFactory` (not the hand-built `new ScanPipeline()` every other test in that file uses) with
  a minimal config that genuinely omits the key, asserting it resolves without throwing — the shape of test
  that would have caught this originally. **Any other `@Config` field added to this codebase in future
  without an explicit default risks the exact same silent failure mode** — worth a lint rule or code-review
  habit, not just this one-off fix.

### 2026-09-12 — Fixed a critical send-after-cancel race in `ScheduledSendJob`, an unbounded mbox-export
gap, and this repo's own lint gate - all three found and validated by an adversarial review pass run from
`@rapidmx/server`'s own session against the `v0.7.0` (`e0dccec`) cut, then fixed here at JP's request

- **`ScheduledSendJob.relayDueMessage()` sent the email via `scanAndRelay()` *before* its own
  optimistic-lock check.** A user cancelling or editing a scheduled send at the exact moment the job
  polled it could still result in the email being delivered - an irreversible external side effect -
  while the version-checked final `update()` then lost the race against the already-bumped version and
  simply failed (caught by `run()`'s own catch, just a warning log), leaving the DB reflecting the
  cancel/edit as if nothing had been sent. Silent and permanent: `scheduledSendTime` was already cleared
  by the (never-actually-committed) intended final write, so nothing ever revisited it. Fixed with the
  same "claim first, work second" discipline `DataExportJob.processRequest()`/`MailboxImportJob.
  processRequest()` already use: a version-checked clear of `scheduledSendTime` now happens *before*
  `scanAndRelay()` runs, so whichever side's version is stale loses cleanly - either this claim fails
  immediately (a concurrent cancel/edit already won) and nothing below it, `scanAndRelay()` included,
  ever runs, or this claim wins first and the concurrent cancel/edit fails on the user's own side instead
  of racing silently against an in-flight send. On a relay failure *after* a successful claim,
  `scheduledSendTime` is restored (best-effort, re-fetching first) so the job's own documented "leave it
  for retry, no backoff" behavior on failure is preserved exactly - confirmed via the existing "Leaves a
  message that fails to relay as-is" test still passing, now strengthened to assert the restored value
  equals the *original* due time, not just that some truthy value exists. Added a new test per backend
  (`test/jobs/{mongo,sql}/ScheduledSendJob{Mongo,SQL}.test.ts`) that bumps a message's version directly in
  the DB before calling `relayDueMessage()` with the now-stale in-memory object, asserting the claim
  itself throws and nothing is sent - the exact race this fix closes.
- **`DataExportJob.buildMboxBundle()` had no row cap at all**, unlike its sibling `buildJsonBundle()`
  (which already passes `this.maxContentRows` through `collectMailboxContentLines()`). An mbox-format
  self-service GDPR export of an unbounded mailbox could grow `findAllPages()`'s in-memory array and the
  final `Buffer.concat()` without limit. Fixed by threading the same `maxContentRows` cap into
  `findAllPages()` itself (checked incrementally per page, throwing rather than silently truncating - the
  same reasoning `collectMailboxContentLines()`'s own doc comment already gives). Added a new test per
  backend mirroring the existing JSON-format cap test exactly, confirming the mbox path now fails the
  same way once its own row count exceeds the configured cap.
  - **Investigated but did NOT change**: `MatterExportJob`'s `maxContentRows` is applied per custodian
    mailbox, not to the combined export across every custodian on a Matter. This looked like an
    analogous gap at first, but its own doc comment (already present before this session, at `59f2393`)
    explicitly documents this as deliberate: a Matter's custodian list is holder/admin-curated, not
    attacker-controlled, so bounding each mailbox individually is the intended compounding boundary here,
    not a single whole-request total. Re-verified this reasoning holds and left it alone rather than
    "fixing" an already-considered design decision.
- **This repo's own `yarn build` (`lint && rimraf dist && tsc`) was failing its own lint gate** - 8
  `typescript/no-unnecessary-type-assertion`/`typescript/no-empty-function` errors, most already
  pre-existing at `59f2393` before this session's own two new job fixes added two more. Auto-fixed the six
  unnecessary-assertion ones via `eslint --fix` (reviewed the diff - each was a genuinely redundant `as
  any`/`as UpdateObject<T>` a prior refactor left behind, no behavior change). Manually fixed the two
  `no-empty-function` cases in `test/util/PstImportUtils.test.ts` (a stub `readCompletely: () => {}`
  deliberately never invoked by the test - given a trivial real body matching its actual `(buf: Buffer) =>
  Buffer` signature instead of an empty one, rather than suppressing the rule). `yarn build` now passes
  end to end for the first time this session found it broken.
- Full suite re-verified green after all three fixes (mongo + sql, real DB + DI integration tests
  throughout, matching this repo's own established test-doubling convention). Not touching
  `RELEASE_NOTES.md` - that file is JP's own manually-curated, release-level summary (distinct from the
  `@rapidrest/cli`-generated `CHANGELOG.md`, which *does* come from this commit's own message), and none
  of these three fixes are new user-facing features worth a release-notes bullet of their own.

## 2026-09-13 — Plugin contract (src/plugins) and DeviceSyncState moved out

- Plugins are npm packages with a `rapidmx.plugin` manifest (`parsePluginManifest`, `PLUGIN_API_VERSION = 1`); the server
  host (server repo `src/plugins/`) installs and loads them. `BasePluginRoute` only records the desired set, validates
  settings against the manifest, and publishes `plugins.changed` on the `plugins` Redis channel.
- Plugin rows are soft-removed (`removed: true`), not deleted, so the server's `system:plugins:defaults` seeding never
  re-adds a plugin an admin removed. `Plugin.packageVersion` is the npm version; `version` is the optimistic lock.
- `PluginRegistry` is deliberately static module state, not a DI token: plugins must share the host's single copy of
  this library (the host enforces it), and code running without a host gets a correct empty answer.
- `DeviceSyncState`/`EasDeviceStateCleanupJob` now live in `@rapidmx/activesync`. `ErasureExecutionJob` purges any
  registered model decorated `@MailboxScopedData()` in its own datastore instead - a plugin model without that decorator
  would survive a data-subject erasure.
- Config keys are `system:plugins:registry`/`registry_token`/`allowed_packages` (default allow-list `@rapidmx/*`).

## 2026-09-13 — MailboxPolicy and SetupState (first-run setup wizard backend)

- `system/mailbox-policy` (`BaseMailboxPolicyRoute`): default quota, self-service auto-provisioning on/off and its quota.
  Config (`mail:default_quota_bytes`, `mail:auto_provision:enabled`/`quota_bytes`) is used both ways, per JP: it
  *seeds* the singleton row the first time anything reads it, and stays a *live fallback* for any unset field and for
  a failed read (`findOrSeedMailboxPolicy()` logs and returns config). Writes (`PUT`) need the real row and do fail.
  `BaseMailboxRoute.autoProvision()` reads the policy, so once seeded the row, not config, decides.
- Test gotcha: SQL test files (and Mongo ones on port 9999) share a database, and seeding persists - a policy row seeded
  by one suite with auto-provisioning off broke another suite that enables it via config. Suites that depend on the
  config value clear `MailboxPolicy` first.
- `system/setup` (`BaseSetupRoute`, trusted role only): `required = !completedAt && (startedAt || no Domain rows)`, so an
  existing deployment with domains is never pulled into the wizard by upgrading. `PUT {currentStep}` records progress and
  `startedAt`; `POST /complete`; `POST /reopen` clears completion and step. Non-admins get 403, which the web apps use to
  decide not to redirect.
- `findOrCreateSingleton()` (util/MailboxPolicyUtils.ts) is the shared create-or-fetch for singleton rows.

## 2026-09-13 — Plugin dependencies (`requires`)

- A manifest may declare `requires: { "<package>": "<semver range>" }` - plugin-to-plugin, deliberately not npm
  `dependencies` (those would install a nested, never-loaded copy). `parsePluginManifest` rejects bad ranges and
  self-requires. `semver` is now a direct dependency.
- `src/plugins/PluginDependencies.ts` is pure (registry passed in): `planPluginChange` resolves requirements recursively
  (install missing at `maxSatisfying`, dependencies first; enable disabled in-range ones; conflict on out-of-range
  installed, no satisfying version, not allowed, cycles, or a version change outside an enabled dependent's range).
  Per JP: conflicts are refused and explained, never auto-upgraded/downgraded; disabling/uninstalling a plugin an
  enabled plugin requires is blocked with a 409 naming the dependents. `orderByDependencies`/`pruneUnmetRequirements`
  are used by the server host at load time.
- Route: new `GET /plan?name=&packageVersion=`; `POST /` now returns `{ plugin, dependencies }` (breaking shape change,
  react-shared updated); `PUT` plans on version change or enable; stale-lock check happens before dependencies are
  touched. 409s use `ApiErrors.IDENTIFIER_EXISTS` like the rest of the codebase.

## 2026-09-14 — Review fixes: plugin system, mailbox access/policy, setup

Fixes for a verified review round (every finding was confirmed in code first; none skipped). Not committed.

Plugins
- `ErasureExecutionJob` now has an abstract `pluginClass` (set on the Mongo/SQL subclasses). After the cascade, if any
  non-removed `Plugin` row isn't in `PluginRegistry` (disabled, failed, safe mode) it logs an error and leaves the
  request `"approved"` - the same skip-and-retry shape as the legal-hold checks - instead of completing. Chosen over
  purging collections by name (the job can't know a plugin's collections without its classes). Known costs: a plugin
  left disabled blocks completion indefinitely, and since `run()` takes the first `approved` request(s), a stuck
  request also delays later ones (the legal-hold skip already had this head-of-line problem); `purgedCount` only
  reflects the final run. The server runs jobs in `worker.*`, which calls `PluginHost.prepare()` first, so the
  registry is populated there.
- `normalizeAllowedPackages()` (new) and `normalizePluginNamespaces()` accept a list, a JSON-list string or a
  comma-separated string (nconf env values), drop malformed entries with a `logger.warn`, and a `*` pattern must be
  `@scope/...`. The route memoizes both so the warning is logged once.
- `isValidPackageName()` (npm's rule, max 214) gates `assertAllowed` and `matchesAllowedPackage`, and `requires` keys
  in `parsePluginManifest`. `NpmRegistryClient` encodes each name part (`@scope%2fname`) and refuses a packument whose
  `name` differs from the requested one (including a missing name) as a `RegistryRequestError` (502).
- `NpmRegistryClient` takes a third `options` arg (`timeoutMs` default 15s via `AbortSignal.timeout`, `maxBodyBytes`
  default 10 MB, checked against `content-length` and while streaming) and caches each packument for the client's
  lifetime (failures evicted) - so create a client per operation. The route adds a per-request `RegistrySession`
  that reuses one client per package, so `getPackage` then `getVersion` (planning, `lookup`) is one fetch. A read-level
  memo was tried and dropped: planning never repeats the same read (its `planned` map prevents revisits), so it was
  dead code. The test double records reads in `registryReads`.
- Partial application: `applyChange()` records an undo per write (created row -> soft-remove; revived row -> previous
  version/settings/manifest and `removed: true`; enabled row -> `enabled: false`), rolls back newest-first
  best-effort (errors logged) on failure, and announces whenever anything was written. Audit entries for rolled-back
  installs are kept (they record what was attempted).
- `installRow` refuses (409 "changed while this change was being planned") to overwrite a non-removed row found by
  name, instead of resetting someone else's version/settings.
- `update()` calls `assertAllowed` when enabling or changing version; `GET /updates` entries gain `allowed` and never
  report `updateAvailable` for a plugin outside the allow-list (additive field).
- A resolved version that isn't `semver.valid` (dist-tag -> `github:`/`file:`) is a 400. Search drops results without a
  string name/version (client and route). `lookup` reads the package first through `registryCall` (502) and 404s.
- Manifest validation: duplicate/reserved (`__proto__`/`constructor`/`prototype`) setting keys, option entries
  without string value+label, and defaults that `checkSettingValue` rejects (type, min/max, select options); reserved
  or invalid `requires` names. `PluginDependencies` looks requirements up with `hasOwnProperty` (`requiredRange`).
- New contract (web-client implements it): optional `expectedPlan: { install: {name, version}[]; enable: string[] }`
  on `POST /` and `PUT /:id`. Compared order-insensitively against the fresh plan (for `PUT` with no plan computed,
  against empty lists) before anything is written; mismatch -> 409 "The plugins this change needs have changed since
  it was previewed. Review the change again."; malformed -> 400.

Mailbox access / policy / setup
- `GET lookup-by-email`: `@Auth(["jwt"])` (anonymous -> 401) and `@RateLimit({ perUser: true })` (rate limiter runs
  after the auth middleware, so per-user keys work). `email` must be a string matching one plain address (single `@`,
  no whitespace/parens/commas, <= 320) and is queried as `eq(<address>)` - `RepoUtils.find` runs every value through
  `ModelUtils.buildSearchQuery`, where `eq(...)` is the documented literal escape. The Mongo `aliasQueryValue` also
  wraps in `eq(...)`; SQL's `Raw` is unaffected. Route order vs `/:id`: both uWS and Bun routers match static segments
  by specificity (see service-core `uWS/Router.js`, `bun/BunRouter.js`), so no change.
- `setMember` only grants to a UUID-shaped user uid (the platform's uid format) that isn't a trusted role - rejects
  `anonymous`, `.*`, `*` and role names. Mailbox-owner existence was considered but rejected: a delegate with no mailbox
  of their own (e.g. a support agent) is legitimate. `removeMember` can still remove any existing record.
- Granting `manager`, or changing/removing a record that has `FULL`, requires the caller to have `FULL` (owner/trusted
  pass); nobody but a trusted role can change or remove their own record.
- ACL read-modify-write reads with `findACL(uid, [], { skipCache: true })`; `saveACL`'s plain "must be of the same
  version" Error maps to 409. `saveACL` refreshes its own cache fire-and-forget; there's no API to await it.
- Audit: `AuditAction.MAILBOX_ACCESS_GRANT`/`MAILBOX_ACCESS_REVOKE` with `details { userOrRoleId, previousRole?, role? }`.
  `auditLogClass` is optional on the base (skipped when unset) and set on `MailboxAccessRouteMongo/SQL`, which the
  server's concrete routes extend - so the server needs no change.
- Roles: `roleFromActions` returns `"custom"` for anything but `FULL` or exactly the viewer set; `listMembers` returns
  `actions` too and omits empty-action records. `"custom"` isn't settable (400).
- `MailboxPolicySQL` quotas and `MailboxSQL.quotaBytes`/`usedBytes` are `type: "double"` (the `ContactSQL` pattern);
  policy quotas are validated with `Number.isSafeInteger`. `AttachmentSQL.sizeBytes` has the same 32-bit shape but
  attachments over 2 GB aren't realistic, so it was left.
- `findOrSeedMailboxPolicy(..., failClosed)`: `autoProvision()` passes `true` and gets a 503 on a read failure; the
  display-only `GET` keeps the config fallback. Both log at error level. Policy `GET` is now `@Auth(["jwt"])` (401).
- Setup `saveStep` only sets `startedAt` while setup is currently `required`, so a step save on a completed or
  healthy (has domains, never started) deployment can't lock admins into the wizard. Step saves retry up to 5 times on
  a 409 and on `INTERNAL_ERROR`: found while testing concurrent saves that service-core `RepoUtils.update()` (Mongo,
  non-trackChanges) returns a 500 when its own `updateOne` landed but a concurrent update bumped the version before
  its `findOne(version + 1)` read-back. That's a service-core bug (not fixed here); retrying is safe only because a
  step save is idempotent.
- Verification: `yarn lint` and `tsc` clean; full `yarn vitest run --coverage` 218 files / 3648 tests passing, 100%
  statements/functions/lines, 96.7% branches (every changed file fully covered; the remaining branch gaps are the
  pre-existing ones, e.g. `ErasureExecutionJob.findAllPages`, `BaseMailboxPolicyRoute.toPublic`). `dist/` rebuilt.

## 2026-09-14 — Review fixes, round 2: plugin system, mailbox access/policy, retention policy

Every finding was confirmed in code first; none skipped. Not committed, no version bump or release notes.

Contracts other repos already build on
- `GET /mail/mailboxes/:id/access/me` (`BaseMailboxAccessRoute.myAccess`, `@Auth(["jwt"])`): 200
  `{ canRead, canCreate, canUpdate, canDelete, canManage }` from `ACLUtils.hasPermission` (owner/delegate/role/
  wildcard/parent records, trusted roles all true); `canManage` = `ACLAction.UPDATE` (`MANAGE_ACTION`, what
  list/set/remove member require). 404 missing mailbox, 401 anonymous, **200 all-false** for no access (not 403). It's a
  deeper static path than `/:id/access/:userOrRoleId`, which has no `GET`; `PUT .../access/me` is a 400 (not a uid).
- `expectedPlan.version` (optional string; non-string 400): compared with the resolved target version (`POST`: the
  looked-up version; `PUT`: new `packageVersion` or the installed one) -> 409 with the usual "changed since it was
  previewed" message.
- `GET /plan?name=X` for an installed plugin with `packageVersion` omitted/empty/equal to the installed one plans from
  the stored manifest (no registry read for X itself) - identical to what `PUT {enabled:true}` plans. `PUT` ignores
  `expectedPlan` (shape still validated) when no plan is computed (plugin stays/becomes disabled, settings-only).
- `PUT /retention-policy`: `null` for `messageRetentionDays`/`auditLogRetentionDays` clears it (stored `null`, omitted
  from responses; `RetentionEnforcementJob` already skipped falsy values). Non-null values validated as before; the
  audit floor only applies to a number.

Plugins
- `PluginDependencies`: enabling an installed disabled dependency checks `options.allowed`; a dependency to install or
  enable whose manifest has a required setting with no default (and, for installed rows, no saved value - planner rows
  now carry `settings`) is a conflict "<displayName> requires settings: A, B."; installed/published versions must be
  `isExactVersion` (semver-valid and `semver.clean(v) === v`, so `v1.0.0`, ` 1.0.0`, `1.0.0+build` are refused - also in
  the route's `lookupVersion`). New `findUnmetRequirements(installed, involving?)`.
- Concurrency: `applyChange(before, involving, change)` re-reads the rows after writing and, for requirements touching
  the changed names, refuses (409 "Another plugin change made at the same time conflicts with this one: ...") and
  rolls back when a requirement is newly unmet (problems already present in the `before` snapshot are ignored, so an
  unrelated pre-broken row doesn't block edits). `PUT`'s own row update and `DELETE` now record undo steps too.
  Tested with the registry hooks (add vs concurrent disable; version change vs concurrently enabled dependent) and a
  spy on `audit` for `DELETE`.
- Undo of a row the change created hard-deletes it (`RepoUtils.delete`, version-guarded; `Plugin` isn't recoverable so
  that's a purge) instead of soft-removing, which the server's defaults seeding treats as an admin removal.
- `PUT {packageVersion: "" | " " | null | non-string}` -> 400. Repeated `?namespace=`/`?packageVersion=` -> 400.
- `/search` `updateAvailable` requires `allowed` (same as `/updates`).
- A namespace `{name, token}` without its own registry uses its token on the default registry; one with its own
  registry never gets the global token.
- `NpmRegistryClient`: userinfo in the registry URL becomes a Basic header (a configured token wins) and is stripped
  from the fetched URL; network errors report only a system code (`Could not reach the plugin registry (ECONNREFUSED).`),
  never `err.message`; an unparsable URL / bad percent-encoding is a `RegistryRequestError`.
- `announce()` catches and logs, so a publish/read failure can't replace a change's outcome.
- `computePluginStateHash` includes `integrity` (`?? null`, so SQL null and Mongo absent agree). The server hashes DB
  rows with this function on both sides, so after upgrading every copy computes a new hash once -> one rolling restart.
- Manifest `mailboxScopedData?: boolean` (validated in `parsePluginManifest`, kept only when declared).
  `ErasureExecutionJob` now holds an erasure only for a non-removed plugin whose stored manifest declares it and that
  isn't loaded; removed plugins declaring it don't hold, the completion logs at error level that their data wasn't
  erased (DataSubjectErasureRequest has no notes/result field; `reason` is the deny reason - no schema change). A hold
  is also only logged, for the same reason. Plugins that don't declare it (e.g. old manifests) never hold - the
  activesync plugin needs `"mailboxScopedData": true`, react-shared's `PluginManifest` type needs the field.

Mailbox access / policy
- SQL `type: "double"` is not a Postgres type (`PostgresDriver.normalizeType` has no mapping, `supportedDataTypes`
  lacks it -> `DataTypeNotSupportedError` at startup) - the round-1 Mailbox/MailboxPolicy columns and the older
  `ContactSQL` ones. Now `"double precision"`: in the supportedDataTypes of Postgres (as-is), MySQL (normalized to
  `double`, so existing MySQL `double` columns don't change) and SQLite (verified the test DB rebuilt with it).
  Upgrade path (read `RdbmsSchemaBuilder.updateExistColumns` + each query runner's `changeColumn`): any type change on
  Postgres/MySQL is `dropColumn` + `addColumn` ("To avoid data conversion, we just recreate column") -> data loss, and
  Postgres `ADD COLUMN ... NOT NULL` fails on a non-empty mailbox table; SQLite recreates the table copying data. No
  type avoids that (integer -> anything is a type change), and `default: 0` would only turn the Postgres failure into
  silent quota loss, so the fix documents a manual `ALTER ... TYPE double precision` / `MODIFY ... DOUBLE` before
  upgrading (README "Upgrading").
- `validateUpdate` -> `validateTrustedOnlyFields`: non-trusted callers get 403 changing `ownerUserUid`, `quotaBytes`,
  `usedBytes` (only real changes; owner compared case-insensitively, null/"" = none). Trusted owner uids must be
  UUID-shaped (stored lowercase) or the caller's own uid (so a dev admin `dev-user` can still assign itself); an
  existing non-UUID owner round-trips. `updateProperty` now saves the value `validateUpdate` normalized.
- Non-trusted `POST /mailboxes` (`assertSelfServiceCreate`): policy read fail-closed; 403 unless policy
  `autoProvisionEnabled`, verified domains and an alias source exist; every address (primary + aliases) must be
  `<own auth-server name alias>@<verified domain>` (403); `quotaBytes` forced to the policy's self-service quota,
  `usedBytes` 0. `autoProvision()` calls the shared `createMailboxes()` directly (no second policy/alias fetch). Not
  added: a one-mailbox-per-user limit on direct create (autoProvision's `existing` shortcut) - not in the finding.
  Web-client: only the admin console/setup wizard create mailboxes (trusted), so no client impact.
- Addresses are lowercased on create/update (`normalizeAddressFields`) - ingest, ScanQueueJob, calendar and uid logic
  already compared lowercase. `lookup-by-email` tries `findOne(<lowercased address>)` (uid) first, used only if that
  mailbox still has the address (uid survives renames), then the `eq()` queries.
- `setMember`/`removeMember`/`listMembers` check permission against the uncached ACL (with uncached parents) they read
  and save. Strict full-access rule: FULL is also required when any record other than the member's own on this mailbox
  grants FULL and may apply to them - their uid on a parent ACL, `.*`/`*`, or any non-UUID role name (their roles are
  unknown) except trusted roles and `anonymous` - since adding/changing their exact record overrides that grant and
  removing it restores it.
- `USER_UID_PATTERN` moved to `util/UserUidUtils.ts` (lowercase only) with `normalizeUserUid()`; member ids are stored
  lowercase and matched against owner/self/existing records case-insensitively for UUIDs.
- `lookup-by-email`: `@RateLimit({ perUser: true, maxAttempts: 30, windowSeconds: 60 })`. The server's
  `TieredRateLimiter` spreads route config last, so it beats the authenticated tier; tested (31st request 429).
- Tests: shared suites `test/routes/mailboxSelfServiceCreateSuite.ts` (run by both MailboxAutoProvision files) and
  `test/routes/retentionPolicyClearSuite.ts`; additions in `mailboxAccessSecuritySuite.ts` and `pluginRouteSuite.ts`
  (context gains `updatePlugin`). MailboxRoute tests that created mailboxes as a non-trusted caller now do it as admin.

## 2026-09-14 — Review fixes, round 3 (part RA2): booking, key vault, escrow, audit/domain/branding, matters, calendar dates, request lists

Uncommitted. Other agents edited restapi concurrently (RA1: folder/message/mailbox/ingest/search routes; RB/RC: jobs,
transport, scan, pki, search providers, key discovery, escrow audit utils, index declarations).

Booking
- `requireBookingByToken`: the token must match the minted shape `^[A-Za-z0-9_-]{43}$` (32 random bytes, base64url)
  and is queried as `eq(token)`; `like(*)`/`regex(^A)`/anything else is a 404 before any query. Contract: manage tokens
  are exactly 43 base64url characters.
- Bookings are written into `BookingType.calendarFolderUid` when it's still a live calendar folder of the booking
  type's mailbox, else the mailbox's well-known calendar folder (created if needed). Busy time is read from
  `calendarFolderUid` plus the well-known calendar folder (legacy bookings were always written there). All three busy
  queries page through every match (`sort: uid`, 500/page) instead of stopping at 500 unsorted rows.
- `book()` no longer uses `@RateLimit()` (keyed on `METHOD path` = one shared counter per booking link, so one client
  could lock out every booker): `checkBookingRateLimit()` calls `RateLimiter.checkAndIncrement("booking|<ip>|<slug>",
  undefined, req)` - IP via `NetUtils.getIPAddress(req, trusted_proxies)`, and passing `req` keeps the limiter's own
  per-IP layer. `cancel`/`reschedule` keep `@RateLimit()` (their path embeds the token, so already per booking).
- `validateBook`: strings only; `bookerName` <= 200 (trimmed), `bookerEmail` <= 254, `bookerNotes` <= 2000,
  `bookerTimezone` <= 64.
- `BaseBookingTypeRoute` gains abstract `folderClass` (concrete Mongo/SQL classes updated): `calendarFolderUid` must
  exist (400), be readable by the caller (403, checked first so a non-reader learns nothing), belong to the booking
  type's mailbox and be `type: calendar` (400); re-checked on update when `calendarFolderUid` or `mailboxUid` changes
  (updateBulk/updateProperty go through `update()`). Existing BookingType tests now create a real calendar folder.

Escrow
- `$or` override: `BaseMatterRoute` find/count/truncate, `BaseEscrowAccessRequestRoute.find`, `BaseEscrowAuditLogRoute`
  find/count (holder path) drop `$`-prefixed keys and the forced key from the client query. NOTE: with this
  service-core, `parseQueryString` is flat (`$or[0][matterId]=x` is a literal key; a repeated `$or=` gives an array of
  strings), so a client can't actually build an object-valued `$or` from a query string today - verified by
  temporarily reverting the strip: the old code 500s (`Property "$or[0][matterId]" was not found`) rather than leaking.
  Kept as defense in depth; the tests assert the post-fix 200 and no leak on both backends.
- Escrow audit log holder visibility and the access/export request lists now page through ALL matters under held
  scopes (the old single `find` capped at 100). A plain `?matterId=` narrows within the visible set.
- `BaseEscrowScopeRoute` dual-control rules (documented on the class): (1) the editing user can't be in the
  `holderUserUids` a create sends, or add themselves on update (403; re-sending an unchanged list is fine); (2) a user
  who is a holder can't change that scope's holders/requiredHolders/publicKey (403); (3) lowering `requiredHolders` or
  changing holders/publicKey while any approved/fulfilled request under the scope has a met, unexpired approval -> 409;
  (4) create/update/delete audit `details.before`/`after` = {name, holderUserUids, requiredHolders,
  publicKeyFingerprint, notifySubjectOnAccess}. `updateBulk`/`updateProperty` route through `update()`, `truncate` is
  403. New abstract `escrowAccessRequestClass` (concrete classes updated). Two colluding admins can still do it -
  inherent to admin-managed holder lists.
- `util/EscrowUtils.ts`: `DEFAULT_ESCROW_APPROVAL_TTL_HOURS` (72), `resolveEscrowApprovalTtlHours(config)` reading
  `mail:escrow:approval_ttl_hours`, `evaluateEscrowApprovals(request, scope, ttl)` - approvals count once per holder
  and only from CURRENT holders; the bar is still `requiredHoldersAtCreation`; expiry = the approval that met the
  threshold + TTL.
- `material()`: holder check, then matter closed -> 409; mailbox not in `custodianMailboxUids` or no longer assigned to
  the matter's scope -> 409; threshold not met by current holders -> 403; approval expired -> 403. `approve()` on a
  closed matter -> 400. `BaseMatterExportRequestRoute.create` and `BaseMatterSearchRoute` refuse closed matters (400).
- Audit append retry: `retryOnAuditConflict()` re-runs the whole `@Transactional()` `persistCreate`/`persistApprove`/
  `persistMaterialRead` up to 3 times on a non-`ApiError` failure (a failed insert aborts a Postgres transaction, so
  `recordEscrowAuditEntry`'s inner retry can't help there). Retries stay idempotent on a MongoDB deployment without
  transactions: `persistCreate` reuses the instance uid and skips an existing row, `persistApprove` re-reads the
  request and skips an already-saved approval. `EscrowAuditUtils` itself untouched (RB/RC).
- `EscrowAuditAction.MATTER_EXPORT_*` confirmed present in types.ts - no change.

Admin write guards
- `BaseAuditLogRoute`/`BaseEscrowAuditLogRoute`: `updateBulk` (PUT /) and `updateProperty` (PUT /:id/:property)
  overridden with `@Before("rejectWrite")` (403 for everyone). `exists` left alone: these are admin-readable anyway and
  non-trusted callers still hit the deny-all class ACL.
- `BaseDomainRoute`: `updateBulk` loops the guarded `update()` (strips verified & co., audits); `updateProperty` 403s
  for `uid`/`verified`/`verificationToken`/`verifiedAt`/`lastCheckedAt`, otherwise goes through `update()`; `truncate`
  403 (it deleted every domain with no per-domain audit).

Key vault
- `enrollKey`/`startSignEnrollment`/`addMasterKeyWrap`/`removeMasterKeyWrap` are owner-only (`requireMailboxOwner`,
  like `rekey`); delegates keep read access (`get`, `checkSignEnrollmentStatus`). Removal made owner-only too since it
  is as destructive as rekey.
- Removing a wrap that would leave no non-escrow wrap -> 409.

Branding
- Logo/icon uploads accept only `image/png`, `image/jpeg`, `image/webp`, `image/x-icon`, `image/vnd.microsoft.icon`;
  stylesheet `text/css`. The media type is lowercased with parameters dropped before comparing/storing.
- Served assets add `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` (also neutralizes an SVG
  uploaded before this change).
- `headerHtml`/`footerHtml` sanitized on save with sanitize-html (already a dependency via ScanPipeline): default tags
  minus script/style plus `img`, default attributes plus `class`/`style` on any tag (no `on*`), schemes
  http/https/mailto only (no `javascript:`/`data:`), no protocol-relative URLs. Non-string -> 400, null clears.
  Existing stored HTML is NOT re-sanitized until its next save.

Dates
- New `util/DateCoercionUtils.ts` (not exported from util/index.ts - index declarations are RB/RC's; add if wanted):
  `coerceDateValue`/`coerceDateFields`/`coerceCalendarEventDates` (startDate, endDate, recurrenceId,
  cancelNoticeSentAt, recurrenceRule.until, recurrenceRule.exceptions[]) and `MATTER_DATE_FIELDS`. Strict mode 400s an
  unparseable value; `lenient` leaves it as is.
- `BaseCalendarEventRoute` coerces on create and update (updateBulk/updateProperty go through update());
  `isSchedulingRelevantChange` wraps stored dates in `new Date()`. `BaseMatterRoute` coerces on create/update/
  updateProperty. `BaseBookingRoute.findBusyEvents` leniently coerces the events it reads; `BaseMatterSearchRoute` wraps
  `dateRangeStart/End` in `new Date()`.
- MIGRATION NEEDED (Mongo only): rows already stored with ISO-string dates stay strings. The reads above tolerate them,
  but MongoDB range queries (booking busy query 1, reminder/OOF/retention jobs, LegalHoldUtils) never match a BSON
  string, so such rows stay invisible to those queries until converted - a one-off `updateMany` with `$toDate` per
  field (CalendarEventMongo: startDate, endDate, recurrenceId, cancelNoticeSentAt, recurrenceRule.until,
  recurrenceRule.exceptions; MatterMongo: dateRangeStart, dateRangeEnd, closedAt), filtering on `{$type: "string"}`.
  Job/LegalHoldUtils reads are RB/RC's.

Request lists
- `GET /data-export-requests`, `/erasure-requests`, `/mailbox-import-requests`, `/matter-export-requests`,
  `/escrow-access-requests`: newest first (`sort: -dateCreated`), `?limit=` (default 100, capped at 500;
  0/negative/fractional/non-numeric/repeated -> 400), `?page=` (0-based). Matter export and escrow access requests also
  take `?matterId=`. Response stays a bare array. `util/RequestListUtils.ts` `parseListPaging()`. The non-trusted data
  export/mailbox import lists are one `$or` query (own requests OR requests for owned mailboxes) so paging is real.
- Signature change: those `find()` methods now take `@Query("limit")`, `@Query("page")` (and `@Query("matterId")` for
  matter export) before `@AuthUser`.

Tests
- Shared suites run on both backends: `test/routes/bookingSecuritySuite.ts` (from the BookingRoute tests),
  `bookingTypeFolderSuite.ts` (BookingTypeRoute tests), and via new `test/routes/{sql,mongo}/SecurityControls.test.ts`:
  `escrowControlsSuite.ts`, `writeGuardsSuite.ts`, `datesAndListsSuite.ts`, on a small backend-neutral `EntityStore`
  (`entityStore.ts`, `sqlEntityStore.ts`, `mongoEntityStore.ts`). Unit: `test/util/DateCoercionUtils.test.ts`,
  `RequestListUtils.test.ts`, additions to `EscrowUtils.test.ts`, `BaseAuditLogRoute.test.ts`,
  `BaseEscrowAuditLogRoute.test.ts`, new `test/routes/BaseAdminWriteGuards.test.ts`.
- Full coverage suite not run here (coordinator runs it).

## 2026-09-14 — Review fixes, round 3 (part RB/RC): jobs, transport, scan, PKI, search, key discovery, escrow audit, models

Every finding confirmed in code first. Not committed, no version bump or release notes.

Cross-cutting
- **Mongo reads are plain documents** (service-core `MongoRepository.find()` is `collection.find()`), and
  `RepoUtils.update()` only enforces the optimistic lock when `existing instanceof BaseEntity` - so every "versioned
  claim" in a job was an unconditional overwrite on Mongo. `util/EntityUtils.ts` `asEntity(repo, row)` wraps
  `existing`; applied to every update in ScanQueueJob, ScheduledSendJob, DataExportJob, MailboxImportJob,
  MatterExportJob, ErasureExecutionJob (CalendarReminderJob/MeetingSchedulingJob wrap their own). Routes were not
  changed; the same gap likely exists wherever a route passes a Mongo `findOne()` result as `existing` (not verified).
- `transport/TransportResultUtils.ts`: `sendOrThrow()`/`isTransportResultDelivered()`. The bundled transports report a
  failure via `rejected` and never throw, so anything that must not count a failed send as sent uses `sendOrThrow`
  (ScanQueueJob auto-reply/MDN/recall report/resource reply/forward, MeetingSchedulingJob, BaseMailIngestRoute notices
  and DL relays).
- `util/UuidUtils.ts` `nameBasedUuid()` (RFC 4122 v5) for rows that must collide instead of duplicating.

Shared blobs (finding 1)
- Inbound raw blobs are shared by every recipient's IngestQueueEntry/Message/QuarantineEntry; attachment and sanitized
  blobs by a message and its rule copies. `util/BlobReferenceUtils.ts`: delete the row first, then
  `deleteBlobsIfUnreferenced()` counts `eq(key)` references (soft-deleted included, `includeDeleted`) in
  Message.bodyBlobKey/sanitizedHtmlBlobKey, Attachment.blobKey/extractedTextBlobKey, QuarantineEntry.rawBlobKey and
  non-DELIVERED IngestQueueEntry.rawBlobKey (DELIVERED entries are never cleaned up, so they can't count). Any remaining
  reference - a held custodian's included - keeps the blob. Used by ErasureExecutionJob, RetentionEnforcementJob and
  QuarantineRetentionJob. Routes that purge messages (RA1) should use it too.
- ErasureExecutionJob also purges KeyVault and CalendarShareLink (found per folder, before the folder is purged), and
  now also finds soft-deleted rows of recoverable entities - `find()` excluded them, so erasure silently skipped
  e.g. Deleted Items. New abstract `keyVaultClass`/`calendarShareLinkClass`. RetentionEnforcementJob gains
  `quarantineEntryClass`/`ingestQueueEntryClass`. QuarantineRetentionJob gains scanResult/message/attachment/
  ingestQueueEntry/matter classes and now deletes the entry's ScanResult and (guarded) raw blob.

Queues (findings 2, 7)
- ScanQueueJob: due = PENDING + FAILED with `nextAttemptAt <= now` + SCANNING with an expired `scanLeaseExpiresAt` (+
  legacy SCANNING with no lease whose `dateModified` is older than the lease), oldest first. The claim is versioned; a
  lost claim is skipped, not failed. Failure: `attempts++`, `nextAttemptAt = now + backoff * 2^(attempts-1)`, null at
  `max_attempts`. Config `mail:jobs:scan_queue:max_attempts` (5), `retry_backoff_seconds` (60), `lease_seconds` (600).
  New nullable IngestQueueEntry fields `attempts`, `nextAttemptAt`, `scanLeaseExpiresAt`.
- Idempotent delivery: the target Message/QuarantineEntry uid, ScanResult uid, rule-copy uids, attachment uids and the
  attachment/sanitized blob keys are all derived from the entry uid and looked up before create. An already-filed
  message isn't re-sent receipts, auto-replies or forwards; iTIP re-applies (it's idempotent). Folder counter bumps
  retry on a version conflict. Residual: counters can be under-counted if a worker dies between filing and bumping.
- RetentionEnforcementJob/QuarantineRetentionJob read `(date, uid)`-sorted pages past skipped/failed rows (the remaining
  set is always "rows skipped so far, then unread rows"). Held mailboxes are excluded from the message/quarantine
  query with `mailboxUid nin(...)` (conservative: ignores the hold's date range); audit entries are skipped in memory
  instead (SQL `NOT IN` would drop NULL mailboxUid rows). `LegalHoldUtils.loadLegalHoldIndex()` loads holds once per
  page instead of per record.
- Leases/attempts elsewhere: DataExportJob/MailboxImportJob (lease on dateModified + `processingAttempts`),
  ScheduledSendJob, SearchIndexJob/AttachmentExtractionJob - config keys below.

Sender verification (findings 3, 4, 5, 10, 14)
- `ScanQueueJob.verifiedFromAddress()`: the From address when it has aligned, passing DKIM (`hasAlignedPassingDkim`,
  trusted authserv-id). Mail this server's own mailboxes send (recall notices, iTIP) leaves through the MTA and comes
  back DKIM-signed, so it passes the same check - no separate internal-origin marker.
- iTIP: REQUEST needs sender == the organizer it names AND == the organizer on any existing row of that icalUid; REPLY
  needs sender == the replying attendee; CANCEL needs sender == the stored organizer. Unverified: ignored (the message
  is still filed). Inbound copies get `inviteSequenceSent = sequence`; declined/cancelled copies get
  `cancelNoticeSentAt` stamped before the soft delete. MeetingSchedulingJob only sends when the organizer is one of
  the mailbox's own addresses and claims before sending. The resource conflict check pages every row with
  `startDate < horizon` (500/page; more than 20 pages declines) and expands occurrences in the event's timezone.
  Created events take the parsed TZID as `timezone`.
- Recall: `X-RapidMX-Recall-Of` is honored only from a verified sender and only matches messages whose stored
  `from.address` equals that sender (otherwise "not found"); an unverified recall is filed as ordinary mail with no
  report. The header isn't stripped in ScanPipeline - it's inert unless verified.
- ACME challenge email: needs a verified From; `recordChallengeToken` throws (-> not correlated, filed normally) for a
  Reply-To outside the CA domain; a token can be re-recorded until the reply is sent.
- Rule forwards: skip `Auto-Submitted` other than `no`, an `X-RapidMX-Loop` marker (own address, or >= 5 markers),
  envelope from = the mailbox's primary address (minimal SRS), transport result checked. Move/copy targets must be
  non-deleted folders of the rule's own mailbox.
- FolderUtils: well-known folders are created under `nameBasedUuid("folder:<mailbox>:<type>")`, so the uid unique index
  arbitrates concurrent creates and the loser re-reads; the oldest wins when legacy duplicates exist. A soft-deleted
  folder holding that uid falls back to a random uid.

Other parts (summaries)
- PKI (`pki/FileStoreUtils.ts`): in-process per-path lock + re-read/modify/temp+rename, exclusive create via hard link.
  LocalX509 recovers "key without cert" with the same key; the ACME account key is saved before registration and a
  missing URL is recovered with the same key (RFC 8555 returns the existing account); 5-attempt caps. Multi-replica
  file stores can still lose updates - a DB-backed store would be the real fix (not done).
- Key discovery (contract change for server/plugins): client `GET /.well-known/rapidmx/keys/<hash>?domain=<domain>`,
  domain in the cache key; server matches `domain`, falls back to the Host header; `:hash` must be 52 z-base32 chars
  (else 400). `parseKeyDiscoveryResponse()` validates responses; cert validity comes from the certificate.
  `sameIssuingCa` auto-replace removed (PublicKey carries no issuer certificate to verify against), so a changed
  pinned fingerprint is always a conflict. AcmeEnrollmentDriverJob writes KeyVault before Mailbox.keys, audits expiry
  once per cert (`KeyVault.expiryAuditedFingerprint`), and pages all mailboxes (MailboxQuotaRecalcJob too).
- Search: `SearchProvider.bulkIndex()` returns the indexed ids (breaking for custom providers); per-document isolation
  in all providers; text capped at 1M chars (Postgres 250k); Mongo participants stored as an array and matched by a
  whole-address regex (legacy joined-string docs still match); limit 1..100, offset <= 10000.
- IcsUtils: period-based expansion starting near the window, ordinal BYDAY, wall-clock stepping in the event timezone,
  quoted TZID, Windows zone table. CalendarReminderJob: expands recurrences, in-memory watermark + lookback, versioned
  `reminderSentFor` claim before sending.
- Export/import: MailboxContentUtils caps per page with the date range in the query; mbox is streamed into the blob
  store under `mail:export:max_bytes`; import refuses AvVerdict.ERROR, enforces quota, PST cumulative allocation budget.
  S3BlobStore now multipart-uploads streams (PutObject can't take a stream of unknown length).
- ScheduledSendJob: relays only Outbox messages of the same mailbox whose from address the mailbox owns; relay is tracked
  (`scheduledSendRelayedAt`) so a post-relay failure retries filing only. ExternalShareExpirationJob revokes the ACL
  record first (reading the ACL uncached). ClamAV: CLEAN only for a reply ending `: OK`.
- Escrow audit: HMAC-SHA256 chain keyed by `mail:escrow:audit_hmac_key` (legacy SHA-256 entries still verify; an unset
  key logs, at error level in production); new `EscrowAuditHead` singleton model detects tail truncation.
- Models: long SQL strings are `type: "text"`, new indexes, unique FocusedInboxOverride(mailboxUid, senderAddress);
  README Upgrading has the ALTER and dedupe SQL. RA2 notes Mongo rows with ISO-string dates are invisible to the jobs'
  range queries until migrated.

Config keys added: `mail:jobs:scan_queue:{max_attempts,retry_backoff_seconds,lease_seconds}`,
`mail:jobs:scheduled_send:{max_attempts,retry_backoff_ms}`, `mail:jobs:search_index:{max_attempts,retry_backoff_seconds}`,
`mail:jobs:attachment_extraction:{max_attempts,retry_backoff_seconds}`, `mail:jobs:data_export:{lease_minutes,max_attempts}`,
`mail:jobs:mailbox_import:{lease_minutes,max_attempts}`, `mail:export:max_bytes`,
`mail:jobs:calendar_reminder:{initial_lookback_seconds,max_lead_minutes}`, `mail:escrow:audit_hmac_key`,
`mail:blob:s3:multipart_part_size_bytes`.

Tests: targeted suites for every changed file, both backends; the full coverage suite wasn't run here (coordinator).

## 2026-09-14 — Review fixes, round 3 (part RA1): mail/mailbox/folder authorization and server-managed fields

Uncommitted, no version bump. Every finding was confirmed in code first; none skipped. Shared suite:
`test/routes/mailAuthzRound3Suite.ts`, run by `test/routes/{mongo,sql}/MailAuthzRound3.test.ts` (34 tests each).

Contracts other repos build on
- Create routes never take a client `uid`: `BaseScopedChildRoute.create()` (messages, attachments, contacts, events,
  tasks, notes, labels, lists, signatures, filter rules, overrides, share links, quarantine, ingest),
  `BaseFolderRoute.create()` and `BaseTransportRuleRoute.create()` drop it. Mailbox/distribution-list uids stay
  address-derived. Why: `RepoUtils.create()` reuses an existing ACL whose uid equals the new record's and adds the
  creator with full rights, so a folder created with `uid` = another mailbox's address (or `Mailbox`, a well-known
  folder's deterministic `nameBasedUuid("folder:<mailbox>:<type>")`, ...) got that ACL. No web-client/react-shared code
  sends a uid on create.
- Share links: the ACL record is now `userOrRoleId: "share:<token>"`. `?shareToken=` resolves only on routes with
  `shareLinkClass` set (`CalendarEventRoute*` list/count/exists/findById, `FolderRoute*` exists), only for a token of
  the minted shape `^[A-Za-z0-9_-]{43}$`, looked up as `eq(token)`, unexpired, and whose `folderUid` is exactly the
  folder being read. The synthetic identity is `share:<token>`. Folder `find`/`count` no longer consult tokens.
  Migration: records written before this are keyed by the bare token and stop granting anything. Revoke (route delete,
  `ExternalShareExpirationJob`) removes both forms and `PUT` on a link re-grants under the new key, so re-saving each link
  (or rewriting `userOrRoleId: <token>` -> `share:<token>` on folder ACLs) migrates it.
- Search: `GET /mail/search?mailboxUid=<uid>` and `GET /mail/search/candidates?mailboxUid=<uid>` search that mailbox
  when the caller has `READ` on it (owner, delegate, trusted); 404 when it doesn't exist or isn't readable, 400 when
  empty. Without the param, the caller's own mailbox as before. `label` and `types` now count as filters (a
  label-only search is 200).
- Quarantine: create/update/updateBulk/updateProperty/delete/truncate are trusted-only (reads unchanged). A release is a
  trusted `PUT /mail/quarantine/:id` with any non-empty `releasedAt`; the server stamps `releasedAt = now` and
  `releasedByUserUid = caller`, ignoring the client's values, and an already-released entry keeps its stamp.
  `react-shared`'s `releaseQuarantineEntry()` keeps working for admins. Ingest queue writes are trusted-only too.
- `POST /mail/attachments` is 400 (`POST /upload` is the only way to create one).
- Attachment download: only `image/png|jpeg|gif|webp|bmp` keep their type and may be `inline`; everything else is
  `application/octet-stream` + `attachment`. Always `X-Content-Type-Options: nosniff` and `CSP: default-src 'none';
  sandbox`; `content-length` is the stored blob's length. Message `GET /:id/content`: `nosniff` and
  `CSP: default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; sandbox` - remote images in the web-client's
  content iframe no longer load.
- Send/schedule/recall: 403 unless `from.address` - and every address in the stored MIME's own `From` header - is the
  sending mailbox's primary address or an alias (case-insensitive).
- Re-creating a mailbox (create or auto-provision) at an address that still has folders (soft-deleted included) or an
  ACL from a deleted mailbox is 409. Deleting a mailbox only removes the row and its ACL; its folders/ACLs/content keep
  the uid. Refusing was chosen over cascading: a cascade would duplicate `ErasureExecutionJob` in a request, and
  anything missed (messages are `mailboxUid`-scoped: `conversations()`, search, quota) would be inherited. To reuse an
  address, erase the mailbox (erasure purges content then the mailbox). An address whose mailbox was already deleted
  outright stays reserved until its folders/ACL are cleaned up by an operator.

Scoping (finding 2, 9)
- SQL `buildSearchQuerySQL` merges `$or` branches over the other keys, so `q={folderUid: mine, $or: [{folderUid: x}]}`
  read `x`. `BaseScopedChildRoute` find/count/truncate, `BaseFolderRoute` find/count and non-trusted `BaseMailboxRoute`
  find/count drop `$`-prefixed keys and `$` path segments, then force the checked scope last as `eq(<uid>)`. A
  non-string scope (`?folderUid=a&folderUid=b`) is 400 on list, and a non-string scope in an update body is 400.
- Truncate (scoped child and mailbox) deletes one `eq(uid)` at a time instead of `in(a,b,...)`, which splits on commas.
  Mailbox addresses (create, alias add, rename) must be plain `local@domain` without whitespace or `,()<>"`.

Fields a non-trusted caller can't write (dropped silently, so full-object round trips still work)
- Message: `bodyBlobKey`, `sanitizedHtmlBlobKey`, `encrypted`, `scanResultUid`, `searchIndexedAt`,
  `recallRequestedAt`, `receiptStatus`, `read|deliveryReceipt{SentAt,Pending,Declined}`. `sentDate`/`receivedDate` and
  `dispositionNotificationTo` only on a create into Drafts; dates never on update (the compose/send path writes through
  the repository); `dispositionNotificationTo` on update only while the message is in Drafts. Server compose
  (`BaseMailComposeRoute`) uses `messageRepo` directly, so it's unaffected. Hooks: `serverManagedFields`,
  `prepareCreate()`, `prepareUpdate()`, `trustedOnlyWrites` on `BaseScopedChildRoute`.
- Attachment: `blobKey`, `extractedTextBlobKey`, `scanResultUid`, `sizeBytes`, `mimeType`. Contact: `photoBlobKey`.
- Folder: `unreadCount`, `totalCount`, `syncKeyVersion`, `mailboxUid` (its ACL parent) - via `validateUpdate()` for
  PUT/bulk; `PUT /:id/<field>` for one of them is 403. Create zeroes the counters.
- Read receipts: the receipt is claimed (`readReceiptSentAt` written under the optimistic lock) before sending and
  released on a failed send, and the trigger also requires the pre-update state to be unanswered - at most one send.

Legal hold (finding 8): `BaseMessageRoute.checkLegalHold()` coerces dates (Mongo strings) and uses `sentDate`, else
`receivedDate`, else `dateCreated`; no valid date at all blocks on any open hold.

Mailbox aliases (finding 6): `validateUpdate()` (PUT, bulk, and `updateProperty` - which now also receives `@Request`)
checks only aliases being added: plain address (400), verified domain when any exist (400), non-trusted callers only
their own auth-server usernames (403; needs the `jwt` cookie or static aliases - `CRUDRoute`'s bulk validator passes no
request, so a non-trusted bulk alias add fails closed), and no other mailbox or list uses it as uid/primary/alias (409;
`MailboxRouteSQL.aliasQueryValue()` LIKE-matches the simple-json column). Create checks primary and aliases the same
way; rename now also collides with other mailboxes' and lists' aliases. Not changed (flag): a self-service owner can
still rename `primarySmtpAddress` to any unused address on a verified domain - the finding only covered aliases.

Other routes
- `BaseMailFilterRuleRoute` (new; `MailFilterRuleRoute*` extend it with `folderClass`/`labelClass`): action `folderUid`/
  `labelUid` must exist in the rule's own mailbox (400), checked on create and when actions or the mailbox change.
- `BaseFocusedInboxOverrideRoute` (new): `senderAddress` trimmed/lowercased (400 if not a string); a create for an
  existing (mailbox, sender) updates that row's `classifyAs` and returns it; renaming onto another row's sender is 409.
- `BaseQuarantineRoute` (new). New bases are exported from `routes/index.ts`.

Testing notes
- `MessageRoute` tests' mailbox helper now has alias `owner@example.com` (their drafts send from it);
  `MailboxAutoProvision` tests clear folders and address-keyed ACLs in `beforeEach` (fixed addresses + the leftover
  check); `FolderRoute` share-token test creates a real link; attachment download/quarantine release/search
  "no filter" and `mailboxAccessSecuritySuite` alias tests updated to the new rules.
- Seen repeatedly while running several route test files in one `vitest run`: a whole file answering 404 for every
  request (different files each time, including files untouched here, e.g. `sql/BrandingRoute`,
  `sql/MailSignatureRoute`); each passes when run alone. Looks like a server start/stop race on the fixed test port 3737,
  not a route change - worth checking before trusting a failing full run.
- Confirmed cause (round-3 full run, 54 failures in `mongo/MailIngestRoute`, `mongo/ContactListRoute`,
  `ScanQueueJobMongo`): a concurrent `yarn vitest run` in `activesync` (17:17-17:18Z, overlapping this run's
  17:16-17:25Z). `activesync`, `mapi` and `autodiscover` tests use the same fixed ports - HTTP 3737 and MongoDB 9999
  (db `rrst-test`) - and don't take restapi's `.vitest-lock`. `MongoMemoryServer` quietly picks another port when 9999
  is taken, but config still points at 9999, so both runs share one database (the other run's `beforeEach` clears wipe
  rows mid-test: "sent message not found"). On Windows both servers can bind 3737 too, so requests reach the other
  repo's server, which doesn't have these routes (404 for everything). The `activesync` run failed its own `EasRoute`
  Mongo tests the same way. Nothing wrong in the code: re-running under the lock with nothing else running passed all
  4193 tests. Before trusting a failing run, check for other `vitest` processes in sibling repos.

## 2026-09-14 — Review fixes, round 4 (part RA2): booking, key vault, escrow/matters, domain/branding/plugins, calendar events

Uncommitted. Concurrent with RA1 (mail/mailbox/scoped-child routes; added `util/RequestBodyUtils.ts`, reused here) and
RB/RC (jobs, transport, scan, util, pki, search, models; `util/ClientIpUtils.ts`).

Escrow / matters (finding 1, 9)
- `Matter` and `EscrowScope` creates always mint the uid: client `uid` is deleted and `stripClientCreateFields()` drops
  `_id`/`version`/`dateCreated`/`dateModified`/dotted/`$` keys (Domain create uses the same strip; its uid is still the
  normalized name).
- `util/EscrowUtils.ts`: `isQuerySafeUid()` (no `,()`, not `me`/`null`) and `exactInFilter(values)` (an `in(...)` of the
  safe, distinct values, `undefined` when none are left). Used for every held-scope / matter-id `in()` in
  `BaseMatterRoute` find/count/truncate, `BaseEscrowAccessRequestRoute.find`, `BaseEscrowAuditLogRoute` (visible matter
  ids), `BaseMatterExportRequestRoute.find` and `BaseEscrowScopeRoute.hasActiveApprovals()`. A legacy uid with a comma
  is simply left out of those lists (fail closed) - such rows stay reachable by id.
- `BaseMatterRoute.truncate` deletes each checked matter as `eq(uid)` (unsafe legacy uid: `repoUtils.delete(uid)`).
- `GET /matter-export-requests/:id/download` on a closed matter -> 409 (after the holder check).
- Escrow scope update: `publicKey` is a change only if `publicKey`/`type` differ, `fingerprint` differs
  case-insensitively, or `notBefore`/`notAfter`/`revokedAt` differ to the second (epoch ms, numeric string, ISO string
  or Date; `null` == absent). An unchanged key in the body is dropped from the patch, so the stored value (not the
  reformatted copy) is kept. Contract: the web client can round-trip the scope object without tripping the
  holder-403 / live-approval-409 rules.
- `update`/`updateBulk`/`updateProperty` on matters, escrow scopes and domains: non-object body 400,
  `assertNoPathKeys()` / `assertPlainPropertyName()` 400. Branding `PUT` also `assertNoPathKeys()`. Not applicable
  (bodies never spread into `RepoUtils.update`): key vault, encryption/retention/mailbox policies (field whitelists),
  plugins (explicit patch), setup. BookingType/CalendarEvent get it from RA1's `BaseScopedChildRoute`.

Optimistic locking on MongoDB (finding 2) - `find()` rows now go through `asEntity()` before an update
- `BaseKeyVaultRoute.findKeyVault()` (feeds enroll/addWrap/removeWrap/rekey; also `skipCache`), `BaseBookingRoute`
  `requireBookingByToken()`, `BasePluginRoute.installedPlugins()` and `installRow()`'s lookup, `BaseKeyLookupRoute`'s
  existing contact. A lost race is now a 409 instead of a silent overwrite (e.g. a rekey dropping a just-enrolled
  wrapped key). Audited the rest of RA2's routes: every other update's `existing` comes from `findOne()` (entity) or
  `create()`/`update()` results. Tests force the race by spying `RepoUtils.prototype.find` and bumping the row's
  version between the read and the write (Mongo and SQL KeyVault tests, booking suite).

Key vault rekey (finding 3): `keys`, `wrappedKeys`, `masterKeyWraps` must each be arrays (400 `<field> must be an
array.`), and `masterKeyWraps` must be non-empty (400 `masterKeyWraps must include at least one non-escrow wrap.`;
escrow entries are still 403 and existing escrow wraps are still preserved). Checked after the 404/403 checks, before
any write. `validateWrappedPrivateKey` no longer throws a TypeError on a null entry.

Booking (findings 4-8)
- `validateAvailability()` (BookingType create/update): `durationMinutes` and `slotIntervalMinutes` whole minutes in
  [5, 1440]; `bufferBefore/AfterMinutes` whole in [0, 1440]; `minimumNoticeMinutes` whole in [0, 365 days];
  `bookingWindowDays` whole in [1, 365]; `maxPerDay` positive whole or null; `availability` <= 50 windows, each
  override <= 50 windows, `dateOverrides` <= 366 entries with no repeated date; window minutes whole. Existing rows are
  not re-validated.
- `generateCandidateSlots()` safety nets for stored rows: step or duration < 1 (or non-numeric) -> no slots; at most 50
  windows a day; duplicate starts offered once; stops after the local day on which 5000 candidates are reached.
- `GET /types/:slug/slots` returns at most 500 slots (`MAX_SLOTS_PER_RESPONSE`, earliest first) - contract: page with a
  later `from`. It is now rate limited per client IP + booking type on its own `booking-slots|ip|slug` counter (booking
  keeps `booking|ip|slug`), so browsing never consumes booking attempts; the limiter's own per-IP layer applies to
  both. The class doc comment's "reads carry no limit" was updated.
- Both limiters run after `requireBookingType()` (empty normalized slug -> 404 first; the stored slug is the key), so
  unknown slugs never create counters. Client IP: `clientAddress(req)` -> `resolveClientIp(req, trusted_proxies)`
  (CIDR-aware; a forged `X-Forwarded-For` from an untrusted peer is ignored). Tests spy
  `BaseBookingRoute.prototype.clientAddress` instead of `NetUtils.getIPAddress`.
- `cancel()`/`reschedule()` write the booking first (version-checked), then the event, so a cancel racing a reschedule
  409s before touching the event. A repeat cancel is still 200 and now also cancels the event if it isn't yet
  (recovers a cancel whose event write lost a race). Reschedule refuses (409) when the booking's event is CANCELLED.
- `maxPerDay` on reschedule excludes the booking itself (`uid: ne(<uid>)`).
- Busy folders: the well-known calendar lookup uses the same `sort: { dateCreated: ASC, uid: ASC }` as
  `findOrCreateWellKnownFolder()`; busy events are queried per folder with `eq(uid)` (+ exact `folderUid` post-filter)
  instead of `in(a,b)`.
- Stale DST note on the class doc replaced (FreeBusyUtils now expands recurring events in their own timezone).

Other
- Branding logo/icon uploads accept `image/gif` (raster, served with nosniff). `writeGuardsSuite` now expects 200.
- `BaseCalendarEventRoute.serverManagedFields = ["inviteSequenceSent", "cancelNoticeSentAt", "reminderSentFor"]`
  (dropped from non-trusted create/update bodies; `sequence` stays route-managed via the auto-bump). RA1 had not added
  one.

Contract changes for web-client: booking type validation limits above (400s); slots capped at 500 and rate limited;
reschedule of a booking whose event was cancelled is 409; rekey 400s above; escrow scope publicKey semantic comparison;
GIF branding uploads; dotted/`$` keys in matter/escrow-scope/domain/branding updates are 400; matter export download
of a closed matter is 409; client-supplied uids on matter/escrow-scope create are ignored.

Tests (all under `.vitest-lock`, `--coverage.enabled=false`, targeted files only): KeyVault unit + mongo/sql (+ sign
enrollment automated), Booking + BookingType mongo/sql, BookingUtils, EscrowUtils, SecurityControls mongo/sql
(escrowControlsSuite + writeGuardsSuite), CalendarEvent, EscrowAccessRequest, EscrowAuditLog, EscrowScope, KeyLookup,
MatterExportRequest, Matter, Plugin, Domain, Branding mongo/sql and their Base* unit tests - all passing. `tsc` clean
outside `src/jobs/` (RB/RC mid-edit); eslint clean on the touched files.

## 2026-09-14 — Review fixes, round 4 (part RA1): mail/mailbox/scoped-child/folder/attachment/message/label/ingest routes

Shared helper (RA2 uses it too): `src/util/RequestBodyUtils.ts`, re-exported from `util/index.ts` -
`assertNoPathKeys(obj)` (400 on any top-level key containing `.` or starting with `$`, object or each array element),
`assertPlainPropertyName(name)` (400 for an empty/dotted/`$` `:property`), `stripClientCreateFields(obj)` (drops `_id`,
`version`, `dateCreated`, `dateModified` and path keys in place, object or array), `stripClientId(obj)`,
`isPathKey(key)`, `isDuplicateKeyError(err)` (Mongo 11000 / Postgres 23505 / MySQL ER_DUP_ENTRY / SQLite UNIQUE).

1. CRITICAL, confirmed: a create body's `_id` reached `MongoRepository.save()` -> `replaceOne({_id}, ..., upsert)`, so a
   message POSTed with another mailbox's message `_id` replaced that message (the new Mongo test fails without the fix:
   the victim row disappears). Fixed in `BaseScopedChildRoute.create()` (all scoped children: messages, attachments,
   contacts, events, tasks, notes, labels, filter rules, focused-inbox overrides, share links, quarantine, ingest queue,
   signatures, task/contact lists), `BaseFolderRoute.create()`, `BaseMailboxRoute.create()`,
   `BaseDistributionListRoute.create()`, `BaseTransportRuleRoute.create()`; bulk arrays too. `RepoUtils.update()` already
   copies the stored `_id` for model instances; update bodies also get `stripClientId()`.
2. HIGH, confirmed: `$set: {...body}` let `aliasAddresses.3`, `keys.0`, `receiptStatus.0`, `actions.0.labelUid` skip the
   field checks. 400 now in `BaseScopedChildRoute.update/updateBulk/updateProperty`, `BaseFolderRoute.validateUpdate/
   updateProperty`, `BaseMailboxRoute.validateUpdate/updateProperty`, and `BaseDistributionListRoute`/
   `BaseTransportRuleRoute` `update/validateUpdate/updateProperty`. A non-array `PUT /` never reaches the bulk handlers
   (`CRUDRoute`'s bulk validator answers first - 400 for scoped routes, 500 "objs is not iterable" for mailboxes;
   framework behavior, left alone).
3. HIGH, confirmed (the scheduled branch only checked `from.address`; a client could also PUT `scheduledSendTime` and
   move a draft into Outbox directly, where `ScheduledSendJob` relays it). Now:
   - `send()` reads the stored source and runs `assertSenderAllowed(..., raw)` before either branch. It uses RB/RC's
     `checkOriginatorHeaders()` (MimeHeaderUtils: exactly one From, at most one Sender, every address the mailbox's,
     no stray address-like text) plus a route-local check refusing any From/Sender display name or comment containing
     `@` (RFC 2047 Q/B decoded) - `"ceo@example.com" <me@...>` passes the shared helper by design.
   - `POST /messages/:id/send` takes an optional body `{ scheduledSendTime }` (400 if unparseable). A future value (or a
     stored one written by server code) queues in Outbox; otherwise immediate.
   - Non-trusted update: a `scheduledSendTime` that would change the stored value is 400 (unchanged/`null` dropped, so
     round trips and react-shared's `cancelScheduledSend()` still work); a move into Outbox is 403; a create into
     Outbox is 403 and never carries `scheduledSendTime`; moving out of Outbox clears `scheduledSendTime`/attempts/
     error (409 if `scheduledSendRelayedAt` is set - relayed, only filing pending).
   - `send()` on a message in Outbox is 409 (queued or claimed - move it back to Drafts first); in Sent Items or with
     `scheduledSendRelayedAt` 409.
4. HIGH, confirmed: `BaseScopedChildRoute.update()` runs `checkLegalHold(existing)` when the resolved `mailboxUid`
   changes (only `BaseMessageRoute` overrides it; holds only cover messages). Not covered: an `Attachment` of a held
   message can still be moved on its own (no hold override on attachments).
5. MEDIUM, confirmed: a trusted create with `ownerUserUid` now writes an owner `FULL` (`*`) ACL record;
   `update`/`updateBulk`/`updateProperty("ownerUserUid")` overrides move it (remove every record of the old owner,
   replace the new owner's records with one FULL record; clearing the owner removes it). ACL save retried 3x.
6. MEDIUM, confirmed: immediate `send()` now claims first - version-checked move into Outbox with
   `scheduledSendTime: null` (the job ignores it) - then relays through a tracking transport. A scan/relay failure
   before acceptance moves it back to its original folder; any failure after acceptance calls `markRelayed()`
   (`scheduledSendRelayedAt` + due `scheduledSendTime`) so `ScheduledSendJob`'s already-relayed path only files it.
   Filing re-reads the version. Known gap: a process crash between claim and relay leaves the message in Outbox with
   no schedule (the user must move it back to Drafts to resend).
7. MEDIUM, confirmed: `BaseMailIngestRoute.handleUnsubscribe` and `BaseLabelRoute.cleanUpDeletedLabel` now `asEntity()` +
   re-read/retry on 409; `BaseMessageRoute.upsertSenderOverride` `asEntity()` + retry on 409/duplicate key. Audited the
   rest of the scope: every other route write uses `findOne()` (which instantiates the model) - send/recall/archive/
   classify/receipts, DL/TR update, scoped update - so those were already version-checked.
8. LOW-MED, confirmed: `?deleted=true` on scoped `find/count/findById/exists/truncate` and folder `find/count/exists` is
   honored only when the effective caller (share-link identity included) has DELETE and UPDATE on the scope; otherwise
   the filter is dropped / the record is 404.
9. LOW, confirmed: `Attachment.messageUid` (and `extractionAttempts/NextAttemptAt/Error`) server-managed;
   `Message.hasAttachments` server-managed and derived - `upload()` and attachment `delete()` recount the message's
   attachments and set it (version-checked, best-effort). Not covered: attachment `truncate` doesn't recount.
10. LOW, confirmed: a list unsubscribe is honored only if the message has exactly one `From` equal to the envelope
    sender and an aligned passing DKIM result under `mail:security:trusted_authserv_id`; otherwise it is logged, not
    applied, and not fanned out (`queued: false`).
11. (a) `BaseScopedChildRoute.dateFields` (strict coercion on create/update/updateBulk/updateProperty): Message
    (sentDate, receivedDate, searchIndexedAt, searchIndexNextAttemptAt, scheduledSendTime, scheduledSendRelayedAt,
    recallRequestedAt, delivery/readReceiptSentAt), Attachment (extractionNextAttemptAt), CalendarShareLink (expiresAt),
    Task (dueDate, reminderDate - in `TaskRoute{Mongo,SQL}`), IngestQueueEntry (nextAttemptAt, scanLeaseExpiresAt - in
    `IngestQueueRoute{Mongo,SQL}`); Mailbox oofStartTime/oofEndTime in `BaseMailboxRoute` create/validateUpdate (covers
    updateProperty). `send()` compares `scheduledSendTime` via `toValidDate()`. Lenient reads in OofUtils are RC's.
    (b) SERVER_MANAGED_MESSAGE_FIELDS += searchIndexAttempts, searchIndexNextAttemptAt, searchIndexError,
    scheduledSendAttempts, scheduledSendError, scheduledSendRelayedAt, hasAttachments. BaseCalendarEventRoute's list was
    already added by RA2 - not touched. (c) FocusedInboxOverride create and `classify()` re-read and update on a
    duplicate-key error (relevant once a unique (mailbox, sender) index exists).

Contract changes (web-client / react-shared)
- `setMessageScheduledSendTime()` (PUT scheduledSendTime) is now 400. Schedule with `POST /mail/messages/:id/send` and
  body `{ "scheduledSendTime": "<ISO>" }` (react-shared `sendMessage()` needs an optional body).
- `cancelScheduledSend()` keeps working (null time + folderUid Drafts). Moving a message into Outbox by PUT is 403.
- "Send now" on a scheduled message: move it back to Drafts, then send (send on an Outbox message is 409). Sending a
  message in Sent Items is 409.
- `hasAttachments`, `Attachment.messageUid` and job retry fields are ignored on non-trusted writes.
- Dotted/`$` body keys and `:property` names are 400 on all mail routes. Unparseable dates are 400.
- Admin-created mailboxes: the owner gets a FULL ACL record; owner changes move it.
- Soft-deleted items via `?deleted=true` need delete+update access.
- List unsubscribe needs DKIM (the MTA must stamp Authentication-Results with trusted_authserv_id).

Tests: new `test/routes/mailAuthzRound4Suite.ts` (+ `{mongo,sql}/MailAuthzRound4.test.ts`, 15 each) and
`test/util/RequestBodyUtils.test.ts`; unsubscribe tests in `{mongo,sql}/MailIngestRoute.test.ts` and
`BaseMailIngestRoute.DistributionLists.test.ts` now carry an Authentication-Results header (plus a forged-unsubscribe
test); `BaseMessageRoute.test.ts` calls `send(id, undefined, req, user)`. Ran under the lock (targeted: 63 files, 1245
tests, all passing): Message/MailAuthzRound3/Round4/Mailbox/Folder/Attachment/Label/MailIngest/DistributionList
(+Domains)/TransportRule/CalendarShareLink/Task/IngestQueue/Quarantine/MailFilterRule/Contact/MailboxAutoProvision
(+Static)/SecurityControls/MailboxAccess/CalendarEvent/Note/ContactList/TaskList/MailSignature/BookingType mongo+sql, the
Base* unit tests, MailPushRoute, BaseAdminWriteGuards. tsc and eslint clean on the touched files.

## 2026-09-14 — Review fixes, round 5 (part B): mailbox, attachments, key vault/enrollment, booking, util exports

Part A (same day) owns BaseMessageRoute/BaseMailIngestRoute/ScanQueueJob/ScheduledSendJob/ErasureExecutionJob and the
DKIM/MIME/ICS utils; nothing here touches those.

1. HIGH, confirmed: `validateAddressChange()` now applies `ownsAddress()` (auth-server usernames x verified domains) to a
   non-trusted primary rename, like alias adds - on PUT, bulk PUT (no `req`: fails closed unless static aliases) and
   `:primarySmtpAddress`. Order 400 (plain/domain) -> 403 (ownership) -> 409 (collision). Existing MailboxRoute tests that
   renamed as the owner now rename as admin; a self-service rename onto the owner's own username is in
   `mailboxSelfServiceCreateSuite.ts`.
2. MEDIUM, confirmed: owner ACL moves happen BEFORE the owner is written (`withOwnerAclMoved()`), so a failure is
   repaired by retrying (stored owner is still the old one, the move is idempotent). If the write fails, each mailbox
   whose stored owner isn't the new one gets the two members' previous records back (a partial bulk keeps committed
   moves). "Remove owner-granted records of non-owners" wasn't possible: `ACLRecord` has only `userOrRoleId`/`actions`
   and a `manager` delegate is also a `FULL` record, so owner grants are indistinguishable.
3. HIGH, confirmed: `BaseAttachmentRoute` resolves the owning message and checks/list by its CURRENT folder: `find`/
   `count` by `messageUid` (LIST/COUNT on the message's folder, query by `messageUid`, `folderUid` ignored),
   `findById`/`exists`/`download`, and `update`/`delete` (permission on the current folder first, then `realign()`
   re-stamps the stored folderUid/mailboxUid, substituting the bumped version when the client's matched). `truncate`
   re-stamps the scope folder's stale rows first. Folder-only list/count return only attachments whose message is in
   that folder now (filtered in memory; count pages). Client `folderUid`/`mailboxUid` on update are dropped. Attachments
   aren't soft-deleted, so `deleted` filters are dropped. Responses show the current folderUid/mailboxUid. Not done:
   re-stamping on message move itself (that's BaseMessageRoute/ScheduledSendJob - part A's).
4. HIGH, confirmed: new server-managed `KeyVault.masterKeyGeneration` (Mongo+SQL, nullable). `rekey()` bumps it and
   returns 409 while a signing enrollment for the mailbox (by recorded mailboxUid, else identity) is pending or issued
   but uninstalled and holds a wrapped key. Chose 409 over auto-cancel: an ACME email challenge may be days in, and
   silently discarding it is worse than asking the owner to wait or cancel. New owner-only
   `DELETE /:id/keyvault/keys/sign-enrollment/:enrollmentId` cancels. `startSignEnrollment()` passes
   `{ mailboxUid, masterKeyGeneration }` to `attachWrappedKey()`; `AcmeEnrollmentDriverJob` refuses (and cancels) when the
   vault generation differs (legacy unrecorded = 0) or the identity now belongs to another mailbox.
   `SigningCertificateEnrollment` gains optional `describeEnrollment()`/`cancelEnrollment()` (Rfc8823 + Manual implement
   both; Null's describe throws its usual 500); Rfc8823 `listPendingEnrollments()` adds `mailboxUid`/`hasWrappedKey`,
   `getIssuedMaterial()` adds `mailboxUid`/`masterKeyGeneration`.
   Refinement B (escrow wraps on rekey): old escrow wraps are no longer kept (they can't open the new MK, piled up
   against the 20-wrap cap, and made discovery report escrow falsely). To keep the owner-can't-remove-escrow rule, rekey
   accepts an escrow wrap only for the mailbox's assigned, existing scope (`resolveAllowEscrow()`), and 409s when the
   mailbox is escrowed (assigned scope exists and the vault has a wrap for it) but the request carries no replacement.
   Wraps for scopes the mailbox left, or deleted scopes, are dropped. "At least one non-escrow wrap" is still required.
5. HIGH, confirmed: `enrollKey()` 409s when `masterKeyWraps` is non-empty and the vault already has wraps or wrapped
   keys (checked before writes and again in `persistEnrollment()`, which now reads the vault before the mailbox write).
   Enrolling without wraps still works.
6. MEDIUM, confirmed (enrollment ids are the only handle; any READ on any mailbox could read any id's status):
   `checkSignEnrollmentStatus()` and cancel require `describeEnrollment()` to bind the id to the path mailbox (recorded
   mailboxUid, else identity == primary address); otherwise 404. Fails closed (404) on an implementation without it.
7. MEDIUM, confirmed: `displayName` with `@`, CR or LF (or non-string) is 400 on create (incl. auto-provision path),
   update, bulk and `:displayName`; on updates only when it actually changes, so a stored legacy name round-trips.
8. LOW, confirmed: `rateLimitKeyForIp()` (ClientIpUtils) keys IPv6 by `/64`; booking slots/book limiter uses it.
9. `asEntity`, LegalHoldUtils (`findActiveHoldsFor`, `assertNotOnLegalHold`, `loadLegalHoldIndex`, `LegalHoldIndex`)
   and `findPagesByUid` are exported from `util/index.ts` (package root). No behaviour change.

Contract changes
- react-shared attachments: `?messageUid=<id>` is the supported list (`folderUid` may still be sent; it's ignored).
  Returned attachments carry the message's current folderUid.
- react-shared key vault: `enrollKey` with masterKeyWraps on a set-up vault is 409 (treat as "another tab set up keys":
  reload the vault, then unlock). Rekey is 409 while a sign enrollment is in flight - offer cancel via
  `DELETE .../sign-enrollment/:enrollmentId`. Rekey of an escrowed mailbox must include the new escrow wrap in
  `masterKeyWraps` (not re-add after). `unlockWithPassword` should skip (not fail on) wrapped keys it can't open, so a
  key installed before this fix doesn't lock the user out.
- Status checks for another mailbox's enrollment id are 404.
- Mailbox displayName with `@`/newline is 400 (web-client/server compose need not change; admin UI should validate).
- Owner primary renames need to be onto the owner's own username; admin console renames are unaffected.
- A third-party `SigningCertificateEnrollment` must implement `describeEnrollment()` for the status endpoint to work.

Tests: `test/routes/routesKeysRound5Suite.ts` (+ `{mongo,sql}/RoutesKeysRound5.test.ts`, 9 each),
`test/routes/keyVaultRound5Suite.ts` (run from `{mongo,sql}/KeyVaultRoute.SignEnrollmentAutomated.test.ts`, which now
share its `FakeAutomatedEnrollment`); additions in MailboxRoute, mailboxSelfServiceCreateSuite, KeyVaultRoute (second
enrollment 409; escrow wrap accepted for assigned scope), BaseKeyVaultRoute, BaseAttachmentRoute (paging),
AcmeEnrollmentDriverJob{Mongo,SQL}, Rfc8823/Manual/Null enrollment, bookingSecuritySuite, ClientIpUtils, EntityUtils.
Targeted runs under the lock all pass; tsc and eslint clean on touched files.

## 2026-09-14 — Review fixes, round 5 (part A): mail flow (send claims, erasure, relays, receipts, DKIM, booking)

Uncommitted. Concurrent with part B (BaseMailboxRoute, BaseAttachmentRoute, BaseKeyVaultRoute, BaseBookingRoute, util
exports). All nine findings re-checked against the code and confirmed; all fixed. Plus the coordinator's add-on
(recipients required to send).

1. HIGH, send in flight could be cancelled then re-sent (double send). New `Message.scheduledSendLeaseExpiresAt`
   (types + MessageMongo/MessageSQL, nullable; server-managed; a date field) is the in-flight marker:
   - Both claims write it: `BaseMessageRoute.send()` (with the Outbox move; `scheduledSendTime` stays null) and
     `ScheduledSendJob` (same instant as its `scheduledSendTime` lease). Lease length for both is
     `mail:jobs:scheduled_send:lease_ms` (900000; the route now reads it too).
   - `BaseMessageRoute.prepareUpdate()` refuses (409 "This message is being sent right now.") any folder move of a
     message whose lease is in the future - for every caller, trusted included. Moving out of Outbox (lapsed lease)
     also clears the lease. `releaseClaim()`, `refuse()`, `recordFailedAttempt()`, the scheduled branch of `send()` and
     both filings clear it.
   - Filing (route `fileSentMessage()`, job filing) re-reads and proceeds only while the row is still in the claimed
     Outbox and carries the claim's lease (compared against the value the claim's `update()` read back, so DB date
     precision can't break it); otherwise it writes nothing. The job's `recordFailedAttempt()` likewise does nothing
     once the claim is gone. An already-relayed message outside Outbox is now refused by the job ("not in Outbox")
     instead of being filed.
2. HIGH, erasure dropped inbound mail indefinitely. `ScanQueueJob.isMailboxBeingErased()` -> `erasureDisposition()`:
   - Requests with `dateCreated` before the mailbox row's `dateCreated` are ignored (earlier mailbox at the same
     address).
   - drop: `in_progress` with a live claim (`dateModified` within `mail:jobs:erasure_execution:claim_lease_seconds`,
     900, read by ScanQueueJob too), or `completed` with the mailbox row gone.
   - defer: `approved` (queued, or handed back by a hold/unloaded plugin) or a stale `in_progress` - `deferEntry()`
     sets FAILED + `nextAttemptAt` now + `mail:jobs:scan_queue:erasure_defer_seconds` (300) and undoes the claim's
     `attempts` increment, until the entry is `mail:jobs:scan_queue:erasure_defer_max_seconds` (3600) old; then deliver.
   - deliver otherwise (incl. `completed` whose mailbox row survived).
   ErasureExecutionJob: no functional change needed (the drop decision lived in ScanQueueJob); the
   `ERASURE_IN_PROGRESS` doc comment now states the new rule.
3. HIGH, MySQL endless re-send on a long Message-ID. `boundIndexedValue()` on every patch write of
   messageId/conversationId (job filing + `recordFailedAttempt` extras, route `fileSentMessage()`/`markRelayed()`).
   `scheduledSendRelayedAt` is now persisted by its own minimal version-checked write (`recordRelayed()`, re-read and
   retried x3 on conflict) inside the tracking transport the moment it accepts, in both the job and the route.
   Grep of src for other patch writes of bounded fields: client PUTs of Message `messageId`/`conversationId`
   (`BaseMessageRoute.prepareUpdate()`, every caller) and CalendarEvent `icalUid` (new
   `BaseCalendarEventRoute.prepareUpdate()`) were unbounded - fixed. Everything else writes these via constructors
   (create) or lookups already bounded. `markRelayed()` keeps an existing relayedAt, clears the lease, and only makes
   the message due while it's still in the claimed Outbox.
4. MEDIUM, `@` display-name bypass (`From :`, bare CR). MimeHeaderUtils now owns it: `extractOriginatorHeaders(raw)`
   (the shared lexer), `hasAddressLikeDisplayName(value)` (quoted strings, comments, display and group names; RFC 2047
   Q/B decoded as UTF-8; raw 8-bit UTF-8; fullwidth/small commercial at look-alikes), and
   `checkOriginatorHeaders(raw, isAllowed, { rejectAddressLikeDisplayNames: true })`. BaseMessageRoute's local copy
   is gone; `ScheduledSendJob` applies the option at send time (refusal "...display name or comment contains an
   address.").
5. MEDIUM, second delivery receipt / lost auto-reply. `completeDeliveryReceipt()` claims first
   (`claimDeliveryReceipt()`: version-checked write of `deliveryReceiptSentAt` or `deliveryReceiptPending`, re-read and
   retried x3 on 409, skipped once handled), then sends; a failed send releases it (`releaseDeliveryReceiptClaim()`,
   only while the row still carries that claim). The automatic reply is tracked per entry by a marker blob
   `ingest-markers/<entry>/auto-replied` (`maybeSendAutoReplyOnce()`, like the forward marker; `markDelivered()` removes
   both), not by "this attempt filed". `deliverMessage()` now returns void.
6. MEDIUM, duplicate trusted Authentication-Results. `DkimOversignUtils.topmostTrustedAuthenticationResults(values, id)`
   returns only the topmost value stamped by the trusted authserv-id (other ids above it skipped; an unreadable
   authserv-id fails closed). `verifiedDkimSignatures()` uses only that, and the header.b-less count must now equal the
   signature count exactly. ScanQueueJob's every AR read goes through it (`authenticationResults()`), as does
   `verifiedFromAddress()`.
7. HIGH, distribution-list relay laundering. New `MimeHeaderUtils.prepareRelayCopy(raw, { trustedAuthservId,
   rewriteFrom, replyToOriginalFrom? })` + `verifiedFromAddress(raw, id)` + `singleFromAddress(raw)` +
   `containsCalendarContent(raw)` + `RELAY_STRIPPED_HEADERS`:
   - always strips Authentication-Results, RapidMX-Key, X-RapidMX-Recall-Of, Disposition-Notification-To (bare CR
     treated as a line break);
   - keeps From only when it's the single From with aligned passing DKIM (topmost trusted AR); otherwise From becomes
     `"<name>" <rewrite address>`, Sender and any existing X-Original-From dropped, `X-Original-From: <original>` added
     (and `Reply-To: <original>` for forwards without a Reply-To);
   - returns `undefined` (don't relay) for unauthenticated calendar content (text/calendar, application/ics, .ics names
     incl. RFC 2231/2047, BEGIN:VCALENDAR).
   `BaseMailIngestRoute`: external members get `prepareRelayCopy(listRaw, { rewriteFrom: list address/name })` (skipped
   and logged when undefined; `queued` then reflects internal members only); internal members keep `listRaw` (their
   ScanQueueJob checks use the ingress AR). `restrictSenders` (top-level and nested) now requires
   `verifiedFromAddress()` to be a member - the envelope sender no longer counts. Unsubscribe verification uses
   `verifiedFromAddress()` too.
8. HIGH, forward-rule laundering. `ScanQueueJob.forwardByRule()` sends `prepareRelayCopy(raw, { rewriteFrom: mailbox
   address/displayName, replyToOriginalFrom: true })` (plus the loop header); also skips when the scan pipeline found an
   `icsPart` and the From isn't verified.
9. LOW, booking declines too eagerly. `IcsUtils` flags `truncated` only when an occurrence past `MAX_OCCURRENCES`
   exists (exactly 500 is complete). `decideResourceBooking()` expands the request in 60-day windows (deduped; cap 5000
   occurrences - practically unreachable, v8-ignored), and `bookingConflicts()` expands each existing booking only over
   the span of a group of requested occurrences, halving the group on truncation; only a single requested
   occurrence whose span still truncates declines.

Add-on (coordinator): `send()` returns 400 "A message needs at least one To, Cc or Bcc recipient to be sent." when no
recipient has a non-blank address - before the scheduled branch and the claim, so it stays in Drafts. `ScheduledSendJob`
refuses such a message ("The message has no To, Cc or Bcc recipients."), no relay, no retry.

Contract changes
- web-client/react-shared: moving a message out of Outbox (e.g. `cancelScheduledSend()`) is 409 while its send is in
  flight (up to lease_ms); send of a message with no recipients is 400; restricted distribution lists need
  DKIM-aligned senders; external list members and forward targets see From rewritten for unauthenticated senders.
- activesync/mapi: send paths should use `checkOriginatorHeaders(raw, isAllowed, { rejectAddressLikeDisplayNames: true })`
  (or `hasAddressLikeDisplayName()` on `extractOriginatorHeaders()` values), require recipients, and any path that moves
  messages out of Outbox should respect `scheduledSendLeaseExpiresAt`. If they write messageId/conversationId/icalUid
  with `RepoUtils.update()`, bound them with `boundIndexedValue()`.
- server: new config keys `mail:jobs:scan_queue:erasure_defer_seconds` (300), `mail:jobs:scan_queue:erasure_defer_max_seconds`
  (3600); ScanQueueJob and BaseMessageRoute also read the existing `mail:jobs:erasure_execution:claim_lease_seconds` and
  `mail:jobs:scheduled_send:lease_ms`. New nullable SQL column `scheduledSendLeaseExpiresAt` on the message table
  (synchronize).

Tests (under `.vitest-lock`, `--coverage.enabled=false`, targeted): MimeHeaderUtils, DkimOversignUtils, IcsUtils unit;
ScheduledSendJob mongo/sql (display name, in-flight/moved-mid-relay, bounded long Message-ID with a simulated
varchar(255), relayed marker surviving filing+bookkeeping failure and a version conflict, no recipients);
MailAuthzRound4 mongo/sql (new "round 5 (part A)" block: in-flight 409 for owner/admin + lapsed lease, cancel during an
immediate send, filing failure left relayed/due, bounded ids from send and PUT, `From :`/bare CR/look-alike, no
recipients); CalendarEventRoute mongo/sql (bounded icalUid PUT); MailIngestRoute mongo/sql (restrictSenders DKIM, From
rewrite + header strip, verified From kept, calendar not relayed); ScanQueueJob mongo/sql (erasure defer/drop/stale/
predating/completed, receipt claim vs mark-read, claim retry, topmost AR, auto-reply on retry once, forward rewrite,
verified forward + calendar skip, booking windows). Replaced: J15's approved-drop test (now in_progress), J7's
"requested series too long" and round-4's "existing booking has too many occurrences" (now accepted; covered by the
new single-long-occurrence decline). Also ran MessageRoute, MailAuthzRound3, BaseMessageRoute, ErasureExecutionJob,
CalendarReminder, MeetingScheduling, Booking, SecurityControls, TransportRule, DistributionList, models and related util
suites - all passing. `tsc` and eslint clean on the touched files.

## 2026-09-14 — Round 5 follow-up: no moving sent/received mail into Drafts; coverage gate restored

Finding: server's `BaseMailComposeRoute.assemble()` (and its sibling at ~line 633) rewrites body/subject/recipients of
any message in a Drafts folder, and restapi still let a client move ANY message into Drafts. A Sent Items copy has no
`scanResultUid`, so it's indistinguishable from a draft: a user (or a held custodian) could move sent/received mail to
Drafts, re-assemble it and move it back, forging history. activesync's `MessageMoveRules` already refuses this.

Fix (`BaseMessageRoute.prepareScheduledSendUpdate()`, so update, bulk update and `PUT /:id/folderUid` all get it): a
non-trusted update that changes `folderUid` into a Drafts folder is refused 403 unless the message is currently in
Drafts (draft between Drafts folders) or Outbox (the scheduled-send cancel path, which still clears the send state; the
in-flight 409 still runs first for every caller). Trusted callers are exempt, mirroring the Outbox rules (which return
before this check for trusted users). Create: nothing to add - a non-trusted create into Drafts can already only set
draft fields (every delivery marker - `scanResultUid`, receipt state, `scheduledSendRelayedAt`, blob keys - is
server-managed and stripped); normal draft creation is unchanged.
Tests: `mailAuthzRound4Suite.ts` "round 5 (part B): moves into Drafts" (mongo + sql): Inbox/Sent Items -> Drafts 403 on
all three paths under a legal hold with the row unchanged; Drafts -> Drafts, Outbox -> Drafts (single and bulk) 200;
admin exempt; in-flight still 409.

Not fixed, flagged: (1) a `MailFilterRule` MOVE_TO_FOLDER can target a Drafts folder, so `ScanQueueJob` can file
inbound mail straight into Drafts where compose can rewrite it - the compose route (server) should probably also refuse
messages with a `scanResultUid`, as activesync does; (2) non-trusted moves OUT of Drafts into Sent Items, and creates
directly into Sent Items, are still allowed, so fabricating (not rewriting) sent history remains possible.

Coverage gate: new tests for the previously uncovered lines - BaseMessageRoute `recordRelayed()` retry after a version
bump mid-relay; ScheduledSendJob `recordRelayed()` stopping when a concurrent writer already stamped the marker;
ScanQueueJob delivery-receipt claim losing to a concurrent claim, giving up after 3 conflicts (entry FAILED, retry sends
once), release leaving a changed claim alone, release failures logged; booking conflict found in the first half of a
split expansion; MimeHeaderUtils quoted-pairs in display names/comments; DkimOversignUtils non-string AR values.
Removed dead code: `BaseAttachmentRoute.resolveMailboxUidFor()` and its `folderClass` (update() strips client
folderUid/mailboxUid and create() is refused, so `BaseScopedChildRoute.enforceMailboxUid()` never runs for attachments).

## 2026-09-14 — Migrated to `@rapidrest/service-core` 2.1.0

Uncommitted, no version bump. `package.json`: devDependency `^2.1.0`, peerDependency `2.x` -> `^2.1.0` (restapi now
relies on `RepoCreateOptions.allowExistingACL`, `ModelUtils.literal()` and 2.1.0's mapped duplicate-key errors).
Read service-core's `RELEASE_NOTES.md` v2.1.0 and its 2026-09-14 NOTES entries (agents A/B, F1-F3) first.

`allowExistingACL` (2.1.0 refuses a create at a uid that already has an ACL, even for a trusted caller)
- Only `recordACL` models reach that check (`RepoUtils.claimRecordACL()`), and in restapi those are just `Folder` and
  `Mailbox` (`@Protect(..., true)`); every other model's create is unaffected, deterministic uid or not (key vaults,
  policies, branding, setup state, `nameBasedUuid()` rows in ScanQueueJob, ...).
- **One site: `util/FolderUtils.ts` `createWellKnownFolder()`, deterministic uid only** (`wellKnownFolderUid()`,
  `nameBasedUuid("folder:<mailbox>:<type>")`). Legitimate because the uid is derived server-side from the mailbox uid
  and type and is never client input, and only a trusted caller can write an ACL at an arbitrary uid (`BaseACLRoute`
  `POST` has no `:id`, so it's trusted-only). An ACL already there is a leftover of an earlier incarnation of the same
  folder (row removed without its ACL - e.g. a failed `removeACL()` after a purge, or a test harness `repo.clear()`,
  which is exactly how the whole ScanQueueJob/auto-provision suites failed with `IDENTIFIER_EXISTS` before this).
  Reusing it also keeps a lost creation race failing on the uid's unique index (the caller re-reads the winner) instead
  of at the ACL claim, where the winner's row may not be visible yet. Because the leftover may carry stale grants or a
  different parent, it is looked up first (`findACL(uid, [], { skipCache, skipParents })`) and, once this create has
  won the uid, reset to the fresh shape (`parentUid: mailboxUid`, `records: []`). The random-uid fallback (a
  soft-deleted folder holds the deterministic uid) does not pass it. `ACLUtils` is read from the repo's protected
  `aclUtils` (callers only hand over a `RepoUtils`).
- Deliberately NOT passed: `BaseFolderRoute.create()` (random server-minted uid), `BaseMailboxRoute` create/
  auto-provision (uid = client-chosen address; `assertNoLeftoverMailboxData()` already refuses 409 when an ACL exists).
- Reserved uids (route/class/`default_*` ACLs): Folder uids are UUIDs and Mailbox uids are addresses (always contain
  `@`), so neither can equal a class/route name. Non-recordACL singleton uids (`encryption-policy`, `retention-policy`,
  `branding`, `setup-state`, `mailbox-policy`) are lowercase-hyphenated and never reach the check anyway.

Code changes caused by 2.1.0 behaviour
- Duplicate keys: `RepoUtils.create()` now throws `ApiError` 400 `IDENTIFIER_EXISTS` instead of the raw driver error, so
  `RequestBodyUtils.isDuplicateKeyError()` also recognises that (400 only; restapi's own `IDENTIFIER_EXISTS` errors are
  409 and stay unrecognised). Callers: `BaseFocusedInboxOverrideRoute.create()` lost-race path and
  `BaseMessageRoute.upsertSenderOverride()` retry, which would otherwise have stopped retrying.
- `BaseBookingRoute` doc comment: `@RateLimit()` on `cancel()`/`reschedule()` is now per (client IP, booking) for the
  anonymous callers these routes serve, plus the independent per-IP counter.

Test expectation changes (new, correct framework behaviour; no security assertion weakened)
- `MailboxRoute.test.ts` (mongo + sql), bulk `PUT /` rename to a foreign address: 400 -> 403. `BulkError` now takes the
  first failed element's status; the row-unchanged assertion is kept.
- Test doubles/spies keyed on a raw query value now read `.value` of the literal: `BaseMailIngestRoute.DistributionLists`
  address repo, ScanQueueJob (mongo + sql) recall race spy, `BaseAttachmentRoute`/`BaseScopedChildRoute` truncate
  criteria. New tests: FolderUtils (allowExistingACL only on the deterministic uid, leftover ACL reset, no reset when
  none/gone), RequestBodyUtils (`IDENTIFIER_EXISTS` 400 vs 409), BaseScopedChildRoute (truncate batches of 500).
- No failures from dates, `$or`/`$and`/`$`-key 400s, truncate caps, cache keys, push payloads (restapi has no
  `@RequiresScope` fields), metrics, Mongo `findOneAndUpdate`, SQL `insert()` (no TypeORM relations) or auth.

`ModelUtils.literal()` replacements (sender/client-controlled values; in-memory exact-match post-filters kept)
- Hand-built `eq(...)`: `BaseBookingRoute` manage token and busy-time folder uids; `BaseFolderRoute`/
  `BaseScopedChildRoute` share-link token and forced scope (`listFilter`/`scopedFilter`); `BaseAttachmentRoute`
  `messageFilter` and the truncate re-stamp scan's `folderUid`; `BaseFocusedInboxOverrideRoute.findForSender` and
  `BaseMessageRoute.upsertSenderOverride` (mailbox + sender); `BaseMailboxRoute` `aliasQueryValue` (Mongo),
  `assertAddressesAvailable` primary lookups and `assertNoLeftoverMailboxData` `mailboxUid`; `BaseMailboxAccessRoute`
  `aliasQueryValue` (Mongo) and lookup-by-email primary lookup.
- Previously raw (unescaped) sender-controlled values, which a value like `ne(x)` could have turned into an operator:
  `BaseMailIngestRoute` mailbox/distribution-list primary lookups and Mongo `aliasQueryValue`; ScanQueueJob OOF
  suppression sender, MDN and recall `messageId`, iTIP `icalUid`, focused-inbox override sender, `conversationId`,
  Mongo `contactEmailQuery`; `MailboxImportJob.alreadyImported` `messageId` (had no post-filter).
- `eq(uid)`-per-record truncates -> literal `in` lists: `BaseScopedChildRoute` and `BaseMailboxRoute` (batches of 500
  so a SQL `IN` stays bounded; per-uid pushes are unchanged since `RepoUtils.truncate()` publishes per uid),
  `BaseMatterRoute` (one call - `matched` is one page - which also drops the `isQuerySafeUid()`/`delete()` split for
  legacy uids; `Matter` isn't recoverable, so both paths were already hard deletes).
- Left alone: job keyset cursors (`gt(<date>)`/`eq(<date>)`, a literal would skip date coercion), server-held
  `user.uid` filters, blob-key references, `in(...)` lists built by `EscrowUtils.exactInFilter()`.

Workarounds now redundant with 2.1.0 (all kept as defence in depth)
- `_id` stripping on create/update (`stripClientCreateFields`/`stripClientId`): create always inserts and drops `_id`;
  update takes `_id` from `existing`. Also create's `version`/`dateCreated`/`dateModified` stripping.
- Dotted/`$` key checks on update bodies (`assertNoPathKeys`/`assertPlainPropertyName`): framework returns 400 too.
- `$`-key stripping from client queries and forcing the scope last (`stripUnsafeQueryKeys`, escrow `$or` overrides):
  SQL `$or` no longer overrides a top-level key and `$` keys are 400 on both backends. restapi still strips silently.
- `asEntity()` for optimistic locking: plain Mongo rows with a numeric `version` are now version-checked.
- `BaseSetupRoute.saveStep` retry on `INTERNAL_ERROR`: the Mongo read-back race is now a 409 (`findOneAndUpdate`).
- `EscrowUtils.isQuerySafeUid()`/`exactInFilter()` could become `ModelUtils.literal(values, "in")`.
- Still needed: bounded indexed values (`boundIndexedValue`, a storage/index limit) and `DateCoercionUtils`.
  `DateCoercionUtils` is laxer than 2.1.0 (it accepts numeric strings and epoch seconds via `new Date()`) for the
  fields it covers; other `Date` columns now get the framework's strict ISO 8601 / epoch-ms rule.

Consumer-visible behaviour (server, activesync, mapi, react-shared, web-client)
- Plugins/server code creating `Folder` or `Mailbox` rows with their own deterministic uids must use
  `findOrCreateWellKnownFolder()` or pass `allowExistingACL` themselves, or get 400 `IDENTIFIER_EXISTS` on a leftover ACL.
- Bulk `PUT` errors carry the first failed element's status (e.g. 403) instead of a blanket 400.
- `DELETE /folders?...` (inherited `CRUDRoute.truncate()` on a recordACL model with ACLs checked) removes at most one
  page per request.
- `Date` fields outside `DateCoercionUtils` reject numeric strings/epoch seconds with 400; an empty/malformed `$or`/
  `$and` or `$` key in the `q` query is 400.
- Anonymous callers of `@RateLimit()` routes (booking cancel/reschedule, public key discovery) are bucketed per client
  IP; metrics are labelled by route pattern.

Verification: `node_modules/@rapidrest/service-core` is 2.1.0. First full run on 2.1.0 before any change: 228 failures
in 8 files (ScanQueueJob mongo/sql + AcmeChallenge: leftover folder ACLs; MailboxAutoProvision: same; MailboxRoute:
bulk status). Final: `npx tsc --noEmit` and `yarn lint` clean; `yarn vitest run --coverage` 243 files / 4814 tests
passed, coverage 100 / 96.58 / 100 / 100 (statements / branches / functions / lines), gate met.

## 2026-09-14 — Review fixes, round 6 (part A): mail flow and jobs (Drafts-only send, erasure, relay marker, invites)

Uncommitted, no version bump. Concurrent with part B (FolderUtils, BaseAttachmentRoute, BaseMailboxRoute, BaseKeyVaultRoute,
BaseEscrowScopeRoute, DateCoercionUtils, Message model, MatterExportJob). All six findings re-checked and confirmed; all
fixed.

1. MEDIUM, round-5 Drafts rule bypassed via scheduled send. `BaseMessageRoute.send()` (scheduled and immediate) now refuses
   403 "Only a message in Drafts can be sent." for a non-trusted caller unless the message is in a Drafts folder (after
   the existing 409s for relayed/Sent Items/Outbox; trusted callers exempt, like the move rules). So for non-trusted
   callers Outbox only ever holds drafts, and Outbox -> Drafts (cancel) keeps working for them. Tightened too:
   Outbox -> Drafts is refused (403) for a delivered message (`scanResultUid`), which a `MailFilterRule` MOVE_TO_FOLDER can
   file into Outbox. Residual: a message a trusted caller sent from elsewhere (or one scheduled from a non-Drafts folder
   before this fix) can still be cancelled into Drafts; an exact rule would need a model field recording where the send
   came from (Message model is part B's - not added).
2. MEDIUM, erasure could recreate erased data. `ScanQueueJob.erasureDisposition()` returns `drop` whenever the mailbox row
   is gone and any approved/in_progress/completed request exists for the address (no mailbox row to date requests by, so
   all count). Defer/deliver only happen while the mailbox exists; the "request older than the mailbox row is ignored"
   rule is unchanged.
3. LOW, re-scan per deferral. `processEntry()` calls `stopForErasure()` (drop/defer) before `scanPipeline.run()`, and again
   after the scan (a cascade can start during a slow scan) - one extra erasure-request query per entry.
4. LOW, immediate send stuck/unmarked.
   (a) `recordRelayed()` also writes `scheduledSendTime` = the claim's lease expiry (not now: a due-now time would let
   `ScheduledSendJob` take over, and re-lease, a filing this request is still doing, making the route skip filing). After
   a crash the job picks it up once the lease lapses and only files it. `fileSentMessage()` now clears
   `scheduledSendTime`.
   (b) `recordRelayed()` retries (route and job) and `markRelayed()` re-read with `includeDeleted`, so the marker lands on a
   message soft-deleted mid-relay. `BaseMessageRoute.delete()` refuses 409 "This message is being sent right now." while
   the lease is live, for every caller with DELETE on the folder (checked after the permission, so no hint to others).
   Not covered: `truncate()` (hard delete in `BaseScopedChildRoute` - the row is gone, so it can't be restored and re-sent).
5. HIGH, invite spoofing/unbounded/unscanned. `MeetingSchedulingJob.sendToAttendees()`:
   - From and ICS `ORGANIZER;CN` use the organizer mailbox's own `displayName` through `safeDisplayName()` (omitted when
     address-like/multi-line); stored `organizer.displayName` is never mailed. Attendee `CN`s get the same rule.
   - Attendees must be `isPlainAddress()` (others skipped with a warning and left out of the ICS), deduplicated; more than
     `mail:jobs:meeting_scheduling:max_attendees` (500) -> nothing mailed, `logger.error`, row stays claimed.
   - One message composed (To: all mailed attendees) and passed once through `scanAndRelay()` with a fan-out transport
     that relays per attendee via `sendOrThrow()` (per-attendee envelopes and failure logging kept). A refused scan throws
     422 -> logged "failed to process invites/cancellation". No blob is written (no HTML part).
   - `BaseCalendarEventRoute`: create, and update when the value changes, refuse 400 an organizer that isn't an object or
     whose non-empty address isn't plain, and `attendees` that aren't an array, exceed 500 (`MAX_EVENT_ATTENDEES`) or hold
     a non-plain address; unchanged round-trips of received lists still save. `respond()` sends no REPLY to a non-plain
     organizer address (logged) and drops an address-like mailbox name from its From.
6. LOW, booking hostDisplayName. `BaseBookingRoute.sendBookingMail()` uses `safeDisplayName(hostDisplayName)` for the From
   and ICS organizer CN; the body names the host by address when the name is dropped.

New `MimeHeaderUtils` exports: `safeDisplayName(name)` (trimmed, or undefined when non-string/blank/control char/
look-alike `@`, encoded words decoded) and `isPlainAddress(address)` (one bare `local@domain`, <= 320, no whitespace/
control/specials). Also applied `safeDisplayName()` to mailbox display names in `prepareRelayCopy()` (rewritten From),
`ScanQueueJob` auto-reply, recall report, MDN and resource-booking reply From lines, `BaseMessageRoute` MDNs, and `recall()` (client-writable
`from.displayName`).

Contract changes
- web-client/react-shared: POST `/messages/:id/send` of a message outside Drafts is 403 (non-trusted); DELETE of a message
  whose send is in flight is 409; moving a filter-filed (delivered) message from Outbox to Drafts is 403; calendar event
  create/update with non-plain organizer/attendee addresses or > 500 attendees is 400.
- activesync/mapi: device-set OrganizerName is no longer mailed (mailbox name instead); invites to > 500 attendees are not
  sent; their own send paths should likewise only send drafts and use `safeDisplayName()`/`isPlainAddress()`; deletes
  of in-flight messages should respect `scheduledSendLeaseExpiresAt`.
- server: new config `mail:jobs:meeting_scheduling:max_attendees` (500). Invites now go through the scan pipeline (spam/AV
  verdicts apply) and carry every mailed attendee in To. Display names in From change for address-like mailbox/host names.

Tests (under `.vitest-lock`, `--coverage.enabled=false`, targeted): mailAuthzRound4Suite "round 6 (part A)" (mongo + sql:
send/schedule from Archive/Inbox 403 under a hold, admin exempt, draft schedule+cancel; delivered Outbox -> Drafts 403;
marker due at lease expiry mid-relay and cleared on filing; in-flight delete 409 owner/admin, 403 other, lapsed OK;
soft-delete mid-relay still marked, restore -> send 409); ScanQueueJob mongo/sql "Round 6 (part A)" (gone mailbox +
approved/stale in_progress drops past the defer bound, no folders; deferred entry not scanned; cascade starting mid-scan
drops); ScheduledSendJob mongo/sql (marker on a message soft-deleted mid-relay); MeetingSchedulingJob mongo/sql (mailbox
name vs stored organizer name, address-like name omitted, non-plain/duplicate/empty attendees, cap for invite and cancel,
spam-refused invite); BookingRoute mongo/sql (address-like host name dropped); CalendarEventRoute mongo/sql (validation
on create/changed update, round-trip, respond to non-plain organizer, address-like mailbox name); MimeHeaderUtils unit
(`safeDisplayName`, `isPlainAddress`, relay rewrite name). Also ran MessageRoute, MailAuthzRound3, BookingTypeRoute,
CalendarShareLinkRoute, FolderRoute, MailIngestRoute, RoutesKeysRound5, SecurityControls, DistributionListRoute,
TransportRuleRoute, CalendarReminder/ErasureExecution/MailboxImport jobs, BaseCalendarEventRoute/BaseMessageRoute/
BaseMailIngestRoute unit - all passing. `tsc` and eslint clean on touched files. Seen once: MailAuthzRound4 (mongo)
"two concurrent sends" returned 500 instead of 409 for the losing send; passed 3/3 on rerun - likely the concurrent
Outbox `findOrCreateWellKnownFolder()` race (FolderUtils, being changed by part B), not reproduced.

## 2026-09-14 — Review fixes, round 6 (part B): folders, attachments, mailbox, key vault, escrow scopes, draft retention, dates

Uncommitted, no version bump. Concurrent with part A (BaseMessageRoute, ScheduledSendJob, ScanQueueJob, MeetingSchedulingJob,
BaseBookingRoute, MimeHeaderUtils, BaseCalendarEventRoute). All nine findings re-checked against the code and confirmed;
all fixed.

1. MEDIUM, well-known folder left with no ACL after a lost race. `FolderUtils`: `allowExistingACL` is still always passed
   on the deterministic uid (passing it only when a leftover was seen would make the create that sees a racer's fresh
   claim fail at the claim, with no winner visible yet). New `ensureFolderACL()` recreates `{ uid, parentUid: mailboxUid,
   records: [] }` (`createOnly`; a concurrent repair's IDENTIFIER_EXISTS is tolerated) when missing: after a won create, in
   the lost-race re-read (after `RepoUtils.create()` has finished removing the loser's claimed ACL), and on the
   find-existing fast path for a deterministic-uid folder (cached read first, uncached confirm before recreating). A loser
   crashing between its ACL removal and its re-read is repaired by the next lookup of that folder.
2. LOW, leftover reset wiped fresh grants. `resetLeftoverACL()` removes only records equal (member + action set) to the
   pre-create snapshot, re-parents to the mailbox, saves with the current version, retries x3 on a version conflict; no
   write when nothing changes.
3. MEDIUM, attachment truncate skipped stale rows. `BaseAttachmentRoute.truncate()`'s re-stamp scan uses `findPagesByUid()`
   (keyset on uid, `folderScanPageSize`), so re-stamped rows leaving the result set don't shift later pages.
4. LOW, overlapping owner-change rollbacks. `withOwnerAclMoved()` restores newest move first, and `restoreOwnerAcl()` only
   writes while the two members' records are exactly what the move wrote (`[{ next, FULL }]`, or none); otherwise it logs a
   warning and leaves the ACL alone.
5. LOW, look-alike `@` display names. `assertValidDisplayName()` refuses `[@＠﹫\r\n]` (a copy of MimeHeaderUtils' private
   `AT_SIGN_LIKE`, which isn't exported) and anything `hasAddressLikeDisplayName()` flags when the name is put quoted into a
   From as UTF-8 bytes (so RFC 2047 encoded words decoding to an `@` are refused too). Part A's new `safeDisplayName()`
   could replace the copy once it lands.
6. LOW, enrollment generation not tied to the client. Every key-vault response (`PublicKeyVault`) carries
   `masterKeyGeneration` (0 when none recorded or no vault). Optional `expectedMasterKeyGeneration` (non-negative integer,
   else 400; `null` = absent) on `POST /:id/keyvault/keys` (checked before writes and again in `persistEnrollment()`),
   `POST .../keys/sign-enrollment` (checked before the CA call; the attached binding records it), `POST .../wraps` (never
   stored with the wrap) and `PUT .../rekey` -> 409 "This mailbox's master key was rotated since this key material was
   sealed - reload the key vault, unlock it again and retry." Without it, sign enrollment records the generation read
   before the CA call, as before.
7. LOW, escrow scope deletable while assigned. `BaseEscrowScopeRoute.delete()` 409s "This escrow scope is still assigned to
   N mailbox(es) - unassign them (set escrowScopeId to null) before deleting it." when any Mailbox has that
   `escrowScopeId` (literal). Chosen over clearing the assignments: one admin must not drop escrow coverage for every
   mailbox as a side effect (dual-control rule 5 in the class doc). New abstract `mailboxClass` (set by the Mongo/SQL
   subclasses). An assignment landing between the count and the delete can still dangle.
8. MEDIUM, legal-hold draft bodies unreachable. New server-managed `Message.retainedBodyBlobKeys?: string[] | null` (Mongo
   `@Column`, SQL `simple-json` nullable, synchronize) and `util/DraftBodyRetentionUtils.ts` (exported from the util
   barrel): `RETAINED_BODY_BLOB_KEY_PREFIX = "bodies/"`, `MAX_RETAINED_BODY_BLOB_KEYS = 500`, `retainedBodyBlobKeysOf()`
   (distinct `bodies/` keys only) and `withRetainedBodyBlobKey(message, replacedKey)` (the new list; 409 at the bound).
   - `MatterExportJob` streams one `{"entityType":"retainedDraftBody","messageUid","mailboxUid","blobKey",
     "contentType":"message/rfc822","encoding":"base64","content"}` line per kept body (`"missing": true` instead when
     unreadable) for the custodian's messages in the matter's sentDate range, counted against `max_bytes`.
   - `RetentionEnforcementJob.run()` always (policy or not) runs `releaseRetainedDraftBodies()`: rows with
     `retainedBodyBlobKeys ne(null)` (live, then soft-deleted; keyset paged; holds reloaded per page; at most `batch_size`
     released and 20 pages examined per run) whose mailbox no open Matter holds get their keys deleted through
     `deleteBlobsIfUnreferenced()` (current `bodyBlobKey` skipped), then a version-checked write sets the field to null (a
     failure is logged and retried next run). Retention purges and `ErasureExecutionJob` delete them with the message.
   - Only `bodies/` keys are ever exported or deleted. `BlobReferenceUtils` doesn't count the field as a reference:
     `bodies/` keys are minted per save for one message and never shared (and SQL can't cheaply query inside the column).
   - NOT done (part A's file): `"retainedBodyBlobKeys"` must be added to `SERVER_MANAGED_MESSAGE_FIELDS` in
     `BaseMessageRoute.ts`. Until then a non-trusted client can write it (mitigated by the `bodies/` prefix rule).
9. LOW, DateCoercionUtils too loose. The strict form of `coerceDateValue()` uses `parseClientDate()`, a copy of
   service-core 2.1.0's `RepoUtils.parseDateInput()` rules: `YYYY-MM-DD` = UTC midnight; date-time with `T` or space,
   optional seconds and fraction, zone `Z`/`±HH`/`±HHmm`/`±HH:mm`, none = UTC; impossible dates refused; numbers only as
   epoch ms with magnitude >= 1e11 within years 1-9999; numeric strings refused. 400 message: "'<field>' must be a valid
   ISO 8601 date/time (a missing zone means UTC) or a number of epoch milliseconds." `lenient` (stored-row reads,
   BaseBookingRoute) tries the strict form, then `new Date()` for legacy values. A unit test compares against the
   framework's private `parseDateInput` on a corpus to catch drift. web-client/react-shared send `toISOString()` (or echo
   stored values) for matters, OOF, scheduled send and calendar/recurrence dates, so no client change is needed.

Contract changes
- react-shared key vault: read `masterKeyGeneration` from GET and every write response; send it back as
  `expectedMasterKeyGeneration` on enrollKey, startSignEnrollment, addMasterKeyWrap and rekey (for rekey: the generation
  of the vault being replaced). On that 409: reload the vault, unlock again, re-seal, retry. Optional field.
- web-client/admin: DELETE `/escrow-scopes/:id` is 409 while any mailbox is assigned; unassign first (trusted
  `PUT /mailboxes/:id` with `escrowScopeId: null`).
- Mailbox displayName with `＠`/`﹫` or an encoded word showing `@` is 400.
- Dates: numeric strings, epoch seconds and impossible dates are 400; a zoneless date-time is UTC.
- server compose (`BaseMailComposeRoute.storeBody()`): when the replaced key starts with `bodies/` and the mailbox is held,
  check the hold BEFORE the update and put `retainedBodyBlobKeys: withRetainedBodyBlobKey(message, previousKey)` into the
  same version-checked update that sets the new `bodyBlobKey`; on the helper's 409, delete the new blob and surface it
  ("send it or start a new draft"). Not held: unchanged. activesync/mapi replacing a draft body under a hold should do
  the same.
- server: new nullable SQL column `retainedBodyBlobKeys` on the message table (synchronize); matter export bundles gain
  `retainedDraftBody` lines.

Tests (under `.vitest-lock`, targeted): new `test/routes/routesKeysRound6Suite.ts` + `{mongo,sql}/RoutesKeysRound6.test.ts`
(simulated lost race removing the reused ACL, fast-path repair, leftover reset keeping a grant made after the insert,
9-row attachment truncate at page size 2, bulk rollback naming one mailbox twice, rollback skipped after a concurrent owner
change, look-alike/encoded display names); `keyVaultRound5Suite` "round 6 (part B)" (both backends); EscrowScopeRoute
mongo/sql (assigned mailbox 409); RetentionEnforcementJob mongo/sql (release after the hold closes with no policy;
shared/current/non-body blobs kept; soft-deleted rows; purge deletes kept bodies; batch bound; failed release retried);
MatterExportJob mongo/sql (lines, date range, missing blob); ErasureExecutionJob mongo/sql; unit FolderUtils,
DateCoercionUtils, DraftBodyRetentionUtils, BaseAttachmentRoute (keyset scan against a mutating fake). Updated:
KeyVaultRoute mongo/sql empty-vault body (`masterKeyGeneration: 0`), BaseAdminWriteGuards (`mailboxClass`). Also ran every
`test/routes` file (132 files, 2539 tests) and the ScanQueueJob, AcmeEnrollmentDriver, CalendarReminder,
MeetingScheduling and DataExport job suites - all passing. `tsc --noEmit` and eslint clean on touched files.

## 2026-09-14 — "Trust this signer": `POST /:id/keys/trust`

Uncommitted, no version bump (on top of the published 0.10.0). Asked for by the web client's "signed, signer not verified"
state; react-shared is built against this contract in parallel, so keep it exact.

Contract
- `POST /mail/mailboxes/:id/keys/trust`, body `{ address, certificate }` (base64 DER X.509), on `BaseKeyLookupRoute` next
  to `GET /:id/keys/lookup`, `@RateLimit()` like lookup. 200 = the lookup shape (`{ keys, encryptPreference?, keyConflict? }`).
- 400: body not an object; `address` not `isPlainAddress()`; certificate not base64 (strict pattern, <= 64 KB), not parseable
  (Node `X509Certificate` via the now-exported `KeyringUtils.sanitizeDiscoveredKey()`, then `@peculiar/x509` for extensions,
  so a malformed extension is 400 too), outside notBefore/notAfter, identities (SAN rfc822Name, else subject
  emailAddress - the fallback Node's `checkEmail()` applies in `CertificateInstallUtils`) not containing the address
  case-insensitively, keyUsage present without digitalSignature, extKeyUsage present without emailProtection (strict:
  `anyExtendedKeyUsage` alone is refused). `util/SignerCertificateUtils.ts` `parseTrustedSignerKey()`.
- 404 missing mailbox; 403 without mailbox UPDATE (as lookup).
- Existing `useType: "sign"` key: same fingerprint -> 200, nothing written, no audit; different -> 409 `IDENTIFIER_EXISTS`.
  Otherwise append the sign key (stored `publicKey` re-encoded from the DER; fingerprint/dates from the cert), keep other
  keys, set `keysFirstSeen` only if unset, never touch `encryptPreference`/`keyConflict`.
- Audit: `AuditAction.CONTACT_KEY_TRUSTED` ("contact.key_trusted"), targetType `Contact`, mailboxUid, details
  `{ address, fingerprint }`, only when written. New abstract `auditLogClass` on `BaseKeyLookupRoute` (set by the
  Mongo/SQL subclasses) - breaking for custom subclasses, in RELEASE_NOTES Unreleased.

Authorization (decided)
- Mailbox UPDATE, plus what `BaseContactRoute`/`BaseScopedChildRoute` require: UPDATE on the existing contact's `folderUid`
  (checked inside the merge, so a re-read after a race is re-checked), or CREATE on the Contacts folder before a create
  (`beforeCreate` hook). restapi has no impersonation concept; delegates go through the same ACLs (manager = FULL passes,
  viewer 403, custom READ+UPDATE can pin on a contact whose folder inherits the mailbox but can't create one). Trusted roles
  bypass as usual.
- Found while testing: `findOrCreateWellKnownFolder(..., user)` makes `RepoUtils.create()` add creator actions for that
  user on the new folder ACL, so a delegate whose lookup lazily created the Contacts folder got lasting rights on it (and
  a CREATE check would pass by construction). The shared write now creates the folder without `user` (inherits the
  mailbox ACL). This also changes lookup.

Race handling: `util/ContactKeyUtils.ts` `writeContactKeys()` (not in the util barrel)
- Shared by lookup, trust and ScanQueueJob (`RapidMX-Key` header and rotation-refresh paths, via
  `persistContactKeyUpdate(mailboxUid, address, now, merge)`). Reads uncached, calls `merge(existing)`, then either a
  version-checked update or a create at `keyContactUid()` = `nameBasedUuid("contact-keys:<mailboxUid>:<address>")` (exact
  address, matching the exact-address contact query). A 409 version conflict, or a duplicate key on the create, re-reads
  and re-merges (3 attempts, then 409). Mongo's only unique index is (uid, version), so two version-0 creates collide; the
  create's `countById` catches the rest.
- **Known gap:** if a soft-deleted contact holds the deterministic uid (the user deleted a server-created contact), the
  create falls back to a random uid, and two writers racing that fallback can still create two contacts, each with its
  own sign pin. Contacts created before this change (random uids) are found by address first, so they are only affected
  if duplicates already exist. Case variants of one address are separate contacts (existing exact-match behaviour).
- Lookup's Mongo `contactEmailQuery` now uses `ModelUtils.literal()` (it was the one raw client value left; ScanQueueJob
  already did). Lookup retries a lost version race instead of returning 409.

Tests: new shared `test/routes/keyTrustSuite.ts` run from `test/routes/{mongo,sql}/KeyLookupRoute.test.ts` (create +
audit row, existing encrypt-only contact untouched fields, idempotent, 409 different key, 400 bodies/addresses, 400
expired/SAN mismatch/no identity/keyUsage/EKU/malformed extension, subject-E fallback and mixed-case SAN, 404/403
other/403 viewer/200 manager, folder CREATE/UPDATE rules, 3 concurrent same-cert trusts, 2 concurrent different certs,
trust racing lookup); `test/util/ContactKeyUtils.test.ts` (race branches, soft-deleted fallback, exhaustion);
`test/util/SignerCertificateUtils.test.ts`; generator `test/util/signerCertificates.ts`. Note: the ACL cache means a test
can't re-parent an ACL through the raw repo and expect the next request to see it - use separate folders.
Verification: `tsc --noEmit` and `yarn lint` clean; full `yarn vitest run --coverage` 248 files / 4927 tests passed,
coverage 100 / 96.64 / 100 / 100 (statements / branches / functions / lines).
