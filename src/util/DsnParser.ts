///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { ParsedMail } from "mailparser";

/**
 * What one recipient group of a delivery status report (RFC 3464) comes to:
 * - `delivered`: the report confirms delivery (`Action: delivered`/`relayed`/`expanded`).
 * - `delayed`: delivery is still being retried (`Action: delayed`).
 * - `soft_bounce`: delivery failed for a reason that may clear up by itself - a `4.x.x` status, or `5.2.2` (mailbox full, which
 * receivers routinely report as permanent although it is not).
 * - `hard_bounce`: delivery failed permanently - any other `5.x.x` status, or a failure with no status at all.
 */
export type DeliveryOutcome = "delivered" | "delayed" | "soft_bounce" | "hard_bounce";

/** One recipient group of a delivery status report. */
export interface DeliveryStatusRecipient {
    /** The bare address of the `Final-Recipient` field, its address type (`rfc822;`) removed. */
    finalRecipient: string;
    /** The bare address of the `Original-Recipient` field, if the report has one. */
    originalRecipient?: string;
    /** The `Action` field, lowercased (`failed`, `delayed`, `delivered`, `relayed`, `expanded`). */
    action?: string;
    /** The `Status` field: an RFC 3463 enhanced status code such as `5.1.1`. */
    status?: string;
    /** The `Diagnostic-Code` field, its type (`smtp;`) removed and folded lines joined. */
    diagnosticCode?: string;
    /** The `Remote-MTA` field, its type (`dns;`) removed. */
    remoteMta?: string;
    /** What this group comes to - see `DeliveryOutcome`. */
    outcome: DeliveryOutcome;
}

/** A parsed delivery status notification (a bounce): `multipart/report; report-type=delivery-status`. */
export interface DeliveryStatusReport {
    /** The `Reporting-MTA` field of the per-message group, its type (`dns;`) removed. */
    reportingMta?: string;
    /** The `Original-Envelope-Id` field of the per-message group, if the report has one. */
    originalEnvelopeId?: string;
    /** The `Message-ID` (angle brackets stripped) of the message the report is about, read from its returned copy
     * (`message/rfc822`) or returned headers (`text/rfc822-headers`), if the report includes either. */
    originalMessageId?: string;
    /** One entry per recipient group - never empty. */
    recipients: DeliveryStatusRecipient[];
}

/** A parsed abuse/feedback report (ARF, RFC 5965): `multipart/report; report-type=feedback-report`. */
export interface FeedbackReport {
    /** The `Feedback-Type` field, lowercased (`abuse`, `fraud`, `not-spam`, `virus`, `other`, ...). */
    feedbackType: string;
    /** The `User-Agent` field of the party that generated the report. */
    userAgent?: string;
    /** The `Original-Rcpt-To` field(s): who the reported message was delivered to, where the reporter disclosed it. */
    originalRecipients: string[];
    /** The `Original-Mail-From` field: the reported message's envelope sender, where the reporter disclosed it. */
    originalMailFrom?: string;
    /** The `Message-ID` (angle brackets stripped) of the reported message, read from its returned copy or headers. */
    originalMessageId?: string;
}

/** The content types a report's returned original can come as. */
const RETURNED_ORIGINAL_TYPES: ReadonlySet<string> = new Set(["message/rfc822", "text/rfc822-headers", "message/global", "message/global-headers"]);

/** The content types a delivery status part can come as (`message/global-delivery-status` is RFC 6533's internationalized form). */
const DELIVERY_STATUS_TYPES: ReadonlySet<string> = new Set(["message/delivery-status", "message/global-delivery-status"]);

/**
 * Reads the fields of an RFC 822-style header block - lines of `Name: value`, with folded continuation lines joined - into a map
 * keyed by the lowercased name. A name that repeats keeps every value, in order.
 */
function readFields(block: string): Map<string, string[]> {
    const fields: Map<string, string[]> = new Map();
    for (const line of block.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ").split("\n")) {
        const colon: number = line.indexOf(":");
        if (colon > 0) {
            const name: string = line.slice(0, colon).trim().toLowerCase();
            const values: string[] = fields.get(name) ?? [];
            values.push(line.slice(colon + 1).trim());
            fields.set(name, values);
        }
    }
    return fields;
}

/** The first value of `name` in `fields`, if any. */
function first(fields: Map<string, string[]>, name: string): string | undefined {
    return fields.get(name)?.[0];
}

/** A typed report field's value without its type prefix: `rfc822; a@b` becomes `a@b`, `smtp; 550 ...` becomes `550 ...`. */
function stripType(value: string | undefined): string | undefined {
    const stripped: string | undefined = value?.replace(/^[^;]*;\s*/, "").trim();
    return stripped ? stripped : undefined;
}

/** A message id without its angle brackets, or `undefined` for an empty one. */
function stripAngleBrackets(value: string | undefined): string | undefined {
    const stripped: string | undefined = value?.trim().replace(/^</, "").replace(/>$/, "").trim();
    return stripped ? stripped : undefined;
}

/** Whether `parsed` is a `multipart/report` of the given `report-type`. */
function isReportOfType(parsed: ParsedMail, reportType: string): boolean {
    const contentType: any = parsed.headers?.get("content-type");
    return contentType?.value === "multipart/report" && String(contentType.params?.["report-type"] ?? "").toLowerCase() === reportType;
}

/** The decoded text of `parsed`'s first attachment of one of `types`, if it has one. */
function attachmentText(parsed: ParsedMail, types: ReadonlySet<string>): string | undefined {
    const part = (parsed.attachments ?? []).find((attachment) => types.has(String(attachment.contentType).toLowerCase()));
    return part?.content.toString("utf-8");
}

/** The `Message-ID` of a report's returned original (the message itself, or only its headers), if the report includes one. */
function returnedOriginalMessageId(parsed: ParsedMail): string | undefined {
    const original: string | undefined = attachmentText(parsed, RETURNED_ORIGINAL_TYPES);
    if (original === undefined) {
        return undefined;
    }
    // Only the header block: a returned message's body could itself contain a line that looks like a header.
    const headerEnd: number = original.search(/\r?\n\r?\n/);
    return stripAngleBrackets(first(readFields(headerEnd >= 0 ? original.slice(0, headerEnd) : original), "message-id"));
}

/**
 * What a recipient group's `Action` and `Status` come to - see `DeliveryOutcome`. An action other than `failed`/`delayed` that the
 * report names (`delivered`, `relayed`, `expanded`) is a success; a group with no action at all falls back to its status class.
 */
export function classifyDeliveryStatus(action: string | undefined, status: string | undefined): DeliveryOutcome {
    const normalizedAction: string = (action ?? "").trim().toLowerCase();
    const normalizedStatus: string = (status ?? "").trim();
    if (normalizedAction === "delayed") {
        return "delayed";
    }
    if (normalizedAction === "delivered" || normalizedAction === "relayed" || normalizedAction === "expanded") {
        return "delivered";
    }
    if (normalizedStatus.startsWith("2.")) {
        return "delivered";
    }
    if (normalizedStatus.startsWith("4.") || normalizedStatus === "5.2.2") {
        return "soft_bounce";
    }
    return "hard_bounce";
}

/**
 * Parses a delivery status notification (RFC 3464) - a `multipart/report; report-type=delivery-status` message - into its
 * per-message fields and one entry per recipient group. `undefined` when `parsed` is not such a report or its report names no
 * recipient.
 *
 * mailparser does not expose the `message/delivery-status` part as an attachment: it appends it to `parsed.text`, after the
 * human-readable notification, where it starts at the report's mandatory `Reporting-MTA` field. A report whose status part does
 * come through as an attachment (`message/global-delivery-status`, or a parser change) is read from there instead.
 */
export function parseDeliveryStatusReport(parsed: ParsedMail): DeliveryStatusReport | undefined {
    if (!isReportOfType(parsed, "delivery-status")) {
        return undefined;
    }
    let statusText: string | undefined = attachmentText(parsed, DELIVERY_STATUS_TYPES);
    if (statusText === undefined) {
        const start: number = typeof parsed.text === "string" ? parsed.text.search(/^Reporting-MTA:/im) : -1;
        statusText = start >= 0 ? parsed.text!.slice(start) : undefined;
    }
    if (statusText === undefined) {
        return undefined;
    }

    let reportingMta: string | undefined;
    let originalEnvelopeId: string | undefined;
    const recipients: DeliveryStatusRecipient[] = [];
    for (const group of statusText.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
        const fields: Map<string, string[]> = readFields(group);
        const finalRecipient: string | undefined = stripType(first(fields, "final-recipient"));
        if (!finalRecipient) {
            // The per-message group (or trailing text) - it names no recipient.
            reportingMta ??= stripType(first(fields, "reporting-mta"));
            originalEnvelopeId ??= first(fields, "original-envelope-id");
            continue;
        }
        const action: string | undefined = first(fields, "action")?.toLowerCase();
        const status: string | undefined = first(fields, "status")?.split(/\s/)[0];
        recipients.push({
            finalRecipient,
            originalRecipient: stripType(first(fields, "original-recipient")),
            action,
            status,
            diagnosticCode: stripType(first(fields, "diagnostic-code")),
            remoteMta: stripType(first(fields, "remote-mta")),
            outcome: classifyDeliveryStatus(action, status),
        });
    }
    if (recipients.length === 0) {
        return undefined;
    }
    return { reportingMta, originalEnvelopeId, originalMessageId: returnedOriginalMessageId(parsed), recipients };
}

/**
 * One line per recipient of `report`, joined with `; `: `<Final-Recipient>: <Action> (<Status>) - <Diagnostic-Code>`, e.g.
 * `nobody@x.example: failed (5.1.1) - 550 5.1.1 <nobody@x.example>: Recipient address rejected: User unknown`. A field the report
 * lacks is left out. This is what a bounce's message list preview shows (`ScanPipeline`).
 */
export function formatDeliveryStatusPreview(report: DeliveryStatusReport): string {
    return report.recipients
        .map(
            (recipient) =>
                `${recipient.finalRecipient}:${recipient.action ? ` ${recipient.action}` : ""}${recipient.status ? ` (${recipient.status})` : ""}${
                    recipient.diagnosticCode ? ` - ${recipient.diagnosticCode}` : ""
                }`,
        )
        .join("; ");
}

/**
 * Parses an abuse/feedback report (ARF, RFC 5965) - a `multipart/report; report-type=feedback-report` message, which is what a
 * mailbox provider's feedback loop sends when one of its users marks a message as spam. `undefined` when `parsed` is not such a
 * report or its `message/feedback-report` part has no `Feedback-Type`.
 *
 * The report's origin is not verified here: anyone can send a message shaped like a feedback report. A consumer that acts on one
 * (a suppression, say) must only trust it for messages it can tie back to something it sent itself - by `originalMessageId`, or by
 * the address the report was delivered to.
 */
export function parseFeedbackReport(parsed: ParsedMail): FeedbackReport | undefined {
    if (!isReportOfType(parsed, "feedback-report")) {
        return undefined;
    }
    let reportText: string | undefined = attachmentText(parsed, new Set(["message/feedback-report"]));
    if (reportText === undefined) {
        const start: number = typeof parsed.text === "string" ? parsed.text.search(/^Feedback-Type:/im) : -1;
        reportText = start >= 0 ? parsed.text!.slice(start) : undefined;
    }
    const fields: Map<string, string[]> = readFields((reportText ?? "").split(/\r?\n\r?\n/)[0]);
    const feedbackType: string | undefined = first(fields, "feedback-type")?.toLowerCase();
    if (!feedbackType) {
        return undefined;
    }
    return {
        feedbackType,
        userAgent: first(fields, "user-agent"),
        originalRecipients: (fields.get("original-rcpt-to") ?? []).map((value) => stripAngleBrackets(value)!).filter(Boolean),
        originalMailFrom: stripAngleBrackets(first(fields, "original-mail-from")),
        originalMessageId: returnedOriginalMessageId(parsed),
    };
}
