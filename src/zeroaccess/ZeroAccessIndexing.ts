///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { type Recipient, RecipientType, type ZeroAccessIndexDocument } from "../models/types.js";

/** One attachment of a message being indexed. */
export interface IndexableAttachment {
    filename?: string;
    contentType: string;
    content: Buffer;
}

/** What `buildIndexDocument()` indexes - the plaintext a delivery holds, before it is encrypted and discarded. */
export interface IndexDocumentInput {
    messageUid: string;
    subject: string;
    bodyText: string;
    fromAddress: string;
    fromDisplayName?: string;
    recipients: Recipient[];
    attachments: IndexableAttachment[];
    dateForSort: Date;
}

/** Extracts an attachment's text, or `undefined` when there is no extractor for it (`ExtractorRegistry.extract()`). */
export type AttachmentTextExtractor = (mimeType: string, content: Buffer) => Promise<string | undefined>;

/** Bounds on the extraction `buildIndexDocument()` does while a delivery waits (`specs/search.md` §9). */
export interface IndexExtractionLimits {
    /** Total time every attachment's extraction may take together, in ms. What doesn't finish in time is deferred. */
    budgetMs: number;
    /** An attachment larger than this, in bytes, is not extracted on the server at all - it is deferred. */
    maxAttachmentBytes: number;
}

/** Marks a budget that ran out before an extraction finished. */
const TIMED_OUT: unique symbol = Symbol("timed out");

/**
 * The index document for one zero-access message (`ZeroAccessIndexDocument`), extracting attachment text within `limits`:
 * the server indexes what it can while it legitimately holds the plaintext, and names the rest in `deferredAttachments` for a
 * client to extract after decrypting (`specs/search.md` §9) - never a plaintext spool to extract from later. An attachment
 * with no extractor isn't deferred: like today, it is findable by name only.
 */
export async function buildIndexDocument(
    input: IndexDocumentInput,
    extract: AttachmentTextExtractor,
    limits: IndexExtractionLimits,
): Promise<ZeroAccessIndexDocument> {
    const attachmentText: string[] = [];
    const deferredAttachments: string[] = [];
    const deadline: number = Date.now() + limits.budgetMs;
    for (const attachment of input.attachments) {
        const name: string = attachment.filename ?? "";
        const remaining: number = deadline - Date.now();
        if (attachment.content.length > limits.maxAttachmentBytes || remaining <= 0) {
            deferredAttachments.push(name);
            continue;
        }
        let timer: NodeJS.Timeout | undefined;
        const outcome: string | undefined | typeof TIMED_OUT = await Promise.race([
            extract(attachment.contentType.split(";")[0].trim().toLowerCase(), attachment.content),
            new Promise<typeof TIMED_OUT>((resolve) => {
                timer = setTimeout(() => resolve(TIMED_OUT), remaining);
            }),
        ]).finally(() => clearTimeout(timer));
        if (outcome === TIMED_OUT) {
            deferredAttachments.push(name);
        } else if (outcome) {
            attachmentText.push(outcome);
        }
    }

    const addresses = (type: RecipientType): string[] => input.recipients.filter((r) => r.type === type).map((r) => r.address);
    const participants: string[] = [
        input.fromAddress,
        ...(input.fromDisplayName ? [input.fromDisplayName] : []),
        ...input.recipients.flatMap((r) => (r.displayName ? [r.address, r.displayName] : [r.address])),
    ].filter((value) => value.length > 0);

    return {
        v: 1,
        messageUid: input.messageUid,
        subject: input.subject,
        body: input.bodyText,
        attachmentText,
        attachmentNames: input.attachments.map((a) => a.filename ?? "").filter((name) => name.length > 0),
        deferredAttachments: deferredAttachments.filter((name) => name.length > 0),
        from: input.fromAddress,
        to: addresses(RecipientType.TO),
        cc: addresses(RecipientType.CC),
        participants,
        dateForSort: input.dateForSort.getTime(),
    };
}
