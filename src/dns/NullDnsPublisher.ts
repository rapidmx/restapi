///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { DnsDesiredStateChange, DnsPublisher } from "./DnsPublisher.js";

/**
 * The default `DnsPublisher`, for a deployment without the DNS controller: changes go nowhere and the version stays 0, so restapi alone behaves as it
 * did before DNS publishing. A long poll against it answers only when it times out or the caller goes away.
 */
export class NullDnsPublisher implements DnsPublisher {
    public async changed(_change: DnsDesiredStateChange): Promise<void> {
        // Nothing listens.
    }

    public async version(): Promise<number> {
        return 0;
    }

    public async waitForChange(_since: number, timeoutMs: number, signal?: AbortSignal): Promise<number> {
        if (!signal?.aborted) {
            await new Promise<void>((resolve) => {
                const done = (): void => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", done);
                    resolve();
                };
                const timer: NodeJS.Timeout = setTimeout(done, timeoutMs);
                signal?.addEventListener("abort", done);
            });
        }
        return 0;
    }
}
