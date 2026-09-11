///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for OpenSearchProvider - `@opensearch-project/opensearch`'s `Client` is mocked at the
// module level so `init()` never opens a real network connection.
const mockClientInstance = {
    indices: {
        exists: vi.fn(),
        create: vi.fn(),
    },
    index: vi.fn(),
    bulk: vi.fn(),
    delete: vi.fn(),
    search: vi.fn(),
};
const mockClientCtor = vi.fn(function MockClient() {
    return mockClientInstance;
});
vi.mock("@opensearch-project/opensearch", () => ({
    Client: mockClientCtor,
}));

import { OpenSearchProvider } from "../../src/search/OpenSearchProvider.js";
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

describe("OpenSearchProvider Tests", () => {
    let provider: OpenSearchProvider;

    beforeEach(() => {
        provider = new OpenSearchProvider();
        mockClientInstance.indices.exists.mockReset().mockResolvedValue({ body: true });
        mockClientInstance.indices.create.mockReset().mockResolvedValue({});
        mockClientInstance.index.mockReset().mockResolvedValue({});
        mockClientInstance.bulk.mockReset().mockResolvedValue({});
        mockClientInstance.delete.mockReset().mockResolvedValue({});
        mockClientInstance.search.mockReset().mockResolvedValue({ body: { hits: { hits: [] } } });
        mockClientCtor.mockClear();
    });

    describe("init()", () => {
        it("Constructs the Client with the configured url/auth and does not create the index when it already exists.", async () => {
            (provider as any).url = "https://os.example.com:9200";
            (provider as any).username = "admin";
            (provider as any).password = "secret";
            mockClientInstance.indices.exists.mockResolvedValue({ body: true });

            await (provider as any).init();

            expect(mockClientCtor).toHaveBeenCalledWith({
                node: "https://os.example.com:9200",
                auth: { username: "admin", password: "secret" },
            });
            expect(mockClientInstance.indices.create).not.toHaveBeenCalled();
        });

        it("Creates the index with the expected mappings when it does not already exist.", async () => {
            mockClientInstance.indices.exists.mockResolvedValue({ body: false });

            await (provider as any).init();

            expect(mockClientInstance.indices.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    index: "mail_search_index",
                    body: expect.objectContaining({
                        mappings: expect.objectContaining({
                            properties: expect.objectContaining({
                                entityType: { type: "keyword" },
                                subject: { type: "text" },
                            }),
                        }),
                    }),
                }),
            );
        });

        it("Passes undefined auth when no username is configured.", async () => {
            await (provider as any).init();

            expect(mockClientCtor).toHaveBeenCalledWith(expect.objectContaining({ auth: undefined }));
        });
    });

    describe("index() / bulkIndex()", () => {
        beforeEach(async () => {
            await (provider as any).init();
        });

        it("index() indexes a single document by its composite id, without refresh.", async () => {
            const doc = makeDoc();

            await provider.index(doc);

            expect(mockClientInstance.index).toHaveBeenCalledWith({
                index: "mail_search_index",
                id: "message:msg-1",
                body: doc,
                refresh: false,
            });
        });

        it("bulkIndex() builds paired action/doc lines for each document.", async () => {
            const docs = [makeDoc({ entityUid: "msg-1" }), makeDoc({ entityUid: "msg-2", entityType: "note" })];

            await provider.bulkIndex(docs);

            expect(mockClientInstance.bulk).toHaveBeenCalledWith({
                body: [
                    { index: { _index: "mail_search_index", _id: "message:msg-1" } },
                    docs[0],
                    { index: { _index: "mail_search_index", _id: "note:msg-2" } },
                    docs[1],
                ],
            });
        });

        it("bulkIndex() is a no-op when given an empty array.", async () => {
            await provider.bulkIndex([]);

            expect(mockClientInstance.bulk).not.toHaveBeenCalled();
        });
    });

    describe("remove()", () => {
        beforeEach(async () => {
            await (provider as any).init();
        });

        it("Deletes the document by its composite id.", async () => {
            await provider.remove("message", "msg-1");

            expect(mockClientInstance.delete).toHaveBeenCalledWith({
                index: "mail_search_index",
                id: "message:msg-1",
            });
        });

        it("Swallows a 404 (already absent) without throwing.", async () => {
            mockClientInstance.delete.mockRejectedValue({ meta: { statusCode: 404 } });

            await expect(provider.remove("message", "msg-1")).resolves.toBeUndefined();
        });

        it("Rethrows a non-404 error.", async () => {
            mockClientInstance.delete.mockRejectedValue({ meta: { statusCode: 500 }, message: "boom" });

            await expect(provider.remove("message", "msg-1")).rejects.toMatchObject({ meta: { statusCode: 500 } });
        });

        it("Rethrows an error with no meta at all.", async () => {
            mockClientInstance.delete.mockRejectedValue(new Error("connection refused"));

            await expect(provider.remove("message", "msg-1")).rejects.toThrow(/connection refused/);
        });
    });

    describe("search()", () => {
        beforeEach(async () => {
            await (provider as any).init();
        });

        it("Builds the multi_match query with the mailboxUid term filter, and maps hits without a next page.", async () => {
            mockClientInstance.search.mockResolvedValue({
                body: {
                    hits: {
                        hits: [{ _source: { entityType: "message", entityUid: "msg-1" }, _score: 2.5 }],
                    },
                },
            });

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello" });

            expect(mockClientInstance.search).toHaveBeenCalledWith(
                expect.objectContaining({
                    index: "mail_search_index",
                    body: expect.objectContaining({
                        query: expect.objectContaining({
                            bool: expect.objectContaining({
                                must: [
                                    expect.objectContaining({
                                        multi_match: expect.objectContaining({ query: "hello" }),
                                    }),
                                ],
                                filter: [{ term: { mailboxUid: "mbx-1" } }],
                            }),
                        }),
                        from: 0,
                        size: 26,
                    }),
                }),
            );
            expect(result).toEqual({
                results: [{ entityType: "message", entityUid: "msg-1", score: 2.5 }],
                nextCursor: undefined,
            });
        });

        it("Applies an entityTypes filter when given.", async () => {
            await provider.search({ mailboxUid: "mbx-1", text: "hello", entityTypes: ["message", "note"] });

            const call = mockClientInstance.search.mock.calls[0][0];
            expect(call.body.query.bool.filter).toEqual([
                { term: { mailboxUid: "mbx-1" } },
                { terms: { entityType: ["message", "note"] } },
            ]);
        });

        it("Applies a numeric cursor as the `from` offset.", async () => {
            await provider.search({ mailboxUid: "mbx-1", text: "hello", cursor: "10" });

            const call = mockClientInstance.search.mock.calls[0][0];
            expect(call.body.from).toBe(10);
        });

        it("Treats a non-numeric cursor as a `from` offset of 0.", async () => {
            await provider.search({ mailboxUid: "mbx-1", text: "hello", cursor: "not-a-number" });

            const call = mockClientInstance.search.mock.calls[0][0];
            expect(call.body.from).toBe(0);
        });

        it("Sets hasMore/nextCursor when more hits are returned than the requested limit.", async () => {
            mockClientInstance.search.mockResolvedValue({
                body: {
                    hits: {
                        hits: Array.from({ length: 3 }, (_, i) => ({
                            _source: { entityType: "message", entityUid: `msg-${i}` },
                            _score: 1,
                        })),
                    },
                },
            });

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello", limit: 2 });

            expect(result.results).toHaveLength(2);
            expect(result.nextCursor).toBe("2");
        });

        it("Caps the effective limit at 200.", async () => {
            await provider.search({ mailboxUid: "mbx-1", text: "hello", limit: 10_000 });

            const call = mockClientInstance.search.mock.calls[0][0];
            expect(call.body.size).toBe(201);
        });

        it("Populates snippet from the highlight response, joining fragments across fields.", async () => {
            mockClientInstance.search.mockResolvedValue({
                body: {
                    hits: {
                        hits: [
                            {
                                _source: { entityType: "message", entityUid: "msg-1" },
                                _score: 1,
                                highlight: { subject: ["<em>Budget</em> Q3"], body: ["discussing the <em>budget</em>"] },
                            },
                        ],
                    },
                },
            });

            const result = await provider.search({ mailboxUid: "mbx-1", text: "budget" });

            expect(result.results[0].snippet).toBe("<em>Budget</em> Q3 … discussing the <em>budget</em>");
            const call = mockClientInstance.search.mock.calls[0][0];
            expect(call.body.highlight).toEqual({ fields: { subject: {}, body: {}, attachmentText: {} } });
        });

        it("Leaves snippet undefined when the hit carries no highlight.", async () => {
            mockClientInstance.search.mockResolvedValue({
                body: { hits: { hits: [{ _source: { entityType: "message", entityUid: "msg-1" }, _score: 1 }] } },
            });

            const result = await provider.search({ mailboxUid: "mbx-1", text: "budget" });

            expect(result.results[0].snippet).toBeUndefined();
        });

        it("Propagates metadataOnly from _source onto the result.", async () => {
            mockClientInstance.search.mockResolvedValue({
                body: {
                    hits: {
                        hits: [{ _source: { entityType: "message", entityUid: "msg-1", metadataOnly: true }, _score: 1 }],
                    },
                },
            });

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello" });

            expect(result.results[0].metadataOnly).toBe(true);
        });

        it("Applies structured operator-grammar filters (from/to/cc/hasAttachment) as term filters, and folderUid/flags/date-range via structuredFilter().", async () => {
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
                before,
                after,
            });

            const call = mockClientInstance.search.mock.calls[0][0];
            expect(call.body.query.bool.filter).toEqual(
                expect.arrayContaining([
                    { term: { mailboxUid: "mbx-1" } },
                    { term: { folderUid: "folder-1" } },
                    { term: { flags: "read" } },
                    { term: { flags: "flagged" } },
                    { range: { dateForSort: { lt: before, gt: after } } },
                    { term: { from: "alice@example.com" } },
                    { term: { to: "bob@example.com" } },
                    { term: { cc: "carol@example.com" } },
                    { term: { hasAttachments: true } },
                ]),
            );
        });

        it("Adds a subject-scoped match clause alongside multi_match when subject: is given.", async () => {
            await provider.search({ mailboxUid: "mbx-1", text: "hello", subject: "budget" });

            const call = mockClientInstance.search.mock.calls[0][0];
            expect(call.body.query.bool.must).toEqual(
                expect.arrayContaining([expect.objectContaining({ match: { subject: "budget" } })]),
            );
        });

        it("Uses match_all and sorts by dateForSort when neither text nor subject is given.", async () => {
            await provider.search({ mailboxUid: "mbx-1", text: "", folderUid: "folder-1" });

            const call = mockClientInstance.search.mock.calls[0][0];
            expect(call.body.query.bool.must).toEqual([{ match_all: {} }]);
            expect(call.body.sort).toEqual([{ dateForSort: "desc" }]);
        });
    });

    describe("candidates()", () => {
        beforeEach(async () => {
            await (provider as any).init();
        });

        it("Queries with match_all and structured filters, sorted by dateForSort, returning identifiers only.", async () => {
            mockClientInstance.search.mockResolvedValue({
                body: { hits: { hits: [{ _source: { entityType: "message", entityUid: "msg-1" } }] } },
            });

            const result = await provider.candidates({ mailboxUid: "mbx-1", entityTypes: ["message"], folderUid: "folder-1" });

            const call = mockClientInstance.search.mock.calls[0][0];
            expect(call.body.query.bool.must).toEqual([{ match_all: {} }]);
            expect(call.body.query.bool.filter).toEqual([
                { term: { mailboxUid: "mbx-1" } },
                { terms: { entityType: ["message"] } },
                { term: { folderUid: "folder-1" } },
            ]);
            expect(call.body.sort).toEqual([{ dateForSort: "desc" }]);
            expect(result).toEqual({ candidates: [{ entityType: "message", entityUid: "msg-1" }], nextCursor: undefined });
        });

        it("Matches on any of the given participant terms via should/minimum_should_match.", async () => {
            mockClientInstance.search.mockResolvedValue({ body: { hits: { hits: [] } } });

            await provider.candidates({ mailboxUid: "mbx-1", participants: ["bob@example.com", "carol@example.com"] });

            const call = mockClientInstance.search.mock.calls[0][0];
            expect(call.body.query.bool.must).toEqual([
                {
                    bool: {
                        should: [{ match: { participants: "bob@example.com" } }, { match: { participants: "carol@example.com" } }],
                        minimum_should_match: 1,
                    },
                },
            ]);
        });

        it("Sets hasMore/nextCursor when more hits are returned than the requested limit.", async () => {
            mockClientInstance.search.mockResolvedValue({
                body: {
                    hits: {
                        hits: Array.from({ length: 3 }, (_, i) => ({
                            _source: { entityType: "message", entityUid: `msg-${i}` },
                        })),
                    },
                },
            });

            const result = await provider.candidates({ mailboxUid: "mbx-1", limit: 2 });

            expect(result.candidates).toHaveLength(2);
            expect(result.nextCursor).toBe("2");
        });
    });
});
