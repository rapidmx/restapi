///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/** A fully composed message ready to be relayed to the internet. */
export interface OutboundMessage {
    /** The complete, fully composed RFC 5322 MIME source, including headers. */
    raw: Buffer;
    envelopeFrom: string;
    envelopeTo: string[];
}

/**
 * Why one envelope recipient was not accepted, in the words of whatever refused it. Everything here is diagnostic text
 * from the mail system itself, kept verbatim (control characters removed, length capped) - never the message, its
 * headers or any credential. Every field but `address` is optional: a transport reports what it can tell.
 */
export interface TransportFailure {
    /** The envelope recipient this concerns. */
    address: string;
    /** The SMTP reply code (e.g. `554`) when the mail system's text carries one. */
    code?: number;
    /** The RFC 3463 enhanced status code (e.g. `5.7.1`) when the mail system's text carries one. */
    enhancedCode?: string;
    /** The mail system's own explanation, e.g. `554 5.7.1 <x@example.net>: Recipient address rejected: Access denied`. */
    response?: string;
    /** What was being done when it failed: the SMTP command (`RCPT TO`), `sendmail`, `SendEmail`, ... */
    command?: string;
    /** What the local delivery agent (`sendmail`) printed on its error stream. */
    stderr?: string;
    /** `true` when trying again later may succeed (a 4xx, a busy or unreachable service), `false` when it will not
     * (a 5xx, a misconfiguration); absent when the transport can't tell. */
    temporary?: boolean;
}

/** The transport-level error behind a failed `MailTransport.send()` - see `TransportFailure` on what it may hold. */
export interface TransportError {
    message: string;
    /** A machine-readable code: nodemailer's `ESENDMAIL`, a Node error code such as `ENOENT`, an SES error name, ... */
    code?: string;
    response?: string;
    responseCode?: number;
    command?: string;
    stderr?: string;
    /** The exit status of the local delivery agent (`sendmail`). */
    exitCode?: number;
    /** The service's own identifier for the failed request (SES's request id), for its support and logs. */
    requestId?: string;
}

/** The outcome of a `MailTransport.send()` call. */
export interface TransportResult {
    accepted: string[];
    rejected: string[];
    /** The `Message-ID` the relaying MTA recorded for this transaction, if reported. */
    messageId?: string;
    /** Why each rejected recipient was refused. Optional and additive: a transport that says nothing more than
     * `rejected` leaves it out, and a consumer must cope with a `rejected` address that has no entry here. */
    failures?: TransportFailure[];
    /** The error that failed the whole call, when it failed because of one (as opposed to a per-recipient refusal). */
    error?: TransportError;
}

/**
 * Hands a fully composed outbound message to the local MTA (Postfix) for internet delivery — DKIM signing,
 * SPF/DMARC alignment, retry/queueing, and everything else needed to speak SMTP to the rest of the internet is
 * the MTA's responsibility, not this library's. See `PostfixSendmailTransport` for the default adapter.
 *
 * This library never opens an outbound SMTP connection itself; every "send" action in the webmail REST API,
 * EAS, and MAPI layers ultimately calls a `MailTransport` implementation.
 *
 * @author Jean-Philippe Steinmetz
 */
export interface MailTransport {
    /** A short, unique name for this transport implementation (e.g. `"postfix-sendmail"`). */
    readonly name: string;

    send(message: OutboundMessage): Promise<TransportResult>;
}
