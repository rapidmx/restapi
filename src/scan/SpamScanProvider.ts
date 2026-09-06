///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { SpamVerdict } from "../models/types.js";

/** The envelope information a `SpamScanProvider` needs alongside the raw message content. */
export interface ScanEnvelope {
    from: string;
    to: string[];
    /** The originating IP address of the SMTP client that submitted the message, if known. */
    remoteIp?: string;
    /** The HELO/EHLO hostname presented by the originating SMTP client, if known. */
    helo?: string;
}

/** The outcome of a `SpamScanProvider.scoreMessage()` call. */
export interface SpamScanResult {
    score: number;
    verdict: SpamVerdict;
    /** The symbolic names (e.g. rspamd symbols, SpamAssassin rule names) that contributed to the score. */
    symbols: string[];
}

/**
 * Scores a raw RFC 5322 message for spam likelihood by delegating to an existing, battle-tested spam-filtering
 * engine (rspamd, SpamAssassin) rather than implementing detection heuristics in this library. See
 * `RspamdSpamScanProvider` for the default adapter. Selected via the `scan:spam:provider` config key.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface SpamScanProvider {
    /** A short, unique name for this provider implementation (e.g. `"rspamd"`, `"spamassassin"`). */
    readonly name: string;

    scoreMessage(raw: Buffer, envelope: ScanEnvelope): Promise<SpamScanResult>;
}
