///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The zero-access sealing guards the HTTP suites (`test/routes/{mongo,sql}/{TaskRoute,ContactRoute}.test.ts`) can't reach.
import "reflect-metadata";
import { ContactRouteMongo } from "../../src/routes/mongo/ContactRouteMongo.js";
import { TaskRouteMongo } from "../../src/routes/mongo/TaskRouteMongo.js";
import { newZeroAccessRecordSealer, ZeroAccessRecordSealer } from "../../src/zeroaccess/ZeroAccessRecordSealer.js";
import { ZeroAccessRouteSealing } from "../../src/zeroaccess/ZeroAccessRouteSealing.js";

const factory = (made: any[] = []) => ({ newInstance: vi.fn(async (type: any, options: any) => (made.push({ type, options }), { type, options })) }) as any;

describe("zero-access route sealing (isolated)", () => {
    it("can't be initialized without an ObjectFactory", async () => {
        await expect((new TaskRouteMongo() as any).initTaskSealing()).rejects.toThrow("objectFactory is not set.");
        await expect((new ContactRouteMongo() as any).initContactSealing()).rejects.toThrow("objectFactory is not set.");
    });

    it("drops a client's sealedFields and seals nothing on a backend without zero-access", async () => {
        const sealing = await ZeroAccessRouteSealing.create(factory(), "tasks", undefined, undefined);
        const obj: any = { title: "Plain", sealedFields: { title: "forged" } };
        await sealing.seal(obj, undefined);
        expect(obj).toEqual({ title: "Plain" });
        expect(await sealing.certificateFor("mb")).toBeUndefined();
    });

    it("seals for the record's mailbox, or none when it names none, and gives the certificate its type is sealed to", async () => {
        const sealing: any = await ZeroAccessRouteSealing.create(factory(), "contacts", { name: "MailboxX" }, undefined);
        sealing.sealer = { sealWrite: vi.fn(), target: vi.fn(async () => ({ certDer: new Uint8Array([7]) })) };
        sealing.mailboxRepo = { findOne: vi.fn(async (uid: string) => (uid === "mb" ? { uid } : undefined)) };

        await sealing.seal({ displayName: "x" }, undefined);
        expect(sealing.sealer.sealWrite).toHaveBeenLastCalledWith("contacts", undefined, { displayName: "x" }, undefined);
        await sealing.seal({}, { mailboxUid: "mb" });
        expect(sealing.sealer.sealWrite).toHaveBeenLastCalledWith("contacts", { uid: "mb" }, {}, { mailboxUid: "mb" });

        expect(Array.from(await sealing.certificateFor("mb"))).toEqual([7]);
        expect(await sealing.certificateFor("gone")).toBeUndefined();
        sealing.sealer.target.mockResolvedValueOnce(undefined);
        expect(await sealing.certificateFor("mb")).toBeUndefined();
    });
});

describe("ZeroAccessRecordSealer (isolated)", () => {
    it("is none without an EncryptionPolicy model, and leaves a type it doesn't seal field by field alone", async () => {
        expect(await newZeroAccessRecordSealer({} as any, undefined)).toBeUndefined();
        const sealer = new ZeroAccessRecordSealer(undefined);
        const patch: any = { subject: "mail is sealed whole" };
        await sealer.sealWrite("mail", undefined, patch);
        expect(patch).toEqual({ subject: "mail is sealed whole" });
        // No mailbox: nothing to seal to, stored readable.
        const task: any = { title: "Readable" };
        await sealer.sealWrite("tasks", undefined, task);
        expect(task).toEqual({ title: "Readable", sealedFields: null });
    });
});
