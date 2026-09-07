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
  
- **Commit message style: concise, one line per task/bug/feature — no verbose prose.** A commit
  message is a short list of one-line bullets, one per item. This mirrors JP's standing convention
  across his other repos.

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
