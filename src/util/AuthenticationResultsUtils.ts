///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** One `method=result` entry from an RFC 8601 `Authentication-Results` header, plus whatever
 * `key.subkey=value` properties followed it (e.g. `header.d`, `header.s`, `header.i`). */
export interface AuthenticationResultEntry {
    method: string;
    result: string;
    properties: Record<string, string>;
}

/**
 * Parses one or more raw RFC 8601 `Authentication-Results` header values into a flat list of method results.
 * Genuinely new territory for this codebase - nothing parses this header today (this app otherwise trusts
 * whatever the upstream MTA hands it, see `BaseMailIngestRoute`'s own doc comment) - needed specifically to
 * gate acceptance of an inbound `RapidMX-Key` header (`util/RapidMxKeyHeaderUtils.ts`) on the MTA having
 * actually verified DKIM, per `specs/end-to-end_encryption.md`'s explicit requirement.
 *
 * Deliberately tolerant, never throws: a header can legitimately appear more than once (once per hop that
 * performed its own authentication checks - `mailparser`/Node's own header handling surfaces repeats as an
 * array, hence the `string[]` input), and the first segment of each value (the `authserv-id`) is skipped
 * since only the `resinfo` method results after it matter here. A value of exactly `none` (no authentication
 * mechanisms were run) or anything unparseable simply contributes no entries rather than failing the caller.
 */
export function parseAuthenticationResults(headerValues: string | string[] | undefined): AuthenticationResultEntry[] {
    if (!headerValues) {
        return [];
    }
    const values: string[] = Array.isArray(headerValues) ? headerValues : [headerValues];
    const entries: AuthenticationResultEntry[] = [];

    for (const raw of values) {
        const segments: string[] = raw
            .split(";")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        // The first segment is the authserv-id, not a method result - skip it unconditionally.
        for (const segment of segments.slice(1)) {
            if (segment.toLowerCase() === "none") {
                continue;
            }
            const tokens: string[] = segment.split(/\s+/);
            // `segment` is non-empty (filtered above), so splitting on whitespace always yields at least one
            // element - `tokens.shift()` can never actually be `undefined` here.
            const methodResult: string = tokens.shift()!;
            const eq: number = methodResult.indexOf("=");
            if (eq < 0) {
                continue;
            }
            const method: string = methodResult.slice(0, eq).toLowerCase();
            const result: string = methodResult.slice(eq + 1).toLowerCase();
            const properties: Record<string, string> = {};
            for (const token of tokens) {
                const propEq: number = token.indexOf("=");
                if (propEq < 0) {
                    continue;
                }
                properties[token.slice(0, propEq).toLowerCase()] = token.slice(propEq + 1).replace(/^"|"$/g, "");
            }
            entries.push({ method, result, properties });
        }
    }
    return entries;
}

/** Reports whether `dkimDomain` aligns with `fromDomain` under DMARC-style "relaxed" alignment - equal, or
 * `dkimDomain` is `fromDomain`'s organizational (parent) domain. Case-insensitive. */
function domainsAlign(dkimDomain: string, fromDomain: string): boolean {
    const a: string = dkimDomain.toLowerCase();
    const b: string = fromDomain.toLowerCase();
    return a === b || b.endsWith(`.${a}`);
}

/**
 * Whether `headerValues` reports at least one `dkim=pass` result whose signing domain (`header.d`) aligns
 * with `fromDomain` - the specific gate `specs/end-to-end_encryption.md` requires before an inbound
 * `RapidMX-Key` header may be acted on: "Receiving servers MUST verify DKIM before acting on the header and
 * MUST treat an unverified header as absent."
 *
 * Fails closed by construction: a missing/unparseable `Authentication-Results` header, a `dkim=fail`/`none`/
 * anything-other-than-`pass` result, or a `pass` for a domain that doesn't align with `fromDomain`, are all
 * indistinguishable from "no verification happened" to this function's caller.
 */
export function hasAlignedPassingDkim(headerValues: string | string[] | undefined, fromDomain: string): boolean {
    return parseAuthenticationResults(headerValues).some(
        (entry) =>
            entry.method === "dkim" &&
            entry.result === "pass" &&
            !!entry.properties["header.d"] &&
            domainsAlign(entry.properties["header.d"], fromDomain),
    );
}
