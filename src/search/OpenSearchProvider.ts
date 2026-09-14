///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { importOptional } from "../util/OptionalDeps.js";
import {
    CandidateQuery,
    CandidateResultPage,
    MAX_SEARCH_OFFSET,
    nextSearchCursor,
    resolveSearchPaging,
    SearchDocument,
    SearchEntityType,
    SearchProvider,
    SearchQuery,
    SearchResultPage,
    truncateSearchDocumentText,
} from "./SearchProvider.js";
const { Config, Init, Logger } = ObjectDecorators;

/**
 * `SearchProvider` adapter for a dedicated OpenSearch cluster, via the optional peer dependency
 * `@opensearch-project/opensearch` — the recommended provider for larger deployments where the embedded
 * Mongo/Postgres default's relevance ranking and indexing throughput become a bottleneck. Selected via the
 * `search:provider: "opensearch"` config key.
 *
 * @author Jean-Philippe Steinmetz
 */
export class OpenSearchProvider implements SearchProvider {
    public readonly name: string = "opensearch";

    @Config("mail:search:opensearch:url", "https://localhost:9200")
    private url: string = "https://localhost:9200";

    @Config("mail:search:opensearch:index", "mail_search_index")
    private index_: string = "mail_search_index";

    @Config("mail:search:opensearch:username")
    private username?: string;

    @Config("mail:search:opensearch:password")
    private password?: string;

    /** Upper bound on one `_bulk` request's serialized body; larger batches are split across requests. */
    @Config("mail:search:opensearch:max_bulk_bytes", 10 * 1024 * 1024)
    private maxBulkBytes: number = 10 * 1024 * 1024;

    @Logger
    private logger: any;

    private client?: any;

    @Init
    private async init(): Promise<void> {
        const { Client } = await importOptional<any>("@opensearch-project/opensearch");
        this.client = new Client({
            node: this.url,
            auth: this.username ? { username: this.username, password: this.password } : undefined,
        });

        const exists = await this.client.indices.exists({ index: this.index_ });
        if (!exists.body) {
            await this.client.indices.create({
                index: this.index_,
                body: {
                    mappings: {
                        properties: {
                            entityType: { type: "keyword" },
                            entityUid: { type: "keyword" },
                            mailboxUid: { type: "keyword" },
                            subject: { type: "text" },
                            body: { type: "text" },
                            attachmentText: { type: "text" },
                            participants: { type: "text" },
                            from: { type: "keyword" },
                            to: { type: "keyword" },
                            cc: { type: "keyword" },
                            dateForSort: { type: "date" },
                            folderUid: { type: "keyword" },
                            flags: { type: "keyword" },
                            labels: { type: "keyword" },
                            hasAttachments: { type: "boolean" },
                            metadataOnly: { type: "boolean" },
                        },
                    },
                },
            });
        }
    }

    private docId(entityType: SearchEntityType, entityUid: string): string {
        return `${entityType}:${entityUid}`;
    }

    public async index(doc: SearchDocument): Promise<void> {
        await this.client.index({
            index: this.index_,
            id: this.docId(doc.entityType, doc.entityUid),
            body: truncateSearchDocumentText(doc),
            refresh: false,
        });
    }

    public async bulkIndex(docs: SearchDocument[]): Promise<string[]> {
        if (docs.length === 0) {
            return [];
        }

        // Split into `_bulk` requests of at most `maxBulkBytes` serialized NDJSON (OpenSearch's
        // `http.max_content_length` defaults to 100MB, and large requests pressure the cluster's heap long before
        // that) - a single document larger than the cap still goes out, alone, in its own chunk.
        const chunks: { docs: SearchDocument[]; body: any[] }[] = [];
        let current: { docs: SearchDocument[]; body: any[] } = { docs: [], body: [] };
        let currentBytes = 0;
        for (const doc of docs) {
            const action: any = { index: { _index: this.index_, _id: this.docId(doc.entityType, doc.entityUid) } };
            const source: SearchDocument = truncateSearchDocumentText(doc);
            const bytes: number = Buffer.byteLength(JSON.stringify(action)) + Buffer.byteLength(JSON.stringify(source)) + 2;
            if (current.docs.length > 0 && currentBytes + bytes > this.maxBulkBytes) {
                chunks.push(current);
                current = { docs: [], body: [] };
                currentBytes = 0;
            }
            current.docs.push(doc);
            current.body.push(action, source);
            currentBytes += bytes;
        }
        chunks.push(current);

        const indexed: string[] = [];
        for (const chunk of chunks) {
            let response: any;
            try {
                response = await this.client.bulk({ body: chunk.body });
            } catch (err: any) {
                if (err?.meta?.statusCode === 413) {
                    // The cluster's own request-size limit is lower than `max_bulk_bytes` - index this chunk one
                    // document at a time instead, isolating any single document that is itself too large.
                    indexed.push(...(await this.indexIndividually(chunk.docs)));
                    continue;
                }
                if (indexed.length === 0) {
                    // Nothing indexed yet: a whole-batch failure (e.g. cluster unreachable) - reject, per the contract.
                    throw err;
                }
                // Earlier chunks did index: report exactly those, leaving the rest for the caller to retry.
                this.logger?.warn(`OpenSearchProvider: bulk request failed after ${indexed.length} indexed document(s): ${err?.message ?? err}`);
                return indexed;
            }
            indexed.push(...this.readBulkResponse(chunk.docs, response));
        }
        return indexed;
    }

    /** The `_bulk` API responds 200 even when individual items fail, flagging that only via a top-level
     * `errors: true` plus a per-item `error` - so success must be read per item, in request order, rather
     * than inferred from the call resolving. */
    private readBulkResponse(docs: SearchDocument[], response: any): string[] {
        const result: any = response?.body ?? response;
        if (!result?.errors) {
            return docs.map((doc) => doc.entityUid);
        }
        const items: any[] = Array.isArray(result.items) ? result.items : [];
        const indexed: string[] = [];
        docs.forEach((doc, i) => {
            const item: any = items[i] ? (items[i].index ?? Object.values(items[i])[0]) : undefined;
            if (item && !item.error && (item.status === undefined || item.status < 300)) {
                indexed.push(doc.entityUid);
            } else {
                const reason: string = item?.error ? (item.error.reason ?? item.error.type ?? JSON.stringify(item.error)) : "no bulk response item";
                this.logger?.warn(`OpenSearchProvider: failed to index ${doc.entityType} ${doc.entityUid}: ${reason}`);
            }
        });
        return indexed;
    }

    private async indexIndividually(docs: SearchDocument[]): Promise<string[]> {
        const indexed: string[] = [];
        for (const doc of docs) {
            try {
                await this.index(doc);
                indexed.push(doc.entityUid);
            } catch (err: any) {
                this.logger?.warn(`OpenSearchProvider: failed to index ${doc.entityType} ${doc.entityUid}: ${err?.message ?? err}`);
            }
        }
        return indexed;
    }

    public async remove(entityType: SearchEntityType, entityUid: string): Promise<void> {
        try {
            await this.client.delete({ index: this.index_, id: this.docId(entityType, entityUid) });
        } catch (err: any) {
            // A 404 (already absent) is not an error for a remove() call — every other status is.
            if (err?.meta?.statusCode !== 404) {
                throw err;
            }
        }
    }

    /** Builds the `filter` clauses shared by `search()` and `candidates()` - the structured operator-grammar
     * predicates (specs/search.md §14), none of which contribute to `_score`. `flags` is pushed as one `term`
     * clause per flag (not a single `terms` clause, which OpenSearch matches as OR) so `is:read is:flagged`
     * requires every named flag to be present, matching Mongo/Postgres's AND semantics for the same operator. */
    private structuredFilter(
        mailboxUid: string,
        entityTypes: SearchEntityType[] | undefined,
        folderUid: string | undefined,
        flags: string[] | undefined,
        labels: string[] | undefined,
        before: Date | undefined,
        after: Date | undefined,
    ): any[] {
        const filter: any[] = [{ term: { mailboxUid } }];
        if (entityTypes && entityTypes.length > 0) {
            filter.push({ terms: { entityType: entityTypes } });
        }
        if (folderUid !== undefined) {
            filter.push({ term: { folderUid } });
        }
        for (const flag of flags ?? []) {
            filter.push({ term: { flags: flag } });
        }
        for (const label of labels ?? []) {
            filter.push({ term: { labels: label } });
        }
        if (before !== undefined || after !== undefined) {
            const range: any = {};
            if (before !== undefined) {
                range.lt = before;
            }
            if (after !== undefined) {
                range.gt = after;
            }
            filter.push({ range: { dateForSort: range } });
        }
        return filter;
    }

    public async search(query: SearchQuery): Promise<SearchResultPage> {
        const { limit, offset: from } = resolveSearchPaging(query.limit, query.cursor);
        // `from + size` must stay within OpenSearch's default `max_result_window` (10,000), or the request is
        // rejected outright - near that ceiling, fetch fewer rows rather than erroring.
        const size: number = Math.max(0, Math.min(limit + 1, MAX_SEARCH_OFFSET - from));

        const filter: any[] = this.structuredFilter(
            query.mailboxUid,
            query.entityTypes,
            query.folderUid,
            query.flags,
            query.labels,
            query.before,
            query.after,
        );
        if (query.from !== undefined) {
            filter.push({ term: { from: query.from } });
        }
        if (query.to !== undefined) {
            filter.push({ term: { to: query.to } });
        }
        if (query.cc !== undefined) {
            filter.push({ term: { cc: query.cc } });
        }
        if (query.hasAttachment !== undefined) {
            filter.push({ term: { hasAttachments: query.hasAttachment } });
        }

        const must: any[] = [];
        if (query.text) {
            must.push({
                multi_match: {
                    query: query.text,
                    fields: ["subject^3", "body", "attachmentText", "participants^2"],
                },
            });
        }
        if (query.subject !== undefined) {
            // Scoped to the `subject` field alone, as an additional required clause alongside (not instead
            // of) the `multi_match` above - `subject:` narrows, it doesn't replace free-text ranking.
            must.push({ match: { subject: query.subject } });
        }
        if (must.length === 0) {
            must.push({ match_all: {} });
        }

        const response = await this.client.search({
            index: this.index_,
            body: {
                query: { bool: { must, filter } },
                // Populates `SearchResult.snippet` - previously left undefined despite the interface
                // declaring it (specs/search.md §1 calls this out explicitly as a pre-existing gap).
                highlight: { fields: { subject: {}, body: {}, attachmentText: {} } },
                sort: query.text || query.subject ? undefined : [{ dateForSort: "desc" }],
                from,
                size,
            },
        });

        const hits: any[] = response.body.hits.hits;
        const hasMore: boolean = hits.length > limit;
        const page: any[] = hasMore ? hits.slice(0, limit) : hits;

        return {
            results: page.map((hit) => ({
                entityType: hit._source.entityType,
                entityUid: hit._source.entityUid,
                score: hit._score,
                snippet: hit.highlight ? Object.values(hit.highlight).flat().join(" … ") : undefined,
                metadataOnly: hit._source.metadataOnly,
            })),
            nextCursor: nextSearchCursor(hasMore, from, limit),
        };
    }

    public async candidates(query: CandidateQuery): Promise<CandidateResultPage> {
        const { limit, offset: from } = resolveSearchPaging(query.limit, query.cursor);
        // `from + size` must stay within OpenSearch's default `max_result_window` (10,000), or the request is
        // rejected outright - near that ceiling, fetch fewer rows rather than erroring.
        const size: number = Math.max(0, Math.min(limit + 1, MAX_SEARCH_OFFSET - from));

        const filter: any[] = this.structuredFilter(
            query.mailboxUid,
            query.entityTypes,
            query.folderUid,
            query.flags,
            query.labels,
            query.before,
            query.after,
        );

        // `participants` is mapped `text` (analyzed), not `keyword` - a `terms` exact-match query wouldn't
        // reliably match against it, so this uses `should`/`minimum_should_match` (matches any one term) the
        // same way `must`'s `match` clauses work elsewhere in this file, instead of `terms`.
        const must: any[] =
            query.participants && query.participants.length > 0
                ? [{ bool: { should: query.participants.map((p) => ({ match: { participants: p } })), minimum_should_match: 1 } }]
                : [{ match_all: {} }];

        const response = await this.client.search({
            index: this.index_,
            body: {
                query: { bool: { must, filter } },
                sort: [{ dateForSort: "desc" }],
                from,
                size,
            },
        });

        const hits: any[] = response.body.hits.hits;
        const hasMore: boolean = hits.length > limit;
        const page: any[] = hasMore ? hits.slice(0, limit) : hits;

        return {
            candidates: page.map((hit) => ({ entityType: hit._source.entityType, entityUid: hit._source.entityUid })),
            nextCursor: nextSearchCursor(hasMore, from, limit),
        };
    }
}
