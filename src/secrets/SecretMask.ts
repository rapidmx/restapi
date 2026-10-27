///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";

/**
 * What a response shows in place of a secret that is set, and what a form sends back for a secret it left alone. One shape for plugin secret settings
 * (`maskSecretSettings()`) and for every credential held on a row (`maskCredentials()`), so the console has one write-only control for both.
 */
export interface SecretMask {
    secret: true;
}

/** A new mask (a new object each time, so no response shares one another can change). */
export function secretMask(): SecretMask {
    return { secret: true };
}

/** Whether `value` is exactly the mask: an object whose only key is `secret`, set to `true`. */
export function isSecretMask(value: unknown): value is SecretMask {
    return typeof value === "object" && value !== null && !Array.isArray(value) && (value as any).secret === true && Object.keys(value).length === 1;
}

/** The mask for each field of `credentials` that is set, keyed as the form's fields are: what a route returns for saved credentials. Nothing when none were saved
 * (or all were cleared). The values - an envelope each - never appear. */
export function maskCredentials(credentials: Record<string, unknown> | null | undefined): Record<string, SecretMask> {
    const masked: Record<string, SecretMask> = {};
    for (const [field, value] of Object.entries(credentials ?? {})) {
        if (value !== undefined && value !== null) {
            masked[field] = secretMask();
        }
    }
    return masked;
}

// C0 controls, DEL and C1 controls: never part of a token, and a line break would split the environment variable or file external-dns reads it from.
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER: RegExp = /[\u0000-\u001f\u007f-\u009f]/;
// The same, less the tab and line breaks a multi-line value (a service-account JSON file) is laid out with.
// eslint-disable-next-line no-control-regex -- as above.
const MULTI_LINE_CONTROL_CHARACTER: RegExp = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/**
 * Turns the credentials a write-only form sent into what `SecretStore.patch()` takes: a field sent as a string is the new value (surrounding whitespace,
 * such as the newline a pasted token carries, trimmed), `null` clears it, and a field sent back as the mask, or not sent, is left alone (so it isn't in the
 * result). Refuses (400) a field not in `fields`, a value that is empty or only whitespace, a control character inside a value (tabs and line breaks are
 * allowed in `multiLineFields` only), and any other value. The error names the field, or for an unknown one lists `fields`, and never repeats what was sent:
 * a credential sent by mistake as a key would otherwise come back in the response and in any log of it.
 *
 * @param input The request's credentials object (`undefined` when it sent none).
 * @param fields The secret fields the form has (a DNS provider type's secret fields, an integration section's secret keys).
 * @param multiLineFields Those of `fields` whose value is a file's content rather than a token (Google's `serviceAccountJson`).
 */
export function toSecretPatch(input: unknown, fields: readonly string[], multiLineFields: readonly string[] = []): Record<string, string | null> {
    if (input === undefined) {
        return {};
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Credentials must be an object of fields.");
    }
    const patch: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(input)) {
        if (!fields.includes(key)) {
            throw new ApiError(
                ApiErrors.INVALID_REQUEST,
                400,
                fields.length > 0 ? `Unknown credential field. The fields are: ${fields.join(", ")}.` : "These settings have no credential fields.",
            );
        }
        if (value === undefined || isSecretMask(value)) {
            continue;
        }
        if (value === null) {
            patch[key] = null;
            continue;
        }
        const trimmed: string | undefined = typeof value === "string" ? value.trim() : undefined;
        if (!trimmed) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${key}' must be a non-empty string, null to clear it, or { "secret": true } to leave it unchanged.`);
        }
        if ((multiLineFields.includes(key) ? MULTI_LINE_CONTROL_CHARACTER : CONTROL_CHARACTER).test(trimmed)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${key}' contains a control character or line break. Paste the value alone.`);
        }
        patch[key] = trimmed;
    }
    return patch;
}
