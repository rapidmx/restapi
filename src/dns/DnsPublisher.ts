///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ObjectFactory } from "@rapidrest/service-core";
import { NullDnsPublisher } from "./NullDnsPublisher.js";

/** What changed in the DNS desired state: one domain's records, one provider config, a queued operation, or everything (a config change every domain
 * reads, such as the Autodiscover host). Today's publisher bumps one version for all of them; the scope is there for a finer one and for the logs. */
export type DnsDesiredStateChange =
    | { scope: "domain"; domainUid: string }
    | { scope: "provider"; providerUid: string }
    | { scope: "operation"; operationUid: string }
    | { scope: "all" };

/**
 * Announces changes to the DNS desired state, so the DNS controller's long poll (`GET /internal/dns/v1/desired-state?since=<version>`) answers at once
 * instead of at its next resync. The server registers its implementation as `"DnsPublisher"`: a version counter in Redis, so every replica answers the
 * long polls alike. `NullDnsPublisher` is what a deployment without the controller (restapi alone, docker-compose) runs with: nothing is announced and
 * the version stays 0.
 *
 * Every change is already saved when it is announced; a lost announcement only delays publishing until the controller's next full resync.
 */
export interface DnsPublisher {
    /** Bumps the desired-state version and wakes the long polls waiting on it. */
    changed(change: DnsDesiredStateChange): Promise<void>;
    /** The current desired-state version. */
    version(): Promise<number>;
    /** Resolves with the version once it is past `since`, or after `timeoutMs`, or when `signal` aborts (the caller went away). */
    waitForChange(since: number, timeoutMs: number, signal?: AbortSignal): Promise<number>;
}

/** Announces `change` through `publisher`, logging (never throwing) when that fails: the change itself is saved, and the controller's periodic resync
 * picks it up anyway. */
export async function notifyDnsPublisher(publisher: DnsPublisher | undefined, change: DnsDesiredStateChange, logger?: any): Promise<void> {
    try {
        await publisher?.changed(change);
    } catch (err: any) {
        logger?.warn(`Could not announce a DNS desired-state change (${change.scope}); the DNS controller picks it up at its next resync: ${err?.message}`);
    }
}

/** The `"DnsPublisher"` the server registered, or a `NullDnsPublisher` (with a warning) on a server that registers none: a server bumping restapi before
 * it registers a publisher still boots and serves domains, and only the controller's long poll waits for its resync. */
export async function resolveDnsPublisher(objectFactory: Pick<ObjectFactory, "newInstance"> | undefined, logger?: any): Promise<DnsPublisher> {
    try {
        const publisher: DnsPublisher | undefined = objectFactory ? await objectFactory.newInstance<DnsPublisher>("DnsPublisher", { name: "default" }) : undefined;
        if (publisher) {
            return publisher;
        }
    } catch (err: any) {
        logger?.warn(`No DnsPublisher is registered, so DNS changes reach the DNS controller only at its next resync: ${err?.message}`);
    }
    return new NullDnsPublisher();
}
