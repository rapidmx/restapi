///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for the edge cases of the suggested-contacts bookkeeping a real datastore can't be made to produce on demand
// (a duplicate-key create, a failing write, a lost version race). The same code against real MongoDB and SQL runs through
// `test/routes/directorySuite.ts` (`POST /mail/directory/suggested-contacts`).
import { FolderType } from "../../src/models/types.js";

vi.mock("../../src/util/FolderUtils.js", () => ({
    findOrCreateWellKnownFolder: vi.fn(async (_repo: any, _class: any, mailboxUid: string) => ({ uid: `suggested-of-${mailboxUid}` })),
}));

import { findOrCreateWellKnownFolder } from "../../src/util/FolderUtils.js";
import { SUGGESTED_CONTACTS_MAX_PER_CALL, SuggestedContactUtils, suggestedContactUid } from "../../src/util/SuggestedContactUtils.js";

class ContactClass {
    constructor(other: any) {
        Object.assign(this, other);
    }
}
class FolderClass {}

const warn = vi.fn();

function build(options: { correspondents?: any[]; total?: number; folders?: any[]; contacts?: any[] } = {}) {
    const correspondents = options.correspondents ?? [];
    const correspondentRepo: any = {
        count: vi.fn(async () => options.total ?? correspondents.length),
        find: vi.fn(async () => correspondents),
        findOne: vi.fn(async (uid: string) => correspondents.find((row) => row.uid === uid)),
        update: vi.fn(async () => undefined),
    };
    const folderRepo: any = {
        find: vi.fn(async () => options.folders ?? [{ uid: "contacts-folder" }]),
        findOne: vi.fn(async (uid: string) => ({ uid, version: 3, syncKeyVersion: 4 })),
        update: vi.fn(async () => undefined),
    };
    const contactRepo: any = {
        find: vi.fn(async () => options.contacts ?? []),
        create: vi.fn(async (contact: any) => contact),
    };
    const utils: any = new SuggestedContactUtils(correspondentRepo, folderRepo, contactRepo, FolderClass, ContactClass);
    utils.logger = { warn };
    return { utils: utils as SuggestedContactUtils, correspondentRepo, folderRepo, contactRepo };
}

const row = (address: any, extra: any = {}) => ({ uid: `row-${String(address)}`, version: 1, address, displayName: "", ...extra });

describe("SuggestedContactUtils", () => {
    beforeEach(() => {
        warn.mockClear();
    });

    it("derives one stable uid per mailbox and (case-insensitive) address", () => {
        expect(suggestedContactUid("m1", "A@X.test")).toBe(suggestedContactUid("m1", "a@x.test"));
        expect(suggestedContactUid("m1", "a@x.test")).not.toBe(suggestedContactUid("m2", "a@x.test"));
    });

    it("finds or creates the Suggested Contacts folder and stops when there is nothing to consider", async () => {
        const { utils, correspondentRepo, contactRepo } = build({ total: 0 });
        expect(await utils.ensureSuggestedContacts("m1")).toEqual({ folderUid: "suggested-of-m1", created: 0, remaining: 0 });
        expect(findOrCreateWellKnownFolder).toHaveBeenCalledWith(expect.anything(), FolderClass, "m1", FolderType.SUGGESTED_CONTACTS, undefined);
        expect(correspondentRepo.find).not.toHaveBeenCalled();
        expect(contactRepo.create).not.toHaveBeenCalled();
    });

    it("creates a contact per unknown address, naming it by the display name or the address, and reports what is left", async () => {
        const rows = [row("Named@X.test", { displayName: "  Nam Ed " }), row("bare@x.test", { displayName: "   " }), row("known@x.test"), row("")];
        const { utils, contactRepo, correspondentRepo, folderRepo } = build({
            correspondents: rows,
            total: rows.length + 7,
            contacts: [{ emails: [{ address: "KNOWN@x.test" }, { address: 5 }, null] }, {}],
        });
        const result = await utils.ensureSuggestedContacts("m1", { uid: "u" } as any);
        expect(result).toEqual({ folderUid: "suggested-of-m1", created: 2, remaining: 7 });
        expect(findOrCreateWellKnownFolder).toHaveBeenCalledWith(expect.anything(), FolderClass, "m1", FolderType.SUGGESTED_CONTACTS, { uid: "u" });
        const made = contactRepo.create.mock.calls.map(([contact]: any[]) => contact);
        expect(made).toEqual([
            expect.objectContaining({ uid: suggestedContactUid("m1", "named@x.test"), mailboxUid: "m1", folderUid: "suggested-of-m1", displayName: "Nam Ed" }),
            expect.objectContaining({ displayName: "bare@x.test", emails: [{ address: "bare@x.test", type: "other" }] }),
        ]);
        expect(contactRepo.create.mock.calls[0][1]).toEqual({ ignoreACL: true });
        // Every row that was looked at is marked, the empty address too; the folder's sync key moves on.
        expect(correspondentRepo.update).toHaveBeenCalledTimes(4);
        expect(correspondentRepo.update.mock.calls[0][0]).toMatchObject({ uid: "row-Named@X.test", version: 1, suggestedAt: expect.any(Date) });
        expect(folderRepo.update).toHaveBeenCalledWith(expect.objectContaining({ uid: "suggested-of-m1", version: 3, syncKeyVersion: 5 }), expect.anything(), {
            ignoreACL: true,
            skipPush: true,
        });
    });

    it("never asks for more than the per-call limit and creates nothing for a mailbox without contact folders' contacts to compare", async () => {
        const { utils, correspondentRepo, contactRepo } = build({ correspondents: [row("a@x.test")], folders: [] });
        await utils.ensureSuggestedContacts("m1");
        expect(correspondentRepo.find.mock.calls[0][0]).toMatchObject({ suggestedAt: null, limit: SUGGESTED_CONTACTS_MAX_PER_CALL });
        expect(contactRepo.find).not.toHaveBeenCalled();
        expect(contactRepo.create).toHaveBeenCalledTimes(1);
    });

    it("counts an address another call already made a contact of as considered, not created", async () => {
        const { utils, contactRepo, correspondentRepo, folderRepo } = build({ correspondents: [row("a@x.test"), row("b@x.test")] });
        contactRepo.create.mockRejectedValueOnce(Object.assign(new Error("E11000 duplicate key"), { code: 11000 }));
        contactRepo.create.mockRejectedValueOnce(Object.assign(new Error("conflict"), { status: 409 }));
        expect(await utils.ensureSuggestedContacts("m1")).toMatchObject({ created: 0, remaining: 0 });
        expect(correspondentRepo.update).toHaveBeenCalledTimes(2);
        expect(folderRepo.update).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
    });

    it("logs a row that can't be written, marks it anyway and goes on with the rest", async () => {
        const { utils, contactRepo, correspondentRepo } = build({ correspondents: [row("a@x.test"), row("b@x.test")] });
        contactRepo.create.mockRejectedValueOnce(new Error("disk full"));
        expect(await utils.ensureSuggestedContacts("m1")).toMatchObject({ created: 1 });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("a@x.test"));
        expect(correspondentRepo.update).toHaveBeenCalledTimes(2);
    });

    it("retries the marker against a fresh read after a lost version race, and gives up after three attempts", async () => {
        const { utils, correspondentRepo } = build({ correspondents: [row("a@x.test"), row("b@x.test"), row("c@x.test")] });
        // a: loses once, wins on the retry. b: always loses. c: loses and then its row has gone.
        correspondentRepo.update.mockImplementation(async (patch: any) => {
            if (patch.uid === "row-a@x.test" && patch.version === 1) throw new Error("version conflict");
            if (patch.uid !== "row-a@x.test") throw new Error("version conflict");
        });
        correspondentRepo.findOne.mockImplementation(async (uid: string) => (uid === "row-c@x.test" ? undefined : { uid, version: 2 }));
        await utils.ensureSuggestedContacts("m1");
        const attempts = (uid: string) => correspondentRepo.update.mock.calls.filter(([patch]: any[]) => patch.uid === uid).length;
        expect(attempts("row-a@x.test")).toBe(2);
        expect(attempts("row-b@x.test")).toBe(3);
        expect(attempts("row-c@x.test")).toBe(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not mark b@x.test"));
    });

    it("leaves the sync key alone when the folder has gone, and logs a sync key it can't bump", async () => {
        const gone = build({ correspondents: [row("a@x.test")] });
        gone.folderRepo.findOne.mockResolvedValue(undefined);
        await gone.utils.ensureSuggestedContacts("m1");
        expect(gone.folderRepo.update).not.toHaveBeenCalled();

        const failing = build({ correspondents: [row("a@x.test")] });
        failing.folderRepo.update.mockRejectedValue(new Error("nope"));
        expect(await failing.utils.ensureSuggestedContacts("m1")).toMatchObject({ created: 1 });
        expect(failing.folderRepo.update).toHaveBeenCalledTimes(3);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("sync key"));
    });

    it("treats a correspondent row without an address as nothing to create", async () => {
        const { utils, contactRepo } = build({ correspondents: [row(undefined)] });
        expect(await utils.ensureSuggestedContacts("m1")).toMatchObject({ created: 0 });
        expect(contactRepo.create).not.toHaveBeenCalled();
    });
});
