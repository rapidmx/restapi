///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { evaluateMailFilterRules, MailFilterMatchContext, matchesConditions } from "../../src/util/MailFilterUtils.js";
import { MailFilterActionType, MailFilterRule, MessageImportance } from "../../src/models/types.js";

function makeContext(overrides: Partial<MailFilterMatchContext> = {}): MailFilterMatchContext {
    return {
        from: "Jane Doe <jane@example.com>",
        subject: "Weekly Newsletter",
        bodyPreview: "Here is your update.",
        recipientAddresses: ["me@example.com", "team@example.com"],
        hasAttachment: false,
        importance: MessageImportance.NORMAL,
        ...overrides,
    };
}

function makeRule(overrides: Partial<MailFilterRule> = {}): MailFilterRule {
    return {
        uid: "rule-1",
        version: 0,
        dateCreated: new Date(),
        dateModified: new Date(),
        mailboxUid: "mbx-1",
        name: "Test rule",
        enabled: true,
        sequence: 0,
        stopProcessingRules: false,
        conditions: {},
        actions: [],
        ...overrides,
    };
}

describe("matchesConditions() Tests", () => {
    it("Matches everything when conditions are empty.", () => {
        expect(matchesConditions({}, makeContext())).toBe(true);
    });

    it("Matches on fromContains, case-insensitively.", () => {
        expect(matchesConditions({ fromContains: ["JANE@EXAMPLE.COM"] }, makeContext())).toBe(true);
        expect(matchesConditions({ fromContains: ["someoneelse@example.com"] }, makeContext())).toBe(false);
    });

    it("Never matches an explicit empty fromContains array.", () => {
        expect(matchesConditions({ fromContains: [] }, makeContext())).toBe(false);
    });

    it("Matches on subjectContains.", () => {
        expect(matchesConditions({ subjectContains: ["newsletter"] }, makeContext())).toBe(true);
        expect(matchesConditions({ subjectContains: ["invoice"] }, makeContext())).toBe(false);
    });

    it("Matches on bodyContains.", () => {
        expect(matchesConditions({ bodyContains: ["update"] }, makeContext())).toBe(true);
        expect(matchesConditions({ bodyContains: ["invoice"] }, makeContext())).toBe(false);
    });

    it("Matches on toCcContains against recipient addresses (exact, case-insensitive).", () => {
        expect(matchesConditions({ toCcContains: ["TEAM@example.com"] }, makeContext())).toBe(true);
        expect(matchesConditions({ toCcContains: ["nobody@example.com"] }, makeContext())).toBe(false);
    });

    it("Matches on hasAttachment.", () => {
        expect(matchesConditions({ hasAttachment: true }, makeContext({ hasAttachment: true }))).toBe(true);
        expect(matchesConditions({ hasAttachment: true }, makeContext({ hasAttachment: false }))).toBe(false);
        expect(matchesConditions({ hasAttachment: false }, makeContext({ hasAttachment: false }))).toBe(true);
    });

    it("Matches on importance.", () => {
        expect(matchesConditions({ importance: MessageImportance.HIGH }, makeContext({ importance: MessageImportance.HIGH }))).toBe(
            true,
        );
        expect(matchesConditions({ importance: MessageImportance.HIGH }, makeContext({ importance: MessageImportance.NORMAL }))).toBe(
            false,
        );
    });

    it("Requires every populated condition field to match (AND).", () => {
        const conditions = { subjectContains: ["newsletter"], hasAttachment: true };
        expect(matchesConditions(conditions, makeContext({ hasAttachment: false }))).toBe(false);
        expect(matchesConditions(conditions, makeContext({ hasAttachment: true }))).toBe(true);
    });
});

describe("evaluateMailFilterRules() Tests", () => {
    it("Returns an all-false/empty result when no rule matches.", () => {
        const result = evaluateMailFilterRules([makeRule({ conditions: { subjectContains: ["invoice"] } })], makeContext());
        expect(result).toEqual({ copyToFolderUids: [], deleted: false, markRead: false, forwardTo: [] });
    });

    it("Skips disabled rules even if their conditions would match.", () => {
        const rule = makeRule({ enabled: false, actions: [{ type: MailFilterActionType.MARK_AS_READ }] });
        const result = evaluateMailFilterRules([rule], makeContext());
        expect(result.markRead).toBe(false);
    });

    it("Applies MOVE_TO_FOLDER, overwritten by a later matching rule's MOVE_TO_FOLDER.", () => {
        const rules = [
            makeRule({ sequence: 0, actions: [{ type: MailFilterActionType.MOVE_TO_FOLDER, folderUid: "folder-a" }] }),
            makeRule({ sequence: 1, actions: [{ type: MailFilterActionType.MOVE_TO_FOLDER, folderUid: "folder-b" }] }),
        ];
        const result = evaluateMailFilterRules(rules, makeContext());
        expect(result.moveToFolderUid).toBe("folder-b");
    });

    it("Accumulates COPY_TO_FOLDER destinations across rules.", () => {
        const rules = [
            makeRule({ sequence: 0, actions: [{ type: MailFilterActionType.COPY_TO_FOLDER, folderUid: "folder-a" }] }),
            makeRule({ sequence: 1, actions: [{ type: MailFilterActionType.COPY_TO_FOLDER, folderUid: "folder-b" }] }),
        ];
        const result = evaluateMailFilterRules(rules, makeContext());
        expect(result.copyToFolderUids).toEqual(["folder-a", "folder-b"]);
    });

    it("Sets deleted when a matching rule's actions include DELETE.", () => {
        const result = evaluateMailFilterRules([makeRule({ actions: [{ type: MailFilterActionType.DELETE }] })], makeContext());
        expect(result.deleted).toBe(true);
    });

    it("Sets markRead when a matching rule's actions include MARK_AS_READ.", () => {
        const result = evaluateMailFilterRules([makeRule({ actions: [{ type: MailFilterActionType.MARK_AS_READ }] })], makeContext());
        expect(result.markRead).toBe(true);
    });

    it("Accumulates forwardTo addresses across matching rules.", () => {
        const rules = [
            makeRule({ sequence: 0, actions: [{ type: MailFilterActionType.FORWARD, forwardTo: "a@example.com" }] }),
            makeRule({ sequence: 1, actions: [{ type: MailFilterActionType.FORWARD, forwardTo: "b@example.com" }] }),
        ];
        const result = evaluateMailFilterRules(rules, makeContext());
        expect(result.forwardTo).toEqual(["a@example.com", "b@example.com"]);
    });

    it("Evaluates rules in ascending sequence order regardless of array order.", () => {
        const rules = [
            makeRule({ sequence: 5, actions: [{ type: MailFilterActionType.MOVE_TO_FOLDER, folderUid: "later" }] }),
            makeRule({ sequence: 1, actions: [{ type: MailFilterActionType.MOVE_TO_FOLDER, folderUid: "earlier" }] }),
        ];
        const result = evaluateMailFilterRules(rules, makeContext());
        // Ascending sequence means the sequence:5 rule is applied last, so its MOVE wins.
        expect(result.moveToFolderUid).toBe("later");
    });

    it("Stops evaluating further rules once a matching rule has stopProcessingRules: true.", () => {
        const rules = [
            makeRule({ sequence: 0, stopProcessingRules: true, actions: [{ type: MailFilterActionType.MARK_AS_READ }] }),
            makeRule({ sequence: 1, actions: [{ type: MailFilterActionType.DELETE }] }),
        ];
        const result = evaluateMailFilterRules(rules, makeContext());
        expect(result.markRead).toBe(true);
        expect(result.deleted).toBe(false);
    });

    it("A non-matching rule's stopProcessingRules has no effect - later rules still evaluate.", () => {
        const rules = [
            makeRule({ sequence: 0, stopProcessingRules: true, conditions: { subjectContains: ["invoice"] } }),
            makeRule({ sequence: 1, actions: [{ type: MailFilterActionType.MARK_AS_READ }] }),
        ];
        const result = evaluateMailFilterRules(rules, makeContext());
        expect(result.markRead).toBe(true);
    });
});
