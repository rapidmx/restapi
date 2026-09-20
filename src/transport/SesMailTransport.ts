///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import type { SendEmailCommandOutput, SESv2Client } from "@aws-sdk/client-sesv2";
import { ObjectDecorators } from "@rapidrest/core";
import { MailTransport, OutboundMessage, TransportError, TransportResult } from "./MailTransport.js";
import { cleanDiagnosticText, transportFailuresOf } from "./TransportResultUtils.js";
import { importAwsClientSESv2 } from "../shared.js";
const { Config, Logger } = ObjectDecorators;

/** SES errors that clear on their own: throttling and a busy or unavailable service. */
const TEMPORARY_SES_ERRORS: ReadonlySet<string> = new Set([
    "TooManyRequestsException",
    "ThrottlingException",
    "LimitExceededException",
    "ServiceUnavailable",
    "ServiceUnavailableException",
    "InternalFailure",
    "InternalServerError",
]);

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
 * own catch-block shape for the failure case. The failure carries SES's own diagnosis: `error` holds the exception's
 * name (as `code`), message, HTTP status and request id, and every recipient gets a `failures` entry saying the same.
 * SES throttling, service errors and any server-side fault are marked `temporary`.
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
            const name: string | undefined = typeof err.name === "string" ? err.name : undefined;
            const text: string = cleanDiagnosticText(err.message) ?? "SES rejected the message.";
            const error: TransportError = {
                message: text,
                ...(name ? { code: name } : {}),
                command: "SendEmail",
                response: name ? `${name}: ${text}` : text,
                ...(typeof err.$metadata?.httpStatusCode === "number" ? { responseCode: err.$metadata.httpStatusCode } : {}),
                ...(typeof err.$metadata?.requestId === "string" ? { requestId: err.$metadata.requestId } : {}),
            };
            const temporary: boolean = err.$fault === "server" || (!!name && TEMPORARY_SES_ERRORS.has(name));
            const failures = transportFailuresOf({ accepted: [], rejected: message.envelopeTo, error }, message.envelopeTo).map(
                (failure) => ({ ...failure, temporary }),
            );
            return { accepted: [], rejected: message.envelopeTo, failures, error };
        }
    }
}
