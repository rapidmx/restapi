///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction } from "@rapidrest/service-core";
import {
    ADMIN_SCOPE,
    assertAdminScope,
    assertMailAccess,
    DEFAULT_ELEVATION_MAX_AGE_SECONDS,
    hasMailAccess,
    isAdminScope,
    isTrustedUser,
    stripTrustedRoles,
} from "../../src/util/MailAccessUtils.js";

const TRUSTED = ["admin"];

describe("MailAccessUtils", () => {
    describe("stripTrustedRoles()", () => {
        it("Returns the same user when it has no trusted role, and undefined for no user.", () => {
            const user: any = { uid: "u", roles: ["support"], scopes: [], elevated: 3 };
            expect(stripTrustedRoles(user, TRUSTED)).toBe(user);
            expect(stripTrustedRoles(undefined, TRUSTED)).toBeUndefined();
            const rolesless: any = { uid: "u", scopes: [] };
            expect(stripTrustedRoles(rolesless, TRUSTED)).toBe(rolesless);
        });

        it("Takes the trusted roles - plain and org-prefixed - and the elevation away, keeping everything else.", () => {
            const user: any = { uid: "u", roles: ["admin", "support", "org1.admin", "administrator"], scopes: ["s"], elevated: 99, verified: true };
            expect(stripTrustedRoles(user, TRUSTED)).toEqual({ uid: "u", roles: ["support", "administrator"], scopes: ["s"], elevated: -1, verified: true });
            // The original is untouched.
            expect(user.roles).toEqual(["admin", "support", "org1.admin", "administrator"]);
        });
    });

    describe("hasMailAccess() / assertMailAccess()", () => {
        const aclUtils: any = { hasPermission: vi.fn() };

        it("Asks the framework as the caller without their trusted roles - so the framework's superuser shortcut can't apply.", async () => {
            aclUtils.hasPermission.mockResolvedValue(false);
            const admin: any = { uid: "a", roles: ["admin"], scopes: [], elevated: 1 };
            expect(await hasMailAccess(aclUtils, TRUSTED, admin, "mailbox", ACLAction.READ)).toBe(false);
            expect(aclUtils.hasPermission).toHaveBeenCalledWith({ uid: "a", roles: [], scopes: [], elevated: -1 }, "mailbox", ACLAction.READ);
        });

        it("Answers what the framework answers for a caller with a record, and false with no ACL utilities at all.", async () => {
            aclUtils.hasPermission.mockResolvedValue(true);
            const owner: any = { uid: "o", roles: [], scopes: [] };
            expect(await hasMailAccess(aclUtils, TRUSTED, owner, "mailbox", ACLAction.READ)).toBe(true);
            expect(await hasMailAccess(undefined, TRUSTED, owner, "mailbox", ACLAction.READ)).toBe(false);
            await expect(assertMailAccess(aclUtils, TRUSTED, owner, "mailbox", ACLAction.READ)).resolves.toBeUndefined();
        });

        it("Refuses with a 403 when the caller has no access.", async () => {
            aclUtils.hasPermission.mockResolvedValue(false);
            await expect(assertMailAccess(aclUtils, TRUSTED, { uid: "x", roles: [], scopes: [] }, "mailbox", ACLAction.UPDATE)).rejects.toMatchObject({ status: 403 });
        });
    });

    describe("administration scope", () => {
        it("Recognizes ?scope=admin only.", () => {
            expect(ADMIN_SCOPE).toBe("admin");
            expect(isAdminScope({ scope: "admin" })).toBe(true);
            expect(isAdminScope({ scope: "other" })).toBe(false);
            expect(isAdminScope({})).toBe(false);
            expect(isAdminScope(undefined)).toBe(false);
        });

        it("Needs a signed-in caller (401), a trusted role (403 api-103) and an elevated token (403 api-104).", () => {
            expect(() => assertAdminScope(undefined, TRUSTED)).toThrow(expect.objectContaining({ status: 401 }));
            expect(() => assertAdminScope({ uid: "u", roles: [], scopes: [], elevated: 5 }, TRUSTED)).toThrow(expect.objectContaining({ status: 403, code: "api-103" }));
            expect(() => assertAdminScope({ uid: "u", roles: ["admin"], scopes: [] }, TRUSTED)).toThrow(expect.objectContaining({ status: 403, code: "api-104" }));
            expect(() => assertAdminScope({ uid: "u", roles: ["admin"], scopes: [], elevated: -1 }, TRUSTED)).toThrow(expect.objectContaining({ status: 403, code: "api-104" }));
            expect(() => assertAdminScope({ uid: "u", roles: ["admin"], scopes: [], elevated: Date.now() }, TRUSTED)).not.toThrow();
        });

        it("Refuses an elevation older than the maximum age (403 api-104), 900 seconds unless told otherwise (R2-08).", () => {
            const admin = (ageMs: number): any => ({ uid: "u", roles: ["admin"], scopes: [], elevated: Date.now() - ageMs });
            expect(DEFAULT_ELEVATION_MAX_AGE_SECONDS).toBe(900);
            expect(() => assertAdminScope(admin(899_000), TRUSTED)).not.toThrow();
            expect(() => assertAdminScope(admin(901_000), TRUSTED)).toThrow(expect.objectContaining({ status: 403, code: "api-104" }));
            expect(() => assertAdminScope(admin(61_000), TRUSTED, 60)).toThrow(expect.objectContaining({ status: 403, code: "api-104" }));
            expect(() => assertAdminScope(admin(30_000), TRUSTED, 60)).not.toThrow();
            // 0 (or a negative or non-numeric value) means no limit.
            expect(() => assertAdminScope(admin(30 * 24 * 3_600_000), TRUSTED, 0)).not.toThrow();
            expect(() => assertAdminScope(admin(30 * 24 * 3_600_000), TRUSTED, -1)).not.toThrow();
            expect(() => assertAdminScope(admin(30 * 24 * 3_600_000), TRUSTED, "x" as any)).not.toThrow();
            // A timestamp in the future (clock skew between the servers) is not an old one.
            expect(() => assertAdminScope(admin(-5_000), TRUSTED, 60)).not.toThrow();
        });

        it("Only holds an elevation to an age when the token carries a timestamp (a small value is a flag, not a time).", () => {
            for (const elevated of [1, 5, 99, 1_700_000_000]) {
                expect(() => assertAdminScope({ uid: "u", roles: ["admin"], scopes: [], elevated }, TRUSTED, 1)).not.toThrow();
            }
        });

        it("Knows a trusted user.", () => {
            expect(isTrustedUser({ uid: "u", roles: ["admin"], scopes: [] }, TRUSTED)).toBe(true);
            expect(isTrustedUser({ uid: "u", roles: [], scopes: [] }, TRUSTED)).toBe(false);
            expect(isTrustedUser(undefined, TRUSTED)).toBe(false);
        });
    });
});
