///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for requireEscrowHolder()/findHeldScopeIds() - objectFactory/repo are hand-built
// mocks so this can assert behavior without a real DB.
//
// Both functions cache one repo per `escrowScopeClass` *object identity* in a module-level WeakMap (see
// EscrowUtils.ts's own doc comment on getEscrowScopeRepo()) - shared across every call in this process, not
// reset between tests. Each test below therefore declares its own fresh, locally-scoped stub class rather
// than a single shared one, so no test's cache entry can leak into (and mask a missing `newInstance()`
// call in) another.
import {
    DEFAULT_ESCROW_APPROVAL_TTL_HOURS,
    evaluateEscrowApprovals,
    exactInFilter,
    findHeldScopeIds,
    isQuerySafeUid,
    requireEscrowHolder,
    resolveEscrowApprovalTtlHours,
} from "../../src/util/EscrowUtils.js";

function makeStubClass(): any {
    return class StubEscrowScope {};
}

function makeObjectFactory(repo: any): any {
    return { newInstance: vi.fn().mockResolvedValue(repo) };
}

describe("requireEscrowHolder() Tests", () => {
    it("Throws NOT_FOUND when the scope doesn't exist.", async () => {
        const repo = { findOne: vi.fn().mockResolvedValue(undefined) };
        const objectFactory = makeObjectFactory(repo);

        await expect(
            requireEscrowHolder(objectFactory, makeStubClass(), "scope-1", { uid: "user-1" } as any),
        ).rejects.toThrow();
    });

    it("Throws AUTH_PERMISSION_FAILURE when the user is not a holder.", async () => {
        const scope = { uid: "scope-1", holderUserUids: ["holder-a"] };
        const repo = { findOne: vi.fn().mockResolvedValue(scope) };
        const objectFactory = makeObjectFactory(repo);

        await expect(
            requireEscrowHolder(objectFactory, makeStubClass(), "scope-1", { uid: "user-1" } as any),
        ).rejects.toThrow();
    });

    it("Throws AUTH_PERMISSION_FAILURE when no user is given at all.", async () => {
        const scope = { uid: "scope-1", holderUserUids: ["holder-a"] };
        const repo = { findOne: vi.fn().mockResolvedValue(scope) };
        const objectFactory = makeObjectFactory(repo);

        await expect(requireEscrowHolder(objectFactory, makeStubClass(), "scope-1", undefined)).rejects.toThrow();
    });

    it("Returns the scope when the user is a listed holder.", async () => {
        const scope = { uid: "scope-1", holderUserUids: ["holder-a", "user-1"] };
        const repo = { findOne: vi.fn().mockResolvedValue(scope) };
        const objectFactory = makeObjectFactory(repo);

        const result = await requireEscrowHolder(objectFactory, makeStubClass(), "scope-1", { uid: "user-1" } as any);

        expect(result).toBe(scope);
    });
});

describe("findHeldScopeIds() Tests", () => {
    it("Returns an empty array for no user at all, without ever fetching scopes.", async () => {
        const repo = { find: vi.fn() };
        const objectFactory = makeObjectFactory(repo);

        const result = await findHeldScopeIds(objectFactory, makeStubClass(), undefined);

        expect(result).toEqual([]);
        expect(repo.find).not.toHaveBeenCalled();
    });

    it("Returns an empty array when the user holds no scope.", async () => {
        const repo = { find: vi.fn().mockResolvedValue([{ uid: "scope-1", holderUserUids: ["someone-else"] }]) };
        const objectFactory = makeObjectFactory(repo);

        const result = await findHeldScopeIds(objectFactory, makeStubClass(), { uid: "user-1" } as any);

        expect(result).toEqual([]);
    });

    it("Returns only the uids of scopes the user actually holds.", async () => {
        const repo = {
            find: vi.fn().mockResolvedValue([
                { uid: "scope-1", holderUserUids: ["user-1"] },
                { uid: "scope-2", holderUserUids: ["someone-else"] },
                { uid: "scope-3", holderUserUids: ["user-1", "someone-else"] },
            ]),
        };
        const objectFactory = makeObjectFactory(repo);

        const result = await findHeldScopeIds(objectFactory, makeStubClass(), { uid: "user-1" } as any);

        expect(result.sort()).toEqual(["scope-1", "scope-3"]);
    });
});

describe("resolveEscrowApprovalTtlHours() Tests", () => {
    it("Reads mail:escrow:approval_ttl_hours, falling back to the default for an unset, invalid or non-positive value.", () => {
        const config = (value: unknown) => ({ get: (key: string) => (key === "mail:escrow:approval_ttl_hours" ? value : undefined) });
        expect(resolveEscrowApprovalTtlHours(config(24))).toBe(24);
        expect(resolveEscrowApprovalTtlHours(config("12"))).toBe(12);
        for (const value of [undefined, "soon", 0, -5, Infinity]) {
            expect(resolveEscrowApprovalTtlHours(config(value))).toBe(DEFAULT_ESCROW_APPROVAL_TTL_HOURS);
        }
        expect(resolveEscrowApprovalTtlHours(undefined)).toBe(DEFAULT_ESCROW_APPROVAL_TTL_HOURS);
        expect(resolveEscrowApprovalTtlHours({})).toBe(DEFAULT_ESCROW_APPROVAL_TTL_HOURS);
    });
});

describe("evaluateEscrowApprovals() Tests", () => {
    const now = new Date("2099-01-10T00:00:00.000Z");
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);
    const scope: any = { holderUserUids: ["a", "b", "c"] };

    it("Counts one approval per current holder, and expires the TTL after the approval that met the threshold.", () => {
        const request: any = {
            requiredHoldersAtCreation: 2,
            approvals: [
                { holderUserUid: "a", approvedAt: hoursAgo(100) },
                { holderUserUid: "a", approvedAt: hoursAgo(90) },
                { holderUserUid: "removed", approvedAt: hoursAgo(80) },
                { holderUserUid: "b", approvedAt: hoursAgo(10).toISOString() },
            ],
        };

        const state = evaluateEscrowApprovals(request, scope, 72, now);

        expect(state.validApprovalCount).toBe(2);
        expect(state.thresholdMet).toBe(true);
        expect(state.thresholdMetAt).toEqual(hoursAgo(10));
        expect(state.expiresAt).toEqual(new Date(hoursAgo(10).getTime() + 72 * 60 * 60 * 1000));
        expect(state.expired).toBe(false);
        expect(evaluateEscrowApprovals(request, scope, 5, now).expired).toBe(true);
    });

    it("Reports an unmet threshold when too few approvals come from current holders.", () => {
        const request: any = {
            requiredHoldersAtCreation: 2,
            approvals: [
                { holderUserUid: "a", approvedAt: hoursAgo(1) },
                { holderUserUid: "x", approvedAt: hoursAgo(1) },
            ],
        };

        expect(evaluateEscrowApprovals(request, scope, 72, now)).toEqual({ validApprovalCount: 1, thresholdMet: false, expired: false });
        expect(evaluateEscrowApprovals({ requiredHoldersAtCreation: 0 } as any, {} as any, 72).thresholdMet).toBe(false);
        const single: any = { requiredHoldersAtCreation: 1, approvals: [{ holderUserUid: "a", approvedAt: new Date() }] };
        expect(evaluateEscrowApprovals(single, scope, 72).expired).toBe(false);
    });
});

describe("isQuerySafeUid() / exactInFilter() Tests", () => {
    it("Accepts ordinary uids and rejects anything the query DSL would read as syntax or substitute.", () => {
        expect(isQuerySafeUid("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
        for (const value of ["a,b", "in(x)", "a)", "me", "null", "", undefined, 42]) {
            expect(isQuerySafeUid(value)).toBe(false);
        }
    });

    it("Builds an in() operand of the safe, distinct values only, or undefined when none are left.", () => {
        expect(exactInFilter(["a", "b", "a", "x,victim", "me"])).toBe("in(a,b)");
        expect(exactInFilter(["x,victim"])).toBeUndefined();
        expect(exactInFilter([])).toBeUndefined();
    });
});
