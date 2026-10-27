///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ConfigEnvelope, DnsProvider } from "../models/types.js";
import { isConfigEnvelope } from "../secrets/ConfigCipher.js";
import type { ConfigEnvelopeSource } from "../secrets/ConfigEnvelopeSource.js";
import { DNS_PROVIDER_RECORD } from "./DnsProviderCredentials.js";

/** The prefix of the field path of a credential in the envelope's associated data (`credentials.<field>`). */
const CREDENTIALS_PREFIX = "credentials.";

/**
 * Where `ConfigKeyRotationJob` finds the envelopes of the DNS provider configs (spec 5.5): each credential of a row, under its field path. Replacing some of
 * them saves the row's whole `credentials` and nothing else - not `credentialsGeneration`, since the plaintext is the same and the DNS controller has no
 * reason to rewrite the external-dns Secret or roll its pod.
 *
 * @param modelClass The datastore's entity class (`DnsProviderMongo`, `DnsProviderSQL`).
 */
export function dnsProviderEnvelopeSource(modelClass: any): ConfigEnvelopeSource<DnsProvider> {
    return {
        record: DNS_PROVIDER_RECORD,
        modelClass,
        envelopes: (row) =>
            Object.entries(row.credentials ?? {})
                .filter(([, value]) => isConfigEnvelope(value))
                .map(([field, envelope]) => ({ field: `${CREDENTIALS_PREFIX}${field}`, envelope })),
        replace: (row, replacements) => {
            const credentials: Record<string, ConfigEnvelope> = { ...(row.credentials ?? {}) };
            for (const [path, envelope] of Object.entries(replacements)) {
                const field: string = path.slice(CREDENTIALS_PREFIX.length);
                if (path.startsWith(CREDENTIALS_PREFIX) && field in credentials) {
                    credentials[field] = envelope;
                }
            }
            return { credentials };
        },
    };
}
