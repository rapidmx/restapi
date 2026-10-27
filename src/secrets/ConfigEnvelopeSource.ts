///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ConfigEnvelope } from "../models/types.js";

/** One envelope in a row, with the field path it is bound to (`credentials.apiToken`, `giphy.apiKey`, `settings.<key>`). */
export interface ConfigEnvelopeRef {
    field: string;
    envelope: ConfigEnvelope;
}

/**
 * The envelopes of one record type (`DnsProvider`, `IntegrationSettings`, `Plugin`): what `ConfigKeyRotationJob` needs to count them per key and to
 * re-encrypt them (spec 5.5, step 3), without knowing any record's shape. restapi's steps R2 to R4 register one per type, each over the class of the
 * datastore the deployment uses.
 */
export interface ConfigEnvelopeSource<T = any> {
    /** The record type, as it is in every envelope's associated data (5.2). */
    record: string;
    /** The entity class (`DnsProviderMongo`, `PluginSQL`, ...) the job pages through. */
    modelClass: any;
    /** The envelopes `row` holds, each with its field path. A field that holds a plain value, or nothing, is not listed. */
    envelopes(row: T): ConfigEnvelopeRef[];
    /** The fields of `row` to save to replace the envelopes at the paths in `replacements` (field path to its new envelope), everything else as it is: the
     * whole top-level field that holds them (`credentials`, `settings`), since a row is replaced, not patched. */
    replace(row: T, replacements: Record<string, ConfigEnvelope>): Record<string, unknown>;
}

/** The record types that hold envelopes, one source each, in the order they were registered. */
export class ConfigEnvelopeSourceRegistry {
    private readonly sources: Map<string, ConfigEnvelopeSource> = new Map();

    /** Registers `source`. A second source for a record type is refused: the type is part of what an envelope is bound to, so two would count its rows twice. */
    public register(source: ConfigEnvelopeSource): void {
        if (this.sources.has(source.record)) {
            throw new Error(`A source of '${source.record}' envelopes is already registered.`);
        }
        this.sources.set(source.record, source);
    }

    public get(record: string): ConfigEnvelopeSource | undefined {
        return this.sources.get(record);
    }

    /** The registered sources, in registration order. */
    public list(): ConfigEnvelopeSource[] {
        return [...this.sources.values()];
    }
}
