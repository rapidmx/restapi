///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Pure-function tests for the mail list's derivation/translation helpers. The end-to-end behavior they back
// (a database actually ordering and filtering on these fields) is exercised against real databases in
// `test/routes/{mongo,sql}/MessageList.test.ts`; this file covers the operand shapes an HTTP test can't reach.
import { MessageClassification, MessageImportance } from "../../src/models/types.js";
import { MAX_INDEXED_VALUE_LENGTH } from "../../src/util/ConversationUtils.js";
import {
    DEFAULT_IMPORTANCE_RANK,
    DEFAULT_MESSAGE_LIST_SORT,
    MESSAGE_LIST_FIELDS,
    MESSAGE_LIST_FILTER_NAMES,
    MESSAGE_LIST_QUERY_PARAMS,
    MESSAGE_LIST_SORT_NAMES,
    MESSAGE_LIST_SOURCE_FIELDS,
    boundedListLimit,
    boundedListPage,
    buildMessageListFilter,
    buildMessageListSort,
    deriveMessageListFields,
    importanceRankOf,
    syncMessageListFields,
} from "../../src/util/MessageListUtils.js";

describe("MessageListUtils", () => {
    describe("importanceRankOf()", () => {
        it("ranks the three known importances so high sorts above normal above low", () => {
            expect(importanceRankOf(MessageImportance.LOW)).toBeLessThan(importanceRankOf(MessageImportance.NORMAL));
            expect(importanceRankOf(MessageImportance.NORMAL)).toBeLessThan(importanceRankOf(MessageImportance.HIGH));
        });

        it("falls back to the normal rank for anything else", () => {
            expect(importanceRankOf("urgent")).toBe(DEFAULT_IMPORTANCE_RANK);
            expect(importanceRankOf(undefined)).toBe(DEFAULT_IMPORTANCE_RANK);
            expect(importanceRankOf(7)).toBe(DEFAULT_IMPORTANCE_RANK);
            // A key inherited from Object.prototype must not be mistaken for a known importance.
            expect(importanceRankOf("toString")).toBe(DEFAULT_IMPORTANCE_RANK);
        });
    });

    describe("deriveMessageListFields()", () => {
        it("derives every mirror from the nested fields", () => {
            expect(
                deriveMessageListFields({
                    flags: { read: true, flagged: true, answered: false, forwarded: false },
                    from: { address: "  Owner@Example.COM ", type: "to" as any },
                    importance: MessageImportance.HIGH,
                }),
            ).toEqual({ read: true, flagged: true, fromAddress: "owner@example.com", importanceRank: 2 });
        });

        it("answers this library's own defaults for a message with nothing set, and for no message at all", () => {
            const empty = { read: false, flagged: false, fromAddress: "", importanceRank: DEFAULT_IMPORTANCE_RANK };
            expect(deriveMessageListFields({})).toEqual(empty);
            expect(deriveMessageListFields(undefined)).toEqual(empty);
            expect(deriveMessageListFields({ from: { address: 42 as any, type: "to" as any } })).toEqual(empty);
        });

        it("bounds an over-long sender address the same way an indexed identifier is bounded", () => {
            const address = `${"a".repeat(MAX_INDEXED_VALUE_LENGTH)}@example.com`;
            const derived = deriveMessageListFields({ from: { address, type: "to" as any } });
            expect(derived.fromAddress.startsWith("sha256:")).toBe(true);
            expect(derived.fromAddress.length).toBeLessThanOrEqual(MAX_INDEXED_VALUE_LENGTH);
        });

        it("names every field it produces in MESSAGE_LIST_FIELDS", () => {
            expect(Object.keys(deriveMessageListFields({})).sort()).toEqual([...MESSAGE_LIST_FIELDS].sort());
        });
    });

    describe("syncMessageListFields()", () => {
        it("re-derives the mirrors from the patch merged over the stored row", () => {
            const patch: Record<string, any> = { flags: { read: true, flagged: false, answered: false, forwarded: false } };
            syncMessageListFields(patch, {
                flags: { read: false, flagged: true, answered: false, forwarded: false },
                from: { address: "sender@example.com", type: "to" as any },
                importance: MessageImportance.LOW,
            });
            // `read` comes from the patch, `fromAddress`/`importanceRank` from the row the patch is applied to.
            expect(patch.read).toBe(true);
            expect(patch.flagged).toBe(false);
            expect(patch.fromAddress).toBe("sender@example.com");
            expect(patch.importanceRank).toBe(0);
        });

        it("leaves a patch that touches none of the source fields completely alone", () => {
            const patch: Record<string, any> = { subject: "unchanged" };
            syncMessageListFields(patch, { flags: { read: true, flagged: false, answered: false, forwarded: false } });
            expect(patch).toEqual({ subject: "unchanged" });
        });

        it("tolerates a missing patch and a missing stored row", () => {
            expect(() => syncMessageListFields(undefined as any)).not.toThrow();
            const patch: Record<string, any> = { importance: MessageImportance.HIGH };
            syncMessageListFields(patch);
            expect(patch.importanceRank).toBe(2);
        });

        it("reacts to every field MESSAGE_LIST_SOURCE_FIELDS names", () => {
            for (const field of MESSAGE_LIST_SOURCE_FIELDS) {
                const patch: Record<string, any> = { [field]: undefined };
                syncMessageListFields(patch);
                expect(Object.keys(patch)).toEqual(expect.arrayContaining([...MESSAGE_LIST_FIELDS]));
            }
        });
    });

    describe("buildMessageListSort()", () => {
        it("defaults to newest received first with a stable uid tiebreaker", () => {
            expect(buildMessageListSort(undefined, undefined)).toEqual({ receivedDate: "DESC", uid: "ASC" });
            expect(buildMessageListSort("", "")).toEqual(buildMessageListSort(DEFAULT_MESSAGE_LIST_SORT, undefined));
        });

        it("appends receivedDate as a secondary key for every sort that isn't already on it", () => {
            expect(buildMessageListSort("from", undefined)).toEqual({ fromAddress: "ASC", receivedDate: "DESC", uid: "ASC" });
            expect(buildMessageListSort("importance", undefined)).toEqual({
                importanceRank: "DESC",
                receivedDate: "DESC",
                uid: "ASC",
            });
        });

        it("honors an explicit sortOrder in either direction, case-insensitively", () => {
            expect(buildMessageListSort("date", "ASC").receivedDate).toBe("ASC");
            expect(buildMessageListSort("subject", "desc").subject).toBe("DESC");
        });

        it("accepts every name it advertises", () => {
            for (const name of MESSAGE_LIST_SORT_NAMES) {
                expect(Object.keys(buildMessageListSort(name, undefined)).length).toBeGreaterThan(0);
            }
        });

        it("rejects an unknown sortBy, an inherited property name, and an unknown sortOrder", () => {
            expect(() => buildMessageListSort("category", undefined)).toThrow(/sortBy/);
            expect(() => buildMessageListSort("constructor", undefined)).toThrow(/sortBy/);
            expect(() => buildMessageListSort("date", "sideways")).toThrow(/sortOrder/);
        });
    });

    describe("buildMessageListFilter()", () => {
        it("compiles nothing for an absent or empty filter, and for the explicit 'all'", () => {
            expect(buildMessageListFilter(undefined)).toEqual({});
            expect(buildMessageListFilter("")).toEqual({});
            expect(buildMessageListFilter("all")).toEqual({});
        });

        it("compiles every advertised name to a query fragment", () => {
            for (const name of MESSAGE_LIST_FILTER_NAMES) {
                expect(buildMessageListFilter(name)).toBeTypeOf("object");
            }
            expect(Object.keys(buildMessageListFilter("unread"))).toEqual(["read"]);
            expect(Object.keys(buildMessageListFilter("flagged"))).toEqual(["flagged"]);
            expect(Object.keys(buildMessageListFilter("hasAttachments"))).toEqual(["hasAttachments"]);
            expect(Object.keys(buildMessageListFilter("other"))).toEqual(["inferenceClassification"]);
        });

        it("compiles 'focused' to a two-branch $or so an absent classification still counts as focused", () => {
            const focused: any = buildMessageListFilter("focused");
            expect(focused.$or.length).toBe(2);
            expect(focused.$or[0].inferenceClassification.value).toBe(MessageClassification.FOCUSED);
            expect(focused.$or[1].inferenceClassification.value).toBeNull();
        });

        it("rejects an unknown filter and an inherited property name", () => {
            expect(() => buildMessageListFilter("mentionsMe")).toThrow(/filter/);
            expect(() => buildMessageListFilter("hasOwnProperty")).toThrow(/filter/);
        });
    });

    describe("boundedListLimit()/boundedListPage()", () => {
        it("bounds a limit to the default and the ceiling", () => {
            expect(boundedListLimit(undefined, 25, 100)).toBe(25);
            expect(boundedListLimit("nonsense", 25, 100)).toBe(25);
            expect(boundedListLimit(0, 25, 100)).toBe(25);
            expect(boundedListLimit("-5", 25, 100)).toBe(25);
            expect(boundedListLimit("10", 25, 100)).toBe(10);
            expect(boundedListLimit(10.7, 25, 100)).toBe(10);
            expect(boundedListLimit(5000, 25, 100)).toBe(100);
        });

        it("floors a page at zero", () => {
            expect(boundedListPage(undefined)).toBe(0);
            expect(boundedListPage("nonsense")).toBe(0);
            expect(boundedListPage(-4)).toBe(0);
            expect(boundedListPage("3")).toBe(3);
            expect(boundedListPage(2.9)).toBe(2);
        });
    });

    it("names exactly the query params the route has to intercept", () => {
        expect([...MESSAGE_LIST_QUERY_PARAMS].sort()).toEqual(["filter", "sortBy", "sortOrder"]);
    });
});
