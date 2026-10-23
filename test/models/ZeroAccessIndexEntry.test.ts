///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ZeroAccessIndexEntryMongo } from "../../src/models/mongo/ZeroAccessIndexEntryMongo.js";
import { ZeroAccessIndexEntrySQL } from "../../src/models/sql/ZeroAccessIndexEntrySQL.js";

describe.each([
    ["SQL", ZeroAccessIndexEntrySQL],
    ["Mongo", ZeroAccessIndexEntryMongo],
] as const)("ZeroAccessIndexEntry%s", (_name, Model) => {
    it("copies every field it is given", () => {
        const receivedAt = new Date("2026-10-22T10:00:00Z");
        const entry = new Model({ mailboxUid: "mb1", messageUid: "m1", weekId: "2026-W43", receivedAt, keyFingerprint: "fp", sealed: "c2VhbGVk" });

        expect(entry).toMatchObject({ mailboxUid: "mb1", messageUid: "m1", weekId: "2026-W43", receivedAt, keyFingerprint: "fp", sealed: "c2VhbGVk" });
    });

    it("keeps its defaults for fields it isn't given", () => {
        const entry = new Model({});

        expect(entry).toMatchObject({ mailboxUid: "", messageUid: "", weekId: "", keyFingerprint: "", sealed: "" });
        expect(entry.receivedAt).toBeInstanceOf(Date);
    });
});
