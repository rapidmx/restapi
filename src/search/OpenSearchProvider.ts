///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { importOptional } from "../util/OptionalDeps.js";
import { SearchDocument, SearchEntityType, SearchProvider, SearchQuery, SearchResultPage } from "./SearchProvider.js";
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
                            dateForSort: { type: "date" },
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
            body: doc,
            refresh: false,
        });
    }

    public async bulkIndex(docs: SearchDocument[]): Promise<void> {
        if (docs.length === 0) {
            return;
        }
        const body: any[] = docs.flatMap((doc) => [
            { index: { _index: this.index_, _id: this.docId(doc.entityType, doc.entityUid) } },
            doc,
        ]);
        await this.client.bulk({ body });
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

    public async search(query: SearchQuery): Promise<SearchResultPage> {
        const limit: number = Math.min(query.limit ?? 25, 200);
        const from: number = query.cursor ? Math.max(0, parseInt(query.cursor, 10) || 0) : 0;

        const filter: any[] = [{ term: { mailboxUid: query.mailboxUid } }];
        if (query.entityTypes && query.entityTypes.length > 0) {
            filter.push({ terms: { entityType: query.entityTypes } });
        }

        const response = await this.client.search({
            index: this.index_,
            body: {
                query: {
                    bool: {
                        must: [
                            {
                                multi_match: {
                                    query: query.text,
                                    fields: ["subject^3", "body", "attachmentText", "participants^2"],
                                },
                            },
                        ],
                        filter,
                    },
                },
                from,
                size: limit + 1,
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
            })),
            nextCursor: hasMore ? String(from + limit) : undefined,
        };
    }
}
