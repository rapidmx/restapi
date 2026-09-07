///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** The subset of a parsed inbound message's headers relevant to RFC 3834 auto-reply loop prevention. */
export interface AutoReplyHeaders {
    /** The `Auto-Submitted` header value, if present (e.g. `"auto-replied"`, `"auto-generated"`, `"no"`). */
    autoSubmittedHeader?: string;

    /** The `Precedence` header value, if present (e.g. `"bulk"`, `"list"`, `"junk"`, `"first-class"`). */
    precedenceHeader?: string;
}

const BULK_PRECEDENCE_VALUES = new Set(["bulk", "list", "junk"]);

/**
 * Decides whether an inbound message is eligible to receive an automatic (out-of-office) reply, per RFC 3834's
 * recommendations for automatic responders - this is the real engineering substance of "automatic replies," not
 * just sending a message: without it, replying to a bounce or another auto-responder can trigger a mail loop.
 *
 * Refuses (`false`) when:
 * - `envelopeFrom` is empty (`""`/`<>`, the classic bounce-message return-path - the single most common
 * real-world mail-loop cause).
 * - `headers.autoSubmittedHeader` is present and not `"no"` (RFC 3834's own mechanism for exactly this).
 * - `headers.precedenceHeader` is `"bulk"`, `"list"`, or `"junk"`.
 *
 * Every automatic reply this library sends must itself carry `Auto-Submitted: auto-replied` (the caller's
 * responsibility when composing the reply) - so a correspondent's own auto-responder, or another copy of this
 * same feature, doesn't loop back.
 */
export function isAutoReplyEligible(envelopeFrom: string, headers: AutoReplyHeaders): boolean {
    if (!envelopeFrom || envelopeFrom.trim().length === 0) {
        return false;
    }
    if (headers.autoSubmittedHeader && headers.autoSubmittedHeader.trim().toLowerCase() !== "no") {
        return false;
    }
    if (headers.precedenceHeader && BULK_PRECEDENCE_VALUES.has(headers.precedenceHeader.trim().toLowerCase())) {
        return false;
    }
    return true;
}
