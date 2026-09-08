///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Normalizes an email address for use as both a lookup key and (for `Mailbox`/`DistributionList`) an entity's
 * own `uid` - trims surrounding whitespace and lowercases the whole address, matching the normalization already
 * applied to an inbound `RCPT TO` value in `BaseMailIngestRoute`.
 */
export function normalizeAddress(address: string): string {
    return address.trim().toLowerCase();
}
