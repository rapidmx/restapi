///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A DNS provider config's credentials (spec 4.1, 5): one encrypted envelope per secret field on its own row, bound to the row and the field.
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import type { ConfigEnvelope, DnsProvider } from "../models/types.js";
import { ConfigSecretUnavailableError, type ConfigCipher, type ConfigCipherContext } from "../secrets/ConfigCipher.js";

/** The record type every envelope of a `DnsProvider` row names in its associated data. */
export const DNS_PROVIDER_RECORD = "DnsProvider";

/** What an envelope of the credential `field` of provider `uid` is bound to. */
export function dnsCredentialContext(uid: string, field: string): ConfigCipherContext {
    return { record: DNS_PROVIDER_RECORD, uid, field: `credentials.${field}` };
}

/** The names of the credentials `credentials` holds (those with a value), in order. */
export function savedCredentialKeys(credentials: Record<string, unknown> | null | undefined): string[] {
    return Object.entries(credentials ?? {})
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key]) => key)
        .sort();
}

/** The 503 for a server that has no `ConfigCipher` registered: nothing can be encrypted or decrypted. */
export function noConfigCipher(): ApiError {
    return new ApiError(ApiErrors.INTERNAL_ERROR, 503, "Configuration encryption isn't available on this server, so DNS provider credentials can't be handled.");
}

/** `values` (credential field to plaintext) sealed for provider `uid`. A 503 without a keyring. */
export function sealDnsCredentials(cipher: ConfigCipher, uid: string, values: Record<string, string>): Record<string, ConfigEnvelope> {
    return Object.fromEntries(Object.entries(values).map(([field, value]) => [field, cipher.encrypt(value, dnsCredentialContext(uid, field))]));
}

/** What `openDnsCredentials()` read. */
export interface OpenedDnsCredentials {
    /** Each credential that decrypted, as text. */
    values: Record<string, string>;
    /** The fields that couldn't be read (a key that isn't in the ring, an envelope from another row, a value that isn't an envelope): named, never why or what. */
    unreadable: string[];
}

/**
 * Decrypts the credentials of `provider`. A field that can't be decrypted is left out and named: the caller (the controller's credentials request) keeps
 * the Secret it has instead of writing half of one. Anything but a `ConfigSecretUnavailableError` is a bug and is thrown.
 */
export function openDnsCredentials(cipher: ConfigCipher, provider: Pick<DnsProvider, "uid" | "credentials">): OpenedDnsCredentials {
    const values: Record<string, string> = {};
    const unreadable: string[] = [];
    for (const field of savedCredentialKeys(provider.credentials)) {
        try {
            values[field] = cipher.decryptString(provider.credentials![field], dnsCredentialContext(provider.uid, field));
        } catch (err) {
            if (!(err instanceof ConfigSecretUnavailableError)) {
                throw err;
            }
            unreadable.push(field);
        }
    }
    return { values, unreadable };
}
