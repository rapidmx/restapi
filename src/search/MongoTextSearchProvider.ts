///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Collection, Db } from "mongodb";
import { ObjectDecorators } from "@rapidrest/core";
import { ConnectionManager } from "@rapidrest/service-core";
import { SearchDocument, SearchEntityType, SearchProvider, SearchQuery, SearchResultPage } from "./SearchProvider.js";
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
    dateForSort?: Date;
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
            dateForSort: doc.dateForSort,
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

    public async search(query: SearchQuery): Promise<SearchResultPage> {
        if (!this.collection) {
            return { results: [] };
        }

        const limit: number = Math.min(query.limit ?? 25, 200);
        const skip: number = query.cursor ? Math.max(0, parseInt(query.cursor, 10) || 0) : 0;

        const filter: any = { mailboxUid: query.mailboxUid, $text: { $search: query.text } };
        if (query.entityTypes && query.entityTypes.length > 0) {
            filter.entityType = { $in: query.entityTypes };
        }

        const cursor = this.collection
            .find(filter, { projection: { score: { $meta: "textScore" } } })
            .sort({ score: { $meta: "textScore" } })
            .skip(skip)
            .limit(limit + 1);
        const rows: (StoredDoc & { score?: number })[] = await cursor.toArray();

        const hasMore: boolean = rows.length > limit;
        const page: (StoredDoc & { score?: number })[] = hasMore ? rows.slice(0, limit) : rows;

        return {
            results: page.map((row) => ({
                entityType: row.entityType,
                entityUid: row.entityUid,
                score: row.score ?? 0,
            })),
            nextCursor: hasMore ? String(skip + limit) : undefined,
        };
    }
}
