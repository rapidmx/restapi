///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { DataSource } from "typeorm";
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
        // `ADD COLUMN IF NOT EXISTS` rather than folding these into the `CREATE TABLE` above - that statement
        // is a no-op against a table an earlier version of this provider already created, so a deployment
        // upgrading from before these columns existed would otherwise never get them.
        await this.dataSource.query(`
            ALTER TABLE ${TABLE_NAME}
                ADD COLUMN IF NOT EXISTS from_address varchar(320),
                ADD COLUMN IF NOT EXISTS to_addresses text[],
                ADD COLUMN IF NOT EXISTS cc_addresses text[],
                ADD COLUMN IF NOT EXISTS folder_uid varchar(64),
                ADD COLUMN IF NOT EXISTS flags text[],
                ADD COLUMN IF NOT EXISTS label_uids text[],
                ADD COLUMN IF NOT EXISTS has_attachments boolean,
                ADD COLUMN IF NOT EXISTS metadata_only boolean
        `);
        await this.dataSource.query(
            `CREATE INDEX IF NOT EXISTS mail_search_index_vector ON ${TABLE_NAME} USING GIN (search_vector)`,
        );
        await this.dataSource.query(
            `CREATE INDEX IF NOT EXISTS mail_search_index_mailbox ON ${TABLE_NAME} (mailbox_uid, entity_type)`,
        );
        // Supports the structured operator-grammar filters (specs/search.md §14) and the Tier 3 candidate
        // query, neither of which goes through the `search_vector` GIN index above.
        await this.dataSource.query(
            `CREATE INDEX IF NOT EXISTS mail_search_index_folder ON ${TABLE_NAME} (mailbox_uid, folder_uid)`,
        );
        await this.dataSource.query(
            `CREATE INDEX IF NOT EXISTS mail_search_index_date ON ${TABLE_NAME} (mailbox_uid, date_for_sort)`,
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
                    (entity_type, entity_uid, mailbox_uid, subject, body, attachment_text, participants,
                     date_for_sort, search_vector, from_address, to_addresses, cc_addresses, folder_uid,
                     flags, label_uids, has_attachments, metadata_only)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                    setweight(to_tsvector('english', coalesce($4, '')), 'A') ||
                    setweight(to_tsvector('english', coalesce($5, '')), 'B') ||
                    setweight(to_tsvector('english', coalesce($6, '')), 'C') ||
                    setweight(to_tsvector('english', coalesce($7, '')), 'D'),
                    $9, $10, $11, $12, $13, $14, $15, $16)
                 ON CONFLICT (entity_type, entity_uid) DO UPDATE SET
                    mailbox_uid = EXCLUDED.mailbox_uid,
                    subject = EXCLUDED.subject,
                    body = EXCLUDED.body,
                    attachment_text = EXCLUDED.attachment_text,
                    participants = EXCLUDED.participants,
                    date_for_sort = EXCLUDED.date_for_sort,
                    search_vector = EXCLUDED.search_vector,
                    from_address = EXCLUDED.from_address,
                    to_addresses = EXCLUDED.to_addresses,
                    cc_addresses = EXCLUDED.cc_addresses,
                    folder_uid = EXCLUDED.folder_uid,
                    flags = EXCLUDED.flags,
                    label_uids = EXCLUDED.label_uids,
                    has_attachments = EXCLUDED.has_attachments,
                    metadata_only = EXCLUDED.metadata_only`,
                [
                    doc.entityType,
                    doc.entityUid,
                    doc.mailboxUid,
                    doc.subject ?? null,
                    doc.body ?? null,
                    attachmentText || null,
                    participants || null,
                    doc.dateForSort ?? null,
                    doc.from ?? null,
                    doc.to ?? null,
                    doc.cc ?? null,
                    doc.folderUid ?? null,
                    doc.flags ?? null,
                    doc.labels ?? null,
                    doc.hasAttachments ?? null,
                    doc.metadataOnly ?? null,
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

    /** Appends `condition` (using `$N` for the next placeholder) with `value` pushed onto `params`, returning
     * the placeholder number used - a dynamic version of the old fixed `$3`/`$4`-style indexing, which does
     * not scale to this method's now much larger set of optional predicates. */
    private addParam(params: any[], value: any): number {
        params.push(value);
        return params.length;
    }

    public async search(query: SearchQuery): Promise<SearchResultPage> {
        if (!this.dataSource) {
            return { results: [] };
        }

        const limit: number = Math.min(query.limit ?? 25, 200);
        const offset: number = query.cursor ? Math.max(0, parseInt(query.cursor, 10) || 0) : 0;

        const params: any[] = [query.mailboxUid];
        const conditions: string[] = ["mailbox_uid = $1"];
        let rankExpr = "0";

        if (query.text) {
            const p = this.addParam(params, query.text);
            conditions.push(`search_vector @@ websearch_to_tsquery('english', $${p})`);
            rankExpr = `ts_rank(search_vector, websearch_to_tsquery('english', $${p}))`;
        }
        if (query.subject !== undefined) {
            // `search_vector` combines every weighted field into one column - restricting to just `subject`
            // requires a separate `to_tsvector()` call scoped to that column alone, not a slice of the combined
            // vector. This is an additional AND predicate, not a replacement for the `text` match above.
            const p = this.addParam(params, query.subject);
            conditions.push(`to_tsvector('english', coalesce(subject, '')) @@ websearch_to_tsquery('english', $${p})`);
        }
        if (query.entityTypes && query.entityTypes.length > 0) {
            const p = this.addParam(params, query.entityTypes);
            conditions.push(`entity_type = ANY($${p}::text[])`);
        }
        if (query.from !== undefined) {
            const p = this.addParam(params, query.from);
            conditions.push(`from_address = $${p}`);
        }
        if (query.to !== undefined) {
            const p = this.addParam(params, query.to);
            conditions.push(`$${p} = ANY(to_addresses)`);
        }
        if (query.cc !== undefined) {
            const p = this.addParam(params, query.cc);
            conditions.push(`$${p} = ANY(cc_addresses)`);
        }
        if (query.hasAttachment !== undefined) {
            const p = this.addParam(params, query.hasAttachment);
            conditions.push(`has_attachments = $${p}`);
        }
        if (query.folderUid !== undefined) {
            const p = this.addParam(params, query.folderUid);
            conditions.push(`folder_uid = $${p}`);
        }
        if (query.flags && query.flags.length > 0) {
            const p = this.addParam(params, query.flags);
            conditions.push(`flags @> $${p}::text[]`);
        }
        if (query.labels && query.labels.length > 0) {
            const p = this.addParam(params, query.labels);
            conditions.push(`label_uids @> $${p}::text[]`);
        }
        if (query.before !== undefined) {
            const p = this.addParam(params, query.before);
            conditions.push(`date_for_sort < $${p}`);
        }
        if (query.after !== undefined) {
            const p = this.addParam(params, query.after);
            conditions.push(`date_for_sort > $${p}`);
        }

        const limitParam = this.addParam(params, limit + 1);
        const offsetParam = this.addParam(params, offset);
        const orderBy = query.text ? "rank DESC" : "date_for_sort DESC NULLS LAST";

        const rows: { entity_type: SearchEntityType; entity_uid: string; rank: number; metadata_only: boolean | null }[] =
            await this.dataSource.query(
                `SELECT entity_type, entity_uid, metadata_only, ${rankExpr} AS rank
                 FROM ${TABLE_NAME}
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY ${orderBy}
                 LIMIT $${limitParam} OFFSET $${offsetParam}`,
                params,
            );

        const hasMore: boolean = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        return {
            results: page.map((row) => ({
                entityType: row.entity_type,
                entityUid: row.entity_uid,
                score: Number(row.rank),
                metadataOnly: row.metadata_only ?? undefined,
            })),
            nextCursor: hasMore ? String(offset + limit) : undefined,
        };
    }

    public async candidates(query: CandidateQuery): Promise<CandidateResultPage> {
        if (!this.dataSource) {
            return { candidates: [] };
        }

        const limit: number = Math.min(query.limit ?? 25, 200);
        const offset: number = query.cursor ? Math.max(0, parseInt(query.cursor, 10) || 0) : 0;

        const params: any[] = [query.mailboxUid];
        const conditions: string[] = ["mailbox_uid = $1"];

        if (query.entityTypes && query.entityTypes.length > 0) {
            const p = this.addParam(params, query.entityTypes);
            conditions.push(`entity_type = ANY($${p}::text[])`);
        }
        if (query.participants && query.participants.length > 0) {
            // `participants` is a space-joined string, not an array column - `&&` overlap semantics aren't
            // available, so this matches any one of the requested participant terms appearing in it verbatim.
            const orTerms: string[] = query.participants.map((term) => {
                const p = this.addParam(params, term);
                return `participants ILIKE '%' || $${p} || '%'`;
            });
            conditions.push(`(${orTerms.join(" OR ")})`);
        }
        if (query.folderUid !== undefined) {
            const p = this.addParam(params, query.folderUid);
            conditions.push(`folder_uid = $${p}`);
        }
        if (query.flags && query.flags.length > 0) {
            const p = this.addParam(params, query.flags);
            conditions.push(`flags @> $${p}::text[]`);
        }
        if (query.labels && query.labels.length > 0) {
            const p = this.addParam(params, query.labels);
            conditions.push(`label_uids @> $${p}::text[]`);
        }
        if (query.before !== undefined) {
            const p = this.addParam(params, query.before);
            conditions.push(`date_for_sort < $${p}`);
        }
        if (query.after !== undefined) {
            const p = this.addParam(params, query.after);
            conditions.push(`date_for_sort > $${p}`);
        }

        const limitParam = this.addParam(params, limit + 1);
        const offsetParam = this.addParam(params, offset);

        const rows: { entity_type: SearchEntityType; entity_uid: string }[] = await this.dataSource.query(
            `SELECT entity_type, entity_uid
             FROM ${TABLE_NAME}
             WHERE ${conditions.join(" AND ")}
             ORDER BY date_for_sort DESC NULLS LAST
             LIMIT $${limitParam} OFFSET $${offsetParam}`,
            params,
        );

        const hasMore: boolean = rows.length > limit;
        const page = hasMore ? rows.slice(0, limit) : rows;

        return {
            candidates: page.map((row) => ({ entityType: row.entity_type, entityUid: row.entity_uid })),
            nextCursor: hasMore ? String(offset + limit) : undefined,
        };
    }
}
