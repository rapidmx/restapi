///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { asEntity } from "../../src/util/EntityUtils.js";
import { IngestQueueEntryMongo } from "../../src/models/mongo/IngestQueueEntryMongo.js";
import { IngestStatus } from "../../src/models/types.js";

describe("asEntity() Tests", () => {
    it("Wraps a plain document (as Mongo reads return) in the repo's model class, keeping its uid and version.", () => {
        const plain = { uid: "entry-1", version: 3, status: IngestStatus.PENDING, mailboxUid: "m" };
        const entity: any = asEntity({ modelClass: IngestQueueEntryMongo } as any, plain);
        expect(entity).toBeInstanceOf(IngestQueueEntryMongo);
        expect(entity.uid).toBe("entry-1");
        expect(entity.version).toBe(3);
    });

    it("Returns an entity instance unchanged, and a plain row unchanged when the repo exposes no model class.", () => {
        const entity = new IngestQueueEntryMongo({ uid: "entry-2" });
        expect(asEntity({ modelClass: IngestQueueEntryMongo } as any, entity)).toBe(entity);
        const plain = { uid: "entry-3" };
        expect(asEntity({} as any, plain)).toBe(plain);
    });
});
