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

## Folder counts

A folder's `unreadCount` and `totalCount` are **derived from its messages**, never trusted from the row:

- `GET /folders` (any query or paging) and `GET /folders/:id` - and the responses of `PUT` - answer with `totalCount` = the folder's
  messages that are not soft-deleted (exactly what `GET /messages?folderUid=` lists) and `unreadCount` = those whose `flags.read`
  is not `true` (unset counts as unread), from **one grouped query per request** (a `$group` on MongoDB, a `GROUP BY` on SQL),
  however many folders are listed. The stored fields are only a cache, refreshed whenever this library changes what a folder holds and
  repaired when a read finds them stale; they stay server-managed (a client cannot set them). `FolderRouteMongo`/`FolderRouteSQL` do
  this through their `messageClass`; a custom `BaseFolderRoute` subclass must set `messageClass` too, or it answers with the stored values.
- **Live event.** After a write that changes a folder's counts (message created, marked read or unread, moved, deleted, sent, imported,
  purged, retained away - a move publishes both folders, a bulk update or a send publishes each folder once) the folder's counts are
  published on the folder's channel **and** its mailbox's channel:

  ```json
  { "type": "FolderMongo", "action": "update", "data": { "uid": "<folder>", "mailboxUid": "<mailbox>", "unreadCount": 3, "totalCount": 27 } }
  ```

  (`type` is `FolderMongo` or `FolderSQL`; match `/^Folder/`. `data` carries exactly those four fields, not the folder row.)
  Publishing is best-effort. A protocol package that writes `Message.flags` or `folderUid` itself should call `refreshFolderCounts()`
  (exported) afterwards, with its own `FolderCountsContext`, so the cache and the event follow.

## Well-known folders

**Every mailbox has every well-known folder, from the moment it exists.** `POST /mailboxes` creates them all in one idempotent step
(`ensureWellKnownFolders()`): Inbox, Drafts, Outbox, Sent Items, Deleted Items, Junk Email, Archive (`FolderType` `inbox`, `drafts`, `outbox`,
`sent_items`, `deleted_items`, `junk`, `archive`) plus Calendar, Contacts, Tasks and Notes (`calendar`, `contacts`, `tasks`, `notes`) -
`WELL_KNOWN_FOLDER_TYPES`. Each has a deterministic uid (`wellKnownFolderUid(mailboxUid, type)`), so two servers creating the same folder at the same
moment end up with one. Nothing waits for the first send or the first spam.

- **Older mailboxes heal on read, with no migration.** `GET /folders?mailboxUid=` and `GET /folders/:id` first check that the mailbox has the whole set -
  **one existence query** per request, nothing written when it is complete - and create what is missing (a mailbox created when only some were
  provisioned, or a shared mailbox that never had them). It happens only for a caller who may list that mailbox (owner or explicit grant, never a role),
  creates the folders without granting the caller anything on them, and never fails the read.
- **Every folder creation is announced**, on the folder's channel and its mailbox's channel, whoever made it - the mailbox create, the heal, a client's
  `POST /folders`, and the lazy paths (`findOrCreateWellKnownFolder()` at a send, a delivery, an import):

  ```json
  { "type": "FolderMongo", "action": "create", "data": { "uid": "<folder>", "mailboxUid": "<mailbox>", "type": "outbox", "name": "Outbox", "unreadCount": 0, "totalCount": 0, "syncKeyVersion": 0 } }
  ```

  One event per folder (a lost race publishes nothing - the winner's create did). `update` carries either the counts only
  (`{ uid, mailboxUid, unreadCount, totalCount }`, above) or, when a client changed the folder itself (rename, move), **the whole folder**; `delete` carries
  `{ uid, mailboxUid, version }`. Match `/^Folder/`, key on `data.uid`. Publishing is best-effort.

## Signing-certificate enrollment status

`POST /mailboxes/:id/keyvault/keys/sign-enrollment` starts an automated (RFC 8823 `email-reply-00`) signing-certificate request and answers
`{ enrollmentId }`. Its progress is readable, and can be re-checked on demand:

- `GET /mailboxes/:id/keyvault/keys/sign-enrollment/:enrollmentId` - the existing `{ status: "pending" | "issued" | "failed", certificate?, error? }`
  **plus** (all additive): `stage` (`submitted` | `awaiting-challenge` | `challenge-answered` | `validating` | `issuing` | `issued` | `failed`), `stages`
  (`{ id, label, state: "done" | "active" | "pending" | "failed", at? }[]`, the sequence this server really runs: *Request submitted*, *Verification e-mail
  sent by the CA*, *Verification e-mail answered*, *CA validating*, *Certificate being issued*, *Certificate issued*), `progress` (0..100, never 100 for a
  failure), `requestedAt`, `updatedAt`, `lastCheckedAt?`, `nextCheckAt?` (when the background job will look next - `lastCheckedAt` + `mail:pki:rfc8823:poll_interval_seconds`, default 300, which should equal the job's own schedule; a time in the past means it is due),
  `errorCode?`/`retryable?`/`note?` (see below), and once issued `issuedAt`, `installedAt?` (the background job installs the certificate into the key vault
  on its next tick - refetch the vault when it appears), `notAfter`, `serialNumber`, `issuer`, `subject`. Times are ISO 8601 and are kept on the enrollment
  record, so they survive a restart.
- `GET /mailboxes/:id/keyvault/keys/sign-enrollment` - the mailbox's **current** enrollment (one in flight: pending, or issued and not yet installed) or,
  when there is none, its **most recent** one, in the same shape plus `enrollmentId`; **404** when it never enrolled. How a client on another device, or with
  its storage cleared, finds one it never saw start.
- `POST /mailboxes/:id/keyvault/keys/sign-enrollment/:enrollmentId/check` - **check now**: takes the step the background job would take on its next tick
  (answer the CA's challenge, poll the order, finalize, download the certificate) and answers with the same object. Rate limited **per enrollment**: a
  second check within about 10 seconds is a **429** with `Retry-After` (seconds; the limit is stored with the enrollment, so it holds across servers). It
  waits for the CA at most a few seconds (8): a slower CA leaves the check running and the answer is the current state with a `note`. A CA that is
  unreachable is in the answer (`errorCode: "ca-unreachable"`, `retryable: true`), not an error. A finished enrollment is answered as it is. The caller
  needs READ on the mailbox (its owner or a delegate; never a role).
- **Failures** carry `errorCode` and `retryable` (whether a new request could succeed): `order-expired` (the CA's order lapsed, or the request outlived
  `mail:pki:rfc8823:max_pending_hours`, default 168, when the CA gave no expiry) and `challenge-failed` and `order-invalid` and `ca-error` are retryable;
  `rejected` (the CA refused the address, key or CSR) is not; `cancelled` is a cancellation by the owner. While still pending, an attempt that failed
  (`ca-unreachable`, `reply-not-sent`, `rate-limited`, `ca-error`) is shown the same way with `retryable: true` and is retried by the next tick.
- The manual-CA enrollment reports a single stage (`submitted`, waiting for an administrator to upload the certificate), then `issued` or `failed`; the
  default (disabled) enrollment has none (404 for the current enrollment).

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

## Appearance preferences

`BaseAppearanceRoute` (`AppearanceRouteMongo`/`AppearanceRouteSQL`; the server mounts it at `/api/mail/preferences/appearance`) keeps the web
client's look **per user** - one row keyed by the JWT's `uid`, not per mailbox, so it follows the person to every mailbox and device. A caller
can only ever read or write their own row (there is no way to name another user's), and a trusted role gets no exception. Every route is
`@Auth(["jwt"])`.

```ts
{
  version: 1;                                              // the shape's own version (`Entity.version` is the lock counter)
  mode: "system" | "light" | "dark";                       // default "system"
  colors?: { primary?: string; accent?: string; surface?: string; text?: string };   // "#rrggbb"; absent = the app's / branding's own
  background?: { kind: "none" | "color" | "image"; color?: string; imageVersion?: string;
                 dim: number /* 0..0.8 */; blur: number /* 0..20 */; fit: "cover" | "contain" | "tile" };
  updatedAt: string;                                       // ISO 8601
}
```

- `GET /` answers the caller's preferences, or `{ version: 1, mode: "system", updatedAt: "1970-01-01T00:00:00.000Z" }` when none are saved -
  never a 404, and no row is written.
- `PUT /` merges a partial body and answers the saved object. Every field is validated strictly - a **400 naming the field**
  (`'colors.primary' must be a colour written as #rrggbb.`) for a colour that is not `#rrggbb` (stored lowercase), an unknown `mode`/`kind`/`fit`,
  a `dim` outside 0..0.8, a `blur` outside 0..20, and any key that is not one of ours (`'theme' is not a known field.`). `version` (must be 1)
  and `updatedAt` are accepted so a client can send back what it read. `colors` merges key by key (`null` clears one colour, `colors: null` all of
  them); `background` merges key by key over the current one (defaults `dim` 0, `blur` 0, `fit` "cover"; `color: null` clears its colour);
  `kind: "color"` needs a colour and `kind: "image"` needs an uploaded image (400 otherwise); `background.imageVersion` cannot be chosen by a
  client (400 unless it is the current one). Switching `kind` away from `"image"` keeps the uploaded image so it can be switched back.
  Rate limited to 600 a minute per user.
- `POST /background` takes the raw image as the body (`Content-Type` `image/png`, `image/jpeg`, `image/webp` or `image/avif`) and answers the
  saved preferences with `background.kind = "image"` and a fresh `background.imageVersion` (`dim`/`blur`/`fit` and any colour are kept). **The
  bytes decide what it is, not the header:** the magic number is sniffed (PNG, JPEG, WebP, AVIF) and the image is served back as that type; an
  SVG - or a GIF, or anything else - is refused with **415** whatever the header says. **413** above `mail:preferences:background_max_bytes`
  (default 8 MiB); 400 for an empty body. The bytes are stored as sent (nothing is re-encoded) in the `BlobStore` under
  `appearance/<userUid>/<version>`, and the previous image's blob is deleted. 30 a minute per user.
- `GET /background/:version` serves the image with the sniffed `Content-Type`, `Cache-Control: private, max-age=31536000, immutable` (the
  version changes with every upload), `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` and
  `Content-Security-Policy: default-src 'none'; sandbox`. Only the owner's current version answers; **404** for anyone else and for a stale
  version - the existence of another user's image is never revealed.
- `DELETE /background` deletes the image's blob and sets `kind` to `"none"` (the other settings stay); answers the saved preferences.
- **Live event.** After a successful `PUT`, upload or delete, `{ type: "AppearancePreferencesMongo" | "AppearancePreferencesSQL", action:
  "update", data: <the saved preferences> }` is published on the **user's own uid channel** (`NotificationUtils.sendMessage(user.uid, ...)`;
  match `/^AppearancePreferences/`) so other tabs and devices update live. Best-effort.
- `fetchAppearanceForSSR(objectFactory, AppearancePreferencesMongo | SQL, userUid, logger?)` (exported) reads the caller's row for a
  server-rendered page's props: `undefined` when there is none, and it never throws (a datastore error is logged at debug level).

## Background send

`POST /messages/:id/send` with `{ "background": true }` answers at once and finishes the send in the background, so the compose window never
waits for the scan pipeline and the mail system:

- The route does only what is cheap - the same checks as a send (sender allowed, has recipients, still a draft, folder permission, not already
  sent) - and moves the message into **Outbox**, due now (`scheduledSendTime` = now, nothing leased), then answers
  **`202 { "status": "queued", "message": <the Outbox copy> }`**. The message is in Outbox, and counted by `GET /folders`, the moment the 202 is sent.
- The relay - scan pipeline, transport, filing into Sent Items - then runs **in this process, started right away**, by
  `ScheduledSendJob.enqueue()` (a bounded number at a time: `mail:jobs:scheduled_send:concurrency`, default 4). Because the queued message is
  simply an ordinary due message in Outbox, a process that dies before, during or after the relay leaves it for `ScheduledSendJob`'s next
  scheduled run - and its `start()` sweeps at once - to finish. The job's version-checked claim and the `scheduledSendRelayedAt` marker (written
  the moment the transport accepts) keep it from being sent twice, whatever is retried. `stop()` waits up to `mail:jobs:scheduled_send:drain_ms`
  (15 s) for relays in flight.
- **Results are events**, `{ type: "MessageMongo" | "MessageSQL", action, data }`, published once on the sender's **mailbox uid channel and the
  Outbox (and, when filed, Sent Items) folder channels** (`data` is `SendEventData`):

  ```json
  { "type": "MessageMongo", "action": "send-succeeded" | "send-retrying" | "send-failed",
    "data": { "uid": "<message>", "mailboxUid": "<mailbox>", "subject": "...", "recipients": ["a@x", "b@y"], "attempt": 1,
              "nextAttemptAt": "2026-09-21T18:31:00.000Z",
              "error": { "message": "...", "details": { "transport": "postfix-sendmail", "failures": [ { "address": "a@x", "code": 554, "temporary": false } ] } } } }
  ```

  `attempt` counts from 1 (the attempt that succeeded or failed); `nextAttemptAt` is only on `send-retrying`; `error` is on `send-failed` and
  `send-retrying` (`details` is the transport's own `MailRelayFailureDetails`, when it said anything). `send-retrying`: an attempt failed and
  another is due after the existing backoff (`attempts x retry_backoff_ms`; `scheduledSendAttempts` counts them). `send-failed`: it will not be
  tried again - refused by the job's own guards, out of attempts (`max_attempts`), or **failed for a reason no retry can fix** (a spam/malware
  verdict, or every recipient refused with an SMTP 5xx: `isPermanentRelayFailure()`); this applies to scheduled sends too. A failed message
  **stays in Outbox** (like a scheduled send the job gave up on) with `scheduledSendError` set, nothing due and no lease, and the delivery
  failure notice is still filed in the sender's Inbox once. A client renders Outbox rows from the message itself: a lease, or a due
  `scheduledSendTime` with no `scheduledSendAttempts`, is *sending*; `scheduledSendAttempts > 0` with a future `scheduledSendTime` is
  *retrying*; a `scheduledSendError` with no `scheduledSendTime` is *failed*.
- **Repeating the request is safe.** For a message already queued or being sent it answers the same 202 without sending again (once it has been
  filed, the 409 "already sent" every send answers); two at the same moment send once. For a message that *failed for good* it queues the
  message again with a fresh retry budget (the way to retry from Outbox) - moving it back to Drafts works as before. A message held for a time
  the user chose (a future `scheduledSendTime`) stays a 409.
- With a future `scheduledSendTime` in the same body the answer is the same 202 and the message waits in Outbox. Without `background: true`
  nothing changes: the send is synchronous (200, or the 502 `MailRelayError`). A `background` that is not a boolean is a 400; a route class
  with no `sendJobClass` (a downstream subclass that predates it) answers 501.
- The job now adds what an immediate send adds to whatever it relays (`prepareOutboundMime()`): `Disposition-Notification-To` when a receipt is
  requested and the `RapidMX-Key` announcement, and it files the Sent Items copy with the receipt tracking rows, `encrypted`, `inReplyTo` and
  `references` as an immediate send does - so a scheduled send now matches too.
- Where the time goes (measured, fake scan providers and transport): a send's own database work is ~15-20 ms; the scan pipeline runs on the main
  thread - mailparser about 50 ms per MB of base64 attachment, sanitizing 200 KB of HTML about 46 ms - plus, in a real deployment, rspamd,
  ClamAV (the message once, each attachment again) and the `sendmail` spawn (~50 ms). `ScanPipeline.run()` takes `{ skipPreview: true }`, which
  `scanAndRelay()` passes: a send does not use the body preview, and deriving it (HTML to text) cost as much as sanitizing the body.

## HTML mail: what is kept, what is blocked

A message's HTML is sanitized once, when it is stored (`ScanPipeline`, `scan/HtmlSanitizer.ts`), and served by `GET /messages/:id/content`. The rule is **faithful but safe**: the sender's
design - colours, backgrounds, fonts, table layout, `<style>` blocks with `@media` queries (dark-mode ones included), inline images - arrives as written, and nothing that runs, navigates,
submits, overlays or loads what the reader did not ask for does. The output is a complete, re-serialized document (`<!DOCTYPE html><html><head>...</head><body ...>...</body></html>`): the
sanitizer parses the input, writes the output itself from an allow-list of elements and attributes with every value checked, and never copies markup through, so it does not depend on how a
browser would have parsed the original. It is idempotent (sanitizing the output changes nothing). It is the first of four layers (the reading pane adds DOMPurify, a strict CSP and a sandbox
without `allow-scripts`); none is relied on by another.

| | Kept | Blocked |
| --- | --- | --- |
| Elements | `div span p br hr h1-h6 blockquote pre code ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col a b strong i em u s strike del ins sub sup small big font center abbr cite q mark tt kbd samp var dfn time bdi bdo nobr wbr address figure figcaption section article header footer nav main aside menu img`, `<style>` (sanitized) | dropped with their content: `script noscript iframe frame frameset object embed applet param input select option optgroup datalist textarea link meta base title svg math video audio source track canvas template slot dialog xml xmp plaintext listing noembed noframes portal area`; custom (`x-foo`) and namespaced (`o:p`, `v:shape`) elements, `form`, `button`, `label`, `marquee`, `details` and every other element not listed lose the tag and keep their text |
| Page | `<html lang dir>`, `<body bgcolor text link vlink alink background style class dir lang>`, `<meta name="color-scheme">` (so a dark-aware mail is recognised) | every other `<meta>` (`http-equiv="refresh"` included), `<title>`, `<base>`, `<link>`, comments (Outlook `[if mso]` blocks), processing instructions |
| Attributes | `style class id dir lang title align valign bgcolor color text link alink vlink face size width height border bordercolor cellpadding cellspacing colspan rowspan nowrap hspace vspace abbr scope span start type alt role aria-hidden aria-label hidden background`, `a[href]`, `img[src]` | every `on*` handler, `srcdoc srcset formaction action name headers ping xlink:href accesskey tabindex contenteditable draggable` and every `data-*`; a value that does not validate is dropped |
| Links | `http`, `https`, `mailto`, `tel`; every link is forced to `target="_blank" rel="noopener noreferrer nofollow"` | `javascript:` `vbscript:` `data:` `file:` `blob:` `cid:`, relative and protocol-relative URLs, `#fragments` (also with tabs, newlines, control characters and entities inside the scheme) - the link's text stays |
| Images (`img src`, `background`, CSS `url()`) | `cid:<Content-ID>` (served as the attachment's URL, below), `data:image/png,jpeg,gif,webp,avif;base64` up to `max_data_image_bytes`, `http(s)` URLs verbatim (the reading pane's CSP does not load them) | SVG, `data:text/html`, larger images, any other scheme, an unknown `cid:` (the `src` goes, the `alt` stays) |
| `id` | prefixed `m-` (and `#id` selectors in the message's own stylesheets the same), so a message can never take a name the app uses | `name` (DOM clobbering) |
| CSS properties | colour, `background*` (with `url()` as above), `font*`, `line-height`, `letter-spacing`, `word-spacing`, `text-*`, `white-space`, `vertical-align`, `direction`, box model (`margin* padding* border* width height min-* max-*`), `display` (`block inline inline-block table* flex inline-flex none list-item`), `float`, `clear`, `overflow` (`visible hidden auto`), `position: relative or static`, `visibility`, `opacity`, `table-layout`, `border-collapse`, `list-style*`, `box-shadow`, `border-radius`, flex layout, `color-scheme`, and the vendor-prefixed forms of these | `position: fixed, absolute or sticky`, `z-index`, `content`, `cursor`, `filter`, `behavior`, `-moz-binding`, `expression()`, `mso-*`, animation, transform, custom properties and `var()`, every function that could load or run something (`image-set()`, `attr()`, `element()`...) |
| CSS at-rules | `@media` (media types and features, `and`/`not`/`only`, commas; `prefers-color-scheme` included) | `@import @charset @namespace @font-face @keyframes @page @supports @container` and the rest |

The CSS is parsed by a tokenizer of its own (CSS Syntax Level 3: escapes decoded, comments removed) and written back out from the tokens, so `u\72l(javascript:x)` is `url(javascript:x)` by the
time it is checked and nothing unchecked can be in the output; there is no CSS dependency (`htmlparser2`, already a dependency of `html-to-text` and `sanitize-html`, parses the HTML).

Settings, all under `mail:scan:sanitize:` and all with a default, bound a hostile message's cost: `allowed_tags` (restricts the elements above to these; **empty or absent keeps them all**, and it can
never allow a blocked one; before, `[]` meant "no tags at all"), `max_data_image_bytes` (262144, per image), `max_css_bytes` (524288 of sanitized CSS in all), `max_css_rules` (10000),
`max_input_length` (2097152 characters of HTML are read), `max_depth` (128 nested elements; deeper ones lose their tag and keep their text), `max_elements` (50000). The serving settings are
`attachment_url_prefix` (`/api/mail/attachments`), `lazy_max_raw_bytes` (16777216) and `lazy_timeout_ms` (10000).

**Inline images.** The stored HTML refers to an inline image as `cid:<Content-ID>` (mailparser is told not to copy every image into the HTML as a `data:` URI). `GET /messages/:id/content` looks up the
message's attachments by `contentId` (angle brackets ignored, case-insensitive) and answers, by `?cid=`: `attachment` - each reference becomes `<attachment_url_prefix>/<attachment uid>/content`, which
loads in a browser tab (the response's CSP is `default-src 'none'; img-src data: 'self'; style-src 'unsafe-inline'; sandbox`); `keep` - known references stay `cid:` for a client that resolves them
itself. Without the parameter a `fetch()` (`Sec-Fetch-Dest: empty`, as the reading pane's) gets `keep` and anything else gets `attachment`. A reference to a part the message does not have loses its
`src`. `Attachment.contentId` is now stored without its angle brackets, as the reference in the HTML spells it; rows written earlier keep theirs and lookups accept both.

**Messages stored by an older sanitizer** (the old one dropped every style, image and `<style>`) need no migration. Every sanitized blob begins with a stamp, `<!--rapidmx-sanitized:<n>-->`
(`SANITIZER_VERSION`, now 2); a blob without one, or with a lower number, is re-sanitized from the raw MIME (`bodyBlobKey`) the first time `GET /messages/:id/content` reads it - the parse and the
sanitize only, no rspamd or ClamAV - and the blob is overwritten with the result (the stamp is stripped from the response). Concurrent readers share one run; a raw message over
`lazy_max_raw_bytes`, a run over `lazy_timeout_ms` (it finishes in the background) or a failure (a missing raw blob...) serves the HTML already stored and is not retried for five minutes. Bump
`SANITIZER_VERSION` whenever the sanitizer's output should be redone for stored mail.

**Body preview.** `Message.bodyPreview` for an HTML-only message is now the text of the message: `<style>`, the `<head>`, scripts and the hidden "preheader" (`display:none`, `visibility:hidden`,
`mso-hide:all`, `opacity:0`, `font-size:0`, zero-size with `overflow:hidden`, `hidden`, zero-width padding characters) are left out, and reading stops as soon as there is enough text.

## Who can see whose mail

**No role - an administrator's included - gives access to another user's mailbox.** Everything scoped to a mailbox (the mailbox, folders, messages and their content/raw/attachments, drafts, conversations,
labels, filter rules, signatures, contacts, calendar events, tasks, notes, key vault, search, imports, sharing, and the live push channels) is reachable only by its **owner** or a holder of an **explicit
ACL grant** on it. A trusted role, an elevated token and `ignoreACL` do not widen that, because `@rapidrest/service-core`'s `ACLUtils.hasPermission()` treats a trusted role as a superuser - so
mailbox-scoped code asks `hasMailAccess()` from `util/MailAccessUtils.ts` instead, which takes the caller's trusted roles away first (`stripTrustedRoles()`, also what the inherited `CRUDRoute`
handlers and `MailPushRoute` are handed). An administrator sees their own mailbox and the mailboxes shared with them; to see another user's they impersonate that user, whose token is just that user's own
identity. A mailbox, folder or message the caller can't see answers 404 exactly like one that doesn't exist.

- **Listing mailboxes** (`GET`/`HEAD /mail/mailboxes`) is the caller's own and shared-with-them mailboxes for every caller.
- **The administration scope** - `?scope=admin` on `GET /mail/mailboxes` and `GET /mail/mailboxes/:id`, and on the quarantine and ingest-queue routes - needs a trusted role AND an elevated token (else
  403 `api-103`/`api-104`). For mailboxes it answers administrative metadata only (`uid`, addresses, display name, `ownerUserUid`, `shared`, quota/usage, timestamps, resource flags, escrow scope,
  encryption preference) for every mailbox, filterable by those fields only. Every call is audited (`mailbox.admin-list`, `mailbox.admin-read`, `mail_queue.admin_access`).
- **Managing a mailbox** an administrator holds no grant on (`PUT`/`DELETE`): only the administrative fields (owner, addresses, display name, timezone, quota, resource and escrow settings) are writable, the
  answer is that metadata, and the change is audited (`mailbox.admin-update`/`-delete`). A shared (ownerless) mailbox an administrator creates is granted to its creator; an existing one is opened up
  by the administrator adding themselves through the Sharing action (`PUT /mail/mailboxes/:id/access/:uid`), which is audited, and refused for a mailbox that has an owner.
- **Compliance workflows that cross mailboxes** keep their own authorization and audit: GDPR data export (a trusted caller may export and download any mailbox; the request and any non-owner download are
  audited) and erasure, retention, legal hold, and escrow/eDiscovery (escrow-scope holders only, never a trusted role).
- **Sharing names a person, and only the uid is stored.** `PUT /mail/mailboxes/:id/access/:principal` takes a mailbox address (its owner), an auth-server username or e-mail alias (`mail:auth_server_url`, looked up with the caller's own cookie: an ordinary caller can name themselves, an
  administrator anyone) or a user uid the server knows, resolves it, and stores the resolved uid - a grant stored against a typed username matches no token and grants nobody anything. Anything that doesn't resolve is 400 `No user found for "<x>".`; `GET /:id/access/resolve?principal=` previews who it is; the member list marks an
  entry that isn't a user uid `noEffect`; `/api/acls` refuses non-uid principals on mail ACLs. A mailbox read carries `accessRole: "owner" | "delegate"`.
- **Extending it:** a new mailbox-scoped route class must be added to `test/routes/mailAccessRouteTable.ts` and to the access matrix (`test/routes/mailAccessMatrixSuite.ts`); `mailAccessGuard.test.ts`
  fails otherwise, and fails on any direct `aclUtils.hasPermission()` call in `src/routes`.

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
