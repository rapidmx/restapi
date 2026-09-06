///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The kind of entity a `SearchDocument` represents. */
export type SearchEntityType = "message" | "contact" | "calendarEvent" | "note" | "task";

/**
 * A flattened, provider-agnostic representation of one searchable entity, built from a `Message`/`Contact`/
 * `CalendarEvent`/`Note`/`Task` record (plus, for a message, its attachments' extracted text) and handed to a
 * `SearchProvider` for indexing.
 */
export interface SearchDocument {
    entityType: SearchEntityType;
    entityUid: string;
    mailboxUid: string;
    subject?: string;
    body?: string;
    attachmentText?: string[];
    participants?: string[];
    dateForSort?: Date;
}

/** A search query issued against `BaseSearchRoute` / `SearchProvider.search()`. */
export interface SearchQuery {
    mailboxUid: string;
    text: string;
    entityTypes?: SearchEntityType[];
    limit?: number;
    cursor?: string;
}

/** A single ranked hit returned by `SearchProvider.search()`. */
export interface SearchResult {
    entityType: SearchEntityType;
    entityUid: string;
    score: number;
    /** A short, provider-generated snippet highlighting the matched text, if supported. */
    snippet?: string;
}

/** The page of results returned by `SearchProvider.search()`. */
export interface SearchResultPage {
    results: SearchResult[];
    /** Opaque cursor to pass back as `SearchQuery.cursor` to retrieve the next page, if more results exist. */
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

    /** Indexes (or re-indexes) a batch of documents in one call, for efficient backfill/reconciliation. */
    bulkIndex(docs: SearchDocument[]): Promise<void>;

    /** Removes a previously indexed document. A no-op if it was never indexed. */
    remove(entityType: SearchEntityType, entityUid: string): Promise<void>;

    /** Executes a search query, returning ranked results across the requested entity types. */
    search(query: SearchQuery): Promise<SearchResultPage>;
}
