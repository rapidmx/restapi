///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// What `ConfigKeyRotationJob` needs of a DNS provider row to count and re-encrypt its credentials (spec 5.5, step 3): the envelopes with the field path they
// are bound to, and the field to save to replace some of them.
import { dnsProviderEnvelopeSource } from "../../src/dns/DnsProviderEnvelopeSource.js";
import type { ConfigEnvelope } from "../../src/models/types.js";

const envelope = (kid: string): ConfigEnvelope => ({ $enc: 1, kid, iv: "aXY=", ct: "Y3Q=", tag: "dGFn" });

describe("dnsProviderEnvelopeSource()", () => {
    class Model {}
    const source = dnsProviderEnvelopeSource(Model);

    it("is the source of DnsProvider envelopes, over the model class it is given", () => {
        expect(source.record).toBe("DnsProvider");
        expect(source.modelClass).toBe(Model);
    });

    it("lists each credential's envelope under the path its associated data names", () => {
        const row = { uid: "aws-x", credentials: { accessKeyId: envelope("k1"), secretAccessKey: envelope("k2") }, credentialsGeneration: 2 };
        expect(source.envelopes(row)).toEqual([
            { field: "credentials.accessKeyId", envelope: envelope("k1") },
            { field: "credentials.secretAccessKey", envelope: envelope("k2") },
        ]);
    });

    it("lists nothing for a row without credentials, cleared ones, or a field that holds no envelope", () => {
        expect(source.envelopes({ uid: "a" })).toEqual([]);
        expect(source.envelopes({ uid: "a", credentials: null })).toEqual([]);
        expect(source.envelopes({ uid: "a", credentials: {} })).toEqual([]);
        // A value saved in plaintext by hand, or a field left empty, isn't an envelope: the credentials route reports it unreadable.
        expect(source.envelopes({ uid: "a", credentials: { apiToken: "plaintext", other: null, third: { secret: true } } })).toEqual([]);
    });

    it("replaces envelopes by path, keeping the others, and saves only the credentials: the plaintext is the same, so the generation stays", () => {
        const row = { uid: "aws-x", name: "AWS", credentials: { accessKeyId: envelope("k1"), secretAccessKey: envelope("k1") }, credentialsGeneration: 2 };
        const changed = source.replace(row, { "credentials.secretAccessKey": envelope("k3") });
        expect(changed).toEqual({ credentials: { accessKeyId: envelope("k1"), secretAccessKey: envelope("k3") } });
        // The row it was given is not changed.
        expect(row.credentials.secretAccessKey).toEqual(envelope("k1"));
    });

    it("ignores a replacement for a path that isn't a credential of the row", () => {
        const row = { uid: "aws-x", credentials: { accessKeyId: envelope("k1") } };
        expect(source.replace(row, { "settings.other": envelope("k3"), "credentials.missing": envelope("k3") })).toEqual({ credentials: { accessKeyId: envelope("k1") } });
        expect(source.replace({ uid: "a" }, {})).toEqual({ credentials: {} });
    });
});
