///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DistributionList } from "../models/types.js";
import { rebuildDroppingReplyTo } from "./MimeHeaderUtils.js";

/**
 * Produces a copy of `raw` rewritten for distribution-list delivery: any existing `Reply-To` header (and its
 * folded continuation lines) is dropped, then `Reply-To`, `List-Id` (RFC 2919), and a mailto-based
 * `List-Unsubscribe` (RFC 2369) are prepended - headers are order-independent, so prepending is safe. Applied
 * once per list match and shared by both the internal blob copy and every external relay copy - see
 * `BaseMailIngestRoute.deliver()`.
 */
export function rewriteHeadersForList(raw: Buffer, list: DistributionList): Buffer {
    // Defensive against header injection via an admin-controlled field ending up in a header value.
    const safeName: string = list.name.replace(/[\r\n]/g, "");
    const address: string = list.primarySmtpAddress.replace(/[\r\n]/g, "");
    const listIdHost: string = address.includes("@") ? address.replace("@", ".") : address;

    const newHeaders: string[] = [
        `Reply-To: ${address}`,
        `List-Id: ${safeName} <${listIdHost}>`,
        `List-Unsubscribe: <mailto:${address}?subject=unsubscribe>`,
    ];

    return rebuildDroppingReplyTo(raw, newHeaders);
}
