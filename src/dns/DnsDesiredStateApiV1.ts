///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Version 1 of the internal DNS API between the server and the DNS controller (spec: specs/dns_publishing_and_integrations.md, 7.3). The types mirror
// rapidmx/dns-controller's `src/api/v1.ts`; both repositories test against the same JSON fixtures (here `test/fixtures/dns-api/v1`, byte-identical to
// the controller's `test/fixtures/api/v1`). Rules:
//
// - Every payload, request and response, carries `apiVersion` and `kind`. A payload with another `apiVersion` is refused, never guessed at.
// - Within v1, changes are additive only (new optional fields, kinds or routes); unknown fields are ignored. A breaking change is v2, under
//   /internal/dns/v2, served next to v1 for at least one release.
// - The handshake (`Handshake`/`HandshakeResult`) is unversioned and its shape never changes: it is what lets two mismatched versions find out that
//   they are.
//
// `DnsProviderV1.options` values may be lists (Cloudflare's `zoneIds`, rfc2136's `hosts`), in both copies and in the shared desired-state fixture.
// `PUT /v1/status` answers a `StatusReportResult`, in both copies (the controller's since its phase C2, which refuses any other answer).

/** The API version this server speaks. */
export const API_VERSION_V1 = "dns.rapidmx.io/v1";
/** Every API version this server speaks, best first. */
export const SUPPORTED_API_VERSIONS: readonly string[] = [API_VERSION_V1];

/** The route prefix of a version: `dns.rapidmx.io/v1` is served under `<base>/v1`. */
export function versionPath(apiVersion: string): string {
    return `/${apiVersion.slice(apiVersion.lastIndexOf("/") + 1)}`;
}

// --- Handshake (unversioned, frozen) ---------------------------------------------------------------------------------

/** `POST <base>/handshake`, sent by the controller at start-up and while incompatible. */
export interface Handshake {
    kind: "Handshake";
    controllerVersion: string;
    apiVersions: string[];
}

/** The server's answer. `selected` is the version both sides speak, when there is one. */
export interface HandshakeResult {
    kind: "HandshakeResult";
    serverVersion: string;
    apiVersions: string[];
    compatible: boolean;
    selected?: string;
    reason?: string;
}

// --- v1 payloads -------------------------------------------------------------------------------------------------------

/** Fields every v1 payload has. */
export interface V1Envelope<K extends string> {
    apiVersion: typeof API_VERSION_V1;
    kind: K;
}

export type DnsProviderTypeV1 = "cloudflare" | "route53" | "rfc2136" | "google" | "azure";
export type DnsRecordKindV1 = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "SRV";

/** Where a provider's credentials are: a reference, never the value. */
export interface SecretRefV1 {
    backend: "openbao" | "kubernetes";
    path: string;
    keys: string[];
    generation: number;
}

export interface DnsProviderV1 {
    uid: string;
    type: DnsProviderTypeV1;
    zones: string[];
    options: Record<string, string | number | boolean | string[]>;
    secretRef?: SecretRefV1;
    enabled: boolean;
}

export interface DnsRecordV1 {
    dnsName: string;
    recordType: DnsRecordKindV1;
    /** Unquoted values; the controller quotes TXT targets when it writes a `DNSEndpoint`. */
    targets: string[];
    ttl?: number;
}

/** One `DNSEndpoint` worth of records: a domain's, or the deployment hosts' for one provider. */
export interface EndpointSetV1 {
    /** Stable name the controller derives the `DNSEndpoint` name from. */
    id: string;
    providerUid: string;
    domainUid?: string;
    records: DnsRecordV1[];
}

/** A queued operation: a credentials test, a takeover, or restoring kept values of a released set. */
export interface OperationV1 {
    id: string;
    type: "test" | "takeover" | "restore";
    providerUid: string;
    endpointSetId?: string;
    records?: DnsRecordV1[];
}

/** `GET <base>/v1/desired-state`. */
export interface DesiredStateV1 extends V1Envelope<"DesiredState"> {
    /** Increases on every change; the long poll's `since`. */
    version: number;
    /** The external-dns `--txt-owner-id`. */
    ownerId: string;
    /** The one external-dns image the controller may run. */
    externalDnsImage: string;
    providers: DnsProviderV1[];
    endpointSets: EndpointSetV1[];
    operations: OperationV1[];
}

export interface ProviderStatusV1 {
    providerUid: string;
    readyReplicas: number;
    image?: string;
    lastSyncAt?: string;
    lastError?: string;
}

export interface EndpointStatusV1 {
    endpointSetId: string;
    generation: number;
    observedGeneration?: number;
}

export interface OperationStatusV1 {
    id: string;
    state: "running" | "succeeded" | "failed";
    message?: string;
}

/** `PUT <base>/v1/status`. */
export interface StatusReportV1 extends V1Envelope<"StatusReport"> {
    controllerVersion: string;
    /** The desired-state version this report reflects. */
    desiredStateVersion?: number;
    lease: { holder: boolean; identity: string };
    providers: ProviderStatusV1[];
    endpoints: EndpointStatusV1[];
    operations: OperationStatusV1[];
}

/** The server's answer to a status report. */
export type StatusReportResultV1 = V1Envelope<"StatusReportResult">;

// --- Validation --------------------------------------------------------------------------------------------------------

/** A payload of a version this server doesn't speak, or of another kind: answered `400 { reason: "unsupported_api_version", supported }`. */
export class ApiVersionError extends Error {
    constructor(
        message: string,
        readonly received?: unknown,
    ) {
        super(message);
        this.name = "ApiVersionError";
    }
}

/** A payload of the right version whose fields are not what the version says: answered 400. Its message names the field, never a value. */
export class DnsApiPayloadError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DnsApiPayloadError";
    }
}

/** The longest text the server keeps from a report (an error or result message), so a misbehaving controller can't grow a row without bound. */
export const MAX_REPORTED_TEXT_LENGTH = 2000;
/** The longest version or identity string accepted. */
const MAX_LABEL_LENGTH = 100;
/** The longest image reference accepted (registry, repository, tag and digest). */
const MAX_IMAGE_LENGTH = 500;
/** The most API versions a handshake may list. */
const MAX_HANDSHAKE_VERSIONS = 20;
/** The most entries of one list in a status report. */
const MAX_REPORT_ENTRIES = 10000;

/**
 * Checks that `payload` is a v1 object of `kind` and returns it typed. Only the envelope is checked here; each kind's own fields are validated by its
 * consumer.
 */
export function expectV1<T extends V1Envelope<string>>(payload: unknown, kind: T["kind"]): T {
    if (typeof payload !== "object" || payload === null) {
        throw new ApiVersionError(`expected a ${kind} object`);
    }
    const envelope = payload as { apiVersion?: unknown; kind?: unknown };
    if (envelope.apiVersion !== API_VERSION_V1) {
        throw new ApiVersionError(
            `unsupported apiVersion ${JSON.stringify(envelope.apiVersion)}; this server speaks ${SUPPORTED_API_VERSIONS.join(", ")}`,
            envelope.apiVersion,
        );
    }
    if (envelope.kind !== kind) {
        throw new ApiVersionError(`expected kind ${kind}, got ${JSON.stringify(envelope.kind)}`);
    }
    return payload as T;
}

function isLabel(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_LABEL_LENGTH;
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** `value` cut to `MAX_REPORTED_TEXT_LENGTH`, or `undefined` when it isn't text. */
function reportedText(value: unknown): string | undefined {
    return typeof value === "string" ? value.slice(0, MAX_REPORTED_TEXT_LENGTH) : undefined;
}

/**
 * Answers a controller's `Handshake`: the best version in `supported` (the server's order) that the controller also lists, or `compatible: false` with
 * the reason when there is none. A body that isn't a `Handshake` is a `DnsApiPayloadError`.
 */
export function negotiateHandshake(body: unknown, serverVersion: string, supported: readonly string[] = SUPPORTED_API_VERSIONS): HandshakeResult {
    const handshake = (typeof body === "object" && body !== null ? body : {}) as Partial<Record<keyof Handshake, unknown>>;
    if (
        handshake.kind !== "Handshake" ||
        !isLabel(handshake.controllerVersion) ||
        !Array.isArray(handshake.apiVersions) ||
        handshake.apiVersions.length > MAX_HANDSHAKE_VERSIONS ||
        !handshake.apiVersions.every(isLabel)
    ) {
        throw new DnsApiPayloadError("expected a Handshake: kind, controllerVersion and a list of apiVersions");
    }
    const controller: string[] = handshake.apiVersions;
    const selected: string | undefined = supported.find((version) => controller.includes(version));
    if (!selected) {
        return {
            kind: "HandshakeResult",
            serverVersion,
            apiVersions: [...supported],
            compatible: false,
            reason: `no API version in common: the controller speaks ${controller.join(", ") || "none"}, the server ${supported.join(", ")}`,
        };
    }
    return { kind: "HandshakeResult", serverVersion, apiVersions: [...supported], compatible: true, selected };
}

/** `value` as a list of at most `MAX_REPORT_ENTRIES` entries, each read by `read`, or a `DnsApiPayloadError` naming `field`. */
function list<T>(value: unknown, field: string, read: (entry: Record<string, unknown>) => T | undefined): T[] {
    if (!Array.isArray(value) || value.length > MAX_REPORT_ENTRIES) {
        throw new DnsApiPayloadError(`'${field}' must be a list`);
    }
    return value.map((entry) => {
        const parsed: T | undefined = typeof entry === "object" && entry !== null ? read(entry as Record<string, unknown>) : undefined;
        if (parsed === undefined) {
            throw new DnsApiPayloadError(`an entry of '${field}' is malformed`);
        }
        return parsed;
    });
}

/**
 * Reads a controller's `StatusReport`: the envelope (`ApiVersionError` for another version or kind), then every field this version defines
 * (`DnsApiPayloadError` for a malformed one, so half a report is never stored). Unknown fields are left out; messages are cut to
 * `MAX_REPORTED_TEXT_LENGTH`.
 */
export function parseStatusReport(payload: unknown): StatusReportV1 {
    const report = expectV1<StatusReportV1>(payload, "StatusReport") as unknown as Record<string, unknown>;
    if (!isLabel(report.controllerVersion)) {
        throw new DnsApiPayloadError("'controllerVersion' must be text");
    }
    if (report.desiredStateVersion !== undefined && !isCount(report.desiredStateVersion)) {
        throw new DnsApiPayloadError("'desiredStateVersion' must be a whole number");
    }
    const lease = report.lease as Record<string, unknown> | undefined;
    if (typeof lease !== "object" || lease === null || typeof lease.holder !== "boolean" || !isLabel(lease.identity)) {
        throw new DnsApiPayloadError("'lease' must say whether the controller holds the Lease, and its identity");
    }
    const providers: ProviderStatusV1[] = list(report.providers, "providers", (entry) => {
        if (!isLabel(entry.providerUid) || !isCount(entry.readyReplicas)) {
            return undefined;
        }
        const status: ProviderStatusV1 = { providerUid: entry.providerUid, readyReplicas: entry.readyReplicas };
        if (typeof entry.image === "string" && entry.image.length <= MAX_IMAGE_LENGTH) {
            status.image = entry.image;
        }
        if (typeof entry.lastSyncAt === "string" && !Number.isNaN(Date.parse(entry.lastSyncAt))) {
            status.lastSyncAt = entry.lastSyncAt;
        }
        const lastError: string | undefined = reportedText(entry.lastError);
        if (lastError !== undefined) {
            status.lastError = lastError;
        }
        return status;
    });
    const endpoints: EndpointStatusV1[] = list(report.endpoints, "endpoints", (entry) => {
        if (!isLabel(entry.endpointSetId) || !isCount(entry.generation) || (entry.observedGeneration !== undefined && !isCount(entry.observedGeneration))) {
            return undefined;
        }
        const status: EndpointStatusV1 = { endpointSetId: entry.endpointSetId, generation: entry.generation };
        if (entry.observedGeneration !== undefined) {
            status.observedGeneration = entry.observedGeneration;
        }
        return status;
    });
    const operations: OperationStatusV1[] = list(report.operations, "operations", (entry) => {
        if (!isLabel(entry.id) || (entry.state !== "running" && entry.state !== "succeeded" && entry.state !== "failed")) {
            return undefined;
        }
        const status: OperationStatusV1 = { id: entry.id, state: entry.state };
        const message: string | undefined = reportedText(entry.message);
        if (message !== undefined) {
            status.message = message;
        }
        return status;
    });
    const parsed: StatusReportV1 = {
        apiVersion: API_VERSION_V1,
        kind: "StatusReport",
        controllerVersion: report.controllerVersion,
        lease: { holder: lease.holder, identity: lease.identity },
        providers,
        endpoints,
        operations,
    };
    if (report.desiredStateVersion !== undefined) {
        parsed.desiredStateVersion = report.desiredStateVersion;
    }
    return parsed;
}
