///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for PostgresFullTextSearchProvider - the injected ConnectionManager and the TypeORM
// `DataSource`-shaped connection it resolves are both hand-built mocks; no real Postgres connection is made.
import { PostgresFullTextSearchProvider } from "../../src/search/PostgresFullTextSearchProvider.js";
import type { SearchDocument } from "../../src/search/SearchProvider.js";

function makeDoc(overrides: Partial<SearchDocument> = {}): SearchDocument {
    return {
        entityType: "message",
        entityUid: "msg-1",
        mailboxUid: "mbx-1",
        subject: "Hello",
        body: "World",
        ...overrides,
    };
}

describe("PostgresFullTextSearchProvider Tests", () => {
    let provider: PostgresFullTextSearchProvider;
    let mockConnection: { query: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        provider = new PostgresFullTextSearchProvider();
        mockConnection = { query: vi.fn().mockResolvedValue([]) };
    });

    function wireConnection(): void {
        (provider as any).connectionManager = { connections: new Map([["sql", mockConnection]]) };
    }

    describe("init()", () => {
        it("Creates the table and both indexes in order.", async () => {
            wireConnection();

            await (provider as any).init();

            expect(mockConnection.query).toHaveBeenCalledTimes(6);
            expect(mockConnection.query.mock.calls[0][0]).toMatch(/CREATE TABLE IF NOT EXISTS mail_search_index/);
            expect(mockConnection.query.mock.calls[1][0]).toMatch(/ALTER TABLE mail_search_index/);
            expect(mockConnection.query.mock.calls[2][0]).toMatch(/CREATE INDEX IF NOT EXISTS mail_search_index_vector/);
            expect(mockConnection.query.mock.calls[3][0]).toMatch(/CREATE INDEX IF NOT EXISTS mail_search_index_mailbox/);
            expect(mockConnection.query.mock.calls[4][0]).toMatch(/CREATE INDEX IF NOT EXISTS mail_search_index_folder/);
            expect(mockConnection.query.mock.calls[5][0]).toMatch(/CREATE INDEX IF NOT EXISTS mail_search_index_date/);
        });

        it("Throws when no connection is found for the configured datasource.", async () => {
            (provider as any).connectionManager = { connections: new Map() };

            await expect((provider as any).init()).rejects.toThrow(/no SQL connection found/);
        });

        it("Throws when the resolved connection has no `query` function.", async () => {
            (provider as any).connectionManager = { connections: new Map([["sql", {}]]) };

            await expect((provider as any).init()).rejects.toThrow(/no SQL connection found/);
        });
    });

    describe("index() / bulkIndex()", () => {
        it("index() delegates to bulkIndex() and issues one parameterized INSERT.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            const doc = makeDoc();

            await provider.index(doc);

            expect(mockConnection.query).toHaveBeenCalledTimes(1);
            const [sql, params] = mockConnection.query.mock.calls[0];
            expect(sql).toMatch(/INSERT INTO mail_search_index/);
            expect(sql).toMatch(/ON CONFLICT \(entity_type, entity_uid\) DO UPDATE SET/);
            expect(params).toEqual([
                "message",
                "msg-1",
                "mbx-1",
                "Hello",
                "World",
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
            ]);
        });

        it("Falls back to null for subject/body when they are omitted.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            const doc = makeDoc({ subject: undefined, body: undefined });

            await provider.index(doc);

            const [, params] = mockConnection.query.mock.calls[0];
            expect(params[3]).toBeNull();
            expect(params[4]).toBeNull();
        });

        it("Joins attachmentText/participants arrays and falls back to null when empty.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            const doc = makeDoc({ attachmentText: ["p1", "p2"], participants: ["a@x.com"] });

            await provider.index(doc);

            const [, params] = mockConnection.query.mock.calls[0];
            expect(params[5]).toBe("p1\np2");
            expect(params[6]).toBe("a@x.com");
        });

        it("bulkIndex() issues one INSERT per document.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            const docs = [makeDoc({ entityUid: "msg-1" }), makeDoc({ entityUid: "msg-2" })];

            await provider.bulkIndex(docs);

            expect(mockConnection.query).toHaveBeenCalledTimes(2);
        });

        it("bulkIndex() is a no-op when given an empty array.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();

            await provider.bulkIndex([]);

            expect(mockConnection.query).not.toHaveBeenCalled();
        });

        it("bulkIndex() is a no-op when no dataSource has been initialized.", async () => {
            await expect(provider.bulkIndex([makeDoc()])).resolves.toBeUndefined();
        });
    });

    describe("remove()", () => {
        it("Deletes by entity_type/entity_uid.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();

            await provider.remove("message", "msg-1");

            expect(mockConnection.query).toHaveBeenCalledWith(
                "DELETE FROM mail_search_index WHERE entity_type = $1 AND entity_uid = $2",
                ["message", "msg-1"],
            );
        });

        it("Does not throw when no dataSource has been initialized.", async () => {
            await expect(provider.remove("message", "msg-1")).resolves.toBeUndefined();
        });
    });

    describe("search()", () => {
        it("Returns an empty result page when no dataSource has been initialized.", async () => {
            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello" });
            expect(result).toEqual({ results: [] });
        });

        it("Queries without a type filter when entityTypes is omitted, using positional params 3/4.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([{ entity_type: "message", entity_uid: "msg-1", rank: 0.5 }]);

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello" });

            const [sql, params] = mockConnection.query.mock.calls[0];
            expect(sql).not.toMatch(/entity_type = ANY/);
            expect(sql).toMatch(/LIMIT \$3 OFFSET \$4/);
            expect(params).toEqual(["mbx-1", "hello", 26, 0]);
            expect(result).toEqual({
                results: [{ entityType: "message", entityUid: "msg-1", score: 0.5 }],
                nextCursor: undefined,
            });
        });

        it("Applies the type filter with positional params 4/5 when entityTypes is given.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([]);

            await provider.search({ mailboxUid: "mbx-1", text: "hello", entityTypes: ["message", "note"] });

            const [sql, params] = mockConnection.query.mock.calls[0];
            expect(sql).toMatch(/AND entity_type = ANY\(\$3::text\[\]\)/);
            expect(sql).toMatch(/LIMIT \$4 OFFSET \$5/);
            expect(params).toEqual(["mbx-1", "hello", ["message", "note"], 26, 0]);
        });

        it("Applies a numeric cursor as the offset.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([]);

            await provider.search({ mailboxUid: "mbx-1", text: "hello", cursor: "15" });

            const [, params] = mockConnection.query.mock.calls[0];
            expect(params[params.length - 1]).toBe(15);
        });

        it("Treats a non-numeric cursor as offset 0.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([]);

            await provider.search({ mailboxUid: "mbx-1", text: "hello", cursor: "not-a-number" });

            const [, params] = mockConnection.query.mock.calls[0];
            expect(params[params.length - 1]).toBe(0);
        });

        it("Sets hasMore/nextCursor when more rows are returned than the requested limit.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            const rows = Array.from({ length: 3 }, (_, i) => ({
                entity_type: "message",
                entity_uid: `msg-${i}`,
                rank: 1,
            }));
            mockConnection.query.mockResolvedValueOnce(rows);

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello", limit: 2 });

            expect(result.results).toHaveLength(2);
            expect(result.nextCursor).toBe("2");
        });

        it("Caps the effective limit at 200.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([]);

            await provider.search({ mailboxUid: "mbx-1", text: "hello", limit: 10_000 });

            const [, params] = mockConnection.query.mock.calls[0];
            expect(params[2]).toBe(201);
        });

        it("Uses websearch_to_tsquery, not plainto_tsquery, for the free-text match.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([]);

            await provider.search({ mailboxUid: "mbx-1", text: "hello -spam" });

            const [sql] = mockConnection.query.mock.calls[0];
            expect(sql).toMatch(/websearch_to_tsquery/);
            expect(sql).not.toMatch(/plainto_tsquery/);
        });

        it("Propagates metadata_only from the row onto the result as metadataOnly.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([
                { entity_type: "message", entity_uid: "msg-1", rank: 0.1, metadata_only: true },
            ]);

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello" });

            expect(result.results[0].metadataOnly).toBe(true);
        });

        it("Applies structured operator-grammar filters as WHERE predicates, in addition to the free-text match.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([]);
            const before = new Date("2026-06-01");
            const after = new Date("2026-01-01");

            await provider.search({
                mailboxUid: "mbx-1",
                text: "hello",
                from: "alice@example.com",
                to: "bob@example.com",
                cc: "carol@example.com",
                hasAttachment: true,
                folderUid: "folder-1",
                flags: ["read", "flagged"],
                labels: ["label-a", "label-b"],
                before,
                after,
            });

            const [sql, params] = mockConnection.query.mock.calls[0];
            expect(sql).toMatch(/from_address = \$\d+/);
            expect(sql).toMatch(/\$\d+ = ANY\(to_addresses\)/);
            expect(sql).toMatch(/\$\d+ = ANY\(cc_addresses\)/);
            expect(sql).toMatch(/has_attachments = \$\d+/);
            expect(sql).toMatch(/folder_uid = \$\d+/);
            expect(sql).toMatch(/flags @> \$\d+::text\[\]/);
            expect(sql).toMatch(/label_uids @> \$\d+::text\[\]/);
            expect(sql).toMatch(/date_for_sort < \$\d+/);
            expect(sql).toMatch(/date_for_sort > \$\d+/);
            expect(params).toEqual(
                expect.arrayContaining([
                    "alice@example.com",
                    "bob@example.com",
                    "carol@example.com",
                    true,
                    "folder-1",
                    ["read", "flagged"],
                    ["label-a", "label-b"],
                    before,
                    after,
                ]),
            );
        });

        it("Matches subject: against a subject-scoped tsvector, as an additional AND predicate alongside the free-text match.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([]);

            await provider.search({ mailboxUid: "mbx-1", text: "", subject: "budget" });

            const [sql, params] = mockConnection.query.mock.calls[0];
            expect(sql).toMatch(/to_tsvector\('english', coalesce\(subject, ''\)\) @@ websearch_to_tsquery/);
            expect(params).toContain("budget");
        });

        it("Sorts by date_for_sort, not rank, when text is empty - a pure structured-filter query.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([]);

            await provider.search({ mailboxUid: "mbx-1", text: "", folderUid: "folder-1" });

            const [sql] = mockConnection.query.mock.calls[0];
            expect(sql).toMatch(/ORDER BY date_for_sort DESC NULLS LAST/);
        });
    });

    describe("candidates()", () => {
        it("Returns an empty page when no dataSource has been initialized.", async () => {
            const result = await provider.candidates({ mailboxUid: "mbx-1" });
            expect(result).toEqual({ candidates: [] });
        });

        it("Filters by mailboxUid, entityTypes, participants (OR'd ILIKE), folderUid/flags/labels/date range, sorted by date, identifiers only.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            mockConnection.query.mockResolvedValueOnce([{ entity_type: "message", entity_uid: "msg-1" }]);

            const before = new Date("2026-06-01");
            const after = new Date("2026-01-01");
            const result = await provider.candidates({
                mailboxUid: "mbx-1",
                entityTypes: ["message"],
                participants: ["bob@example.com", "carol@example.com"],
                folderUid: "folder-1",
                flags: ["read", "flagged"],
                labels: ["label-a"],
                before,
                after,
            });

            const [sql, params] = mockConnection.query.mock.calls[0];
            expect(sql).toMatch(/SELECT entity_type, entity_uid/);
            expect(sql).not.toMatch(/search_vector|rank/);
            expect(sql).toMatch(/participants ILIKE '%' \|\| \$\d+ \|\| '%' OR participants ILIKE '%' \|\| \$\d+ \|\| '%'/);
            expect(sql).toMatch(/flags @> \$\d+::text\[\]/);
            expect(sql).toMatch(/label_uids @> \$\d+::text\[\]/);
            expect(sql).toMatch(/date_for_sort < \$\d+/);
            expect(sql).toMatch(/date_for_sort > \$\d+/);
            expect(sql).toMatch(/ORDER BY date_for_sort DESC NULLS LAST/);
            expect(params).toEqual(
                expect.arrayContaining([
                    "mbx-1",
                    ["message"],
                    "bob@example.com",
                    "carol@example.com",
                    "folder-1",
                    ["read", "flagged"],
                    ["label-a"],
                    before,
                    after,
                ]),
            );
            expect(result).toEqual({ candidates: [{ entityType: "message", entityUid: "msg-1" }], nextCursor: undefined });
        });

        it("Sets hasMore/nextCursor when more rows are returned than the requested limit.", async () => {
            wireConnection();
            await (provider as any).init();
            mockConnection.query.mockClear();
            const rows = Array.from({ length: 3 }, (_, i) => ({ entity_type: "message", entity_uid: `msg-${i}` }));
            mockConnection.query.mockResolvedValueOnce(rows);

            const result = await provider.candidates({ mailboxUid: "mbx-1", limit: 2 });

            expect(result.candidates).toHaveLength(2);
            expect(result.nextCursor).toBe("2");
        });
    });
});
