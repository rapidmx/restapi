///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { BlobStore } from "../blob/BlobStore.js";
import { resolveDeliveryVerdict, ScanPipeline } from "../scan/ScanPipeline.js";

/** The outcome of `scanAndRelay()` a caller needs to finish persisting a sent message. */
export interface ScanAndRelayResult {
    /** The blob key `scanResult.sanitizedHtml` (if any) was stored under - see the identical reasoning in
     * `ScanQueueJob.processEntry()`'s own doc comment on why this must never be folded into the raw body key. */
    sanitizedHtmlBlobKey?: string;
}

/**
 * Runs `raw` through `ScanPipeline` and, if it passes, relays it via `mailTransport` - the scan-then-relay core
 * shared by every "send a composed message" entry point in this library (`BaseMessageRoute.send()`'s REST
 * endpoint and the EAS `SendMail`/`SmartForward`/`SmartReply` commands via `sendComposedMime()` below), so this
 * gate is defined exactly once rather than duplicated per protocol.
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
    const scanResult = await scanPipeline.run(raw, { from: envelopeFrom, to: envelopeTo });
    const verdict = resolveDeliveryVerdict(scanResult);
    if (verdict !== "deliver") {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 422, "This message could not be sent because it failed spam/malware scanning.");
    }

    const transportResult = await mailTransport.send({ raw, envelopeFrom, envelopeTo });
    if (transportResult.accepted.length === 0) {
        throw new ApiError(ApiErrors.INTERNAL_ERROR, 502, "The mail transport rejected this message.");
    }

    let sanitizedHtmlBlobKey: string | undefined;
    if (scanResult.sanitizedHtml !== undefined) {
        sanitizedHtmlBlobKey = `sanitized/${crypto.randomUUID()}`;
        await blobStore.put(sanitizedHtmlBlobKey, Buffer.from(scanResult.sanitizedHtml, "utf-8"), { contentType: "text/html" });
    }

    return { sanitizedHtmlBlobKey };
}
