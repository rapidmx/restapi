///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ACLAction } from "@rapidrest/service-core";
import type { ZeroAccessKey } from "../../src/models/types.js";
import { ENCRYPTION_POLICY_UID, ZeroAccessResolver, zeroAccessTargetFor, type ZeroAccessMailbox } from "../../src/zeroaccess/ZeroAccessResolver.js";

const OWNER = "0f8fad5b-d9cb-469f-a165-70867728950e";

const key = (fingerprint: string, fields: Partial<ZeroAccessKey> = {}): ZeroAccessKey => ({
    publicKey: Buffer.from(`cert-${fingerprint}`).toString("base64"),
    type: "x509",
    useType: "zero-access",
    fingerprint,
    notBefore: 1,
    notAfter: 2,
    ...fields,
});

const mailbox = (fields: Partial<ZeroAccessMailbox> = {}): ZeroAccessMailbox => ({ uid: "mb1", ownerUserUid: OWNER, zeroAccessKeys: [key("za")], ...fields });

function resolver({ policy, records = [], allowedDefault = true }: { policy?: object; records?: object[]; allowedDefault?: boolean } = {}) {
    const policyRepo: any = { findOne: vi.fn().mockResolvedValue(policy) };
    const aclUtils: any = { findACL: vi.fn().mockResolvedValue({ records }) };
    return { resolver: new ZeroAccessResolver(policyRepo, aclUtils, allowedDefault, ["admin"]), policyRepo, aclUtils };
}

describe("ZeroAccessResolver", () => {
    describe("allowed()", () => {
        it("reads the saved policy row, falling back to the server default when the row or the field is missing", async () => {
            const saved = resolver({ policy: { allowZeroAccess: false } });
            expect(await saved.resolver.allowed()).toBe(false);
            expect(saved.policyRepo.findOne).toHaveBeenCalledWith(ENCRYPTION_POLICY_UID, { ignoreACL: true, skipCache: true });

            expect(await resolver({ policy: { allowZeroAccess: null } }).resolver.allowed()).toBe(true);
            expect(await resolver({ allowedDefault: false }).resolver.allowed()).toBe(false);
            expect(await new ZeroAccessResolver(undefined, undefined, true, []).allowed()).toBe(true);
        });
    });

    describe("hasDelegates()", () => {
        it("ignores the owner (however their uid is spelled), administrative roles and grants that don't read", async () => {
            const { resolver: r } = resolver({
                records: [
                    { userOrRoleId: OWNER.toUpperCase(), actions: [ACLAction.FULL] },
                    { userOrRoleId: "admin", actions: [ACLAction.READ] },
                    { userOrRoleId: ".*", actions: [] },
                    { userOrRoleId: "someone", actions: [ACLAction.CREATE] },
                ],
            });
            expect(await r.hasDelegates(mailbox())).toBe(false);
        });

        it("counts another user with read or full access", async () => {
            expect(await resolver({ records: [{ userOrRoleId: "delegate", actions: [ACLAction.READ] }] }).resolver.hasDelegates(mailbox())).toBe(true);
            expect(await resolver({ records: [{ userOrRoleId: "manager", actions: [ACLAction.FULL] }] }).resolver.hasDelegates(mailbox())).toBe(true);
        });

        it("treats a mailbox with no access list, or no ACL utility, as having none", async () => {
            const { resolver: r, aclUtils } = resolver();
            aclUtils.findACL.mockResolvedValue(undefined);
            expect(await r.hasDelegates(mailbox())).toBe(false);
            expect(await new ZeroAccessResolver(undefined, undefined, true, []).hasDelegates(mailbox())).toBe(false);
        });
    });

    describe("status() and target()", () => {
        it("is active, targeting the active key's certificate, for an owned, enabled mailbox with a key", async () => {
            const { resolver: r } = resolver();
            expect(await r.status(mailbox())).toBe("active");
            const target = await r.target(mailbox({ zeroAccessKeys: [key("old", { revokedAt: 1 }), key("za", { notBefore: 2 })] }));
            expect(target?.key.fingerprint).toBe("za");
            expect(target?.certDer.toString()).toBe("cert-za");
        });

        it("checks the administrator's switch first, without reading the access list", async () => {
            const { resolver: r, aclUtils } = resolver({ policy: { allowZeroAccess: false } });
            expect(await r.status(mailbox({ zeroAccessEnabled: false, ownerUserUid: undefined }))).toBe("disabled_by_admin");
            expect(await r.target(mailbox())).toBeUndefined();
            expect(aclUtils.findACL).not.toHaveBeenCalled();
        });

        it("then the owner's switch, then the mailbox's shape, then its key", async () => {
            const { resolver: r, aclUtils } = resolver();
            expect(await r.status(mailbox({ zeroAccessEnabled: false }))).toBe("disabled_by_owner");
            expect(await r.status(mailbox({ ownerUserUid: undefined }))).toBe("shared_mailbox");
            expect(aclUtils.findACL).not.toHaveBeenCalled();
            expect(await r.status(mailbox({ zeroAccessKeys: [] }))).toBe("no_key");

            aclUtils.findACL.mockResolvedValue({ records: [{ userOrRoleId: "delegate", actions: [ACLAction.READ] }] });
            expect(await r.status(mailbox())).toBe("shared_mailbox");
        });
    });

    describe("zeroAccessTargetFor()", () => {
        it("finds a key by fingerprint even once it's revoked, and nothing for an unknown one", () => {
            const target = zeroAccessTargetFor(mailbox({ zeroAccessKeys: [key("old", { revokedAt: 1 })] }), "old");
            expect(target?.certDer.toString()).toBe("cert-old");
            expect(zeroAccessTargetFor(mailbox(), "missing")).toBeUndefined();
            expect(zeroAccessTargetFor({}, "za")).toBeUndefined();
        });
    });
});
