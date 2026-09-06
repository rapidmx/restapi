///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for MongoTextSearchProvider - the injected ConnectionManager and the Mongo `Collection`
// it resolves are both hand-built mocks; no real MongoDB connection is made.
import { MongoTextSearchProvider } from "../../src/search/MongoTextSearchProvider.js";
import type { SearchDocument } from "../../src/search/SearchProvider.js";

/** Builds a chainable cursor mock matching the subset of the Mongo `find()` cursor API this provider uses. */
function makeCursor(rows: any[]) {
    const cursor: any = {
        sort: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(rows),
    };
    return cursor;
}

function makeCollection(overrides: any = {}) {
    return {
        createIndex: vi.fn().mockResolvedValue(undefined),
        bulkWrite: vi.fn().mockResolvedValue(undefined),
        deleteOne: vi.fn().mockResolvedValue(undefined),
        find: vi.fn().mockReturnValue(makeCursor([])),
        ...overrides,
    };
}

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

describe("MongoTextSearchProvider Tests", () => {
    let provider: MongoTextSearchProvider;
    let mockCollection: ReturnType<typeof makeCollection>;

    beforeEach(() => {
        provider = new MongoTextSearchProvider();
        mockCollection = makeCollection();
    });

    function wireConnection(): void {
        (provider as any).connectionManager = {
            connections: new Map([["mongo", { db: { collection: vi.fn().mockReturnValue(mockCollection) } }]]),
        };
    }

    describe("init()", () => {
        it("Creates the text and compound indexes against the resolved collection.", async () => {
            wireConnection();

            await (provider as any).init();

            expect(mockCollection.createIndex).toHaveBeenCalledWith(
                { subject: "text", body: "text", attachmentText: "text", participants: "text" },
                { name: "mail_search_text" },
            );
            expect(mockCollection.createIndex).toHaveBeenCalledWith({ mailboxUid: 1, entityType: 1 });
        });

        it("Throws when no connection is found for the configured datasource.", async () => {
            (provider as any).connectionManager = { connections: new Map() };

            await expect((provider as any).init()).rejects.toThrow(/no MongoDB connection found/);
        });

        it("Throws when the resolved connection has no `db`.", async () => {
            (provider as any).connectionManager = {
                connections: new Map([["mongo", {}]]),
            };

            await expect((provider as any).init()).rejects.toThrow(/no MongoDB connection found/);
        });
    });

    describe("index() / bulkIndex()", () => {
        it("index() delegates to bulkIndex() with a single-element array.", async () => {
            wireConnection();
            await (provider as any).init();
            const doc = makeDoc();

            await provider.index(doc);

            expect(mockCollection.bulkWrite).toHaveBeenCalledWith([
                {
                    replaceOne: {
                        filter: { _id: "message:msg-1" },
                        replacement: expect.objectContaining({
                            _id: "message:msg-1",
                            entityType: "message",
                            entityUid: "msg-1",
                            mailboxUid: "mbx-1",
                            subject: "Hello",
                            body: "World",
                        }),
                        upsert: true,
                    },
                },
            ]);
        });

        it("Flattens attachmentText and participants arrays into joined strings.", async () => {
            wireConnection();
            await (provider as any).init();
            const doc = makeDoc({ attachmentText: ["page one", "page two"], participants: ["a@x.com", "b@x.com"] });

            await provider.index(doc);

            const call = mockCollection.bulkWrite.mock.calls[0][0][0];
            expect(call.replaceOne.replacement.attachmentText).toBe("page one\npage two");
            expect(call.replaceOne.replacement.participants).toBe("a@x.com b@x.com");
        });

        it("bulkIndex() is a no-op when given an empty array.", async () => {
            wireConnection();
            await (provider as any).init();

            await provider.bulkIndex([]);

            expect(mockCollection.bulkWrite).not.toHaveBeenCalled();
        });

        it("bulkIndex() is a no-op when no collection has been initialized.", async () => {
            await provider.bulkIndex([makeDoc()]);
            // No throw, and nothing to assert against since no collection was ever wired.
        });

        it("bulkIndex() batches multiple documents into one bulkWrite call.", async () => {
            wireConnection();
            await (provider as any).init();
            const docs = [makeDoc({ entityUid: "msg-1" }), makeDoc({ entityUid: "msg-2" })];

            await provider.bulkIndex(docs);

            expect(mockCollection.bulkWrite).toHaveBeenCalledTimes(1);
            expect(mockCollection.bulkWrite.mock.calls[0][0]).toHaveLength(2);
        });
    });

    describe("remove()", () => {
        it("Deletes the document by its composite id.", async () => {
            wireConnection();
            await (provider as any).init();

            await provider.remove("message", "msg-1");

            expect(mockCollection.deleteOne).toHaveBeenCalledWith({ _id: "message:msg-1" });
        });

        it("Does not throw when no collection has been initialized.", async () => {
            await expect(provider.remove("message", "msg-1")).resolves.toBeUndefined();
        });
    });

    describe("search()", () => {
        it("Returns an empty result page when no collection has been initialized.", async () => {
            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello" });
            expect(result).toEqual({ results: [] });
        });

        it("Builds the $text filter, sorts by textScore, and maps results without a next page.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([
                { _id: "message:msg-1", entityType: "message", entityUid: "msg-1", score: 1.5 },
            ]);
            mockCollection.find.mockReturnValue(cursor);

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello" });

            expect(mockCollection.find).toHaveBeenCalledWith(
                { mailboxUid: "mbx-1", $text: { $search: "hello" } },
                { projection: { score: { $meta: "textScore" } } },
            );
            expect(cursor.sort).toHaveBeenCalledWith({ score: { $meta: "textScore" } });
            expect(cursor.skip).toHaveBeenCalledWith(0);
            expect(cursor.limit).toHaveBeenCalledWith(26);
            expect(result).toEqual({
                results: [{ entityType: "message", entityUid: "msg-1", score: 1.5 }],
                nextCursor: undefined,
            });
        });

        it("Applies an entityTypes filter when given.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([]);
            mockCollection.find.mockReturnValue(cursor);

            await provider.search({ mailboxUid: "mbx-1", text: "hello", entityTypes: ["message", "note"] });

            expect(mockCollection.find).toHaveBeenCalledWith(
                expect.objectContaining({ entityType: { $in: ["message", "note"] } }),
                expect.anything(),
            );
        });

        it("Sets hasMore/nextCursor when more rows are returned than the requested limit.", async () => {
            wireConnection();
            await (provider as any).init();
            const rows = Array.from({ length: 3 }, (_, i) => ({
                _id: `message:msg-${i}`,
                entityType: "message",
                entityUid: `msg-${i}`,
                score: 1,
            }));
            const cursor = makeCursor(rows);
            mockCollection.find.mockReturnValue(cursor);

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello", limit: 2 });

            expect(result.results).toHaveLength(2);
            expect(result.nextCursor).toBe("2");
        });

        it("Applies a numeric cursor as the skip offset.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([]);
            mockCollection.find.mockReturnValue(cursor);

            await provider.search({ mailboxUid: "mbx-1", text: "hello", cursor: "10" });

            expect(cursor.skip).toHaveBeenCalledWith(10);
        });

        it("Treats a non-numeric cursor as a skip offset of 0.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([]);
            mockCollection.find.mockReturnValue(cursor);

            await provider.search({ mailboxUid: "mbx-1", text: "hello", cursor: "not-a-number" });

            expect(cursor.skip).toHaveBeenCalledWith(0);
        });

        it("Caps the effective limit at 200.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([]);
            mockCollection.find.mockReturnValue(cursor);

            await provider.search({ mailboxUid: "mbx-1", text: "hello", limit: 10_000 });

            expect(cursor.limit).toHaveBeenCalledWith(201);
        });

        it("Defaults missing row score to 0.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([{ _id: "message:msg-1", entityType: "message", entityUid: "msg-1" }]);
            mockCollection.find.mockReturnValue(cursor);

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello" });

            expect(result.results[0].score).toBe(0);
        });
    });
});
