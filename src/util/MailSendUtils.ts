///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { deriveConversationId } from "./ConversationUtils.js";
import { extractHeader, prependHeaders } from "./MimeHeaderUtils.js";
import { resolveDeliveryVerdict, ScanPipeline } from "../scan/ScanPipeline.js";

/** The outcome of `scanAndRelay()` a caller needs to finish persisting a sent message. */
export interface ScanAndRelayResult {
    /** The raw MIME actually scanned and relayed - identical to the input `raw` unless it had no
     * `Message-ID` header, in which case one was generated and injected (see `messageId` below). A caller
     * that persists `raw` (e.g. `BaseMessageRoute.send()`'s `bodyBlobKey`) must re-store THIS value, not its
     * own original buffer, so a later read - and any future `recall()` of this very message - sees the same
     * header it was actually relayed with. */
    raw: Buffer;

    /** The RFC 5322 `Message-ID` header value `raw` now carries, angle brackets stripped (matching
     * `ScanPipelineResult.messageIdHeader`'s own normalization, so a value stored here compares equal to
     * what every recipient's own ingest pipeline stores on their delivered `Message.messageId`). This is the
     * identifier `BaseMessageRoute.recall()` later targets - see its own doc comment. */
    messageId: string;

    /** Groups this message with the rest of its RFC 5322/2822 thread - see `util/ConversationUtils.ts`'s
     * `deriveConversationId()`, computed from the same scan that already parsed `raw`'s `References`/
     * `In-Reply-To` headers, so this needs no second parse. */
    conversationId: string;

    /** The blob key `scanResult.sanitizedHtml` (if any) was stored under - see the identical reasoning in
     * `ScanQueueJob.processEntry()`'s own doc comment on why this must never be folded into the raw body key. */
    sanitizedHtmlBlobKey?: string;

    /** `true` if the scan pipeline identified this message's body as S/MIME (CMS) encrypted - see
     * `util/SmimeUtils.ts`'s `isEncryptedBody()`. Threaded through so `BaseMessageRoute.send()` can persist
     * it onto the sent `Message`, the same signal `ScanQueueJob` stamps for inbound mail. */
    encrypted: boolean;
}

/**
 * Runs `raw` through `ScanPipeline` and, if it passes, relays it via `mailTransport` - the scan-then-relay core
 * shared by every "send a composed message" entry point in this library (`BaseMessageRoute.send()`'s REST
 * endpoint and the EAS `SendMail`/`SmartForward`/`SmartReply` commands via `sendComposedMime()` below), so this
 * gate is defined exactly once rather than duplicated per protocol.
 *
 * Before scanning, guarantees `raw` carries a real `Message-ID` header - a compose client (webmail/EAS/MAPI)
 * usually sets one, but if it didn't, one is generated and injected here (reusing `MimeHeaderUtils`'s existing
 * header-prepend primitive) rather than leaving each recipient's own ingest pipeline to independently mint an
 * unrelated random one. Every cross-mailbox feature that needs to recognize "the same message" across copies
 * (`recall()` in particular) depends on this identifier actually matching everywhere.
 *
 * Throws `ApiError` (422) if the scan pipeline's verdict is anything other than "deliver", or (502) if the
 * transport itself rejects the message outright - both cases callers should let propagate as the request's
 * own failure, not attempt to recover from.
 */
export async function scanAndRelay(
    raw: Buffer,
    envelopeFrom: string,
    envelopeTo: string[],
    scanPipeline: ScanPipeline,
    mailTransport: any,
    blobStore: BlobStore,
): Promise<ScanAndRelayResult> {
    let finalRaw = raw;
    const existingMessageId = extractHeader(raw, "Message-ID");
    let messageId: string;
    if (existingMessageId) {
        messageId = existingMessageId.replace(/^</, "").replace(/>$/, "");
    } else {
        const domain = envelopeFrom.split("@")[1] || "localhost";
        messageId = `${crypto.randomUUID()}@${domain}`;
        finalRaw = prependHeaders(raw, [{ name: "Message-ID", value: `<${messageId}>` }]);
    }

    const scanResult = await scanPipeline.run(finalRaw, { from: envelopeFrom, to: envelopeTo });
    const verdict = resolveDeliveryVerdict(scanResult);
    if (verdict !== "deliver") {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 422, "This message could not be sent because it failed spam/malware scanning.");
    }

    const transportResult = await mailTransport.send({ raw: finalRaw, envelopeFrom, envelopeTo });
    if (transportResult.accepted.length === 0) {
        throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "The mail transport rejected this message.");
    }

    let sanitizedHtmlBlobKey: string | undefined;
    if (scanResult.sanitizedHtml !== undefined) {
        sanitizedHtmlBlobKey = `sanitized/${crypto.randomUUID()}`;
        await blobStore.put(sanitizedHtmlBlobKey, Buffer.from(scanResult.sanitizedHtml, "utf-8"), { contentType: "text/html" });
    }

    const conversationId = deriveConversationId(scanResult.references, scanResult.inReplyTo, messageId);

    return { raw: finalRaw, messageId, conversationId, sanitizedHtmlBlobKey, encrypted: scanResult.encrypted };
}
