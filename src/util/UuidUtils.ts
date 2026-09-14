///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";

/** The namespace `nameBasedUuid()` uses when none is given (an arbitrary, fixed UUID). */
export const RAPIDMX_UUID_NAMESPACE = "6f6f3a52-2b0c-4d5e-9a0b-6d61696c666c";

/**
 * A name-based (RFC 4122 version 5, SHA-1) UUID of `name` within `namespace` - the same `name` always yields the
 * same uid. Used where two attempts at creating "the same" row must collide on the uid's unique index instead of
 * producing two rows (a well-known folder created by two replicas at once, a message re-delivered after a crash).
 */
export function nameBasedUuid(name: string, namespace: string = RAPIDMX_UUID_NAMESPACE): string {
    const namespaceBytes: Buffer = Buffer.from(namespace.replace(/-/g, ""), "hex");
    const bytes: Buffer = crypto.createHash("sha1").update(namespaceBytes).update(name).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex: string = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
