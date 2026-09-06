///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as nodemailer from "nodemailer";
import { ObjectDecorators } from "@rapidrest/core";
import { MailTransport, OutboundMessage, TransportResult } from "./MailTransport.js";
const { Config, Logger } = ObjectDecorators;

/**
 * `MailTransport` adapter that hands a fully composed message to the local Postfix (or any other locally
 * installed MTA) via the `sendmail(1)` command-line interface — the simplest integration that works with
 * essentially any Unix MTA, and lets Postfix (with an OpenDKIM milter) apply DKIM signing on the way out
 * exactly as it would for mail submitted by any other local process.
 *
 * @author Jean-Philippe Steinmetz
 */
export class PostfixSendmailTransport implements MailTransport {
    public readonly name: string = "postfix-sendmail";

    @Config("mail:transport:sendmail:path", "/usr/sbin/sendmail")
    private sendmailPath: string = "/usr/sbin/sendmail";

    @Logger
    private logger: any;

    public async send(message: OutboundMessage): Promise<TransportResult> {
        const transport = nodemailer.createTransport({
            sendmail: true,
            path: this.sendmailPath,
            newline: "unix",
        });

        try {
            const info = await transport.sendMail({
                envelope: { from: message.envelopeFrom, to: message.envelopeTo },
                raw: message.raw,
            });
            return {
                accepted: (info.accepted ?? message.envelopeTo).map(String),
                rejected: (info.rejected ?? []).map(String),
                messageId: info.messageId,
            };
        } catch (err: any) {
            this.logger?.error(`Failed to relay outbound message via sendmail: ${err.message}`);
            return { accepted: [], rejected: message.envelopeTo };
        }
    }
}
