///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MessageClassification } from "../models/types.js";

/**
 * Everything `classifyMessage()` needs to decide whether a newly-delivered message belongs in the Focused
 * or the Other half of the Inbox. Built by `ScanQueueJob.deliverMessage()` from its already-parsed MIME and
 * a small number of lookups - this module performs no I/O of its own, keeping the classification itself a
 * pure function of its arguments (the same split `MailFilterUtils`/`TransportRuleUtils` already use).
 */
export interface FocusedInboxSignals {
    /** The user's explicit `FocusedInboxOverride` for this sender, if one exists. Always wins. */
    override?: MessageClassification;

    /** `true` if the sender's domain is one of this server's own verified `Domain`s - i.e. a colleague
     * rather than an outsider. */
    isInternalSender: boolean;

    /** `true` if this mailbox already has mail in the same conversation, or the sender is in its Contacts -
     * someone the user demonstrably corresponds with. */
    isKnownCorrespondent: boolean;

    /** The message's `List-Unsubscribe` header value, if present - the single strongest bulk-mail indicator,
     * since RFC 8058/2369 only make sense for list traffic. */
    listUnsubscribeHeader?: string;

    /** The message's `Precedence` header value, if present. */
    precedenceHeader?: string;

    /** The message's `Auto-Submitted` header value, if present (RFC 3834). */
    autoSubmittedHeader?: string;

    /** The spam score assigned by `SpamScanProvider`. Only consulted for mail that was NOT junk-routed -
     * junk never reaches `classifyMessage()` at all. */
    spamScore: number;
}

/** `Precedence` values that mark a message as list/bulk traffic rather than personal correspondence. */
const BULK_PRECEDENCE_VALUES: Set<string> = new Set(["bulk", "list", "junk"]);

/**
 * Decides whether `signals` describe mail a person actually wants to see now (Focused) or bulk/automated
 * mail that can wait (Other) - the classification behind Outlook's Focused Inbox, stored on
 * `Message.inferenceClassification`.
 *
 * Precedence, highest first:
 *
 * 1. An explicit `FocusedInboxOverride` for the sender - the user's own choice always wins outright.
 * 2. Bulk/automated indicators (`List-Unsubscribe`, a bulk `Precedence`, or an `Auto-Submitted` other than
 * `no`) -> `OTHER`. Checked *before* the positive signals below, deliberately: an internal company
 * newsletter is still newsletter traffic, and a colleague's actual reply never carries these headers, so
 * nothing a human personally typed is caught by this.
 * 3. An internal sender -> `FOCUSED`.
 * 4. A known correspondent (existing thread, or in Contacts) -> `FOCUSED`.
 * 5. A spam score at or above `otherSpamScoreThreshold` - spammy enough to deprioritize, but under the
 * junk-routing cutoff that would have kept it out of the Inbox entirely -> `OTHER`.
 * 6. Otherwise `FOCUSED` - the safe default. Mail is never hidden on a guess; Other is only ever chosen on
 * a positive signal.
 */
export function classifyMessage(signals: FocusedInboxSignals, otherSpamScoreThreshold: number): MessageClassification {
    if (signals.override !== undefined) {
        return signals.override;
    }
    if (isBulkOrAutomated(signals)) {
        return MessageClassification.OTHER;
    }
    if (signals.isInternalSender || signals.isKnownCorrespondent) {
        return MessageClassification.FOCUSED;
    }
    if (signals.spamScore >= otherSpamScoreThreshold) {
        return MessageClassification.OTHER;
    }
    return MessageClassification.FOCUSED;
}

/** Whether any of the three RFC header signals mark this message as list/bulk/automated traffic. */
function isBulkOrAutomated(signals: FocusedInboxSignals): boolean {
    if (signals.listUnsubscribeHeader) {
        return true;
    }
    if (signals.precedenceHeader && BULK_PRECEDENCE_VALUES.has(signals.precedenceHeader.trim().toLowerCase())) {
        return true;
    }
    // RFC 3834: `Auto-Submitted: no` is the explicit "a human sent this" value; anything else present
    // (`auto-generated`, `auto-replied`, ...) means it came from software.
    return !!signals.autoSubmittedHeader && signals.autoSubmittedHeader.trim().toLowerCase() !== "no";
}
