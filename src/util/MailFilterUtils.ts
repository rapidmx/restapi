///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailFilterAction, MailFilterActionType, MailFilterConditions, MailFilterRule, MessageImportance } from "../models/types.js";

/** The fields of a newly-delivered message `matchesConditions()`/`evaluateMailFilterRules()` need to evaluate a
 * `MailFilterRule` against - built from `ScanQueueJob`'s already-parsed MIME, not from a persisted `Message`
 * (rules run before the `Message` row exists). */
export interface MailFilterMatchContext {
    /** The message's From address, optionally combined with its display name (e.g. `"Jane Doe <jane@x.com>"`). */
    from: string;

    subject: string;

    bodyPreview: string;

    /** The To/Cc recipient addresses (case-insensitive exact match against `MailFilterConditions.toCcContains`). */
    recipientAddresses: string[];

    hasAttachment: boolean;

    importance: MessageImportance;
}

/** The outcome of folding every matching rule's actions together, for `ScanQueueJob` to apply. */
export interface MailFilterEvaluationResult {
    /** Set by the last matching `MOVE_TO_FOLDER` action across all evaluated rules - overrides the default
     * (Inbox) filing destination entirely when set. */
    moveToFolderUid?: string;

    /** One entry per matching `COPY_TO_FOLDER` action - an additional copy of the message is filed into each of
     * these folders, alongside wherever it's otherwise filed (Inbox, or `moveToFolderUid` if also set). */
    copyToFolderUids: string[];

    /** `true` if any matching rule's actions included `DELETE` - the message is discarded outright rather than
     * filed at its primary destination. Any `copyToFolderUids` copies are still created (a `DELETE` action only
     * removes the primary delivery, not copies an earlier/later action in the same rule set explicitly asked for). */
    deleted: boolean;

    /** `true` if any matching rule's actions included `MARK_AS_READ`. */
    markRead: boolean;

    /** One entry per matching `FORWARD` action's `forwardTo` address. */
    forwardTo: string[];
}

function containsAnyIgnoreCase(haystack: string, needles?: string[]): boolean {
    if (!needles || needles.length === 0) {
        return false;
    }
    const lower = haystack.toLowerCase();
    return needles.some((needle) => lower.includes(needle.toLowerCase()));
}

/**
 * Evaluates a single `MailFilterRule`'s `MailFilterConditions` against `context`. Every populated condition
 * field must match (AND); a field holding an array of strings is itself OR-matched against its entries.
 */
export function matchesConditions(conditions: MailFilterConditions, context: MailFilterMatchContext): boolean {
    if (conditions.fromContains && !containsAnyIgnoreCase(context.from, conditions.fromContains)) {
        return false;
    }
    if (conditions.subjectContains && !containsAnyIgnoreCase(context.subject, conditions.subjectContains)) {
        return false;
    }
    if (conditions.bodyContains && !containsAnyIgnoreCase(context.bodyPreview, conditions.bodyContains)) {
        return false;
    }
    if (conditions.toCcContains && conditions.toCcContains.length > 0) {
        const lowerRecipients = context.recipientAddresses.map((address) => address.toLowerCase());
        const matched = conditions.toCcContains.some((needle) => lowerRecipients.includes(needle.toLowerCase()));
        if (!matched) {
            return false;
        }
    }
    if (conditions.hasAttachment !== undefined && conditions.hasAttachment !== context.hasAttachment) {
        return false;
    }
    if (conditions.importance !== undefined && conditions.importance !== context.importance) {
        return false;
    }
    return true;
}

function applyAction(result: MailFilterEvaluationResult, action: MailFilterAction): void {
    switch (action.type) {
        case MailFilterActionType.MOVE_TO_FOLDER:
            if (action.folderUid) {
                result.moveToFolderUid = action.folderUid;
            }
            break;
        case MailFilterActionType.COPY_TO_FOLDER:
            if (action.folderUid) {
                result.copyToFolderUids.push(action.folderUid);
            }
            break;
        case MailFilterActionType.DELETE:
            result.deleted = true;
            break;
        case MailFilterActionType.MARK_AS_READ:
            result.markRead = true;
            break;
        case MailFilterActionType.FORWARD:
            if (action.forwardTo) {
                result.forwardTo.push(action.forwardTo);
            }
            break;
    }
}

/**
 * Evaluates `rules` (only those with `enabled: true`, in ascending `sequence` order) against `context`, folding
 * every matching rule's actions into a single combined result. Stops evaluating further rules once a matching
 * rule has `stopProcessingRules: true` (mirrors the Rules Wizard's "stop processing more rules" checkbox).
 */
export function evaluateMailFilterRules(rules: MailFilterRule[], context: MailFilterMatchContext): MailFilterEvaluationResult {
    const result: MailFilterEvaluationResult = { copyToFolderUids: [], deleted: false, markRead: false, forwardTo: [] };

    const sorted = rules.filter((rule) => rule.enabled).sort((a, b) => a.sequence - b.sequence);
    for (const rule of sorted) {
        if (!matchesConditions(rule.conditions, context)) {
            continue;
        }
        for (const action of rule.actions) {
            applyAction(result, action);
        }
        if (rule.stopProcessingRules) {
            break;
        }
    }

    return result;
}
