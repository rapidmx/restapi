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

    /**
     * Teaches the engine that `raw` (a whole RFC 5322 message) is spam (`"spam"`) or not (`"ham"`) - what `POST /messages/:id/report`
     * calls when a user reports a message. Optional: an engine that cannot learn (or a deployment that turned learning off) simply
     * leaves it out, and the report is answered `learnSkipped: "unsupported"`.
     *
     * Resolves once the engine accepted the message; a message it has already learned as that class counts as accepted. Rejects with
     * an `Error` when the engine is unreachable, refuses (a bad password, no statistics configured) or times out - the caller logs it
     * and reports `learned: false`, it never fails the user's report. Never called for an encrypted message.
     *
     * @param raw The raw message, at most the report route's size bound (5 MiB).
     * @param kind What the message is.
     * @param options `recipient` is the mailbox the message was reported from, for an engine that keeps statistics per user.
     */
    learn?(raw: Buffer, kind: "spam" | "ham", options?: SpamLearnOptions): Promise<void>;
}

/** Optional context for `SpamScanProvider.learn()`. */
export interface SpamLearnOptions {
    /** The primary address of the mailbox the message was reported from - what a per-user statistics engine files it under. */
    recipient?: string;
}
