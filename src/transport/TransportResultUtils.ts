///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import type { MailTransport, OutboundMessage, TransportError, TransportFailure, TransportResult } from "./MailTransport.js";

/** The longest a piece of diagnostic text from a mail system is kept - see `cleanDiagnosticText()`. */
export const MAX_DIAGNOSTIC_LENGTH: number = 2000;

/**
 * Diagnostic text from a mail system made safe to store and show: anything that is not a string is `undefined`, control
 * characters other than line breaks and tabs are dropped (a terminal escape sequence has no business in a message or a
 * log), and it is cut to `max` characters. Returns `undefined` for text with nothing left.
 */
export function cleanDiagnosticText(value: unknown, max: number = MAX_DIAGNOSTIC_LENGTH): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    // eslint-disable-next-line no-control-regex
    const cleaned: string = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
    return cleaned.length > 0 ? cleaned.slice(0, max) : undefined;
}

/**
 * The SMTP reply code (`554`) and RFC 3463 enhanced status code (`5.7.1`) in a mail system's diagnostic text, when it
 * has them - e.g. `554 5.7.1 <x@example.net>: Recipient address rejected: Access denied`, as Postfix words a refusal - and
 * whether that makes the failure `temporary` (a 4xx: worth retrying) or not (a 5xx). Text with neither yields `{}`.
 */
export function parseSmtpStatus(text: string | undefined): { code?: number; enhancedCode?: string; temporary?: boolean } {
    const enhancedCode: string | undefined = text?.match(/(?<![\d.])([245]\.\d{1,3}\.\d{1,3})(?![\d.])/)?.[1];
    const codeText: string | undefined = text?.match(/(?:^|\n)\s*(?:smtp;\s*)?([245]\d\d)[ -]/i)?.[1];
    const code: number | undefined = codeText ? Number(codeText) : undefined;
    const leading: string | undefined = enhancedCode ? enhancedCode[0] : codeText?.[0];
    return {
        ...(code !== undefined ? { code } : {}),
        ...(enhancedCode ? { enhancedCode } : {}),
        ...(leading === "4" ? { temporary: true } : leading === "5" ? { temporary: false } : {}),
    };
}

/**
 * Thrown by `sendOrThrow()` when a `MailTransport` reports that it relayed the message to nobody, or rejected
 * any envelope recipient. Every bundled transport reports a relay failure through `TransportResult.rejected`
 * rather than throwing, so a caller that only `await`s `send()` would otherwise treat a failed send as sent.
 */
export class TransportRejectedError extends Error {
    public readonly result: TransportResult | undefined;

    constructor(result: TransportResult | undefined) {
        super(
            `The mail transport did not accept the message (accepted: ${(result?.accepted ?? []).length}, rejected: ${
                (result?.rejected ?? []).length
            }).` + (result?.error?.message ? ` ${result.error.message}` : ""),
        );
        this.name = "TransportRejectedError";
        this.result = result;
    }
}

/** `true` when `result` shows at least one accepted recipient and no rejected ones. A missing result (a
 * transport that returns nothing) is treated as not delivered. */
export function isTransportResultDelivered(result: TransportResult | undefined): boolean {
    return !!result && (result.accepted ?? []).length > 0 && (result.rejected ?? []).length === 0;
}

/** Sends `message` through `transport` and throws `TransportRejectedError` unless the result shows it was
 * accepted for every envelope recipient - see `isTransportResultDelivered()`. */
export async function sendOrThrow(transport: MailTransport, message: OutboundMessage): Promise<TransportResult> {
    const result: TransportResult = await transport.send(message);
    if (!isTransportResultDelivered(result)) {
        throw new TransportRejectedError(result);
    }
    return result;
}

/** The first line of `error`'s own words about what went wrong, as the short reason a person can be shown. */
function errorReason(error: TransportError | undefined): string | undefined {
    return (
        cleanDiagnosticText(error?.response)?.split("\n")[0] ??
        cleanDiagnosticText(error?.stderr)?.split("\n")[0] ??
        cleanDiagnosticText(error?.message)?.split("\n")[0]
    );
}

/**
 * One `TransportFailure` for every recipient `result` did not deliver to - the transport's own entry where it gave
 * one (matched case-insensitively), otherwise one built from the call's `error`. `envelopeTo` names the recipients
 * when the transport reported none as rejected (a transport that failed the whole call). Every entry has its `address`
 * and, where the text carries them, the SMTP and enhanced status codes; text is cleaned (`cleanDiagnosticText()`).
 */
export function transportFailuresOf(result: TransportResult | undefined, envelopeTo: string[] = []): TransportFailure[] {
    const rejected: string[] = result?.rejected ?? [];
    const undelivered: string[] = rejected.length > 0 ? rejected : (result?.accepted ?? []).length > 0 ? [] : envelopeTo;
    const reported: TransportFailure[] = result?.failures ?? [];
    return undelivered.map((address) => {
        const own: TransportFailure | undefined = reported.find((failure) => failure.address?.toLowerCase() === address.toLowerCase());
        const response: string | undefined = cleanDiagnosticText(own ? own.response : errorReason(result?.error));
        const stderr: string | undefined = cleanDiagnosticText(own ? own.stderr : result?.error?.stderr);
        const status = parseSmtpStatus(response ?? stderr);
        const code: number | undefined = own?.code ?? status.code;
        const enhancedCode: string | undefined = own?.enhancedCode ?? status.enhancedCode;
        const command: string | undefined = own ? own.command : result?.error?.command;
        const temporary: boolean | undefined = own?.temporary ?? status.temporary;
        return {
            address,
            ...(code !== undefined ? { code } : {}),
            ...(enhancedCode ? { enhancedCode } : {}),
            ...(response ? { response } : {}),
            ...(command ? { command } : {}),
            ...(stderr ? { stderr } : {}),
            ...(temporary !== undefined ? { temporary } : {}),
        };
    });
}

/**
 * What a client is told when a send fails, in `MailRelayError.details`. Diagnostic text only: never the message or any
 * credential.
 */
export interface MailRelayFailureDetails {
    /** The `name` of the `MailTransport` that failed (e.g. `postfix-sendmail`, `ses`), when it has one. */
    transport?: string;
    /** Every envelope recipient the message was to be relayed to. */
    recipients: string[];
    accepted: string[];
    rejected: string[];
    /** One entry per recipient that was not delivered to - see `transportFailuresOf()`. */
    failures: TransportFailure[];
    /** The error that failed the whole call, when there was one. */
    error?: TransportError;
}

/** The plain-language sentence `MailRelayError` carries as its message: what failed, for whom, and the mail system's own
 * first-line reason (with its status codes). */
export function describeRelayFailure(details: MailRelayFailureDetails): string {
    const first: TransportFailure | undefined = details.failures[0];
    const codes: string = [first?.code, first?.enhancedCode].filter((part) => part !== undefined).join(" ");
    const response: string = first?.response ?? "";
    // The mail system's own wording usually starts with its status codes already.
    const reason: string = response.startsWith(codes) ? response : `${codes} ${response}`.trim();
    const detail: string | undefined = reason || errorReason(details.error);
    const who: string = details.failures.length > 0 ? details.failures.map((failure) => failure.address).join(", ") : "its recipients";
    return (
        `This message could not be sent: the mail system refused it for ${who}` +
        (detail ? `. Reason given: ${detail.slice(0, 500)}` : ".") +
        (first?.temporary === true ? " This looks temporary; trying again later may work." : "")
    );
}

/**
 * Thrown when a `MailTransport` did not relay a message to anybody (`scanAndRelay()`) - a 502 whose `message` is a
 * sentence a person can act on, and whose `details` (`MailRelayFailureDetails`) carries the mail system's own diagnostic
 * text for a client to show alongside it: per-recipient SMTP/enhanced status codes and responses, the transport error and
 * what its delivery agent printed. The framework serializes it into the response body like `code`/`status`/`message`.
 */
export class MailRelayError extends ApiError {
    public readonly details: MailRelayFailureDetails;

    constructor(details: MailRelayFailureDetails) {
        super(ApiErrors.INTERNAL_ERROR, 502, describeRelayFailure(details));
        // `ApiError` resets the prototype to its own.
        Object.setPrototypeOf(this, MailRelayError.prototype);
        this.details = details;
    }
}

/**
 * Whether a failed relay is one no retry can fix: the message failed spam/malware scanning (a 422 - scanning it again gives
 * the same answer), or the transport refused it and every recipient's failure is explicitly permanent (an SMTP 5xx). Anything
 * else - a transport that threw, a 4xx, a failure that says nothing either way - may pass later and is worth another attempt.
 */
export function isPermanentRelayFailure(err: unknown): boolean {
    if (err instanceof MailRelayError) {
        const failures: TransportFailure[] = err.details.failures;
        return failures.length > 0 && failures.every((failure) => failure.temporary === false);
    }
    return err instanceof ApiError && err.status === 422;
}

/** The `MailRelayFailureDetails` of a relay that reached nobody: `result` is what the transport said (possibly nothing). */
export function relayFailureDetails(result: TransportResult | undefined, envelopeTo: string[], transportName?: string): MailRelayFailureDetails {
    const source: TransportError | undefined = result?.error;
    const response: string | undefined = cleanDiagnosticText(source?.response);
    const stderr: string | undefined = cleanDiagnosticText(source?.stderr);
    const error: TransportError | undefined = source
        ? {
              message: cleanDiagnosticText(source.message) ?? "The mail transport reported an error.",
              ...(source.code ? { code: source.code } : {}),
              ...(response ? { response } : {}),
              ...(source.responseCode !== undefined ? { responseCode: source.responseCode } : {}),
              ...(source.command ? { command: source.command } : {}),
              ...(stderr ? { stderr } : {}),
              ...(source.exitCode !== undefined ? { exitCode: source.exitCode } : {}),
              ...(source.requestId ? { requestId: source.requestId } : {}),
          }
        : undefined;
    return {
        ...(transportName ? { transport: transportName } : {}),
        recipients: envelopeTo,
        accepted: result?.accepted ?? [],
        rejected: result?.rejected ?? [],
        failures: transportFailuresOf(result, envelopeTo),
        ...(error ? { error } : {}),
    };
}
