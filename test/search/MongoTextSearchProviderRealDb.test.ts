///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real-DB integration test for MongoTextSearchProvider: verifies against a real in-memory MongoDB what the
// mock-based MongoTextSearchProvider.test.ts can only assert structurally - that `candidates()`'s participant
// filter matches both the current array shape and the legacy space-joined string shape, and that one rejected
// document in `bulkIndex()` doesn't prevent the rest of the batch from being written.
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import { MongoTextSearchProvider } from "../../src/search/MongoTextSearchProvider.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: { port: 9999, dbName: "rrst-test" },
});

describe("MongoTextSearchProvider Tests (real DB)", () => {
    let client: MongoClient;
    let provider: MongoTextSearchProvider;

    beforeAll(async () => {
        await mongod.start();
        client = new MongoClient(mongod.getUri());
        await client.connect();
    });

    afterAll(async () => {
        await client.close();
        await mongod.stop();
    });

    beforeEach(async () => {
        const db = client.db("rrst-search-provider-test");
        await db.dropDatabase();
        provider = new MongoTextSearchProvider();
        (provider as any).connectionManager = { connections: new Map([["mongo", { db }]]) };
        await (provider as any).init();
    });

    it("candidates() matches a participant against both array-shaped and legacy string-shaped documents, as a whole address.", async () => {
        await provider.bulkIndex([
            { entityType: "message", entityUid: "new", mailboxUid: "mbx", participants: ["alice@example.com", "Bob@Example.com"] },
            { entityType: "message", entityUid: "other", mailboxUid: "mbx", participants: ["notbob@example.com"] },
        ]);
        // A document written by a previous version of the provider, with participants joined into one string.
        const collection = client.db("rrst-search-provider-test").collection<any>("mail_search_index");
        await collection.insertOne({
            _id: "message:legacy",
            entityType: "message",
            entityUid: "legacy",
            mailboxUid: "mbx",
            participants: "carol@example.com bob@example.com",
        });

        const result = await provider.candidates({ mailboxUid: "mbx", participants: ["bob@example.com"] });

        expect(result.candidates.map((c) => c.entityUid).sort()).toEqual(["legacy", "new"]);
    });

    it("bulkIndex() writes every document it can and returns only those entityUids when one is rejected.", async () => {
        const collection = client.db("rrst-search-provider-test").collection<any>("mail_search_index");
        // Force a real per-document server-side rejection: a unique index that the second document violates.
        await collection.createIndex({ subject: 1 }, { unique: true, sparse: true });

        const indexed = await provider.bulkIndex([
            { entityType: "message", entityUid: "a", mailboxUid: "mbx", subject: "dup" },
            { entityType: "message", entityUid: "b", mailboxUid: "mbx", subject: "dup" },
            { entityType: "message", entityUid: "c", mailboxUid: "mbx", subject: "unique" },
        ]);

        expect(indexed).toEqual(["a", "c"]);
        expect((await collection.find({}).toArray()).map((d) => d.entityUid).sort()).toEqual(["a", "c"]);
    });
});
