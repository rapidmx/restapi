///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { AvVerdict } from "../models/types.js";

/** The outcome of an `AvScanProvider.scanBuffer()` call. */
export interface AvScanResult {
    verdict: AvVerdict;
    /** The name of the malware signature matched, if `verdict` is `INFECTED`. */
    signatureName?: string;
}

/**
 * Scans a buffer of content (a full raw MIME message, a decoded attachment, or an HTML body) for malicious
 * content by delegating to an existing anti-virus engine (ClamAV) rather than implementing detection in this
 * library. See `ClamAvScanProvider` for the default adapter. Selected via the `scan:av:provider` config key.
 *
 * Called on more than just file attachments — the full raw message and HTML bodies are scanned too, which is
 * what covers embedded/malicious HTML (e.g. an exploit payload in an inline `<script>`), not just attachments.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface AvScanProvider {
    /** A short, unique name for this provider implementation (e.g. `"clamav"`). */
    readonly name: string;

    scanBuffer(content: Buffer, filename?: string): Promise<AvScanResult>;
}
