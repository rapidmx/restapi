///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as dns from "dns";
import { DnsMxRecord, DnsResolver, DnsSrvRecord } from "./DnsResolver.js";

/**
 * `DnsResolver` backed by Node's own built-in resolver - no extra dependency, works for any deployment.
 * A consuming server registers this under `@Inject("DnsResolver")`, the same way it registers
 * `PostfixSendmailTransport` under `"MailTransport"`.
 *
 * @author Jean-Philippe Steinmetz
 */
export class NodeDnsResolver implements DnsResolver {
    public async resolveTxt(hostname: string): Promise<string[][]> {
        return await dns.promises.resolveTxt(hostname);
    }

    public async resolveMx(hostname: string): Promise<DnsMxRecord[]> {
        return await dns.promises.resolveMx(hostname);
    }

    public async resolveCname(hostname: string): Promise<string[]> {
        return await dns.promises.resolveCname(hostname);
    }

    public async resolveSrv(hostname: string): Promise<DnsSrvRecord[]> {
        // Node's own SRV records use `name` for the target hostname; `DnsSrvRecord` uses the more
        // conventional SRV term `target` instead, so the field is renamed on the way out.
        const records = await dns.promises.resolveSrv(hostname);
        return records.map((record) => ({ priority: record.priority, weight: record.weight, port: record.port, target: record.name }));
    }
}
