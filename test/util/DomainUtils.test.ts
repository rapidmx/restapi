///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for getVerifiedDomainNames() - objectFactory/repo are hand-built mocks, no real DB,
// same rationale as test/util/AuditLogUtils.test.ts (a fresh stub class per test so the module-level
// repo-cache WeakMap can't leak between tests).
import { getVerifiedDomainNames } from "../../src/util/DomainUtils.js";

function makeStubClass(): any {
    return class StubDomain {
        [key: string]: any;
        constructor(props: any) {
            Object.assign(this, props);
        }
    };
}

describe("getVerifiedDomainNames() Tests", () => {
    let repo: { find: ReturnType<typeof vi.fn> };
    let objectFactory: { newInstance: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        repo = { find: vi.fn().mockResolvedValue([]) };
        objectFactory = { newInstance: vi.fn().mockResolvedValue(repo) };
    });

    it("Returns an empty array when there are no Domain rows.", async () => {
        const result = await getVerifiedDomainNames(objectFactory as any, makeStubClass());

        expect(result).toEqual([]);
        expect(repo.find).toHaveBeenCalledWith({ enabled: true, verified: true }, { ignoreACL: true });
    });

    it("Returns the names of every domain the query returns (filtering is left to the query itself).", async () => {
        repo.find.mockResolvedValue([{ name: "example.com" }, { name: "example.org" }]);

        const result = await getVerifiedDomainNames(objectFactory as any, makeStubClass());

        expect(result).toEqual(["example.com", "example.org"]);
    });

    it("Reuses the same cached repo across two calls with the same domainClass (only one newInstance call).", async () => {
        const domainClass = makeStubClass();

        await getVerifiedDomainNames(objectFactory as any, domainClass);
        await getVerifiedDomainNames(objectFactory as any, domainClass);

        expect(objectFactory.newInstance).toHaveBeenCalledTimes(1);
        expect(repo.find).toHaveBeenCalledTimes(2);
    });
});
