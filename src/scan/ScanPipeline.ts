///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import sanitizeHtml from "sanitize-html";
import { simpleParser, ParsedMail, Attachment as ParsedAttachment } from "mailparser";
import { ObjectDecorators } from "@rapidrest/core";
import { AvVerdict, SpamVerdict } from "../models/types.js";
import { AvScanProvider, AvScanResult } from "./AvScanProvider.js";
import { ScanEnvelope, SpamScanProvider, SpamScanResult } from "./SpamScanProvider.js";
const { Config, Inject, Logger } = ObjectDecorators;

/** The per-attachment AV outcome, keyed by the attachment's position in the parsed message. */
export interface ScanPipelineAttachmentResult {
    filename?: string;
    contentType: string;
    content: Buffer;
    contentId?: string;
    isInline: boolean;
    av: AvScanResult;
}

/** The combined outcome of running the full SPAM/AV pipeline against one raw message. */
export interface ScanPipelineResult {
    spam: SpamScanResult;
    /** The overall AV verdict for the message: the worst of the raw-message-level and every attachment's scan. */
    av: AvScanResult;
    attachments: ScanPipelineAttachmentResult[];
    /** The message's HTML body with `<script>`/active content stripped, if it had one. */
    sanitizedHtml?: string;
}

/** Verdicts ranked worst-to-best, used to combine the raw-message and per-attachment AV results. */
const AV_SEVERITY: Record<AvVerdict, number> = {
    [AvVerdict.INFECTED]: 2,
    [AvVerdict.ERROR]: 1,
    [AvVerdict.CLEAN]: 0,
};

/**
 * Orchestrates SPAM scoring, AV scanning, and HTML sanitization for a single raw RFC 5322 message — the
 * ingestion-time gate that every inbound message (via `MailIngestRoute`) and outbound send (via the webmail/
 * EAS/MAPI "send" routes) passes through before delivery/relay. AV scanning covers the full raw message buffer
 * *and* each decoded attachment (not just attachments), which is what catches embedded/malicious HTML.
 *
 * @author Jean-Philippe Steinmetz
 */
export class ScanPipeline {
    // Bound by the consuming server's config (`scan:spam:provider`/`scan:av:provider`) to a concrete
    // implementation (e.g. RspamdSpamScanProvider/ClamAvScanProvider), the same registration convention
    // `service-core` uses for `@Inject("ACLUtils")`.
    @Inject("SpamScanProvider")
    private spamScanProvider?: SpamScanProvider;

    @Inject("AvScanProvider")
    private avScanProvider?: AvScanProvider;

    @Config("mail:scan:sanitize:allowed_tags")
    private allowedTags?: string[];

    @Logger
    private logger: any;

    public async run(raw: Buffer, envelope: ScanEnvelope): Promise<ScanPipelineResult> {
        if (!this.spamScanProvider || !this.avScanProvider) {
            throw new Error(
                "ScanPipeline requires both a SpamScanProvider and an AvScanProvider to be registered. " +
                    "Configure `scan:spam:provider`/`scan:av:provider`.",
            );
        }

        const parsed: ParsedMail = await simpleParser(raw);

        const [spam, rawAv, attachmentResults] = await Promise.all([
            this.spamScanProvider.scoreMessage(raw, envelope),
            this.avScanProvider.scanBuffer(raw),
            this.scanAttachments(parsed.attachments ?? []),
        ]);

        let worstAv: AvScanResult = rawAv;
        for (const attachment of attachmentResults) {
            if (AV_SEVERITY[attachment.av.verdict] > AV_SEVERITY[worstAv.verdict]) {
                worstAv = attachment.av;
            }
        }

        const sanitizedHtml: string | undefined =
            typeof parsed.html === "string" ? this.sanitize(parsed.html) : undefined;

        return { spam, av: worstAv, attachments: attachmentResults, sanitizedHtml };
    }

    private async scanAttachments(attachments: ParsedAttachment[]): Promise<ScanPipelineAttachmentResult[]> {
        const results: ScanPipelineAttachmentResult[] = [];
        for (const attachment of attachments) {
            const av: AvScanResult = await this.avScanProvider!.scanBuffer(attachment.content, attachment.filename);
            results.push({
                filename: attachment.filename,
                contentType: attachment.contentType,
                content: attachment.content,
                contentId: attachment.contentId,
                isInline: attachment.contentDisposition === "inline",
                av,
            });
        }
        return results;
    }

    /**
     * Strips `<script>` tags and other active/executable content from an HTML body. Defense in depth alongside
     * clamd's own HTML/JS signature detection (run against the raw message above) and whatever sandboxing the
     * eventual client renderer applies.
     */
    private sanitize(html: string): string {
        return sanitizeHtml(html, {
            allowedTags: this.allowedTags ?? sanitizeHtml.defaults.allowedTags.filter((tag) => tag !== "script"),
            allowVulnerableTags: false,
            disallowedTagsMode: "discard",
            allowedSchemes: ["http", "https", "mailto", "cid"],
        });
    }
}

/**
 * Combines a spam verdict and an AV verdict into where the message should be routed on ingestion.
 *
 * `AvVerdict.ERROR` and `SpamVerdict.SUSPECT` are the providers' own documented fail-closed outcomes for a
 * scan-engine outage (see `ClamAvScanProvider.scanBuffer()`/`RspamdSpamScanProvider.scoreMessage()`) - treating
 * them as equivalent to a clean/normal verdict here would silently deliver every message straight to the
 * inbox, completely unscanned, for the entire duration of an AV/spam engine outage. `ERROR` quarantines
 * (matching AV's own "treat like infected" intent); `SUSPECT` routes to Junk for human review rather than
 * blind inbox delivery.
 */
export function resolveDeliveryVerdict(result: ScanPipelineResult): "deliver" | "junk" | "quarantine" {
    if (result.av.verdict === AvVerdict.INFECTED || result.av.verdict === AvVerdict.ERROR) {
        return "quarantine";
    }
    if (result.spam.verdict === SpamVerdict.SPAM || result.spam.verdict === SpamVerdict.SUSPECT) {
        return "junk";
    }
    return "deliver";
}
