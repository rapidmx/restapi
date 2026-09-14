///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { asEntity } from "../../src/util/EntityUtils.js";
import * as util from "../../src/util/index.js";
import { assertNotOnLegalHold, findActiveHoldsFor, loadLegalHoldIndex } from "../../src/util/LegalHoldUtils.js";
import { findPagesByUid } from "../../src/util/MailboxContentUtils.js";
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

    it("Is exported from the package's util barrel (and so the package root), with the legal-hold helpers and findPagesByUid().", () => {
        expect(util.asEntity).toBe(asEntity);
        expect(util.findActiveHoldsFor).toBe(findActiveHoldsFor);
        expect(util.assertNotOnLegalHold).toBe(assertNotOnLegalHold);
        expect(util.loadLegalHoldIndex).toBe(loadLegalHoldIndex);
        expect(util.findPagesByUid).toBe(findPagesByUid);
    });
});
