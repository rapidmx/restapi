///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as nodemailer from "nodemailer";
import { ObjectDecorators } from "@rapidrest/core";
import { MailTransport, OutboundMessage, TransportError, TransportFailure, TransportResult } from "./MailTransport.js";
import { cleanDiagnosticText, MAX_DIAGNOSTIC_LENGTH, transportFailuresOf } from "./TransportResultUtils.js";
const { Config, Logger } = ObjectDecorators;

/** How much of what `sendmail` prints is kept: its last characters, which is where a fatal error is. */
const MAX_CAPTURED_OUTPUT = MAX_DIAGNOSTIC_LENGTH;

/** `sysexits.h` statuses of `sendmail` after which trying again later can work: temporary failure, service unavailable,
 * operating system, file and I/O errors, and "can't create" (a full queue). Everything else (bad usage, a refused
 * address, a configuration error, ...) will fail the same way again. */
const TEMPORARY_SENDMAIL_EXIT_CODES: ReadonlySet<number> = new Set([69, 71, 72, 73, 74, 75]);

/** What `sendmail` did, gathered while nodemailer ran it - see `PostfixSendmailTransport.captureSendmail()`. */
interface SendmailCapture {
    stderr: string;
    exitCode?: number;
}

/**
 * `MailTransport` adapter that hands a fully composed message to the local Postfix (or any other locally
 * installed MTA) via the `sendmail(1)` command-line interface — the simplest integration that works with
 * essentially any Unix MTA, and lets Postfix (with an OpenDKIM milter) apply DKIM signing on the way out
 * exactly as it would for mail submitted by any other local process.
 *
 * `sendmail` only *queues* the message: it exits 0 once Postfix has it, and what the remote server says about each
 * recipient comes back later as a bounce message (see `BaseMailIngestRoute`). A failure this transport can report is
 * therefore local - `sendmail` missing, Postfix refusing the submission or its queue being unavailable - and applies to
 * every recipient alike. When one happens the result carries `error` and one `failures` entry per recipient with what
 * nodemailer knows (its message and code) plus what `sendmail` printed on stderr and its exit status, neither of which
 * nodemailer reports itself: they are captured off the child process it spawns.
 *
 * @author Jean-Philippe Steinmetz
 */
export class PostfixSendmailTransport implements MailTransport {
    public readonly name: string = "postfix-sendmail";

    @Config("mail:transport:sendmail:path", "/usr/sbin/sendmail")
    private sendmailPath: string = "/usr/sbin/sendmail";

    @Logger
    private logger: any;

    /**
     * Records `transport`'s `sendmail` child's error stream and exit status into `capture`. nodemailer keeps the process
     * to itself and only reports "Sendmail exited with code N", so this wraps the `_spawn` hook it exposes (for
     * mocking) to listen to the same process. Best effort: a nodemailer without the hook simply captures nothing.
     */
    private captureSendmail(transport: any, capture: SendmailCapture): void {
        const inner: any = transport.transporter;
        if (typeof inner?._spawn !== "function") {
            return;
        }
        const spawn = inner._spawn;
        inner._spawn = (...args: any[]) => {
            const child: any = spawn(...args);
            child?.stderr?.on("data", (chunk: Buffer | string) => {
                capture.stderr = (capture.stderr + chunk.toString()).slice(-MAX_CAPTURED_OUTPUT);
            });
            child?.once("exit", (code: number | null) => {
                if (code !== null) {
                    capture.exitCode = code;
                }
            });
            return child;
        };
    }

    public async send(message: OutboundMessage): Promise<TransportResult> {
        const transport = nodemailer.createTransport({
            sendmail: true,
            path: this.sendmailPath,
            newline: "unix",
        });
        const capture: SendmailCapture = { stderr: "" };
        this.captureSendmail(transport, capture);

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
            const stderr: string | undefined = cleanDiagnosticText(capture.stderr, MAX_CAPTURED_OUTPUT);
            const response: string | undefined = cleanDiagnosticText(err.response);
            const error: TransportError = {
                message: cleanDiagnosticText(err.message) ?? "sendmail failed.",
                code: typeof err.code === "string" ? err.code : undefined,
                command: typeof err.command === "string" ? err.command : this.sendmailPath,
                ...(response ? { response } : {}),
                ...(typeof err.responseCode === "number" ? { responseCode: err.responseCode } : {}),
                ...(stderr ? { stderr } : {}),
                ...(capture.exitCode !== undefined ? { exitCode: capture.exitCode } : {}),
            };
            const failures: TransportFailure[] = transportFailuresOf(
                { accepted: [], rejected: message.envelopeTo, error },
                message.envelopeTo,
            ).map((failure) => ({
                ...failure,
                ...(failure.temporary === undefined && capture.exitCode !== undefined
                    ? { temporary: TEMPORARY_SENDMAIL_EXIT_CODES.has(capture.exitCode) }
                    : {}),
            }));
            return { accepted: [], rejected: message.envelopeTo, failures, error };
        }
    }
}
