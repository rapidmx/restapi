///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for getVerifiedDomainNames() - objectFactory/repo are hand-built mocks, no real DB,
// same rationale as test/util/AuditLogUtils.test.ts (a fresh stub class per test so the module-level
// repo-cache WeakMap can't leak between tests).
import { classifyRecipientTier, getVerifiedDomainNames, isInternalAddress } from "../../src/util/DomainUtils.js";

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

describe("isInternalAddress() Tests", () => {
    let repo: { find: ReturnType<typeof vi.fn> };
    let objectFactory: { newInstance: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        repo = { find: vi.fn().mockResolvedValue([{ name: "example.com" }]) };
        objectFactory = { newInstance: vi.fn().mockResolvedValue(repo) };
    });

    it("Returns true for an address whose domain is verified.", async () => {
        const result = await isInternalAddress(objectFactory as any, makeStubClass(), "user@example.com");
        expect(result).toBe(true);
    });

    it("Returns false for an address whose domain is not verified.", async () => {
        const result = await isInternalAddress(objectFactory as any, makeStubClass(), "user@outside.com");
        expect(result).toBe(false);
    });

    it("Is case-insensitive on the domain.", async () => {
        const result = await isInternalAddress(objectFactory as any, makeStubClass(), "user@EXAMPLE.COM");
        expect(result).toBe(true);
    });

    it("Returns false without querying at all for an address with no @ (no domain to check).", async () => {
        const result = await isInternalAddress(objectFactory as any, makeStubClass(), "not-an-address");
        expect(result).toBe(false);
        expect(objectFactory.newInstance).not.toHaveBeenCalled();
    });
});

describe("classifyRecipientTier() Tests", () => {
    let repo: { find: ReturnType<typeof vi.fn> };
    let objectFactory: { newInstance: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        repo = { find: vi.fn().mockResolvedValue([{ name: "example.com" }]) };
        objectFactory = { newInstance: vi.fn().mockResolvedValue(repo) };
    });

    it("Classifies a same-org address as 'same-org', without ever calling isFederatedPeer.", async () => {
        const isFederatedPeer = vi.fn().mockResolvedValue(true);

        const result = await classifyRecipientTier(objectFactory as any, makeStubClass(), "user@example.com", isFederatedPeer);

        expect(result).toBe("same-org");
        expect(isFederatedPeer).not.toHaveBeenCalled();
    });

    it("Classifies a non-same-org address as 'federated' when isFederatedPeer resolves true.", async () => {
        const isFederatedPeer = vi.fn().mockResolvedValue(true);

        const result = await classifyRecipientTier(objectFactory as any, makeStubClass(), "user@peer.com", isFederatedPeer);

        expect(result).toBe("federated");
        expect(isFederatedPeer).toHaveBeenCalledWith("user@peer.com");
    });

    it("Classifies a non-same-org address as 'external' when isFederatedPeer resolves false.", async () => {
        const result = await classifyRecipientTier(
            objectFactory as any,
            makeStubClass(),
            "user@outside.com",
            vi.fn().mockResolvedValue(false),
        );

        expect(result).toBe("external");
    });

    it("Defaults to 'external' for any non-same-org address when no isFederatedPeer is supplied.", async () => {
        const result = await classifyRecipientTier(objectFactory as any, makeStubClass(), "user@outside.com");
        expect(result).toBe("external");
    });
});
