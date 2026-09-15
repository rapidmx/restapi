///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { ContactMongo } from "../../src/models/mongo/ContactMongo.js";
import { keyContactUid, MAX_CONTACT_KEY_WRITE_ATTEMPTS, writeContactKeys } from "../../src/util/ContactKeyUtils.js";

vi.mock("../../src/util/FolderUtils.js", () => ({
    findOrCreateWellKnownFolder: vi.fn(async (_repo: any, _class: any, mailboxUid: string) => ({ uid: `contacts-of-${mailboxUid}` })),
}));

const versionConflict = () => new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "Invalid object version");
const identifierExists = () => new ApiError(ApiErrors.IDENTIFIER_EXISTS, 400, "Identifier exists");

function makeTarget(overrides: Record<string, any> = {}) {
    const contactRepo: any = {
        modelClass: ContactMongo,
        create: vi.fn(async (instance: any) => instance),
        update: vi.fn(async (obj: any, existing: any) => ({ ...existing, ...obj, version: existing.version + 1 })),
        findOne: vi.fn(async () => undefined),
    };
    return {
        contactRepo,
        folderRepo: {} as any,
        contactClass: ContactMongo,
        folderClass: Object,
        mailboxUid: "m@example.com",
        address: "alice@example.net",
        findContact: vi.fn(async () => undefined as any),
        ...overrides,
    };
}

describe("ContactKeyUtils Tests", () => {
    it("keyContactUid() is deterministic per mailbox and exact address.", () => {
        expect(keyContactUid("m", "a@x")).toBe(keyContactUid("m", "a@x"));
        expect(keyContactUid("m", "a@x")).not.toBe(keyContactUid("m", "A@x"));
        expect(keyContactUid("m", "a@x")).not.toBe(keyContactUid("n", "a@x"));
    });

    it("Writes nothing when the merge returns undefined, returning what was read.", async () => {
        const target = makeTarget();
        expect(await writeContactKeys(target as any, () => undefined)).toEqual({ contact: undefined, written: false });
        expect(target.contactRepo.create).not.toHaveBeenCalled();
    });

    it("Creates a new contact at the deterministic uid in the Contacts folder, after beforeCreate.", async () => {
        const beforeCreate = vi.fn(async () => undefined);
        const target = makeTarget({ beforeCreate });
        const result = await writeContactKeys(target as any, () => ({ keysFirstSeen: 5 }) as any);
        expect(result.written).toBe(true);
        expect(beforeCreate).toHaveBeenCalledWith({ uid: "contacts-of-m@example.com" });
        expect(result.contact).toEqual(
            expect.objectContaining({
                uid: keyContactUid("m@example.com", "alice@example.net"),
                folderUid: "contacts-of-m@example.com",
                emails: [{ address: "alice@example.net", type: "other" }],
                keysFirstSeen: 5,
            }),
        );
    });

    it("Updates an existing contact version-checked, and retries with a fresh read after a version conflict.", async () => {
        const rows = [
            { uid: "c1", version: 1, keys: [] },
            { uid: "c1", version: 2, keys: [{ useType: "sign" }] },
        ];
        const target = makeTarget({ findContact: vi.fn(async () => rows.shift()) });
        target.contactRepo.update.mockRejectedValueOnce(versionConflict());
        const merge = vi.fn((existing: any) => ({ keysFirstSeen: existing.version }) as any);
        const result = await writeContactKeys(target as any, merge);
        expect(merge).toHaveBeenCalledTimes(2);
        expect(target.contactRepo.update.mock.calls[0][0]).toEqual({ uid: "c1", version: 1, keysFirstSeen: 1 });
        expect(target.contactRepo.update.mock.calls[1][0]).toEqual({ uid: "c1", version: 2, keysFirstSeen: 2 });
        expect(result).toEqual({ contact: expect.objectContaining({ version: 3 }), written: true });
    });

    it("A create that loses the uid to a live concurrent create re-reads and merges into the winner.", async () => {
        const winner = { uid: "winner", version: 0 };
        const findContact = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(winner);
        const target = makeTarget({ findContact });
        target.contactRepo.create.mockRejectedValueOnce(identifierExists());
        target.contactRepo.findOne.mockResolvedValueOnce(winner);
        const result = await writeContactKeys(target as any, (existing: any) => (existing ? undefined : ({ keysFirstSeen: 1 } as any)));
        expect(result).toEqual({ contact: expect.objectContaining({ uid: "winner" }), written: false });
        expect(target.contactRepo.create).toHaveBeenCalledTimes(1);
    });

    it("Falls back to a random uid when a soft-deleted contact holds the deterministic one.", async () => {
        const target = makeTarget();
        target.contactRepo.create.mockRejectedValueOnce(identifierExists());
        const result = await writeContactKeys(target as any, () => ({ keysFirstSeen: 1 }) as any);
        expect(target.contactRepo.create).toHaveBeenCalledTimes(2);
        expect(result.contact!.uid).not.toBe(keyContactUid("m@example.com", "alice@example.net"));
    });

    it("Rethrows errors that aren't a lost race, including a duplicate key on an update.", async () => {
        const target = makeTarget();
        target.contactRepo.create.mockRejectedValueOnce(new Error("boom"));
        await expect(writeContactKeys(target as any, () => ({}) as any)).rejects.toThrow("boom");

        const updating = makeTarget({ findContact: vi.fn(async () => ({ uid: "c", version: 0 })) });
        updating.contactRepo.update.mockRejectedValueOnce(identifierExists());
        await expect(writeContactKeys(updating as any, () => ({}) as any)).rejects.toMatchObject({ status: 400 });

        const denied = makeTarget({ beforeCreate: async () => Promise.reject(new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, "no")) });
        await expect(writeContactKeys(denied as any, () => ({}) as any)).rejects.toMatchObject({ status: 403 });
    });

    it("Gives up with 409 after repeatedly losing races.", async () => {
        const target = makeTarget({ findContact: vi.fn(async () => ({ uid: "c", version: 0 })) });
        target.contactRepo.update.mockRejectedValue(versionConflict());
        await expect(writeContactKeys(target as any, () => ({}) as any)).rejects.toMatchObject({ status: 409 });
        expect(target.contactRepo.update).toHaveBeenCalledTimes(MAX_CONTACT_KEY_WRITE_ATTEMPTS);
    });
});
