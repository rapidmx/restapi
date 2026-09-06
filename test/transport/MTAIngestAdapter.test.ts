///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Trivial smoke test for MTAIngestAdapter.ts - it is a documentation-only module (no pluggable interface, no
// implementation) describing the MTA integration contract, so there is nothing to exercise beyond its constant.
import { MTA_INGEST_CONTRACT_DOC } from "../../src/transport/MTAIngestAdapter.js";

describe("MTAIngestAdapter Tests", () => {
    it("Exports MTA_INGEST_CONTRACT_DOC as a non-empty string.", () => {
        expect(typeof MTA_INGEST_CONTRACT_DOC).toBe("string");
        expect(MTA_INGEST_CONTRACT_DOC.length).toBeGreaterThan(0);
    });
});
