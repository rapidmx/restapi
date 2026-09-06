///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { SpamVerdict } from "../models/types.js";
import { ScanEnvelope, SpamScanProvider, SpamScanResult } from "./SpamScanProvider.js";
const { Config, Logger } = ObjectDecorators;

/** The shape of the JSON body rspamd's `checkv2` HTTP endpoint returns. */
interface RspamdCheckV2Response {
    action: "no action" | "greylist" | "add header" | "rewrite subject" | "soft reject" | "reject";
    score: number;
    symbols?: Record<string, unknown>;
}

/**
 * `SpamScanProvider` adapter for rspamd, talking to its HTTP controller `checkv2` endpoint. Chosen over
 * SpamAssassin's `spamc`/`spamd` line protocol for HTTP-native integration matching this library's HTTP-first
 * design — a `SpamAssassinScanProvider` implementing the same interface via `spamc` is a straightforward
 * drop-in alternative for a deployment that already runs SpamAssassin instead.
 *
 * @author Jean-Philippe Steinmetz
 */
export class RspamdSpamScanProvider implements SpamScanProvider {
    public readonly name: string = "rspamd";

    @Config("mail:scan:spam:rspamd:url", "http://127.0.0.1:11333")
    private url: string = "http://127.0.0.1:11333";

    @Config("mail:scan:spam:rspamd:timeout_ms", 15_000)
    private timeoutMs: number = 15_000;

    @Logger
    private logger: any;

    public async scoreMessage(raw: Buffer, envelope: ScanEnvelope): Promise<SpamScanResult> {
        const headers: Record<string, string> = {
            "Content-Type": "application/octet-stream",
            From: envelope.from,
        };
        if (envelope.to.length > 0) {
            headers["Rcpt"] = envelope.to.join(",");
        }
        if (envelope.remoteIp) {
            headers["IP"] = envelope.remoteIp;
        }
        if (envelope.helo) {
            headers["Helo"] = envelope.helo;
        }

        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(`${this.url}/checkv2`, {
                method: "POST",
                headers,
                body: new Uint8Array(raw),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`rspamd returned HTTP ${response.status}`);
            }
            const body: RspamdCheckV2Response = (await response.json()) as RspamdCheckV2Response;
            return {
                score: body.score,
                verdict: mapAction(body.action),
                symbols: Object.keys(body.symbols ?? {}),
            };
        } catch (err: any) {
            // A scan-engine outage must not silently pass every message through as clean — fail closed to
            // `SUSPECT` so it's routed for human review/Junk rather than blind delivery to the inbox.
            this.logger?.error(`rspamd scan failed: ${err.message}`);
            return { score: 0, verdict: SpamVerdict.SUSPECT, symbols: ["SCAN_ENGINE_UNAVAILABLE"] };
        } finally {
            clearTimeout(timeoutHandle);
        }
    }
}

function mapAction(action: RspamdCheckV2Response["action"]): SpamVerdict {
    switch (action) {
        case "reject":
        case "soft reject":
            return SpamVerdict.SPAM;
        case "add header":
        case "rewrite subject":
        case "greylist":
            return SpamVerdict.SUSPECT;
        default:
            return SpamVerdict.CLEAN;
    }
}
