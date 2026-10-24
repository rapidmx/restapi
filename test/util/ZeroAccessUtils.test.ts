///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Mailbox, ZeroAccessKey } from "../../src/models/types.js";
import {
    activeZeroAccessKey,
    defaultZeroAccessTypes,
    isZeroAccessActive,
    isZeroAccessDataType,
    settleZeroAccessTypes,
    syncedDataTypes,
    zeroAccessStatus,
    zeroAccessTypeIncluded,
} from "../../src/util/ZeroAccessUtils.js";

const key = (fields: Partial<ZeroAccessKey>): ZeroAccessKey => ({
    publicKey: "QUJD",
    type: "x509",
    useType: "zero-access",
    fingerprint: "fp",
    notBefore: 0,
    notAfter: Number.MAX_SAFE_INTEGER,
    ...fields,
});

type ZeroAccessMailbox = Pick<Mailbox, "ownerUserUid" | "zeroAccessEnabled" | "zeroAccessKeys" | "zeroAccessTypes">;

const mailbox = (fields: Partial<ZeroAccessMailbox> = {}): ZeroAccessMailbox => ({
    ownerUserUid: "owner",
    zeroAccessKeys: [key({})],
    ...fields,
});

const allowed = { allowZeroAccess: true };

describe("ZeroAccessUtils", () => {
    describe("activeZeroAccessKey()", () => {
        it("returns undefined for a mailbox that has never enrolled a key", () => {
            expect(activeZeroAccessKey({})).toBeUndefined();
            expect(activeZeroAccessKey({ zeroAccessKeys: [] })).toBeUndefined();
        });

        it("skips revoked keys", () => {
            expect(activeZeroAccessKey({ zeroAccessKeys: [key({ revokedAt: 5 })] })).toBeUndefined();
        });

        it("picks the unrevoked key with the latest notBefore, the later one on a tie", () => {
            const old = key({ fingerprint: "old", notBefore: 1 });
            const newer = key({ fingerprint: "newer", notBefore: 2 });
            const tie = key({ fingerprint: "tie", notBefore: 2 });
            expect(activeZeroAccessKey({ zeroAccessKeys: [newer, old] })?.fingerprint).toBe("newer");
            expect(activeZeroAccessKey({ zeroAccessKeys: [old, newer, tie] })?.fingerprint).toBe("tie");
        });

        it("keeps an expired key active, so the mailbox never drops back to plaintext", () => {
            expect(activeZeroAccessKey({ zeroAccessKeys: [key({ notAfter: 1 })] })?.fingerprint).toBe("fp");
        });
    });

    describe("zeroAccessStatus()", () => {
        it("is active for an owned mailbox with a key, enabled or unset, on a server that allows it", () => {
            expect(zeroAccessStatus(mailbox(), allowed)).toBe("active");
            expect(zeroAccessStatus(mailbox({ zeroAccessEnabled: true }), allowed)).toBe("active");
            expect(zeroAccessStatus(mailbox({ zeroAccessEnabled: null as any }), allowed)).toBe("active");
        });

        it("is disabled_by_admin when the server doesn't allow it, whatever the mailbox says", () => {
            expect(zeroAccessStatus(mailbox({ zeroAccessEnabled: true }), { ...allowed, allowZeroAccess: false })).toBe("disabled_by_admin");
            expect(zeroAccessStatus(mailbox({ zeroAccessEnabled: false }), { ...allowed, allowZeroAccess: false })).toBe("disabled_by_admin");
        });

        it("is disabled_by_owner when the mailbox turned it off", () => {
            expect(zeroAccessStatus(mailbox({ zeroAccessEnabled: false }), allowed)).toBe("disabled_by_owner");
        });

        it("treats a mailbox without an owner like any other: active with a key (its members read it through member key wraps)", () => {
            expect(zeroAccessStatus(mailbox({ ownerUserUid: undefined }), allowed)).toBe("active");
            expect(zeroAccessStatus(mailbox({ ownerUserUid: undefined, zeroAccessKeys: [] }), allowed)).toBe("no_key");
        });

        it("is no_key when no unrevoked key is enrolled", () => {
            expect(zeroAccessStatus(mailbox({ zeroAccessKeys: undefined }), allowed)).toBe("no_key");
            expect(zeroAccessStatus(mailbox({ zeroAccessKeys: [key({ revokedAt: 1 })] }), allowed)).toBe("no_key");
        });
    });

    describe("isZeroAccessActive()", () => {
        it("is true only when the status is active", () => {
            expect(isZeroAccessActive(mailbox(), allowed)).toBe(true);
            expect(isZeroAccessActive(mailbox({ zeroAccessKeys: [] }), allowed)).toBe(false);
            expect(isZeroAccessActive(mailbox(), { ...allowed, allowZeroAccess: false })).toBe(false);
        });
    });

    describe("data types", () => {
        const phone = (types: string[]) => ({ activesync: { devices: [{ id: "d1", model: "iPhone", types: types as any, lastSeenAt: 1 }] } });

        it("knows the four types, and counts an undecided mail as on and the others as off", () => {
            expect(["mail", "calendar", "contacts", "tasks"].every(isZeroAccessDataType)).toBe(true);
            expect(isZeroAccessDataType("notes")).toBe(false);
            expect(zeroAccessTypeIncluded({}, "mail")).toBe(true);
            expect(zeroAccessTypeIncluded({}, "calendar")).toBe(false);
            expect(zeroAccessTypeIncluded({ zeroAccessTypes: { mail: false, tasks: true } }, "mail")).toBe(false);
            expect(zeroAccessTypeIncluded({ zeroAccessTypes: { mail: false, tasks: true } }, "tasks")).toBe(true);
        });

        it("reports a type the owner left out as not included, after the switches and before the key", () => {
            const box = mailbox({ zeroAccessTypes: { mail: true, calendar: false } });
            expect(zeroAccessStatus(box, allowed, "calendar")).toBe("type_not_included");
            expect(zeroAccessStatus(box, allowed)).toBe("active");
            expect(zeroAccessStatus({ ...box, zeroAccessKeys: [] }, allowed, "calendar")).toBe("type_not_included");
            expect(zeroAccessStatus({ ...box, zeroAccessEnabled: false }, allowed, "calendar")).toBe("disabled_by_owner");
            expect(isZeroAccessActive(mailbox({ zeroAccessTypes: { contacts: true } }), allowed, "contacts")).toBe(true);
        });

        it("collects what ActiveSync devices sync, and every type for Outlook", () => {
            expect([...syncedDataTypes(undefined)]).toEqual([]);
            expect([...syncedDataTypes(phone(["mail", "calendar", "bogus"]))].sort()).toEqual(["calendar", "mail"]);
            expect([...syncedDataTypes({ activesync: { devices: [{ id: "d", lastSeenAt: 1 } as any] } })]).toEqual([]);
            expect([...syncedDataTypes({ mapi: { lastSeenAt: 1 } })].sort()).toEqual(["calendar", "contacts", "mail", "tasks"]);
        });

        it("defaults the types a device syncs to off - mail on only once the keys are exported - and everything else to on", () => {
            expect(defaultZeroAccessTypes({})).toEqual({ mail: true, calendar: true, contacts: true, tasks: true });
            expect(defaultZeroAccessTypes({ syncClients: phone(["mail", "calendar", "contacts"]) })).toEqual({ mail: false, calendar: false, contacts: false, tasks: true });
            expect(defaultZeroAccessTypes({ syncClients: phone(["mail"]), zeroAccessKeysExportedAt: 5 }).mail).toBe(true);
        });

        it("decides only the undecided types, keeping protected mail protected unless zero-access is being turned on now", () => {
            const withPhone = { syncClients: phone(["mail", "calendar"]) };
            expect(settleZeroAccessTypes({ ...withPhone, zeroAccessTypes: { mail: true, calendar: true, contacts: false, tasks: false } }, true)).toBeUndefined();
            expect(settleZeroAccessTypes({ ...withPhone, zeroAccessTypes: { calendar: true } }, false)).toEqual({ mail: true, calendar: true, contacts: true, tasks: true });
            expect(settleZeroAccessTypes(withPhone, true)).toEqual({ mail: false, calendar: false, contacts: true, tasks: true });
            expect(settleZeroAccessTypes({ ...withPhone, zeroAccessTypes: { mail: false } }, false)).toEqual({ mail: false, calendar: false, contacts: true, tasks: true });
        });
    });
});
