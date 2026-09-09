///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { convert } from "html-to-text";
import sanitizeHtml from "sanitize-html";
import { simpleParser, ParsedMail, Attachment as ParsedAttachment } from "mailparser";
import { ObjectDecorators } from "@rapidrest/core";
import { AvVerdict, SpamVerdict } from "../models/types.js";
import { AvScanProvider, AvScanResult } from "./AvScanProvider.js";
import { ScanEnvelope, SpamScanProvider, SpamScanResult } from "./SpamScanProvider.js";
const { Config, Inject, Logger } = ObjectDecorators;

/** The maximum length, in characters, of the plain-text body preview `ScanPipeline.run()` derives. */
const BODY_PREVIEW_MAX_LENGTH = 500;

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
    /** The message's parsed subject line, used to populate `Message.subject` and to evaluate `MailFilterRule`
     * subject conditions. */
    subject?: string;
    /** A short plain-text preview of the message body (from its plain-text part, or its HTML part converted to
     * text if it has no plain-text part), truncated to `BODY_PREVIEW_MAX_LENGTH` characters. Used to populate
     * `Message.bodyPreview` and to evaluate `MailFilterRule` body conditions. */
    bodyPreview?: string;
    /** The message's parsed `From` address (e.g. `"Jane Doe <jane@x.com>"`), used to evaluate `MailFilterRule`
     * from conditions - the envelope-from (`ScanEnvelope.from`) is the SMTP `MAIL FROM`, which can legitimately
     * differ from this header. */
    parsedFrom?: string;
    /** The RFC 5322 `Auto-Submitted` header value, if present - see `isAutoReplyEligible()` (`util/
     * AutoReplyUtils.ts`). */
    autoSubmittedHeader?: string;
    /** The RFC 5322 `Precedence` header value, if present - see `isAutoReplyEligible()`. */
    precedenceHeader?: string;
    /** The RFC 2369/8058 `List-Unsubscribe` header value, if present - the strongest single bulk-mail
     * indicator, used by `classifyMessage()` (`util/FocusedInboxUtils.ts`). */
    listUnsubscribeHeader?: string;
    /** The message's parsed `Message-ID` header, angle brackets stripped (mailparser's own `parsed.messageId`
     * does NOT strip them, unlike its `parsed.from`/etc. normalization - stripped explicitly here so a value
     * from this field compares equal to `MailSendUtils.scanAndRelay()`'s own bracket-stripped `messageId`,
     * which every cross-mailbox `Message-ID`-matching feature (`recall()`, `conversationId`) depends on).
     * Also used to set `In-Reply-To`/`References` on an automatic reply - `nodemailer`'s `MailComposer`
     * re-adds brackets on the wire regardless of whether the value passed in already has them. */
    messageIdHeader?: string;
    /** The decoded text of this message's `text/calendar` part (an iTIP `REQUEST`/`REPLY`/`CANCEL`), if it has
     * one - see `IcsUtils.parseIcsEvent()` and `ScanQueueJob.maybeProcessItipMessage()`. */
    icsPart?: string;
    /** The `Message-ID` (angle brackets stripped) this message asks to recall, from its custom
     * `X-RapidMX-Recall-Of` header - present only on the control message `BaseMessageRoute.recall()`
     * composes, see `ScanQueueJob.processRecall()`. */
    recallOfMessageId?: string;
    /** The message's parsed `In-Reply-To` header, if it's a reply - used (together with `references`) to
     * populate `Message.inReplyTo`/`conversationId`, see `util/ConversationUtils.ts`. */
    inReplyTo?: string;
    /** The message's parsed `References` header, oldest ancestor first, or `[]` if absent - see
     * `util/ConversationUtils.ts`'s `deriveConversationId()`. */
    references: string[];
    /** The RFC 3798 `Disposition-Notification-To` header's address, if present - a request for a real MDN
     * receipt back. `undefined` when absent, or when the header names no resolvable address. See
     * `util/ReceiptUtils.ts` and `ScanQueueJob.maybeSendReceipt()`. */
    dispositionNotificationTo?: string;
    /** The decoded text of this message's `message/disposition-notification` part, if it has one (i.e. this
     * message is itself an inbound MDN) - see `ScanQueueJob.processReceipt()` and
     * `util/ReceiptUtils.ts`'s `parseDispositionNotification()`, which actually interprets it. */
    dispositionNotificationPart?: string;
}

/** Strips a `Message-ID`-shaped header value's surrounding angle brackets, if present - mailparser
 * normalizes `parsed.messageId` this way already, but leaves `parsed.inReplyTo`/`parsed.references`
 * bracketed, so those need the same treatment applied explicitly for a value from either source to
 * compare equal (`deriveConversationId()`, `util/ConversationUtils.ts`, depends on this). */
function stripAngleBrackets(value: string): string {
    return value.replace(/^</, "").replace(/>$/, "");
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

        const bodyPreview: string | undefined = this.derivePreview(parsed);
        const parsedFrom: string | undefined = parsed.from?.text;
        const autoSubmittedHeader: string | undefined = this.getHeaderString(parsed, "auto-submitted");
        const precedenceHeader: string | undefined = this.getHeaderString(parsed, "precedence");
        const listUnsubscribeHeader: string | undefined = this.getRawHeaderLine(parsed, "list-unsubscribe");
        const icsPart: string | undefined = this.deriveIcsPart(parsed);
        const recallOfMessageId: string | undefined = this.getHeaderString(parsed, "x-rapidmx-recall-of");
        const dispositionNotificationTo: string | undefined = this.getHeaderAddress(parsed, "disposition-notification-to");
        const dispositionNotificationPart: string | undefined = this.deriveDispositionNotificationPart(parsed);
        // mailparser types `references` as `string[] | string | undefined` (a single reference collapses to a
        // bare string rather than a one-element array) - normalize to always an array, oldest ancestor first,
        // and (unlike `parsed.messageId`) mailparser leaves these bracketed, so strip them here too.
        const referencesRaw: string[] = Array.isArray(parsed.references)
            ? parsed.references
            : parsed.references
              ? [parsed.references]
              : [];
        const references: string[] = referencesRaw.map(stripAngleBrackets);
        const inReplyTo: string | undefined = parsed.inReplyTo ? stripAngleBrackets(parsed.inReplyTo) : undefined;
        const messageIdHeader: string | undefined = parsed.messageId ? stripAngleBrackets(parsed.messageId) : undefined;

        return {
            spam,
            av: worstAv,
            attachments: attachmentResults,
            sanitizedHtml,
            subject: parsed.subject,
            bodyPreview,
            parsedFrom,
            autoSubmittedHeader,
            precedenceHeader,
            listUnsubscribeHeader,
            messageIdHeader,
            icsPart,
            recallOfMessageId,
            inReplyTo,
            references,
            dispositionNotificationTo,
            dispositionNotificationPart,
        };
    }

    /** Derives a short plain-text body preview from `parsed`'s plain-text part, falling back to its HTML part
     * (converted to text) if it has none - truncated to `BODY_PREVIEW_MAX_LENGTH` characters. */
    private derivePreview(parsed: ParsedMail): string | undefined {
        const text: string | undefined =
            typeof parsed.text === "string"
                ? parsed.text
                : typeof parsed.html === "string"
                  ? convert(parsed.html, { wordwrap: false })
                  : undefined;
        return text?.trim().slice(0, BODY_PREVIEW_MAX_LENGTH);
    }

    /** Finds this message's `text/calendar` part (an iTIP invite/reply/cancel), if it has one - mailparser
     * exposes any non `text/plain`/`text/html` part (including an inline-or-attached `.ics` part) via
     * `parsed.attachments`, matched here by content type first and filename extension as a fallback for a
     * sender that omits/mangles the `text/calendar` content type. */
    private deriveIcsPart(parsed: ParsedMail): string | undefined {
        const icsAttachment = (parsed.attachments ?? []).find(
            (attachment) => attachment.contentType === "text/calendar" || (attachment.filename ?? "").toLowerCase().endsWith(".ics"),
        );
        return icsAttachment?.content.toString("utf-8");
    }

    /** Finds this message's `message/disposition-notification` part (present only on an inbound MDN receipt),
     * mirroring `deriveIcsPart()` exactly - mailparser exposes it via `parsed.attachments` the same way it
     * does a `text/calendar` part. Read as `"binary"` (latin1), not `"utf-8"`: the part is itself just an
     * RFC 822 header block (ASCII by spec), and `util/ReceiptUtils.ts`'s `parseDispositionNotification()`
     * re-wraps this text into a `Buffer` the same way for `MimeHeaderUtils.extractHeader()` - matching that
     * module's own encoding convention keeps the two sides consistent. */
    private deriveDispositionNotificationPart(parsed: ParsedMail): string | undefined {
        const part = (parsed.attachments ?? []).find((attachment) => attachment.contentType === "message/disposition-notification");
        return part?.content.toString("binary");
    }

    /** Reads a single header value out of mailparser's parsed header map, which normalizes keys to lowercase and
     * may store a header's value as a plain string or (for structured headers) an object - only a plain string
     * value is meaningful for the headers this is used for (`Auto-Submitted`/`Precedence`/`X-RapidMX-Recall-Of`). */
    private getHeaderString(parsed: ParsedMail, headerName: string): string | undefined {
        const value = parsed.headers.get(headerName);
        return typeof value === "string" ? value : undefined;
    }

    /**
     * Reads a header's raw value straight out of mailparser's `headerLines`, for headers its parsed
     * `headers` map doesn't expose as a plain string. `List-Unsubscribe` is the case this exists for:
     * mailparser folds every `List-*` header into a single structured `list` entry
     * (`{ unsubscribe: { url, mail } }`), so `getHeaderString("list-unsubscribe")` above always returns
     * `undefined` for it. Reading the raw line keeps the extracted value faithful to the header actually
     * sent, and doesn't depend on the shape of that folded object.
     */
    private getRawHeaderLine(parsed: ParsedMail, headerName: string): string | undefined {
        const line: string | undefined = parsed.headerLines?.find((header) => header.key === headerName)?.line;
        if (!line) {
            return undefined;
        }
        const separatorIndex: number = line.indexOf(":");
        return separatorIndex >= 0 ? line.slice(separatorIndex + 1).trim() : undefined;
    }

    /** Reads a single address-typed header (e.g. `Disposition-Notification-To`) out of mailparser's parsed
     * header map. mailparser folds an address-typed header into a structured `{ value: [{address, name}],
     * html, text }` object rather than a plain string - the same situation `List-Unsubscribe` is in relative
     * to `getHeaderString()`, confirmed with a throwaway script - so this reads `.value[0].address`
     * specifically rather than `.text` (which would include a display name RFC 3798 doesn't want here).
     * Returns `undefined` if the header is absent or names no resolvable address. */
    private getHeaderAddress(parsed: ParsedMail, headerName: string): string | undefined {
        const value: any = parsed.headers.get(headerName);
        return typeof value === "object" && value !== null ? value.value?.[0]?.address : undefined;
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
