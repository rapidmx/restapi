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
    SearchDocument,
    SearchEntityType,
    SearchProvider,
    SearchQuery,
    SearchResultPage,
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
    participants?: string;
    from?: string;
    to?: string[];
    cc?: string[];
    dateForSort?: Date;
    folderUid?: string;
    flags?: string[];
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

    private toStoredDoc(doc: SearchDocument): StoredDoc {
        return {
            _id: this.docId(doc.entityType, doc.entityUid),
            entityType: doc.entityType,
            entityUid: doc.entityUid,
            mailboxUid: doc.mailboxUid,
            subject: doc.subject,
            body: doc.body,
            attachmentText: doc.attachmentText?.join("\n"),
            participants: doc.participants?.join(" "),
            from: doc.from,
            to: doc.to,
            cc: doc.cc,
            dateForSort: doc.dateForSort,
            folderUid: doc.folderUid,
            flags: doc.flags,
            hasAttachments: doc.hasAttachments,
            metadataOnly: doc.metadataOnly,
        };
    }

    public async index(doc: SearchDocument): Promise<void> {
        await this.bulkIndex([doc]);
    }

    public async bulkIndex(docs: SearchDocument[]): Promise<void> {
        if (!this.collection || docs.length === 0) {
            return;
        }
        await this.collection.bulkWrite(
            docs.map((doc) => ({
                replaceOne: {
                    filter: { _id: this.docId(doc.entityType, doc.entityUid) },
                    replacement: this.toStoredDoc(doc),
                    upsert: true,
                },
            })),
        );
    }

    public async remove(entityType: SearchEntityType, entityUid: string): Promise<void> {
        await this.collection?.deleteOne({ _id: this.docId(entityType, entityUid) });
    }

    /** Applies the structured operator-grammar predicates (specs/search.md §14) shared by `search()` and
     * `candidates()`. `$text` (free-text ranking) is deliberately not built here - `search()` layers it on
     * separately, and `candidates()` never uses it at all (metadata-only, per its own doc comment). */
    private structuredFilter(entityTypes: SearchEntityType[] | undefined, before?: Date, after?: Date, folderUid?: string, flags?: string[]): any {
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

        const limit: number = Math.min(query.limit ?? 25, 200);
        const skip: number = query.cursor ? Math.max(0, parseInt(query.cursor, 10) || 0) : 0;

        const filter: any = {
            mailboxUid: query.mailboxUid,
            ...this.structuredFilter(query.entityTypes, query.before, query.after, query.folderUid, query.flags),
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
            nextCursor: hasMore ? String(skip + limit) : undefined,
        };
    }

    public async candidates(query: CandidateQuery): Promise<CandidateResultPage> {
        if (!this.collection) {
            return { candidates: [] };
        }

        const limit: number = Math.min(query.limit ?? 25, 200);
        const skip: number = query.cursor ? Math.max(0, parseInt(query.cursor, 10) || 0) : 0;

        const filter: any = {
            mailboxUid: query.mailboxUid,
            ...this.structuredFilter(query.entityTypes, query.before, query.after, query.folderUid, query.flags),
        };
        if (query.participants && query.participants.length > 0) {
            filter.participants = { $in: query.participants };
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
            nextCursor: hasMore ? String(skip + limit) : undefined,
        };
    }
}
