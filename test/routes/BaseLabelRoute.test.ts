///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit test for BaseLabelRoute's cleanUpDeletedLabel(): that deleting a label reads only the messages that carry it (the
// message list's own label predicate) instead of paging through every message of the mailbox. What it does to those messages is
// exercised through real HTTP+DB requests in test/routes/{mongo,sql}/LabelRoute.test.ts.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseLabelRoute } from "../../src/routes/BaseLabelRoute.js";

class TestLabelRoute extends BaseLabelRoute<any, any> {
    protected messageClass: any = class {};

    protected buildLabelUidsFilter(labelUids: string[]): Record<string, any> {
        return { labelUids: `carries(${labelUids.join(",")})` };
    }
}

describe("BaseLabelRoute Tests (label delete cleanup only)", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());

    const makeRoute = (find: any, update: any = vi.fn()): any => {
        const route: any = objectFactory.newInstance<TestLabelRoute>(TestLabelRoute, { initialize: false });
        route.messageRepo = { find, update, modelClass: undefined };
        return route;
    };

    it("Reads only the messages that carry the label, never a page of every message in the mailbox.", async () => {
        const find = vi.fn().mockResolvedValue([]);
        const route = makeRoute(find);

        await route.cleanUpDeletedLabel("mailbox-1", "label-1");

        // Once for the messages in their folders, once for the ones the user deleted (which can still be restored).
        expect(find).toHaveBeenCalledTimes(2);
        expect(find.mock.calls[0][0]).toEqual(expect.objectContaining({ mailboxUid: "mailbox-1", labelUids: "carries(label-1)" }));
        expect(find.mock.calls[0][0].deleted).toBeUndefined();
        expect(find.mock.calls[1][0]).toEqual(expect.objectContaining({ mailboxUid: "mailbox-1", labelUids: "carries(label-1)", deleted: true }));
    });

    it("Strips the label from each message it finds, and reads the first page again while whole pages were stripped.", async () => {
        const carrying = (n: number) => Array.from({ length: n }, (_, i) => ({ uid: `m${i}`, version: 0, labelUids: ["label-1", "keep"] }));
        const find = vi.fn().mockResolvedValueOnce(carrying(500)).mockResolvedValueOnce(carrying(2)).mockResolvedValue([]);
        const update = vi.fn().mockResolvedValue(undefined);
        const route = makeRoute(find, update);

        await route.cleanUpDeletedLabel("mailbox-1", "label-1");

        // Two rounds of the first pass, then the one of the deleted messages (none).
        expect(find).toHaveBeenCalledTimes(3);
        for (const call of find.mock.calls) {
            expect(call[0].page).toBe(0);
        }
        expect(update).toHaveBeenCalledTimes(502);
        expect(update.mock.calls[0][0].labelUids).toEqual(["keep"]);
    });

    it("Stops instead of reading the same page forever when nothing on it could be stripped.", async () => {
        const find = vi.fn().mockResolvedValue(Array.from({ length: 500 }, (_, i) => ({ uid: `m${i}`, version: 0, labelUids: ["other"] })));
        const route = makeRoute(find);

        await route.cleanUpDeletedLabel("mailbox-1", "label-1");

        // One read per pass, neither repeated.
        expect(find).toHaveBeenCalledTimes(2);
    });

    it("Logs a warning, and still answers the delete, when cleaning the deleted label off its messages fails.", async () => {
        const route = makeRoute(vi.fn());
        const warn = vi.fn();
        route.logger = { warn };
        route.repoUtils = { findOne: vi.fn().mockResolvedValue({ uid: "label-1", mailboxUid: "mailbox-1" }) };
        route.cleanUpDeletedLabel = vi.fn().mockRejectedValue(new Error("scan failed"));
        vi.spyOn(Object.getPrototypeOf(BaseLabelRoute.prototype), "delete").mockResolvedValue(undefined);

        await expect(route.delete("label-1", undefined, undefined, {}, { uid: "u1" })).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(expect.stringContaining("scan failed"));
    });
});
