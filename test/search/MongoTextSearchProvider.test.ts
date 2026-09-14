///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for MongoTextSearchProvider - the injected ConnectionManager and the Mongo `Collection`
// it resolves are both hand-built mocks; no real MongoDB connection is made.
import { MongoTextSearchProvider } from "../../src/search/MongoTextSearchProvider.js";
import { MAX_SEARCH_DOCUMENT_TEXT_CHARS, type SearchDocument } from "../../src/search/SearchProvider.js";

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
            ], { ordered: false });
        });

        it("Flattens attachmentText into a joined string and stores participants as an array.", async () => {
            wireConnection();
            await (provider as any).init();
            const doc = makeDoc({ attachmentText: ["page one", "page two"], participants: ["a@x.com", "b@x.com"] });

            await provider.index(doc);

            const call = mockCollection.bulkWrite.mock.calls[0][0][0];
            expect(call.replaceOne.replacement.attachmentText).toBe("page one\npage two");
            expect(call.replaceOne.replacement.participants).toEqual(["a@x.com", "b@x.com"]);
        });

        it("Truncates subject/body/attachmentText to MAX_SEARCH_DOCUMENT_TEXT_CHARS in total before storing.", async () => {
            wireConnection();
            await (provider as any).init();
            const doc = makeDoc({
                subject: "s",
                body: "b".repeat(MAX_SEARCH_DOCUMENT_TEXT_CHARS),
                attachmentText: ["dropped"],
            });

            await provider.index(doc);

            const replacement = mockCollection.bulkWrite.mock.calls[0][0][0].replaceOne.replacement;
            expect(replacement.subject).toBe("s");
            expect(replacement.body).toHaveLength(MAX_SEARCH_DOCUMENT_TEXT_CHARS - 1);
            expect(replacement.attachmentText).toBe("");
        });

        it("bulkIndex() returns every entityUid when the bulk write succeeds.", async () => {
            wireConnection();
            await (provider as any).init();

            const result = await provider.bulkIndex([makeDoc({ entityUid: "msg-1" }), makeDoc({ entityUid: "msg-2" })]);

            expect(result).toEqual(["msg-1", "msg-2"]);
        });

        it("bulkIndex() isolates per-document write errors, returning only the entityUids that were written.", async () => {
            wireConnection();
            await (provider as any).init();
            const bulkError: any = new Error("bulk write failed");
            bulkError.writeErrors = [{ index: 1, errmsg: "document too large" }];
            mockCollection.bulkWrite.mockRejectedValue(bulkError);

            const result = await provider.bulkIndex([
                makeDoc({ entityUid: "msg-1" }),
                makeDoc({ entityUid: "msg-2" }),
                makeDoc({ entityUid: "msg-3" }),
            ]);

            expect(result).toEqual(["msg-1", "msg-3"]);
        });

        it("bulkIndex() accepts a single (non-array) writeErrors entry.", async () => {
            wireConnection();
            await (provider as any).init();
            const bulkError: any = new Error("bulk write failed");
            bulkError.writeErrors = { index: 0, errmsg: "bad" };
            mockCollection.bulkWrite.mockRejectedValue(bulkError);

            const result = await provider.bulkIndex([makeDoc({ entityUid: "msg-1" }), makeDoc({ entityUid: "msg-2" })]);

            expect(result).toEqual(["msg-2"]);
        });

        it("bulkIndex() rethrows a whole-batch failure that isn't a bulk write error.", async () => {
            wireConnection();
            await (provider as any).init();
            mockCollection.bulkWrite.mockRejectedValue(new Error("connection closed"));

            await expect(provider.bulkIndex([makeDoc()])).rejects.toThrow("connection closed");
        });

        it("bulkIndex() is a no-op when given an empty array.", async () => {
            wireConnection();
            await (provider as any).init();

            await provider.bulkIndex([]);

            expect(mockCollection.bulkWrite).not.toHaveBeenCalled();
        });

        it("bulkIndex() is a no-op when no collection has been initialized.", async () => {
            await expect(provider.bulkIndex([makeDoc()])).resolves.toEqual([]);
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

        it("Caps the effective limit at 100.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([]);
            mockCollection.find.mockReturnValue(cursor);

            await provider.search({ mailboxUid: "mbx-1", text: "hello", limit: 10_000 });

            expect(cursor.limit).toHaveBeenCalledWith(101);
        });

        it("Clamps a limit below 1 up to 1, and a cursor beyond 10000 down to 10000 with no further nextCursor.", async () => {
            wireConnection();
            await (provider as any).init();
            const rows = Array.from({ length: 2 }, (_, i) => ({ _id: `message:m${i}`, entityType: "message", entityUid: `m${i}` }));
            const cursor = makeCursor(rows);
            mockCollection.find.mockReturnValue(cursor);

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello", limit: -5, cursor: "999999" });

            expect(cursor.limit).toHaveBeenCalledWith(2);
            expect(cursor.skip).toHaveBeenCalledWith(10_000);
            expect(result.results).toHaveLength(1);
            expect(result.nextCursor).toBeUndefined();
        });

        it("Clamps a negative cursor to offset 0.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([]);
            mockCollection.find.mockReturnValue(cursor);

            await provider.candidates({ mailboxUid: "mbx-1", cursor: "-50", limit: 500 });

            expect(cursor.skip).toHaveBeenCalledWith(0);
            expect(cursor.limit).toHaveBeenCalledWith(101);
        });

        it("Defaults missing row score to 0.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([{ _id: "message:msg-1", entityType: "message", entityUid: "msg-1" }]);
            mockCollection.find.mockReturnValue(cursor);

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello" });

            expect(result.results[0].score).toBe(0);
        });

        it("Propagates metadataOnly from the stored document onto the result.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([
                { _id: "message:msg-1", entityType: "message", entityUid: "msg-1", score: 1, metadataOnly: true },
            ]);
            mockCollection.find.mockReturnValue(cursor);

            const result = await provider.search({ mailboxUid: "mbx-1", text: "hello" });

            expect(result.results[0].metadataOnly).toBe(true);
        });

        it("Applies structured operator-grammar filters (from/to/cc/hasAttachment/folderUid/flags/labels/before/after) as exact/range predicates.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([]);
            mockCollection.find.mockReturnValue(cursor);
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

            expect(mockCollection.find).toHaveBeenCalledWith(
                expect.objectContaining({
                    from: "alice@example.com",
                    to: "bob@example.com",
                    cc: "carol@example.com",
                    hasAttachments: true,
                    folderUid: "folder-1",
                    flags: { $all: ["read", "flagged"] },
                    labels: { $all: ["label-a", "label-b"] },
                    dateForSort: { $lt: before, $gt: after },
                }),
                expect.anything(),
            );
        });

        it("Falls back to a case-insensitive regex against subject when subject: is given, as an additional AND predicate.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([]);
            mockCollection.find.mockReturnValue(cursor);

            await provider.search({ mailboxUid: "mbx-1", text: "", subject: "budget (q3)" });

            const [filter] = mockCollection.find.mock.calls[0];
            expect(filter.subject).toEqual({ $regex: "budget \\(q3\\)", $options: "i" });
            // No free text was given, so $text is omitted entirely rather than searching for an empty string.
            expect(filter.$text).toBeUndefined();
        });

        it("Sorts by dateForSort (not textScore) when text is empty - a pure structured-filter query.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([]);
            mockCollection.find.mockReturnValue(cursor);

            await provider.search({ mailboxUid: "mbx-1", text: "", folderUid: "folder-1" });

            expect(cursor.sort).toHaveBeenCalledWith({ dateForSort: -1 });
        });
    });

    describe("candidates()", () => {
        it("Returns an empty page when no collection has been initialized.", async () => {
            const result = await provider.candidates({ mailboxUid: "mbx-1" });
            expect(result).toEqual({ candidates: [] });
        });

        it("Filters by mailboxUid/participants/structured predicates, sorts by dateForSort, and returns identifiers only.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([
                { _id: "message:msg-1", entityType: "message", entityUid: "msg-1" },
            ]);
            mockCollection.find.mockReturnValue(cursor);

            const result = await provider.candidates({
                mailboxUid: "mbx-1",
                entityTypes: ["message"],
                participants: ["bob@example.com"],
                folderUid: "folder-1",
            });

            expect(mockCollection.find).toHaveBeenCalledWith(
                {
                    mailboxUid: "mbx-1",
                    entityType: { $in: ["message"] },
                    folderUid: "folder-1",
                    participants: { $in: [expect.any(RegExp)] },
                },
                { projection: { entityType: 1, entityUid: 1 } },
            );
            expect(cursor.sort).toHaveBeenCalledWith({ dateForSort: -1 });
            expect(result).toEqual({ candidates: [{ entityType: "message", entityUid: "msg-1" }], nextCursor: undefined });
        });

        it("Matches a participant term as a whole address against both the array shape and the legacy space-joined string shape.", async () => {
            wireConnection();
            await (provider as any).init();
            mockCollection.find.mockReturnValue(makeCursor([]));

            await provider.candidates({ mailboxUid: "mbx-1", participants: ["Bob@Example.com", "a.b+c@x.com"] });

            const [filter] = mockCollection.find.mock.calls[0];
            const [bob, special]: RegExp[] = filter.participants.$in;
            // Array element (current shape).
            expect(bob.test("bob@example.com")).toBe(true);
            // Token inside the legacy joined string.
            expect(bob.test("alice@example.com bob@example.com carol@example.com")).toBe(true);
            // Not a substring of a different address.
            expect(bob.test("notbob@example.com")).toBe(false);
            expect(bob.test("bob@example.com.evil")).toBe(false);
            // Regex metacharacters in the term are literal.
            expect(special.test("a.b+c@x.com")).toBe(true);
            expect(special.test("aXb+c@x.com")).toBe(false);
        });

        it("Never includes score/content - only entityType/entityUid.", async () => {
            wireConnection();
            await (provider as any).init();
            const cursor = makeCursor([{ _id: "message:msg-1", entityType: "message", entityUid: "msg-1" }]);
            mockCollection.find.mockReturnValue(cursor);

            const result = await provider.candidates({ mailboxUid: "mbx-1" });

            expect(Object.keys(result.candidates[0])).toEqual(["entityType", "entityUid"]);
        });

        it("Sets hasMore/nextCursor when more rows are returned than the requested limit.", async () => {
            wireConnection();
            await (provider as any).init();
            const rows = Array.from({ length: 3 }, (_, i) => ({
                _id: `message:msg-${i}`,
                entityType: "message",
                entityUid: `msg-${i}`,
            }));
            const cursor = makeCursor(rows);
            mockCollection.find.mockReturnValue(cursor);

            const result = await provider.candidates({ mailboxUid: "mbx-1", limit: 2 });

            expect(result.candidates).toHaveLength(2);
            expect(result.nextCursor).toBe("2");
        });
    });
});
