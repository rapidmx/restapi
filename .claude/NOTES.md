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
  derived from identity auth-server already has — calls auth-server's own `GET /api/aliases?
  type=name` (originally written as `/aliases/me`, which never existed - see the 2026-09-20 entry), forwarding the caller's `jwt` cookie (so it only ever sees *their* aliases), then
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
  message isn't re-sent receipts, auto-replies or forwards; iTIP re-applies (it's idempotent). ~~Folder counter bumps
  retry on a version conflict. Residual: counters can be under-counted if a worker dies between filing and bumping.~~
  Superseded 2026-09-20 ("Folder counts are derived"): counts are recomputed from the messages, so there is nothing to under-count.
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

## 2026-09-15 — Key rotation continuity, part A (publishing side): `issuerCertificate`, superseded-key revocation

Uncommitted, no version bump. Concurrent with part B (receiving side: KeyringUtils merge, Contact model, resolve endpoint).
Contract (react-shared/web-client/part B depend on it): `PublicKey.issuerCertificate?: string` (base64 DER of the direct
issuer, present when known) and, per a mid-task amendment, `PublicKey.revocationReason?: "superseded" | "compromised"`
(absent on a revoked key = compromised).

- **Capture.** `IssuedCertificate.issuerCertificate?` is PEM (same encoding as `certificate`). Local CA returns its CA cert;
  OpenBao returns `issuing_ca`, else `ca_chain[0]` (non-empty strings only). Signing certs (`enrollKey` sign path, ACME job)
  go through `publicKeyFromCertificatePem()`, which now splits a PEM chain (`splitPemCertificates()`): block 0 is the leaf,
  block 1 the candidate issuer, the rest ignored; no PEM blocks = parse the input as before.
  `verifiedIssuerCertificate(leaf, pem)` keeps it only if `leaf.issuer === issuer.subject`, `leaf.checkIssued(issuer)` and
  `leaf.verify(issuer.publicKey)` (checkIssued alone does NOT check the signature - verified with a same-name impostor CA)
  and base64 DER <= 16384. Failure drops the issuer, never refuses the install. The encrypt path verifies the CA's issuer too.
- **Publish.** Discovery returns `Mailbox.keys` as-is. `KeyDiscoveryClient.parsePublicKey()` (it rebuilds keys field by
  field, so the fields were being DROPPED, not rejected) now keeps `issuerCertificate` (base64, 1..16384 chars,
  `MAX_ISSUER_CERTIFICATE_BASE64_LENGTH`) and `revocationReason` (only alongside a numeric `revokedAt`); a malformed value
  makes the whole response malformed like every other field; null = absent. `sanitizeDiscoveredKey()` spreads the key, so
  both survive; it doesn't parse/verify the issuer - that's part B's call. Not in the `RapidMX-Key` header.
- **Supersession.** `supersedeKeys(keys, installed, now)` (used in `persistEnrollment()` and the ACME job's mailbox write):
  other unrevoked keys of the same `useType` get `revokedAt: now, revocationReason: "superseded"`; entries with the
  installed fingerprint are replaced (re-enrolling a revoked/expired cert no longer leaves a duplicate). Same write as the
  publish, so a failed install (CA error, 409 generation, collision, identity mismatch, mailbox write failure in the job)
  revokes nothing. `persistEnrollment()` still writes mailbox then vault inside `@Transactional()` (unchanged order).
  Wrapped private keys untouched (server never destroyed old signing private keys; still doesn't).
- **Rekey (decided).** Keys are rebuilt from the stored entry (`rekeyedKey()`): `issuerCertificate` absent/null = keep stored,
  equal = ok, else 400 (including adding one to a key stored without). Stored `revokedAt` is kept even if the request omits
  it (a published revocation isn't withdrawable); a reason can escalate superseded -> compromised only; a new `revokedAt`
  takes the request's reason or defaults to `"compromised"`; a reason without `revokedAt` is ignored; non-numeric
  `revokedAt`/unknown reason = 400; extra fields are no longer stored. Then `revokeInactiveKeys()` revokes (superseded)
  every unrevoked key that isn't its useType's active one (unrevoked, unexpired, latest `notBefore`, later index on tie -
  react-shared `findActivePublicKey()`'s rule), normalizing pre-existing mailboxes. No-op for a useType with no active key.
- **revokedAt consumers checked.** restapi: `BaseKeyVaultRoute` collision check (only blocks an active same fingerprint -
  unaffected); `AcmeEnrollmentDriverJob.flagExpiringSigningCerts()` (newest unrevoked sign key - same answer);
  `BaseMessageRoute` RapidMX-Key header and `ScanQueueJob` MDN rotation hint use `.find()` = FIRST unrevoked unexpired
  encrypt key, which after a rotation was the OLD key - now the current one (a fix). `KeyringUtils` (part B) reads
  `revokedAt` for conflict resolution. react-shared: `findActivePublicKey()` unchanged in effect (newest notBefore;
  revocation only changes the pick when an installed key has an older notBefore); `signingKeyFingerprints()` drops revoked
  keys -> own-mailbox and contact pins lose superseded signing keys, so old signed mail would show unverified until
  react-shared keeps `revocationReason: "superseded"` keys (at least for signatures made before `revokedAt`). Decrypting
  old mail: react-shared's unlock only opens the ACTIVE encryption key (pre-existing; revocation doesn't change it), and its
  rekey rewrap (`rewrapPrivateKeysUnderNewMasterKey`) only re-seals the active keys, so a rekey already drops older wrapped
  private keys from the vault (pre-existing spec gap, not changed here). web-client shows "(revoked)" on superseded keys.

Tests (under `.vitest-lock`, targeted, `--coverage.enabled=false`): new `test/routes/keyRotationContinuitySuite.ts` +
`{mongo,sql}/KeyRotationContinuity.test.ts` (controllable `ChainingTestCertificateAuthority`; issuer published through
discovery; impostor/none dropped; encrypt rotation revokes superseded, sign untouched, vault keeps 3 wrapped keys; no revoke
on CA failure/409/collision/identity; PEM chain sign install + revoke; bad chain issuers dropped; rekey issuer/revocation/
reason rules; legacy normalization); new `test/util/CertificateInstallUtils.test.ts`; LocalX509 (issuer = CA PEM),
OpenBao (issuing_ca / ca_chain / none / non-array), KeyDiscoveryClient (keep/null/reject), ACME job mongo+sql (chain
issuer + superseded, impostor dropped, failed publish revokes nothing then revokes on the retry). Also ran KeyVaultRoute,
KeyVaultRoute.SignEnrollmentAutomated, KeyDiscoveryRoute, RoutesKeysRound5 (both backends), BaseKeyVaultRoute unit, all of
`test/pki`, RapidMxKeyHeaderUtils - all passing. `tsc` and eslint clean on touched files (tsc errors remaining at the time
were part B's in-progress Contact changes). Pre-existing: `tsc -p tsconfig.test.json` reports errors in
`test/routes/BaseKeyVaultRoute.test.ts` (missing abstract `escrowScopeClass` on its test subclass), untouched.

## 2026-09-15 — Key rotation continuity, part B (receiving side): automatic replacement, `POST /:id/keys/resolve`

Uncommitted, no version bump. Concurrent with part A (above). react-shared and web-client are built against this contract.

Contract
- Types (`src/models/types.ts`): `KeyConflict { useType; observedKey: PublicKey; observedAt; source: "header"|"discovery" }`,
  `PreviousKey extends PublicKey { replacedAt; replacement: "automatic"|"user" }`, `RejectedKey { useType; fingerprint;
  rejectedAt }`. `Contact.keyConflicts?` (one per useType, latest wins), `previousKeys?` (newest first, <= 5 per useType,
  `MAX_PREVIOUS_KEYS_PER_USE_TYPE`), `rejectedKeys?` (newest first, <= 10, `MAX_REJECTED_KEYS`). `Contact.keyConflict` is
  gone. All three new fields are in `BaseContactRoute`'s DISCOVERY_MANAGED_FIELDS (the old `keyConflict` name stays refused).
  Mongo/SQL models: `simple-json` columns (SQL).
- Lookup/trust/resolve response: `{ keys, encryptPreference?, keyConflicts?, previousKeys? }` (both omitted when empty;
  conflicts normalized on output).
- `applyDiscoveredKeys(existing, discovered, observedAt, source, address)` - new 5th arg. Order per call: sanitize keys;
  copy listed revocations onto pinned/previous keys when stronger (`escalateRevocation()`: none < superseded < compromised
  or no reason; never weakened); then per non-revoked listed key: skip if already in previousKeys (same useType+fp); TOFU if
  nothing pinned (a revoked listed key is never TOFU-pinned any more - behaviour change); same fp = no-op;
  `canReplaceAutomatically(pinned, observed, address, observedAt)` -> pin, old to previousKeys (`automatic`, keeps its
  revokedAt/reason), drop that useType's conflict; else skip if in rejectedKeys; else set the useType's conflict.
- `canReplaceAutomatically()`: (a) `issuerCertificate` parses (Node), basicConstraints (peculiar) absent or cA true, N
  `issuer === I.subject && checkIssued(I) && verify(I.publicKey)` (same trio as part A's `verifiedIssuerCertificate`;
  checkIssued also enforces keyCertSign when I has keyUsage); (b) same for P; (c) P expired at observedAt (from P's cert) or
  `P.revokedAt` set (listing already escalated onto P); (d) `parseContactKey(N, address, useType, observedAt)`. One try block,
  anything throwing = false.
- `SignerCertificateUtils.parseContactKey(cert, address, useType, now)` generalizes `parseTrustedSignerKey` (now a wrapper).
  Encrypt usage decided from `LocalX509CertificateAuthority`: keyUsage (if present) needs keyAgreement OR keyEncipherment;
  EKU (if present) needs emailProtection for both use types.
- `sanitizeDiscoveredKey()` keeps `revocationReason` only if superseded/compromised AND `revokedAt` present (amendment).
- `POST /mail/mailboxes/:id/keys/resolve` (`BaseKeyLookupRoute.resolve()`, `@RateLimit()`), body `{ address, useType,
  action, expectedPinnedFingerprint, certificate? }`. Validation order: body object -> address `isPlainAddress` -> useType ->
  action -> fingerprint string 1..256 -> `certificate` with reject = 400 -> mailbox 404/403 (UPDATE) -> certificate
  `parseContactKey` 400 -> inside the shared write merge: no contact 404 -> folder UPDATE 403 ->
  - reject: no conflict 404; pinned fp != expected 409; clear conflict, `addRejectedKey`, audit
    `contact.key_conflict_rejected` `{ address, useType, fingerprint, pinnedFingerprint }`.
  - accept: no pinned useType key 404; given cert == pinned -> 200 no write (checked BEFORE 409 so a retried accept with a
    certificate is idempotent); pinned != expected 409; no cert and no conflict 404; conflict key re-validated now (400 if
    e.g. expired since; keeps its issuerCertificate); pin, previousKeys (`user`, new fp removed from previousKeys),
    conflict cleared, fp removed from rejectedKeys; audit `contact.key_replaced` `{ address, useType, from, to }`.
  A retried accept WITHOUT certificate after success gets 409 (conflict gone, pinned moved) - clients should treat 409 as
  "reload". 409 uses `INVALID_OBJECT_VERSION`. Never creates a contact.
- Clearing lists: `listField(next, stored)` writes `[]` when a stored list becomes empty (TypeORM `update` skips undefined, so
  `undefined` wouldn't clear on SQL).

Migration (decided): drop. The legacy `keyConflict` held only a fingerprint (not acceptable). It's no longer a model field, so
the model constructors never copy it (Mongo docs keep the stale field unread; SQL synchronize drops the column).
`normalizeKeyConflicts()` also drops malformed/legacy-shaped array entries and dedupes per useType. The pinned key is
unchanged, so the next observation of the differing key records a full conflict.

ScanQueueJob: `processInboundRapidMxKeyHeader()` notes whether the merge recorded a header conflict at `now`; after the write,
`refreshKeysAfterHeaderConflict()` calls `maybeRefreshRotatedKey()` (same shared write as the MDN hint) and logs+swallows
errors. Bounded by the federation negative cache, the key response cache and the fetch timeout. Awaited inline like the MDN
refresh ("non-blocking" = never fails delivery). Spec tension noted in the spec: discovery is otherwise compose-time only;
this fires at delivery for a DKIM-verified changed key header, revealing delivery time to the sender's server.

Tests: `test/util/KeyringUtils.test.ts` (existing tests moved to keyConflicts/5-arg; new "Key rotation continuity" block with
real CA-issued certs from new `makeTestIssuer()`/`issueCertificate()` in `test/util/signerCertificates.ts`: expired,
revoked via record, via listing superseded and no-reason, listed revocation escalation on pinned/previous, no-BC issuer ok,
encrypt usage ok; conflicts for different CA, same-name impostor CA, no issuer, pinned valid, issuer cA=false, issuer
unparseable, N or P not verifying, N other address, usage mismatch; revoked never TOFU; previous key ignored; latest conflict
wins; rejected not re-recorded; previousKeys/rejectedKeys bounds; legacy migration; sanitize reason); SignerCertificateUtils
(encrypt usage); new `test/routes/keyResolveSuite.ts` run from `{mongo,sql}/KeyLookupRoute.test.ts` (accept from conflict
with issuer, accept by certificate + idempotent retry, re-accepting a previous key, reject + later discovery not re-recording +
accept lifts rejection, 409s, 404s incl. keyless contact, 400s incl. expired recorded conflict, authorization incl. folder
not inheriting, resolve racing an auto-replacing discovery, lookup auto-replace with superseded listing); ScanQueueJob
mongo+sql (header conflict -> refresh -> auto-replace; non-federated keeps full header conflict; matching header doesn't
refresh; failing refresh still delivers); keyTrustSuite, model and ContactRoute tests updated from `keyConflict`.

Verification: `tsc --noEmit` and `yarn lint` clean. Full `yarn vitest run --coverage` (after part A's tree was idle):
251 files / 5022 tests passed; coverage 100 / 96.72 / 100 / 100 (statements / branches / functions / lines).

## 2026-09-15 — Message verification seal: `Message.verificationSeal`, `PUT /:id/verification-seal`

Uncommitted, no version bump. react-shared and web-client build against this contract. Amended mid-task from strict write-once
to generation-bound replacement (a key vault rekey makes older seals unopenable, so write-once would block re-sealing forever).

Contract
- `Message.verificationSeal?: string | null` (opaque; Mongo string, SQL `text` nullable) and
  `Message.verificationSealGeneration?: number | null` (SQL `integer` nullable). Both in `SERVER_MANAGED_MESSAGE_FIELDS`.
- `PUT /mail/messages/:id/verification-seal` (`BaseMessageRoute.setVerificationSeal()`), body `{ seal, masterKeyGeneration }`.
  Order: 500 no repoUtils -> 400 seal (not a string, empty, > `MAX_VERIFICATION_SEAL_LENGTH` = 2048 (exported), outside
  `[A-Za-z0-9+/=_.:-]`) -> 400 generation (not a non-negative safe integer) -> 404 -> 403 (READ and UPDATE on the message's
  current folder; checked BEFORE the vault lookup so a stranger can't probe for a vault) -> 409 no KeyVault for
  `message.mailboxUid` -> 409 generation != vault `masterKeyGeneration` (absent/invalid = 0) -> stored non-empty seal with
  storedGeneration (absent/invalid = 0): equal gen + identical = 200 no write; storedGen >= current = 409 (a different seal at
  the same gen, or anything at a newer gen); storedGen < current = replace (identical seal gets re-stamped too) -> no stored
  seal = write. Write is version-checked (`asEntity()`); a lost lock (RepoUtils 409) re-runs the whole read/vault/rules, up to
  3 attempts. Returns the message; publishes `update` on the folder channel. No legal-hold check, no audit.
- Vault read per attempt is uncached (`skipCache`) with `ModelUtils.literal(mailboxUid)`. Not atomic with the message write: a
  rekey landing between the vault read and the message write can still store a seal at the just-superseded generation - the
  next write at the new generation replaces it, so it's self-healing.
- `BaseMessageRoute` gained abstract `keyVaultClass` (breaking for custom subclasses; restapi's two concrete routes set it).
- `prepareCreate()`/`prepareUpdate()` delete both fields for TRUSTED callers too (decided: the dedicated route is the only
  writer). `:property` goes through `update()`, so it's dropped there too (200, unchanged).
- Route order: `@Put("/:id/verification-seal")` wins over the inherited `@Put("/:id/:property")` on both test backends
  (`getRouteMethods()` registers subclass members first).

Copy paths audited (restapi only): every `Message` construction lists fields explicitly - `ScanQueueJob` primary + rule copies,
`MailboxImportJob`. Forwards/list relays/recall/receipts relay MIME, not rows. `send()`/`ScheduledSendJob` file the SAME row into
Sent Items (not a copy), so a seal on a draft stays on that row - not refused, the contract doesn't mention drafts. Import formats
are only mbox/PST (no JSON import of the user's own export exists), so import never sets either field; if a JSON import is ever
added, it may keep both only for the user's own export. JSON data export and matter export serialize whole rows
(`collectMailboxContentLines()`), so both are included as-is; mbox can't carry them. Erasure purges rows. activesync/mapi sibling
repos don't subclass BaseMessageRoute and weren't checked for copy paths.

Tests: shared `test/routes/verificationSealSuite.ts` run from `test/routes/{mongo,sql}/MessageVerificationSeal.test.ts` (28 each:
set, rekeyed-vault generation, max length, idempotent without version bump, 409 different at same gen, replace after rekey then
hold, identical seal re-stamped, stored seal without generation = 0, stale/future client generation, vault without generation = 0,
stored newer than vault 409, no vault 409, real concurrent races (first write; replacement), deterministic interleavings via a
one-shot `RepoUtils.prototype.update` spy (different seal 409, replacement race 409, same seal 200, unrelated write retried), 400
bodies incl. generation, 404, 403 other/READ-only/UPDATE-only + delegate 200, 403 before vault check, legal hold doesn't block,
create/bulk create/update/bulk update/`:property` ignore both fields for owner and admin, sealed draft send keeps one row and
relays no seal). `test/routes/BaseMessageRoute.test.ts` guard (500). ScanQueueJob mongo+sql: a retry after the primary was
sealed files a rule copy without either field and forwards MIME without the seal. DataExport/MatterExport JSON include both;
MailboxImport mbox leaves both unset.

Verification: `tsc --noEmit` and `yarn lint` clean. Full `yarn vitest run --coverage`: 253 files / 5081 tests passed; coverage
100 / 96.74 / 100 / 100 (statements / branches / functions / lines).

## 2026-09-15 — Plugin UI contract: `PluginManifest.ui`, mount validation and conflicts

Uncommitted, no version bump. Phase 2 of the booking-as-a-plugin plan (`~/.claude/plans/cheerful-giggling-pine.md`): the
server's PluginHost/PluginUiBuilder and the booking plugin build on this.

Contract
- Types in `src/models/types.ts`: `PluginUiHost` (`public|www|admin|escrow`), `PluginUiApp { id, host, mount, dir }`,
  `PluginUiNavItem { id, label, href, icon? }`, `PluginUi { apps?, settingsSections?, adminNav?, appRail? }`,
  `PluginManifest.ui?`. `apiVersion` stays 1.
- New `src/plugins/PluginUiUtils.ts` (exported from root): `parsePluginUi()`, `findPluginUiMountConflicts()`,
  `pluginUiMountsOverlap()`, `RESERVED_PLUGIN_UI_MOUNTS`, `PLUGIN_UI_HOSTS`, `MAX_PLUGIN_UI_APPS` (16),
  `MAX_PLUGIN_UI_NAV_ITEMS` (8), `MAX_PLUGIN_UI_LABEL_LENGTH` (64). `parsePluginManifest()` calls `parsePluginUi()` when
  `ui` is neither undefined nor null; unknown fields inside `ui` and its entries are dropped.
- Rules: ids are lowercase slugs (`[a-z0-9]+(-[a-z0-9]+)*`, <= 64) unique per list. `dir`: `/`-separated segments of
  `[A-Za-z0-9_-][A-Za-z0-9._-]*`, <= 200 chars (so no leading `/`, drive letter, backslash, empty/`.`/`..`/hidden segment).
  `mount`: slug-segment absolute path <= 200, exactly ONE segment below the host base (public `/<n>`, www `/<n>` or
  `/settings/<n>`, admin `/admin/<n>`, escrow `/escrow/<n>`). Decision: no deeper mounts - an app's own file routing gives
  nested pages, and one segment means an exact match against the reserved list is enough (nothing can sit beneath a
  reserved path). Not in `RESERVED_PLUGIN_UI_MOUNTS`, no overlap between the plugin's own apps. Nav `href`: slug-segment
  path; settingsSections `/settings/<...>` (>= 2 segments), adminNav `/admin/<...>`, appRail first segment not
  admin/escrow. `label` non-blank <= 64. `icon` optional, `^Hi[A-Z][A-Za-z0-9]*$` <= 64 (react-icons/hi2 name, as the
  shells use).
- Reserved list (must track server core routes): `/api /assets /__rapidrest__ /.well-known /internal /push`, server/public
  (`/favicon.ico /fonts /images /styles`), www pages (`/calendar /contacts /messages /tasks /settings` + the 9 core settings
  sections), `/admin` + its 15 page dirs, `/escrow /escrow/audit-log /escrow/matters`. NOT `/book` or
  `/settings/booking-types`.
- `findPluginUiMountConflicts(plugins)`: pairs from different plugins with equal or nested mounts, across hosts (one URL
  space), in list order; `name` = later plugin, `otherName` = earlier (a host keeping the first claimant drops `name`).
  Message: `"A and B both serve pages at /x."` or `"A's pages at /x/y overlap B's pages at /x."`.

Planner / route
- `planPluginChange()` appends conflicts for overlaps in the post-change enabled set (untouched enabled rows, then installs,
  enables, then the change at its new manifest) where the later plugin is one the change touches. Unrelated pre-existing
  overlaps are ignored; a version change isn't compared with its own old version.
- `BasePluginRoute.applyChange()` race recheck also compares mount conflicts (enabled rows sorted by name so messages are
  order-independent) before vs after, refusing new ones with the existing "Another plugin change made at the same time" 409.

Tests: `test/plugins/PluginUiUtils.test.ts` (every rule, reserved list, overlap and conflict helpers), PluginUtils (manifest
keeps ui, null ui, errors), PluginDependencies (enabled/disabled/removed, installed/enabled dependency, own vs dependency,
version change, unrelated pair), `pluginRouteSuite` mongo+sql (add/plan/enable 409, invalid ui 400, stored manifest keeps
ui, race undo in both name orders, pre-existing overlap doesn't block a settings save).

Verification: `tsc --noEmit` and `yarn lint` clean (`tsconfig.test.json` has pre-existing unrelated errors). Full
`yarn vitest run --coverage`: 254 files / 5112 tests passed; coverage 100 / 96.78 / 100 / 100; PluginUiUtils,
PluginUtils, PluginDependencies and BasePluginRoute at 100% on every metric.

## 2026-09-15 — Booking removed from core (moving to `@rapidmx/booking-plugin`)

Uncommitted, no version bump. Phase 6 (restapi part) of `~/.claude/plans/cheerful-giggling-pine.md`. Started from
`319623229ade781575d83cb17a8561a3645f7a79`; the booking plugin copies the removed code from that commit.

Removed
- `src/models/types.ts`: `BookingAvailabilityWindow`, `BookingDateOverride`, `BookingType`, `BookingStatus`, `Booking`.
- Models `BookingMongo`, `BookingTypeMongo`, `BookingSQL`, `BookingTypeSQL`; routes `BaseBookingRoute`,
  `BaseBookingTypeRoute`, `Booking{,Type}Route{Mongo,SQL}`; `src/util/BookingUtils.ts`; their index re-exports.
- `ErasureExecutionJob` abstract `bookingTypeClass`/`bookingClass` and the Mongo/SQL assignments; the explicit purge
  calls. Erasure tests no longer seed bookings (purgedCount 22 -> 20); the generic `PluginMailboxData*` fixture still
  covers plugin `@MailboxScopedData()` models.
- Tests: `test/routes/booking{Security,TypeFolder}Suite.ts`, `test/routes/{mongo,sql}/Booking{,Type}Route.test.ts`,
  `test/server-{mongo,sql}/routes/Booking{,Type}Route.ts`, `test/util/BookingUtils.test.ts`, the Booking model cases in
  `test/models/{mongo,sql}.test.ts`.
- Stale comment references to `BaseBookingRoute`/`BookingUtils` reworded (Branding, KeyDiscovery, KeyVault,
  EscrowAccessRequestRouteMongo, IcsUtils, FreeBusyUtils, PluginUiUtils, test config-defaults, IcsUtils test).
- Resource/room booking (`Mailbox.autoAcceptBookings`, booking window, `ScanQueueJob.decideResourceBooking`) untouched.

Added: `export * from "./DateCoercionUtils.js"` in `src/util/index.ts` (no name collisions). Everything else the moved
code imports was already on the root / `mongo` / `sql` entry points.

Erasure / export findings
- Erasure is generic: `ErasureExecutionJob.pluginMailboxScopedClasses()` purges by `mailboxUid` every ObjectFactory class
  with `@MailboxScopedData()` whose `rrst:datasource` equals the job's Mailbox class (`"mongo"`/`"sql"`). Plugin needs
  the decorator on all four models, `@DataStore("mongo"|"sql")` unchanged, and `rapidmx.plugin.mailboxScopedData: true`
  so an erasure waits (not completes) while the plugin is installed but not loaded.
- Gap: a deployment that upgrades restapi with booking data but never installs the plugin has no Plugin row declaring
  mailbox data, so erasure completes and leaves `booking*` rows. Mitigated by the server adding the plugin to
  `system:plugins:defaults`.
- `DataExportJob`, `MatterExportJob` and mailbox deletion never included bookings, and have no plugin hook: no regression.
- Keep class names (collection/table names `BookingMongo`/`booking_sql`...), index names and `@Protect` uids
  (`Booking`, `BookingType`) so existing data and class ACLs carry over.
- `mail:booking:public_url` was only a `@Config` default inside `BaseBookingRoute` (no restapi defaults file). Test
  config's raised `rateLimit` block stays (key discovery uses `@RateLimit()`); the plugin tests need an equivalent.

Verification: `tsc --noEmit`, `yarn lint`, `yarn build` clean. Full `yarn vitest run --coverage`: 249 files / 4897 tests
passed; coverage 100 / 96.75 / 100 / 100.

## 2026-09-15 — Recipient suggestions: `BaseDirectoryRoute` (`GET /mail/directory`, `GET /mail/directory/contacts`)

Compose To/Cc/Bcc autocomplete (web-client `RecipientInput`, react-shared `mail/directoryApi.ts`). Server mounts
`@ApiRoute("mail/directory")` on `DirectoryRouteMongo`/`DirectoryRouteSQL`.

Contract
- `GET /` (`search`): mailboxes + distribution lists. `GET /contacts` (`searchContacts`): caller's contacts. Both
  `@Auth(["jwt"])`, `@RateLimit({ perUser, maxAttempts: 120, windowSeconds: 60 })` (separate buckets per path), return
  `DirectoryEntry { displayName, address, kind }` only. kind: `user` (ownerUserUid), `shared` (no owner), `room`/`equipment`
  (`isResource`; missing `resourceType` → room), `list`, `contact`.
- `parseDirectoryQuery()`: q one string, trimmed+lowercased length 2..100 (400 otherwise, incl. repeated `q`), split on
  whitespace, distinct, first 5 terms. limit `^\d{1,6}$` positive, default 8, capped 20.
- Matching: every term is a prefix of a name word (split `[\s-]+`) or of the address (primary only - aliases neither
  matched nor returned, so an alias can't be probed). Contacts: words from displayName + givenName + surname; one entry per
  email that satisfies the terms (so a name match lists all addresses, an address match only that one); displayName falls
  back to "given surname". `rankDirectoryEntries()`: entries whose name/address starts with the whole query first, then
  name (base sensitivity), address; dedupe lowercase address, first wins.
- Backend queries are precise, then re-checked in JS with `matchesDirectoryTerms()`, fetching `limit * 2` candidates.
  Mongo: native `MongoRepository.find` with `$and` of `$or` per term, `$regex` `(?:^|[\s-])<escaped>` / `^<escaped>`,
  `i`; projections limit fields. SQL: QueryBuilder `Brackets` per term, `LOWER(col) LIKE :p ESCAPE '\'` with `t%`,
  `% t%`, `%-t%` for names and `t%` for addresses; contacts' `emails` simple-json matched as `%"address":"<json-escaped,
  like-escaped term>%`. SQLite `LOWER()` is ASCII-only, so non-ASCII case variants can miss on SQLite (JS check is
  Unicode-aware but can't add rows the DB didn't return). Boolean `deleted = :deleted` with `false` binds fine on
  better-sqlite3 through TypeORM.

Security/privacy decisions
- Directory search needs a caller who owns a mailbox here (`ownerUserUid in [uid, uid.toLowerCase()]`) or a trusted role:
  an identity from the shared auth service without a mailbox gets 403. Delegate-only users without their own mailbox are
  refused too (auto-provisioning normally gives users one); revisit if that matters.
- No "hidden from address lists" flag exists on Mailbox/DistributionList (searched types.ts), so every mailbox is listed
  except those with a `DataSubjectErasureRequest` in `approved`/`in_progress` (filtered after the query). Soft-deleted lists
  excluded; a completed erasure has already deleted the mailbox. Disabled domains are not considered.
- `/contacts` never 403s: folders = `type contacts` folders (max 50) of owned mailboxes + `mailboxUid` if
  `hasPermission(READ)` on it (else silently ignored), each kept only with READ on the folder (an explicit empty record
  denies), soft-deleted folders skipped. Contacts query excludes soft-deleted.
- Literal matching: user text only reaches regex/LIKE escaped (`escapeDirectoryRegExp`, `escapeDirectoryLike`), never
  the search-query parser (`like()` passes `%`/`_` and globs through unescaped, so it wasn't used). Escaped regex has no
  quantified groups, so no ReDoS. Tests send `.*`, `%%`, `__`, `like(*)`, `regex(.*)`, `(a+)+$`, `[a-z]*`, backslashes,
  quotes, `$ne`.
- Enumeration: 120/min × 20 per request is a GAL-like exposure for signed-in mailbox holders only; name/address/kind only.

Tests: `test/routes/directorySuite.ts` via `test/routes/{mongo,sql}/DirectoryRoute.test.ts` (fixtures
`test/server-{mongo,sql}/routes/DirectoryRoute.ts` at `/mongo|sql/directory`), `test/routes/BaseDirectoryRoute.test.ts`
(helpers). Defensive `deleted`/`?? ""` checks in the base were removed (the abstract finders' contract excludes deleted
rows) because they were unreachable and cost coverage.

Verification: `tsc --noEmit`, `yarn lint`, `yarn build` clean. Full `yarn vitest run --coverage`: 252 files / 4928 tests
passed; coverage 100 / 96.78 / 100 / 100; BaseDirectoryRoute and both concrete routes at 100% on every metric.

## 2026-09-15 — Delivered messages recorded only the envelope recipient, and the whole From header as the sender's name

Two bugs in what `ScanQueueJob` writes onto a delivered `Message`, both found from `@rapidmx/web-client` while fixing
Reply All (its HEAD `7d689a0` works around the first client-side, recovering `To`/`Cc` from the raw message).

- **`recipients` came from the SMTP envelope** (`entry.envelopeTo.map(...)`), and `BaseMailIngestRoute` stages one entry
  per recipient with `envelopeTo: [address]` - so every delivered copy claimed it had exactly one recipient (itself).
  Reply All, conversation participants (`BaseMessageRoute`'s union of `from`+`recipients`), `SearchIndexJob`'s
  participant list and EAS/MAPI's To/Cc fields were all wrong. Now built from the message's own headers.
- **`from.displayName` was `result.parsedFrom`**, the *whole* `From` header (`"Bob Allen" <bob@partner.test>`), so a
  client showing the name and then the address rendered it twice.

Decisions
- **Parsing lives in `ScanPipeline`, not a second header scan.** `ScanPipelineResult` gained `headerRecipients:
  Recipient[]` and `fromDisplayName?: string`, filled from the `ParsedMail` it already produces - mailparser has
  already split the address lists, RFC 2047-decoded the names and expanded groups, so a huge or hostile header adds no
  new parsing and no new regular expression to the ingest path. `parsedFrom` stays (mail filter `from` conditions match
  the whole header value). Additive, so `@rapidmx/activesync`/`mapi` are unaffected.
- **New `src/util/RecipientUtils.ts`** (barrel-exported): `parseHeaderRecipients()`, `buildDeliveredRecipients()`,
  `parseSenderDisplayName()`, `storedAddress()`, `storedDisplayName()`, `MAX_MESSAGE_RECIPIENTS = 100`. Pure, so it is
  unit-testable without a DB. Bounds: 100 recipients per message, 320-character addresses (RFC 5321), 200-character
  display names, group nesting followed 5 deep, and the walk stops as soon as the cap is reached (a 50k-address header
  costs 100 entries of work). Control characters are refused in an address and replaced in a name - a stray CR/LF must
  never reach a header this server composes. No regular expression sees attacker text (character-code scans, like
  `MimeHeaderUtils.ts`; the only regex is a literal ` {2,}` whitespace collapse).
- **Typing**: `To` -> `to`, `Cc` -> `cc`, and a `Bcc` header **only when the stored copy genuinely carries one** (a
  Sent Items copy, or an MTA that left it on) - a bcc entry is never invented for another recipient, since a delivered
  copy normally has no `Bcc` header at all.
- **The envelope recipient stays represented**, deduped case-insensitively by address: when no header names it (bcc'd,
  alias-only, distribution-list expansion) it is added as **`bcc`** - that is what it is from this copy's point of
  view, it keeps Reply All from putting a privately-addressed address back on a visible header (web-client already
  carries no bcc recipient over), and it means the copy always still records the mailbox it was delivered into.
  Envelope entries are never the ones dropped to the cap; they displace the last header recipients instead.
- **`from.address` deliberately unchanged** - still `entry.envelopeFrom`, not the `From` header's address.
  `BaseMessageRoute.upsertSenderOverride()` writes a focused-inbox override keyed on `message.from.address` while
  `ScanQueueJob.classifyForInbox()` looks it up by `entry.envelopeFrom`; they must agree, and `SearchIndexJob` indexes
  the same value. Only the display name was wrong, so only the display name changed.
- **Not sanitized through `safeDisplayName()`**: that drops a name containing an `@`, which is right for a name this
  server puts in front of one of its *own* addresses, but here the name is what the sender shows the reader and
  `web-client`'s `MessageDetailPane.checkSenderName()` phishing warning needs to see it. The fix actually *improves*
  that warning: with the whole header stored, every named sender used to look "address-like" and often "misleading"
  (the address extracted from the name is the `From` address, compared against the envelope one). No web-client change
  is needed; its raw-header Reply All recovery in `quotedBody.ts`/`MessageDetailPane.tsx` is now redundant for newly
  delivered mail and can be simplified later.
- **Other creation paths checked**: only `ScanQueueJob` (primary row + a filter rule's `copyToFolderUids` copy) and
  `MailboxImportJob` create a delivered/ingested `Message` (`grep "new this.messageClass"`). `MailboxImportJob` stored
  `recipients: []` and the same combined display name - fixed, with no envelope to fall back on (an import has none).
  `BaseMessageRoute.send()`/`ScheduledSendJob` store what the client composed (already correct);
  `MeetingSchedulingJob`, forwarding/relay copies and distribution-list expansion only relay MIME and create no
  `Message` row; `BaseMailIngestRoute` creates only `IngestQueueEntry` rows.
- **No migration** (pre-release): existing dev data keeps the old one-entry list and combined name. Nothing in this
  repo reads `displayName` back apart from `safeDisplayName()` on a client-written value, so no reader tolerance was
  needed.

Tests: `test/util/RecipientUtils.test.ts` (23 unit tests, 100% on every metric), 8 new `ScanPipeline` tests, and
matching Mongo+SQL suites for `ScanQueueJob` (6 each: multiple To/Cc with display names, a comma inside a quoted name,
an RFC 2047 encoded word, a bcc'd/alias-only envelope recipient, no sender name, a 5000-address header capped with the
envelope recipient still kept, a malformed header) and `MailboxImportJob` (1 each).

Verification: `yarn tsc --noEmit`, `yarn lint`, `yarn build` clean. Full `yarn vitest run --coverage`: 253 files /
4973 tests passed; coverage 100 / 96.8 / 100 / 100.

## 2026-09-15 — Mail list UX phase 1 (data/API): server-side sort + filter, nested conversations, bounded bulk

Phase 1 of an Outlook-parity mail list overhaul (phase 2 builds the UI in `web-client`). The whole point of this
phase was that the *database* has to do the ordering and filtering: a client that sorts or filters a page it already
fetched is wrong as soon as the folder is bigger than the page.

- **Four denormalized `Message` mirrors, `util/MessageListUtils.ts`.** `flags` and `from` are one `simple-json`
  column on SQL (and an embedded sub-document on Mongo), and `ModelUtils.buildSearchQuery` can't filter or sort on a
  field *inside* one on both backends - that's the constraint react-shared's `mail/flaggedMessages.ts` had already
  written up as the reason "every flagged message" fanned out per folder and filtered in the browser. So `read`,
  `flagged`, `fromAddress` (normalized + `boundIndexedValue()`) and `importanceRank` (0/1/2 - the enum's stored
  strings sort `high`, `low`, `normal`, which is useless) are now ordinary top-level columns.
  - Kept in sync in exactly two places: `deriveMessageListFields()` in both model constructors (covers every
    `new MessageMongo/SQL({...})` - ScanQueueJob's delivery and filter-rule copy, MailboxImportJob, compose), and
    `syncMessageListFields()` on an update patch, which `BaseMessageRoute.prepareUpdate()` applies to every REST
    write. The two direct `repoUtils.update()` calls that rewrite `flags` themselves (`fileSentMessage()`,
    `ScheduledSendJob.relayDueMessage()`) spread `deriveMessageListFields()` inline. `lockUnreadForRecall()` rewrites
    `flags` unchanged, so it needs nothing.
  - All four are in `SERVER_MANAGED_MESSAGE_FIELDS`: a body naming them is stripped, for trusted callers too.
    Otherwise a caller could set `read: true` without `flags.read` and the two readers would disagree.
  - **Known gap, deliberately not closed here**: `@rapidmx/activesync-plugin`/`@rapidmx/mapi-plugin` write `flags`
    through their own repos and will desynchronize the mirrors. `syncMessageListFields()` is exported from the
    package root for them. A self-healing backfill was considered and rejected for now: a new job would need the
    server's `worker.*` wiring (uncommitted in that repo at the time), and piggybacking it on
    `MailboxQuotaRecalcJob` - the only job that already pages every message of every mailbox - muddies that job's
    single responsibility. Same reason legacy rows aren't backfilled; they're nullable and read as
    unread/unflagged/normal, which is documented in the release notes.
- **Named `?filter=`/`?sortBy=`/`?sortOrder=` rather than leaving it to the generic DSL.** Two things forced it:
  `filter=focused` has to be `inferenceClassification = "focused" OR IS NULL` (absent means focused) and
  `stripUnsafeQueryKeys()` drops a *client's* `$or`; and `sortBy=from`/`importance` must map onto the mirrors, not
  the fields they come from. Implemented with two new hooks on `BaseScopedChildRoute` - `listQueryParams` (keys the
  route interprets itself, deleted before the query reaches `RepoUtils` - a non-column key fails the SQL query
  outright) and `listQueryOverrides()` (server-built fragments merged over the stripped client query, before
  `params` and the forced scope). `BaseMessageRoute` is the only implementer. Because `scopedFilter()` backs
  `find()`, `count()` and `truncate()`, `HEAD` gets the same filter for free - so a filter's count matches its list.
- **Sort always carries `receivedDate` then `uid` as tiebreakers.** Without a total order, `limit`/`page` can show
  the same message twice or skip one. Same reasoning applied to `summarizeConversation()`, which now breaks a
  `receivedDate` tie by `uid` - it used to depend on the database's own row order, and adding a sort to the
  conversation scan flipped it, which is how the existing "Groups a reply with its parent" test caught it (fixture
  now gives the root an explicitly older `receivedDate`).
- **Conversations**: `?folderUid=`, `?filter=`, `?limit=`/`?page=` (over the grouped rows), scan ordered newest-first
  so the cap drops the oldest, five new summary fields for a collapsed parent row, and `GET /conversations/:id` for
  the expanded children (oldest first, mailbox-scoped, default 100 / max 500 per page, singleton fallback to a uid
  lookup for a message with no `conversationId`). Route order is fine: `/conversations/:id` is a deeper static
  prefix than `/:id`, and both routers match static segments by specificity.
- **No new bulk endpoint.** `BaseScopedChildRoute.updateBulk()` (`PUT` on the collection, inherited by every scoped
  child route) already loops `update()` per element, so bulk mark read/unread, flag, move, archive, report junk and
  relabel are all one request through it with every per-message check intact. It was *unbounded*, though - one
  request could be an arbitrarily long write loop - so it's now capped at `MAX_BULK_UPDATE` (100) with a 400. Its
  fail-fast, non-atomic, partially-applied semantics are now documented on the method rather than changed: a
  tolerant per-element variant would be a second authorization surface for no behavior the client can't get by
  sending the items individually.
- **Outlook options this data model cannot serve, dropped rather than invented**: sort by Category (labels are
  multi-valued - there is no single category to order by), Flag due date (no follow-up date field), Size (no size on
  `Message`; the raw MIME's length lives only in the blob store and `MailboxQuotaRecalcJob` reads it from there) and
  Type (no message class). Filter by To me (would need a delivery-time boolean computed against the owning
  mailbox's addresses - `recipients` is `simple-json`, so it isn't queryable either), Mentions me (nothing parses
  mentions) and Has calendar invites (`ScanPipelineResult.icsPart` exists but is never persisted on the message).

Tests: `test/util/MessageListUtils.test.ts` (100% on every metric) plus a shared `test/routes/messageListSuite.ts`
run against real Mongo and real SQL (`test/routes/{mongo,sql}/MessageList.test.ts`, 32 cases each) - every sort key,
every filter, the `$or` focused branch on both backends, paging stability, mirror derivation/re-derivation/body
rejection, conversation fields/folder scope/filter/paging/tie-break, conversation expansion incl. the singleton
fallback, bulk update and its cap, and the delegate/stranger ACL paths.

## 2026-09-15 — Mail list label filter: `?labelUids=`, and why it is NOT a mirror column

Follow-on to the same day's phase-1 entry: web-client's Filter menu wants "filter by label, itself a menu of all
labels, with multiple selection". `GET /mail/messages` (+ `HEAD`) and `GET /mail/messages/conversations` now take
`?labelUids=<uid>,<uid>,...` — OR across the set, ANDed with `?filter=`, applied server-side before paging, and (for
conversations) to the messages before they are grouped, the same point `?filter=` is applied.

- **The hard part was SQL.** `MessageSQL.labelUids` is a `simple-json` column — opaque JSON *text*, not a queryable
  array — while Mongo stores a real array. `ModelUtils`'s shared DSL can't express one predicate that means the same
  thing on both: `in()` is array membership on Mongo and a whole-column `IN` on SQL; `like()` on Mongo's array field
  matches a bare *element* (no JSON quotes) while on SQL it matches the serialization. So the predicate is built per
  backend — `buildLabelUidsFilter()`, a new abstract on `BaseMessageRoute`, implemented by `MessageRoute{Mongo,SQL}`
  over `buildMessageLabelFilter{Mongo,SQL}()` in `util/MessageListUtils.ts`. Abstract, not defaulted: a default can
  only be right for one backend and the failure mode is silently wrong rows. (Same "one abstract per backend" shape
  `BaseDirectoryRoute` already uses for regex-vs-LIKE.)
  - Mongo: `{ labelUids: ModelUtils.literal(uids, "in") }` → `$in`, which against an array field *is* membership.
  - SQL: `{ $and: [{ $or: uids.map(u => ({ labelUids: `like(*"<u>"*)` })) }] }` → one `ILike('%"<uid>"%')` per uid
    against the stored `["a","b"]`. Matching **with the JSON quotes** is what makes it exact-uid-safe. `$and` rather
    than a bare `$or` because `filter=focused` already emits a top-level `$or` and the fragments are merged into one
    object — a second `$or` key would replace it. `$and`+`$or` compose on both backends (`buildSearchQuerySQL`
    cross-products the branches; Mongo passes both keys through).
- **Rejected: a `labelIndex`-style mirror column** (the obvious phase-1-consistent move). Three reasons: (1) it would
  need a backfill before any *existing* deployment's already-labelled mail became findable — unlike the `read`/
  `flagged` mirrors, where a stale value is a wrong sort, here it is a message silently missing from a filter the user
  explicitly asked for; (2) it goes stale for any writer that sets `labelUids` outside this library's update path
  (activesync/mapi plugins, and `BaseLabelRoute.cleanUpDeletedLabel()`'s own direct `repo.update()`); (3) it buys no
  index anyway — a leading-wildcard `LIKE` on a mirror is exactly as unindexable as one on the JSON text. The list is
  already narrowed to one folder by `message_folder_received` before either is evaluated. So: no schema change, no
  migration, no write-path cost, correct for every row however it was written.
- **Injection/ReDoS safety comes from validating the uid, not from escaping.** `parseMessageLabelUids()` requires each
  entry to match a v4-UUID shape (every uid this library mints — `BaseScopedChildRoute.create()` refuses a
  client-chosen one), which by construction excludes `%`/`_` (LIKE wildcards), `"`/`\` (breaking out of the JSON
  string) and `(`/`)`/`,` (the `op(value)` DSL's own syntax). A non-uid entry is a 400 rather than a query matching
  nothing. Cap `MAX_MESSAGE_LABEL_FILTER_UIDS` = 20 (each uid is one more OR branch / one more LIKE). Empty value =
  unset; an empty *entry* (`a,,b`) is a 400; a repeated `?labelUids=a&labelUids=b` is flattened into one set rather
  than going through the DSL's "zip" semantics for repeated keys.
- **`?labelUids=` used to fall through to the generic DSL** and meant different things on the two backends (Mongo:
  single-label array membership; SQL: a whole-column compare that matched nothing). Adding it to
  `MESSAGE_LIST_QUERY_PARAMS` makes the route interpret it instead — noted in the release notes as a behavior change.

Tests: 10 new cases in the shared `test/routes/messageListSuite.ts` (so 10 on real Mongo *and* 10 on real SQL) —
single label, several ORed in either order, ANDed with `filter=unread`/`read` plus a sort, HEAD count, paging
stability, unknown uid, another mailbox's uid (and that the same uid still works in its own folder), a legacy row with
`labelUids: null`, a near-miss uid differing in its last character, empty/repeated parameter, malformed uid and cap
exceeded, plus the conversation endpoint; and 9 unit cases in `test/util/MessageListUtils.test.ts`. Full
`yarn vitest run --coverage`: 254 files / 5088 tests passed, coverage 100 / 96.8 / 100 / 100. `yarn tsc --noEmit`,
`yarn lint`, `yarn build` clean.

## 2026-09-16 — Reply threading: the headers were never written, and a conversation is resolved against the mailbox

JP: a reply chain showed up in conversation mode as separate rows ("Arthur, Jean-Philippe, Administrator — Re: Hello"
*and* "Arthur — Re: Hello"), each opening as "1 message". Reproduced end to end against a real server (in-memory
Mongo/Redis, `NODE_ENV=development`, mail seeded through `/internal/mta/deliver`, replies composed through the real
`POST /mail/compose/:id/assemble` + `POST /mail/messages/:id/send` path) before changing anything.

- **Root cause: nothing ever wrote `In-Reply-To`/`References`.** `server`'s `BaseMailComposeRoute.assemble()` builds
  the MIME with `MailComposer` from `{to, cc, bcc, subject, html, attachments}` - `ComposeAssembleInput` has no
  threading fields and `MailComposer` is given none - and `send()` only prepended `Disposition-Notification-To` and
  `RapidMX-Key`. The relayed headers in the repro were literally `From/To/Subject/Message-ID/Date/MIME-Version/
  Content-Type`. So every recipient's `ScanQueueJob` saw `references: []`, `inReplyTo: undefined` and
  `deriveConversationId()` fell through to the message's own `messageId`: a new conversation per reply. The sender's
  Sent Items copy got the same treatment from `scanAndRelay()`. The "conversation row with three participants" was
  just *one* delivered copy whose `from` + `recipients` happen to name three people.
- **`GET /mail/messages/conversations` was never wrong.** It keys every message on `conversationId ?? uid`, so a
  message is in exactly one group - there is no overlap to fix. What looked like duplicates were unthreaded
  messages. Still covered by a new test (every group's `messageUids` disjoint, every message present exactly once).
- **The client half must supply what is being replied to** and that is the one part this repo cannot do for itself.
  `inReplyTo`/`references` are deliberately *not* in `SERVER_MANAGED_MESSAGE_FIELDS`, so a plain
  `POST /mail/messages` body carries them; react-shared now has `buildReplyThreading()` and
  `createDraft(mailbox, folder, threading)`, and web-client's `ComposeWindow` has to pass them (its `createDraft()`
  call at `apps/shared/components/mail/compose/ComposeWindow.tsx:527` sends neither today). Nothing server-side can
  recover it: by assemble time the draft is recipients + subject + HTML.
- **`applyThreadHeaders()`/`threadHeaders()` (`util/MailSendUtils.ts`)** write the headers at send time, from the
  draft row, and `send()` persists the threaded bytes to the body blob *before* the claim - so a scheduled send
  relays the same bytes and a client reading the raw source sees the thread. MIME that already carries either header
  is returned untouched (`assemble-raw`'s client-finalized signed/encrypted bodies, EAS/MAPI compose handlers).
  `References` is the draft's chain with the parent appended, trimmed from *after the root* to
  `MAX_RELAYED_REFERENCES` (20) entries and `MAX_RELAYED_REFERENCES_LENGTH` (900) characters - RFC 5322 caps a header
  line at 998 and `prependHeaders()` strips CR/LF rather than folding, so the trim is what keeps the line legal.
  Each id is stripped of brackets/CRLF and dropped if it contains whitespace.
- **`resolveConversationId()` + `findThreadConversationId()` (`util/ConversationUtils.ts`)** replace the pure
  `deriveConversationId()` at both write sites (`ScanQueueJob.deliverMessage()`, its filter-rule copy,
  `BaseMessageRoute.send()`, `ScheduledSendJob.relayDueMessage()`): one `mailboxUid` + `messageId IN (ancestors)`
  query (`message_id` index), ancestors being `inReplyTo` then `references` reversed, bounded and deduped at
  `MAX_CONVERSATION_ANCESTORS` (20). Needed because header-only derivation breaks at depth 3 for a client that sets
  only `In-Reply-To`: the third message would key on the second's `Message-ID`. Deliberately *not* subject-based -
  this codebase never implied a subject fallback, and a subject-change test pins that.
  - Known, accepted gap: out-of-order delivery (a reply arriving before its parent, with no `References`) can leave
    two groups that a later merge pass would have to join. No merge pass exists; documented rather than built.
  - `MailboxImportJob` still uses the pure derivation - an mbox archive carries real `References` - and an import
    would otherwise pay a lookup per message.
- **The Sent Items copy now also stores the `inReplyTo`/`references` the relayed bytes carry**, not just what the
  draft row said, so the `assemble-raw` path (headers composed client-side) records the thread too.

Tests: 6 new delivery cases in each of `test/jobs/{mongo,sql}/ScanQueueJob*.test.ts` (two- and three-deep chains,
References-only, subject change mid-chain, a same-subject message that replies to nothing, an orphan reply), 8 new
send cases in each of `test/routes/{mongo,sql}/MessageRoute.test.ts` (headers written and persisted, three-deep via
the mailbox lookup, References-only, replies-to-nothing, renamed reply, client-composed headers left alone, and the
conversations endpoint reporting every message exactly once), 1 scheduled-send case per backend, plus unit tests for
every new `ConversationUtils`/`MailSendUtils` export. An unset column reads back as `null` on SQL and `undefined` on
Mongo - shared assertions use `?? undefined`.

## 2026-09-16 — Rate limiting: only four endpoints have any, and an explicit limit beats the authenticated tier

JP: "rate-limit delays while simply navigating - clicking between two folders or settings pages a second apart".
Driven with a real browser against the compiled server (headless Chromium, `jwt` cookie, every `/api` response
logged) plus authenticated API bursts.

- **What is actually rate limited in this library**: `GET /mail/directory` and `/mail/directory/contacts`
  (`@RateLimit({perUser, 120/60s})` each), `GET /mail/mailboxes/lookup-by-email` (30/60s), `GET /mail/mailboxes/
  :id/keys/lookup` and the public key-discovery endpoint (`@RateLimit()` with no numbers). **Nothing else.** Measured:
  300 rapid `GET /mail/folders` and 300 `GET /mail/messages` as an authenticated user - no 429. So folder/settings
  navigation cannot hit a limit in this package; what it *does* do is a full document load per click that refetches
  branding, setup, mailboxes, folders, labels (twice), keyvault and conversations (twice) - ~9 API calls per click,
  which is the skeleton/stall JP sees. Reported to web-client; not this repo's to fix.
- **Measured 429s** (authenticated admin, `Authorization: Bearer`): `/mail/directory` 429s on request **#121**,
  `lookup-by-email` on **#31**. Both are the decorator's own numbers, *not* the server's `rateLimit.authenticated`
  tier (10 000/300s): `TieredRateLimiter.checkAndIncrement()` merges `{...anonymous, ...authenticated, ...config}`
  with the decorator's `config` **last**, so an explicit `@RateLimit({maxAttempts})` always wins over the tier. That
  is intended (a per-endpoint limit should be able to be stricter) and already has a test asserting it - it just
  means these constants are the ceiling interactive use runs into, which the doc comments now say.
- **Raised**: `DIRECTORY_MAX_ATTEMPTS` 120 -> 600/60s, `LOOKUP_MAX_ATTEMPTS` 30 -> 300/60s.
  `fetchRecipientSuggestions()` asks *both* directory endpoints per pause in typing at a 150 ms debounce, so ~20 s of
  composing hit 120; the failure is swallowed by `Promise.allSettled` and shows as suggestions that silently stop.
  600/min is 10/s sustained per caller per endpoint. `@RateLimit()`-with-no-numbers endpoints are left alone - they
  correctly take the deployment's anonymous or authenticated tier.
- **Not fixed here (service-core)**: a 429 from `RateLimiter.enforceLimit()` carries no `Retry-After` and no
  `RateLimit-*` headers (verified on the wire), so a client cannot back off. Worth adding in
  `@rapidrest/service-core`; nothing in this repo can add them.

Verification for both entries: `yarn tsc --noEmit`, `yarn lint`, `yarn build` clean. Full `yarn vitest run --coverage`:
256 files / 5143 tests passed, coverage 100 / 96.84 / 100 / 100. Flake worth knowing about: every
`test/routes/mongo/*.test.ts` starts its own `MongoMemoryServer` on the **same hardcoded port 9999** (54 files), so
under heavy machine load (other repos' suites running at the same time) one file's `mongod.stop()` can take the
instance out from under another worker and a handful of files fail together with `MongoNetworkError: read
ECONNRESET`, a different set each run, with zero assertion failures. Re-running those files alone passes. Not caused
by anything in this change; worth giving each file its own port one day.

## 2026-09-19 — Mailbox policy: `defaults` so an admin can reset a field to the deployed config

- Ask (JP): settings editable in the admin console but sourced from `config.ts` first get a "reset" back to the config
  value, so a newly deployed config can be taken without retyping it. `MailboxPolicy` is the only such setting in this
  package (`system:plugins:*` are read-only config, retention/encryption policy/branding have no config source; the
  server's own `PluginStateStore` seeds default plugins, which is a different, per-package thing not covered here).
- `BaseMailboxPolicyRoute` `GET`/`PUT` return `{ ...values, defaults }` (`MailboxPolicyResponse`), `defaults` being
  `this.seed()` - the live config, read per request, not the row. **Deliberately not** "reset = clear the field on the
  row so it falls back to config live": that would make a reset field silently track config forever (an admin could no
  longer tell an override from a default), and no other write path clears a field today. Reset is therefore a plain `PUT` of the default value (same validation,
  same audit entry), which needs no new endpoint or migration.
- `findOrSeedMailboxPolicy()`'s datastore-failure fallback still returns config for `get()`, and `defaults` is the same
  object then, so a console reading during an outage shows nothing to reset.
- Tests: `systemSettingsSuite.ts` (runs on both Mongo and SQL) - `defaults` before anything is saved, after edits, and a
  reset by `PUT`. `tsc --noEmit`/`eslint` clean on the changed files.

## 2026-09-20 — Self-service mailbox creation never worked: wrong auth-server alias endpoint and response field

- Symptom (verified live by JP, with real accounts that all have a `name` alias): the web client showed "No mailbox
  available - ask an administrator" for everyone. Root cause was in `BaseMailboxRoute.fetchNameAliases()` (used by
  `autoProvision()` and by the non-trusted branches of `create()`/`validateAliasChange()`/the primary-address change),
  which had been written against a made-up contract and only ever tested against a `fetch` mock of the same made-up contract:
  1. It called `GET {auth}/api/aliases/me?type=name`. auth-server has no such list endpoint: `GET /aliases/:id` reads `me` as
     the caller's *uid* (`ModelRoute.doFindById`), which is never an alias id, so it is a 404 (`api-010`) for every caller, and
     `fetchNameAliases()` turned every non-ok answer into a 502 "Could not reach the identity service...".
  2. It read `entry.value ?? entry.name`; an auth-server `Alias` is `{ uid, alias, type, userUid, verified, version, ... }`.
     Fixing only the URL would have returned `[]` (a 404 "No username is registered").
- Fix: `GET {auth}/api/aliases?type=name` (auth-server's `BaseAliasRoute.find()` forces `userUid` to the caller for a
  non-administrator, and auth-server's own UI lists with `GET /aliases`), keep entries with `type === "name"` and
  `verified !== false`, read `entry.alias`. Non-ok / network error / timeout stay a 502 with the same wording; an empty list
  still ends in the 404 "No username is registered for this account."
- **Not loosened**: `create()`'s non-trusted branch (`assertSelfServiceCreate()`) compares every address to that list via
  `ownsAddress()`, so an account with no username (empty list) is still refused a self-chosen address (403); covered by a new
  case in `mailboxSelfServiceCreateSuite.ts`. There is still no way to *pick* a username through this API: an account with no
  name alias has to register one in auth-server first. A `needs_username`/create-alias flow was considered and deliberately
  dropped - alias creation stays authoritative in auth-server (which also demands a freshly confirmed identity for it,
  `@RequiresElevation(60)`, so a server-to-server call with an ordinary session cookie would be refused anyway).
- **Scoping (follow-up, same day):** `BaseAliasRoute.find()` returns *every* alias to a caller carrying a trusted role (only an elevated
  token has one), so an elevated administrator's cookie listed all users' name aliases, and `autoProvision()` would have offered and
  accepted another user's username. Fixed twice over: (1) `fetchNameAliases(req, user)` now drops every entry whose `userUid` is not the
  caller's (case-insensitive; missing or non-string `userUid` dropped) - the real guard, since it does not depend on auth-server -
  applied in addition to the type/verified filter and **never to `staticAliases`** (dev); the JWTUser is passed through
  `assertSelfServiceCreate()`, `validateAliasChange()` and `validateAddressChange()` too, so `POST /` and the alias/address updates
  are guarded the same way; (2) the request also carries `&userUid=me`. That one is justified from source, not live: `ModelUtils.
  coerceOperand()` turns a plain query value `"me"` into `user.uid` on both the SQL and Mongo query builders, and `RepoUtils.find()` is
  given `options.user` by `ModelRoute.doFind()`, which `BaseAliasRoute.find()` reaches via `super.find()` for a trusted caller (a
  non-trusted caller's `userUid` is overwritten with their own uid anyway). Tests (mongo and sql): a listing mixing another user's,
  no-owner and non-string-owner entries offers only the caller's, for a user and for an administrator; another user's alias in
  `body.alias` is a 400; all-foreign is the usual 404; plain `POST /` at another's username is a 403.
- Tests: `MailboxAutoProvision.test.ts` (mongo and sql) now stub auth-server answering **only** `GET /api/aliases?type=name`
  with real `Alias` records (any other URL, the old `/aliases/me` included, is its 404), so the whole file and the shared
  `mailboxSelfServiceCreateSuite` fail against the old code - plus explicit request-shape, `alias` field, type/verified
  filtering and 404 -> 502 tests.

## 2026-09-20 — Delivery failures were silent: transport diagnostics, a 502 with `details`, and failure notices in the Inbox

Trigger (verified live on JP's host): a reply to an external address was accepted by Postfix and vanished - no error in the UI,
nothing in the inbox. The routing half (Postfix `transport_maps` sending everything to the bridge) is fixed in
`postfix-bridge`; JP's requirement here: **whenever delivery fails there must be a message explaining what happened, with the
underlying MTA/SMTP error.**

- **What `sendmail` can and cannot tell us.** `PostfixSendmailTransport` submits with `sendmail -i -f from to...` via nodemailer's
  `sendmail` transport (`nodemailer/dist/esm/sendmail-transport`). That only *queues* the message: it exits 0 once Postfix has it, so a
  remote server's `554 5.7.1 Recipient address rejected` can only ever arrive **later, as a bounce DSN** (task D below). The
  synchronous failures are local (sendmail missing/EX_USAGE/EX_TEMPFAIL, Postfix refusing the submission) and apply to every
  recipient. nodemailer reports only `Sendmail exited with code N` + `code: "ESENDMAIL"` - it does **not** capture stderr, the exit
  code as a field, or per-recipient SMTP replies - so `captureSendmail()` wraps the `_spawn` hook nodemailer exposes "for mocking
  purposes" (`transport.transporter._spawn`) to listen to the same child's stderr (last 2000 chars) and exit status. That hook is
  private API: without it the transport still returns the nodemailer message/code, just no stderr/exit code (tested).
- **`TransportResult` gained `failures?: TransportFailure[]` and `error?: TransportError`** (both optional; an existing transport
  is unaffected). `TransportFailure = { address, code?, enhancedCode?, response?, command?, stderr?, temporary? }`,
  `TransportError = { message, code?, response?, responseCode?, command?, stderr?, exitCode?, requestId? }`.
  `transportFailuresOf(result, envelopeTo)` (transport/TransportResultUtils.ts) normalizes: one failure per undelivered recipient,
  the transport's own entry if any else one derived from `error` (response = error.response, else first stderr line, else message),
  SMTP/enhanced codes parsed out of the text (`parseSmtpStatus()`, class 4 = temporary, 5 = permanent), everything through
  `cleanDiagnosticText()` (control chars dropped, 2000 chars). Never a body, header or credential. `sendmail` exit codes 69/71-75
  are marked temporary. SES: `err.name` -> `error.code`, `$metadata.httpStatusCode/requestId`, throttling/`$fault: "server"` temporary.
- **Synchronous surface: `MailRelayError extends ApiError`** (transport/TransportResultUtils.ts), thrown by `scanAndRelay()` when
  `accepted` is empty, replacing the old generic 502 "The mail transport rejected this message.". **Status 502, code unchanged
  (`api-500`)** so existing clients keep working; `message` is a sentence ("This message could not be sent: the mail system refused it
  for X. Reason given: 554 5.7.1 ..."), **`details: MailRelayFailureDetails`** = `{ transport, recipients, accepted, rejected,
  failures[], error? }`. `@rapidrest/service-core`'s `Server.serializeError()` spreads the error's own enumerable props, so a subclass field
  reaches the client with no framework change; `ApiError`'s constructor resets the prototype, hence `Object.setPrototypeOf(this,
  MailRelayError.prototype)` in ours (same as `BulkError`). The 5xx is logged at error level by the framework, as any 502 was. The
  message stays in Drafts: `relayClaimed()` -> `releaseClaim()` was already the behavior; now asserted (folder, lease and
  `scheduledSendRelayedAt` cleared, nothing in Sent Items) in `messageSendFailureSuite.ts` on both backends. **No notice for a
  synchronous failure** - the caller is being told directly; "a send that fails after the client went away" cannot be detected in
  the request handler and is not covered separately.
- **Partial rejection is no longer silent.** `scanAndRelay()` treated `accepted.length > 0` as success and dropped `rejected`;
  it now returns `undelivered` (details for the refused recipients) alongside the normal result. `send()` and `ScheduledSendJob`
  file a notice for them and carry on (the message *was* relayed). `sendmail` never produces this (`rejected` is always empty), SES
  is all-or-nothing; it exists for any transport that reports per recipient.
- **Notice generator: `util/DeliveryFailureNoticeUtils.ts`** (`buildDeliveryFailureNotice`, `fileDeliveryFailureNotice`,
  `tryFileDeliveryFailureNotice`, `describeOriginal`, `originalHeaderBlock`, `deliveryFailureKey/Uid`). Built with nodemailer's
  `MimeNode` (`MailComposer` cannot emit `multipart/report`). From = `Mail Delivery System <postmaster@<mailbox domain>>` - the
  identity `BaseMailIngestRoute.applyTransportRules()` already uses for its rejection notices (not `mailer-daemon@`, which nothing
  here does). Headers: `Return-Path: <>`, `Auto-Submitted: auto-replied` (what Postfix puts on its bounces; RFC 3834 also allows
  `auto-generated`), `X-Auto-Response-Suppress: All`, `In-Reply-To`/`References` = the original's Message-ID. Parts: text/plain
  summary (who, when, per-recipient status/SMTP code/server response/command/delivery-agent output, technical details), RFC 3464
  `message/delivery-status` (per-message group + one group per recipient: `Action: failed`, `Status` = enhanced code, else class
  from the SMTP code/`temporary`, else 5.0.0/4.0.0, `Diagnostic-Code: smtp; ...` or `X-RapidMX; ...` when there is no SMTP reply,
  ASCII-only), `text/rfc822-headers` = original's header block **without Bcc**, ASCII-only, 16 KiB (never the body). At most 50
  recipients listed, the rest counted.
- **Where a notice is generated and filed.** *Direct into the Inbox* (not via the ingest queue) for `send()` partial failures and
  `ScheduledSendJob`: those need it immediately, have the message/folder repos and `NotificationUtils` already, and the server wrote
  the message so there is nothing to scan. It creates the `Message` (`importance: high`, unread), bumps the Inbox counters (same
  retry as `ScanQueueJob.bumpFolderCounters()`, duplicated to leave that class alone) and calls
  `NotificationUtils.sendMessage(inbox.uid, ..., "create", message)` like `deliverMessage()`. *Via the ingest queue* for the
  `deliver()` drop (BaseMailIngestRoute has no message/folder repos): an `IngestQueueEntry` with `envelopeFrom: ""`, so
  `ScanQueueJob` files it seconds later like a bounce. `ScheduledSendJob` notifies (a) from `refuse()` and (b) when
  `recordFailedAttempt()` reaches `max_attempts` - and **only after the update that took the message out of the queue succeeded** - but
  **not** when the failure is post-relay (`scheduledSendRelayedAt` set: the message was delivered, only its filing failed).
- **Dedupe key = uid.** `nameBasedUuid("delivery-failure:<mailboxUid>:<key>")`; `fileDeliveryFailureNotice()` skips if a row with
  that uid exists **including soft-deleted** (a notice the user deleted is not resurrected) and re-checks after a failed create (lost
  race). Keys: `scheduled-refused:<uid>:<row version>`, `scheduled-failed:<uid>:<row version>` (the version being transitioned FROM
  is unique per failure, so a message rescheduled and failing again reports again but a retried write does not), `scheduled-partial:<uid>`,
  `send-partial:<uid>`, `dropped:<lowercased Message-ID or sha256(raw)>:<rcpt>` (the ingest entry's uid is the same derivation, so an MTA
  redelivering the same transaction collides).
- **Inbound bounces (D).** A Postfix-format DSN fixture (`test/fixtures/postfixDsn.ts`, hand-written field-for-field from bounce(8):
  `Return-Path: <>`, `From: MAILER-DAEMON@host (Mail Delivery System)`, `Auto-Submitted: auto-replied`, `multipart/report;
  report-type=delivery-status` with notification / `message/delivery-status` (X-Postfix-* fields) / `message/rfc822`) - **no real
  capture existed** in `postfix-bridge` (it has no fixtures). `dsnDeliverySuite.ts` runs it through the real `ScanQueueJob` +
  real `ScanPipeline` on Mongo and SQL: filed in the Inbox, unread, not quarantined, no auto-reply, HTML variant sanitized with the
  diagnostic text intact. Nothing in the pipeline treats a null sender or missing SPF/DKIM as a quarantine reason (the verdict is AV +
  spam score + TransportRule only); **what real rspamd scores a bounce is not verifiable here** (test doubles). One real bug found: a
  bounce's `Message.from.address` was `entry.envelopeFrom` = `""`; `ScanQueueJob.deliverMessage()` now falls back to the `From` header's
  address (`result.fromAddress`) when the envelope sender is null. `BaseMailIngestRoute.deliver()`'s "dropping delivery for unresolvable
  recipient" path now calls `reportUnresolvableRecipient()`: only when the envelope sender is one of our own mailboxes (exact
  primary/alias match - the postfix-bridge hands `deliver()` recipients Postfix already accepted, and locally-submitted mail bypasses
  the `/resolve` check), never for a null sender or an `Auto-Submitted` message, best-effort. Not covered: other silent drops in
  `deliver()` (restricted lists, unverified unsubscribe) - not asked for.
- **Not verified here:** a real Postfix (`sendmail` stderr wording, real bounce DSN, what `smtpd`/milters do to a `<>` bounce on the way to
  the bridge), real rspamd scoring of a bounce, and the web client's rendering of `details` and of a `multipart/report` message.
- Files: `transport/{MailTransport,TransportResultUtils,PostfixSendmailTransport,SesMailTransport}.ts`, `util/{DeliveryFailureNoticeUtils,
  MailSendUtils}.ts`, `routes/{BaseMessageRoute,BaseMailIngestRoute}.ts`, `jobs/{ScheduledSendJob,ScanQueueJob}.ts`. Tests:
  `transport/*.test.ts`, `util/{DeliveryFailureNoticeUtils,MailSendUtils}.test.ts`, `routes/messageSendFailureSuite.ts` (+ mongo/sql
  `MessageSendFailure.test.ts`), `routes/ingestDroppedNoticeSuite.ts` (in both `MailIngestRoute.test.ts`), `jobs/dsnDeliverySuite.ts` (in both
  `ScanQueueJob*.test.ts`), the ScheduledSendJob suites, `fixtures/postfixDsn.ts`, and `testDoubles.ts`'s `RecordingMailTransport`.

## 2026-09-20 (later) — Genuine Postfix bounces replace the hand-written DSN as the primary fixtures; bounce list preview

`@rapidmx/postfix-bridge` captured real bounces from a boky/postfix container (docker lab, `.lab` placeholder domains) into its
`test/fixtures/`; copied here byte-for-byte (verified equal once against the originals) as `test/fixtures/postfixCapturedDsn.ts` -
`DSN_UNKNOWN_RECIPIENT_550`, `DSN_EXPIRED_450`, `DSN_DELAYED_450` (CRLF, exactly what the bridge POSTs to `/internal/mta/deliver`) and
`DSN_ENVELOPE` (`X-Envelope-From` present-but-EMPTY, `X-Envelope-To: alice@owned.lab`). Stored as arrays of lines and rejoined with
CRLF so git's autocrlf can't change them. The hand-written `postfixDsn.ts` stays only for its HTML variant.

- (a) **The route treats the empty `X-Envelope-From` as the null sender.** `deliver()` reads `firstHeader(req, "x-envelope-from") ?? ""`;
  through the real HTTP server an empty header arrives as `""` and a missing one as `undefined` -> `""`: both give a 202, `queued: true`
  and an `IngestQueueEntry` with `envelopeFrom: ""` (not the `From:` header). Nothing needed fixing (`ingestBounceSuite`, both
  backends). A bounce to a non-existent local address is dropped without a notice (a bounce is never bounced).
- (b) **The `Action: delayed` notice is filed in the Inbox like the others**, unread, from `MAILER-DAEMON@mail.owned.lab`, subject
  "Delayed Mail (still being retried)", `importance` normal. Nothing in our generator changed: it is Postfix's own text ("THIS IS A
  WARNING ONLY. YOU DO NOT NEED TO RESEND YOUR MESSAGE", `Will-Retry-Until`), stored intact.
- (c) **Sanitization is fine; the list *preview* was not.** Real notices are text-only (no `sanitizedHtmlBlobKey`; nothing is rewritten, the
  wrapped diagnostic lines survive verbatim). But `bodyPreview` is the first 500 chars of `parsed.text`, and mailparser appends the
  `message/delivery-status` part to `parsed.text` after the notification: on the captures the server's `said: 550 5.1.1 ...` starts at
  char 433/428/621 of the notification, so the preview cut the reason off (delayed: never reached it). `ScanPipeline.derivePreview()` now
  previews a `multipart/report; report-type=delivery-status` message by its report - `<Final-Recipient>: <Action> (<Status>) -
  <Diagnostic-Code>` per recipient, `; `-joined, folded fields unfolded - and falls back to the text when the report names nobody. Only
  DSNs are affected (checked via the parsed `Content-Type`: `report-type=disposition-notification` or a quoted report inside an ordinary
  message keep the old preview). `MailFilterRule` body conditions see the new preview for a DSN. The notice this server generates is
  the same shape, so it gets the same preview.
- Also confirmed on the real captures: not quarantined (nothing in the verdict looks at a null sender or SPF/DKIM), no auto-reply sent,
  `Message.from.address` = `MAILER-DAEMON@mail.owned.lab` (the earlier null-envelope fallback), stored source byte-identical to the input.

## 2026-09-20 (later) — Folder counts are derived from the messages, and published when they change

Trigger (measured on JP's live Mongo): a folder's stored `unreadCount`/`totalCount` were **write-only**. Only `ScanQueueJob.bumpFolderCounters()` and
`DeliveryFailureNoticeUtils.bumpInboxCounters()` (and, for `totalCount` only, `MailboxImportJob`) ever wrote them, always as `+1`. Nothing
decremented or recomputed them on mark read/unread, move, delete/restore, purge, retention, send (Sent Items/Outbox), or draft create/delete. Live
mailbox: inbox stored 7/7 vs actual 0 unread of 3; sent_items stored 0/0 vs 0/7; deleted_items 0/0 vs 0/4. The web client's badge was wrong at all
times and never changed. JP's standing rule: pre-release, no migrations - existing rows must simply become right.

- **Design: the messages are the source of truth; counts are derived on read** (`util/FolderCountUtils.ts`). `BaseFolderRoute.find/findById` (and
  the `update`/`updateBulk`/`updateProperty` responses) replace `unreadCount`/`totalCount` with `countMessagesByFolder()`'s answer: ONE grouped
  query for the whole request (Mongo `aggregate` `$match`+`$group` on `folderUid`; SQL `GROUP BY folderUid` via the query builder), chunked at 500
  uids only to bound a SQL `IN`. Tested: 1 grouped query for 1, 3 and 25 folders on both backends, and for `GET /:id`. Not N queries, not a stored
  counter: there is no second source of truth that can disagree on a read.
- **What counts = exactly what the message list shows.** The list is `RepoUtils.find()` scoped to `folderUid`, whose only implicit exclusion is
  `deleted: false` (a soft-deleted row); drafts/Outbox/scheduled rows, released quarantine mail etc. are all listed, so all count. Unread =
  `flags.read !== true` (unset, `false` or a missing `flags` are unread - tested with a row whose `flags` is `{}`). New inbound mail is filed with
  `flags.read = filterResult.markRead` (explicit `false` unless a rule marks it read); the derivation doesn't depend on that. Non-message folder
  types (Calendar/Contacts/Tasks/Notes) simply derive 0/0 (no messages), which is what they always stored.
- **`flags.read`, NOT the `read` mirror.** `Message.read` is indexed for the Unread filter, but (see the 2026-09-15 mirror entry) the ActiveSync/MAPI
  plugins write `flags` through their own repos and never maintain it, and it is `NULL` on rows older than it. Counting on the mirror would make the
  badge wrong exactly when a device marks mail read. Mongo reads `$flags.read`; SQL has `flags` as `simple-json` text, so it matches
  `flags LIKE '%"read":true%'` (`MessageFlags` holds only booleans, and `JSON.stringify` writes no spaces, so this can't match anything but the key).
  Consequence, unchanged and documented: `?filter=unread` (the mirror) can still disagree with the badge for a row written by a plugin that skipped
  `syncMessageListFields()` - the badge is the one that's right.
- **Indexes.** `message_folder` (`folderUid`) exists on both. Added `MessageMongo` `message_folder_deleted_flags_read` `[folderUid, deleted, flags.read]`
  - the group reads only those three fields, so it's a covered index scan (a dotted key works with `MongoSchemaSync`, which builds the key from the
  column name; SQL can't cover JSON text) - and `MessageSQL` `message_folder_deleted` `[folderUid, deleted]`.
- **The stored fields are now a best-effort cache, and reads never trust them.** Written by `refreshFolderCounts()` (version-checked `update` with
  `skipPush: true`, so it doesn't also publish the whole folder row; on a version race it recomputes the counts too, up to 3 attempts, then gives
  up silently) and by `healStoredFolderCounts()` when a read finds a stored value that disagrees (so JP's wrong rows repair themselves on the first
  `GET /folders`). `SERVER_MANAGED_FOLDER_FIELDS` still lists both (client `PUT` drops them, `PUT /:id/unreadCount` is 403, `POST` zeroes them) - tested.
  The dead `+1` increments were replaced, not just removed: `bumpFolderCounters`/`bumpInboxCounters`/`MailboxImportJob`'s `totalCount + n` now call
  `refreshFolderCounts(ctx, [folderUid], { bumpSyncKey: true })` (`syncKeyVersion` is still bumped on every add, as before - nothing in this
  workspace reads it, but it is documented as the EAS/ICS watermark). **Behavior change:** a failing folder-row write can no longer fail a delivery
  (it used to throw after the message was filed and fail the queue entry for retry); four tests that used that failure as their injection point
  (delivery receipt / auto-reply "on retry") now fail the job's own `create` notice instead, and the three "counter bump retry" tests were rewritten
  around the refresh.
- **Who reads the stored fields (grepped across `d:\github\rapidmx\*`).** Only `@rapidmx/mapi-plugin` in production code: `rop/FolderTarget.ts`
  `resolveFolderInfo()` reads `folder.unreadCount/totalCount` straight from `folderRepo.findOne()` (via `PropertyResolvers`), so it does not go through
  the route classes. `@rapidmx/activesync-plugin`, `autodiscover` and `server` do not read them (activesync only seeds them to 0 in tests). Resolution:
  kept them as a cache refreshed at every point this library changes a folder's contents, repaired by any `GET /folders`, and exported
  `refreshFolderCounts()`/`countMessagesByFolder()`/`coalesceFolderCounts()`/`notifyFolderCounts()` from the root for a plugin that writes messages through
  its own repos (mapi/activesync flag writes, moves and deletes do NOT run this library's routes, so until they call `refreshFolderCounts()` the cache and
  the event lag for those writes; the REST reads are right regardless). Not changed in those repos (read-only here). The ideal follow-up is mapi resolving
  counts with `countMessagesByFolder()`.
- **Live event** (the contract the web client codes against):
  `{ type: <FolderClass.name: "FolderMongo" | "FolderSQL">, action: "update", data: { uid, mailboxUid, unreadCount, totalCount } }` via
  `notificationUtils.sendMessage([folder.uid, folder.mailboxUid], type, "update", data)`. **Channels: both the folder's uid and its mailbox's uid.**
  Reason: today's folder-level events are split (`BaseFolderRoute.create` publishes on the *mailbox* channel; `RepoUtils`' own record events on the
  *folder's*), and `MailPushRoute` subscribes per bare uid with no fan-out from a mailbox to its folders; the web client subscribes to every folder
  channel but caps channels (`PUSH_MAX_CHANNELS`) and lists mailboxes last, so publishing to both means the badge updates whichever it kept. A client
  subscribed to both hears it twice (idempotent: `data.uid` names the folder). `data` is exactly those four fields, not the row. Computed with the
  same derivation as the read, always published for the affected folders (not gated on "changed" - the stored value may be stale), best-effort and
  fire-and-forget (`refreshFolderCounts()` catches everything; a publish failure never fails the mutation). Events from overlapping writes to one
  folder are not ordered; the client's poll/reconnect re-read (`GET /folders`) is the backstop.
- **Where it fires.** `BaseMessageRoute` (through `notifyFolders()`): `create` (single or array), `update` (only when `folderUid` or `flags.read` changed -
  `deleted` is not client-writable), `delete` (soft delete or purge of a live row; a soft-deleted row is a 404 and publishes nothing), `truncate`, `archive`,
  `send` (Drafts -> Outbox -> Sent Items, scheduled Drafts -> Outbox) and `updateBulk`. **Coalescing:** `coalesceFolderCounts()` uses an `AsyncLocalStorage`
  scope (per request, so concurrent requests can't leak into each other) that collects folder uids and publishes once per folder when the scope ends -
  `finally`, so a bulk that failed part-way still publishes for what it applied. `send()` was split into `send()` (scope) + `relaySend()` (the old body).
  Jobs (direct calls to `refreshFolderCounts`): `ScanQueueJob` (delivery, rule copies, recall delete), `ScheduledSendJob` (Outbox -> Sent),
  `MailboxImportJob` (once per import), `RetentionEnforcementJob` (once per folder per run, live rows only; needs the optional `folderClass` +
  `NotificationUtils` injection), `DeliveryFailureNoticeUtils` (Inbox). Not covered: `ErasureExecutionJob` (erases a whole mailbox - its folders go with
  it), a *restore* (this library has no route that un-deletes a message, so a restore done elsewhere shows on the next read but is not published), and
  plugin-side writes (above).
- **`BaseFolderRoute` needs `messageClass`** (a new optional protected field, set by `FolderRouteMongo/SQL`; unset = stored values, so a downstream
  subclass keeps working unchanged). `update`/`updateBulk`/`updateProperty` are overridden **without** decorators (like the existing `updateProperty`) so
  `CRUDRoute`'s `@Validate`/`@Transactional` metadata still applies; `findById` re-declares `@Get("/:id")` like `find` does.
- Tests: `test/routes/folderCountsSuite.ts` (+ `{mongo,sql}/FolderCounts.test.ts`: derived list/by-id/filtered/paged, wrong stored counters incl. negative,
  cache repair, PUT responses, client counts ignored, bounded queries, list == count, mark read/unread, no event for an unrelated update, bulk once per
  folder, part-way bulk, move, archive, delete/restore/purge, truncate, draft create/delete/bulk, send/failed send/scheduled send, event payloads and
  channels), `test/util/FolderCountUtils.test.ts` (batching, string sums, lost version race recomputes, give-up, missing folder, failures logged,
  coalescing), plus event assertions in the ScanQueueJob (ingest, recall, refresh conflict), ScheduledSendJob, MailboxImportJob and
  RetentionEnforcementJob suites.
- Not verified here: the web client actually rendering the event, mapi's tables with real Outlook, and behavior on MySQL/PostgreSQL (the SQL suite is
  SQLite; the query uses only portable `COUNT`/`SUM(CASE)`/`LIKE` and driver-string sums are coerced with `Number()`).

## 2026-09-21 — Appearance preferences (per user) and background send (`{ background: true }`)

Not committed. Batch of web-client UX work; this repo's half. JP's principle: the app feels instantaneous - user actions return at once, work continues in the
background, failures surface as notifications. The contracts below are what the web-client agents code against; the README has them in full.

### A. Appearance preferences (`BaseAppearanceRoute`, `util/AppearanceUtils.ts`)

- **Model:** `AppearancePreferencesMongo/SQL` (`models/types.ts` `AppearancePreferences`), one row per **user**, uid = `nameBasedUuid("appearance-preferences:<userUid>")` (so two first
  writes at once collide on the uid instead of making two rows; `userUid` also has a unique index), columns `mode`, `colors` and `background` (JSON: `simple-json` on SQL, sub-documents on
  Mongo) and route-managed `backgroundContentType`. Deny-all class ACL like every route-managed entity; the routes read and write with `ignoreACL` and a row can only be named through the
  JWT's own `uid`, so a trusted role reads and writes only its own (tested: an admin's `GET` is its own defaults, its `PUT` does not touch another user's row, `?userUid=` is ignored).
  The wire object has `version: 1` (the shape's version) which is **not** the entity's optimistic-lock `version` - `toPublicAppearance()` maps one to the other.
- **JP removed `invertDarkMessages` (mid-task): HTML mail is always rendered as authored.** It is not in the model, the validation or the defaults; a `PUT` that still sends it is a 400 naming it
  like any unknown key (tested).
- **Contract decisions (mine, where the brief left room):** `updatedAt` of a user with no row is the epoch (so any real save is newer). `PUT` accepts `version` (must be 1) and `updatedAt`
  so a client can send back what it read. `colors` merges per key, `null` clears one / all; `background` merges per key; `background: null` is a 400 (use `DELETE /background` or
  `kind: "none"`); `background.imageVersion` in a `PUT` must equal the stored one (400) - a client cannot name an image. `kind: "image"` without an upload and `kind: "color"` without a colour
  are 400s. Switching `kind` away from `"image"` **keeps** the blob and `imageVersion` (switching back needs no re-upload); only `DELETE /background` removes it. An empty `PUT {}` writes nothing
  and publishes nothing. Colours are stored lowercase. Rate limits (`@RateLimit({perUser})`): `PUT` 600/min, upload 30/min, `DELETE` 60/min; `GET`s none.
- **Upload:** `Content-Type` must be `image/png|jpeg|webp|avif` (else **415**), the bytes are sniffed (`sniffImageType()`: PNG, JPEG, WebP = RIFF...WEBP, AVIF = an `ftyp` box naming `avif`/`avis` as
  major or compatible brand) and the sniffed type is what is stored and served - a JPEG sent as `image/png` is stored as `image/jpeg`; SVG, GIF, HEIC and anything else are **415** whatever the
  header says. Empty body 400. Above `mail:preferences:background_max_bytes` (default 8 MiB, `Number()`-coerced) **413** from the route (the server's `max_body_size` is 100 MiB, the framework's
  own default 10 MiB, so the route's is the effective one). Stored as sent (no re-encode, nothing stripped) at `appearance/<userUid>/<uuid>`; the previous blob is deleted **after** the row
  points at the new one (a crash in between leaks a blob, never a dangling reference); a failed row write deletes the new blob. Two uploads at once: the version-checked write retries from a fresh
  read (3 attempts), the loser's blob is deleted as "previous" - tested (one row, one blob).
- **Serve:** `GET /background/:version` 404s for a stale version and for anyone else (the row is looked up by the caller's uid, so another user's image cannot even be addressed); headers as the
  brief (`private, max-age=31536000, immutable`, `nosniff`, `inline`, `default-src 'none'; sandbox`) plus `Content-Length`. Reads the whole blob (8 MiB cap) rather than streaming.
- **Live event:** `NotificationUtils.sendMessage(user.uid, <entity class name>, "update", <public prefs>)` - the type is `AppearancePreferencesMongo`/`AppearancePreferencesSQL` (the brief's
  `AppearancePreferences*`), match `/^AppearancePreferences/`. After a `PUT` that changed something, an upload and a `DELETE`; best-effort. The writes pass `skipPush: true` so `RepoUtils` does
  not also publish the whole entity.
- **`fetchAppearanceForSSR()`** (exported from the root; used by the server's `wwwRoute.fetchProps`): one `findOne`, `undefined` for no row / no uid, never throws (debug log).
  **Caveat, not fixed:** `@rapidrest/react`'s `ReactRoute` caches the rendered HTML in Redis in production for 60 s **per user** (`hashRequest()`: path + query + `userUid`), so the `appearance` prop can
  be up to a minute stale after a change - the client must still apply the live event / its own copy after hydration. `cacheKeyExtras()` is synchronous and cannot read the row.
- Files: `models/{mongo,sql}/AppearancePreferences*.ts`, `models/types.ts`, `routes/BaseAppearanceRoute.ts`, `routes/{mongo,sql}/AppearanceRoute*.ts`, `util/AppearanceUtils.ts`. Tests:
  `test/routes/appearanceSuite.ts` (+ `{mongo,sql}/AppearanceRoute.test.ts`, real HTTP: 65 tests each incl. the 26-row validation table, all four image types, size limit at and above the boundary,
  SVG/GIF/type-lie/empty refusals, replace/delete blob bookkeeping, ownership 404 for another user and an admin, concurrent writes and uploads, events), `test/util/AppearanceUtils.test.ts`.

### B. Background send (`BaseMessageRoute.send`, `ScheduledSendJob`)

- **Design: the message is queued as an ordinary *due* message in Outbox and the existing `ScheduledSendJob` relays it; the route just kicks it.** Not a second relay implementation and not the sync
  path detached: `relaySend(background=true)` does the cheap checks (unchanged code, same order), persists the thread headers as before, moves the draft into Outbox with `scheduledSendTime = now`
  (no lease - the job leases when it claims), `notifyFolders`, answers `202 { status: "queued", message }` and only then (`setImmediate`, so the CPU-bound scan starts after the response is on its
  way) calls `ScheduledSendJob.enqueue(uid)` on the job instance of this process (`objectFactory.getInstance(sendJobClass)` = the one the background service manager made, else one created under the
  name `background-send`). Crash safety is therefore free: at every instant the message is either due in Outbox (the job's next `run()`, and `start()` now sweeps at once, finish it), or claimed with a
  lease (lapses -> due again), or relayed-and-marked (`scheduledSendRelayedAt`, filing only). Never-twice = the version-checked claim + `scheduledSendRelayedAt`, both pre-existing and now covered
  by tests for: claim lost to another process, crash before the claim / after the claim before the relay / after the relay before the filing, kick + scheduled run + repeated requests at once.
- **Job additions** (`jobs/ScheduledSendJob.ts`): `enqueue(uid)` (looks the row up, skips it unless it has a due `scheduledSendTime`, so a message cancelled since is untouched), a bounded pool
  (`mail:jobs:scheduled_send:concurrency`, default 4; `run()` still goes one at a time, oldest first, but through the same slots and per-uid de-duplication), `whenIdle()`, `start()` sweep, `stop()` drains
  (`drain_ms` 15 s) and then refuses new work. **`ScheduledSendJobSQL` runs one relay at a time on SQLite** (`maxParallel()` checks `datastores:sql:type`): two overlapping relays on the single
  better-sqlite3 connection failed each other's transactions ("cannot start a transaction within a transaction") *including the relayed-marker write after the transport had accepted* - found by the pool
  test; irrelevant for Postgres/MySQL. (For the same reason the SQL route tests fire requests one after another; concurrent duplicate requests are tested on Mongo, and claim-loss on both.)
- **Events** (`SendEventData`, exported): `{ type: <MessageMongo|MessageSQL>, action: "send-succeeded"|"send-retrying"|"send-failed", data: { uid, mailboxUid, subject, recipients[], attempt,
  nextAttemptAt?, error?: { message, details? } } }` via one `sendMessage([mailboxUid, outboxUid(, sentUid)], ...)`. Fired by the job for **every** message it relays (scheduled sends too - a scheduled
  send arriving is worth a toast; the web client can filter on `uid`). `attempt` = attempts so far + 1 = the one the event is about. A post-relay filing failure (mail system took it, Sent Items could
  not be written) is `send-retrying` with the message "The message was sent, but could not be filed in Sent Items: ..." and is never relayed again.
- **Failure semantics chosen: a failed message STAYS IN OUTBOX marked failed** (`scheduledSendError` set, `scheduledSendTime` null, no lease) - that is exactly what the job already did on give-up /
  refuse, the Outbox list then shows it, and the notice is still filed once (`scheduled-failed`/`scheduled-refused` keys). It does **not** go back to Drafts (the sync path does, because there the client is
  being told directly). Retrying: `POST send { background: true }` on it queues it afresh (attempts/error cleared); moving it to Drafts still works. `scheduledSendAttempts` is reset to null when it gives
  up (existing behaviour), the count is in the error text ("Gave up after N attempts").
- **Permanent failures are final at once** (`isPermanentRelayFailure()` in `transport/TransportResultUtils.ts`): a 422 spam/malware verdict, or a `MailRelayError` whose failures are all
  `temporary === false` (SMTP 5xx). Anything else retries up to `max_attempts` with the existing `attempts x retry_backoff_ms` backoff. This closes the "left alone" note in the server's 2026-09-20 (QA)
  entry (a 554 used to take 12 minutes to reach the Inbox). Two existing tests changed for it (a 554 recipient is no longer "attempt 1, retried"). With `max_attempts` reached at the same time the old
  "Gave up after N attempts" wording is kept.
- **Idempotency** (route): already in Outbox and (leased, or due, or waiting out a retry backoff) -> same 202 with the current copy; two racing requests -> the loser's version conflict is re-read and
  answers the winner's 202; in Outbox with `scheduledSendError` and nothing due/leased -> retry (above); a future user-chosen `scheduledSendTime` in Outbox stays 409; relayed / Sent Items 409. `background`
  not a boolean -> 400; a route without `sendJobClass` -> 501. `background: true` with a future `scheduledSendTime` -> the same 202, message waits in Outbox.
- **The job now relays what an immediate send relays** - a gap found while building this: `send()` added `Disposition-Notification-To` (when a receipt is requested; the mailbox default
  `alwaysRequestReceiptInternal` is **true**, so any send to an own-domain recipient) and `RapidMX-Key`, and filed `receiptStatus`/`encrypted`/`inReplyTo`/`references`; `ScheduledSendJob` did none of it.
  Both now use `prepareOutboundMime()` / `seedReceiptStatus()` (`util/MailSendUtils.ts`); the job needs `domainClass` (set by the Mongo/SQL subclasses; the SQL job test's connection now loads
  `DomainSQL`) and `@Inject("DnsResolver")`. Behaviour change for scheduled sends: their Sent copy now tracks receipts, and `Disposition-Notification-To` goes out when the mailbox asks for it.
- **Measurements** (real HTTP, in-memory Mongo/SQLite, fake scanners/transport, this machine): background 202 median 13 ms / p95 16 ms (Mongo), 31 / 39 ms (SQL); the same request without
  `background` 17 / 18 ms and 21 / 28 ms - i.e. with instant fakes there is little to win; the win is what the fakes hide. **What dominates the real seconds** (micro-benchmarks of `scanAndRelay` with
  fake providers, 5 runs, median): small mail 3 ms; 200 KB HTML mail **93 ms** (sanitize-html 46 + html-to-text 42 + mailparser 3); mail with a 5 MB attachment **427 ms** (mailparser ~266 ms of it, the
  base64 decode); 25 MB **2.1 s** - all CPU on the one main thread (blocking every other request while it runs), before the real rspamd HTTP call, ClamAV `INSTREAM` (the raw message once **and each
  attachment again**) and the `sendmail` spawn (~49 ms for a trivial child process here). The 202 does none of it inline.
  **Low-hanging fruit taken:** `scanAndRelay()` now passes `ScanPipeline.run(..., { skipPreview: true })` - the send path never used `bodyPreview` and deriving it (`convert()` of the whole HTML) was
  ~45% of the pipeline for HTML mail. **Not done** (would change behaviour or is a larger change): scanning attachments once (the raw scan already covers them), moving sanitize/parse to a worker thread,
  skipping the scan for internal-only recipients, streaming instead of buffering 25 MB.
- Files: `routes/BaseMessageRoute.ts` (`send()` gained `@Response res` before the user; `relaySend(background)`; `QueuedSend`; the 501/400 guards), `routes/{mongo,sql}/MessageRoute*.ts` (`sendJobClass`),
  `jobs/ScheduledSendJob.ts`, `jobs/{mongo,sql}/ScheduledSendJob*.ts`, `util/MailSendUtils.ts`, `transport/TransportResultUtils.ts`, `scan/ScanPipeline.ts`. Tests: `test/jobs/backgroundSendSuite.ts`
  (in both `ScheduledSendJob*.test.ts`: 20 tests each), `test/routes/backgroundSendRouteSuite.ts` (+ `{mongo,sql}/MessageBackgroundSend.test.ts`, real HTTP: 14 each), `RecordingMailTransport` gained
  `temp-fail@example.com` (4xx), `gate`, `inFlight`/`maxInFlight`; unit tests for `isPermanentRelayFailure`, `prepareOutboundMime`, `seedReceiptStatus`, `skipPreview`.

### C. `GET /system/encryption-policy`

Verified, no code change: any signed-in user (a token with no roles and no `elevated`, an ordinary one, an admin) gets 200 with the all-`"optional"` defaults when no row exists, and the `GET` creates no
row; unauthenticated is still 403. Test added to both `EncryptionPolicyRoute.test.ts` files.

### Authorization note (for the privacy work running alongside)

Appearance: owner-only by construction (the caller's own uid is the only row any route can address; no `isTrusted`/`ignoreACL`-for-others path). Background send: it reuses `relaySend()`'s existing checks unchanged and adds none of its own - the caller needs UPDATE on the message's folder via `aclUtils.hasPermission()` (whose framework-level trusted-role bypass is what a privacy change would have to close at that call site), and `assertSenderAllowed()` only ties the *From* to the message's own mailbox's addresses, not the caller to the mailbox. `isTrusted(user)` still exempts a caller from "only a Drafts message can be sent". `util/MailAccessUtils.ts` did not exist when this was written, so nothing here uses it; the job (`ScheduledSendJob`) has no caller identity at all - it relays whatever is due in the mailbox's own Outbox.

### Not verified here

A real Postfix/rspamd/ClamAV (all timings above are with fakes), the web client's handling of the 202/events, behaviour on MySQL/PostgreSQL (the SQL suites are SQLite; the pool runs relays in
parallel there by design - untested against a real pooled driver), a multi-replica run (claims are version-checked, so replicas are safe by construction but were not run).

## 2026-09-21 — PRIVACY: no role reads another user's mail (an admin sees their own mailbox and shared ones, nothing else)

Uncommitted, no version bump, no migrations. JP called it "a big one": any administrator holding an elevated token (roles `['admin']`) could list every mailbox and read every folder/message/attachment
through the ordinary mail API, and the web client's mailbox switcher and Settings dropdown listed everybody. Evidence from the live host: elevated admin -> `GET /mail/mailboxes` = every mailbox,
`GET /mail/messages?folderUid=<other's inbox>` = 200 with the message; the same user non-elevated (roles empty) = nothing. Root cause: `ACLUtils.hasPermission()` (service-core, read-only) returns `true` for a
trusted role (`UserUtils.hasRoles(user, trustedRoles, aclUid)`), and `RepoUtils` (every `{ user }` call without `ignoreACL`), `BaseACLRoute` and `BasePushRoute` (subscribe/publish) all go through it;
restapi's own routes leaned on it (and added `isTrusted` branches that listed "every mailbox unfiltered").

### Policy as implemented

- **P1** Anything scoped to a mailbox needs: the caller owns it (the mailbox's ACL carries the owner's `FULL`, written on create and on every owner change) OR holds an explicit ACL record on it (folders inherit
  from their mailbox by `parentUid`). A trusted role, an elevated token, `ignoreACL` and `isTrusted()` never widen that. Impersonation needs no code: the token is the target's own identity (no trusted role,
  not elevated) and nothing keys off the impersonator (grep: no `impersonat` anywhere in restapi src). Read-shaped denials are 404/empty like a record that doesn't exist; mailbox-address lookups
  (key lookup/trust/resolve, key vault, escrow info, sharing) answer 403 for "missing" too, so no route tells which addresses have a mailbox.
- **ONE helper**, `util/MailAccessUtils.ts` (exported from `util/index.ts`): `hasMailAccess(aclUtils, trustedRoles, user, uid|acl, action)`, `assertMailAccess()`, `stripTrustedRoles(user, trustedRoles)` (also
  drops org-prefixed `<org>.<role>` and `elevated`), `isTrustedUser()`, `ADMIN_SCOPE`/`isAdminScope()`/`assertAdminScope()` (401 / 403 `api-103` trusted role / 403 `api-104` elevation). `hasMailAccess` =
  `aclUtils.hasPermission(stripTrustedRoles(user), uid, action)`: verified in ACLUtils/RepoUtils that a role-less copy takes the ordinary owner/delegate path (`getRecord`, parents, wildcard/role records)
  with no superuser shortcut. `BaseScopedChildRoute`, `BaseFolderRoute`, `BaseMailboxRoute` have `hasMailAccess()` (+ `mailUser()` = stripped user) methods; the inherited `CRUDRoute` handlers
  (`findById`/`update`/`updateBulk`/`updateProperty`/`delete`/`truncate` of Folder and Mailbox) are handed `mailUser(user)`. Mailbox `find`/`count` use `accessibleMailboxUids()` (candidates from
  `findAccessibleMailboxUids(mailUser)`, then READ-checked) for EVERYONE.
- **Ownerless (org/shared) mailboxes:** an administrator who creates one gets an explicit `FULL` record (`grantCreator()`; `details.sharedWithCreator` on `mailbox.create`); existing ones
  (`hello@`) are invisible until the administrator adds themselves through Sharing (`PUT /mail/mailboxes/:id/access/:uid`, audited `mailbox_access.grant`).
- **P2 admin scope** `?scope=admin` (trusted + elevated): `GET`/`HEAD /mail/mailboxes`, `GET`/`HEAD /mail/mailboxes/:id` -> `ADMIN_METADATA_FIELDS` + `shared`; query keys limited to those fields + `limit`/`page`/
  `sort` (a sort/filter by a hidden field is dropped); audit `mailbox.admin-list` (`targetUid: "*"`, `details.count/query`) / `mailbox.admin-read`. Quarantine and ingest queue (`adminScope` flag on
  `BaseScopedChildRoute`, `auditLogClass` on the four concrete routes): `?scope=admin` list/count/read/exists, and their trusted-only writes (create/update=release/delete/truncate) need trusted + elevated,
  audited `mail_queue.admin_access` (`details.operation`). Admin management of a mailbox with no grant (`isAdminOnly()`): `validateUpdate()`/`update()` reduce the patch to `ADMIN_MANAGED_FIELDS`
  (owner, addresses, displayName, timezone, quota, resource flags, escrow scope), `updateProperty` of another field is 403, the answer is `toAdminMetadata()`, audits `mailbox.admin-update`
  (`details.fields`) / `mailbox.admin-delete`. Sharing (`BaseMailboxAccessRoute`): owner/manager as of right; an administrator (trusted + elevated) may list (audited `mailbox_access.admin-list`),
  revoke any member, and grant on an OWNERLESS mailbox (themselves included); granting on an owned mailbox is 403 ("the owner's to give, or the administrator's to do by impersonating"). This is the
  decision for "an admin granting themselves access through /api/acls": the generic `/api/acls` route (server) never lets a trusted role touch a mail ACL at all (see server NOTES), so Sharing is the only door.
- **P4 push:** `MailPushRoute` overrides `connect()` and `send()` to hand `BasePushRoute` `stripTrustedRoles(user)`; SUBSCRIBE (initial, reconnect re-check, later frames) and publish then go through
  the ordinary ACL resolution. Tests: `test/push/MailPushAccess.test.ts` (real ACL store, faked `redis`): owner/read delegate/impersonation get folder+mailbox, an elevated admin gets nothing (not even another
  user's uid or `Mailbox`), an admin with a delegate grant gets it; `send` is 403 for the admin. Channels published by `ScheduledSendJob` (`send-*` on mailbox/outbox/sent) are the same uids, so covered.
- **Import** (`BaseMailboxImportRoute`): a trusted caller's `?mailboxUid=` is honoured only with CREATE on it (403 otherwise, also for a non-string); an ordinary caller's stays ignored.
  **Send-as** (`send()`, sync and background): `relaySend()` requires UPDATE on the message's folder via `hasMailAccess`, and `assertSenderAllowed()` ties From to that mailbox - an admin can no longer send as a user.
- Kept (field-level, after access is decided): `isTrusted()` privileges inside `BaseMessageRoute`/`BaseScopedChildRoute`/`BaseFolderRoute` (server-managed fields, Drafts-only send) apply to a trusted caller on
  mailboxes they own or hold a grant on. Listed in `TRUSTED_ROLE_USES` (test table) with why.

### Route audit (`test/routes/mailAccessRouteTable.ts` is the source; `mailAccessGuard.test.ts` enforces it)

Concrete route classes in restapi: 24 mailbox-scoped (incl. `MailPushRoute`), 1 per-user, 8 compliance (cross-mailbox by design), 10 platform-admin, 2 public/machine = 45; the server table lists 15
(4 mailbox-scoped incl. `PushRoute`, 5 admin, 2 user, 4 public) and mounts the rest as subclasses. None unclassified; a folder or mailbox by id the caller can't read is a 404 like a missing one.

| Class | Routes | Gate |
| --- | --- | --- |
| mailbox | Mailbox, Folder, Message, Attachment, CalendarEvent, CalendarShareLink, Contact, ContactList, Note, Task, TaskList, Label, MailSignature, MailFilterRule, FocusedInboxOverride, Quarantine, IngestQueue, MailboxAccess, Search, KeyVault, KeyLookup, Directory (own contacts), MailboxImportRequest, MailPushRoute (server `PushRoute`) | `hasMailAccess`; admin scope only where listed above |
| server mailbox | MessageRawContent, MailCompose, EscrowInfo | `hasMailAccess` (raw/compose), owner/ACL record without bypass (escrow info) |
| user | Appearance (own row only, no trusted path), GiphySearch, wwwRoute | own identity |
| compliance | DataExportRequest, DataSubjectErasureRequest, EscrowAccessRequest, EscrowAuditLog, EscrowScope, Matter, MatterSearch, MatterExportRequest | see below |
| admin | AuditLog, Branding, DistributionList, Domain, EncryptionPolicy, MailboxPolicy, Plugin, RetentionPolicy, Setup, TransportRule; server: ACLRoute (guarded), AdminConsole, Admin, EscrowConsole, Metrics | trusted (class ACL), audited writes; no mail content |
| public | KeyDiscovery (published keys by hash), MailIngest (MTA secret); server: OpenAPI, PublicPage, StaticAsset, Status | anonymous / machine |

### Still crosses mailboxes by design (JP decides whether any stay)

1. **`DataExportRequest`** (`POST`/`GET /data-export-requests`, `/:id/download`): a trusted caller may export - and download the complete mbox/ndjson of - ANY mailbox. Audited: `data_export.requested`;
   `data_export.downloaded` (new) for any download by someone who isn't the mailbox owner. This is the one place message-level content reaches a plain trusted role. Stricter options: require the request
   to carry a matter/approval, or make it owner-only and let an admin impersonate.
2. `DataSubjectErasureRequest`: a trusted caller approves/denies/executes erasure of any mailbox - destroys data, exposes none. Audited (`erasure_request.*`).
3. `EscrowAuditLog`/`EscrowScope`: trusted reads the hash-chained escrow audit and configures scopes - metadata and keys' public halves only.
4. **Quarantine / IngestQueue entries** with `?scope=admin`: envelope from/to, reason, error text, blob key of any mailbox's held/pending mail - not the content (no route serves `rawBlobKey`). Audited per call.
5. Sharing (`MailboxAccess`) admin path above, `MailboxImportRequest` list (`find`/`findById` show a trusted caller who imported what where - metadata) and `DirectoryRoute.search` (the org address book, not private).
6. Not cross-mailbox: `EscrowAccessRequest`/`Matter*`/eDiscovery are gated by escrow-scope holdership (`requireEscrowHolder()`, never a trusted role) with dual control.
7. System jobs (`ScanQueueJob`, `ScheduledSendJob`, retention, erasure, imports, exports) run as the system - unaffected.

### Outside this repo (read-only, reported)

`activesync` (`SyncCommand`, `ItemOperationsCommand`, `MoveItemsCommand`, `PingCommand`, `SearchCommand`, `GetItemEstimateCommand`, `MeetingResponseCommand`, `ComposeMailCommand`: ~25 direct
`aclUtils.hasPermission(ctx.user, folderUid, ...)` calls on client-supplied folder ids) and `booking-plugin` (`BaseBookingProfileRoute`, `BaseBookingTypeRoute`) still call the framework directly, so a caller with
a trusted role in the token they authenticate with could reach other users' folders through them; they resolve the caller's own mailbox by `ownerUserUid` (as does `mapi`), and an EAS/MAPI device signs in with
its user's normal token (no trusted role), so this is latent, not the reported leak. They should switch to `hasMailAccess()` (exported from `@rapidmx/restapi`) in their next release.

### Tests

New: `test/routes/mailAccessMatrixSuite.ts` (+ `{mongo,sql}/MailAccessMatrix.test.ts`: 6 personas x every case per backend: owner, read delegate, write delegate, unrelated user, elevated admin, impersonation
token), `mailAdminScopeSuite.ts` (scope=admin, admin management, Sharing, quarantine/ingest admin, data export), `mailAccessRouteTable.ts` + `mailAccessGuard.test.ts` (route table, matrix coverage, no direct
`hasPermission`, trusted-role uses listed), `test/push/MailPushAccess.test.ts`, `test/util/MailAccessUtils.test.ts`. Changed because they encoded "trusted sees everything" (each still tests its point):
`MailboxRoute` (admin list/count/read -> own-only + `?scope=admin`; ownerless create -> creator grant; eager folders read as the owner; keyDiscoveryHash read back as the owner; other user's mailbox 403 -> 404),
`MailAuthzRound3/4` suites + `verificationSealSuite` (an admin exercising trusted-only field privileges now holds an explicit grant), `mailboxAccessSecuritySuite` (admin reads the version via
`?scope=admin`; trusted role -> `access/me` all-false; missing mailbox -> all-false; own-record change by a trusted manager), `KeyLookup`/`keyTrust`/`keyResolve` (missing mailbox 404 -> 403),
`MailboxImportRequest` (admin import needs a grant; 404 -> 403), `Quarantine`/`IngestQueue` (admin list -> `?scope=admin`, audited), `CalendarShareLink` (the two "fails open when the folder ACL is
missing" tests reached it through the trusted bypass; they now mock the permission check to simulate the race), `MessageRoute` (admin content read -> 404; a delegate admin is still audited),
`MailPushRoute` ("no overrides" -> the two overrides).

### 2026-09-21 (later) - a shared mailbox grant stored against a username matched nobody: sharing now RESOLVES the principal and stores only a user uid

**Live example.** The ACL of the ownerless mailbox `hello@powerlevel.gg` ("Support") was `{ uid: "hello@powerlevel.gg", parentUid: "Mailbox", records: [{ userOrRoleId: "jean-philippe", actions: ["read","list","count","exists"] }] }` - the grant was stored against the USERNAME the
admin typed into the console's Sharing form (it wrote it through the generic `/acls`, verbatim), not JP's uid (`94337e42-...`). An ACL record matches only a token's uid or a role of that name, so it could never apply: the mailbox only ever showed up because a trusted token bypassed ACLs -
which the privacy fix removes, so it became visible as a bug. Fix, in both write paths:
- `BaseMailboxAccessRoute.setMember` (`PUT /mail/mailboxes/:id/access/:principal`): the path segment is now a PRINCIPAL resolved by `resolvePrincipal()`: the caller's own uid or configured username (`mail:auto_provision:static_aliases`, for a deployment with no auth-server) -> the caller;
  a uid -> itself if it owns a mailbox here, or (caller's cookie) auth-server holds an alias for it; an address with a@b -> that mailbox's owner (primary/alias/uid; an ownerless mailbox names nobody); else a username/e-mail alias ->
  `GET {mail:auth_server_url}/api/aliases?alias=<x>&limit=10` with the caller's `jwt` cookie, keeping a verified entry whose alias matches exactly (case-insensitively) and whose `userUid` is UUID-shaped. Verified against `rapidrest/auth`'s `BaseAliasRoute.find()`: an ordinary caller is only ever
  listed their OWN aliases (`userUid` forced to theirs), a trusted (elevated) caller everybody's - so an administrator resolves anyone's username/e-mail alias, a user can name themselves, and a user can name anybody else by mailbox address or uid (the Settings page's existing address lookup). ONLY the resolved lowercase uid is stored; anything unresolvable is
  400 `No user found for "<x>".`; an unreachable/erroring auth-server is 502 (never a guess). A uid that already has a record on this mailbox needs no second lookup (role changes still work). No compatibility trick lets a username match a uid: existing bad grants are re-created through the fixed flow.
- `GET /mail/mailboxes/:id/access/resolve?principal=` (new; same standing as listing members, rate limited like `lookup-by-email`): `{ userUid, displayName?, address? }` or 404 - for a sharing screen to show the person (name + address) before saving.
- `listMembers` marks a member whose id is not a user uid (and not `.*`/`*`/`anonymous`/`share:<token>`) with `noEffect: true` - a role of that name is the only thing it can match - so the UI can flag it ("has no effect - replace or remove"); the fix is PUT the resolved user, DELETE the string (`DELETE` matches the stored string exactly).
- `/api/acls` (server `BaseGuardedACLRoute`): a create/update/updateProperty/updateBulk of a MAIL ACL whose records name a principal that is not a lowercase user uid, unless that exact id is already stored on the ACL, is 400 `No user found for "<x>".`.
- `GET`/`findById` of a mailbox now carries `accessRole: "owner" | "delegate"` (computed on the way out; dropped from create/update bodies) so a client can label the ones shared with the caller; the admin scope answer has `shared` instead.
- **Places that accept a principal string (10):** (1) `PUT /mail/mailboxes/:id/access/:principal` (resolved); (2) `DELETE .../access/:principal` (matches a stored string exactly - needed to remove a bad one; writes nothing); (3) `GET .../access/resolve?principal=` (read-only); (4) `GET /mail/mailboxes/lookup-by-email` (address -> owner uid; read-only); (5) `/api/acls` create/update/updateProperty/updateBulk (server; mail ACLs validated, other ACLs unchanged);
  (6) `POST`/`PUT /mail/mailboxes` `ownerUserUid` (`parseOwnerUserUid`: UUID-shaped only, trusted only) which writes the owner's ACL record; (7) the console's new-mailbox form's "Owner user uid" (goes through 6); (8) `BaseCalendarShareLinkRoute` (`share:<token>` records, minted by the server, no client string); (9) `moveOwnerAcl`/`grantCreator` (server-derived from `ownerUserUid`/the caller's uid);
  (10) escrow `holderUserUids`/matter custodians (not ACL records; unrelated to mailbox access). Only (1) and (5) could store a client-supplied string in an ACL; both now resolve or validate.
- Tests (Mongo and SQL, `mailPrincipalSuite.ts`): grant by address / alias address / uid (upper- and lowercase) / username / e-mail alias / own configured username; the uid is what is stored; a delegate then sees the mailbox with a non-elevated token, labelled `delegate` (owner: `owner`); an administrator with no mailbox adds themselves by uid and by username;
  unresolvable names, an unverified alias, an unknown uid and an ownerless mailbox's own address are 400 with nothing stored; no cookie / unreachable / erroring / malformed identity service; `resolve` (200/404/400/403); the live `hello@` shape (`jean-philippe` flagged `noEffect`, replaced through PUT + DELETE, the real grantee unaffected); revoking removes the mailbox again. Existing sharing tests now grant to KNOWN users (they own a mailbox) and expect `No user found` instead of "Access can only be granted to a user".

## 2026-09-21 — Every mailbox has every well-known folder, and folder events (R3, task A)

Trigger (JP's screenshot + live Mongo): a brand-new account showed only Inbox/Drafts/Deleted Items after its first e-mail was sent - Outbox and Sent Items
were created lazily at that send (`findOrCreateWellKnownFolder()`) and the open client was never told; the shared mailbox `hello@` had only
`calendar, contacts, drafts, inbox, tasks`. (Deleted Items was never created by this library at all - a client made it.)

- **Well-known set** (`util/FolderUtils.ts`, `WELL_KNOWN_FOLDER_TYPES` - every `FolderType` but `USER`): inbox, drafts, outbox, sent_items, deleted_items, junk,
  archive, calendar, contacts, tasks, notes - 11 folders, created in that order (so `dateCreated` reads Inbox first). Names from `DEFAULT_FOLDER_NAMES`
  ("Junk Email", "Sent Items", ...). Uids stay `wellKnownFolderUid(mailboxUid, type)`.
- **`ensureWellKnownFolders(folderRepo, folderClass, mailboxUid, user?)`**: ONE uncached existence query (`{ mailboxUid: literal, type: [all 11], limit }` - an array
  value is an OR on both backends), then `findOrCreateWellKnownFolder()` for each missing type, so it inherits the existing race safety (deterministic uid + unique
  index, ACL repair). A complete mailbox costs the one query and writes nothing. `BaseMailboxRoute.create()` calls it (was: 5 hand-picked `findOrCreate...` calls;
  `create()` is also the only path for auto-provisioning - `autoProvision` is just `POST /` under the policy). Nothing else creates mailboxes (import needs an
  existing mailbox; the server package has no creation path).
- **Heal on read** (`BaseFolderRoute.healWellKnownFolders()`): `find()` (after its `hasMailAccess(LIST)` check, before the query, so the answer includes what was created) and
  `findById()` (only when the caller may LIST the folder's whole mailbox - a folder-only share heals nothing). Best-effort: a failure is logged and the read goes on.
  Called WITHOUT `user`: `RepoUtils.create()` grants a non-trusted creator on the new record's ACL, so passing a delegate's user would have handed a read-only delegate
  FULL on every healed folder (the suite proves a READ delegate cannot rename a healed folder). `BaseMailboxRoute.create()` still passes its caller (owner/creator), as before.
  Nothing is created for a mailbox the caller has no access to (stranger, trusted+elevated admin without a grant, nonexistent mailbox - all tested).
- **Events, and where each comes from**: `RepoUtils.create()` already publishes `{ type: <class name>, action: "create", data: <record> }` on `[folder.uid, ...options.pushChannels]`
  through its own injected `NotificationUtils` - nobody listens on a brand-new folder's own channel, which is why lazy creation was silent. So `createWellKnownFolder()` now passes
  `pushChannels: [mailboxUid]`: every creation path (mailbox create, heal, and the lazy ones in `ScanQueueJob`, `ScheduledSendJob`, `BaseMessageRoute`, `ContactKeyUtils`,
  `DeliveryFailureNoticeUtils` - all through `findOrCreateWellKnownFolder()`) announces on both channels with no change at any call site. A lost race publishes nothing (its insert
  throws before `RepoUtils` publishes; the winner's did) - proven by 6 concurrent `GET /folders` on an empty mailbox ending with 11 folders and exactly 11 create events. The
  route's client `POST /folders` is unchanged (RepoUtils -> folder channel, the route -> mailbox channel). New in `BaseFolderRoute`: `update`/`updateBulk`/`updateProperty` publish
  `{ action: "update", data: <whole folder, derived counts> }` on the mailbox's channel (RepoUtils only published it on the folder's own), and `delete` publishes
  `{ action: "delete", data: { uid, mailboxUid, version } }` there (reads the folder first: it is gone by the time RepoUtils publishes its own `{ uid, version }`). The counts-only
  update event (`FolderCountUtils`) is unchanged. Bulk `truncate` is not published (a mailbox user can't call it - `mailUser()`).
- **A latent race in `findOrCreateWellKnownFolder()`, found by the concurrency test (1 run in ~40)**: when a concurrent create won and the loser's type lookup didn't see the winner's row yet, the
  loser found the row by uid on its next look and treated it as "a soft-deleted folder holds the deterministic uid" - creating a SECOND folder of that type under a random uid (a mailbox with two
  Notes). It now uses that row when it is live (`deleted !== true`) and falls back to a random uid only for a really soft-deleted holder. 150 concurrent-read iterations on Mongo: no duplicates.
- **Existing tests that legitimately changed**: `GET /folders` for a mailbox with no folders is no longer `[]` (it lists the 11): `FolderRoute` (mongo+sql) "Owner can list folders"
  (1 -> 12: the user folder + 11), `folderCountsSuite` "empty mailbox" (now 11 zero-count folders, still one grouped query) and "one grouped query" (1/25 -> 11/35 folders),
  `MailboxRoute` "eagerly provisions" (5 -> 11 types - note it reads through the route, so it would pass even without eager creation; `WellKnownFolders` reads the raw rows).
- **Tests**: `test/routes/wellKnownFoldersSuite.ts` + `{mongo,sql}/WellKnownFolders.test.ts` (creation by an admin for an owner and for a shared mailbox, heal via list and by id, idempotency,
  concurrency, delegate, stranger, admin, missing mailbox, lazy/client create, rename/bulk/property/delete events), `FolderUtils.test.ts` (`ensureWellKnownFolders` on a mock repo), `BaseFolderRoute.test.ts`.
- **For the web client (W-D)**: the client used to create its own Deleted Items (that is where `arthur@`'s came from) - after this it exists, so it must not POST a second one (duplicates of a
  well-known type already exist in the wild; `findOrCreateWellKnownFolder()` returns the oldest, so a second one is invisible to the server but shows twice in the tree).
- **Shared-test-infrastructure warning**: every `test/routes/mongo/*.test.ts` starts its own mongod on port 9999, and every SQL test uses the same better-sqlite3 FILE (`rrst-test`, relative to the
  restapi cwd, see `sqlDatastoreConfig()`). Two agents running suites at once in this repo therefore collide (a `clear()` in one wipes the other's rows: sporadic 403/500/404 in unrelated SQL
  tests, a different set each run). Re-run the file alone; consider a per-run database name.

## 2026-09-21 — Signing-certificate status, progress and check-now (R3, task B)

JP: "There should be a progress bar and status shown for the digital signature cert with a button to check/update the status." `GET .../sign-enrollment/:enrollmentId` said only `pending`.

- **Where the state lives** (correction to the brief): the RFC 8823 enrollment records are NOT in Mongo/SQL - `Rfc8823AcmeSigningCertificateEnrollment` keeps them in a JSON file
  (`enrollments.json` in `mail:pki:rfc8823:store_dir`, `FileStoreUtils`), like the manual CA's. The stage timestamps went onto that record (all optional, so an old record reads correctly:
  `updatedAt`, `challengeReceivedAt`, `finalizedAt`, `issuedAt`, `failedAt`, `errorCode`, `retryable`, `orderExpires`, `orderStatus`, `lastCheckedAt`, `lastForcedCheckAt`, `lastError`). The route tests run
  on Mongo and SQL (the mailbox/ACL side) with the real enrollment on a temp store and a fake `acme-client` `Client` (`test/pki/acmeTestDoubles.ts`).
- **Stage machine** (`pki/EnrollmentStages.ts`, pure, `test/pki/EnrollmentStages.test.ts`), the sequence as the code really runs it: submitted (`startEnrollment` opened the order) ->
  awaiting-challenge (until `recordChallengeToken()` stores the CA's e-mail token - `challengeReceivedAt`) -> challenge-answered (until `advanceEnrollment` sent the reply + `completeChallenge()` -
  `replySentAt`) -> validating (polling `getOrder()` until `ready`, then `finalizeOrder()` - `finalizedAt`) -> issuing (order `processing`, until `valid` + `getCertificate()` - `issuedAt`) -> issued.
  A stage is done when its milestone or any later one is; a failed enrollment fails in the stage it reached (an issued-then-cancelled one on the last, progress capped at 90). `progress`: 15/40/60/85/100.
- **Failure classification** (`retryable` = a new request could succeed): ACME problem types `rejectedIdentifier|unsupportedIdentifier|caa|badCSR|badPublicKey|...` -> `rejected`, not retryable;
  `unauthorized|incorrectResponse` -> `challenge-failed`; `serverInternal|rateLimited|connection|dns|tls` -> `ca-error`; anything else `order-invalid`; local `order-expired` and `cancelled`.
  The old free-text `error` (JSON of the ACME problem) is unchanged. Attempts that throw while still pending (CA unreachable, reply not relayed, `completeChallenge` refused) are stored as `lastError`
  and shown as `errorCode` `ca-unreachable|reply-not-sent|rate-limited|ca-error` + `retryable: true` + `note`, cleared by the next step that succeeds; `advanceEnrollment()` still rethrows so the job logs as before.
- **Expiry** (was: a request whose challenge e-mail never came stayed pending forever): the CA's `order.expires` is stored at start (and refreshed from `getOrder()`); past it - or, with none,
  `createdAt + mail:pki:rfc8823:max_pending_hours` (168) - a still-waiting request fails `order-expired`, retryable, with no CA call. An order already being finalized is never expired locally.
- **Check-now** (`checkNow()`, `POST .../:enrollmentId/check`): one `advance` (the job's own step) and, if that step was answering the challenge, one more (the poll the job would leave to the next tick);
  while the e-mail is still awaited it also peeks at the order (`peekOrder`) so a request the CA already gave up on is noticed - the background tick doesn't do that (unchanged: no CA call without a digest).
  Rate limit is in the record (`lastForcedCheckAt`), so it holds across replicas and restarts: 429 with `retryAfterSeconds` on the error, which the route turns into `Retry-After`; only pending
  enrollments are limited/checked. The wait is bounded by `Promise.race` against 8 s: the step keeps running (the per-enrollment lock serializes it) and the answer carries a `note`. A CA problem never
  throws out of it. The route requires READ on the mailbox (owner or delegate - `requireMailboxAccess`, no trusted bypass), like the status endpoints; start/cancel stay owner-only.
- **Current enrollment** (`GET .../sign-enrollment`): `listEnrollments()` (metadata only) filtered with the existing `enrollmentBelongsTo()` (recorded mailbox uid, else address), the newest in-flight one
  (pending, or issued and not installed), else the newest. 404 for none; the Null default has an empty list (so 404, not its usual 500); an implementation without the method also 404s.
- **Not done here / limits**: nothing installs the certificate on a check - `AcmeEnrollmentDriverJob` does that on its next tick (<= 5 min), so a client sees `issued` before `installedAt`
  (documented; `installedAt` is in the response). `nextCheckAt` is `lastCheckedAt + mail:pki:rfc8823:poll_interval_seconds` (300) - an estimate tied to that config matching the job's cron,
  and a past value means due. The 8 s bound is not configurable from the route (an option on `checkNow()`). Slow-CA behavior is tested at the class level only (a route test would wait 8 s).
- Manual CA: `describeProgress()` = one active stage (waiting for an administrator to upload), then issued/failed; no `checkNow` (the route answers with the current status), no `nextCheckAt`.

### 2026-09-21 - HTML mail keeps its design: a faithful-but-safe sanitizer (R4)

Not committed. **Defect:** `ScanPipeline.sanitize()` called `sanitize-html` with its default attribute allow-list, so every stored HTML mail was an unstyled skeleton - no `<img>` (inline `cid:` images
gone), no `<style>`, `style`, `class`, `bgcolor`, `color`, `face`, `width`, `cellpadding`... JP's rule: mail renders faithfully to its HTML including styling, safely, no JS. The reading pane (web-client,
NOTES 2026-09-21) sandboxes and re-sanitizes, but can only show what the server stored.

- **Threat model.** The HTML is written by an attacker. Goals to stop: script execution (tags, `on*`, `javascript:`/`vbscript:`/`data:` URLs, CSS `expression()`/`behavior`/`-moz-binding`, mXSS through
  namespace/`noscript`/`<style>` re-parsing), navigation and exfiltration (`meta refresh`, `base`, `form`, `iframe`, `link`, `@import`, `@font-face`, `url()` to anything not an image), overlay/clickjacking
  (`position: fixed|absolute|sticky`, `z-index`), DOM clobbering (`name`, `id`), tracking that the client would follow, and denial of service (5 MB of CSS, 50,000-deep nesting, 5 MB attributes). Defence in depth: this sanitizer
  is layer 1 of 4 and relies on none of the others (client: DOMPurify + hardening pass, CSP, sandbox without `allow-scripts`).
- **Design: re-serialize, never copy.** `scan/HtmlSanitizer.ts` walks `htmlparser2`'s events and writes the output itself: allow-listed elements only, each attribute value validated and rewritten to a canonical
  form, text/attribute escaping, every tag closed. Whatever a browser would parse differently in the *input* does not matter; the output has no raw-text elements (`script`, `textarea`, `title`, `xmp`, `noscript`
  are dropped; `style` is written from tokens with `<` escaped to `\3c `) and never `svg`/`math`, so there is nothing to mutate. Dropped-with-content vs unwrapped (tag removed, text kept) is the split in the
  README table; unknown/custom/namespaced elements and form wrappers unwrap. A run that unwrapped an element repeats on its own output until nothing is unwrapped (max 3 passes) - removing an element can change
  how the rest nests (`<p>` in `<p>`), and this keeps `sanitize(sanitize(x)) === sanitize(x)`, proven on both corpora and 300 random inputs. Output is a full document (`<!DOCTYPE html><html><head>[meta
  color-scheme][style...]</head><body attrs>...</body></html>`): every `<style>` moves to the head, the first `<html>`/`<body>` attributes are kept (a template's `bgcolor` lives there), comments (Outlook `[if mso]`)
  are dropped, `<!--[if !mso]><!-->` content stays (a non-Outlook client shows it).
- **CSS (`scan/CssSanitizer.ts`), and the library choice.** `css-tree` is not installed; `postcss` (via `sanitize-html`) and `lightningcss` (dev-only native) were evaluated. A stylesheet parser is only half the job:
  what the sanitizer checks must be what the browser reads, so every value needs a CSS-Syntax tokenizer (escapes decoded, comments removed) anyway, and the output has to be re-serialized from those tokens. So a
  ~900-line purpose-built tokenizer/parser/serializer (`tokenizeCss`, `serializeCssTokens`) does all of it, with no dependency: `u\72l(javascript:x)`, `expr/**/ession(` and `\75rl(` are `url(javascript:x)` and
  `expression(` by the time they are checked. Rules: property allow-list (README), function allow-list (colours, `calc`/`min`/`max`/`clamp`, gradients; anything else - `var()`, `image-set()`, `attr()`,
  `expression()` - refuses the declaration), `url()` only `cid:`/small raster `data:`/`http(s)` and only on `background*`/`list-style*`, `display`/`position`/`overflow` value checks, `!important` kept,
  `@media` kept (3 levels, plain media queries only), every other at-rule dropped, selectors re-serialized (ID selectors renamed with the `m-` prefix the `id` attributes get, pseudo functions allow-listed),
  syntax errors dropped rule by rule, `<!--`/`-->` ignored. Budget across all `<style>` blocks: `max_css_bytes`, `max_css_rules`; input beyond 4x the byte budget is not even tokenized. Style text with a
  control character in a name (`\9` hacks) is refused. `mso-*` and vendor-only properties drop as not in the list.
- **URLs (`scan/MailUrlRules.ts`).** Tabs/newlines/control characters are removed before the scheme is read (as a browser does), the canonical form is what is written. Links: `http(s)`, `mailto`, `tel`; relative,
  protocol-relative and `#fragment` links lose the `href` (a link in an `about:srcdoc` frame goes nowhere) and keep their text; every link gets `target=_blank rel="noopener noreferrer nofollow"`. Images: `cid:`,
  `data:image/(png|jpeg|gif|webp|avif);base64` up to `max_data_image_bytes` (measured decoded), `http(s)` verbatim (not proxied here; the client's CSP does not load them). `cid:` tokens are restricted to
  `[A-Za-z0-9._~@+=!$*/-]{1,256}`, which is what lets the serving step find them again with a regex.
- **Decisions.** (1) `id` is prefixed `m-`, not dropped: MailChimp-style templates style through `#templateHeader`; selectors are renamed the same way; prefix is not re-added (idempotent). (2) `noscript` content is
  dropped (it is usually a tracking pixel fallback); `form`/`button`/`label` unwrap (an ASP.NET page is one big `<form>`). (3) `<meta name=color-scheme>` is the only meta kept, so a dark-aware mail is
  recognised by the reading pane. (4) `allowed_tags`: an empty list now means "all"; the tests' config set `[]`, which with sanitize-html had silently meant "no tags"; the list restricts, never adds. (5) The version is a stamp
  **inside the blob** (`<!--rapidmx-sanitized:2-->` in front), not a model field: no Mongo/SQL model change, nothing to keep in step across `ScanQueueJob` (2 sites), `MailboxImportJob`, `MailSendUtils`,
  `ScheduledSendJob` and `BaseMessageRoute.send()` (which all just store `result.sanitizedHtml`), and the version travels atomically with the content; a blob without a stamp is version 0. (6) mailparser is called with
  `skipImageLinks` (by default it rewrites every `cid:` image in the HTML to a `data:` URI of the whole image - which the size cap would then drop) and `skipHtmlToText` (its own HTML-to-text put the stylesheet and
  the preheader in `parsed.text`, which is what the preview used); `bodyPreview` for HTML-only mail is now `scan/HtmlPreview.ts` (own extractor over the same parser: skips `style`/`head`/scripts/hidden
  preheaders, stops after ~560 characters; 200 KB: 0.4 ms vs ~5 ms for `html-to-text`). `html-to-text` stays (search extraction, transport rules use it).
- **Attachments' `contentId`** was stored with the header's angle brackets (`<logo@x>`); the HTML says `cid:logo@x`. `ScanPipeline` now stores it without them (new mail); old rows keep theirs and the serving lookup
  ignores brackets and case.
- **Serving (`GET /messages/:id/content`, `scan/SanitizedBody.ts`, small edits in `BaseMessageRoute.content()`; authorization untouched - R2's).** `SanitizedBodyLoader.load()` reads the blob; a version below
  `SANITIZER_VERSION` is re-sanitized from `bodyBlobKey` (`ScanPipeline.sanitizeRaw()`: parse + sanitize, no rspamd/ClamAV), overwriting the blob. Race-safety: pure function of the raw MIME, so concurrent
  writers write identical bytes; `put` is an atomic replace on the local FS and S3; one shared promise per blob key in a process; the blob is only replaced if it still exists (an erased message is not resurrected;
  narrow window remains between `exists` and `put`). Bounds: `lazy_max_raw_bytes` (16 MiB), `lazy_timeout_ms` (10 s; the run finishes in the background), failures remembered 5 minutes (max 2000). Failure never fails the
  request: the stored HTML is served. Then `pointInlineImages()`: `?cid=attachment` rewrites each known reference to `<attachment_url_prefix>/<uid>/content`, `?cid=keep` leaves it `cid:`, default by
  `Sec-Fetch-Dest` (`empty` = fetch() = keep; else attachment); unknown references lose the `src`/`url()` (`none`). CSP header `img-src data: 'self'` (was `data: cid:`). `attachmentClass` is a new optional
  hook on `BaseMessageRoute`, set by `MessageRouteMongo`/`SQL` (downstream subclasses without it just have no inline attachments to resolve).
- **Client compatibility (read from `web-client/.../reading/{bodyHtml,safeDocument,frameDocument}.ts`, `react-shared/mail/messageBodySanitizer.ts`).** Everything the client keeps it gets: `cid:` on `<img>`
  (resolved by `makeCidResolver` against `Attachment.contentId`, which is why `keep` mode and unbracketed ids exist), `data:` images, `<meta name=color-scheme>`, `@media (prefers-color-scheme)`, `<body>`
  `bgcolor/text/link/style/class/dir`, head `<style>`s, `http(s)`/`mailto`/`tel` links. **What the client strips that the server now emits usefully:** (a) every `http(s)` image, `background` and CSS `url()` (its
  DOMPurify hook keeps only `data:`/`cid:`) - kept by the server for a future "load remote images" affordance, currently shown as nothing; (b) `cid:` in a CSS `url()` or a `background` attribute is not
  resolved by `hardenImage()` (only `<img src>` is) and `frameCsp` allows only `data:` and the attachment prefix, so inline background images do not show; (c) a server-rewritten `/api/mail/attachments/<uid>/content`
  `src` (`?cid=attachment`) would be removed by `hardenImage()` - the reading pane must use `?cid=keep` or a `fetch()` (it does by default: `Sec-Fetch-Dest: empty`); (d) `makeCidResolver` compares `contentId`
  exactly - rows written before this change carry brackets (`<logo@x>`), so the client should strip them when comparing; (e) the served document is now a full page (`<html><head><style>...`), which its
  `DOMParser` path handles, but a reply-quote of `/content` should take the body. The client's `id` hardening finds nothing to strip (ids already `m-`-prefixed).
- **Proof.** Unit: 127 hostile payloads (`test/scan/fixtures/mailCorpus.ts`: OWASP evasions, entity/CSS-escape obfuscation, mXSS `svg`/`math`/`noscript`, `srcset`, `@import`, `expression()`, `meta refresh`,
  `base`, `form`, `iframe srcdoc`, `object data:`, `link`, unclosed tags, 20,000-deep nesting, 5 MB CSS/attribute, 30,000 rules, 100,000 elements) all pass `test/scan/fixtures/inert.ts` (an independent re-parse
  that lists any non-allow-listed element/attribute, URL or CSS hazard), in under a second each, idempotent; 7 design fixtures (plain reply, Gmail, Apple Mail, Outlook/Word with conditional comments and mso
  styles, MailChimp-style newsletter, dark-mode newsletter, legacy font/center page) keep their colours, fonts, layout and images. **Real browser (Edge via Playwright, a throwaway script, not kept):** the
  sanitized 127 payloads, in an iframe with `sandbox="allow-scripts allow-same-origin"` and *no CSP* (worst case) and in the reading pane's own configuration (no scripts + its CSP), with `window.__pwned`
  and `alert` canaries, a dialog/popup/navigation/request watch and DOM checks: 127/127 inert in both, 0 requests with the CSP (3 payloads request their remote images without it, by design), no
  script/iframe/object/form/svg/handler/`fixed`-position element in any rendered document; harness self-check: 5 of 6 raw (unsanitized) canary payloads fire (the sixth needs a click); the 7 design fixtures render with
  their computed background/font colours.
- **Measured** (this machine, 200 KB table-layout newsletter, median of 20): old `sanitize-html` 5.3 ms, new `sanitizeMailHtml` 4.9 ms; 184 KB Word-style (`o:p`, second pass): 4.4 vs 6.1 ms; the preview 5.0 vs
  0.4 ms. (An earlier build of this run was 3x slower until `<head>` stopped forcing a second pass and repeated `style` values were memoized.)
- **Known gaps.** No proxy for remote images (kept verbatim; blocked by the client CSP); `<svg>`/`<math>` mail (some icon sets) is dropped; a `background` `cid:` inside CSS needs a client change; `mso-` conditional
  content is dropped in full (correct for non-Outlook readers); `position: absolute` layouts flatten; CSS custom properties/`var()` and `@supports` are dropped; `@media` range syntax (`width <= 600px`)
  is dropped; `?cid=attachment` in a browser tab under `sandbox` CSP loads attachments only if the browser sends the session cookie for a sandboxed document's same-origin subresource (not verified in a browser - the
  reading pane does not use it); an erasure racing a re-sanitization can leave the window described above; `sanitizeRaw()` parses the whole raw MIME (bounded by `lazy_max_raw_bytes`) though only the HTML is needed.
- Files: new `src/scan/{HtmlSanitizer,CssSanitizer,MailUrlRules,HtmlPreview,SanitizedBody}.ts`; changed `src/scan/ScanPipeline.ts` (config, `parse()`, `sanitizeRaw()`, `contentId`, preview),
  `src/routes/BaseMessageRoute.ts` (`content()` + `sanitizedHtmlOf()`, `attachmentClass`, 3 `@Config`), `src/routes/{mongo/MessageRouteMongo,sql/MessageRouteSQL}.ts` (`attachmentClass`), `package.json`/`yarn.lock`
  (`htmlparser2`); tests `test/scan/{HtmlSanitizer,CssSanitizer,MailUrlRules,HtmlPreview,SanitizedBody}.test.ts`, `test/scan/fixtures/{mailCorpus,inert}.ts`, `test/scan/ScanPipeline.test.ts`,
  `test/routes/sanitizedContentSuite.ts` + `{mongo,sql}/MessageSanitizedContent.test.ts`, `test/jobs/htmlMailSuite.ts` (+2 calls in `ScanQueueJob{Mongo,SQL}.test.ts`), `test/routes/mailAuthzRound3Suite.ts` (one CSP string).

## 2026-09-21 (later) - Signing certificates: honest status, an admin route to complete manual requests, CA health (R6)

JP's live report: requested a signature key over an hour ago, no key, no status/failure info anywhere. **Diagnosis (verified live, from the report and the code):** the deployment ran the default
`mail.pki.signing_enrollment.backend: "manual"` (`server/src/config.{mongo,sql}.ts`), whose enrollment sat `status: "pending"` in `/var/lib/rapidmx/pki/manual-enrollments.json` waiting for a human
to upload a certificate - but there was **no admin route for that upload step at all** (`ManualSigningCertificateEnrollment`'s own doc comment: "intentionally not part of this pass"), while the
Encryption settings page told the user a public CA issues it automatically in the background - true only for `rfc8823`, a separately built backend never turned on by default. JP decided: switch the
live deployment to automatic issuance (`rfc8823`) - the CA's directory is reachable over HTTPS with no external-account-binding requirement - and build the manual-completion path too (the honest
fallback / escape hatch), plus make every future failure of either path visible. A real CA e-mail exchange could not be exercised here; everything is proven against the existing fake-ACME test
doubles (`test/pki/acmeTestDoubles.ts`) and new ones (`test/pki/signingCertTestUtils.ts`, a real self-signed test CA for certificate validation).

- **`provider` on every status** (`EnrollmentProgress.provider: "manual" | "rfc8823"`, additive). `SigningCertificateEnrollment` gained an optional `kind` (`"manual"|"rfc8823"|"none"`) each
  implementation sets; `BaseKeyVaultRoute.enrollmentProgress()` stamps it from the implementation's own report or, if it says nothing, `providerKindOf()` (its `kind`, else guessed from `name` -
  `"rfc8823-acme"` is `rfc8823`, else `manual`) - so even an implementation that predates this feature (or a test double) always carries a provider.
- **`GET /system/signing-enrollment`** (new `BaseSigningEnrollmentInfoRoute`, mounted by the server at `system/signing-enrollment`; any signed-in user) answers `SigningBackendInfo`:
  `{ backend, automatic, ca?: { host }, contactEmail?, typicalDurationMinutes?, adminUpload, health? }`. `ca.host` is deliberately `new URL(directoryUrl).host` only - never the path/query, which on a
  self-hosted CA could carry something private. `typicalDurationMinutes` for `rfc8823` is a constant (`TYPICAL_DURATION_MINUTES = 20`, documented 10-30: the CA's e-mail arrives in a minute or two,
  then one 5-minute-tick step per stage - answer, finalize, download - plus the install tick). Each `SigningCertificateEnrollment` implements `describeBackend()`; the route degrades to
  `{ backend: kind ?? "none", automatic: kind === "rfc8823", adminUpload: false }` if it throws or has none, so a broken store never blanks the whole page.
- **`SigningEnrollmentHealth`** (`src/pki/SigningEnrollmentHealth.ts`) is the one place a CA outcome is recorded: `record({ ok } | { ok: false, error, code? }, { auditAfter? })` returns whether this is a
  *new* failure (first of a run, or the text changed - worth one log line), a *recovery*, and whether an *audit entry is due* (the run just reached `auditAfter`, written once per run via a
  `streakAudited` flag cleared on success). Persisted as `health.json` next to the RFC 8823 enrollment store (survives a restart, shared by every process on the volume) plus an in-memory fallback if
  the write fails. `sanitizeErrorText()` (also exported) strips PEM blocks, reduces every URL to `[url <host>]` (credentials removed), strips `Bearer` tokens and any 32+ char token-like run, collapses
  whitespace and caps at 300 chars - used everywhere an error reaches a client or the audit log (the RFC 8823 provider's `lastError`, the admin list's `lastError`, the health report).
- **`AcmeEnrollmentDriverJob`** now tags a failure from `advanceEnrollment()` with `err.enrollmentPhase` (`"ca"` from `Rfc8823AcmeSigningCertificateEnrollment.advance()`, `"reply"` if the outbound
  e-mail relay failed) and, only for `"ca"` failures on a provider that exposes `health`, swallows them into one summary per run instead of one `logger.error` per enrollment: `reportCaHealth()` calls
  `health.record()` once, logs a `warn` only when `newFailure`, an `info` line once on recovery, and writes `AuditAction.SIGNING_ENROLLMENT_CA_UNREACHABLE` (`targetType: "SigningEnrollment"`,
  `targetUid: "ca"`, `details: { consecutiveFailures, firstFailureAt, error }`) when `auditDue`. New `mail:jobs:acme_enrollment_driver:failure_audit_after` (default 3). `advanceEnrollment()` itself now
  returns `boolean` (whether it spoke to the CA and got an answer) instead of `void` - both providers updated, `AcmeDrivenEnrollment`'s local interface loosened to `Promise<boolean | void>` so an
  older/test implementation returning `void` still type-checks.
- **Startup line, no network call.** Both providers gained `@Init logStartup()`: the manual one logs once that requests wait for an administrator; the RFC 8823 one logs the CA host and whether an
  ACME account is already registered - read from the local store (`account.url`) only, so a CA that is down at boot never delays or fails startup.
- **Unknown enrollment id -> `404 signing-enrollment-unknown`, and idempotent cancel.** New `SIGNING_ENROLLMENT_UNKNOWN` error code, thrown by both providers' `requireEnrollment()` for any unknown id
  (was the framework's generic `NOT_FOUND`) and by `BaseKeyVaultRoute.requireEnrollmentOf()` for one that doesn't belong to the path mailbox - deliberately the SAME code for "this backend doesn't know
  it" and "it's someone else's", so which one it is stays private. `findEnrollmentOf()` now returns a three-way `"own" | "other" | "unknown"` (was boolean) so `cancelSignEnrollment()` can special-case
  `"unknown"`: instead of 404 it answers 200 with `unknownEnrollmentProgress()` - a synthesized `{ status: "failed", errorCode: "cancelled", retryable: true, stage: "failed", stages: [], progress: 0 }`
  - so a client holding a stale id from a backend the deployment switched away from clears it and offers "request again" instead of showing a dead end. `"other"` still 404s as before.
- **The manual provider can now be completed.** `ManualSigningCertificateEnrollment` gained everything the RFC 8823 one already had for the driver job - `attachWrappedKey()`, `listPendingEnrollments()`,
  `advanceEnrollment()` (always a no-op `false` - there is no CA to poll), `getIssuedMaterial()`, `markInstalled()` - so `BaseKeyVaultRoute.startSignEnrollment()` submitting a wrapped key up front
  works identically regardless of backend, and `AcmeEnrollmentDriverJob.installCertificate()` (unmodified) installs a manually-uploaded certificate into the mailbox's `KeyVault` exactly as it does an
  automatic one. New `getRequest()` (CSR + status + mailboxUid + hasWrappedKey, never the key), `uploadValidatedCertificate()` (validates then calls the existing `uploadCertificate()`),
  `rejectEnrollment()` (`errorCode: "rejected"`), `listAdminEnrollments()`. A pre-existing enrollment with no wrapped key (started before this pass, or via a caller that never attached one) reports
  `canUpload: false` with `uploadBlockedReason` telling the admin to have the owner cancel and request again - uploading a certificate for it would strand it (no key to install).
- **`IssuedCertificateValidation.ts` (`validateIssuedCertificate(csrPem, identity, certificatePem, now?)`)** - the real check behind an admin's upload, all refusals 400 with a plain-English message:
  parses a PEM chain (leaf first, up to 8 certificates); the leaf's public key must match the CSR's (a wrong chain order that puts an issuer first, when a later certificate DOES match, gets a specific
  "put the end-entity certificate first" message); `emailProtection` EKU required, `digitalSignature` key usage checked only if the extension is present; the leaf must name `identity`
  (`certificateEmailIdentities()`, case-insensitive, SAN `rfc822Name` else subject `emailAddress` - reused from `util/SignerCertificateUtils.ts`); not expired, not valid-in-the-future beyond 5 minutes
  of clock skew. Returns `{ chainLength, subject, issuer, serialNumber, notBefore, notAfter }` for the audit entry and the response.
- **`BaseSigningEnrollmentAdminRoute`** (new, mounted by the server Mongo+SQL at `admin/signing-enrollments`): `GET /` (`listAdminEnrollments()` from whichever provider is active - metadata only,
  `AdminEnrollmentSummary[]`), `GET /:id/csr` (PEM download, `content-disposition: attachment`), `POST /:id/certificate` (`{ certificate }` -> `validateIssuedCertificate()` + store, answers
  `CertificateUploadResult`), `POST /:id/reject` (`{ reason }`, 1-500 chars, control characters stripped). Every call `assertAdminScope()` (trusted role AND elevated - the same gate the mailbox admin
  scope and the plugin purge route use) and audited (`recordAuditLog`, new `AuditAction.SIGNING_ENROLLMENT_ADMIN_{LIST,CSR,UPLOAD,REJECT}`). On the `rfc8823` provider (which has no
  `getRequest`/`uploadValidatedCertificate`/`rejectEnrollment`) every write answers 409 with an explanation; the list still works (`listAdminEnrollments()` is on both providers, the RFC 8823 one
  read-only: `canUpload: false`, `uploadBlockedReason` explains why).
- **What could NOT be verified here:** a real CA e-mail exchange (challenge received, reply sent and accepted, certificate actually issued) - only the fake `acme-client` doubles. The CA's directory
  reachability/EAB-free-ness was checked live per the brief but the automated flow's real challenge round-trip was not.
- Files: new `src/pki/{SigningEnrollmentHealth,IssuedCertificateValidation}.ts`, `src/routes/{BaseSigningEnrollmentInfoRoute,BaseSigningEnrollmentAdminRoute}.ts` + their Mongo/SQL concrete classes;
  changed `src/pki/{SigningCertificateEnrollment,ManualSigningCertificateEnrollment,Rfc8823AcmeSigningCertificateEnrollment,NullSigningCertificateEnrollment}.ts`, `src/jobs/AcmeEnrollmentDriverJob.ts`,
  `src/routes/BaseKeyVaultRoute.ts`, `src/models/types.ts` (5 new `AuditAction`s); tests `test/pki/{IssuedCertificateValidation,SigningEnrollmentHealth,ManualSigningCertificateEnrollment.admin,
  Rfc8823AcmeSigningCertificateEnrollment.backend}.test.ts`, `test/pki/signingCertTestUtils.ts`, `test/jobs/caHealthSuite.ts` (+1 call each in `AcmeEnrollmentDriverJob{Mongo,SQL}.test.ts`),
  `test/routes/signingEnrollmentAdminSuite.ts` + `{mongo,sql}/SigningEnrollmentAdmin.test.ts`, one addition to `test/routes/mailAccessRouteTable.ts`.

## 2026-09-21 (R5) - "failed to discover the recipient's key" between two accounts on the same server (live report)

JP: two `powerlevel.gg` mailboxes, each with one published internal-CA encryption certificate, could not encrypt to each other -
`GET /mailbox/:id/keys/lookup?addr=<other>` answered 404 both directions. **Root cause:** `BaseKeyLookupRoute.lookup()` always went
through `discoverAndMergeKeys()`, which only ever does federation - resolve the address's domain `_rapidmx` TXT policy
(`FederationUtils.resolveFederationPolicy()`), then fetch that peer's public discovery endpoint (`KeyDiscoveryClient.fetchRemoteKeys()`).
There was no path at all for "the address is a mailbox this deployment itself hosts" - a same-server, same-domain pair (or any
deployment whose own domain publishes no `_rapidmx` record, which no deployment needs to) always fell through to "not a federated
peer" and 404'd, no matter how thoroughly its keys were set up.

**Fix: one shared builder, checked before any DNS/HTTP.** `util/LocalKeyDiscoveryUtils.ts` (new) has `buildKeyDiscoveryResponse()` -
the exact response shape (`{ encryptPreference, keys, escrow }`) a mailbox publishes, escrow computed from its `KeyVault`'s wraps the
same way the timing-safe "one KeyVault lookup either way" logic always did - extracted out of `BaseKeyDiscoveryRoute` (the public
`.well-known` endpoint) so both callers build it from literally the same function and can never drift; `BaseKeyDiscoveryRoute` itself
is now a thin caller of it. `discoverLocalKeys()` resolves `addr` to a mailbox the way inbound delivery does (`findMailboxByAddress()`-
equivalent: exact `primarySmtpAddress`, then `aliasAddresses`, then - if plus-addressing is enabled - the same two tiers against the
plus-stripped address; case-insensitive via `normalizeAddress()`), and reports the mailbox's *primary* address as the key's identity
(what its certificate actually names) alongside the response - `undefined` (fall through to federation, unchanged) for an address
that's neither a local mailbox nor of one of this deployment's own domains, and `{ address, response: undefined }` (no mailbox, no
DNS - straight to `KeyringUtils`'s existing "nothing discoverable" / Anti-Downgrade path, same as a remote 404) for an address of a
served domain nobody has. `discoverAndMergeKeys()` takes an optional `local: LocalKeyDiscovery` and checks it first; every existing
caller (`BaseKeyLookupRoute`, `ScanQueueJob.maybeRefreshRotatedKey()` for the MDN rotation-hint path) now passes its own mailbox/
KeyVault repos and `aliasQueryValue()` so a peer who happens to live on this deployment is never sent out to DNS/HTTP from either
call site - `ScanQueueJob`'s in-band `RapidMX-Key` header path (`processInboundRapidMxKeyHeader()`) needed no change: it already has
a `KeyDiscoveryResponse`-shaped payload from the header itself and calls `applyDiscoveredKeys()` directly, never `discoverAndMergeKeys()`.
`BaseDirectoryRoute`/`ContactKeyUtils` don't call either function and have no analogous gap. New abstract `keyVaultClass`/`domainClass`
(lookup route) and `keyVaultClass` (ScanQueueJob) on the Mongo/SQL concrete classes, mirroring the existing `mailboxClass` pattern.

**Proven with a real client, real internal CA, real send/receive** (sandbox: `mongodb-memory-server` 7.0.14 + a real Windows Redis
binary on fixed local ports, `NODE_ENV=development` so the dev-only scan-bypass/local-delivery wrappers apply, `node dist/src/worker.js`
production build of server+restapi+react-shared+web-client all built from source and overlaid into `node_modules/@rapidmx/*` as copies,
a stub identity service for `users/me`/`profiles/me`/`aliases`/`logout`, real headless Chromium via `playwright-core`): two mailboxes
(`alice@qa.test`, `bob@qa.test`, plus an alias `robert@qa.test`) each ran Settings > Encryption "Set up" for real - client-generated
P-256 keypair + CSR, `LocalX509CertificateAuthority` issued a real certificate chained to a freshly generated local CA. Compose showed
"bob@qa.test supports encryption" from the live (fixed) lookup with **no DNS call at all**; Alice sent encrypted (`{background:true}`
send path); the message delivered through the fake-sendmail-less dev local-delivery transport (`DevLocalDeliveryTransportMongo`,
`src/dev/DevLocalDeliveryTransport.ts` in `server`, no server-side change needed) straight into Bob's Inbox as a locked "Encrypted
message" with a lock icon; Bob unlocked with his password and read the real plaintext; Alice's Sent Items copy decrypted too (see the
`MessageDetailPane.tsx` fix below); a third mailbox with no key (`carol@qa.test`) produced "This message can't be encrypted for
everyone: carol@qa.test has no encryption key on file... or send the whole message in plaintext" with a working "Send without
encryption" fallback, not a crash - Carol received and read that plaintext copy. Alias-addressed and case-insensitive lookups verified
both via the API directly and (alias) via `discoverLocalKeys()`'s own unit tests. Not verified: RFC 8823 real public-CA signing
enrollment (needs a live e-mail round trip with a real ACME CA) and cross-deployment federation against a second real server - both
exercised here only against the existing fake-DNS/fake-fetch test doubles, unchanged by this fix.

**One client defect the round trip found, fixed at the source (in scope per this task - not one of `web-client`'s W-D-owned files):**
Alice's own Sent Items copy of an encrypted message she sent to Bob decrypted fine but showed a confusing banner - "The recipients
this message was signed or encrypted for don't include this mailbox... you may have been Bcc'd" - because `evaluateMessageSecurity()`'s
`notAddressedToReader` compares the reader's address against the message's protected (signed/encrypted-for) `To`/`Cc` headers, which
for an ordinary message never include the sender's own address. Fixed by gating the notice's own render in `MessageDetailPane.tsx` on
`!isSentItems` (the same signal the Recall button already uses) rather than touching the shared `messageSecurity.ts` logic the Inbox/
other-folder cases still need unchanged - a genuine Bcc/forwarded-verbatim notice still shows everywhere else. One new test
(`MessageDetailPane.test.tsx`).

Files: new `src/util/LocalKeyDiscoveryUtils.ts`; changed `src/routes/BaseKeyDiscoveryRoute.ts`, `src/routes/BaseKeyLookupRoute.ts`,
`src/routes/mongo/KeyLookupRouteMongo.ts`, `src/routes/sql/KeyLookupRouteSQL.ts`, `src/util/KeyringUtils.ts`, `src/jobs/ScanQueueJob.ts`,
`src/jobs/mongo/ScanQueueJobMongo.ts`, `src/jobs/sql/ScanQueueJobSQL.ts`; tests: new `test/util/LocalKeyDiscoveryUtils.test.ts`,
`test/routes/keyLocalDiscoverySuite.ts` + `{mongo,sql}/KeyLocalDiscovery.test.ts`, plus the local-peer-no-DNS/no-fetch case added to
`ScanQueueJob{Mongo,SQL}.test.ts`'s rotation-notification describe block. `yarn tsc --noEmit` and `yarn lint` clean. Every test file
touched or added passes in isolation with 100% statement/line/function and 98.84% branch coverage on the four changed/added source
files (`--coverage.include` scoped run); a genuinely exclusive whole-repo run could not be obtained this session - a second agent
(R6) ran the full restapi suite back-to-back essentially the entire time, and two full-suite attempts both showed the documented
contamination signature (`MongoNetworkError: read ECONNRESET` on the shared port-9999 instance; SQL ACL/contact-count mismatches
consistent with the shared sqlite file) in files outside this diff - no failure in either run named any file this fix touches for a
reason that reproduced in isolation.

### 2026-09-22 - Autodiscover never worked on any deployment: the setting was never wired, and the DNS checklist never mentioned it

Two independent gaps, both closed. (1) `@rapidmx/autodiscover-plugin`'s `BaseAutodiscoverRoute` has always needed `mail:autodiscover:public_url`
to answer anything - the plugin's own `package.json` already declared it as an admin-console setting, but server's `config.mongo.ts`/`config.sql.ts`
had no default block for it at all (unlike every other plugin setting of this shape, e.g. `mail:booking:public_url`), so it sat unset on every
real deployment; fixed by adding the matching `autodiscover: { public_url: "" }` block. The plugin's own stale doc-comment example (describing
an old subclass-override design `BaseAutodiscoverRoute` no longer uses) was also rewritten to describe the real, current config-driven mechanism.
(2) `util/DnsSetupUtils.ts`'s `DnsRecordType` never had an Autodiscover entry, so an administrator setting up a domain had no idea anything else
was needed even once `public_url` is set - real client discovery (MS-OXDISCO) also needs `autodiscover.<domain>` reachable. New `autodiscover_cname`
(`autodiscover.<domain>` CNAME/A to the same host `public_url` names - needs its own TLS coverage) and `autodiscover_srv` (`_autodiscover._tcp.<domain>`
SRV to the same host, `0 0 443 <host>` - needs **no** extra certificate, since the target is already correctly certed; the one to recommend first on
a Let's-Encrypt-rate-limited deployment). Both are entirely omitted from `checkDnsSetup()`'s result when `@rapidmx/autodiscover-plugin` isn't active
(`PluginRegistry.isActive()`, checked live per request via a new `AUTODISCOVER_PLUGIN` constant in `BaseDomainRoute.ts`); when active but `public_url`
is unset/invalid they appear with `configured: false`. New `DnsResolver.resolveCname()`/`resolveSrv()` (and their `NodeDnsResolver`/`DohDnssecDnsResolver`
implementations - the latter over DoH, since that's the DNSSEC-validating resolver real deployments actually run). `extractPublicHostname()` lives in
`util/DomainUtils.ts` (a pure helper, directly unit-testable) rather than inline in the route, matching that file's existing convention.

Operator runbook for `powerlevel.gg` once this ships: set the Autodiscover plugin's **Public server URL** setting to this deployment's real
`https://` host (saving restarts servers one at a time); add `_autodiscover._tcp.powerlevel.gg` **SRV** `0 0 443 <that host>` (no new certificate
needed - do this one first); add `autodiscover.powerlevel.gg` **CNAME** to the same host as a follow-up once its own TLS coverage is sorted (a SAN
on the existing certificate, or its own).

Files: new `test/routes/mongo/DomainRouteAutodiscoverConfigured.test.ts`, `test/routes/sql/DomainRouteAutodiscoverConfigured.test.ts` (a real
`public_url` value needs its own server instance - `@Config` binds at route construction, before `server.start()`, so it can't vary per-test in
the shared server the way `PluginRegistry.isActive()` can); changed `src/dns/DnsResolver.ts`, `src/dns/NodeDnsResolver.ts`, `src/routes/BaseDomainRoute.ts`,
`src/util/DnsSetupUtils.ts`, `src/util/DomainUtils.ts`, `test/dns/NodeDnsResolver.test.ts`, `test/routes/{mongo,sql}/DomainRoute.test.ts`,
`test/testDoubles.ts` (`StaticDnsResolver` gains `cnameRecords`/`srvRecords`), `test/util/DnsSetupUtils.test.ts`, `test/util/DomainUtils.test.ts`.
`yarn build` (lint + tsc) and `yarn test:prod` both clean: 296/296 files, 7469/7469 tests, 100/97.25/100/100 (stmts/branch/func/lines).

### 2026-09-22 - Resolving who a mailbox owner or an escrow scope's key holder is, instead of typing a raw uid blind

An administrator reassigning a mailbox's `ownerUserUid` or an escrow scope's `holderUserUids` had nothing but a bare text field - `parseOwnerUserUid()`
only ever checked the value was UUID-*shaped*, never that it named a real person, and `validateEscrowScope()` only checked "non-empty strings, no
duplicates". Lifted `BaseMailboxAccessRoute`'s private `resolvePrincipal()` (address, username, e-mail alias or uid -> the one person it names, or
nothing - deliberately exact-match only, never a fuzzy/partial directory search, matching this session's privacy posture throughout) into a shared,
DI-parameterized `util/PrincipalResolutionUtils.ts` (the same interface-of-injected-repos/callbacks convention `LocalKeyDiscoveryUtils.ts` established),
with `BaseMailboxAccessRoute` now calling it too - zero behavior change, confirmed against its own full suite plus `test/routes/mailPrincipalSuite.ts`'s
much more thorough branch coverage (real auth-server fetch/502/timeout paths included), which caught one genuine regression in an early draft (a shared
`principalNotFoundMessage()` that trimmed the principal unconditionally, where the original `noUserFound()` never did) before it shipped. Two new
endpoints, both mirroring `resolve()`'s exact contract (exact-match, 400 on bad input, 404 `No user found for "..."`, rate-limited at 300/60s):
`GET /mail/mailboxes/resolve-owner` (`BaseMailboxRoute.resolveOwner()`, gated `@RequiresTrustedRole()` matching `ownerUserUid`'s own write gate) and
`GET /escrow/scopes/resolve-holder` (`BaseEscrowScopeRoute.resolveHolder()`, gated the same as `create()`/`update()`). Neither endpoint is gated more
strictly than the write it feeds by design - a stricter read-side gate than the write itself would add no real security, since the same caller could
just call the write directly.

Explicitly out of this pass's scope, confirmed rather than assumed: mailbox sharing's own `PrincipalPicker` (already fine); escrow access requests
(approvals always act on the caller's own JWT uid, never a typed field); distribution list membership (legitimately free-text addresses, not an
internal-uid problem); legal hold/matter custodians (mailbox uids, a different picker problem, left untouched); retention policy (a global singleton,
no user/mailbox targeting at all); admin impersonation (already a searchable mailbox list, not a blind uid box).

Files: new `src/util/PrincipalResolutionUtils.ts`, `test/routes/principalResolveEndpointSuite.ts`; changed `src/routes/BaseMailboxAccessRoute.ts`,
`src/routes/BaseMailboxRoute.ts`, `src/routes/BaseEscrowScopeRoute.ts`, `src/routes/sql/EscrowScopeRouteSQL.ts`, `test/routes/{mongo,sql}/MailboxRoute.test.ts`,
`test/routes/{mongo,sql}/EscrowScopeRoute.test.ts`. Full suite (combined with the Autodiscover work above, both landed in the same working tree): clean.

### 2026-09-22 (later) - Every escrow scope action now also requires elevation, not just a trusted role

JP's own call after I flagged it: the two new `resolve-owner`/`resolve-holder` endpoints above were gated to match their write paths exactly, which
for escrow raised the question of whether that write path itself should be stricter. Asked; answer was scope/holder management specifically, not the
M-of-N approval flow or a holder's own audit visibility (both deliberately usable by non-admin holders, see `BaseEscrowScopeRoute`'s doc comment on
"Separation of duties" - requiring elevation there would mean only elevated administrators could ever approve an access request, collapsing the very
separation the feature exists to enforce).

`BaseEscrowScopeRoute` gains a `protected trustedRoles: string[] = ["admin"]` field (it didn't have one) and calls `assertAdminScope(user,
this.trustedRoles)` - the same "trusted role AND elevated" gate `BaseSigningEnrollmentAdminRoute`/`BaseMailboxRoute`'s admin-scope reads already use -
as the first statement of every one of its ten `@RequiresTrustedRole()`-decorated actions (`resolveHolder`, `create`, `update`, `updateBulk`,
`updateProperty`, `truncate`, `delete`, `find`, `count`, `findById`). Deliberately first: an unauthorized caller is refused before any body validation
or repo lookup, so e.g. `updateBulk()`'s own non-array-body 400 is now unreachable without elevation too (found by `BaseAdminWriteGuards.test.ts`'s
existing direct-call unit test, which called `updateBulk()` with no user at all expecting 400 - fixed by passing a trusted, elevated one, since the
guard it's testing is a layer beneath the new elevation check, not a replacement for it).

Confirmed via `AdminShell.tsx` (web-client) that this is pure defense-in-depth, not a new restriction on the admin console's own UX: the whole admin
console, escrow scopes included, was already gated behind a single canary (`GET /admin/release-notes`, itself `@RequiresElevation()`) before any
section renders, independent of what individual routes required. What this closes is a direct-API-caller gap - a trusted-but-unelevated token (an
administrator's normal, non-console session) could previously call these endpoints directly without ever going through that UI gate.

New test: `test/routes/escrowControlsSuite.ts`'s "escrow scope management: a trusted role AND an elevated token, and nothing else" describe block, an
`it.each` table over all ten actions (mirroring `signingEnrollmentAdminSuite.ts`'s identical pattern) proving each is refused to an anonymous caller,
an ordinary user (`api-103`) and an unelevated administrator (`api-104`), and one further test that a trusted, elevated administrator still gets
through. Shared by both Mongo and SQL (`SecurityControls.test.ts`). No web-client or react-shared changes needed.

Files: changed `src/routes/BaseEscrowScopeRoute.ts`, `test/routes/escrowControlsSuite.ts`, `test/routes/BaseAdminWriteGuards.test.ts`. Full suite:
296/296 files, 7491/7491 tests, 100/97.26/100/100 (stmts/branch/func/lines).

### 2026-09-22 (later still) - Per-attendee personalized invite links, without restapi ever learning a plugin exists

A `@rapidmx/videoconf-plugin` mints a `VideoMeeting` with a distinct `joinToken` per invitee, and each invitee's iTIP `REQUEST` has to carry
*their own* join URL - which means `MeetingSchedulingJob` has to mail something it cannot compute, held in a table it must never import. The
dependency direction is the whole constraint: every plugin depends on `@rapidmx/restapi`, so `restapi` importing `@rapidmx/videoconf-plugin`
(or reading its tables by name) would invert it. Solved with a deliberately generic, plugin-agnostic hook rather than anything video-shaped:
a new `CalendarEventAttendeeLink` entity (`mailboxUid`, `calendarEventUid`, `attendeeAddress`, `url`, optional `label`) that *any* plugin
needing "each attendee gets their own personalized invite content" can write through a `RepoUtils` it builds itself over the exported
`CalendarEventAttendeeLinkMongo`/`CalendarEventAttendeeLinkSQL` - the same way `videoconf-plugin`'s routes already build one over the imported
`MailboxMongo`/`MailboxSQL`. No `@ApiRoute` and a deny-all `@Protect` (both `anonymous` and `.*` get `actions: []`), like every other
system-managed entity here: it is written and read only by trusted server-side code. Indexed on `calendarEventUid` (the job's only lookup) and
`mailboxUid` (scoped/erasure queries). `restapi` imports nothing from any plugin; `@rapidmx/videoconf-plugin` is named in prose, in doc comments
only, and never in an `import`.

`CalendarEvent.videoMeetingUid?: string` is the switch - a plain nullable string, no FK, styled after `Task.assignedTo`/`Task.taskListUid`, and
deliberately **unindexed**: nothing queries by it, the job only reads it off rows it already loaded. That is what buys the property this change
was designed around and which its regression test asserts directly (by spying on the job's own attendee-link repo and proving it was never
called): an event with no linked video meeting adds **zero** database reads and executes exactly the pre-existing code path. The single new
branch on the way to a send is `method === "request" && event.videoMeetingUid`, an in-memory field read placed *after* the shared
plain-address filter, organizer-excluding dedup, attendee cap and "nobody to mail" early return - all of which both paths still share verbatim.

What changes only for a `REQUEST` on an event that has one: instead of composing one `MailComposer`/ICS and fanning the same bytes out by
envelope, the job composes, scans and relays **one message per attendee**, each with `location` set to that attendee's own url (falling back
per-attendee to the event's plain stored `location` when there is no matching row) and, only when a url was substituted, a
`\n\nJoin the video call: <url>` line appended to the body. Every failure mode degrades rather than aborting: the link lookup itself throwing
logs a warning and is treated as an empty result (everyone falls back to the plain location); each attendee's compose+scan+relay is its own
try/catch logging the existing `failed to send <what> for event <uid> to <to>` line and continuing. That last one *generalizes* the class's
standing "Known limitation" posture rather than changing it - on this path "log and continue" now also covers a **scan refusal** of one
attendee's own copy, which cannot happen on the shared path (there is only one message there to refuse, and refusing it still fails the whole
event). The claim-then-send optimistic lock, the organizer-owned-rows-only check, the `encryptionOrigin === "originated"` skip and the attendee
cap are all provably untouched. `CANCEL` is unconditionally unchanged - a cancellation never needs a join link, so `sendCancellations()`/the
`"cancel"` path never looks anything up at all, asserted with its own regression test (both attendees still receive byte-identical bytes).

The organizer can never be mailed on the new path either, and that falls out structurally rather than from a new check: `recipients` already
excludes the organizer's own address, and the personalized loop only ever mails addresses that list holds - so even a contrived
`CalendarEventAttendeeLink` row for the organizer's address cannot produce a message (tested).

Tests follow this repo's shared-suite convention (`test/jobs/backgroundSendSuite.ts`'s shape): one new `test/jobs/meetingSchedulingLinkSuite.ts`
called from inside both `MeetingSchedulingJob{Mongo,SQL}.test.ts`, covering the no-`videoMeetingUid` regression (including the zero-extra-queries
assertion), full/partial/zero row matches, case-insensitive address matching, rows belonging to a different event, a throwing lookup, the
organizer, an unaffected CANCEL, a per-attendee transport rejection and a per-attendee scan refusal. Both job test files also register the new
entity in their `models` map (a bare TypeORM `DataSource`/`MongoConnection` here needs every entity named explicitly - no `ClassLoader` scan).

Files: new `src/models/mongo/CalendarEventAttendeeLinkMongo.ts`, `src/models/sql/CalendarEventAttendeeLinkSQL.ts`,
`test/jobs/meetingSchedulingLinkSuite.ts`; changed `src/models/types.ts`, `src/models/mongo/CalendarEventMongo.ts`,
`src/models/sql/CalendarEventSQL.ts`, `src/models/{mongo,sql}/index.ts`, `src/jobs/MeetingSchedulingJob.ts`,
`src/jobs/mongo/MeetingSchedulingJobMongo.ts`, `src/jobs/sql/MeetingSchedulingJobSQL.ts`, `test/jobs/{mongo,sql}/MeetingSchedulingJob*.test.ts`,
`test/models/{mongo,sql}.test.ts`, `RELEASE_NOTES.md` (Unreleased section; no version bumped, nothing committed). No `package.json` change needed - `@rapidmx/restapi/mongo`/`/sql` already re-export the whole model barrel, so
both new classes are importable by a plugin the moment this builds. `server` does not subclass `MeetingSchedulingJob` (it only re-exports
`MeetingSchedulingJob{Mongo,SQL}` from `src/{mongo,sql}/Jobs.ts`), so nothing there needs rebuilding for this.

### 2026-09-22 (later still) - `CalendarReminderJob`'s push event also carries `location`

Small, standalone addition, requested for a web-client tweak: a meeting reminder pop-up wants a "Join Meeting" button
when the event's own `location` looks like a URL. `sendMessage()`'s payload gains `location: event.location` alongside
`eventUid`/`title`/`startDate` - plain, undecorated text, verbatim, exactly as `location` is already shown anywhere
else in this codebase. Confirmed safe to read directly: field-level encryption of `location` is deferred, future work
(see `CalendarEvent.encryptionOrigin`'s own doc comment) - nothing here reads ciphertext, because there isn't any yet.

One real Mongo-vs-SQL difference this surfaced: a fresh SQL read of an unset nullable `text` column comes back `null`,
not `undefined`, so the reminder payload's `location` is `null` on SQL for an event with none, while Mongo's is
genuinely absent (`JSON.stringify()` drops an `undefined` key entirely). Both existing tests that assert the full
payload shape needed updating for SQL's `location: null`; a new test on each backend proves a real `location` value
comes through unchanged.

Files: changed `src/jobs/CalendarReminderJob.ts`, `test/jobs/{mongo,sql}/CalendarReminderJob{Mongo,SQL}.test.ts`.
Scoped verification (this repo's own uncommitted working tree currently also carries an unrelated domain-aliasing
feature from a peer session, whose pre-existing lint errors in files this change never touches block a plain
`yarn test:prod` - verified this change in isolation instead): `npx eslint` on every file this touches, clean; scoped
coverage on `CalendarReminderJob.ts` alone, 100%/96.82%/100%/100% (the two uncovered branches are pre-existing,
unrelated to this change - confirmed by line number).

### 2026-09-22 (later still) - Pure domain aliases: a `Domain` with no mailboxes of its own

JP's ask: `plc.gg` as a shorthand alias of `powerlevel.gg`, so `jean-philippe@powerlevel.gg` can receive AND send as
`jean-philippe@plc.gg`, with no `Mailbox`/`DistributionList` ever created at `plc.gg` itself.

**Design.** New optional `Domain.aliasOf` (a domain name, matching the target's own `uid`). An alias domain still goes
through the exact same DNS-ownership-proof and DKIM-key-generation flow as any other `Domain` (`BaseDomainRoute`
untouched there) - it is a real, independently-verified domain in its own right, just one with no addressable entities
of its own. Three new `util/DomainUtils.ts` functions carry the whole feature:
- `getPrimaryDomainNames()` - `getVerifiedDomainNames()` minus any row with `aliasOf` set. This is the list
  `BaseMailboxRoute`/`BaseDistributionListRoute` actually restrict a *new* address to (create, rename, the self-service
  `assertSelfServiceCreate()`/`autoProvision()` domain choices, and the `GET /mailboxes/domains` list a client's "New
  mailbox" form reads) - an alias domain is deliberately excluded from all of them. `getVerifiedDomainNames()` itself is
  untouched and still includes alias domains, which is correct: `BaseMailIngestRoute.domain()` (the MTA's relay-accept
  check) and `isInternalAddress()`/`classifyRecipientTier()` should both still treat mail to/from an alias domain as
  this server's own.
- `resolveDomainAlias(objectFactory, domainClass, address)` - two indexed `findOne`s (never a full domain scan): if
  `address`'s domain is a currently enabled+verified alias whose `aliasOf` target is itself currently enabled+verified,
  returns the same local part on the target's own name; otherwise `undefined` (dangling/disabled reference resolves to
  nothing, never misroutes). Wired into `BaseMailIngestRoute.findExactMailboxByAddress()`/`findDistributionListByAddress()`
  as a fallback retry after a direct match misses - this is the ONE place inbound delivery actually resolves an alias,
  and it's why `resolve()`/`deliver()`/`expandDistributionList()`'s member loop/`reportUnresolvableRecipient()` all pick
  it up for free (they all funnel through those two methods). Also wired into `util/LocalKeyDiscoveryUtils.ts`'s
  `findMailbox()` (new optional `LocalKeyDiscovery.resolveDomainAlias` field, wired from both
  `BaseKeyLookupRoute.localKeyDiscovery()` and `ScanQueueJob.maybeRefreshRotatedKey()`) so federation key discovery for
  an alias address finds the primary mailbox's own published keys instead of "nothing published here."
- `getAliasDomainNames(objectFactory, domainClass, primaryDomainName)` - the reverse lookup (every enabled+verified
  domain whose `aliasOf` names this one). Used only by `BaseMessageRoute.assertSenderAllowed()`, now `async`: for each
  domain among a mailbox's own addresses (`primarySmtpAddress` + `aliasAddresses`), every alias domain of it lets that
  same local part send too - so `jean-philippe@powerlevel.gg` can send as `jean-philippe@plc.gg` with **zero**
  per-mailbox configuration, the whole point of a *pure* alias. `BaseDomainRoute` validates `aliasOf` on both create and
  update: must name an existing `Domain`, that domain must not itself be an alias (no chains - every alias resolves in
  exactly one hop), no self-alias, and turning a domain that already HAS dependents into an alias itself is refused the
  same way (checked before the chain check, so the more specific 409 wins over the generic 400). `delete()` refuses
  removing a domain other domains still alias (`IDENTIFIER_EXISTS`/409, same convention as `BaseMatterRoute`'s
  "still has EscrowAccessRequests referencing it").

**DKIM/DNS needs no restapi change at all.** Since an alias domain is an ordinary `Domain` row that goes through
`BaseDomainRoute.create()`/`dnsSetup()` unchanged, `FsDkimKeyProvider`/OpenDKIM signing infra (see the 2026-09-09 and
2026-09-20 entries above) picks it up automatically, keyed by its own `domain.name` - no new integration point needed.

**Regression found the hard way: several "isolated unit test" files construct a lightweight `TestMailIngestRoute` (or
similar) that never sets `domainClass` at all** (only `mailboxClass`/`ingestQueueClass`/`distributionListClass`/
`transportRuleClass`), because before this change `domainClass` was only ever touched by `applyTransportRules()` when
at least one enabled `TransportRule` exists - every such harness registers zero rules, so the field was never
exercised. My first version of `findExactMailboxByAddress()`/`findDistributionListByAddress()` called
`resolveDomainAlias()` unconditionally on every failed direct lookup, which now touches `domainClass` on **every**
delivery regardless of transport rules, and `getDomainRepo()` throws on `domainClass.name` with `domainClass`
`undefined`. Confirmed via a full, uncontended `yarn vitest run`: `test/routes/BaseMailIngestRoute.DistributionLists.test.ts`
failed 8/8, all the same `Cannot read properties of undefined (reading 'name')` stack. Fixed at the source
(`resolveDomainAlias()` returns `undefined` immediately when `domainClass` is falsy - the same
"unwired-optional-dependency degrades gracefully" posture `DkimKeyProvider`'s own doc comment already establishes for
`NullDkimKeyProvider`), not by patching every lightweight test harness - a real Mongo/SQL route subclass always
supplies `domainClass`, so this only ever matters for exactly this class of test double.

**A second, false-alarm regression while chasing the first one**: running a second, separate `yarn vitest run` against
this repo (a narrow `--coverage.include` probe) WHILE the first full-suite run was still going produced 34 unrelated
failures in `test/routes/sql/RoutesKeysRound5.test.ts` (owner ACL moves, display names, attachments-follow-folder) -
nothing to do with domains at all. Re-ran that file alone: 9/9 clean. This is the same "two vitest processes racing the
one shared on-disk SQLite file" hazard this file's own SQL-datastore entries already warn about elsewhere in this
document - **never run a second `vitest run` against this repo while another one is already in flight**; wait for it to
finish (or scope both to disjoint files you're certain don't share the SQL fixture file) instead.

New/changed tests: `test/util/DomainUtils.test.ts` (`getPrimaryDomainNames`/`getAliasDomainNames`/`resolveDomainAlias`,
including the just-described unset-`domainClass` guard), `test/routes/{mongo,sql}/DomainRoute.test.ts` (`aliasOf`
create/update validation - self-alias, chain, dangling reference, turning a domain-with-dependents into an alias,
round-tripping the same value as a no-op, delete guard both directions), `test/routes/{mongo,sql}/MailIngestRoute.test.ts`
(`/domain`, `/resolve`, `/deliver` through an alias domain, to both a `Mailbox` and a `DistributionList`, plus the
disabled-alias-domain no-op case), `test/routes/mongo/DistributionListDomains.test.ts` +
`test/routes/sql/DistributionListDomains.test.ts` (alias domain rejected for a new list's address), new `describe("domain
alias")` blocks in `test/routes/{mongo,sql}/MailboxRoute.test.ts` (create/rename rejected on an alias domain,
`GET /mailboxes/domains` excludes it) and `test/routes/{mongo,sql}/MessageRoute.test.ts` (send-as-alias allowed with zero
config, refused for an unrelated alias, and the two-different-owned-domains case that's the only way to hit
`assertSenderAllowed()`'s inner-loop `continue` branch), `test/util/LocalKeyDiscoveryUtils.test.ts` (`resolveDomainAlias`
wired vs. unwired, including the plus-tag-after-rewrite case).

Files: changed `src/models/types.ts` (`Domain.aliasOf`), `src/models/mongo/DomainMongo.ts`, `src/models/sql/DomainSQL.ts`,
`src/util/DomainUtils.ts`, `src/routes/BaseDomainRoute.ts`, `src/routes/BaseMailboxRoute.ts`,
`src/routes/BaseDistributionListRoute.ts`, `src/routes/BaseMailIngestRoute.ts`, `src/routes/BaseMessageRoute.ts`,
`src/routes/BaseKeyLookupRoute.ts`, `src/jobs/ScanQueueJob.ts`, `src/util/LocalKeyDiscoveryUtils.ts`, `RELEASE_NOTES.md`
(Unreleased > Features; no version bumped, nothing committed) and the test files listed above. Full suite (clean,
uncontended run): **296/296 files, 100/97.18/100/100 (stmts/branch/func/lines)** - gates 100/95/100/100. `yarn tsc
--noEmit` clean.

Companion changes (separate repos, same session): `@rapidmx/react-shared`'s `admin/domainsApi.ts` gains `aliasOf` on
`Domain`/`CreateDomainInput`/`UpdateDomainInput` (pure type addition, no logic - full suite unaffected, still 96/96
files/1264/1264 tests); `@rapidmx/web-client`'s domains admin pages (`new`, detail, list) gain an alias-of
picker/display/edit/column (full suite 273/273 files, 4180/4180 tests). Neither is wired into `server`'s own
`node_modules` yet (both are real npm deps there, not portal/workspace links - see this file's own "monorepo checkout"
entry) - `web-client`'s own `tsc --noEmit` won't go green on the new `aliasOf` usages until `react-shared` actually
publishes and `web-client` bumps its dependency, same release order every prior cross-repo client addition in this log
has followed. No `package.json` version bumped anywhere, nothing committed.

### 2026-09-22 (later still) - Adversarial-review pass: SSRF/hijack/quota/pagination/iTIP-race fixes

An external adversarial review round (several passes, including self-delegated sub-agents) against this repo turned
up a priority-ordered list of confirmed issues. Worked through in severity order; here's what actually landed, in the
same order.

**1. [CRITICAL] SSRF bypass in `KeyDiscoveryClient.isSafeDiscoveryHost()` via numeric IP notation.** It rejected an
IP-literal `host` via `net.isIP(withoutPort) !== 0`, but `net.isIP()` doesn't recognize decimal/octal/hex IPv4 forms
(`2852039166` = `169.254.169.254`) that Node's `fetch()`/the WHATWG `URL` parser still normalize to the real
dotted-quad with no DNS lookup - verified directly (`new URL('https://2852039166/x').hostname ===
'169.254.169.254'`). Fixed by re-checking `net.isIP()` against `new URL(\`https://${host}/\`).hostname` (the
URL-parser-normalized form) after the syntax check passes, closing the bypass regardless of encoding base. Also added
a port allow-list (`443`/`8443` - `ALLOWED_DISCOVERY_PORTS`) in place of the previous unrestricted 1-65535 range. The
existing DNS-rebinding residual-gap doc comment is preserved verbatim, per the review's own explicit instruction not
to touch it - that gap needs real DNS pinning, a separate, larger undertaking.

**2. [HIGH] `BaseMailboxRoute.validateAliasChange()` used `getVerifiedDomainNames()` (includes alias domains)
instead of `getPrimaryDomainNames()`.** Every sibling check in this file was correctly updated when `Domain.aliasOf`
landed (see the entry above) except this one - a caller could add e.g. `boss@plc.gg` (alias of `powerlevel.gg`) to
their OWN mailbox's `aliasAddresses`, hijacking mail/send-as/key-discovery for whatever mailbox `boss@powerlevel.gg`
actually resolves to (`findExactMailboxByAddressRaw()`/`LocalKeyDiscoveryUtils.findMailbox()` both match
`aliasAddresses` by exact literal BEFORE `resolveDomainAlias()` ever runs). Fixed the one line. Also closed the
related pre-existing gap `createMailboxes()` had: it only ever validated `primarySmtpAddress`'s domain at create
time, never `aliasAddresses`' - added the same `getPrimaryDomainNames()` check there too, for both the trusted and
self-service (`assertSelfServiceCreate()`) paths (the latter's own `domains` list was itself still
`getVerifiedDomainNames()`-derived - fixed to `getPrimaryDomainNames()` as well, which changes its ownership-check
denominator too, not just create()'s own explicit domain gate).

**3. [MEDIUM] `BaseKeyDiscoveryRoute` (the public `.well-known/rapidmx/keys/:hash` endpoint) never resolved alias
domains** - it had no `domainClass` at all (only `mailboxClass`/`keyVaultClass`), so a peer querying `?domain=plc.gg`
for an address whose mailbox actually lives at `you@powerlevel.gg` always got the indistinguishable-from-real
"nothing published" response, which could make a compose client send unencrypted. Factored the domain-name-only half
of `resolveDomainAlias()` out into a new `resolveDomainAliasName(objectFactory, domainClass, domainName)` (bare
domain in, primary domain name or `undefined` out - no local part involved, since `:hash` is a one-way hash of it and
the public endpoint never sees a real local part at all) and wired a new `domainClass` into `BaseKeyDiscoveryRoute`
plus both Mongo/SQL subclasses. `lookup()` tries the literal domain match first (unchanged), and only on a miss
resolves `?domain=`/`Host` via `resolveDomainAliasName()` and retries against the primary. This route had real tests
already (contrary to the review's belief it had none) - added the alias-domain-lookup case plus a
disabled/dangling-alias no-op case to both backends' files.

**4. [MEDIUM] Mailbox storage quota was never enforced at write time on attachment upload** - only
`MailboxImportJob`'s own `chargeQuota()` did; `BaseAttachmentRoute.upload()` and `ScanQueueJob`'s inbound delivery
both wrote first and let `MailboxQuotaRecalcJob`'s hourly pass reconcile the drift after the fact. Extracted
`MailboxImportJob`'s charge/refund loop into a new shared `util/MailboxQuotaUtils.ts`
(`chargeMailboxQuota()`/`refundMailboxQuota()`, generic over any `RepoUtils<Mailbox>`) - `MailboxImportJob` itself
now delegates to it with no behavior change (its own `MailboxQuotaExceededError`/`assertWithinQuota()` pre-check
stay local, translating the shared function's own exceeded-error into the same "Import stopped: ..." message
existing tests already assert on). Wired the shared function into `BaseAttachmentRoute.upload()`: charges before
`blobStore.put()`, 413s on `MailboxQuotaExceededError`, refunds on any failure after a successful charge. Also added
a `mail:attachments:max_bytes` (default 50 MiB) ceiling checked before anything else touches the uploaded bytes.

**Not done: `ScanQueueJob`'s inbound delivery path.** First attempt wired the identical charge-before-file pattern
into `deliverMessage()`, gating it on a genuinely-new-primary-filing check (`!alreadyFiled && !filterResult.deleted`)
and quarantining (new `QuarantineReason.QUOTA_EXCEEDED`) instead of filing on `MailboxQuotaExceededError`. A full,
uncontended `vitest run` of `test/jobs/mongo/ScanQueueJobMongo.test.ts` came back **75/214 failed** - the vast
majority of this file's test fixtures stage `IngestQueueEntry` rows against a `mailboxUid` with NO corresponding
`Mailbox` row ever created (delivery never needed one to exist before), and `chargeMailboxQuota()`'s own
`mailboxRepo.findOne()` throwing "The target mailbox no longer exists." on a genuinely absent mailbox turned that
into a hard failure across dozens of unrelated tests instead of the intended narrow quota check. Reverted the
`ScanQueueJob.ts`/`models/types.ts` (`QuarantineReason.QUOTA_EXCEEDED`) changes entirely rather than either (a)
retrofitting a real `Mailbox` row into 75+ existing test cases across two ~5,000-line files, disproportionate for
this pass, or (b) special-casing "mailbox not found" to silently skip the quota check, which would quietly reopen
the exact gap this fix exists to close for any genuinely-missing-mailbox edge case. Documented as a Known Issue in
`RELEASE_NOTES.md` and left for a dedicated follow-up. **Lesson for next time touching this file**: check whether a
new required lookup's target row actually exists in this file's own test fixtures BEFORE wiring the lookup in, not
after - this file's sheer size (10k+ lines across both backends) makes a full run the only reliable signal, and it's
slow enough that mid-run edits to files it's actively reading produce misleading stale-content failures (see below).

**5. [HIGH] `BaseMailboxImportRoute.create()` had no upload-size ceiling at all** - `MailboxImportJob`/
`PstImportUtils` read the whole file into one `Buffer` before `PstAllocationBudget` (bounds *extracted* output only)
ever runs, so a large authenticated upload could OOM-crash the whole Node process every `BackgroundService` job
shares. Added a `mail:import:max_bytes` (default 500 MiB, `DEFAULT_MAX_IMPORT_BYTES`) check immediately after the
existing empty-body check, before any mailbox/folder DB lookup or the blob write.

**6. [MEDIUM] `RetentionEnforcementJob.purgeSortedBatches()`'s offset pagination could silently skip a due row** -
`page = floor(skipped/pageSize)` plus slicing away `skipped % pageSize` rows assumed those rows were still
physically at the front of the result set; a `delete()` that threw AFTER actually committing (e.g. post-commit
timeout) broke that assumption and sliced away a fresh, never-examined row instead. Switched to keyset pagination on
`uid` (`uid > <last page's last uid>`, sorted `uid` ASC - the same cursor shape `util/MailboxContentUtils.ts`'s
`findPagesByUid()` already uses), which advances past every row a page reads regardless of what happened to it, so a
physically-vanished row can never shift what a later page sees. Traversal order changes from oldest-`dateField`-first
to `uid`-order (the `dateField < cutoff` filter is unaffected - only visitation order within one run changes). The
existing test that PINNED the buggy behavior (`test/jobs/mongo/RetentionEnforcementJobMongo.test.ts`, "Stops mid-page
at the batch size when a row counted as skipped vanished underneath the page offset") is rewritten to assert the
CORRECT behavior, using explicit lexically-ordered `uid`s (`msg-0`..`msg-5`) so the new uid-based traversal order is
deterministic in the test rather than depending on whatever uid a real backend assigns. Added the identical SQL-side
test (there wasn't one before).

**7. [MEDIUM-HIGH, silent data loss] iTIP REPLY/CANCEL/REQUEST-update version conflicts were silently swallowed.**
`maybeProcessItipMessage()`'s outer `try/catch` only ever `logger.warn()`'d a version conflict from a plain
`update()` inside `processItipReply()`, `processItipCancel()` (via `deleteReceivedEventCopy()`) and the
REQUEST-update branch of `processItipRequest()` - two attendees replying to the same invite near-simultaneously (an
ordinary race, not a hypothetical) meant the loser's RSVP was permanently dropped while the ingest entry still
closed `DELIVERED`. Added a new private `updateCalendarEventWithRetry(uid, mutate, options?, attempts=3)` helper
(same re-fetch-and-retry-on-409 shape `claimDeliveryReceipt()`/`writeContactKeys()` already use elsewhere in this
file) and routed all four call sites through it; `mutate` receives the freshly-read row on every attempt so the
staleness/SEQUENCE check is re-evaluated against current data each retry, not just the caller's original (possibly
stale) read.

**8. [MEDIUM] `decideResourceBooking()` TOCTOU double-booking - not fixed.** Two concurrent iTIP REQUESTs for
overlapping times on the same resource, processed by two workers, can both read "no conflict" before either commits.
A real fix needs mutual exclusion across the read-decide-commit span for one resource mailbox, and this codebase has
no reusable lock/lease primitive for an arbitrary keyed resource today (`ScheduledSendJob`/`ScanQueueJob`'s own
"lease" fields are all claims on the ROW BEING PROCESSED itself, e.g. `scanLeaseExpiresAt` on `IngestQueueEntry`,
not a generic "lock resource X" construct). Introducing one would mean a new persisted lease field on `Mailbox`
across both Mongo and SQL models plus a restructure spanning `decideResourceBooking()`+`processItipRequest()`'s
commit - a bigger, separate undertaking than this pass's remaining budget allowed for safely, especially against
this same large `ScanQueueJob.ts` file (see finding 4's own lesson above). Documented as a Known Issue.

**9. [MEDIUM-LOW] New-`CalendarEvent` branch of `processItipRequest()` used a random uid.** Unlike the
message-delivery path's `nameBasedUuid('ingest:' + entry.uid + ':target')`, a duplicate-delivered REQUEST processed
as two concurrent `IngestQueueEntry` rows could create two `CalendarEvent` rows for the same meeting and double-fire
booking replies. Uid is now `nameBasedUuid(\`itip:${mailboxUid}:${parsed.uid}:${parsed.recurrenceId?.toISOString()
?? "master"}\`)` - deterministic per `(mailbox, icalUid, recurrenceId)`, so a second concurrent create collides on
the unique index and throws (caught by the same outer `try/catch` that already logs-and-continues), rather than a
duplicate row and a duplicate reply.

**10. [LOW, defense-in-depth] `isPathKey()` now also flags `__proto__`/`constructor`/`prototype`.** Not currently
exploitable (every write path here spreads rather than `Object.assign`s), but closes the gap against this function's
own documented "never a plain field name" contract. Test uses `JSON.parse('{"__proto__":...}')` rather than an
object literal - a literal `{ __proto__: {...} }` sets the actual prototype instead of creating an own enumerable
property, but `JSON.parse()` (what a real HTTP body goes through) does create one, which is the actual attack shape.

**11. [LOW, doc-only] Stale `@rapidmx/videoconf-plugin` prose** in `models/types.ts`/`CalendarEventMongo.ts`/
`CalendarEventSQL.ts` doc comments, from before the plugin was renamed `@rapidmx/meet-plugin` - updated, no
functional change.

**Two items folded in mid-task from a second reviewer pass, same session:**
- **Three routes' `$`-key stripping was top-level-only** (`BaseMatterRoute.stripClientQuery()`,
  `BaseEscrowAccessRequestRoute.find()`, `BaseEscrowAuditLogRoute.buildFilter()` all used
  `!key.startsWith("$")`) instead of the segment-aware `!key.split(".").some((s) => s.startsWith("$"))` every other
  route in this codebase uses (`BaseScopedChildRoute`/`BaseFolderRoute`/`BaseMailboxRoute`/`BaseAttachmentRoute`) -
  a nested key like `escrowScopeId.$where` could slip past unstripped. Not currently exploitable (`service-core`
  2.1.0's `ModelUtils` independently re-validates with the identical segment-aware check before a query could ever
  see it), but a real inconsistency - all three now match. No dedicated regression test added (the fix is a pure
  belt-and-suspenders duplicate of a check `ModelUtils` already enforces downstream, so a black-box HTTP test can't
  observe a behavior difference pre/post-fix - both paths already 400 via `ModelUtils`); verified by full existing
  suites for all three routes staying green (161/161) plus `tsc`/`eslint` clean.
- **`postfix-bridge` started percent-encoding each envelope address before joining `X-Envelope-From`/
  `X-Envelope-To`** (its own fix for a recipient-list-ambiguity bug), which needed a companion decode on this side
  to actually restore full address fidelity rather than just correct recipient count. `BaseMailIngestRoute.deliver()`
  did a naive `.split(",")` on `X-Envelope-To` with no decoding at all (confirmed by reading the code before
  touching it). Added a `decodeEnvelopeAddress()` helper (try/decode, fall back to the raw segment on malformed
  percent-encoding rather than failing the whole delivery) applied to both the single `X-Envelope-From` header and
  each `X-Envelope-To` segment after splitting - backward compatible, since a plain ASCII address with nothing
  percent-encoded round-trips through `decodeURIComponent()` unchanged. Updated `transport/MTAIngestAdapter.ts`'s
  own contract doc to document the encoding requirement. New test in both `MailIngestRoute.test.ts` backends
  covers a comma-AND-non-ASCII address in one, asserting it arrives as exactly one recipient with the comma and
  non-ASCII character both intact, not split or mangled.

**A process note on editing files while a full suite runs in the background**: mid-task, a background
`vitest run --coverage` was kicked off to get a clean baseline before committing, and (incorrectly) 5 more files
were edited for findings 6/9/10 while it was still in flight. That run came back with 7 failures, every single one
in a file edited during the run (`RequestBodyUtils.test.ts`, both `RetentionEnforcementJob*.test.ts`, both
`MailboxImportRequestRoute.test.ts`) - a stale-read artifact of vitest transforming/loading a file mid-edit, not a
real regression (confirmed: every one of those 5 files passes clean, individually, once the background run had
actually finished and nothing was mid-edit). Re-ran a second, fully clean, uncontended full suite afterward before
committing - this file's own SQLite/mongod concurrent-run hazards, already documented elsewhere in this log, extend
to "don't edit files a long-running suite hasn't gotten to yet" too, not just "don't run two suites at once."

New/changed tests: `test/util/KeyDiscoveryClient.test.ts` (decimal/octal/hex IP-literal rejection), `test/routes/
{mongo,sql}/MailboxRoute.test.ts` (`aliasAddresses` PUT/create rejected on an alias domain, both directly and via
`aliasAddresses`), `test/routes/{mongo,sql}/MailboxAutoProvision.test.ts` (self-service create/PUT alias-domain
rejection, trusted create's `aliasAddresses` domain check), `test/routes/{mongo,sql}/KeyDiscoveryRoute.test.ts`
(alias-domain lookup, disabled/dangling-alias no-op), `test/routes/{mongo,sql}/AttachmentRoute.test.ts` (quota
charge on upload, quota-exceeded 413, max-upload-size 413), `test/jobs/{mongo,sql}/MailboxImportJob{Mongo,SQL}
.test.ts` (unchanged behavior after the `MailboxQuotaUtils` refactor - all pre-existing quota tests still pass
verbatim), `test/routes/{mongo,sql}/MailboxImportRequestRoute.test.ts` (oversized-upload 413), `test/jobs/
{mongo,sql}/RetentionEnforcementJob{Mongo,SQL}.test.ts` (rewritten pinned test + new SQL-side equivalent),
`test/routes/{mongo,sql}/MailIngestRoute.test.ts` (percent-encoded envelope address decoding), `test/util/
RequestBodyUtils.test.ts` (`__proto__`/`constructor`/`prototype` rejection via `JSON.parse()`).

Files: changed `src/util/KeyDiscoveryClient.ts`, `src/routes/BaseMailboxRoute.ts`, `src/routes/
BaseKeyDiscoveryRoute.ts`, `src/routes/mongo/KeyDiscoveryRouteMongo.ts`, `src/routes/sql/KeyDiscoveryRouteSQL.ts`,
`src/util/DomainUtils.ts` (new `resolveDomainAliasName()`), `src/util/MailboxQuotaUtils.ts` (new),
`src/jobs/MailboxImportJob.ts`, `src/routes/BaseAttachmentRoute.ts`, `src/routes/mongo/AttachmentRouteMongo.ts`,
`src/routes/sql/AttachmentRouteSQL.ts`, `src/routes/BaseMailboxImportRoute.ts`, `src/jobs/RetentionEnforcementJob.ts`,
`src/jobs/ScanQueueJob.ts` (findings 7/9 only - finding 4's ScanQueueJob change was reverted), `src/util/
RequestBodyUtils.ts`, `src/routes/BaseMatterRoute.ts`, `src/routes/BaseEscrowAccessRequestRoute.ts`, `src/routes/
BaseEscrowAuditLogRoute.ts`, `src/routes/BaseMailIngestRoute.ts`, `src/transport/MTAIngestAdapter.ts`,
`src/models/types.ts` (doc-only), `src/models/mongo/CalendarEventMongo.ts` (doc-only), `src/models/sql/
CalendarEventSQL.ts` (doc-only), `RELEASE_NOTES.md`, and the test files listed above.

### 2026-09-22 (later still, round 2) - Follow-up: DistributionList alias validation, ScanQueueJob quota re-fix (the actual root cause), iTIP retry regression tests, mailbox-import size cap that now has teeth

A second reviewer pass on the round above found the finding-4 revert (ScanQueueJob quota enforcement) needed a
real second attempt rather than staying reverted, plus 4 more items. All addressed in one follow-up commit:

**1. [HIGH] `BaseDistributionListRoute`'s `aliasAddresses` had ZERO validation** - not the alias-domain check, not
the ordinary domain check, no collision check - even though `BaseMailIngestRoute` resolves and trusts a
distribution list's `aliasAddresses` identically to a mailbox's. Fixed by mirroring `BaseMailboxRoute`'s already-
fixed pattern exactly: a new `aliasQueryValue()` (Mongo: `ModelUtils.literal()`; SQL: the same `Raw()` LIKE-pattern
override `MailboxRouteSQL` uses for its serialized `simple-json` column), `validateAliasAddresses()`
(`getPrimaryDomainNames()`-based domain check + collision check against every other Mailbox/DistributionList's
uid/primary/alias) called from `create()`, and `validateAliasAddressChange()` (diffs against the existing value so
only *newly added* aliases get re-validated on `update()`) called from `update()`. New tests in both
`test/routes/{mongo,sql}/DistributionListDomains.test.ts` (5 each): plain-domain rejection, alias-domain rejection
on create, acceptance on a verified non-alias domain, PUT rejection, 409 on collision with an existing
mailbox/list address.

**2. [MEDIUM, the actual priority item] ScanQueueJob quota enforcement was reverted in the first pass over 75
test failures - re-investigated instead of leaving it reverted, and the reviewer's hypothesis was exactly right.**
`chargeMailboxQuota()` requires an existing `Mailbox` row and threw a plain `Error` when none was found; almost
every `ScanQueueJobMongo.test.ts`/`ScanQueueJobSQL.test.ts` fixture stages an `IngestQueueEntry` against a
`mailboxUid` with no real `Mailbox` row, since ordinary delivery never needed one before. Root-caused and fixed
properly this time:
- `MailboxQuotaUtils.ts` gets a new `MailboxNotFoundError` (distinct type, not a message-string match) thrown
  instead of a plain `Error` when `mailboxUid` names no current row.
- `ScanQueueJob.deliverMessage()` now returns `Promise<boolean>` (`false` = quarantined instead of filed) and
  calls a new private `chargeMailboxQuotaForDelivery()` wrapper: `MailboxQuotaExceededError` -> `false`
  (quarantine, new `QuarantineReason.QUOTA_EXCEEDED`, re-added to `models/types.ts`); `MailboxNotFoundError` ->
  `true` with a `logger.debug()` note (gracefully skip enforcement rather than fail an otherwise-deliverable
  message over a row that was never required before); anything else re-thrown as a real failure. This is the
  key distinction the first attempt got wrong - it treated every non-quota-exceeded error as fatal.
- `processEntry()` only fires `maybeSendAutoReplyOnce()`/`maybeProcessItipMessage()` when `deliverMessage()`
  actually returned `true` (a quarantined message gets neither).
- This closes the actual vector this whole review round exists for: `BaseAttachmentRoute.upload()` needs an
  authenticated caller with UPDATE access; `ScanQueueJob`'s inbound delivery needs nothing at all, so before this
  fix any external sender could flood a mailbox past quota with zero authentication, completely unmitigated
  except by the hourly `MailboxQuotaRecalcJob` reconciliation (after the fact, not preventative).
- Verified clean: `ScanQueueJobMongo.test.ts` 75/214 failing -> 217/217 passing (214 + 3 new, below), 
  `ScanQueueJobSQL.test.ts` 198/198 -> 201/201, both AcmeChallenge variants 20/20, with no other regressions.

**3. [HIGH] The mailbox-import size check (`mail:import:max_bytes`, added in the first pass) had no practical
effect under the reference deployment.** `server/src/config.defaults.ts` sets the framework's own `max_body_size`
(enforced on every request's raw body before ANY route code runs, including this one) to 100 MiB
(`DEFAULT_MAX_BODY_SIZE_BYTES`), while restapi's own `DEFAULT_MAX_IMPORT_BYTES` defaulted to 500 MiB - every
upload large enough to reach the new check would already have been rejected one layer up first, so the new check
protected against nothing in the shipped default configuration. Fixed two ways:
- Lowered `DEFAULT_MAX_IMPORT_BYTES` to 90 MiB - safely below the reference deployment's `max_body_size` so this
  check is actually the one that fires (and gives a specific, on-brand 413 message instead of the framework's
  generic one).
- Discovered `@rapidrest/service-core`'s `Server.js` reads `max_body_size` via `this.config.get("max_body_size")`
  (confirmed by reading `node_modules/@rapidrest/service-core/dist/lib/Server.js` directly) - an ordinary,
  unnamespaced top-level config key, readable via the exact same `@Config()` decorator this codebase already uses
  everywhere else. `BaseMailboxImportRoute` now injects it (`@Config("max_body_size", FRAMEWORK_DEFAULT_MAX_BODY_SIZE)`,
  falling back to the framework's own hardcoded 10 MiB default - `DEFAULT_MAX_BODY_SIZE` in
  `http/uWS/Adapters.js` - when unset) and `init()` logs a one-time `logger.warn()` if `mail:import:max_bytes`
  ends up configured at or above it, so this class of misconfiguration doesn't go silently unnoticed a second
  time. No test added for the warning itself (it's a log-line side effect of config values, not an HTTP-observable
  behavior change) - covered by `tsc`/`eslint` staying clean and the existing `MailboxImportRequestRoute.test.ts`
  suites (44/44) staying green, since both set `mail:import:max_bytes` well under the 10 MiB fallback and never
  trigger the new warning path.
- Updated `RELEASE_NOTES.md` to describe the real vulnerability (the first version protected against nothing) and
  the real fix, not just "added a cap."

**4. [MEDIUM] The iTIP retry (`updateCalendarEventWithRetry`-shaped fixes) and dedup-uid fixes from the first-pass
commit had zero regression tests** - confirmed by `git show <first-pass-commit> --stat` touching no
`test/jobs/*/ScanQueueJob*.test.ts` file at all. Added 3 new tests to each of `ScanQueueJobMongo.test.ts`/
`ScanQueueJobSQL.test.ts`:
- A REPLY that loses the optimistic-lock race (409) on attempt 1 but succeeds on retry - asserts the final
  `responseStatus` reflects the RSVP and `attempts >= 2`.
- A REPLY that loses the race on every retry attempt - asserts `logger.error()` was called (see item 5 below),
  the attendee's `responseStatus` stays unchanged, and the ingest entry still closes `DELIVERED` (documenting the
  known remaining limitation, not just the fix).
- Two concurrent `IngestQueueEntry` rows for the same iTIP REQUEST (same `icalUid`/`recurrenceId`, different raw
  blob keys, same ICS body) processed in one `job.run()` - asserts exactly one `CalendarEvent` row exists
  afterward and both ingest entries close `DELIVERED` (the second collides on the deterministic uid instead of
  creating a duplicate).

**5. [MEDIUM] Docs overclaimed what the iTIP retry fix actually does, and the exhausted-retry failure mode was
unchanged from before the fix.** After all 3 retries fail, `maybeProcessItipMessage()`'s catch still only logged
and `processEntry()` still called `markDelivered(claim)` right after - on sustained contention the outcome is
byte-for-byte the same silent-warn-and-still-`DELIVERED` behavior as before, so "no longer silently dropped" in
the first-pass `RELEASE_NOTES.md`/this file overstated the fix. Corrected the wording in both to "significantly
less likely to be silently dropped under contention," and made the one safe, quick improvement available: the
catch in `maybeProcessItipMessage()` now logs at `logger.error()` (was `logger.warn()`) specifically for a 409
that survived every retry (`err?.status === 409 ? "error" : "warn"`), so it's operator-visible/alertable instead
of silent - the actual outcome for the lost update itself is still unchanged, and `RELEASE_NOTES.md`'s "Known
Issues" section now says so plainly instead of leaving the old (now-fixed-sounding) bullet in place.

**Verification**: full clean `vitest run --coverage` run (no concurrent file edits mid-run, per the standing
lesson above), `tsc --noEmit` clean, `eslint` clean.

**Coverage gate follow-up, same pass**: the project's 100%-statements/lines/functions coverage gate was
failing on this full run - some of it from code THIS round added with no dedicated test yet (the new
`aliasAddresses` validators in `BaseDistributionListRoute.ts`/`DistributionListRouteSQL.ts`, the new quota-
quarantine branch and `chargeMailboxQuotaForDelivery()` in `ScanQueueJob.ts`), and some of it pre-existing
debt from the FIRST commit of this whole review chain (`2b3c5a3`) that had apparently never actually been run
clean before landing: `MailboxImportJob.chargeQuota()`'s own catch-and-translate branch (only reachable when
the AUTHORITATIVE `chargeMailboxQuota()` charge - not `assertWithinQuota()`'s cheap local-cache pre-check -
is what detects the overage, e.g. a concurrent writer having already used up room the job's own cache still
thinks is free), `BaseMailIngestRoute.ts`'s `decodeEnvelopeAddress()` malformed-percent-encoding fallback, and
`KeyDiscoveryClient.ts`'s `isSafeDiscoveryHost()` catch branch for a host that passes the hostname-syntax
regex but that the WHATWG `URL` parser itself can't parse (an all-digit 63-character label - valid per the
regex, unrecognized by `net.isIP()`, but `new URL()` tries to read an all-numeric host as an IPv4 address and
throws "Invalid URL" rather than accepting it as a hostname). Closed all of it with new regression tests
(`DistributionListDomains.test.ts` x2: malformed-`aliasAddresses`-shape rejection, PUT-resubmit-unchanged
no-op; `ScanQueueJob{Mongo,SQL}.test.ts`: quota-exceeded quarantine, an unexpected non-quota/non-missing-
mailbox charge error propagating as a real FAILED rather than being swallowed, plus 4 `updateCalendarEventWithRetry()`
edge-case tests per backend - row-deleted-mid-retry, and each of the three call sites' own "stale by the time
of the retry-fetch" mutate-returns-undefined branch, using `vi.spyOn(repoUtils, "findOne")` to make the
internal re-fetch (not the initial existence check, which uses `.find()`) return an already-advanced row
without needing to actually force a real concurrent write; `MailboxImportJob{Mongo,SQL}.test.ts`: quota
exceeded via the authoritative charge with `assertWithinQuota()` spied to a no-op; `MailIngestRoute.test.ts`
x2: malformed `X-Envelope-From` percent-encoding falls back to the raw value; `KeyDiscoveryClient.test.ts`:
the all-digit-label host rejection above). Full suite re-run clean afterward: 7654/7654 tests passing, 100%
statements/lines/functions, 97%+ branches (branches only ever need 95%).

Files: changed `src/routes/BaseDistributionListRoute.ts`, `src/routes/sql/DistributionListRouteSQL.ts`,
`src/util/MailboxQuotaUtils.ts` (`MailboxNotFoundError`), `src/models/types.ts` (`QuarantineReason.QUOTA_EXCEEDED`
re-added), `src/jobs/ScanQueueJob.ts` (quota charge + quarantine fallback, `deliverMessage()` return type,
`maybeProcessItipMessage()` logging severity), `src/routes/BaseMailboxImportRoute.ts` (`DEFAULT_MAX_IMPORT_BYTES`
lowered to 90 MiB, `max_body_size` cross-check + one-time warning), `RELEASE_NOTES.md`, and new/changed tests in
`test/routes/{mongo,sql}/DistributionListDomains.test.ts`, `test/jobs/{mongo,sql}/ScanQueueJob{Mongo,SQL}.test.ts`,
`test/jobs/{mongo,sql}/MailboxImportJob{Mongo,SQL}.test.ts`, `test/routes/{mongo,sql}/MailIngestRoute.test.ts`,
`test/util/KeyDiscoveryClient.test.ts` (the last three closing pre-existing coverage-gate gaps from `2b3c5a3`,
unrelated to this round's own 5 items but blocking this commit's own required clean coverage run).
