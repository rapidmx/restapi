///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** One `method=result` entry from an RFC 8601 `Authentication-Results` header, plus whatever
 * `key.subkey=value` properties followed it (e.g. `header.d`, `header.s`, `header.i`). */
export interface AuthenticationResultEntry {
    /** The `authserv-id` (first segment) of the header value this entry came from, lowercased - the identity
     * of the hop that claims to have performed this authentication check. MUST be checked by the caller
     * against a configured trusted value before this entry is acted on; see `hasAlignedPassingDkim()`. */
    authservId: string;
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
 * The header field itself carries no authentication of its own - RFC 8601 §5 places the entire burden of
 * trustworthiness on the receiving MTA deleting any instance of this header already present on the message
 * (which could have been forged by the remote sender) before adding its own, and on downstream consumers
 * checking the `authserv-id` against the value that trusted hop is known to stamp. This function surfaces
 * `authservId` on every returned entry specifically so `hasAlignedPassingDkim()` can enforce that second half;
 * this module cannot enforce the first half (header stripping happens upstream, at the MTA), which is why
 * `BaseMailIngestRoute`'s ingest contract documents it as a deployment requirement (see its own doc comment).
 *
 * Deliberately tolerant, never throws: a header can legitimately appear more than once (once per hop that
 * performed its own authentication checks - `mailparser`/Node's own header handling surfaces repeats as an
 * array, hence the `string[]` input). A value of exactly `none` (no authentication mechanisms were run) or
 * anything unparseable simply contributes no entries rather than failing the caller.
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
        if (segments.length === 0) {
            continue;
        }
        // The first segment is the authserv-id - captured (not skipped) so each entry can be checked against
        // a configured trusted value below.
        const authservId: string = segments[0].split(/\s+/)[0].toLowerCase();
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
            entries.push({ authservId, method, result, properties });
        }
    }
    return entries;
}

/** Reports whether `dkimDomain` aligns with `fromDomain`. Case-insensitive, and deliberately **strict**
 * (exact match) rather than DMARC-style "relaxed" (organizational-domain) alignment: relaxed alignment
 * requires a public-suffix list to compute the organizational domain correctly, and this codebase has no such
 * dependency. A naive `fromDomain.endsWith("." + dkimDomain)` approximation is actively unsafe on shared-suffix
 * hosting domains (e.g. any two tenants of `*.blob.core.windows.net` would "align" with each other), so strict
 * equality is used instead - it rejects some legitimate relaxed-alignment cases (e.g. `d=example.com` signing
 * mail `From: bounce.example.com`) in exchange for never producing a false positive. */
function domainsAlign(dkimDomain: string, fromDomain: string): boolean {
    return dkimDomain.toLowerCase() === fromDomain.toLowerCase();
}

/**
 * Whether `headerValues` reports at least one `dkim=pass` result - from an entry whose `authserv-id` matches
 * `trustedAuthservId` - whose signing domain (`header.d`) aligns with `fromDomain`. This is the specific gate
 * `specs/end-to-end_encryption.md` requires before an inbound `RapidMX-Key` header may be acted on: "Receiving
 * servers MUST verify DKIM before acting on the header and MUST treat an unverified header as absent."
 *
 * The `authserv-id` check is not optional. Without it, this function would trust *any* `Authentication-Results`
 * header found on the message - including one the remote sender forged themselves, since nothing upstream of
 * this function strips a pre-existing instance of the header before this deployment's own trusted MTA hop adds
 * its own (RFC 8601 §5 places that responsibility on the MTA/milter configuration, not on this code). Matching
 * `authserv-id` narrows trust to entries claiming to be that specific configured hop; the deployment's MTA MUST
 * still be configured to delete any inbound `Authentication-Results` header bearing this same `authserv-id`
 * before stamping its own, or a sender could simply forge that identity string too.
 *
 * An empty/unconfigured `trustedAuthservId` fails closed (returns `false` unconditionally) rather than falling
 * back to trusting every entry - a missing configuration value must never silently widen trust.
 *
 * Fails closed by construction otherwise: a missing/unparseable `Authentication-Results` header, a
 * `dkim=fail`/`none`/anything-other-than-`pass` result, an entry from an unrecognized `authserv-id`, or a
 * `pass` for a domain that doesn't align with `fromDomain`, are all indistinguishable from "no verification
 * happened" to this function's caller.
 */
export function hasAlignedPassingDkim(
    headerValues: string | string[] | undefined,
    fromDomain: string,
    trustedAuthservId: string,
): boolean {
    if (!trustedAuthservId) {
        return false;
    }
    const trusted: string = trustedAuthservId.toLowerCase();
    return parseAuthenticationResults(headerValues).some(
        (entry) =>
            entry.authservId === trusted &&
            entry.method === "dkim" &&
            entry.result === "pass" &&
            !!entry.properties["header.d"] &&
            domainsAlign(entry.properties["header.d"], fromDomain),
    );
}
