///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit test for `collectMailboxContentLines()`'s paging/cap/date-range query shape, against fake repos that
// record every `find()` call - the real-DB behavior (both backends) is covered by DataExportJob/
// MatterExportJob's own integration tests; this pins down HOW MUCH gets loaded before the cap trips.
import { collectMailboxContentLines, MailboxContentEntityClasses } from "../../src/util/MailboxContentUtils.js";

function makeFixture(rowsPerEntity: Record<string, number>) {
    const calls: { entity: string; criteria: any; options: any }[] = [];
    const classes: any = {};
    for (const entity of ["message", "contact", "contactList", "calendarEvent", "task", "note", "attachment"]) {
        classes[entity] = { name: `${entity}Class` };
    }
    const objectFactory: any = {
        newInstance: async (_type: any, opts: { name: string }) => {
            const entity: string = opts.name.replace(/Class$/, "");
            const total: number = rowsPerEntity[entity] ?? 0;
            return {
                // Keyset paging: rows are uids `<entity>-000000`.. sorted ascending; `uid: gt(x)` resumes after `x`.
                find: async (criteria: any, options: any) => {
                    calls.push({ entity, criteria, options });
                    const all: string[] = Array.from({ length: total }, (_, i) => `${entity}-${String(i).padStart(6, "0")}`);
                    const after: string | undefined = criteria.uid?.match(/^gt\((.*)\)$/)?.[1];
                    return all
                        .filter((uid) => after === undefined || uid > after)
                        .slice(0, criteria.limit)
                        .map((uid) => ({ uid }));
                },
            };
        },
    };
    return { calls, classes: classes as MailboxContentEntityClasses, objectFactory };
}

describe("MailboxContentUtils Tests", () => {
    it("Collects every row across pages for every entity type.", async () => {
        const { classes, objectFactory } = makeFixture({ message: 12, contact: 3 });
        const lines = await collectMailboxContentLines(objectFactory, classes, "mb", { uid: "mb" } as any, undefined, 1_000, 5);
        expect(lines.length).toBe(1 + 12 + 3);
        expect(lines.filter((l) => JSON.parse(l).entityType === "message").length).toBe(12);
    });

    it("Throws as soon as a page would exceed the row budget, without loading the remaining pages.", async () => {
        const { calls, classes, objectFactory } = makeFixture({ message: 10_000 });
        await expect(collectMailboxContentLines(objectFactory, classes, "mb", { uid: "mb" } as any, undefined, 20, 10)).rejects.toThrow(
            "exceeds the maximum of 20 exportable rows",
        );
        // Mailbox line + page 0 (10) fits; page 1 would make 21 > 20 - so exactly two pages were ever read.
        expect(calls.filter((c) => c.entity === "message").length).toBe(2);
    });

    it("Pages by stable uid keyset (sorted, uid > last uid of the previous page), never by unsorted offset.", async () => {
        const { calls, classes, objectFactory } = makeFixture({ contact: 5 });
        await collectMailboxContentLines(objectFactory, classes, "mb", { uid: "mb" } as any, undefined, 1_000, 2);
        const contactCalls = calls.filter((c) => c.entity === "contact");
        expect(contactCalls.map((c) => c.criteria.uid)).toEqual([undefined, "gt(contact-000001)", "gt(contact-000003)"]);
        for (const call of contactCalls) {
            expect(call.criteria.sort).toEqual({ uid: "ASC" });
            expect(call.criteria.page).toBeUndefined();
            expect(call.options.page).toBeUndefined();
            expect(call.criteria.mailboxUid).toBe("mb");
        }
    });

    it("Pushes both date-range bounds into the Message query as one range(...) criterion, and applies it to messages only.", async () => {
        const { calls, classes, objectFactory } = makeFixture({ message: 1, contact: 1 });
        const start = new Date("2026-03-01T00:00:00.000Z");
        const end = new Date("2026-03-31T00:00:00.000Z");
        await collectMailboxContentLines(objectFactory, classes, "mb", { uid: "mb" } as any, { start, end });
        const messageCall = calls.find((c) => c.entity === "message")!;
        expect(messageCall.criteria.sentDate).toBe(`range(${start.toISOString()},${end.toISOString()})`);
        expect(calls.find((c) => c.entity === "contact")!.criteria.sentDate).toBeUndefined();
    });
});
