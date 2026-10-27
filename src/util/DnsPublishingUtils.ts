///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Shared by the routes that publish DNS records through the DNS controller: the domain route, the provider route and the controller's own internal
// API (`BaseDnsDesiredStateRoute`).
import * as crypto from "crypto";
import type { RepoUtils } from "@rapidrest/service-core";
import { domainEndpointSetId } from "../dns/DnsDesiredState.js";
import { PluginRegistry } from "../plugins/PluginRegistry.js";
import type { DeploymentIdentity, DnsOperation, DnsOperationRecord, DnsOperationState, DnsOperationType, Domain } from "../models/types.js";
import { findOrCreateDeploymentIdentity } from "./DeploymentIdentityUtils.js";
import { extractPublicHostname } from "./DomainUtils.js";

/** The fixed identifier of the one `DnsControllerState` row - same singleton convention as `DEPLOYMENT_IDENTITY_UID`. */
export const DNS_CONTROLLER_STATE_UID = "dns-controller";

/** How long the controller's desired-state long poll waits for a change before answering with the same version (`mail:dns:desired_state:long_poll_seconds`).
 * Below the 60 s most proxies and clients give up after. */
export const DEFAULT_LONG_POLL_SECONDS = 55;

/** The plugin the Autodiscover records are published for - mirrors `BaseAutodiscoverRoute`'s own gating. */
export const AUTODISCOVER_PLUGIN = "@rapidmx/autodiscover-plugin";

/** The most rows read in one page (`RepoUtils.find()`'s own ceiling). */
const PAGE_LIMIT = 1000;

/** The Autodiscover host the records point at: `undefined` while the Autodiscover plugin isn't active (no Autodiscover records at all), else the host of
 * `mail:autodiscover:public_url` (`""` while that isn't a valid URL). */
export function autodiscoverHostnameFor(publicUrl: string): string | undefined {
    return PluginRegistry.isActive(AUTODISCOVER_PLUGIN) ? extractPublicHostname(publicUrl) : undefined;
}

/** The external-dns owner id of this deployment: `rapidmx-<installationId>`. */
export function dnsOwnerId(identity: Pick<DeploymentIdentity, "installationId">): string {
    return `rapidmx-${identity.installationId}`;
}

/** This deployment's external-dns owner id, creating its identity the first time; `undefined` (logged) when it can't be read or is malformed. */
export async function findDnsOwnerId(repo: RepoUtils<DeploymentIdentity> | undefined, logger?: any): Promise<string | undefined> {
    if (!repo) {
        return undefined;
    }
    try {
        return dnsOwnerId(await findOrCreateDeploymentIdentity(repo));
    } catch (err: any) {
        logger?.error(`The deployment identity could not be read, so DNS ownership can't be judged: ${err?.message}`);
        return undefined;
    }
}

/** Every row of `repo` matching `query`, page by page in uid order. `limit`/`page` go in the query too: the SQL backend reads them only from there. */
export async function findAllRows<R>(repo: RepoUtils<any>, query: Record<string, unknown> = {}): Promise<R[]> {
    const rows: R[] = [];
    for (let page = 0; ; page++) {
        const batch: R[] = await repo.find({ ...query, sort: "uid", limit: PAGE_LIMIT, page } as any, { ignoreACL: true, limit: PAGE_LIMIT, page, skipCache: true });
        rows.push(...batch);
        if (batch.length < PAGE_LIMIT) {
            return rows;
        }
    }
}

/** Whether external-dns has observed `domain`'s current endpoint, as the controller last reported it. */
export function isDomainEndpointObserved(domain: Pick<Domain, "uid" | "dnsPublication">): boolean {
    const endpoint = domain.dnsPublication?.endpoints?.find((candidate) => candidate.name === domainEndpointSetId(domain.uid));
    return !!endpoint && endpoint.observedGeneration !== undefined && endpoint.observedGeneration >= endpoint.generation;
}

/** What a queued operation is created from. */
export interface DnsOperationRequest {
    type: DnsOperationType;
    providerUid: string;
    domainUid?: string;
    endpointSetId?: string;
    records?: DnsOperationRecord[];
    requestedBy?: string;
}

/** Queues an operation for the controller: a new `queued` row of `operationClass`. The caller announces it (`DnsPublisher`). */
export async function queueDnsOperation<T extends DnsOperation>(repo: RepoUtils<T>, operationClass: any, request: DnsOperationRequest): Promise<T> {
    const fields: Record<string, unknown> = { uid: crypto.randomUUID(), state: "queued", ...request };
    for (const key of Object.keys(fields)) {
        if (fields[key] === undefined) {
            delete fields[key];
        }
    }
    return await repo.create(new operationClass(fields), { ignoreACL: true });
}

/** The wire shape of a queued operation. */
export interface PublicDnsOperation {
    uid: string;
    type: DnsOperationType;
    providerUid: string;
    domainUid?: string;
    endpointSetId?: string;
    records?: DnsOperationRecord[];
    state: DnsOperationState;
    message?: string;
    requestedBy?: string;
    startedAt?: Date;
    finishedAt?: Date;
    dateCreated?: Date;
}

/** `operation` without its bookkeeping fields. */
export function toPublicDnsOperation(operation: DnsOperation): PublicDnsOperation {
    const result: PublicDnsOperation = { uid: operation.uid, type: operation.type, providerUid: operation.providerUid, state: operation.state };
    for (const key of ["domainUid", "endpointSetId", "records", "message", "requestedBy", "startedAt", "finishedAt", "dateCreated"] as const) {
        if (operation[key] !== undefined && operation[key] !== null) {
            (result as any)[key] = operation[key];
        }
    }
    return result;
}
