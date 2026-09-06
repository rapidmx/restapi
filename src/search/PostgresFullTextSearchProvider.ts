///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { DataSource } from "typeorm";
import { ObjectDecorators } from "@rapidrest/core";
import { ConnectionManager } from "@rapidrest/service-core";
import { SearchDocument, SearchEntityType, SearchProvider, SearchQuery, SearchResultPage } from "./SearchProvider.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;

const TABLE_NAME = "mail_search_index";

/**
 * `SearchProvider` backed by Postgres's native full-text search (`tsvector`/`to_tsquery` with a GIN index) —
 * the embedded default for a SQL-backed deployment that hasn't opted into a dedicated search engine. Documents
 * are stored in a dedicated table separate from the entities they're derived from, keyed by
 * `(entity_type, entity_uid)`.
 *
 * @author Jean-Philippe Steinmetz
 */
export class PostgresFullTextSearchProvider implements SearchProvider {
    public readonly name: string = "postgres";

    @Inject(ConnectionManager)
    private connectionManager?: ConnectionManager;

    @Config("mail:search:postgres:datasource", "sql")
    private datasourceName: string = "sql";

    @Logger
    private logger: any;

    private dataSource?: DataSource;

    @Init
    private async init(): Promise<void> {
        const conn: any = this.connectionManager?.connections.get(this.datasourceName);
        if (!conn || typeof conn.query !== "function") {
            throw new Error(
                `PostgresFullTextSearchProvider: no SQL connection found for datasource '${this.datasourceName}'.`,
            );
        }
        this.dataSource = conn as DataSource;

        await this.dataSource.query(`
            CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
                entity_type varchar(32) NOT NULL,
                entity_uid varchar(64) NOT NULL,
                mailbox_uid varchar(64) NOT NULL,
                subject text,
                body text,
                attachment_text text,
                participants text,
                date_for_sort timestamptz,
                search_vector tsvector,
                PRIMARY KEY (entity_type, entity_uid)
            )
        `);
        await this.dataSource.query(
            `CREATE INDEX IF NOT EXISTS mail_search_index_vector ON ${TABLE_NAME} USING GIN (search_vector)`,
        );
        await this.dataSource.query(
            `CREATE INDEX IF NOT EXISTS mail_search_index_mailbox ON ${TABLE_NAME} (mailbox_uid, entity_type)`,
        );
    }

    public async index(doc: SearchDocument): Promise<void> {
        await this.bulkIndex([doc]);
    }

    public async bulkIndex(docs: SearchDocument[]): Promise<void> {
        if (!this.dataSource || docs.length === 0) {
            return;
        }
        for (const doc of docs) {
            const attachmentText: string = (doc.attachmentText ?? []).join("\n");
            const participants: string = (doc.participants ?? []).join(" ");
            await this.dataSource.query(
                `INSERT INTO ${TABLE_NAME}
                    (entity_type, entity_uid, mailbox_uid, subject, body, attachment_text, participants, date_for_sort, search_vector)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                    setweight(to_tsvector('english', coalesce($4, '')), 'A') ||
                    setweight(to_tsvector('english', coalesce($5, '')), 'B') ||
                    setweight(to_tsvector('english', coalesce($6, '')), 'C') ||
                    setweight(to_tsvector('english', coalesce($7, '')), 'D'))
                 ON CONFLICT (entity_type, entity_uid) DO UPDATE SET
                    mailbox_uid = EXCLUDED.mailbox_uid,
                    subject = EXCLUDED.subject,
                    body = EXCLUDED.body,
                    attachment_text = EXCLUDED.attachment_text,
                    participants = EXCLUDED.participants,
                    date_for_sort = EXCLUDED.date_for_sort,
                    search_vector = EXCLUDED.search_vector`,
                [
                    doc.entityType,
                    doc.entityUid,
                    doc.mailboxUid,
                    doc.subject ?? null,
                    doc.body ?? null,
                    attachmentText || null,
                    participants || null,
                    doc.dateForSort ?? null,
                ],
            );
        }
    }

    public async remove(entityType: SearchEntityType, entityUid: string): Promise<void> {
        await this.dataSource?.query(`DELETE FROM ${TABLE_NAME} WHERE entity_type = $1 AND entity_uid = $2`, [
            entityType,
            entityUid,
        ]);
    }

    public async search(query: SearchQuery): Promise<SearchResultPage> {
        if (!this.dataSource) {
            return { results: [] };
        }

        const limit: number = Math.min(query.limit ?? 25, 200);
        const offset: number = query.cursor ? Math.max(0, parseInt(query.cursor, 10) || 0) : 0;

        const typeFilter: string =
            query.entityTypes && query.entityTypes.length > 0 ? `AND entity_type = ANY($3::text[])` : "";
        const params: any[] = [query.mailboxUid, query.text];
        if (typeFilter) {
            params.push(query.entityTypes);
        }
        params.push(limit + 1, offset);

        const rows: { entity_type: SearchEntityType; entity_uid: string; rank: number }[] = await this.dataSource.query(
            `SELECT entity_type, entity_uid, ts_rank(search_vector, plainto_tsquery('english', $2)) AS rank
             FROM ${TABLE_NAME}
             WHERE mailbox_uid = $1 AND search_vector @@ plainto_tsquery('english', $2) ${typeFilter}
             ORDER BY rank DESC
             LIMIT $${typeFilter ? 4 : 3} OFFSET $${typeFilter ? 5 : 4}`,
            params,
        );

        const hasMore: boolean = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        return {
            results: page.map((row) => ({
                entityType: row.entity_type,
                entityUid: row.entity_uid,
                score: Number(row.rank),
            })),
            nextCursor: hasMore ? String(offset + limit) : undefined,
        };
    }
}
