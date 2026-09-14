///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AuthenticationResultEntry, parseAuthenticationResults } from "./AuthenticationResultsUtils.js";

/**
 * DKIM "oversigning" checks (RFC 6376 §5.4.2 / §8.15) for security-sensitive headers that are only safe to act
 * on when a replayer can't *add* them to an otherwise genuinely signed message.
 *
 * A DKIM signature only covers the header instances its `h=` tag names. A verifier matches `h=` entries against
 * a header's instances bottom-up, and an `h=` entry with no instance left to match signs the *absence* of any
 * further instance. So a signature whose `h=` lists a header name **strictly more times** than the header appears
 * in the message makes any appended instance break verification - while a signature that lists it exactly as
 * often (or not at all) still verifies after an attacker appends one more. Without that property, anyone holding
 * a single genuinely DKIM-signed message from a domain (e.g. a newsletter) could add a `RapidMX-Key` or
 * `X-RapidMX-Recall-Of` header to it and replay it: `Authentication-Results` would still say `dkim=pass`.
 *
 * This module never verifies a signature cryptographically - that's the trusted MTA hop's job (see
 * `util/AuthenticationResultsUtils.ts`). It ties each `DKIM-Signature` header back to a trusted, passing
 * `Authentication-Results` `dkim` entry instead:
 *
 * - When the entry carries RFC 6008's `header.b` (a prefix of the signature's `b=` value), it identifies exactly one
 * signature; a prefix matching more than one signature is ambiguous and matches none.
 * - When it doesn't (many MTAs only stamp `header.d`), a signature for domain `d` counts as verified only when the
 * trusted hop reported exactly as many passing entries without `header.b` for `d` as the message carries
 * `DKIM-Signature` headers for `d` - i.e. every signature for that domain passed, so an extra, forged signature
 * claiming the same `d=` (which would fail verification) can't be the one providing the oversigning. Only the
 * topmost trusted `Authentication-Results` instance counts (`topmostTrustedAuthenticationResults()`), so a second,
 * older trusted instance (a re-ingested copy) can't double the pass count.
 *
 * Alignment is deliberately **strict** (exact, case-insensitive domain equality), matching
 * `AuthenticationResultsUtils.hasAlignedPassingDkim()` - see its `domainsAlign()` for why relaxed
 * (organizational-domain) alignment isn't attempted without a public-suffix list.
 *
 * @author Jean-Philippe Steinmetz
 */

/** One parsed `DKIM-Signature` header - only the tags the oversigning check needs. */
export interface ParsedDkimSignature {
    /** Every tag, name lowercased, value with all folding/whitespace removed. */
    tags: Record<string, string>;
    /** The `d=` signing domain, lowercased, without a trailing dot. */
    domain: string;
    /** The `h=` signed header field names, lowercased, in order (repeats preserved). */
    signedHeaders: string[];
    /** The `b=` signature value, whitespace removed. */
    signature: string;
}

/**
 * Parses one `DKIM-Signature` header value (RFC 6376 §3.2 tag-list: `tag=value` pairs separated by `;`, with
 * folding whitespace allowed around tags and inside values). Returns `undefined` for anything unusable: a
 * duplicate tag (RFC 6376 §3.2 makes the whole tag-list invalid), a tag without `=`, a `v=` other than `1`, or
 * a missing/empty `d=`, `h=` or `b=`.
 */
export function parseDkimSignature(value: string): ParsedDkimSignature | undefined {
    const tags: Record<string, string> = {};
    for (const part of value.split(";")) {
        if (part.trim().length === 0) {
            continue;
        }
        const eq: number = part.indexOf("=");
        if (eq < 0) {
            return undefined;
        }
        const name: string = part.slice(0, eq).trim().toLowerCase();
        if (!name || Object.prototype.hasOwnProperty.call(tags, name)) {
            return undefined;
        }
        tags[name] = part.slice(eq + 1).replace(/\s+/g, "");
    }
    if (tags.v !== undefined && tags.v !== "1") {
        return undefined;
    }
    const domain: string = (tags.d ?? "").toLowerCase().replace(/\.$/, "");
    const signedHeaders: string[] = (tags.h ?? "")
        .split(":")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0);
    const signature: string = tags.b ?? "";
    if (!domain || signedHeaders.length === 0 || !signature) {
        return undefined;
    }
    return { tags, domain, signedHeaders, signature };
}

/** The raw message's top-level header block, unfolded into logical lines. */
function logicalHeaderLines(raw: Buffer): string[] {
    const text: string = raw.toString("binary");
    const match: RegExpMatchArray | null = text.match(/\r\n\r\n|\n\n/);
    const headerText: string = match && match.index !== undefined ? text.slice(0, match.index) : text;
    const logical: string[] = [];
    for (const line of headerText.split(/\r\n|\n/)) {
        if (/^[ \t]/.test(line) && logical.length > 0) {
            logical[logical.length - 1] += " " + line.trim();
        } else if (line.length > 0) {
            logical.push(line);
        }
    }
    return logical;
}

/** Splits a logical header line into its lowercased field name (whitespace before the colon tolerated, the way
 * relaxed canonicalization and lenient parsers treat it) and value. */
function splitHeaderLine(line: string): { name: string; value: string } | undefined {
    const colon: number = line.indexOf(":");
    if (colon <= 0) {
        return undefined;
    }
    return { name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
}

/** How many times the top-level header `headerName` occurs in `raw` (case-insensitive). */
export function countHeaderOccurrences(raw: Buffer, headerName: string): number {
    const wanted: string = headerName.toLowerCase();
    return logicalHeaderLines(raw).filter((line) => splitHeaderLine(line)?.name === wanted).length;
}

/** Every parseable `DKIM-Signature` header in `raw` (unparseable ones are skipped). */
export function extractDkimSignatures(raw: Buffer): ParsedDkimSignature[] {
    const signatures: ParsedDkimSignature[] = [];
    for (const line of logicalHeaderLines(raw)) {
        const header = splitHeaderLine(line);
        if (header?.name !== "dkim-signature") {
            continue;
        }
        const parsed: ParsedDkimSignature | undefined = parseDkimSignature(header.value);
        if (parsed) {
            signatures.push(parsed);
        }
    }
    return signatures;
}

/** `true` if `signature`'s `h=` names `headerName` strictly more times than it occurs (`occurrences`). */
export function oversignsHeader(signature: ParsedDkimSignature, headerName: string, occurrences: number): boolean {
    const wanted: string = headerName.toLowerCase();
    return signature.signedHeaders.filter((name) => name === wanted).length > occurrences;
}

/** Method name `authservIdOf()` appends to a header value to learn its authserv-id even when it reports no results. */
const AUTHSERV_PROBE_METHOD = "x-rapidmx-authserv-probe";

/** The authserv-id of one `Authentication-Results` value (lowercased), or `undefined` if it can't be read - e.g. an
 * unterminated comment or quoted string that would swallow anything after it. */
function authservIdOf(value: string): string | undefined {
    return parseAuthenticationResults(`${value};${AUTHSERV_PROBE_METHOD}=none`).find((entry) => entry.method === AUTHSERV_PROBE_METHOD)?.authservId;
}

/**
 * Only the topmost `Authentication-Results` value stamped by `trustedAuthservId` - the one this deployment's MTA
 * added when it accepted the message - out of `values` (in header order, topmost first, as `extractHeaders()`
 * returns them). Values above it from other authserv-ids (a later internal hop) are skipped. Older trusted instances
 * below it are ignored: they were stamped for an earlier delivery of the same bytes (e.g. a message re-ingested
 * through a forward) and describe signatures as they verified then, so counting them too would let a pass be
 * counted twice. A value whose authserv-id can't be read ends the search with nothing trusted (fails closed).
 * Returns at most one value; none for an unconfigured `trustedAuthservId`.
 */
export function topmostTrustedAuthenticationResults(values: string | string[] | undefined, trustedAuthservId: string): string[] {
    if (!trustedAuthservId || !values) {
        return [];
    }
    const trusted: string = trustedAuthservId.toLowerCase();
    for (const value of Array.isArray(values) ? values : [values]) {
        if (typeof value !== "string") {
            continue;
        }
        const id: string | undefined = authservIdOf(value);
        if (id === undefined) {
            return [];
        }
        if (id === trusted) {
            return [value];
        }
    }
    return [];
}

/**
 * The subset of `signatures` a trusted `Authentication-Results` `dkim=pass` entry vouches for - see this module's
 * doc comment for how an entry is tied to a signature with and without `header.b`. Only the topmost trusted
 * `Authentication-Results` instance is consulted (`topmostTrustedAuthenticationResults()`).
 */
export function verifiedDkimSignatures(
    signatures: ParsedDkimSignature[],
    authenticationResults: string | string[] | undefined,
    trustedAuthservId: string,
): ParsedDkimSignature[] {
    if (!trustedAuthservId) {
        return [];
    }
    const trusted: string = trustedAuthservId.toLowerCase();
    const passing: AuthenticationResultEntry[] = parseAuthenticationResults(topmostTrustedAuthenticationResults(authenticationResults, trustedAuthservId)).filter(
        (entry) => entry.authservId === trusted && entry.method === "dkim" && entry.result === "pass" && !!entry.properties["header.d"],
    );
    const entryDomain = (entry: AuthenticationResultEntry): string => entry.properties["header.d"].toLowerCase().replace(/\.$/, "");

    const verified: Set<ParsedDkimSignature> = new Set();
    for (const entry of passing) {
        const headerB: string | undefined = entry.properties["header.b"]?.replace(/\s+/g, "");
        if (!headerB) {
            continue;
        }
        const candidates = signatures.filter((sig) => sig.domain === entryDomain(entry) && sig.signature.startsWith(headerB));
        if (candidates.length === 1) {
            verified.add(candidates[0]);
        }
    }

    const domains: Set<string> = new Set(signatures.map((sig) => sig.domain));
    for (const domain of domains) {
        const forDomain = signatures.filter((sig) => sig.domain === domain);
        const unidentifiedPasses: number = passing.filter((entry) => !entry.properties["header.b"] && entryDomain(entry) === domain).length;
        // Exactly one pass per signature: more passes than signatures means the results don't describe these
        // signatures one-to-one, so nothing can be concluded from them.
        if (unidentifiedPasses > 0 && unidentifiedPasses === forDomain.length) {
            forDomain.forEach((sig) => verified.add(sig));
        }
    }
    return signatures.filter((sig) => verified.has(sig));
}

/**
 * Whether `raw` carries a `DKIM-Signature` that (1) the trusted MTA hop reported as passing
 * (`verifiedDkimSignatures()`), (2) is strictly aligned with `fromDomain`, and (3) oversigns `headerName`
 * (`oversignsHeader()`) - the gate a replay-sensitive header must pass before it's acted on. Fails closed on an
 * unconfigured `trustedAuthservId`, an empty `fromDomain`, or no qualifying signature.
 */
export function isHeaderOversignedByAlignedDkim(
    raw: Buffer,
    headerName: string,
    fromDomain: string,
    authenticationResults: string | string[] | undefined,
    trustedAuthservId: string,
): boolean {
    const from: string = (fromDomain ?? "").toLowerCase().replace(/\.$/, "");
    if (!from || !trustedAuthservId) {
        return false;
    }
    const occurrences: number = countHeaderOccurrences(raw, headerName);
    return verifiedDkimSignatures(extractDkimSignatures(raw), authenticationResults, trustedAuthservId).some(
        (sig) => sig.domain === from && oversignsHeader(sig, headerName, occurrences),
    );
}
