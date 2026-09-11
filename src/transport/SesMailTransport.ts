///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { SendEmailCommandOutput, SESv2Client } from "@aws-sdk/client-sesv2";
import { ObjectDecorators } from "@rapidrest/core";
import { MailTransport, OutboundMessage, TransportResult } from "./MailTransport.js";
import { importAwsClientSESv2 } from "../shared.js";
const { Config, Logger } = ObjectDecorators;

/**
 * `MailTransport` adapter that hands a fully composed message directly to AWS SES's `SendEmail` API
 * (raw-content mode) — the outbound half of this repo's RapidMX↔SES bridge. Unlike
 * `PostfixSendmailTransport`, this never shells out to a local MTA: SES itself handles DKIM signing
 * (Easy DKIM — see this repo's README/`.claude/NOTES.md` for why RapidMX's own `DkimKeyProvider`
 * machinery is deliberately not used for domains relayed through this bridge), SPF/DMARC alignment, and
 * internet-facing SMTP delivery/retries.
 *
 * `envelopeFrom`/`envelopeTo` are passed as `FromEmailAddress`/`Destination.ToAddresses` — explicit
 * overrides distinct from whatever `From`/`To` headers `message.raw` itself carries — so this always
 * relays to the exact envelope RapidMX resolved (including a distribution list's rewritten envelope),
 * never a header SES might otherwise parse differently.
 *
 * Credentials are resolved via the standard AWS SDK credential provider chain (an IAM role in any real
 * deployment) — this class deliberately has no secret/key configuration of its own.
 *
 * SES's `SendEmail` call is all-or-nothing (it throws on a rejection — an unverified `From` identity, a
 * sending-quota breach, etc.) rather than reporting per-recipient acceptance the way `sendmail` does, so
 * `accepted`/`rejected` below are necessarily all-or-nothing too, matching `PostfixSendmailTransport`'s
 * own catch-block shape for the failure case.
 *
 * @author Jean-Philippe Steinmetz
 */
export class SesMailTransport implements MailTransport {
    public readonly name: string = "ses";

    @Config("mail:transport:ses:region")
    private region?: string;

    /** SES configuration set name for delivery/bounce/complaint event tracking - optional, omitted from
     * the `SendEmail` call entirely when unset. */
    @Config("mail:transport:ses:configuration_set")
    private configurationSet?: string;

    @Logger
    private logger: any;

    private client?: SESv2Client;

    private async getClient(sdk?: any): Promise<SESv2Client> {
        sdk = sdk ?? (await importAwsClientSESv2());
        if (!this.client) {
            this.client = new sdk.SESv2Client(this.region ? { region: this.region } : {});
        }
        return this.client as any;
    }

    public async send(message: OutboundMessage): Promise<TransportResult> {
        try {
            const sdk = await importAwsClientSESv2();
            const client = await this.getClient();
            const result: SendEmailCommandOutput = await client.send(
                new sdk.SendEmailCommand({
                    FromEmailAddress: message.envelopeFrom,
                    Destination: { ToAddresses: message.envelopeTo },
                    Content: { Raw: { Data: message.raw } },
                    ConfigurationSetName: this.configurationSet,
                }),
            );
            return { accepted: message.envelopeTo, rejected: [], messageId: result.MessageId };
        } catch (err: any) {
            this.logger?.error(`Failed to relay outbound message via SES: ${err.message}`);
            return { accepted: [], rejected: message.envelopeTo };
        }
    }
}
