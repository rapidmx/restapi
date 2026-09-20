///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A Postfix-format delivery status notification, as the local Postfix (bounce(8)) hands one to the ingest hand-off when it
// cannot deliver a message it accepted: sent by MAILER-DAEMON at the MTA's own host, with a null envelope sender (`<>`),
// `Auto-Submitted: auto-replied`, and a `multipart/report; report-type=delivery-status` body made of a plain-language
// notification, a `message/delivery-status` report (RFC 3464, with Postfix's X- fields) and the undelivered message.
//
// HAND-WRITTEN to follow bounce(8)'s output field for field, and kept only for what no capture has - a configurable recipient and an
// HTML notification alternative. The GENUINE Postfix captures (boky/postfix, docker lab, 2026-09-20, from `@rapidmx/postfix-bridge`) are
// in `postfixCapturedDsn.ts`; prefer them wherever the exact bytes matter.

/** What the Postfix `bounce` service reports for one recipient refused by a remote server. */
export function postfixRefusal(recipient: string): string {
    return (
        `<${recipient}>: host mx.example.net[192.0.2.25] said: 554 5.7.1 <${recipient}>: Recipient address\n` +
        "    rejected: Access denied (in reply to RCPT TO command)"
    );
}

export interface PostfixDsnOptions {
    /** Who the notice is addressed to: the local sender of the failed message. */
    to: string;
    /** The MTA's own hostname; the notice is from MAILER-DAEMON@this. */
    host?: string;
    /** The failed recipient. */
    recipient?: string;
    /** An HTML alternative of the notification text - some MTAs send one; Postfix does not. */
    html?: string;
}

/** A Postfix bounce notice (CRLF line endings, as it arrives from the SMTP hand-off). */
export function postfixDsn(options: PostfixDsnOptions): Buffer {
    const host: string = options.host ?? "mail.example.com";
    const recipient: string = options.recipient ?? "bob@example.net";
    const boundary = `4F1D42A11B2.1758344405/${host}`;
    const lines: string[] = [
        "Return-Path: <>",
        `X-Original-To: ${options.to}`,
        `Delivered-To: ${options.to}`,
        `Received: from ${host} (localhost [127.0.0.1])`,
        `\tby ${host} (Postfix) with ESMTP id 4F1D42A11B2`,
        `\tfor <${options.to}>; Sat, 19 Sep 2026 22:00:05 -0700 (PDT)`,
        `Received: by ${host} (Postfix)`,
        "\tid 3E23A2A11B3; Sat, 19 Sep 2026 22:00:05 -0700 (PDT)",
        "Date: Sat, 19 Sep 2026 22:00:05 -0700 (PDT)",
        `From: MAILER-DAEMON@${host} (Mail Delivery System)`,
        "Subject: Undelivered Mail Returned to Sender",
        `To: ${options.to}`,
        "Auto-Submitted: auto-replied",
        "MIME-Version: 1.0",
        "Content-Type: multipart/report; report-type=delivery-status;",
        `\tboundary="${boundary}"`,
        `Message-Id: <20260920050005.3E23A2A11B3@${host}>`,
        "",
        "This is a MIME-encapsulated message.",
        "",
        `--${boundary}`,
        "Content-Description: Notification",
        "Content-Type: text/plain; charset=us-ascii",
        "",
        `This is the mail system at host ${host}.`,
        "",
        "I'm sorry to have to inform you that your message could not",
        "be delivered to one or more recipients. It's attached below.",
        "",
        "For further assistance, please send mail to postmaster.",
        "",
        "If you do so, please include this problem report. You can",
        "delete your own text from the attached returned message.",
        "",
        "                   The mail system",
        "",
        postfixRefusal(recipient),
        "",
        ...(options.html
            ? [`--${boundary}`, "Content-Description: Notification (HTML)", "Content-Type: text/html; charset=us-ascii", "", options.html, ""]
            : []),
        `--${boundary}`,
        "Content-Description: Delivery report",
        "Content-Type: message/delivery-status",
        "",
        `Reporting-MTA: dns; ${host}`,
        "X-Postfix-Queue-ID: 4F1D42A11B2",
        `X-Postfix-Sender: rfc822; ${options.to}`,
        "Arrival-Date: Sat, 19 Sep 2026 22:00:00 -0700 (PDT)",
        "",
        `Final-Recipient: rfc822; ${recipient}`,
        `Original-Recipient: rfc822;${recipient}`,
        "Action: failed",
        "Status: 5.7.1",
        "Remote-MTA: dns; mx.example.net",
        `Diagnostic-Code: smtp; 554 5.7.1 <${recipient}>: Recipient address rejected:`,
        "    Access denied",
        "",
        `--${boundary}`,
        "Content-Description: Undelivered Message",
        "Content-Type: message/rfc822",
        "",
        `Return-Path: <${options.to}>`,
        `Received: by ${host} (Postfix, from userid 1000)`,
        "\tid 4F1D42A11B2; Sat, 19 Sep 2026 22:00:00 -0700 (PDT)",
        `From: JP <${options.to}>`,
        `To: ${recipient}`,
        "Subject: Q3 plan",
        "Message-ID: <orig-1@example.com>",
        "Date: Sat, 19 Sep 2026 22:00:00 -0700",
        "",
        "Hello Bob,",
        "",
        "Here is the plan.",
        "",
        `--${boundary}--`,
        "",
    ];
    return Buffer.from(lines.join("\r\n"));
}
