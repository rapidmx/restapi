///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ZeroAccessIndexSegmentMongo } from "../../src/models/mongo/ZeroAccessIndexSegmentMongo.js";
import { ZeroAccessIndexSegmentSQL } from "../../src/models/sql/ZeroAccessIndexSegmentSQL.js";

describe.each([
    ["SQL", ZeroAccessIndexSegmentSQL],
    ["Mongo", ZeroAccessIndexSegmentMongo],
] as const)("ZeroAccessIndexSegment%s", (_name, Model) => {
    it("copies every field it is given", () => {
        const fields = {
            mailboxUid: "mb1",
            weekId: "2026-W43",
            generation: 3,
            blobKey: "za-index/mb1/2026-W43/3-n",
            bytes: 10,
            etag: "abc",
            schemaVersion: 2,
            origin: "client" as const,
            keyFingerprint: "fp",
            entryCount: 7,
        };
        expect(new Model(fields)).toMatchObject(fields);
    });

    it("keeps its defaults for fields it isn't given", () => {
        expect(new Model({})).toMatchObject({
            mailboxUid: "",
            weekId: "",
            generation: 1,
            blobKey: "",
            bytes: 0,
            etag: "",
            schemaVersion: 1,
            origin: "zero-access",
            keyFingerprint: "",
            entryCount: 0,
        });
    });
});
