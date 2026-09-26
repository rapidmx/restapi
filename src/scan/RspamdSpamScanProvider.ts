///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ObjectDecorators } from "@rapidrest/core";
import { SpamVerdict } from "../models/types.js";
import { ScanEnvelope, SpamLearnOptions, SpamScanProvider, SpamScanResult } from "./SpamScanProvider.js";
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

    /**
     * The base URL of rspamd's controller worker, which serves `/learnspam` and `/learnham` (the scan worker `url` above does not).
     * The controller normally listens on port 11334, beside the scan worker on 11333: left empty (the default), it is `url` with its
     * port replaced by 11334 - the same host - which is right for rspamd's stock layout and for the Helm chart's single rspamd pod.
     */
    @Config("mail:scan:spam:rspamd:controller_url", "")
    private controllerUrl: string = "";

    /** The controller's password, sent as the `Password` header of a learn request. Empty (the default) sends none, which rspamd
     * accepts from an address in its controller's `secure_ip`/`trusted_networks` (loopback by default). */
    @Config("mail:scan:spam:rspamd:controller_password", "")
    private controllerPassword: string = "";

    /** How long a learn request may take before it is abandoned. Learning is best-effort, so this is shorter than a scan's. */
    @Config("mail:scan:spam:rspamd:controller_timeout_ms", 10_000)
    private controllerTimeoutMs: number = 10_000;

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

    /**
     * The controller's base URL without a trailing slash: `mail:scan:spam:rspamd:controller_url` when set, else the scan worker's
     * `url` with its port replaced by 11334 (`http://rspamd:11333` -> `http://rspamd:11334`).
     *
     * @throws if neither is a valid URL.
     */
    public controllerBaseUrl(): string {
        const configured: string = this.controllerUrl.trim();
        if (configured.length > 0) {
            return configured.replace(/\/+$/, "");
        }
        const derived: URL = new URL(this.url);
        derived.port = "11334";
        return derived.origin;
    }

    /**
     * Teaches rspamd that `raw` is spam or ham: `POST <controller>/learnspam` or `/learnham` with the raw message as the body,
     * `Content-Type: application/octet-stream`, the controller password (when configured) as the `Password` header and, when the
     * caller names one, the reporting mailbox as `Deliver-To` (what rspamd files a per-user classifier's statistics under; ignored
     * by a global one). Any 2xx counts as success - rspamd answers a message it already learned as that class with 208, which is the
     * outcome a repeated report wants. Rejects on any other status, on a network failure and after `controller_timeout_ms`; unlike
     * `scoreMessage()` it has nothing to fail closed to, so the caller decides what a failure means.
     */
    public async learn(raw: Buffer, kind: "spam" | "ham", options: SpamLearnOptions = {}): Promise<void> {
        const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
        if (this.controllerPassword) {
            headers["Password"] = this.controllerPassword;
        }
        if (options.recipient) {
            headers["Deliver-To"] = options.recipient;
        }

        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), this.controllerTimeoutMs);
        try {
            const response = await fetch(`${this.controllerBaseUrl()}/learn${kind}`, {
                method: "POST",
                headers,
                body: new Uint8Array(raw),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`rspamd controller returned HTTP ${response.status}`);
            }
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
