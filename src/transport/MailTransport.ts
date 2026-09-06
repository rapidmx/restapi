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

/** The outcome of a `MailTransport.send()` call. */
export interface TransportResult {
    accepted: string[];
    rejected: string[];
    /** The `Message-ID` the relaying MTA recorded for this transaction, if reported. */
    messageId?: string;
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
