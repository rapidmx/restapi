///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import * as net from "net";
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { DnsProviderOptionValue, DnsProviderType } from "../models/types.js";

/** A host name in lowercase: dot-separated labels of letters, digits and hyphens (a label neither starts nor ends with one, at most 63 characters), at
 * most 253 in all. The same rule as a `Domain`'s name. */
const DNS_NAME_PATTERN: RegExp = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const UUID_PATTERN: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The most zones one provider config may hold. */
export const MAX_DNS_PROVIDER_ZONES = 50;

/** How an option's value is typed in a form and checked on save. */
export type DnsProviderOptionKind = "string" | "string-list" | "integer" | "boolean" | "enum";

/** One non-secret option of a provider type. */
export interface DnsProviderOptionSpec {
    key: string;
    label: string;
    kind: DnsProviderOptionKind;
    required: boolean;
    /** What a value left out is saved as. */
    default?: string | number | boolean;
    /** The allowed values of an `enum`. */
    values?: readonly string[];
    /** The range of an `integer`. */
    min?: number;
    max?: number;
    /** The most entries a `string-list` takes. */
    maxItems?: number;
    description: string;
    /** What a valid value looks like, in the words of the error message. */
    format?: string;
    /** Puts a string (each entry of a list) into its stored form before `check` runs: lowercase, without a trailing dot. */
    normalize?: (value: string) => string;
    /** Whether a string (each entry of a list) is acceptable. */
    check?: (value: string) => boolean;
}

/** One credential field of a provider type: saved encrypted on the provider's row, never returned. */
export interface DnsProviderSecretFieldSpec {
    key: string;
    label: string;
    /** Always needed. A field needed only in some configurations (Route 53's keys, rfc2136's TSIG secret) is `false` and says when in `description`. */
    required: boolean;
    /** A file's content (Google's service-account JSON) rather than a token: tabs and line breaks allowed. */
    multiLine?: boolean;
    description: string;
    /** What a valid value looks like, in the words of the error message (which never repeats the value). */
    format?: string;
    check?: (value: string) => boolean;
}

/** Everything the server knows about one provider type. */
export interface DnsProviderTypeSpec {
    type: DnsProviderType;
    label: string;
    /** The `--provider` external-dns runs with. */
    externalDnsProvider: string;
    /** Whether this type has been tested against the real service. The console marks the others "not yet live-tested". */
    tested: boolean;
    options: readonly DnsProviderOptionSpec[];
    secretFields: readonly DnsProviderSecretFieldSpec[];
    /** Record kinds this provider can't manage (rfc2136 writes MX and SRV but can never update or delete them); those records stay manual. */
    unsupportedRecordKinds: readonly ("MX" | "SRV")[];
    /** What the console shows next to the form. */
    notes: readonly string[];
    /** Checks between options, and between options and the zones, once each option is valid on its own. Returns what's wrong. */
    checkOptions?: (options: Record<string, DnsProviderOptionValue>, zones: readonly string[]) => string | undefined;
    /** Checks that the credentials saved (by key) are enough for these options. Returns what's missing. */
    checkCredentials: (options: Record<string, DnsProviderOptionValue>, keys: readonly string[]) => string | undefined;
}

/** What `GET /system/dns-providers/types` returns per type: the spec without its functions. */
export interface DnsProviderTypeInfo {
    type: DnsProviderType;
    label: string;
    externalDnsProvider: string;
    tested: boolean;
    options: Omit<DnsProviderOptionSpec, "normalize" | "check">[];
    secretFields: Omit<DnsProviderSecretFieldSpec, "check">[];
    unsupportedRecordKinds: ("MX" | "SRV")[];
    notes: string[];
}

/** Lowercase, without a trailing dot: how a DNS name is stored. */
function dnsName(value: string): string {
    return value.toLowerCase().replace(/\.$/, "");
}

function isDnsName(value: string): boolean {
    return DNS_NAME_PATTERN.test(value);
}

function isBase64(value: string): boolean {
    return value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isJsonObject(value: string): boolean {
    try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    } catch {
        return false;
    }
}

const has = (keys: readonly string[], key: string): boolean => keys.includes(key);

const DNS_PROVIDER_TYPES: readonly DnsProviderTypeSpec[] = [
    {
        type: "cloudflare",
        label: "Cloudflare",
        externalDnsProvider: "cloudflare",
        tested: true,
        options: [
            {
                key: "zoneIds",
                label: "Zone IDs",
                kind: "string-list",
                required: true,
                maxItems: MAX_DNS_PROVIDER_ZONES,
                description: "The Cloudflare zone ID of each zone, in the same order as the zones. They let a token scoped to those zones work.",
                format: "a 32-character hexadecimal Cloudflare zone ID",
                normalize: (value) => value.toLowerCase(),
                check: (value) => /^[0-9a-f]{32}$/.test(value),
            },
        ],
        secretFields: [{ key: "apiToken", label: "API token", required: true, description: "A token with Zone:Zone:Read and Zone:DNS:Edit on these zones." }],
        unsupportedRecordKinds: [],
        notes: [
            "Records are never proxied: mail hosts must not be, and MX, TXT and SRV records can't be.",
            "If the token is restricted to client IP addresses, list every address the cluster reaches the internet from, IPv4 and IPv6.",
        ],
        checkOptions: (options, zones) => {
            const zoneIds = options.zoneIds as string[];
            if (zoneIds.length !== zones.length) {
                return "'zoneIds' must have one zone ID per zone, in the same order as 'zones'.";
            }
            return new Set(zoneIds).size !== zoneIds.length ? "'zoneIds' must not repeat a zone ID." : undefined;
        },
        checkCredentials: (_options, keys) => (has(keys, "apiToken") ? undefined : "'apiToken' is required."),
    },
    {
        type: "route53",
        label: "Amazon Route 53",
        externalDnsProvider: "aws",
        tested: false,
        options: [
            {
                key: "region",
                label: "Region",
                kind: "string",
                required: true,
                description: "The AWS region the API is called in, such as us-east-1.",
                format: "an AWS region name such as us-east-1",
                normalize: (value) => value.toLowerCase(),
                check: (value) => /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(value),
            },
            { key: "zoneType", label: "Zone type", kind: "enum", required: false, default: "public", values: ["public", "private"], description: "Which hosted zones to publish in." },
            {
                key: "assumeRoleArn",
                label: "Role to assume",
                kind: "string",
                required: false,
                description: "An IAM role ARN to assume for every call, if the credentials aren't the role itself.",
                format: "an IAM role ARN such as arn:aws:iam::123456789012:role/external-dns",
                check: (value) => /^arn:aws(?:-[a-z]+)*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/.test(value),
            },
        ],
        secretFields: [
            {
                key: "accessKeyId",
                label: "Access key ID",
                required: false,
                description: "Set both keys, or neither to use the role of external-dns's service account (IRSA).",
                format: "an AWS access key ID (letters and digits)",
                check: (value) => /^[A-Z0-9]{16,128}$/.test(value),
            },
            { key: "secretAccessKey", label: "Secret access key", required: false, description: "Set both keys, or neither to use the role of external-dns's service account (IRSA)." },
        ],
        unsupportedRecordKinds: [],
        notes: ["Not yet live-tested."],
        checkCredentials: (_options, keys) =>
            has(keys, "accessKeyId") === has(keys, "secretAccessKey") ? undefined : "'accessKeyId' and 'secretAccessKey' must be set together, or neither.",
    },
    {
        type: "rfc2136",
        label: "RFC 2136 (BIND and other DNS servers)",
        externalDnsProvider: "rfc2136",
        tested: false,
        options: [
            {
                key: "hosts",
                label: "Servers",
                kind: "string-list",
                required: true,
                maxItems: 10,
                description: "The DNS servers that accept dynamic updates and zone transfers for these zones.",
                format: "a host name or an IP address",
                normalize: dnsName,
                check: (value) => isDnsName(value) || net.isIP(value) !== 0,
            },
            { key: "port", label: "Port", kind: "integer", required: false, default: 53, min: 1, max: 65535, description: "The servers' DNS port." },
            {
                key: "zone",
                label: "Zone",
                kind: "string",
                required: true,
                description: "The zone updates are sent for: one of this config's zones.",
                format: "a zone name",
                normalize: dnsName,
                check: isDnsName,
            },
            {
                key: "tsigKeyName",
                label: "TSIG key name",
                kind: "string",
                required: false,
                description: "The name of the TSIG key the servers accept updates signed with. Required unless 'insecure' is on.",
                format: "a key name (a DNS name)",
                normalize: dnsName,
                check: isDnsName,
            },
            {
                key: "tsigAlgorithm",
                label: "TSIG algorithm",
                kind: "enum",
                required: false,
                default: "hmac-sha256",
                values: ["hmac-sha1", "hmac-sha224", "hmac-sha256", "hmac-sha384", "hmac-sha512"],
                description: "The algorithm of that key.",
            },
            { key: "insecure", label: "Unsigned updates", kind: "boolean", required: false, default: false, description: "Send updates without TSIG. Only for a server that accepts them from this cluster alone." },
        ],
        secretFields: [
            {
                key: "tsigSecret",
                label: "TSIG secret",
                required: false,
                description: "The TSIG key's secret, base64. Required unless 'insecure' is on.",
                format: "base64",
                check: isBase64,
            },
        ],
        unsupportedRecordKinds: ["MX", "SRV"],
        notes: ["MX and SRV records can't be managed through RFC 2136 zone transfers; they stay manual.", "Not yet live-tested."],
        checkOptions: (options, zones) => {
            if (!zones.includes(options.zone as string)) {
                return "'zone' must be one of the zones.";
            }
            return !options.insecure && options.tsigKeyName === undefined ? "'tsigKeyName' is required unless 'insecure' is on." : undefined;
        },
        checkCredentials: (options, keys) => (options.insecure || has(keys, "tsigSecret") ? undefined : "'tsigSecret' is required unless 'insecure' is on."),
    },
    {
        type: "google",
        label: "Google Cloud DNS",
        externalDnsProvider: "google",
        tested: false,
        options: [
            {
                key: "project",
                label: "Project ID",
                kind: "string",
                required: true,
                description: "The Google Cloud project that holds the zones.",
                format: "a Google Cloud project ID",
                check: (value) => /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value),
            },
        ],
        secretFields: [
            {
                key: "serviceAccountJson",
                label: "Service account key (JSON)",
                required: true,
                multiLine: true,
                description: "The JSON key file of a service account with the DNS Administrator role on the project.",
                format: "a JSON object (the key file's content)",
                check: isJsonObject,
            },
        ],
        unsupportedRecordKinds: [],
        notes: ["Not yet live-tested."],
        checkCredentials: (_options, keys) => (has(keys, "serviceAccountJson") ? undefined : "'serviceAccountJson' is required."),
    },
    {
        type: "azure",
        label: "Azure DNS",
        externalDnsProvider: "azure",
        tested: false,
        options: [
            {
                key: "tenantId",
                label: "Tenant ID",
                kind: "string",
                required: true,
                description: "The Microsoft Entra tenant of the service principal.",
                format: "a GUID",
                normalize: (value) => value.toLowerCase(),
                check: (value) => UUID_PATTERN.test(value),
            },
            {
                key: "subscriptionId",
                label: "Subscription ID",
                kind: "string",
                required: true,
                description: "The subscription that holds the zones.",
                format: "a GUID",
                normalize: (value) => value.toLowerCase(),
                check: (value) => UUID_PATTERN.test(value),
            },
            {
                key: "resourceGroup",
                label: "Resource group",
                kind: "string",
                required: true,
                description: "The resource group that holds the zones.",
                format: "a resource group name (letters, digits, '-', '_', '.', '(' and ')', not ending with '.')",
                check: (value) => /^[A-Za-z0-9_.()-]{1,90}$/.test(value) && !value.endsWith("."),
            },
        ],
        secretFields: [
            {
                key: "clientId",
                label: "Client ID",
                required: true,
                description: "The application (client) ID of a service principal with the DNS Zone Contributor role.",
                format: "a GUID",
                check: (value) => UUID_PATTERN.test(value.toLowerCase()),
            },
            { key: "clientSecret", label: "Client secret", required: true, description: "A client secret of that service principal." },
        ],
        unsupportedRecordKinds: [],
        notes: ["Not yet live-tested."],
        checkCredentials: (_options, keys) => (has(keys, "clientId") && has(keys, "clientSecret") ? undefined : "'clientId' and 'clientSecret' are required."),
    },
];

/** Whether `value` names a provider type. */
export function isDnsProviderType(value: unknown): value is DnsProviderType {
    return typeof value === "string" && DNS_PROVIDER_TYPES.some((spec) => spec.type === value);
}

/** The spec of `type`, or a 400 listing the types. */
export function getDnsProviderType(type: unknown): DnsProviderTypeSpec {
    const spec: DnsProviderTypeSpec | undefined = DNS_PROVIDER_TYPES.find((candidate) => candidate.type === type);
    if (!spec) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'type' must be one of: ${DNS_PROVIDER_TYPES.map((candidate) => candidate.type).join(", ")}.`);
    }
    return spec;
}

/** Every provider type, without the functions: what drives the console's form. A new copy each call. */
export function listDnsProviderTypes(): DnsProviderTypeInfo[] {
    return DNS_PROVIDER_TYPES.map((spec) => ({
        type: spec.type,
        label: spec.label,
        externalDnsProvider: spec.externalDnsProvider,
        tested: spec.tested,
        options: spec.options.map(({ normalize: _normalize, check: _check, values, ...rest }) => ({ ...rest, ...(values ? { values: [...values] } : {}) })),
        secretFields: spec.secretFields.map(({ check: _check, ...rest }) => ({ ...rest })),
        unsupportedRecordKinds: [...spec.unsupportedRecordKinds],
        notes: [...spec.notes],
    }));
}

/** The keys of `spec`'s credential fields, and those of them that hold a file's content. */
export function dnsProviderSecretKeys(spec: DnsProviderTypeSpec): { fields: string[]; multiLineFields: string[] } {
    return {
        fields: spec.secretFields.map((field) => field.key),
        multiLineFields: spec.secretFields.filter((field) => field.multiLine).map((field) => field.key),
    };
}

/**
 * Validates and normalizes a provider config's zones: a non-empty list (at most `MAX_DNS_PROVIDER_ZONES`) of DNS names of at least two labels, stored
 * lowercase without a trailing dot, each once. A single label (a top-level domain) is refused: a config is confined to the zones it names.
 */
export function normalizeDnsZones(input: unknown): string[] {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_DNS_PROVIDER_ZONES) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'zones' must be a list of 1 to ${MAX_DNS_PROVIDER_ZONES} zone names.`);
    }
    const zones: string[] = [];
    for (const entry of input) {
        const zone: string | undefined = typeof entry === "string" ? dnsName(entry.trim()) : undefined;
        if (!zone || !isDnsName(zone) || !zone.includes(".")) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "Each zone must be a domain name such as example.com (not a top-level domain on its own).");
        }
        if (!zones.includes(zone)) {
            zones.push(zone);
        }
    }
    return zones;
}

/** What a `DnsProvider.uid` looks like: a DNS label of at most 40 characters that starts with a letter (it names Kubernetes resources and a label value). */
export const DNS_PROVIDER_UID_PATTERN: RegExp = /^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const UID_SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A new `DnsProvider.uid` for a config named `name`: the name as a slug of lowercase letters, digits and hyphens (at most 31 characters, `dns` in front
 * when it doesn't start with a letter), a hyphen and 8 random letters and digits - readable in `kubectl get deployments`, and never reused, so
 * renaming the config never changes it.
 */
export function newDnsProviderUid(name: string): string {
    const slug: string = name
        .normalize("NFKD")
        // The accents NFKD splits off, so "Zürich" reads as "zurich" rather than "zu-rich".
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const prefix: string = (/^[a-z]/.test(slug) ? slug : `dns-${slug}`).slice(0, 31).replace(/-+$/, "");
    let suffix = "";
    for (let i = 0; i < 8; i++) {
        suffix += UID_SUFFIX_ALPHABET[crypto.randomInt(UID_SUFFIX_ALPHABET.length)];
    }
    return `${prefix}-${suffix}`;
}

/** Whether `name` is one of `zones` or under one of them: what a domain assigned to a provider config must be. */
export function isNameInZones(name: string, zones: readonly string[]): boolean {
    const normalized: string = dnsName(name);
    return zones.some((zone) => normalized === zone || normalized.endsWith(`.${zone}`));
}

/** One option's value, checked against `option` and normalized, or a 400 naming the key. */
function normalizeOption(option: DnsProviderOptionSpec, value: unknown): DnsProviderOptionValue {
    const invalid = (what: string): ApiError => new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${option.key}' must be ${what}.`);
    const normalizeString = (raw: unknown): string => {
        const text: string | undefined = typeof raw === "string" ? raw.trim() : undefined;
        const normalized: string | undefined = text ? (option.normalize ? option.normalize(text) : text) : undefined;
        if (!normalized || normalized.length > 512 || (option.check && !option.check(normalized))) {
            throw invalid(option.format ?? "non-empty text");
        }
        return normalized;
    };
    switch (option.kind) {
        case "boolean":
            if (typeof value !== "boolean") {
                throw invalid("true or false");
            }
            return value;
        case "integer":
            if (typeof value !== "number" || !Number.isInteger(value) || value < option.min! || value > option.max!) {
                throw invalid(`a whole number from ${option.min} to ${option.max}`);
            }
            return value;
        case "enum":
            if (typeof value !== "string" || !option.values!.includes(value)) {
                throw invalid(`one of: ${option.values!.join(", ")}`);
            }
            return value;
        case "string-list": {
            if (!Array.isArray(value) || value.length === 0 || value.length > option.maxItems!) {
                throw invalid(`a list of 1 to ${option.maxItems} entries, each ${option.format}`);
            }
            return value.map(normalizeString);
        }
        default:
            return normalizeString(value);
    }
}

/**
 * Validates a provider config's options against its type and its zones, returning them normalized with every default filled in. A 400 for anything
 * that isn't an object, an unknown key (naming the allowed ones), a missing required option, a value of the wrong kind or format, or a combination the
 * type refuses (`checkOptions`). Values become external-dns arguments or environment variables and are never interpolated into a shell or a path.
 */
export function normalizeDnsProviderOptions(spec: DnsProviderTypeSpec, input: unknown, zones: readonly string[]): Record<string, DnsProviderOptionValue> {
    const raw: unknown = input === undefined || input === null ? {} : input;
    if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, "'options' must be an object.");
    }
    const allowed: string[] = spec.options.map((option) => option.key);
    for (const key of Object.keys(raw as object)) {
        if (!allowed.includes(key)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `Unknown option for ${spec.label}. The options are: ${allowed.join(", ")}.`);
        }
    }
    const options: Record<string, DnsProviderOptionValue> = {};
    for (const option of spec.options) {
        const value: unknown = (raw as Record<string, unknown>)[option.key];
        if (value === undefined || value === null || value === "") {
            if (option.required) {
                throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${option.key}' is required for ${spec.label}.`);
            }
            if (option.default !== undefined) {
                options[option.key] = option.default;
            }
            continue;
        }
        options[option.key] = normalizeOption(option, value);
    }
    const problem: string | undefined = spec.checkOptions?.(options, zones);
    if (problem) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, problem);
    }
    return options;
}

/**
 * Checks the credential values a form is about to save (the non-null entries of a `toSecretPatch()` result) against each field's format. The error names
 * the field and the expected format, never the value.
 */
export function assertDnsProviderSecretValues(spec: DnsProviderTypeSpec, patch: Record<string, string | null>): void {
    for (const field of spec.secretFields) {
        const value: string | null | undefined = patch[field.key];
        if (typeof value === "string" && field.check && !field.check(value)) {
            throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `'${field.key}' must be ${field.format}.`);
        }
    }
}

/** A 400 unless the credential keys saved (`keys`) are enough for a config of `spec` with `options`. */
export function assertDnsProviderCredentials(spec: DnsProviderTypeSpec, options: Record<string, DnsProviderOptionValue>, keys: readonly string[]): void {
    const problem: string | undefined = spec.checkCredentials(options, keys);
    if (problem) {
        throw new ApiError(ApiErrors.INVALID_REQUEST, 400, `${problem} Credentials are saved encrypted and never shown again.`);
    }
}
