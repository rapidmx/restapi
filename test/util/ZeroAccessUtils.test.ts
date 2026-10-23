///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { Mailbox, ZeroAccessKey } from "../../src/models/types.js";
import { activeZeroAccessKey, isZeroAccessActive, zeroAccessStatus } from "../../src/util/ZeroAccessUtils.js";

const key = (fields: Partial<ZeroAccessKey>): ZeroAccessKey => ({
    publicKey: "QUJD",
    type: "x509",
    useType: "zero-access",
    fingerprint: "fp",
    notBefore: 0,
    notAfter: Number.MAX_SAFE_INTEGER,
    ...fields,
});

type ZeroAccessMailbox = Pick<Mailbox, "ownerUserUid" | "zeroAccessEnabled" | "zeroAccessKeys">;

const mailbox = (fields: Partial<ZeroAccessMailbox> = {}): ZeroAccessMailbox => ({
    ownerUserUid: "owner",
    zeroAccessKeys: [key({})],
    ...fields,
});

const allowed = { allowZeroAccess: true, hasDelegates: false };

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

        it("is shared_mailbox for an ownerless mailbox or one with delegates", () => {
            expect(zeroAccessStatus(mailbox({ ownerUserUid: undefined }), allowed)).toBe("shared_mailbox");
            expect(zeroAccessStatus(mailbox(), { ...allowed, hasDelegates: true })).toBe("shared_mailbox");
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
});
