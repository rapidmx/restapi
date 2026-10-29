///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/internal/dns")` to its own concrete subclass, outside the public Gateway like `/internal/mta` - every
// method here is defined relative to that.
import * as crypto from "crypto";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, HttpResponse, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import { planAutomaticTakeovers, type PlannedTakeover } from "../dns/DnsAutoTakeover.js";
import {
    buildDesiredState,
    DEFAULT_EXTERNAL_DNS_IMAGE,
    DEFAULT_PUBLISH_TTL,
    domainEndpointSetId,
    hostsEndpointSetId,
    normalizePublicAddresses,
    normalizePublishHosts,
    type PublishHost,
} from "../dns/DnsDesiredState.js";
import {
    API_VERSION_V1,
    ApiVersionError,
    negotiateHandshake,
    parseStatusReport,
    SUPPORTED_API_VERSIONS,
    type DesiredStateV1,
    type DnsProviderCredentialsV1,
    type HandshakeResult,
    type EndpointStatusV1,
    type StatusReportResultV1,
    type StatusReportV1,
} from "../dns/DnsDesiredStateApiV1.js";
import type { DnsControllerTokenVerifier } from "../dns/DnsControllerTokenVerifier.js";
import { noConfigCipher, openDnsCredentials, savedCredentialKeys, type OpenedDnsCredentials } from "../dns/DnsProviderCredentials.js";
import { notifyDnsPublisher, resolveDnsPublisher, type DnsPublisher } from "../dns/DnsPublisher.js";
import type { DnsResolver } from "../dns/DnsResolver.js";
import type { ConfigCipher } from "../secrets/ConfigCipher.js";
import { findOrCreateDeploymentIdentity } from "../util/DeploymentIdentityUtils.js";
import { AuditLogUtils } from "../util/AuditLogUtils.js";
import {
    autodiscoverHostnameFor,
    DEFAULT_LONG_POLL_SECONDS,
    DNS_CONTROLLER_STATE_UID,
    dnsOwnerId,
    findAllRows,
    findDnsOwnerId,
    liveRecordValues,
    queueDnsOperation,
} from "../util/DnsPublishingUtils.js";
import { DEFAULT_ACCEPT_LEGACY_APEX } from "../util/DomainVerificationUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { findOrCreateSingleton } from "../util/MailboxPolicyUtils.js";
import { isDuplicateKeyError } from "../util/RequestBodyUtils.js";
import { AuditAction, DeploymentIdentity, DnsControllerState, DnsOperation, DnsProvider, DnsProviderStatus, DnsPublicationStatus, Domain } from "../models/types.js";
const { Config, Init, Inject, Logger } = ObjectDecorators;
const { Get, Param, Post, Put, Query, Request, Response } = RouteDecorators;

/** A provider config's status is rewritten when only its report time moved, but no more often than this: what keeps a status report every minute from
 * bumping the row's version (and failing an admin's edit made meanwhile) every minute. */
const PROVIDER_STATUS_REFRESH_MS = 5 * 60 * 1000;

/** The shortest time between two looks at the conflicts for an automatic takeover, unless a report arrives while one runs (`mail:dns:takeover:min_interval_seconds`). */
const DEFAULT_TAKEOVER_MIN_INTERVAL_SECONDS = 60;

/** How long a domain or host set found with nothing to take over is not looked at again while its endpoint stays as it is (`mail:dns:takeover:recheck_seconds`): what a
 * record added at the DNS host behind the endpoint's back waits for, since nothing else tells the server about it. */
const DEFAULT_TAKEOVER_RECHECK_SECONDS = 6 * 60 * 60;

/** The endpoints a status report said external-dns has observed (at their current generation), by endpoint set id. */
type ObservedEndpoints = ReadonlySet<string>;

/** What one status report said of the endpoint sets, kept for the scan it starts: the generation of each set, as a scan that runs for minutes must record what
 * it looked at under the generation it was told was observed, not under one a later report brought. */
type ReportedGenerations = ReadonlyMap<string, number>;

/** The report a scan is made for. */
interface TakeoverScanRequest {
    observed: ObservedEndpoints;
    generations: ReportedGenerations;
}

/** `res` answering 400 with `body`, the shape the controller reads a refusal from. */
function refuse(res: HttpResponse, body: Record<string, unknown>): HttpResponse {
    res.status(400).json(body);
    return res;
}

/** `value` without `reportedAt`, to tell a status that changed from one that was only reported again. */
function withoutReportedAt(status: DnsProviderStatus | null | undefined): string {
    const { reportedAt: _reportedAt, ...rest } = status ?? {};
    return JSON.stringify(rest);
}

/**
 * The DNS controller's internal API (spec 7.3), mounted by the server under `/internal/dns`. The controller is the only RapidMX component that writes to
 * Kubernetes; it reads what to publish from here and reports back here:
 *
 * - `POST /handshake` (unversioned, frozen): the controller lists the API versions it speaks; the answer selects the best one both speak, or says they
 * share none. What the controller said is recorded (`DnsControllerState`) so the console can show a mismatch.
 * - `GET /v1/desired-state?since=<version>`: the provider configs (credentials only as the names of their fields and a generation), every domain's and the deployment hosts' records,
 * the external-dns owner id and image, and the queued operations. With `since`, a long poll answering as soon as the version moves away from it
 * (`DnsPublisher`), or after `mail:dns:desired_state:long_poll_seconds`.
 * - `GET /v1/providers/:uid/credentials`: one provider config's credentials, decrypted (spec 5.4), for the controller to write the Secret its external-dns
 * instance reads. Answered to the controller's token only, with `Cache-Control: no-store`; logged with the provider and generation only, never audited per call.
 * - `PUT /v1/status`: the controller's report - per provider config (`DnsProvider.status`), per endpoint set (`Domain.dnsPublication`), per operation,
 * and its Lease. Only the Lease holder's report changes rows; another pod's is kept apart (`lastStandbyReport`). It is also what drives the
 * **automatic takeover**: after applying a Lease holder's report, the server queues a takeover of the records in conflict for every provider config that
 * allows it (`planAutomaticTakeovers()`), in the background so the report is answered at once. This is the place that sees conflicts: the report is the one
 * periodic, serialized signal that the controller is alive (a takeover can't run without it) and that external-dns has observed an endpoint (a conflict
 * counts only once it has tried to publish), so no second job on every replica has to agree on "at most once".
 *
 * **Access:** only the DNS controller. It presents its projected ServiceAccount token (`Authorization: Bearer`, audience `rapidmx-internal-dns`); the
 * registered `DnsControllerTokenVerifier` verifies it against the cluster's keys, and its subject must be exactly `mail:dns:controller:subject`. With
 * no verifier registered or no subject configured, every call is refused (403): fail closed, never into an unauthenticated internal endpoint. A user's
 * JWT is no controller token.
 *
 * **Versions:** every v1 payload carries `apiVersion` and `kind`; one this server doesn't speak is answered `400 { reason: "unsupported_api_version",
 * supported }`, which sends the controller back to the handshake.
 *
 * @author Jean-Philippe Steinmetz
 */
export abstract class BaseDnsDesiredStateRoute {
    protected abstract dnsProviderClass: any;
    protected abstract domainClass: any;
    protected abstract dnsOperationClass: any;
    protected abstract deploymentIdentityClass: any;
    protected abstract dnsControllerStateClass: any;

    /** Supplied by the Mongo/SQL concrete subclasses so an automatic takeover is audited; without it none is queued. */
    protected auditLogClass?: any;

    // Automatically injected by ObjectFactory on instantiation
    private _objectFactory?: ObjectFactory;

    @Logger
    private logger: any;

    /** The server's own version, reported in the handshake. */
    @Config("version", "")
    private serverVersion: string = "";

    /** The one ServiceAccount whose token is accepted: `system:serviceaccount:<namespace>:<fullname>-dns-controller`. Empty refuses every call. */
    @Config("mail:dns:controller:subject", "")
    private controllerSubject: string = "";

    @Config("mail:dns:desired_state:long_poll_seconds", DEFAULT_LONG_POLL_SECONDS)
    private longPollSeconds: number = DEFAULT_LONG_POLL_SECONDS;

    @Config("mail:dns:publish:ttl", DEFAULT_PUBLISH_TTL)
    private publishTtlSeconds: number = DEFAULT_PUBLISH_TTL;

    /** The deployment's own hosts, rendered by the chart from what it serves (a list or its JSON string of `{ name, type, target? }`). */
    @Config("mail:dns:publish:hosts", [])
    private publishHosts: unknown = [];

    /** The public addresses the mail host's A/AAAA records point at (a list or its JSON string); only global unicast ones are used. */
    @Config("mail:dns:publish:addresses", [])
    private publicAddresses: unknown = [];

    /** The one external-dns image the controller may run, pinned by the chart. */
    @Config("mail:dns:publish:external_dns_image", DEFAULT_EXTERNAL_DNS_IMAGE)
    private externalDnsImage: string = DEFAULT_EXTERNAL_DNS_IMAGE;

    @Config("mail:dns:mx_hostname", "")
    private mxHostname: string = "";

    @Config("mail:autodiscover:public_url", "")
    private autodiscoverPublicUrl: string = "";

    /** Whether a verification token at a domain's root still counts (`mail:domain_verification:accept_legacy_apex`): the ownership record is judged the same way. */
    @Config("mail:domain_verification:accept_legacy_apex", DEFAULT_ACCEPT_LEGACY_APEX)
    private acceptLegacyApex: boolean = DEFAULT_ACCEPT_LEGACY_APEX;

    @Config("mail:dns:takeover:min_interval_seconds", DEFAULT_TAKEOVER_MIN_INTERVAL_SECONDS)
    private takeoverMinIntervalSeconds: number = DEFAULT_TAKEOVER_MIN_INTERVAL_SECONDS;

    @Config("mail:dns:takeover:recheck_seconds", DEFAULT_TAKEOVER_RECHECK_SECONDS)
    private takeoverRecheckSeconds: number = DEFAULT_TAKEOVER_RECHECK_SECONDS;

    /** Looks up the live records an automatic takeover judges conflicts by. */
    @Inject("DnsResolver")
    private dnsResolver?: DnsResolver;

    protected providerRepo?: RepoUtils<DnsProvider>;
    protected domainRepo?: RepoUtils<Domain>;
    protected operationRepo?: RepoUtils<DnsOperation>;
    protected identityRepo?: RepoUtils<DeploymentIdentity>;
    protected controllerStateRepo?: RepoUtils<DnsControllerState>;
    protected auditLogRepo?: RepoUtils<any>;
    protected auditLogUtils?: AuditLogUtils;

    /** The automatic takeover looking at conflicts right now, if one is. */
    private takeoverScan?: Promise<void>;

    /** What a report asked to be looked at while a scan was running: looked at once it ends. */
    private pendingTakeoverScan?: TakeoverScanRequest;

    private lastTakeoverScanAt: number = 0;

    /** The generation of each endpoint set in the latest report of the Lease holder. */
    private reportedGenerations: Map<string, number> = new Map();

    /** What the last look found for each set of a provider config (`<provider uid>/<set id>`): the generation it looked at, when, and whether a record was in
     * conflict. A set found clean at the generation the controller still reports is not looked at again before `takeoverRecheckSeconds`; one in conflict is, on
     * every look, until a takeover has cleared it. Kept per copy: only the copy that was sent the report looks, and a restart looks at everything once. */
    private takeoverLooks: Map<string, { generation: number | undefined; at: number; conflict: boolean }> = new Map();

    /** Decrypts the credentials the controller asks for; unset on a server that registers none (a config with credentials is then answered 503). */
    @Inject("ConfigCipher")
    protected cipher?: ConfigCipher;

    /** The credential fields already logged as unreadable (`<provider uid>/<field>`), so the controller asking again every pass doesn't fill the log. */
    private readonly warnedUnreadable: Set<string> = new Set();

    /** Verifies the controller's token; unset (every call refused) on a server that registers none. */
    protected tokenVerifier?: DnsControllerTokenVerifier;

    protected dnsPublisher?: DnsPublisher;

    /** Whether the configuration's invalid hosts and refused addresses were logged yet (once per process). */
    private configWarned: boolean = false;

    @Init
    protected async initialize(): Promise<void> {
        if (!this._objectFactory) {
            throw new Error("objectFactory is not set.");
        }
        const repo = async (cls: any): Promise<RepoUtils<any> | undefined> =>
            cls ? await this._objectFactory!.newInstance(RepoUtils, { name: cls.name, args: [cls] }) : undefined;
        this.providerRepo ??= await repo(this.dnsProviderClass);
        this.domainRepo ??= await repo(this.domainClass);
        this.operationRepo ??= await repo(this.dnsOperationClass);
        this.identityRepo ??= await repo(this.deploymentIdentityClass);
        this.controllerStateRepo ??= await repo(this.dnsControllerStateClass);
        this.auditLogRepo ??= await repo(this.auditLogClass);
        if (!this.auditLogUtils && this.auditLogRepo) {
            this.auditLogUtils = await this._objectFactory.newInstance(AuditLogUtils, { name: this.auditLogClass.name, args: [this.auditLogRepo] });
        }
        if (!this.tokenVerifier) {
            try {
                this.tokenVerifier = await this._objectFactory.newInstance<DnsControllerTokenVerifier>("DnsControllerTokenVerifier", { name: "default" });
            } catch (err: any) {
                this.logger?.warn(`No DnsControllerTokenVerifier is registered, so every DNS controller call is refused: ${err?.message}`);
            }
        }
        this.dnsPublisher ??= await resolveDnsPublisher(this._objectFactory, this.logger);
    }

    /** Refuses (403) any caller but the DNS controller's ServiceAccount, with the same answer whatever the reason, so a caller learns nothing. */
    private async authorize(req: HttpRequest): Promise<void> {
        const forbidden = (): ApiError => new ApiError(ApiErrors.AUTH_PERMISSION_FAILURE, 403, ApiErrorMessages.AUTH_PERMISSION_FAILURE);
        const header: string | string[] | undefined = req.headers["authorization"];
        const match: RegExpMatchArray | null | undefined = (Array.isArray(header) ? header[0] : header)?.match(/^Bearer\s+(\S+)$/i);
        if (!match || !this.tokenVerifier || !this.controllerSubject) {
            throw forbidden();
        }
        let subject: string;
        try {
            subject = (await this.tokenVerifier.verify(match[1])).subject;
        } catch {
            throw forbidden();
        }
        const presented: Buffer = Buffer.from(String(subject));
        const expected: Buffer = Buffer.from(this.controllerSubject);
        if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
            throw forbidden();
        }
    }

    /** Updates the controller-state singleton with `patch`, best effort: what the controller said is shown in the console, never needed to serve it. */
    private async recordControllerState(patch: Partial<DnsControllerState>): Promise<void> {
        if (!this.controllerStateRepo) {
            return;
        }
        try {
            const state: DnsControllerState = await findOrCreateSingleton(this.controllerStateRepo, DNS_CONTROLLER_STATE_UID);
            await this.controllerStateRepo.update({ uid: state.uid, version: state.version, ...patch }, asEntity(this.controllerStateRepo, state), {
                version: state.version,
                ignoreACL: true,
            });
        } catch (err: any) {
            this.logger?.warn(`Could not record what the DNS controller reported: ${err?.message}`);
        }
    }

    /**
     * The start-up compatibility check. Answers with the best version both sides speak (`compatible: true, selected`), or `compatible: false` with the
     * reason - and records what the controller said either way, so the console and Diagnostics can show "DNS controller 0.4.0 speaks
     * dns.rapidmx.io/v2; this server speaks v1".
     */
    @Post("/handshake")
    public async handshake(body: unknown, @Request req: HttpRequest, @Response res: HttpResponse): Promise<HandshakeResult | HttpResponse> {
        await this.authorize(req);
        let result: HandshakeResult;
        try {
            result = negotiateHandshake(body, this.serverVersion);
        } catch (err: any) {
            // Only a `DnsApiPayloadError`, whose message names what is missing, never a value.
            return refuse(res, { reason: "invalid_payload", message: err?.message });
        }
        const handshake = body as { controllerVersion: string; apiVersions: string[] };
        await this.recordControllerState({
            handshake: {
                controllerVersion: handshake.controllerVersion,
                apiVersions: [...handshake.apiVersions],
                compatible: result.compatible,
                ...(result.selected ? { selected: result.selected } : {}),
                ...(result.reason ? { reason: result.reason } : {}),
                at: new Date(),
            },
        });
        if (!result.compatible) {
            this.logger?.error(`dns_api_incompatible: ${result.reason}`);
        }
        return result;
    }

    /** What the configured hosts and addresses come to, logging (once) what was left out. */
    private publishConfig(): { hosts: PublishHost[]; addresses: string[] } {
        const { hosts, invalid } = normalizePublishHosts(this.publishHosts);
        const { addresses, refused } = normalizePublicAddresses(this.publicAddresses);
        if (!this.configWarned && (invalid > 0 || refused.length > 0)) {
            this.configWarned = true;
            if (invalid > 0) {
                this.logger?.warn(`${invalid} entr${invalid === 1 ? "y" : "ies"} of mail:dns:publish:hosts were invalid and are not published.`);
            }
            if (refused.length > 0) {
                this.logger?.warn(`mail:dns:publish:addresses holds addresses that are not global unicast, which are not published: ${refused.join(", ")}`);
            }
        }
        return { hosts, addresses };
    }

    /**
     * The desired state. With `since`, a long poll: while the version is still `since` it waits for a change (`DnsPublisher.waitForChange()`) or for
     * `mail:dns:desired_state:long_poll_seconds`, whichever comes first, and stops waiting when the controller goes away. A version behind `since` (the
     * counter was reset: Redis restarted without persistence, a rebuilt server) is answered at once, so the controller learns of the new count instead
     * of waiting out every poll until the counter climbs past its own again. The version is read before the rows, so a change landing meanwhile is in this
     * answer or wakes the next poll at once.
     */
    @Get("/v1/desired-state")
    public async desiredState(
        @Query("since") since: string | undefined,
        @Request req: HttpRequest,
        @Response res: HttpResponse,
    ): Promise<DesiredStateV1 | HttpResponse> {
        await this.authorize(req);
        let after: number | undefined;
        if (since !== undefined) {
            if (!/^\d{1,15}$/.test(String(since))) {
                return refuse(res, { reason: "invalid_payload", message: "'since' must be a desired-state version" });
            }
            after = Number(since);
        }
        let version: number = await this.dnsPublisher!.version();
        if (after !== undefined && version === after) {
            const abort: AbortController = new AbortController();
            res.onFinish?.(() => abort.abort());
            version = await this.dnsPublisher!.waitForChange(after, this.longPollSeconds * 1000, abort.signal);
        }

        const identity: DeploymentIdentity = await findOrCreateDeploymentIdentity(this.identityRepo!);
        const [providers, domains, queued, running] = await Promise.all([
            findAllRows<DnsProvider>(this.providerRepo!),
            findAllRows<Domain>(this.domainRepo!),
            findAllRows<DnsOperation>(this.operationRepo!, { state: "queued" }),
            findAllRows<DnsOperation>(this.operationRepo!, { state: "running" }),
        ]);
        const operations: DnsOperation[] = [...queued, ...running].sort((a, b) => new Date(a.dateCreated ?? 0).getTime() - new Date(b.dateCreated ?? 0).getTime());
        return buildDesiredState({
            version,
            ownerId: dnsOwnerId(identity),
            externalDnsImage: this.externalDnsImage,
            providers,
            domains,
            operations,
            ...this.publishConfig(),
            context: { mxHostname: this.mxHostname, autodiscoverHostname: autodiscoverHostnameFor(this.autodiscoverPublicUrl), ttl: this.publishTtlSeconds },
        });
    }

    /**
     * One provider config's credentials, decrypted, for the controller to write the one Secret its external-dns instance reads (spec 5.4: not kept, decrypted
     * only to answer this, which the controller asks only when the config's generation moves or its Secret is missing). The controller's token only; 404
     * for a config that is gone; empty `values` for one without credentials. A credential that can't be decrypted is left out and named in `unreadable`,
     * so the controller keeps the Secret it has rather than writing half of one. Never cached, and logged with the provider and generation alone: a
     * value appears in no log line, audit entry or error, and a call is no audit event.
     */
    @Get("/v1/providers/:uid/credentials")
    public async providerCredentials(@Param("uid") uid: string, @Request req: HttpRequest, @Response res: HttpResponse): Promise<DnsProviderCredentialsV1> {
        await this.authorize(req);
        const provider: DnsProvider | undefined = await this.providerRepo!.findOne(uid, { ignoreACL: true, skipCache: true });
        if (!provider) {
            throw new ApiError(ApiErrors.NOT_FOUND, 404, ApiErrorMessages.NOT_FOUND);
        }
        let opened: OpenedDnsCredentials = { values: {}, unreadable: [] };
        if (savedCredentialKeys(provider.credentials).length > 0) {
            if (!this.cipher) {
                throw noConfigCipher();
            }
            opened = openDnsCredentials(this.cipher, provider);
        }
        const generation: number = provider.credentialsGeneration ?? 0;
        for (const field of opened.unreadable) {
            if (!this.warnedUnreadable.has(`${provider.uid}/${field}`)) {
                this.warnedUnreadable.add(`${provider.uid}/${field}`);
                this.logger?.warn(`The credential '${field}' of DNS provider '${provider.uid}' can't be read (its key isn't in the keyring, or it was changed): enter it again.`);
            }
        }
        this.logger?.info(`Served the credentials of DNS provider '${provider.uid}' at generation ${generation} to the DNS controller.`);
        res.setHeader("cache-control", "no-store");
        return {
            apiVersion: API_VERSION_V1,
            kind: "DnsProviderCredentials",
            providerUid: provider.uid,
            generation,
            values: opened.values,
            ...(opened.unreadable.length > 0 ? { unreadable: opened.unreadable } : {}),
        };
    }

    /**
     * The controller's status report: each provider config's instance (`DnsProvider.status`), each domain's endpoint (`Domain.dnsPublication.endpoints`,
     * what the checklist's "published" is judged by), each operation's result, and the controller's own version and Lease. Rows are only written when
     * what they hold changes (a provider's status at most every few minutes otherwise), so a report every minute doesn't race the admin's edits. Entries
     * naming a config, endpoint set or operation that no longer exists are ignored; a finished operation is never reopened.
     *
     * Only the Lease holder acts, so only its report changes rows and `lastReport`. A pod that doesn't hold the Lease (a stuck old one during a rollout,
     * a new one waiting for it) may still report what it last saw; that is recorded as `lastStandbyReport`, so the console can show it, and changes
     * nothing else: two reporters taking turns would flip the status back and forth and bump row versions under the admin's edits.
     */
    @Put("/v1/status")
    public async status(body: unknown, @Request req: HttpRequest, @Response res: HttpResponse): Promise<StatusReportResultV1 | HttpResponse> {
        await this.authorize(req);
        let report: StatusReportV1;
        try {
            report = parseStatusReport(body);
        } catch (err: any) {
            if (err instanceof ApiVersionError) {
                return refuse(res, { reason: "unsupported_api_version", supported: [...SUPPORTED_API_VERSIONS] });
            }
            // A `DnsApiPayloadError`, whose message names the field, never a value.
            return refuse(res, { reason: "invalid_payload", message: err?.message });
        }
        const now: Date = new Date();
        const summary: NonNullable<DnsControllerState["lastReport"]> = {
            controllerVersion: report.controllerVersion,
            ...(report.desiredStateVersion !== undefined ? { desiredStateVersion: report.desiredStateVersion } : {}),
            leaseHolder: report.lease.holder,
            leaseIdentity: report.lease.identity,
            at: now,
        };
        if (!report.lease.holder) {
            await this.recordControllerState({ lastStandbyReport: summary });
            return { apiVersion: API_VERSION_V1, kind: "StatusReportResult" };
        }
        await this.applyProviderStatus(report, now);
        await this.applyEndpointStatus(report, now);
        await this.applyHostsEndpointStatus(report);
        await this.applyOperationStatus(report, now);
        await this.recordControllerState({ lastReport: summary });
        this.requestTakeoverScan(report);
        return { apiVersion: API_VERSION_V1, kind: "StatusReportResult" };
    }

    /** Runs `write`, logging (not failing the report) when it loses a race or the row is gone: the next report carries the same news. */
    private async bestEffort(what: string, write: () => Promise<unknown>): Promise<void> {
        try {
            await write();
        } catch (err: any) {
            this.logger?.warn(`Could not record the DNS controller's status of ${what}: ${err?.message}`);
        }
    }

    private async applyProviderStatus(report: StatusReportV1, now: Date): Promise<void> {
        for (const entry of report.providers) {
            const provider: DnsProvider | undefined = await this.providerRepo!.findOne(entry.providerUid, { ignoreACL: true, skipCache: true });
            if (!provider) {
                continue;
            }
            const status: DnsProviderStatus = { reportedAt: now, readyReplicas: entry.readyReplicas };
            // The hosts' endpoint is written apart (`applyHostsEndpointStatus()`); this rewrite of the instance's status keeps it.
            if (provider.status?.hostsEndpoint) {
                status.hostsEndpoint = provider.status.hostsEndpoint;
            }
            if (entry.image !== undefined) {
                status.image = entry.image;
            }
            if (entry.lastSyncAt !== undefined) {
                status.lastSyncAt = new Date(entry.lastSyncAt);
            }
            if (entry.lastError !== undefined) {
                status.lastError = entry.lastError;
            }
            const reportedAt: number = provider.status?.reportedAt ? new Date(provider.status.reportedAt).getTime() : 0;
            if (withoutReportedAt(provider.status) === withoutReportedAt(status) && now.getTime() - reportedAt < PROVIDER_STATUS_REFRESH_MS) {
                continue;
            }
            await this.bestEffort(`DNS provider '${provider.uid}'`, () =>
                this.providerRepo!.update({ uid: provider.uid, version: provider.version, status }, asEntity(this.providerRepo!, provider), {
                    version: provider.version,
                    ignoreACL: true,
                }),
            );
        }
    }

    private async applyEndpointStatus(report: StatusReportV1, now: Date): Promise<void> {
        const reported: Map<string, StatusReportV1["endpoints"][number]> = new Map(report.endpoints.map((entry) => [entry.endpointSetId, entry]));
        if (reported.size === 0) {
            return;
        }
        const domains: Domain[] = await findAllRows<Domain>(this.domainRepo!);
        for (const domain of domains) {
            const id: string = domainEndpointSetId(domain.uid);
            const entry = reported.get(id);
            if (!entry || !domain.dnsProviderUid) {
                continue;
            }
            const endpoint: DnsPublicationStatus["endpoints"][number] = { name: id, generation: entry.generation };
            if (entry.observedGeneration !== undefined) {
                endpoint.observedGeneration = entry.observedGeneration;
            }
            if (JSON.stringify(domain.dnsPublication?.endpoints ?? []) === JSON.stringify([endpoint])) {
                continue;
            }
            const dnsPublication: DnsPublicationStatus = { ...(domain.dnsPublication ?? {}), endpoints: [endpoint], records: domain.dnsPublication?.records ?? [], lastReconciledAt: now };
            await this.bestEffort(`domain '${domain.uid}'`, () =>
                this.domainRepo!.update({ uid: domain.uid, version: domain.version, dnsPublication }, asEntity(this.domainRepo!, domain), {
                    version: domain.version,
                    ignoreACL: true,
                }),
            );
        }
    }

    /** Records, on each provider config, the generation external-dns observed of its hosts' endpoint (`hosts-<uid>`), which `GET system/dns-providers/hosts` judges
     * "published" by. Written only when it changed, so a report every minute doesn't bump the row's version. */
    private async applyHostsEndpointStatus(report: StatusReportV1): Promise<void> {
        const reported: Map<string, EndpointStatusV1> = new Map(report.endpoints.map((entry) => [entry.endpointSetId, entry]));
        const reporting: Set<string> = new Set(report.providers.map((entry) => entry.providerUid));
        if (reported.size === 0 && reporting.size === 0) {
            return;
        }
        for (const provider of await findAllRows<DnsProvider>(this.providerRepo!)) {
            const name: string = hostsEndpointSetId(provider.uid);
            const entry: EndpointStatusV1 | undefined = reported.get(name);
            if (!entry) {
                // The provider reports but its hosts' set is gone: forget what was observed of it, so a set that comes back (its generation starting lower)
                // isn't judged by the old one.
                if (provider.status?.hostsEndpoint && reporting.has(provider.uid)) {
                    const { hostsEndpoint: _gone, ...status } = provider.status;
                    await this.bestEffort(`DNS provider '${provider.uid}'`, () =>
                        this.providerRepo!.update({ uid: provider.uid, version: provider.version, status }, asEntity(this.providerRepo!, provider), {
                            version: provider.version,
                            ignoreACL: true,
                        }),
                    );
                }
                continue;
            }
            const endpoint: NonNullable<DnsProviderStatus["hostsEndpoint"]> = { name, generation: entry.generation };
            if (entry.observedGeneration !== undefined) {
                endpoint.observedGeneration = entry.observedGeneration;
            }
            if (JSON.stringify(provider.status?.hostsEndpoint ?? null) === JSON.stringify(endpoint)) {
                continue;
            }
            const status: DnsProviderStatus = { ...(provider.status ?? {}), hostsEndpoint: endpoint };
            await this.bestEffort(`DNS provider '${provider.uid}'`, () =>
                this.providerRepo!.update({ uid: provider.uid, version: provider.version, status }, asEntity(this.providerRepo!, provider), {
                    version: provider.version,
                    ignoreACL: true,
                }),
            );
        }
    }

    /**
     * Starts looking for conflicts to take over (`queueAutomaticTakeovers()`) in the background, for the report of the Lease holder that was just applied.
     * One look runs at a time; a report that arrives while one runs is looked at once it ends, and one that arrives within
     * `mail:dns:takeover:min_interval_seconds` of the last start is skipped (the next report is a minute away). Never throws: the report is answered first.
     */
    private requestTakeoverScan(report: StatusReportV1): void {
        if (!this.auditLogUtils || !this.dnsResolver) {
            return;
        }
        const generations: Map<string, number> = new Map(report.endpoints.map((entry) => [entry.endpointSetId, entry.generation]));
        this.reportedGenerations = generations;
        const observed: Set<string> = new Set(
            report.endpoints.filter((entry) => entry.observedGeneration !== undefined && entry.observedGeneration >= entry.generation).map((entry) => entry.endpointSetId),
        );
        if (this.takeoverScan) {
            this.pendingTakeoverScan = { observed, generations };
            return;
        }
        const now: number = Date.now();
        if (now - this.lastTakeoverScanAt < this.takeoverMinIntervalSeconds * 1000) {
            return;
        }
        this.lastTakeoverScanAt = now;
        this.takeoverScan = this.runTakeoverScans({ observed, generations });
    }

    /** Looks for conflicts with `observed`, then again for whatever report arrived meanwhile. */
    private async runTakeoverScans(request: TakeoverScanRequest): Promise<void> {
        let current: TakeoverScanRequest | undefined = request;
        while (current) {
            this.pendingTakeoverScan = undefined;
            try {
                await this.queueAutomaticTakeovers(current.observed, current.generations);
            } catch (err: any) {
                this.logger?.warn(`Could not look for DNS records to take over: ${err?.message}`);
            }
            // A report that came meanwhile is looked at once the minimum interval since the last look started has passed; otherwise the next report asks again.
            current = this.pendingTakeoverScan && Date.now() - this.lastTakeoverScanAt >= this.takeoverMinIntervalSeconds * 1000 ? this.pendingTakeoverScan : undefined;
            if (current) {
                this.lastTakeoverScanAt = Date.now();
            }
        }
        this.pendingTakeoverScan = undefined;
        this.takeoverScan = undefined;
    }

    /**
     * Queues the takeovers `planAutomaticTakeovers()` plans: for every enabled provider config with `allowTakeover`, the domain records and deployment hosts in
     * conflict, once per name, type and values. Each is created under a uid derived from its records, so two servers looking at the same moment queue it once
     * (the second create is refused as a duplicate and skipped).
     */
    private async queueAutomaticTakeovers(observed: ObservedEndpoints, generations: ReportedGenerations): Promise<void> {
        const providers: DnsProvider[] = await findAllRows<DnsProvider>(this.providerRepo!);
        if (!providers.some((provider) => provider.allowTakeover && provider.enabled)) {
            return;
        }
        const ownerId: string | undefined = await findDnsOwnerId(this.identityRepo, this.logger);
        if (!ownerId) {
            return;
        }
        // Only takeovers and restores matter to the plan (what was taken over before, what is under way); tests and the like are never read.
        const [domains, takeovers, restores] = await Promise.all([
            findAllRows<Domain>(this.domainRepo!),
            findAllRows<DnsOperation>(this.operationRepo!, { type: "takeover" }),
            findAllRows<DnsOperation>(this.operationRepo!, { type: "restore" }),
        ]);
        // What was looked at of a set that is no longer reported is forgotten, so one that comes back (its generation starting lower) is looked at again.
        const looks: Map<string, { generation: number | undefined; at: number; conflict: boolean }> = new Map(
            [...this.takeoverLooks].filter(([key]) => this.reportedGenerations.has(key.slice(key.indexOf("/") + 1))),
        );
        this.takeoverLooks = looks;
        const plan: PlannedTakeover[] = await planAutomaticTakeovers({
            providers,
            domains,
            operations: [...takeovers, ...restores],
            ...this.publishConfig(),
            context: { mxHostname: this.mxHostname, autodiscoverHostname: autodiscoverHostnameFor(this.autodiscoverPublicUrl), ttl: this.publishTtlSeconds },
            resolver: this.dnsResolver!,
            ownerId,
            observed: (endpointSetId) => observed.has(endpointSetId),
            acceptLegacyApex: this.acceptLegacyApex,
            unchanged: (providerUid, endpointSetId) => {
                const look = looks.get(`${providerUid}/${endpointSetId}`);
                return !!look && !look.conflict && look.generation === this.reportedGenerations.get(endpointSetId) && Date.now() - look.at < this.takeoverRecheckSeconds * 1000;
            },
            // Under the generation of the report this scan was made for (the one it was told was observed), not the latest: a report that came meanwhile may
            // bring a generation external-dns has not read, and a look made before it must not stand for it.
            looked: (providerUid, endpointSetId, conflict) => looks.set(`${providerUid}/${endpointSetId}`, { generation: generations.get(endpointSetId), at: Date.now(), conflict }),
        });
        for (const planned of plan) {
            await this.queueTakeover(planned);
        }
    }

    /** Queues one planned takeover, audits it as the system (no user) and announces it to the controller. */
    private async queueTakeover(planned: PlannedTakeover): Promise<void> {
        let operation: DnsOperation;
        try {
            operation = await queueDnsOperation(this.operationRepo!, this.dnsOperationClass, {
                uid: planned.uid,
                type: "takeover",
                providerUid: planned.provider.uid,
                domainUid: planned.domain?.uid,
                endpointSetId: planned.endpointSetId,
                records: planned.records,
            });
        } catch (err: any) {
            // Queued already, by another server looking at the same moment.
            if (isDuplicateKeyError(err)) {
                return;
            }
            throw err;
        }
        const oldValues: string[] = (await Promise.all(planned.records.map((record) => liveRecordValues(this.dnsResolver!, record)))).flat();
        await this.auditLogUtils!.record({
            action: AuditAction.DNS_TAKEOVER,
            targetType: "DnsProvider",
            targetUid: planned.provider.uid,
            details: {
                provider: planned.provider.uid,
                ...(planned.domain ? { domain: planned.domain.name } : { hosts: true }),
                recordNames: [...new Set(planned.records.map((record) => record.dnsName))],
                oldValues,
                operation: operation.uid,
                actor: "system",
                automatic: true,
            },
        });
        this.logger?.info(
            `Queued the takeover of ${planned.records.length} record(s) of '${planned.endpointSetId}' through DNS provider '${planned.provider.uid}', which allows takeover (operation ${operation.uid}).`,
        );
        await notifyDnsPublisher(this.dnsPublisher, { scope: "operation", operationUid: operation.uid }, this.logger);
    }

    private async applyOperationStatus(report: StatusReportV1, now: Date): Promise<void> {
        for (const entry of report.operations) {
            const operation: DnsOperation | undefined = await this.operationRepo!.findOne(entry.id, { ignoreACL: true, skipCache: true });
            // A finished operation stays as it finished.
            if (!operation || (operation.state !== "queued" && operation.state !== "running")) {
                continue;
            }
            if (operation.state === entry.state && (entry.message === undefined || entry.message === operation.message)) {
                continue;
            }
            const patch: Partial<DnsOperation> = { state: entry.state };
            if (entry.message !== undefined) {
                patch.message = entry.message;
            }
            if (!operation.startedAt) {
                patch.startedAt = now;
            }
            if (entry.state !== "running") {
                patch.finishedAt = now;
            }
            await this.bestEffort(`operation '${operation.uid}'`, () =>
                this.operationRepo!.update({ uid: operation.uid, version: operation.version, ...patch }, asEntity(this.operationRepo!, operation), {
                    version: operation.version,
                    ignoreACL: true,
                }),
            );
        }
    }
}
