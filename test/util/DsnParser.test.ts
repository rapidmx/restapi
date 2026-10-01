///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { simpleParser } from "mailparser";
import {
    classifyDeliveryStatus,
    formatDeliveryStatusPreview,
    parseDeliveryStatusReport,
    parseFeedbackReport,
} from "../../src/util/DsnParser.js";
import { DSN_DELAYED_450, DSN_EXPIRED_450, DSN_UNKNOWN_RECIPIENT_550 } from "../fixtures/postfixCapturedDsn.js";
import { postfixDsn } from "../fixtures/postfixDsn.js";

/** Parses a message the way `ScanPipeline` does. */
function parse(raw: Buffer | string) {
    return simpleParser(typeof raw === "string" ? Buffer.from(raw) : raw, { skipImageLinks: true, skipHtmlToText: true });
}

/** A multipart/report built from parts given as [content type, body] pairs. */
function report(reportType: string, parts: [string, string][]): string {
    return [
        "From: reporter@isp.example",
        "To: bounces+tok@a.example",
        "Subject: Report",
        "MIME-Version: 1.0",
        `Content-Type: multipart/report; report-type=${reportType}; boundary="B"`,
        "",
        ...parts.flatMap(([type, body]) => ["--B", `Content-Type: ${type}`, "", body, ""]),
        "--B--",
        "",
    ].join("\r\n");
}

/** A parsed message that is a `multipart/report` of `reportType` and has nothing else, or only `extra`. */
function bareReport(reportType: string, extra: Record<string, unknown> = {}): any {
    return { headers: new Map([["content-type", { value: "multipart/report", params: { "report-type": reportType } }]]), ...extra };
}

describe("DsnParser", () => {
    describe("classifyDeliveryStatus()", () => {
        it.each([
            ["delayed", "4.2.0", "delayed"],
            ["delivered", "2.0.0", "delivered"],
            ["relayed", undefined, "delivered"],
            ["expanded", undefined, "delivered"],
            [undefined, "2.1.5", "delivered"],
            ["failed", "4.2.0", "soft_bounce"],
            ["failed", "5.2.2", "soft_bounce"],
            ["failed", "5.1.1", "hard_bounce"],
            ["failed", undefined, "hard_bounce"],
            [undefined, undefined, "hard_bounce"],
            [" FAILED ", " 5.7.1 ", "hard_bounce"],
        ])("Classifies action %s with status %s as %s", (action, status, expected) => {
            expect(classifyDeliveryStatus(action, status)).toBe(expected);
        });
    });

    describe("parseDeliveryStatusReport()", () => {
        it("Parses a genuine Postfix 550 bounce: per-message fields, the recipient group and the returned message's id", async () => {
            const parsed = parseDeliveryStatusReport(await parse(DSN_UNKNOWN_RECIPIENT_550));

            expect(parsed).toEqual({
                reportingMta: "mail.owned.lab",
                originalEnvelopeId: undefined,
                originalMessageId: "6ffffb17-1dc0-a0c6-0ab8-173f954579ce@owned.lab",
                recipients: [
                    {
                        finalRecipient: "nobody@refuse.lab",
                        originalRecipient: "nobody@refuse.lab",
                        action: "failed",
                        status: "5.1.1",
                        diagnosticCode: "550 5.1.1 <nobody@refuse.lab>: Recipient address rejected: User unknown in virtual mailbox table",
                        remoteMta: "mx.refuse.lab",
                        outcome: "hard_bounce",
                    },
                ],
            });
        });

        it("Classifies an expired 450 as a soft bounce and a delayed notice as delayed", async () => {
            expect(parseDeliveryStatusReport(await parse(DSN_EXPIRED_450))!.recipients[0].outcome).toBe("soft_bounce");
            expect(parseDeliveryStatusReport(await parse(DSN_DELAYED_450))!.recipients[0].outcome).toBe("delayed");
        });

        it("Formats the preview line a bounce's message list shows", async () => {
            const parsed = parseDeliveryStatusReport(await parse(postfixDsn({ to: "recipient@example.com", recipient: "carol@example.org" })))!;

            expect(formatDeliveryStatusPreview(parsed)).toBe(
                "carol@example.org: failed (5.7.1) - 554 5.7.1 <carol@example.org>: Recipient address rejected: Access denied",
            );
        });

        it("Reads several recipient groups, an envelope id and returned headers, leaving out fields a group lacks", async () => {
            const raw = report("delivery-status", [
                ["text/plain", "Some mail could not be delivered."],
                [
                    "message/delivery-status",
                    [
                        "Reporting-MTA: dns; mx.example",
                        "Original-Envelope-Id: env-42",
                        "",
                        "Final-Recipient: rfc822; one@x.example",
                        "Action: failed",
                        "Status: 5.2.2 (mailbox full)",
                        "",
                        "Final-Recipient: rfc822; two@x.example",
                    ].join("\r\n"),
                ],
                ["text/rfc822-headers", "Message-ID: <orig-1@a.example>\r\nSubject: hi"],
            ]);

            const parsed = parseDeliveryStatusReport(await parse(raw))!;

            expect(parsed.reportingMta).toBe("mx.example");
            expect(parsed.originalEnvelopeId).toBe("env-42");
            expect(parsed.originalMessageId).toBe("orig-1@a.example");
            expect(parsed.recipients).toEqual([
                expect.objectContaining({ finalRecipient: "one@x.example", status: "5.2.2", outcome: "soft_bounce" }),
                expect.objectContaining({ finalRecipient: "two@x.example", action: undefined, status: undefined, outcome: "hard_bounce" }),
            ]);
            expect(formatDeliveryStatusPreview(parsed)).toBe("one@x.example: failed (5.2.2); two@x.example:");
        });

        it("Reads a status part that comes through as an attachment (message/global-delivery-status)", async () => {
            const raw = report("delivery-status", [
                ["text/plain", "Undeliverable."],
                ["message/global-delivery-status", "Reporting-MTA: dns; mx.example\r\n\r\nFinal-Recipient: rfc822; intl@x.example\r\nAction: failed\r\nStatus: 5.1.1"],
                ["message/rfc822", "From: a@a.example\r\nSubject: s\r\n\r\nbody"],
            ]);

            const parsed = parseDeliveryStatusReport(await parse(raw))!;

            expect(parsed.recipients[0].finalRecipient).toBe("intl@x.example");
            // The returned message has no Message-ID.
            expect(parsed.originalMessageId).toBeUndefined();
        });

        it("Reads returned headers that have no blank line after them", async () => {
            const raw = report("delivery-status", [
                ["message/global-delivery-status", "Reporting-MTA: dns; mx.example\r\n\r\nFinal-Recipient: rfc822; a@x.example\r\nAction: failed"],
                ["text/rfc822-headers", "Message-ID: <only-headers@a.example>"],
            ]);

            expect(parseDeliveryStatusReport(await parse(raw))!.originalMessageId).toBe("only-headers@a.example");
        });

        it("Returns undefined for ordinary mail, another report type, a report without a status part, and one naming no recipient", async () => {
            expect(parseDeliveryStatusReport(await parse("From: a@a.example\r\nSubject: hi\r\n\r\nhello\r\n"))).toBeUndefined();
            expect(parseDeliveryStatusReport(await parse(report("disposition-notification", [["text/plain", "read"]])))).toBeUndefined();
            expect(parseDeliveryStatusReport(await parse(report("delivery-status", [["text/plain", "no status here"]])))).toBeUndefined();
            expect(
                parseDeliveryStatusReport(await parse(report("delivery-status", [["message/global-delivery-status", "Reporting-MTA: dns; mx.example"]]))),
            ).toBeUndefined();
        });

        it("Copes with a parsed message that has no headers, text or attachments", () => {
            expect(parseDeliveryStatusReport({} as any)).toBeUndefined();
            expect(parseDeliveryStatusReport(bareReport("delivery-status"))).toBeUndefined();
            expect(parseDeliveryStatusReport(bareReport("delivery-status", { text: "Reporting-MTA: dns; x\n\nFinal-Recipient: ;" }))).toBeUndefined();
        });
    });

    describe("parseFeedbackReport()", () => {
        it("Parses an ARF abuse report and the reported message's id", async () => {
            const raw = report("feedback-report", [
                ["text/plain", "This is an abuse report."],
                [
                    "message/feedback-report",
                    [
                        "Feedback-Type: Abuse",
                        "User-Agent: FBL/1.0",
                        "Version: 1",
                        "Original-Mail-From: <bounces+tok@a.example>",
                        "Original-Rcpt-To: <user@isp.example>",
                        "Original-Rcpt-To: other@isp.example",
                        "Original-Rcpt-To: <>",
                    ].join("\r\n"),
                ],
                ["message/rfc822", "From: news@a.example\r\nMessage-ID: <orig-2@a.example>\r\n\r\nbody"],
            ]);

            expect(parseFeedbackReport(await parse(raw))).toEqual({
                feedbackType: "abuse",
                userAgent: "FBL/1.0",
                originalRecipients: ["user@isp.example", "other@isp.example"],
                originalMailFrom: "bounces+tok@a.example",
                originalMessageId: "orig-2@a.example",
            });
        });

        it("Falls back to the text when the feedback part isn't an attachment, and omits what the report leaves out", () => {
            const parsed = parseFeedbackReport(bareReport("feedback-report", { text: "Complaint.\n\nFeedback-Type: not-spam\nVersion: 1\n", attachments: [] }));

            expect(parsed).toEqual({
                feedbackType: "not-spam",
                userAgent: undefined,
                originalRecipients: [],
                originalMailFrom: undefined,
                originalMessageId: undefined,
            });
        });

        it("Returns undefined for other messages and for a report without a Feedback-Type", async () => {
            expect(parseFeedbackReport(await parse(DSN_UNKNOWN_RECIPIENT_550))).toBeUndefined();
            expect(parseFeedbackReport(await parse(report("feedback-report", [["message/feedback-report", "Version: 1"]])))).toBeUndefined();
            expect(parseFeedbackReport(await parse(report("feedback-report", [["text/plain", "nothing"]])))).toBeUndefined();
            expect(parseFeedbackReport(bareReport("feedback-report"))).toBeUndefined();
        });
    });

    describe("caps on hostile reports", () => {
        it("Keeps at most 100 recipient groups and clips every field to 1 KB", () => {
            const long = "x".repeat(5000);
            const groups = Array.from(
                { length: 500 },
                (_, i) => `Final-Recipient: rfc822; u${i}@x.example\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; ${long}`,
            );
            const text = `Reporting-MTA: dns; ${long}\n\n${groups.join("\n\n")}\n`;
            const parsed = parseDeliveryStatusReport(bareReport("delivery-status", { text, attachments: [] }))!;
            expect(parsed.recipients).toHaveLength(100);
            expect(parsed.recipients[0].finalRecipient).toBe("u0@x.example");
            expect(parsed.recipients[0].diagnosticCode!.length).toBeLessThanOrEqual(1024);
            expect(parsed.reportingMta!.length).toBeLessThanOrEqual(1024);
        });

        it("Keeps at most 100 ARF original recipients and clips every field to 1 KB", () => {
            const long = "y".repeat(5000);
            const rcpts = Array.from({ length: 500 }, (_, i) => `Original-Rcpt-To: <u${i}@x.example>`).join("\n");
            const text = `Feedback-Type: abuse\nUser-Agent: ${long}\n${rcpts}\nOriginal-Mail-From: ${long}\n`;
            const parsed = parseFeedbackReport(bareReport("feedback-report", { text, attachments: [] }))!;
            expect(parsed.originalRecipients).toHaveLength(100);
            expect(parsed.userAgent).toHaveLength(1024);
            expect(parsed.originalMailFrom).toHaveLength(1024);
        });
    });
});
