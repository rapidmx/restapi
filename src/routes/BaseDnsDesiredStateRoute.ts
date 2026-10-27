///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The consuming application must apply `@Route("/internal/dns")` to its own concrete subclass, outside the public Gateway like `/internal/mta` - every
// method here is defined relative to that.
import * as crypto from "crypto";
import { ApiError, ObjectDecorators } from "@rapidrest/core";
import { ApiErrorMessages, ApiErrors, HttpRequest, HttpResponse, ObjectFactory, RepoUtils, RouteDecorators } from "@rapidrest/service-core";
import {
    buildDesiredState,
    DEFAULT_EXTERNAL_DNS_IMAGE,
    DEFAULT_PUBLISH_TTL,
    domainEndpointSetId,
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
    type HandshakeResult,
    type StatusReportResultV1,
    type StatusReportV1,
} from "../dns/DnsDesiredStateApiV1.js";
import type { DnsControllerTokenVerifier } from "../dns/DnsControllerTokenVerifier.js";
import { resolveDnsPublisher, type DnsPublisher } from "../dns/DnsPublisher.js";
import { findOrCreateDeploymentIdentity } from "../util/DeploymentIdentityUtils.js";
import { autodiscoverHostnameFor, DEFAULT_LONG_POLL_SECONDS, DNS_CONTROLLER_STATE_UID, dnsOwnerId, findAllRows } from "../util/DnsPublishingUtils.js";
import { asEntity } from "../util/EntityUtils.js";
import { findOrCreateSingleton } from "../util/MailboxPolicyUtils.js";
import { DeploymentIdentity, DnsControllerState, DnsOperation, DnsProvider, DnsProviderStatus, DnsPublicationStatus, Domain } from "../models/types.js";
const { Config, Init, Logger } = ObjectDecorators;
const { Get, Post, Put, Query, Request, Response } = RouteDecorators;

/** A provider config's status is rewritten when only its report time moved, but no more often than this: what keeps a status report every minute from
 * bumping the row's version (and failing an admin's edit made meanwhile) every minute. */
const PROVIDER_STATUS_REFRESH_MS = 5 * 60 * 1000;

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
 * - `GET /v1/desired-state?since=<version>`: the provider configs (credentials only as references), every domain's and the deployment hosts' records,
 * the external-dns owner id and image, and the queued operations. With `since`, a long poll answering as soon as the version moves away from it
 * (`DnsPublisher`), or after `mail:dns:desired_state:long_poll_seconds`.
 * - `PUT /v1/status`: the controller's report - per provider config (`DnsProvider.status`), per endpoint set (`Domain.dnsPublication`), per operation,
 * and its Lease. Only the Lease holder's report changes rows; another pod's is kept apart (`lastStandbyReport`).
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

    protected providerRepo?: RepoUtils<DnsProvider>;
    protected domainRepo?: RepoUtils<Domain>;
    protected operationRepo?: RepoUtils<DnsOperation>;
    protected identityRepo?: RepoUtils<DeploymentIdentity>;
    protected controllerStateRepo?: RepoUtils<DnsControllerState>;

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
        await this.applyOperationStatus(report, now);
        await this.recordControllerState({ lastReport: summary });
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
