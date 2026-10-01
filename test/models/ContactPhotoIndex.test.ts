///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { PersistenceDecorators } from "@rapidrest/service-core";
import { ContactMongo } from "../../src/models/mongo/ContactMongo.js";
import { ContactSQL } from "../../src/models/sql/ContactSQL.js";

// Every photo write, replace and purge looks for other contacts naming the same `photoBlobKey` (`BaseContactRoute.deletePhotoBlobs()`):
// without an index that is a scan of every contact of every user. The other blob-key reference columns are indexed the same way.
describe("Contact photoBlobKey index", () => {
    it.each([
        ["ContactMongo", ContactMongo],
        ["ContactSQL", ContactSQL],
    ])("%s indexes photoBlobKey", (_name, entity) => {
        const indexes = PersistenceDecorators.getIndexMetadata(entity);
        expect(indexes.some((index: any) => index.columns.length === 1 && index.columns[0] === "photoBlobKey")).toBe(true);
    });
});
