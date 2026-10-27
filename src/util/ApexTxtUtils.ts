///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The values of a domain's apex TXT set, for the opt-in that lets RapidMX own the set to publish SPF (`Domain.apexTxt`, `PUT mail/domains/:id/apex-txt`).
// Owning a set means owning every value in it, so the admin chooses the values to keep; these helpers suggest them, check them and choose the SPF value.
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { DEFAULT_SPF_VALUE } from "./DnsSetupUtils.js";
import { DOMAIN_VERIFICATION_TXT_PREFIX } from "./DomainVerificationUtils.js";

/** The most values a managed apex TXT set keeps besides SPF. */
export const MAX_APEX_TXT_KEEP = 50;

/** The longest value kept: a TXT record carries a value of this size split into 255-byte strings. */
export const MAX_APEX_TXT_VALUE_LENGTH = 2048;

// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER: RegExp = /[\u0000-\u001f\u007f-\u009f]/;

/** Whether `value` is an SPF record (`v=spf1`, alone or followed by mechanisms). */
export function isSpfValue(value: string): boolean {
    return /^v=spf1(\s|$)/i.test(value.trim());
}

/** Whether `value` is a RapidMX ownership token (`rapidmx-domain-verification=...`), which no longer lives at the apex (`_rapidmx-verify`). */
export function isVerificationTokenValue(value: string): boolean {
    return value.trim().startsWith(DOMAIN_VERIFICATION_TXT_PREFIX);
}

/** What the console pre-fills the "values to keep" list with: every value at the apex except SPF records (RapidMX publishes the one SPF record) and
 * RapidMX ownership tokens (verification no longer reads them there once the domain is verified), each once, in the order they were found. */
export function suggestApexTxtKeep(current: readonly string[]): string[] {
    const keep: string[] = [];
    for (const value of current) {
        if (!isSpfValue(value) && !isVerificationTokenValue(value) && !keep.includes(value)) {
            keep.push(value);
        }
    }
    return keep;
}

/** An SPF `mx` mechanism that authorizes the domain's own MX hosts: `mx` or `+mx`, optionally with CIDR lengths (`mx/24`, `mx//64`, `mx/24//64`). Not
 * `-mx`, `~mx` or `?mx` (which fail or don't vouch for them) and not `mx:<other domain>` (another domain's MX hosts). */
const AUTHORIZES_OWN_MX: RegExp = /(^|\s)\+?mx(\/\d{1,2})?(\/\/\d{1,3})?(?=\s|$)/i;

/** The SPF value to publish when a domain opts in: its existing SPF record verbatim when that already authorizes the domain's MX hosts (whatever else it
 * allows keeps working), else `v=spf1 mx ~all` (an SPF that doesn't is replaced, its old value in the audit entry). */
export function chooseApexSpf(current: readonly string[]): string {
    return current.find((value) => isSpfValue(value) && AUTHORIZES_OWN_MX.test(value)) ?? DEFAULT_SPF_VALUE;
}

/**
 * Checks the "values to keep" an admin sent: a list (left out means none) of at most `MAX_APEX_TXT_KEEP` non-empty values of at most
 * `MAX_APEX_TXT_VALUE_LENGTH` characters, without control characters, trimmed and each once. An SPF record is refused (a name may hold only one, and
 * RapidMX publishes it); a RapidMX ownership token is dropped, as the spec says, since verification no longer reads it at the apex. A 400 otherwise.
 */
export function normalizeApexTxtKeep(input: unknown): string[] {
    if (input === undefined) {
        return [];
    }
    const invalid = (message: string): ApiError => new ApiError(ApiErrors.INVALID_REQUEST, 400, message);
    if (!Array.isArray(input) || input.length > MAX_APEX_TXT_KEEP) {
        throw invalid(`'keep' must be a list of at most ${MAX_APEX_TXT_KEEP} TXT values.`);
    }
    const keep: string[] = [];
    for (const entry of input) {
        const value: string | undefined = typeof entry === "string" ? entry.trim() : undefined;
        if (!value || value.length > MAX_APEX_TXT_VALUE_LENGTH || CONTROL_CHARACTER.test(value)) {
            throw invalid(`Each value in 'keep' must be text of 1 to ${MAX_APEX_TXT_VALUE_LENGTH} characters without control characters.`);
        }
        if (isSpfValue(value)) {
            throw invalid("'keep' can't hold an SPF record: RapidMX publishes the domain's one SPF record itself.");
        }
        if (!isVerificationTokenValue(value) && !keep.includes(value)) {
            keep.push(value);
        }
    }
    return keep;
}
