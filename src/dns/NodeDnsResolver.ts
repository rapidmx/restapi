///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as dns from "dns";
import { DnsResolver } from "./DnsResolver.js";

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
}
