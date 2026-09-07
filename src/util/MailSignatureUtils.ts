///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { MailSignature } from "../models/types.js";

/** Which compose context a signature is being resolved for - matches OWA's separate "New messages" and
 * "Replies/forwards" signature selectors. */
export type MailSignatureContext = "new" | "reply_forward";

/**
 * Picks the `MailSignature` a composing client (webmail compose, EAS `SendMail`/`SmartReply`/`SmartForward`,
 * MAPI's submit handler) should use for `context`, out of a mailbox's full list of signatures. This library does
 * not compose message bodies itself (see `MailSignature`'s own doc comment), so inserting the resolved
 * signature's `contentHtml` into a drafted message is each caller's own responsibility - this function only
 * centralizes "which one applies" so that isn't reimplemented per client.
 *
 * Returns `undefined` if no signature in `signatures` is marked as the default for `context`.
 */
export function resolveDefaultSignature(signatures: MailSignature[], context: MailSignatureContext): MailSignature | undefined {
    const flag: keyof MailSignature = context === "new" ? "isDefaultForNewMessages" : "isDefaultForReplyForward";
    return signatures.find((signature) => signature[flag]);
}
