///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { DistributionList } from "../models/types.js";
import { rebuildDroppingReplyTo, singleLineHeaderValue } from "./MimeHeaderUtils.js";

/**
 * Produces a copy of `raw` rewritten for distribution-list delivery: any existing `Reply-To` header (and its
 * folded continuation lines) is dropped, then `Reply-To`, `List-Id` (RFC 2919), and a mailto-based
 * `List-Unsubscribe` (RFC 2369) are prepended - headers are order-independent, so prepending is safe. Applied
 * once per list match and shared by both the internal blob copy and every external relay copy - see
 * `BaseMailIngestRoute.deliver()`.
 */
export function rewriteHeadersForList(raw: Buffer, list: DistributionList): Buffer {
    // Defensive against header injection via an admin-controlled field ending up in a header value: the address keeps only
    // visible ASCII (and no angle brackets), the name is an RFC 2047 encoded word when it isn't plain printable ASCII.
    const trimmedName: string = singleLineHeaderValue(list.name).trim();
    // A plain ASCII name made only of atom characters (RFC 5322) and spaces goes out as it is; one with a special (`<`, `>`, `"`, `(`,
    // `,` ...) as a quoted string, so the phrase stays a phrase in front of the `<list-id>`.
    const safeName: string = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~.]*$/.test(trimmedName)
        ? trimmedName
        : /^[\x20-\x7E]*$/.test(trimmedName)
          ? `"${trimmedName.replace(/["\\]/g, "\\$&")}"`
          : `=?UTF-8?B?${Buffer.from(trimmedName, "utf8").toString("base64")}?=`;
    const address: string = list.primarySmtpAddress.replace(/[^\x21-\x7E]|[<>]/g, "");
    const listIdHost: string = address.includes("@") ? address.replace("@", ".") : address;

    const newHeaders: string[] = [
        `Reply-To: ${address}`,
        `List-Id: ${safeName} <${listIdHost}>`,
        `List-Unsubscribe: <mailto:${address}?subject=unsubscribe>`,
    ];

    return rebuildDroppingReplyTo(raw, newHeaders);
}
