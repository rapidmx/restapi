///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { MailTransport, OutboundMessage, TransportResult } from "./MailTransport.js";

/**
 * Thrown by `sendOrThrow()` when a `MailTransport` reports that it relayed the message to nobody, or rejected
 * any envelope recipient. Every bundled transport reports a relay failure through `TransportResult.rejected`
 * rather than throwing, so a caller that only `await`s `send()` would otherwise treat a failed send as sent.
 */
export class TransportRejectedError extends Error {
    public readonly result: TransportResult | undefined;

    constructor(result: TransportResult | undefined) {
        super(
            `The mail transport did not accept the message (accepted: ${(result?.accepted ?? []).length}, rejected: ${
                (result?.rejected ?? []).length
            }).`,
        );
        this.name = "TransportRejectedError";
        this.result = result;
    }
}

/** `true` when `result` shows at least one accepted recipient and no rejected ones. A missing result (a
 * transport that returns nothing) is treated as not delivered. */
export function isTransportResultDelivered(result: TransportResult | undefined): boolean {
    return !!result && (result.accepted ?? []).length > 0 && (result.rejected ?? []).length === 0;
}

/** Sends `message` through `transport` and throws `TransportRejectedError` unless the result shows it was
 * accepted for every envelope recipient - see `isTransportResultDelivered()`. */
export async function sendOrThrow(transport: MailTransport, message: OutboundMessage): Promise<TransportResult> {
    const result: TransportResult = await transport.send(message);
    if (!isTransportResultDelivered(result)) {
        throw new TransportRejectedError(result);
    }
    return result;
}
