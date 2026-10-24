///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `BaseTaskRoute`'s guards the HTTP suites (`test/routes/{mongo,sql}/TaskRoute.test.ts`) can't reach.
import "reflect-metadata";
import { TaskRouteMongo } from "../../src/routes/mongo/TaskRouteMongo.js";
import { newZeroAccessRecordSealer } from "../../src/zeroaccess/ZeroAccessRecordSealer.js";

describe("BaseTaskRoute (isolated)", () => {
    it("can't be initialized without an ObjectFactory", async () => {
        const route = new TaskRouteMongo() as any;
        await expect(route.initTaskSealing()).rejects.toThrow("objectFactory is not set.");
    });

    it("drops a client's sealedFields and seals nothing on a backend without zero-access", async () => {
        const route = new TaskRouteMongo() as any;
        const obj: any = { title: "Plain", sealedFields: { title: "forged" } };
        await route.seal(obj, undefined);
        expect(obj).toEqual({ title: "Plain" });
    });

    it("seals for no mailbox when the body names none", async () => {
        const route = new TaskRouteMongo() as any;
        route.recordSealer = { sealWrite: vi.fn() };
        route.mailboxRepo = { findOne: vi.fn() };
        await route.seal({ title: "x" }, undefined);
        expect(route.mailboxRepo.findOne).not.toHaveBeenCalled();
        expect(route.recordSealer.sealWrite).toHaveBeenCalledWith("tasks", undefined, { title: "x" }, undefined);
    });
});

describe("ZeroAccessRecordSealer (isolated)", () => {
    it("is none without an EncryptionPolicy model, and leaves a type it doesn't seal field by field alone", async () => {
        expect(await newZeroAccessRecordSealer({} as any, undefined)).toBeUndefined();
        const { ZeroAccessRecordSealer } = await import("../../src/zeroaccess/ZeroAccessRecordSealer.js");
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
