///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Collection, Db } from "mongodb";
import { ObjectDecorators } from "@rapidrest/core";
import { ConnectionManager } from "@rapidrest/service-core";
import {
    CandidateQuery,
    CandidateResultPage,
    nextSearchCursor,
    resolveSearchPaging,
    SearchDocument,
    SearchEntityType,
    SearchProvider,
    SearchQuery,
    SearchResultPage,
    truncateSearchDocumentText,
} from "./SearchProvider.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

const COLLECTION_NAME = "mail_search_index";

/** The shape a `SearchDocument` is flattened/stored as in the dedicated Mongo search collection. */
interface StoredDoc {
    _id: string;
    entityType: SearchEntityType;
    entityUid: string;
    mailboxUid: string;
    subject?: string;
    body?: string;
    attachmentText?: string;
    /** Stored as an array of addresses. Documents indexed by an earlier version of this provider hold a
     * space-joined string instead - `candidates()` matches both shapes, and such a document is rewritten in
     * the array shape the next time it's re-indexed. */
    participants?: string[] | string;
    from?: string;
    to?: string[];
    cc?: string[];
    dateForSort?: Date;
    folderUid?: string;
    flags?: string[];
    labels?: string[];
    hasAttachments?: boolean;
    metadataOnly?: boolean;
}

/**
 * `SearchProvider` backed by MongoDB's native `$text` index — the embedded default for a Mongo-backed
 * deployment that hasn't opted into a dedicated search engine. Documents are stored in a collection separate
 * from the entities they're derived from (`mail_search_index`), keyed by `<entityType>:<entityUid>`.
 *
 * @author Jean-Philippe Steinmetz
 */
export class MongoTextSearchProvider implements SearchProvider {
    public readonly name: string = "mongo";

    @Inject(ConnectionManager)
    private connectionManager?: ConnectionManager;

    @Config("mail:search:mongo:datasource", "mongo")
    private datasourceName: string = "mongo";

    @Logger
    private logger: any;

    private collection?: Collection<StoredDoc>;

    @Init
    private async init(): Promise<void> {
        const conn: any = this.connectionManager?.connections.get(this.datasourceName);
        const db: Db | undefined = conn?.db;
        if (!db) {
            throw new Error(
                `MongoTextSearchProvider: no MongoDB connection found for datasource '${this.datasourceName}'.`,
            );
        }
        this.collection = db.collection<StoredDoc>(COLLECTION_NAME);
        await this.collection.createIndex(
            { subject: "text", body: "text", attachmentText: "text", participants: "text" },
            { name: "mail_search_text" },
        );
        await this.collection.createIndex({ mailboxUid: 1, entityType: 1 });
        // Supports the structured operator-grammar filters (specs/search.md §14) and the Tier 3 candidate
        // query, none of which go through the `$text` index above.
        await this.collection.createIndex({ mailboxUid: 1, folderUid: 1 });
        await this.collection.createIndex({ mailboxUid: 1, dateForSort: 1 });
    }

    private docId(entityType: SearchEntityType, entityUid: string): string {
        return `${entityType}:${entityUid}`;
    }

    private toStoredDoc(input: SearchDocument): StoredDoc {
        const doc: SearchDocument = truncateSearchDocumentText(input);
        return {
            _id: this.docId(doc.entityType, doc.entityUid),
            entityType: doc.entityType,
            entityUid: doc.entityUid,
            mailboxUid: doc.mailboxUid,
            subject: doc.subject,
            body: doc.body,
            attachmentText: doc.attachmentText?.join("\n"),
            participants: doc.participants,
            from: doc.from,
            to: doc.to,
            cc: doc.cc,
            dateForSort: doc.dateForSort,
            folderUid: doc.folderUid,
            flags: doc.flags,
            labels: doc.labels,
            hasAttachments: doc.hasAttachments,
            metadataOnly: doc.metadataOnly,
        };
    }

    public async index(doc: SearchDocument): Promise<void> {
        await this.bulkIndex([doc]);
    }

    public async bulkIndex(docs: SearchDocument[]): Promise<string[]> {
        if (!this.collection || docs.length === 0) {
            return [];
        }
        try {
            // `ordered: false` so one rejected document (e.g. one exceeding the BSON size limit) doesn't stop
            // the server from applying every later operation in the batch.
            await this.collection.bulkWrite(
                docs.map((doc) => ({
                    replaceOne: {
                        filter: { _id: this.docId(doc.entityType, doc.entityUid) },
                        replacement: this.toStoredDoc(doc),
                        upsert: true,
                    },
                })),
                { ordered: false },
            );
            return docs.map((doc) => doc.entityUid);
        } catch (err: any) {
            // A `MongoBulkWriteError` reports exactly which operations failed (by their index in the request);
            // every other operation was applied. Anything else (e.g. a connection failure) affects the whole
            // batch and is rethrown.
            const writeErrors: any[] | undefined =
                err?.writeErrors === undefined ? undefined : Array.isArray(err.writeErrors) ? err.writeErrors : [err.writeErrors];
            if (!writeErrors) {
                throw err;
            }
            const failed: Set<number> = new Set();
            for (const writeError of writeErrors) {
                const index: number = writeError?.index ?? writeError?.err?.index;
                failed.add(index);
                const doc: SearchDocument | undefined = docs[index];
                this.logger?.warn(
                    `MongoTextSearchProvider: failed to index ${doc?.entityType} ${doc?.entityUid}: ${writeError?.errmsg ?? writeError?.message ?? "unknown error"}`,
                );
            }
            return docs.filter((_doc, i) => !failed.has(i)).map((doc) => doc.entityUid);
        }
    }

    public async remove(entityType: SearchEntityType, entityUid: string): Promise<void> {
        await this.collection?.deleteOne({ _id: this.docId(entityType, entityUid) });
    }

    /** Applies the structured operator-grammar predicates (specs/search.md §14) shared by `search()` and
     * `candidates()`. `$text` (free-text ranking) is deliberately not built here - `search()` layers it on
     * separately, and `candidates()` never uses it at all (metadata-only, per its own doc comment). */
    private structuredFilter(
        entityTypes: SearchEntityType[] | undefined,
        before?: Date,
        after?: Date,
        folderUid?: string,
        flags?: string[],
        labels?: string[],
    ): any {
        const filter: any = {};
        if (entityTypes && entityTypes.length > 0) {
            filter.entityType = { $in: entityTypes };
        }
        if (folderUid !== undefined) {
            filter.folderUid = folderUid;
        }
        if (flags && flags.length > 0) {
            filter.flags = { $all: flags };
        }
        if (labels && labels.length > 0) {
            filter.labels = { $all: labels };
        }
        if (before !== undefined || after !== undefined) {
            filter.dateForSort = {};
            if (before !== undefined) {
                filter.dateForSort.$lt = before;
            }
            if (after !== undefined) {
                filter.dateForSort.$gt = after;
            }
        }
        return filter;
    }

    public async search(query: SearchQuery): Promise<SearchResultPage> {
        if (!this.collection) {
            return { results: [] };
        }

        const { limit, offset: skip } = resolveSearchPaging(query.limit, query.cursor);

        const filter: any = {
            mailboxUid: query.mailboxUid,
            ...this.structuredFilter(
                query.entityTypes,
                query.before,
                query.after,
                query.folderUid,
                query.flags,
                query.labels,
            ),
        };
        if (query.from !== undefined) {
            filter.from = query.from;
        }
        if (query.to !== undefined) {
            filter.to = query.to;
        }
        if (query.cc !== undefined) {
            filter.cc = query.cc;
        }
        if (query.hasAttachment !== undefined) {
            filter.hasAttachments = query.hasAttachment;
        }
        // `$text` cannot be scoped to a single field on a combined multi-field text index, so `subject:` falls
        // back to a case-insensitive regex against the (untokenized) `subject` string - correct, if not
        // stemmed/ranked the way the combined `$text` match is. Applied as an additional AND predicate, not a
        // replacement for `$text`, so `subject:foo bar` still ranks on `bar` across every field too.
        if (query.subject !== undefined) {
            filter.subject = { $regex: query.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
        }
        if (query.text) {
            filter.$text = { $search: query.text };
        }

        const projection: any = query.text ? { score: { $meta: "textScore" } } : {};
        const cursor = this.collection.find(filter, { projection });
        if (query.text) {
            cursor.sort({ score: { $meta: "textScore" } });
        } else {
            cursor.sort({ dateForSort: -1 });
        }
        cursor.skip(skip).limit(limit + 1);
        const rows: (StoredDoc & { score?: number })[] = await cursor.toArray();

        const hasMore: boolean = rows.length > limit;
        const page: (StoredDoc & { score?: number })[] = hasMore ? rows.slice(0, limit) : rows;

        return {
            results: page.map((row) => ({
                entityType: row.entityType,
                entityUid: row.entityUid,
                score: row.score ?? 0,
                metadataOnly: row.metadataOnly,
            })),
            nextCursor: nextSearchCursor(hasMore, skip, limit),
        };
    }

    public async candidates(query: CandidateQuery): Promise<CandidateResultPage> {
        if (!this.collection) {
            return { candidates: [] };
        }

        const { limit, offset: skip } = resolveSearchPaging(query.limit, query.cursor);

        const filter: any = {
            mailboxUid: query.mailboxUid,
            ...this.structuredFilter(
                query.entityTypes,
                query.before,
                query.after,
                query.folderUid,
                query.flags,
                query.labels,
            ),
        };
        if (query.participants && query.participants.length > 0) {
            // Matches a whole participant address, case-insensitively, against either stored shape: an array
            // element (current) or a space-delimited token inside the legacy joined string - a plain `$in` of
            // the raw terms would never match the legacy shape at all. Escaped, so a term is always literal.
            filter.participants = {
                $in: query.participants.map(
                    (term) => new RegExp(`(^|\\s)${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`, "i"),
                ),
            };
        }

        const rows: StoredDoc[] = await this.collection
            .find(filter, { projection: { entityType: 1, entityUid: 1 } })
            .sort({ dateForSort: -1 })
            .skip(skip)
            .limit(limit + 1)
            .toArray();

        const hasMore: boolean = rows.length > limit;
        const page: StoredDoc[] = hasMore ? rows.slice(0, limit) : rows;

        return {
            candidates: page.map((row) => ({ entityType: row.entityType, entityUid: row.entityUid })),
            nextCursor: nextSearchCursor(hasMore, skip, limit),
        };
    }
}
