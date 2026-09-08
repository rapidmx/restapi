///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Derives the stable identifier (`Message.conversationId`) that groups a message with the rest of its
 * RFC 5322/2822 thread: the thread's root `Message-ID` is the oldest ancestor named in `references`
 * (RFC 5322 lists them oldest-first), falling back to `inReplyTo` (a client that sets only `In-Reply-To`,
 * not the full `References` chain), falling back to the message's own `messageId` when it has neither -
 * it starts a new conversation. Pure and side-effect-free so both the ingest path
 * (`ScanQueueJob.deliverMessage()`) and the send path (`MailSendUtils.scanAndRelay()`) can share it.
 */
export function deriveConversationId(references: string[], inReplyTo: string | undefined, messageId: string): string {
    return references[0] ?? inReplyTo ?? messageId;
}
