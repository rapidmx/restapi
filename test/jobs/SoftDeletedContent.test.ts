///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Unit tests for `softDeletedContentLines()` - hand-built fake repositories; the real-DB behaviour (both backends) is covered by
// the DataExportJob and MatterExportJob integration tests.
import { RecoverableBaseEntity } from "@rapidrest/service-core";
import { softDeletedContentLines } from "../../src/jobs/SoftDeletedContent.js";

/** A repo over `rows` answering keyset paging (`sort uid`, `uid: gt(<last>)`, `limit`) and recording each query. */
function pagedRepo(rows: any[], modelClass?: any): any {
    const sorted = [...rows].sort((a, b) => (a.uid < b.uid ? -1 : 1));
    return {
        modelClass,
        find: vi.fn(async (query: any) => {
            const after: string | undefined = /^gt\((.*)\)$/.exec(query.uid ?? "")?.[1];
            return sorted.filter((row) => after === undefined || row.uid > after).slice(0, query.limit);
        }),
    };
}

describe("SoftDeletedContent Tests", () => {
    class Recoverable extends RecoverableBaseEntity {}
    class Plain {}
    const collect = async (generator: AsyncGenerator<string>): Promise<any[]> => {
        const out: any[] = [];
        for await (const line of generator) {
            out.push(JSON.parse(line));
        }
        return out;
    };

    it("softDeletedContentLines() yields the soft-deleted rows of the recoverable repositories only.", async () => {
        const messages = pagedRepo([{ uid: "m1" }], Recoverable);
        const tasks = pagedRepo([{ uid: "t1" }], Recoverable);
        const notes = pagedRepo([{ uid: "n1" }], Plain);
        const unknown = pagedRepo([{ uid: "u1" }]);

        const lines = await collect(softDeletedContentLines({ message: messages, task: tasks, note: notes, attachment: unknown } as any, "mbx-1", undefined, 0, 100));

        expect(lines).toEqual([
            { entityType: "message", uid: "m1", deleted: true },
            { entityType: "task", uid: "t1", deleted: true },
        ]);
        expect(messages.find.mock.calls[0][0]).toMatchObject({ deleted: true });
        expect(notes.find).not.toHaveBeenCalled();
        expect(unknown.find).not.toHaveBeenCalled();
    });

    it("softDeletedContentLines() narrows only the messages by the date range.", async () => {
        const messages = pagedRepo([], Recoverable);
        const tasks = pagedRepo([], Recoverable);
        const range = { start: new Date("2026-01-01T00:00:00Z"), end: new Date("2026-02-01T00:00:00Z") };

        await collect(softDeletedContentLines({ message: messages, task: tasks } as any, "mbx-1", range, 0, 100));

        expect(messages.find.mock.calls[0][0].sentDate).toBe("range(2026-01-01T00:00:00.000Z,2026-02-01T00:00:00.000Z)");
        expect(tasks.find.mock.calls[0][0].sentDate).toBeUndefined();
    });

    it("softDeletedContentLines() throws once the rows already held plus its own exceed maxRows.", async () => {
        const messages = pagedRepo([{ uid: "m1" }, { uid: "m2" }], Recoverable);

        await expect(collect(softDeletedContentLines({ message: messages } as any, "mbx-1", undefined, 9, 10))).rejects.toThrow(
            "Mailbox mbx-1's content exceeds the maximum of 10 exportable rows.",
        );
    });
});
