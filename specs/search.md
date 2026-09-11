# RapidMX: Search Under End-to-End Encryption

Companion to `end-to-end_encryption.md`, which defers the encrypted search design to this document. This document specifies how search continues to function once message bodies, subjects and attachments are encrypted end-to-end.

## 1. Current Architecture

**Provider abstraction.** `SearchProvider` exposes `index`, `bulkIndex`, `remove` and `search`, selected via the `search:provider` config key. Three implementations exist: `MongoTextSearchProvider`, `PostgresFullTextSearchProvider` (tsvector/GIN) and `OpenSearchProvider`. Indexing is eventually consistent with the primary datastore via `SearchIndexState` and `SearchIndexJob`.

**Document shape.** `SearchDocument` is a flattened, provider-agnostic projection covering five entity types — `message`, `contact`, `calendarEvent`, `note`, `task` — with fields `subject`, `body`, `attachmentText[]`, `participants[]` and `dateForSort`, scoped by `mailboxUid`.

**Query model.** `SearchQuery` is `{ mailboxUid, text, entityTypes?, limit?, cursor? }`. There is no field-operator grammar. Postgres uses `plainto_tsquery`, OpenSearch uses `multi_match`. Search is bag-of-words relevance ranking, not structured query.

**Ranking.** Both providers weight fields, and they agree on the ordering:

| Field            | Postgres weight | OpenSearch boost |
| ---------------- | --------------- | ---------------- |
| `subject`        | A               | ×3               |
| `participants`   | D               | ×2               |
| `body`           | B               | ×1               |
| `attachmentText` | C               | ×1               |

**Pagination** is offset-based. Both providers encode an integer offset in the opaque `cursor` and detect `hasMore` by requesting `limit + 1`.

**Attachment text** is extracted server-side by `AttachmentExtractionJob` via `ExtractorRegistry`, dispatching on MIME type to plain-text, HTML, PDF and DOCX extractors, with a 25 MB size cap and a 30-second timeout.

**`SearchResult.snippet`** is declared in the interface as provider-generated highlight text. `OpenSearchProvider.search()` does not currently populate it.

## 2. What E2E Removes

For an encrypted message, the server cannot populate most of `SearchDocument`:

| Field                                   | Under E2E       | Note                                                                                   |
| --------------------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `entityType`, `entityUid`, `mailboxUid` | Available       | Routing metadata.                                                                      |
| `dateForSort`                           | Available       | From the envelope.                                                                     |
| `participants`                          | Available       | Envelope recipients are needed for delivery.                                           |
| `subject`                               | **Unavailable** | RFC 9788 header protection places `Subject` inside the signed and encrypted structure. |
| `body`                                  | **Unavailable** | —                                                                                      |
| `attachmentText[]`                      | **Unavailable** | `ExtractorRegistry` cannot read ciphertext.                                            |

Two consequences follow that are larger than they first appear.

**Ranking collapses.** The server retains only the `participants` field, which is weight D in Postgres and the ×2 boost in OpenSearch. Every high-weight signal is gone. A server-side score for an encrypted message is therefore not comparable to a server-side score for a plaintext one, and neither is comparable to a client-computed score.

**Attachment extraction must relocate.** `AttachmentExtractionJob` cannot run over encrypted attachments. PDF and DOCX extraction moves to the client, on devices with far less headroom than the server. See §9.

## 3. Encryption Scope

Encryption is scoped by **provenance**, not by entity type and not by the correspondent's stated preference.

| Entity type     | Encrypted?                                                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message`       | Yes, per the E2E policy.                                                                                                                                                                |
| `calendarEvent` | When materialised from an encrypted message received from a federated peer or external sender, **or** when the user originates an invitation sent over an encrypted channel (any tier). |
| `contact`       | Never. See below.                                                                                                                                                                       |
| `note`, `task`  | Only when user-created from encrypted content, and only with explicit warning.                                                                                                          |

The majority of calendar events — user-created and sent unencrypted, internal invitations, and invitations from unencrypted external senders — remain plaintext and are served entirely by Tier 1 at existing fidelity.

### Rationale: Sender Privacy, Not Recipient Privacy

The protected interest is the **external sender's**, not the recipient organisation's internal privacy.

When an external party sends an encrypted meeting invitation, they encrypted it because RapidMX told them it was end-to-end. If the recipient's client then materialises a `calendarEvent` with a plaintext subject, attendee list, location and agenda into `mail_search_index`, the sender's content has reached server-visible storage through a side door — a different store from the mailbox, with its own backups, replicas and possibly a managed service.

The sender cannot see the recipient organisation's configuration. Allowing that configuration to silently determine whether their content is indexed in plaintext makes the meaning of "end-to-end" depend on a setting they have no visibility into.

This does not extend to same-organisation mail _by default_. Where both parties are inside one administrative boundary, the administrator can already read the mailbox, and indexing a derived event leaks nothing new. **Automatic** derived-entity protection therefore applies only to content originating from a federated peer or external sender.

**Inheritance, however, follows the message's actual encryption state, not its tier.** If a message arrived encrypted — for any reason, including a same-organisation sender who chose to encrypt — its derived entities are encrypted. Tier scoping governs only whether protection is applied _automatically_; it MUST NOT govern whether existing protection is inherited.

Without this distinction, an internal sender's deliberate encryption is silently undone on the receiving side. The motivating case is privileged communication: counsel encrypts an internal invitation, the recipient's client materialises the event, and a tier-based rule would index its title in plaintext.

### Contacts Are Never Encrypted

A contact is a record the user authored about another person. The correspondent never sent it and has no expectation about it. `prefer-encrypt=mutual` is a statement about messages in transit, not about the recipient's address book, and MUST NOT be interpreted as retroactively changing how an existing contact is stored.

To eliminate the mixed-provenance case entirely — a record whose display name was typed by the user but whose phone number was scraped from an encrypted signature block — **contacts MUST NOT be auto-enriched from encrypted message content.**

- Address and display name MAY be taken from the envelope, which the server already processes for delivery.
- Signature-block parsing, phone number extraction, title inference and any other enrichment derived from decrypted body content MUST be skipped for encrypted messages.

With this rule, no contact ever contains encrypted-derived content, field-level provenance tracking is unnecessary, and contacts remain fully searchable in Tier 1.

### Originated Encrypted Events

A user MUST be able to originate an encrypted calendar invitation, not merely receive one. Without this, no RapidMX user could ever produce encrypted calendar content and the receive path would be unreachable in practice.

**An event's encryption state follows the message that carries it, in both directions.** When an invitation is sent encrypted, the organiser's own copy of the event MUST be encrypted. This is the encrypt-to-self rule from `end-to-end_encryption.md` applied to calendar: without it, the organiser's Calendar holds in plaintext exactly what the invitation protected.

This refines the external-only scoping above. Automatic protection is scoped to external senders, but an **explicit user choice to encrypt MUST be honoured regardless of tier**, including for same-organisation invitations. A deliberate decision outranks a default.

### Field Split

Encrypted calendar events are partially encrypted.

| Field                                                 | State         |
| ----------------------------------------------------- | ------------- |
| Title                                                 | **Encrypted** |
| Notes / description                                   | **Encrypted** |
| Location                                              | **Encrypted** |
| Attachments                                           | **Encrypted** |
| Start, end, duration, busy status, recurrence pattern | Plaintext     |
| Attendee list and RSVP status                         | Plaintext     |
| Organiser                                             | Plaintext     |

**Temporal fields stay plaintext** because free/busy is a same-organisation disclosing capability served by the server, and an encrypted event must still block time. Free/busy responses MUST report busy time without title or location.

**Attendees stay plaintext** because the list is already server-visible. A meeting invitation travels as an ordinary message whose `To:` and `Cc:` headers name every attendee, and RFC 9788 retains outer headers by default so that clients without header-protection support can still render the message. Encrypting the attendee list inside the derived event would protect a copy of data the receiving server already holds, while breaking RSVP tracking, delegate access, room booking and "who hasn't responded" — all of which are server-side functions.

Two residuals are recorded rather than acted on:

- **RSVP status is not derivable from the original headers.** Who accepted or declined accumulates after the invitation is sent. It is retained in plaintext because scheduling requires it server-side, and its sensitivity is low relative to the attendee list itself.
- **This decision depends on outer headers being retained.** If RapidMX later adopts RFC 9788 HP-Obscured handling for encrypted mail, stripping or obscuring outer `To` and `Cc`, the attendee list would cease to be server-visible and this rule MUST be revisited.

This split preserves `dateForSort` and `participants`, so date-range and attendee search over encrypted events continue to work at Tier 1. Only title, notes, location and attachment text drop to Tiers 2 and 3.

### Lifecycle

Encryption state is sticky for the life of the event.

- Updates and cancellations MUST use the same encryption state as the original invitation. An encrypted invitation followed by a plaintext update discloses the subject regardless.
- For a recurring series, all instances and exceptions MUST share one encryption state.
- Adding an attendee who cannot receive encrypted mail is the multi-recipient case from `end-to-end_encryption.md`: the client MUST NOT split the event into encrypted and plaintext copies. It MUST present the user the choice of sending the whole event unencrypted or removing that attendee.
- Transitioning an existing plaintext event to encrypted MUST re-encrypt the stored event **and** remove its content fields from the server-side index. Transitioning in either direction MUST be an explicit user action, never automatic.

### Provenance

Encrypted derived and originated entities carry an origin marker governing behaviour on edit, update and duplication. It is not a security control — ciphertext is self-evident to the server — but it determines which operations preserve encryption.

```ts
export type EncryptionOrigin =
    /** Not encrypted. */
    | "none"
    /** Materialised from an encrypted message received from a federated peer or external sender. */
    | "derived"
    /** Encrypted by explicit choice of this user. */
    | "originated";
```

It MUST be a denormalised field on the entity, not a reference to the source message. A user routinely deletes an invitation email while keeping the meeting; a join would break, a copied value does not.

`derived` and `originated` MUST remain distinguishable. The UI MUST be able to explain _why_ an item is encrypted — "received encrypted from bob@orgb.com" versus "you chose to encrypt this" — because an unexplained lock icon reads as a defect.

**Inheritance:**

| Operation                                 | Inherits encryption                                                 |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Edit (any field)                          | **Yes** — editing a title must not leak what the original protected |
| Meeting update / cancellation             | **Yes**                                                             |
| Series exception from an encrypted master | **Yes** — an exception is part of the series, not a new event       |
| Drag to a new date / time                 | **Yes**                                                             |
| Duplicate, "copy to", use as template     | **No** — a new meeting is a new meeting                             |
| New event from scratch                    | **No**                                                              |

Duplication deliberately does not inherit: the user makes an explicit choice for the new event. Because this is a downgrade path, the encryption toggle in the compose UI MUST default to **on** when the source event is encrypted. The choice remains the user's; the default must not make the leaky path the lazy one.

The distinction between a series exception and a duplicate MUST be enforced at the model level. Exceptions are frequently implemented through the same code path as duplication, which is how this rule gets broken by accident.

Changing encryption state on an existing entity MUST be an explicit user action with a warning, and downgrading MUST re-index the content fields server-side.

### Progressive Results

Tiers report at very different speeds: Tier 1 in tens of milliseconds, Tier 2 nearly as fast, Tier 3 in seconds. The UI MUST reflect an in-progress search rather than presenting partial results as complete.

**Never show a hard count until every tier has reported.** Display `n of ??`, or omit the count. A settled count is the signal that ordering is final.

**Unresolved encrypted results MUST be rendered as skeleton entries in place**, not appended on arrival. A skeleton claims its slot, so resolution is a fill rather than an insertion, and the list does not grow under the reader.

**Reordering is permitted and preferred over appending.** Ordering by best-known score means a highly relevant result that resolves late takes its correct position. Appending late results would bury the best match at the end of a long list, which makes search useless precisely when it matters.

**Skeletons resolve or disappear.** A candidate that decrypts to a non-match is pruned, and pruning is visually acceptable in a way that late insertion is not.

**Skeletons MUST be capped**, at approximately one and a half pages. A Tier 3 candidate set may contain hundreds of entries and rendering all of them as skeletons is its own failure mode. Resolve the visible set, then extend.

### Calendar Views

Grid views — month, week, day — are the easy case, because position is determined by time and temporal fields are plaintext (§3).

An encrypted event MUST render in its correct cell from the first frame, with a skeleton in place of the title and location, filling in on decryption. The event never moves, since its position was never in question. Duration, busy status and attendee count are available immediately.

This makes grid view strictly better behaved than list view for encrypted content, and no tier restriction is needed for it.

### Requirements

- Entities materialised from an encrypted external message MUST carry a provenance flag.
- Such entities MUST NOT have `subject`, `body` or `attachmentText` indexed server-side. They are indexed on the reduced field set of §2 and searched through Tiers 2 and 3.
- Files saved out of encrypted attachments MUST NOT be submitted to `AttachmentExtractionJob`.
- User-initiated derivation (creating a note or task from an encrypted message) MUST warn that the new entity will be stored unencrypted unless provenance handling is applied.
- This behaviour MUST be an administrator setting, **defaulting to protective**, so that a compliance-driven organisation disables it deliberately rather than acquiring it by accident.

### Administrative Recovery

Derived encrypted entities are encrypted under the same mailbox master key (MK) as messages, so the organisational escrow mechanism in `end-to-end_encryption.md` covers them with no extension. An administrator with the escrow key can decrypt both mail and derived calendar events.

Escrow is optional and disabled by default. An organisation that has not enabled it cannot recover either messages or derived events. Product documentation MUST state that escrow is _available_, not that administrators can always decrypt.

### Legal Note

Retention regimes such as SEC 17a-4, FINRA and HIPAA generally permit encryption provided records remain producible in readable form, which is the purpose escrow serves. GDPR Article 32 pulls the other way, naming encryption as an appropriate technical measure on a risk basis. None of them grant a correspondent authority over how the receiving organisation stores its own records, which is why derived-entity handling is an administrator decision.

## 4. Threat Model

The design must not increase what the server learns beyond what it already knows for delivery.

**The server already knows,** and may continue to use for search: envelope participants, dates, message sizes, folder placement, flags, and the full content of any message that is not encrypted.

**The server must not learn:** any token, term or n-gram derived from encrypted plaintext; which term a user searched for; or which specific encrypted messages matched a query.

**Out of scope:** an adversary who compromises an unlocked client. The local index is plaintext-derived and a compromised device exposes the mailbox regardless.

## 5. Rejected: Deterministic Encrypted Keyword Index

Restated from `end-to-end_encryption.md` because it is the design most likely to be reproposed.

Having the client hash each token on decryption and upload the hashes for server-side matching MUST NOT be used.

- **Frequency analysis.** Natural-language word frequencies are public, so the hash distribution maps back onto the word distribution with high accuracy. A per-user HMAC key prevents cross-user correlation but not within-user analysis.
- **Query and access-pattern leakage.** The server learns which hash was queried and which messages matched — the basis of most practical attacks on searchable encryption.
- **It does not restore ranking.** Uploaded token hashes give term presence, not the field weights that produce the current relevance ordering. Preserving those weights would require uploading per-field token sets, multiplying the leakage.

## 6. Architecture

Three tiers, merged in the client.

```
                          ┌──────────────────────────────┐
   query ────────────────►│      Client merge layer      │◄──── merged, ranked
                          └───┬──────────┬───────────┬───┘
                              │          │           │
                 ┌────────────▼──┐  ┌────▼───────┐  ┌▼───────────────────┐
                 │ Tier 1        │  │ Tier 2     │  │ Tier 3             │
                 │ Server-side   │  │ Local      │  │ Server-assisted    │
                 │ full index    │  │ index      │  │ narrowing          │
                 ├───────────────┤  ├────────────┤  ├────────────────────┤
                 │ Unencrypted   │  │ Encrypted, │  │ Encrypted, outside │
                 │ mail + all    │  │ within the │  │ the local window   │
                 │ other entity  │  │ local      │  │                    │
                 │ types         │  │ window     │  │                    │
                 └───────────────┘  └────────────┘  └────────────────────┘
```

### Tier 1 — Server-side, unchanged

The existing `SearchProvider` continues to serve unencrypted messages, all contacts, and every calendar event, note and task that is not derived from an encrypted external message (§3) — at full fidelity with existing ranking intact. No changes to `MongoTextSearchProvider`, `PostgresFullTextSearchProvider` or `OpenSearchProvider` are required.

Encrypted messages and derived encrypted entities MUST still be indexed server-side with the fields from §2 that remain available. This keeps participant and date search working across the entire mailbox regardless of tier.

### Tier 2 — Local index over a bounded window

The client maintains a full-fidelity local index over decrypted content for a bounded, recent subset of encrypted entities — messages and any derived encrypted calendar events, notes or tasks (§3).

**The window is bounded because the mailbox is not.** At the 1M+ message target, a full local inverted index is not viable in a browser and is unwelcome on mobile.

The window is defined by two dimensions serving different purposes:

- **A time floor** — the user-facing dimension. Expressed as "at least the last N months," extended backwards while budget allows. Users reason about recency, not counts: "sometime last month" is a real memory, "in the last 5,000 messages" is not.
- **A byte budget** — the enforcement dimension. This is what devices actually constrain; browser quota is measured in bytes. It can only ever _shrink_ the window below the time floor, never extend it.

A message count ceiling MUST NOT be used. Message sizes vary by orders of magnitude, making count a poor proxy for both storage consumed and time covered.

When the byte budget forces the window below the configured time floor, the client MUST report the actual coverage through `SearchResultPage.coverage.indexedFrom` (§12) rather than silently under-covering.

Entities are added to the local index as they are decrypted, and evicted oldest-first when the byte budget is reached.

**The window bounds what is fast, not what is findable.** Tier 3 reaches everything outside it. The UI MUST offer an explicit "search all mail" action that opts into the slower path, and SHOULD offer to extend the window when a user repeatedly finds results beyond it.

### Tier 3 — Server-assisted narrowing

For encrypted entities outside the local window, the server narrows on metadata it already possesses and the client verifies.

1. Client issues the query with a filter derived from the query text where possible (participants, date ranges).
2. Server returns a candidate set of `entityUid`s, ranked only on the metadata available to it.
3. Client fetches, decrypts and matches locally, discarding non-matches.
4. Matching results are scored client-side and merged.

**This introduces no new leakage.** The server's narrowing uses only fields from the "already knows" list in §4, and the server never learns which candidates matched. The cost is bandwidth and latency proportional to the candidate set, not confidentiality.

The candidate set MUST be capped and MUST be fetched in pages, so an unfiltered query over a million-message archive degrades to "searching older mail…" with incremental results rather than a multi-gigabyte download.

## 7. Ranking and Merge

Scores from the three tiers are not comparable. `ts_rank` values, OpenSearch `_score` values and client-computed scores occupy different ranges, and encrypted server-side results are ranked on `participants` alone.

**The client MUST re-score all results it can see in plaintext** using a single scoring function, applying the existing field weights so that relevance ordering matches today's behaviour:

| Field            | Weight |
| ---------------- | ------ |
| `subject`        | 3      |
| `participants`   | 2      |
| `body`           | 1      |
| `attachmentText` | 1      |

Tier 1 results for unencrypted messages arrive with a server score. The client MUST normalise these into the same space rather than interleaving raw scores. The normalisation function MUST be defined once and shared, not implemented per provider.

**Results the client has not yet re-scored** — an encrypted entity matched only on server-visible metadata, whose content has not yet been fetched and decrypted — MUST be rendered as skeleton entries in place, per §_Progressive Results_, using the metadata score as a provisional position. They MUST NOT be presented at a fabricated content score, and they MUST NOT be deferred to the end of the list.

On resolution a skeleton either takes its true position or is pruned. Movement of unresolved entries is expected and MUST be animated rather than instantaneous, so the reader can track it.

### Snippets

`SearchResult.snippet` is populated by the provider today, where supported. For encrypted results the server cannot generate one. The client MUST generate snippets locally for any result it has decrypted, using the same highlighting rules, so snippet presence does not visibly differ by tier.

This is also an opportunity to populate `snippet` in `OpenSearchProvider`, which currently leaves it undefined despite the interface declaring it.

## 8. Pagination

The current offset cursor does not survive a merge. Two sources advancing independent offsets cannot produce stable pages: a result promoted by client-side re-scoring shifts the merge boundary, and offsets drift apart.

The merged cursor MUST be a composite, opaque to the caller, carrying at minimum:

- the server-side offset consumed so far,
- the local index position consumed so far,
- the Tier 3 candidate-set position,
- a query fingerprint, so a cursor cannot be replayed against a different query.

Cursors MUST remain opaque strings at the API boundary, preserving the existing `SearchQuery.cursor` contract.

The client MUST over-fetch from each source relative to the requested page size, because re-scoring reorders results and a result ranked tenth by the server may rank first after re-scoring.

## 9. Attachment Extraction

`AttachmentExtractionJob` and `ExtractorRegistry` cannot process encrypted attachments. For encrypted mail, extraction moves client-side, and this is the heaviest single client-side cost in the design.

Requirements:

- The client MUST apply its own size cap and timeout, mirroring `mail:search:extraction:max_bytes` (25 MB) and `mail:search:extraction:timeout_ms` (30 s), configurable downward per platform.
- Extraction MUST run off the UI thread.
- Extraction MUST be deferrable. An attachment whose text is not yet extracted is not an error — it simply is not content-searchable yet, matching the existing server-side semantics where an unsupported or oversized attachment is skipped without error and remains findable by filename.
- The client SHOULD prioritise PDF and DOCX at lower size caps than the server, and MAY decline extraction entirely on constrained platforms.

Filenames are not encrypted content in the same way as bodies and SHOULD remain searchable via Tier 1 where the MIME structure permits.

## 10. Client Capability Matrix

Search fidelity is a property of the client, not of the mailbox. This MUST be surfaced in the UI rather than discovered.

| Client                 | Local index                   | Attachment extraction | Encrypted search fidelity                    |
| ---------------------- | ----------------------------- | --------------------- | -------------------------------------------- |
| Native desktop         | Full, on-disk, large window   | Full                  | Highest — window may cover the whole mailbox |
| Native mobile          | Bounded window                | PDF only, reduced cap | Good for recent mail, Tier 3 beyond          |
| Web                    | Bounded window, quota-limited | Best-effort           | Moderate; window materially smaller          |
| **Outlook (MAPI/EAS)** | **None**                      | **None**              | **Encrypted mail is not searchable at all**  |

The Outlook row is a consequence of using an existing client that cannot hold a RapidMX-managed index or decrypt on RapidMX's behalf. It is a documented limitation, not a defect, and MUST appear in user-facing documentation.

## 11. Index Lifecycle

**Initial build.** A newly unlocked device has no local index. The client MUST build it incrementally, newest-first, so the most likely searches work soonest.

**Incomplete-index UX.** While the index is incomplete, search MUST return the results it has and MUST indicate that coverage is partial, naming the covered range. It MUST NOT present partial results as complete.

**Persistence and protection.** The local index is derived from plaintext and MUST be encrypted at rest under the mailbox master key (MK) defined in `end-to-end_encryption.md`, using the same AEAD construction. It MUST be destroyed on the same events that destroy private keys: explicit logout, session revocation, and the configurable idle timeout.

**Invalidation.** The index MUST be discarded and rebuilt on key rotation affecting stored content, on schema version change, and on detection of corruption.

**Eviction.** Oldest-first, against the byte budget. Eviction MUST NOT block search.

**Storage budget.** The client MUST track index size against its byte budget and MUST reduce the window rather than fail writes when the budget is reached. On web, quota-exceeded MUST be handled as a normal operating state, not an error.

### Window Sizing

Index size is approximately `extractable_text_bytes × ratio`. The ratio depends on two choices: whether term positions are stored — required for phrase search — and whether snippets are cached. A term-only index lands well under half the source text; a positional index with a snippet cache can approach it. Email averages a few KB of extractable text after HTML stripping, putting the expected cost in the low single-digit KB per message.

These defaults are starting points and MUST be validated against a real mailbox before release. Measured index size per thousand messages is the input this document cannot supply.

| Platform       | Time floor | Byte budget  |
| -------------- | ---------- | ------------ |
| Native desktop | Unbounded  | Disk-limited |
| Web            | 12 months  | ~500 MB      |
| Native mobile  | 6 months   | ~250 MB      |

Mobile is smaller for **build cost**, not storage. Decrypting and indexing tens of thousands of messages on a phone is a battery and thermal event, and it dominates the first-run experience far more than the disk it consumes.

### Platform Hazards

**Browser storage is evictable.** Safari's storage policy is materially stricter than Chrome's and has historically evicted origin data after a period without user interaction. A web index can therefore disappear with no user action and no warning. The client MUST treat a missing or partial index as a normal state and rebuild, never as an error condition.

**Quota is shared across the origin.** The index competes with everything else stored under the same origin. The byte budget MUST be a fraction of available quota, not all of it, and the client MUST re-evaluate available quota rather than assuming a fixed ceiling.

**Persistent storage SHOULD be requested** where the platform offers it, but MUST NOT be assumed granted.

## 12. Interface Changes

Additive to the existing contracts.

```ts
/** Which tier produced a result, so the client can re-score, group and label appropriately. */
export type SearchResultSource = "server" | "local" | "candidate";

export interface SearchResult {
    entityType: SearchEntityType;
    entityUid: string;
    score: number;
    snippet?: string;
    /** Which tier produced this result. */
    source?: SearchResultSource;
    /** True when `score` is derived from server-visible metadata only and is not comparable to re-scored results. */
    metadataOnly?: boolean;
}

export interface SearchResultPage {
    results: SearchResult[];
    nextCursor?: string;
    /** Present when the local index does not yet cover the full mailbox. */
    coverage?: {
        /** Oldest message date covered by the local index. */
        indexedFrom?: Date;
        /** True while an initial build or backfill is in progress. */
        building: boolean;
        /** Messages indexed locally so far. */
        indexedCount: number;
    };
}

/** Requests a Tier 3 candidate set. Server-side; returns identifiers only, never content. */
export interface CandidateQuery {
    mailboxUid: string;
    entityTypes?: SearchEntityType[];
    /** Participant terms extracted from the query text, matched against server-visible envelope data. */
    participants?: string[];
    before?: Date;
    after?: Date;
    limit?: number;
    cursor?: string;
}
```

`SearchQuery` is unchanged. `SearchProvider` is unchanged; the candidate endpoint is a separate route rather than a fifth method, since it returns identifiers rather than ranked results and applies only to encrypted entities.

## 13. Local Index Implementation

**SQLite with FTS5**, on every platform. Native SQLite on desktop and mobile; SQLite compiled to WebAssembly over OPFS on web.

### Rationale

One engine across three platforms means one query implementation, one ranking function and one schema. The alternatives fail on specific requirements:

| Requirement               | SQLite FTS5                                                                                                 | JS libraries (Lunr, FlexSearch, MiniSearch, Orama)                |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Per-field ranking weights | `bm25()` accepts per-column weights, mapping directly onto the existing `subject^3 / participants^2` scheme | Varies; approximation at best                                     |
| Snippet generation        | `snippet()` and `highlight()` built in                                                                      | Mostly absent                                                     |
| Incremental insert/delete | Native                                                                                                      | Memory-resident; the whole index must be re-serialised to persist |
| Phrase and prefix queries | Native                                                                                                      | Partial                                                           |
| Metadata cache colocation | Same database                                                                                               | Separate store required                                           |

The serialisation point is decisive. At a 12-month window on an active mailbox, re-serialising an in-memory index on every decrypted message is not viable.

The index database also holds the decrypted metadata cache — titles, participants, dates needed for rendering — so there is one local store rather than two.

### Web Platform Constraints

- **OPFS sync access handles are Worker-only.** This aligns with the requirement that indexing not run on the UI thread.
- **Choose the SAH Pool VFS.** The plain `opfs` VFS requires cross-origin isolation via COOP and COEP response headers; the OPFS SAH Pool VFS does not, at the cost of being single-connection. Take the SAH Pool unless multiple connections are genuinely needed.

### Encryption at Rest

This is the one place where platforms diverge and the only genuine implementation risk.

- **Native:** SQLCipher provides page-level encryption and is mature. Key derived from MK.
- **Web:** no official SQLCipher WASM build exists. Encryption at rest requires a custom VFS that encrypts pages before they reach OPFS.

Content fields MUST NOT be encrypted before insertion into FTS5 — the index requires plaintext tokens, and encrypting them reduces the design to the deterministic keyword index rejected in §5. Protection must therefore be at the storage layer, not the record layer.

**Prototype the encrypting VFS before committing.** wa-sqlite exists specifically to support custom storage layers and is the easier base for this; the official `@sqlite.org/sqlite-wasm` build is better supported but harder to extend. If an encrypting VFS proves unworkable on web, the at-rest requirement in §11 must be revisited explicitly rather than quietly dropped — noting that browser OPFS is origin-isolated but not encrypted against local disk access.

## 14. Query Grammar

A light operator syntax is introduced and applies to **all tiers**, including Tier 1. Encrypted and unencrypted results must respond to the same query language, or the tiering becomes visible to the user.

### Operators

| Operator            | Matches                             |
| ------------------- | ----------------------------------- |
| `from:`             | Sender address or display name      |
| `to:`, `cc:`        | Recipient addresses                 |
| `subject:`          | Subject or title                    |
| `has:attachment`    | Presence of attachments             |
| `before:`, `after:` | Date bounds                         |
| `in:`               | Folder or calendar                  |
| `is:`               | Flags — `read`, `unread`, `flagged` |
| `type:`             | Maps to `SearchQuery.entityTypes`   |

Unqualified terms remain free text and are matched as they are today. Quoted strings are phrase queries. A leading `-` negates.

### Required Schema Changes

`SearchDocument` cannot support these operators as currently defined:

| Gap                                                                                                   | Change                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `participants[]` flattens sender and recipients together, so `from:` and `to:` are indistinguishable  | Split into `from`, `to[]`, `cc[]`; retain `participants[]` as the union for existing free-text ranking |
| Folder is absent                                                                                      | Add `folderUid`                                                                                        |
| Flags are absent                                                                                      | Add `flags[]`                                                                                          |
| Attachment presence is implicit in `attachmentText[]`, which is empty for non-extractable attachments | Add `hasAttachments: boolean`                                                                          |

These are additive and require a full re-index on deployment.

### Provider Implementation

The operator portion becomes filter predicates; the free-text portion continues to drive relevance ranking.

- **Postgres:** replace `plainto_tsquery` with `websearch_to_tsquery`, which handles quoted phrases, `OR` and `-` negation safely on untrusted input. Operators become SQL `WHERE` predicates alongside the existing `search_vector @@` match.
- **OpenSearch:** the free-text portion remains a `multi_match` in `must`; operators become `term` and `range` clauses in `filter`, where they do not contribute to `_score`.
- **Mongo:** `$text` for free text, `$and` predicates for operators.
- **Local (FTS5):** FTS5 `MATCH` for free text, SQL predicates for operators.

Parsing MUST happen once, client-side, producing a structured query passed to every tier. Each provider translates the same structure, so tiers cannot diverge in interpretation.

Tier 3 candidate narrowing uses the `from`, `to`, `cc`, `before`, `after`, `in` and `is` predicates, all of which resolve against server-visible fields. Free text and `subject:` cannot narrow at Tier 3 and are applied client-side after decryption.

## 15. Non-Goals

- **Encrypted server-side ranking.** No construction is adopted that computes relevance over ciphertext.
- **Query privacy against the client's own server for metadata.** The server already sees participants and dates; Tier 3 uses only that.
- **Parity with plaintext search on Outlook.** Not achievable; documented instead.

## 16. Measurement Task

One input remains outstanding and cannot be supplied by design work.

**Measure index size per thousand messages** on a representative mailbox, and validate the window defaults in §11 against it.

Method:

1. Build an FTS5 index over a sample of at least 10,000 real messages, post-HTML-stripping.
2. Measure in both configurations, since the ratio differs substantially: term-only, and positional with a snippet cache.
3. Measure database size on disk, including FTS5 auxiliary tables and the metadata cache — not just the token index.
4. Measure wall-clock build time on a mid-range phone, not a developer machine. Build cost, not storage, is what sets the mobile window.
5. Derive whether ~500 MB holds 12 months on web and ~250 MB holds 6 months on mobile, and adjust the defaults or the positional/snippet choices accordingly.

Until this is measured, the §11 table is a starting point and MUST NOT be treated as validated.

## Resolved

| Question                                     | Decision                                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which entity types are encrypted             | Scoped by provenance, not type. Messages per policy; calendar events when derived from an encrypted **external** message or originated as an encrypted invitation; contacts never. |
| Can a user originate an encrypted invitation | Yes, at any tier. The organiser's own copy is encrypted, per encrypt-to-self.                                                                                                      |
| Explicit user choice vs. tier scoping        | Explicit choice wins. Automatic protection is external-only; a deliberate decision to encrypt applies everywhere.                                                                  |
| Free/busy for encrypted events               | Preserved. Temporal fields stay server-visible; content fields are encrypted.                                                                                                      |
| Encrypted calendar fields                    | Title, notes, location, attachments only. Attendees, RSVP status, organiser and all temporal fields stay plaintext.                                                                |
| Why attendees stay plaintext                 | Already server-visible via `To`/`Cc` headers, which RFC 9788 retains by default. Encrypting them would protect nothing while breaking RSVP and delegation.                         |
| Provenance storage                           | Denormalised `EncryptionOrigin` enum on the entity, not a reference to the source message. `derived` and `originated` kept distinct so the UI can explain the lock.                |
| Provenance on edit vs. copy                  | Edits, updates and series exceptions inherit. Duplicates and templates do not, but the compose toggle defaults to on when copying from an encrypted source.                        |
| Late-arriving results                        | Skeletons rendered in place, reordering permitted, pruning on non-match. Appending late results is prohibited.                                                                     |
| Result counts during search                  | No hard count until all tiers report. `n of ??` until settled.                                                                                                                     |
| Calendar grid views                          | No tier restriction. Position is temporal and therefore plaintext, so encrypted events render in place and never move.                                                             |
| Local index window unit                      | Time floor as the user-facing dimension, byte budget as enforcement. Message count rejected — size varies too widely to proxy either.                                              |
| Window semantics                             | A floor extended backwards while budget allows, not a ceiling. Bounds what is fast, not what is findable.                                                                          |
| Local index engine                           | SQLite with FTS5 on all platforms. WASM over OPFS on web, using the SAH Pool VFS.                                                                                                  |
| Index encryption at rest                     | SQLCipher natively; custom encrypting VFS on web. Content fields are never encrypted before FTS5 insertion.                                                                        |
| Query operator grammar                       | Introduced, and applies to all tiers including Tier 1, so tiering stays invisible to the user.                                                                                     |
| `SearchDocument` schema                      | Additive changes required: split `from`/`to`/`cc`, add `folderUid`, `flags[]`, `hasAttachments`. Full re-index on deployment.                                                      |
