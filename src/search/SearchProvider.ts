///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * The maximum total number of characters of free text (`subject` + `body` + every `attachmentText` entry,
 * counted in that order) a provider stores/indexes for a single `SearchDocument` - see
 * `truncateSearchDocumentText()`. A message with a very large body or many large extracted attachments would
 * otherwise exceed backend-specific hard limits (MongoDB's 16MB document limit, OpenSearch's `http.max_content_length`
 * for a bulk request) and fail to index at all. 1,000,000 characters is far beyond what's useful for ranking.
 */
export const MAX_SEARCH_DOCUMENT_TEXT_CHARS = 1_000_000;

/** The maximum page size any `SearchProvider.search()`/`candidates()` returns - a larger requested `limit` is
 * clamped down to this; a `limit` below 1 is clamped up to 1. */
export const MAX_SEARCH_PAGE_SIZE = 100;

/** The default page size when a query specifies no (or a non-numeric) `limit`. */
export const DEFAULT_SEARCH_PAGE_SIZE = 25;

/** The maximum offset (decoded from an opaque `cursor`) any provider will page to - deep offset paging is
 * expensive on every backend (and OpenSearch rejects `from + size` beyond its default `max_result_window` of
 * 10,000 outright). A larger cursor is clamped to this, and no `nextCursor` is returned past it. */
export const MAX_SEARCH_OFFSET = 10_000;

/**
 * Resolves a query's `limit`/`cursor` to a bounded `{ limit, offset }` pair (`limit` in
 * `1..MAX_SEARCH_PAGE_SIZE`, `offset` in `0..MAX_SEARCH_OFFSET`), shared by every provider so paging bounds are
 * identical regardless of backend.
 */
export function resolveSearchPaging(limit: number | undefined, cursor: string | undefined): { limit: number; offset: number } {
    const requested: number = Number(limit);
    const resolvedLimit: number =
        limit === undefined || limit === null || !Number.isFinite(requested)
            ? DEFAULT_SEARCH_PAGE_SIZE
            : Math.min(MAX_SEARCH_PAGE_SIZE, Math.max(1, Math.floor(requested)));
    const parsedOffset: number = cursor ? parseInt(cursor, 10) : 0;
    const offset: number = Number.isFinite(parsedOffset) ? Math.min(MAX_SEARCH_OFFSET, Math.max(0, parsedOffset)) : 0;
    return { limit: resolvedLimit, offset };
}

/** Returns the `nextCursor` for a page, or `undefined` when there are no more results or the next page would
 * start past `MAX_SEARCH_OFFSET` (so a client paging forward terminates instead of re-reading the clamped page
 * forever). */
export function nextSearchCursor(hasMore: boolean, offset: number, limit: number): string | undefined {
    return hasMore && offset + limit <= MAX_SEARCH_OFFSET ? String(offset + limit) : undefined;
}

/** Truncates `value` to at most `max` characters without splitting a UTF-16 surrogate pair. */
function truncateChars(value: string, max: number): string {
    if (value.length <= max) {
        return value;
    }
    let end: number = Math.max(0, max);
    const code: number = value.charCodeAt(end - 1);
    if (end > 0 && code >= 0xd800 && code <= 0xdbff) {
        end--;
    }
    return value.slice(0, end);
}

/**
 * Returns a copy of `doc` whose `subject`/`body`/`attachmentText` together contain at most `maxChars`
 * characters (default `MAX_SEARCH_DOCUMENT_TEXT_CHARS`), filled in priority order: subject, then body, then
 * attachment text entries in order (an entry that no longer fits is truncated, and every later entry dropped).
 * A document already within budget is returned unchanged (same object).
 */
export function truncateSearchDocumentText(doc: SearchDocument, maxChars: number = MAX_SEARCH_DOCUMENT_TEXT_CHARS): SearchDocument {
    const total: number =
        (doc.subject?.length ?? 0) +
        (doc.body?.length ?? 0) +
        (doc.attachmentText ?? []).reduce((sum, text) => sum + (text?.length ?? 0), 0);
    if (total <= maxChars) {
        return doc;
    }

    let remaining: number = maxChars;
    const take = (value: string | undefined): string | undefined => {
        if (value === undefined || value === null) {
            return value;
        }
        const result: string = truncateChars(value, remaining);
        remaining -= result.length;
        return result;
    };

    const subject: string | undefined = take(doc.subject);
    const body: string | undefined = take(doc.body);
    let attachmentText: string[] | undefined;
    if (doc.attachmentText) {
        attachmentText = [];
        for (const text of doc.attachmentText) {
            if (remaining <= 0) {
                break;
            }
            attachmentText.push(take(text) ?? "");
        }
    }
    return { ...doc, subject, body, attachmentText };
}

/** The kind of entity a `SearchDocument` represents. */
export type SearchEntityType = "message" | "contact" | "calendarEvent" | "note" | "task";

/**
 * A flattened, provider-agnostic representation of one searchable entity, built from a `Message`/`Contact`/
 * `CalendarEvent`/`Note`/`Task` record (plus, for a message, its attachments' extracted text) and handed to a
 * `SearchProvider` for indexing.
 *
 * `from`/`to`/`cc` and `participants` (the spec's "Required Schema Changes", `specs/search.md` §14) are both
 * populated together, not one derived from the other at query time: `participants` remains the flattened union
 * used by existing free-text ranking (weighted like `body`), while `from`/`to`/`cc` exist so the `from:`/`to:`/
 * `cc:` query operators can filter on a specific role rather than "any participant".
 */
export interface SearchDocument {
    entityType: SearchEntityType;
    entityUid: string;
    mailboxUid: string;
    subject?: string;
    body?: string;
    attachmentText?: string[];
    /** The union of `from`/`to`/`cc`, for existing free-text participant ranking. */
    participants?: string[];
    /** Sender address - powers the `from:` query operator. */
    from?: string;
    /** Recipient (`To`) addresses - powers the `to:` query operator. */
    to?: string[];
    /** Recipient (`Cc`) addresses - powers the `cc:` query operator. */
    cc?: string[];
    dateForSort?: Date;
    /** The folder this entity currently resides in - powers the `in:` query operator. */
    folderUid?: string;
    /** Flag/state strings (e.g. `"read"`, `"unread"`, `"flagged"`) - powers the `is:` query operator. */
    flags?: string[];
    /** Whether the entity has attachments - powers the `has:attachment` query operator. */
    hasAttachments?: boolean;
    /** `Label.uid`s applied to this entity (a message), if any - powers the `label:` query operator. Matched
     * by uid, the same "client resolves the human-readable form first" convention `folderUid`/`in:` uses. */
    labels?: string[];
    /**
     * True when this document was built from an encrypted entity whose `subject`/`body`/`attachmentText`
     * were therefore intentionally excluded (`specs/search.md` §2/§6, Tier 1 still indexes the reduced field
     * set for an encrypted message so participant/date search keeps working, but a score computed from that
     * reduced set is not comparable to one computed from full content). Propagated to
     * `SearchResult.metadataOnly` on every result built from this document.
     */
    metadataOnly?: boolean;
}

/**
 * A search query issued against `BaseSearchRoute` / `SearchProvider.search()`.
 *
 * The structured filter fields below are the operator-grammar portion of a query (`specs/search.md` §14) -
 * `from:`/`to:`/`cc:`/`subject:`/`has:attachment`/`before:`/`after:`/`in:`/`is:`. Per the spec, parsing the
 * operator syntax out of raw query text ("`from:bob has:attachment foo`") happens once, client-side, so that
 * every tier (including a client's own local Tier 2/3 search) interprets it identically - this interface
 * accepts the already-parsed result, not raw operator text. `type:` needs no separate field; it maps directly
 * onto `entityTypes` below, which already existed. `text` continues to drive free-text relevance ranking
 * across the full weighted field set; the structured fields narrow via exact/range predicates instead.
 */
export interface SearchQuery {
    mailboxUid: string;
    text: string;
    entityTypes?: SearchEntityType[];
    limit?: number;
    cursor?: string;
    /** `from:` - sender address. */
    from?: string;
    /** `to:` - a recipient address in the `To` line. */
    to?: string;
    /** `cc:` - a recipient address in the `Cc` line. */
    cc?: string;
    /** `subject:` - restricts free-text-style matching to the subject/title field only, instead of `text`
     * matching against the full weighted field set. May be used together with or instead of `text`. */
    subject?: string;
    /** `has:attachment` */
    hasAttachment?: boolean;
    /** `before:` */
    before?: Date;
    /** `after:` */
    after?: Date;
    /** `in:` - folder or calendar uid. */
    folderUid?: string;
    /** `is:` - one or more flag/state strings, matched as an AND (all must be present). */
    flags?: string[];
    /** `label:` - one or more `Label.uid`s, matched as an AND (all must be present), the same semantics `is:`
     * already uses for flags. */
    labels?: string[];
}

/** A single ranked hit returned by `SearchProvider.search()`. */
export interface SearchResult {
    entityType: SearchEntityType;
    entityUid: string;
    score: number;
    /** A short, provider-generated snippet highlighting the matched text, if supported. */
    snippet?: string;
    /** True when `score` is derived from server-visible metadata only (participants/date, not content) and
     * is not comparable to a result scored from full content - see `SearchDocument.metadataOnly`. */
    metadataOnly?: boolean;
}

/** The page of results returned by `SearchProvider.search()`. */
export interface SearchResultPage {
    results: SearchResult[];
    /** Opaque cursor to pass back as `SearchQuery.cursor` to retrieve the next page, if more results exist. */
    nextCursor?: string;
}

/**
 * Requests a Tier 3 candidate set (`specs/search.md` §6 "Tier 3 — Server-assisted narrowing") - identifiers
 * only, ranked purely on server-visible metadata (participants, dates, folder, flags), never on content. For
 * an encrypted entity outside a client's local Tier 2 index window, the client uses this to narrow down to a
 * manageable candidate set, then fetches/decrypts/matches each candidate locally - the server never learns
 * which candidate actually matched.
 */
export interface CandidateQuery {
    mailboxUid: string;
    entityTypes?: SearchEntityType[];
    /** Participant terms extracted from the query text, matched against server-visible envelope data
     * (`from`/`to`/`cc`/`participants`). */
    participants?: string[];
    before?: Date;
    after?: Date;
    folderUid?: string;
    flags?: string[];
    labels?: string[];
    limit?: number;
    cursor?: string;
}

/** The page of candidate identifiers returned by `SearchProvider.candidates()`. */
export interface CandidateResultPage {
    candidates: { entityType: SearchEntityType; entityUid: string }[];
    nextCursor?: string;
}

/**
 * Provides full-text indexing and search over mail/contacts/calendar/notes/tasks content, independent of the
 * chosen persistence backend (Mongo/SQL have no native cross-entity relevance-ranked search of their own).
 * Implementations are selected via the `search:provider` config key and are never queried through `RepoUtils`.
 *
 * Index updates are eventually consistent with respect to the primary datastore — see `SearchIndexState` and
 * `SearchIndexJob` — so a just-created entity may briefly be readable via its own CRUD route before it becomes
 * findable via search.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface SearchProvider {
    /** A short, unique name for this provider implementation (e.g. `"mongo"`, `"postgres"`, `"opensearch"`). */
    readonly name: string;

    /** Indexes (or re-indexes) a single document. */
    index(doc: SearchDocument): Promise<void>;

    /**
     * Indexes (or re-indexes) a batch of documents in one call, for efficient backfill/reconciliation.
     *
     * Failures are isolated per document: one document the backend rejects (e.g. an oversized field, a mapping
     * conflict) must not prevent the rest of the batch from being indexed. Resolves with the `entityUid`s of the
     * documents that were actually indexed - a caller (`SearchIndexJob`) treats any document whose uid is absent
     * as not indexed and retries it later. May still reject outright for a failure that affects the whole batch
     * (e.g. the backend is unreachable), in which case no document should be assumed indexed.
     */
    bulkIndex(docs: SearchDocument[]): Promise<string[]>;

    /** Removes a previously indexed document. A no-op if it was never indexed. */
    remove(entityType: SearchEntityType, entityUid: string): Promise<void>;

    /** Executes a search query, returning ranked results across the requested entity types. */
    search(query: SearchQuery): Promise<SearchResultPage>;

    /** Executes a Tier 3 candidate query, returning identifiers only - see `CandidateQuery`'s own doc
     * comment. Ranked on server-visible metadata alone, never on `subject`/`body`/`attachmentText`. */
    candidates(query: CandidateQuery): Promise<CandidateResultPage>;
}
