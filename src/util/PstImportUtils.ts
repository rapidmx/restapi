///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import MimeNode from "nodemailer/lib/mime-node/index.js";
import { PSTAttachment, PSTFile, PSTFolder, PSTMessage } from "pst-extractor";

/**
 * Reads a Microsoft Outlook PST file (via the free, actively-maintained `pst-extractor` dependency - see
 * `util/MboxUtils.ts`'s own doc comment for why PST *export* isn't built, while PST *import* is) and
 * reconstructs each mail item it contains as a raw RFC 5322 message buffer - the same shape
 * `util/MboxUtils.ts`'s `parseMbox()` produces for an Mbox source, so `MailboxImportJob` can feed either
 * format's output through the identical `ScanPipeline`-based persistence step.
 *
 * PST stores a message's body/attachments as separate structured properties, not as an already-assembled
 * MIME byte stream (unlike Mbox, which preserves the original wire bytes verbatim) - so this is a
 * reconstruction, built via `nodemailer`'s `MimeNode` (the same lower-level builder `util/ReceiptUtils.ts`'s
 * `buildDispositionNotification()` already uses for the identical "build a Buffer from structured parts"
 * need). A reconstructed message cannot be byte-identical to whatever originally created it - accepted, the
 * same class of "good enough, not perfect" tradeoff `MboxUtils.ts`'s own mboxo escaping already documents.
 *
 * PST's own folder hierarchy is deliberately NOT recreated - see `MailboxImportRequest.targetFolderUid`'s
 * own doc comment; every extracted item lands in the one folder the import request named. Only genuine mail
 * items (`messageClass` starting with `IPM.Note`) are extracted - a PST can also hold calendar/contact/task/
 * sticky-note items stored as MAPI objects with no meaningful "raw email" representation at all; importing
 * those is a fast-follow (real per-type import, not a mis-shapen `Message` row) if ever needed.
 */
export async function extractPstMessages(pstBuffer: Buffer): Promise<Buffer[]> {
    const pstFile = new PSTFile(pstBuffer);
    const messages: PSTMessage[] = [];
    collectMailItems(pstFile.getRootFolder(), messages);

    const raw: Buffer[] = [];
    for (const message of messages) {
        // An attachment can never legitimately be larger than the PST file containing it - bounding
        // `readAttachmentContent()`'s allocation by this file's own size is what keeps a corrupted or
        // maliciously crafted `filesize` property from driving an unbounded `Buffer.alloc()`.
        raw.push(await buildRawMimeFromPstMessage(message, pstBuffer.length));
    }
    return raw;
}

/** Recursively walks every folder in the PST (its hierarchy is discarded - see this module's own doc
 * comment), collecting every `IPM.Note`-classed item regardless of which folder it was found in.
 * Exported (alongside `readAttachmentContent()`/`buildRawMimeFromPstMessage()` below) purely so a unit
 * test can exercise its non-mail-item skip branch directly against a hand-built fake `PSTFolder`/
 * `PSTMessage` - the real `pst-extractor` fixture this module's own integration test uses happens to
 * contain only genuine `IPM.Note` mail items, so that branch is otherwise unreachable from real data. */
export function collectMailItems(folder: PSTFolder, out: PSTMessage[]): void {
    if (folder.hasSubfolders) {
        for (const child of folder.getSubFolders()) {
            collectMailItems(child, out);
        }
    }
    if (folder.contentCount > 0) {
        let item: PSTMessage | null = folder.getNextChild();
        while (item != null) {
            if (item.messageClass.startsWith("IPM.Note")) {
                out.push(item);
            }
            item = folder.getNextChild();
        }
    }
}

/** Reads one attachment's binary content in full - `PSTNodeInputStream.readCompletely()` needs a
 * pre-sized destination buffer (`filesize`), unlike a Node stream's own chunked `read()`. Exported for the
 * same reason as `collectMailItems()` above - the real fixture's every attachment has a readable stream. */
export function readAttachmentContent(attachment: PSTAttachment, maxSize: number = Infinity): Buffer | undefined {
    const stream = attachment.fileInputStream;
    if (!stream) {
        // An attachment with no readable content stream (e.g. an OLE-embedded object PST stores in a form
        // this library has no use for) - skipped rather than persisted as a zero-byte attachment.
        return undefined;
    }
    if (attachment.filesize > maxSize) {
        // `filesize` is a PST property, not a value this code has independently verified - a corrupted or
        // maliciously crafted PST could claim an arbitrarily large one, driving an unbounded
        // `Buffer.alloc()` below. An attachment can never legitimately be larger than the PST file that
        // contains it, so `maxSize` (the caller's own file size) is a hard, always-true ceiling. Skipped
        // the same way an unreadable stream is, rather than trusting an unverified size enough to
        // pre-allocate from it.
        return undefined;
    }
    const content = Buffer.alloc(attachment.filesize);
    stream.readCompletely(content);
    return content;
}

/** Builds one raw RFC 5322 message buffer from a `PSTMessage`'s structured properties - HTML body
 * preferred over plain text (falling back to plain text only when no HTML part exists, matching this
 * library's own `sanitizedHtml`-preferred rendering convention elsewhere), both included via
 * `multipart/alternative` when the item has both. Exported for the same reason as `collectMailItems()`
 * above - lets a unit test assert on one message's exact reconstructed headers/body without needing to
 * also exercise the folder-walking/attachment-reading logic around it. */
export function buildRawMimeFromPstMessage(message: PSTMessage, maxAttachmentSize: number = Infinity): Promise<Buffer> {
    const hasHtml = !!message.bodyHTML;
    const hasPlain = !!message.body;

    let bodyNode: MimeNode;
    if (hasHtml && hasPlain) {
        bodyNode = new MimeNode("multipart/alternative");
        bodyNode.createChild("text/plain").setContent(message.body);
        bodyNode.createChild("text/html").setContent(message.bodyHTML);
    } else if (hasHtml) {
        bodyNode = new MimeNode("text/html").setContent(message.bodyHTML);
    } else {
        bodyNode = new MimeNode("text/plain").setContent(message.body);
    }

    let root: MimeNode;
    if (message.hasAttachments) {
        root = new MimeNode("multipart/mixed");
        root.appendChild(bodyNode);
        for (let i = 0; i < message.numberOfAttachments; i++) {
            const attachment: PSTAttachment = message.getAttachment(i);
            const content: Buffer | undefined = readAttachmentContent(attachment, maxAttachmentSize);
            if (!content) {
                continue;
            }
            root.createChild(attachment.mimeTag || undefined, {
                filename: attachment.longFilename || attachment.filename || "attachment",
            }).setContent(content);
        }
    } else {
        root = bodyNode;
    }

    root.setHeader("Subject", message.subject);
    // `MimeNode`'s own `From`/`To`/`Cc` header encoder parses the value as an RFC 5322 address list and
    // silently DROPS the whole header if nothing address-shaped comes out the other end (confirmed via a
    // throwaway script, not assumed - the same verify-before-relying-on-it discipline `util/ReceiptUtils.ts`
    // documents for its own `nodemailer` usage) - a real risk here, not a hypothetical: PST items this old
    // (this module's own real test fixture is 2001-era Enron mail) often carry a proprietary Exchange
    // directory name with no `@` at all as `senderEmailAddress` (e.g. `"Lokay"`), which is not
    // address-shaped and would otherwise vanish entirely rather than degrade gracefully. A synthetic-but-
    // syntactically-valid `@import.invalid` address is fabricated whenever the PST's own value isn't
    // already one, so the sender identity - the actual compliance-relevant fact - always survives into the
    // reconstructed header.
    const senderAddress: string =
        message.senderEmailAddress && message.senderEmailAddress.includes("@")
            ? message.senderEmailAddress
            : `${(message.senderName || message.senderEmailAddress || "unknown").replace(/[^a-zA-Z0-9.]+/g, ".").replace(/^\.+|\.+$/g, "") || "unknown"}@import.invalid`;
    const senderDisplayName: string = message.senderName.replace(/"/g, "");
    root.setHeader("From", senderDisplayName ? `"${senderDisplayName}" <${senderAddress}>` : senderAddress);
    if (message.displayTo) {
        root.setHeader("To", message.displayTo);
    }
    if (message.displayCC) {
        root.setHeader("Cc", message.displayCC);
    }
    const sentDate: Date = message.clientSubmitTime ?? message.messageDeliveryTime ?? new Date();
    root.setHeader("Date", sentDate.toUTCString());
    // Preserved when the PST retained it (mail actually received over SMTP always carries one) so a
    // re-imported message keeps deduplicating/threading against its original identity - see
    // `Message.messageId`'s own doc comment. Left for `ScanPipeline`/`mailparser` to mint one from scratch
    // (as it already does for any message with no header at all) when the PST has none, e.g. a message
    // composed and saved locally in Outlook but never actually sent.
    if (message.internetMessageId) {
        root.setHeader("Message-ID", message.internetMessageId);
    }

    return new Promise<Buffer>((resolve, reject) => {
        root.build((err: Error | null, output: Buffer) => {
            /* v8 ignore next 3 -- unreachable in practice: `MimeNode.build()` fails only for a stream source
               it can't read - every part built here is set via `setContent()` with a plain string/Buffer,
               never a stream. Same unreachable callback-to-promise error path `util/ReceiptUtils.ts`'s
               `buildDispositionNotification()` already documents identically. */
            if (err) {
                reject(err);
            } else {
                resolve(output);
            }
        });
    });
}
