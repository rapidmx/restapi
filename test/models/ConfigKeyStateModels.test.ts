///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Default and copy construction of the configuration keyring's state (spec 4.9), on both backends.
import { ConfigKeyStateMongo } from "../../src/models/mongo/ConfigKeyStateMongo.js";
import { ConfigKeyStateSQL } from "../../src/models/sql/ConfigKeyStateSQL.js";

describe.each([
    ["Mongo", ConfigKeyStateMongo],
    ["SQL", ConfigKeyStateSQL],
])("ConfigKeyState (%s)", (_backend, State: any) => {
    it("starts with nothing set: the keyring's only (newest) key encrypts, no rotation has run", () => {
        const state = new State();
        for (const field of ["activeKid", "rotation", "kidUsage", "countedAt", "reencryption", "pluginSecrets"]) {
            expect(state[field], field).toBeUndefined();
        }
        const copy = new State({});
        for (const field of ["activeKid", "rotation", "kidUsage", "countedAt", "reencryption", "pluginSecrets"]) {
            expect(copy[field], field).toBeUndefined();
        }
    });

    it("copies every field", () => {
        const fields = {
            activeKid: "a1b2c3d4",
            rotation: {
                kid: "e5f6a7b8",
                previousKids: ["a1b2c3d4"],
                compromised: false,
                requestedBy: "admin-1",
                requestedAt: new Date("2026-10-28T10:00:00Z"),
                phase: "activating",
                waitingFor: ["server-abc:1"],
            },
            kidUsage: { a1b2c3d4: 3, e5f6a7b8: 0 },
            countedAt: new Date("2026-10-28T10:05:00Z"),
            reencryption: { targetKid: "e5f6a7b8", complete: false, startedAt: new Date("2026-10-28T10:04:00Z") },
            pluginSecrets: { encryptedAt: new Date("2026-10-28T09:00:00Z"), waitingForRollout: false },
        };
        expect(new State(fields)).toEqual(expect.objectContaining(fields));
    });

    it("copies a field cleared to null, which is how a rotation or a count is reset", () => {
        const cleared = { activeKid: null, rotation: null, kidUsage: null, reencryption: null, pluginSecrets: null };
        expect(new State(cleared)).toEqual(expect.objectContaining(cleared));
    });

    it("keeps the singleton's uid it is given", () => {
        expect(new State({ uid: "config-keys" }).uid).toBe("config-keys");
    });
});
