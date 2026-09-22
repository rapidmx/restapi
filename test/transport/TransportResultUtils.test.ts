///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { ApiError } from "@rapidrest/core";
import {
    cleanDiagnosticText,
    describeRelayFailure,
    isPermanentRelayFailure,
    isTransportResultDelivered,
    MailRelayError,
    parseSmtpStatus,
    relayFailureDetails,
    sendOrThrow,
    TransportRejectedError,
    transportFailuresOf,
} from "../../src/transport/TransportResultUtils.js";

describe("TransportResultUtils Tests", () => {
    it("isTransportResultDelivered() requires an accepted recipient and no rejected ones.", () => {
        expect(isTransportResultDelivered({ accepted: ["a@x"], rejected: [] })).toBe(true);
        expect(isTransportResultDelivered({ accepted: [], rejected: [] })).toBe(false);
        expect(isTransportResultDelivered({ accepted: ["a@x"], rejected: ["b@x"] })).toBe(false);
        expect(isTransportResultDelivered({} as any)).toBe(false);
        expect(isTransportResultDelivered(undefined)).toBe(false);
    });

    it("sendOrThrow() returns the result when delivered and throws TransportRejectedError otherwise.", async () => {
        const message = { raw: Buffer.from("x"), envelopeFrom: "a@x", envelopeTo: ["b@x"] };
        const ok = { name: "t", send: vi.fn().mockResolvedValue({ accepted: ["b@x"], rejected: [] }) };
        await expect(sendOrThrow(ok, message)).resolves.toEqual({ accepted: ["b@x"], rejected: [] });

        const rejected = { name: "t", send: vi.fn().mockResolvedValue({ accepted: [], rejected: ["b@x"] }) };
        const err: any = await sendOrThrow(rejected, message).catch((e) => e);
        expect(err).toBeInstanceOf(TransportRejectedError);
        expect(err.result).toEqual({ accepted: [], rejected: ["b@x"] });
        expect(err.message).toContain("accepted: 0, rejected: 1");

        const nothing = { name: "t", send: vi.fn().mockResolvedValue(undefined) };
        await expect(sendOrThrow(nothing, message)).rejects.toThrow("accepted: 0, rejected: 0");
    });

    it("TransportRejectedError adds the transport's own error message when it gave one.", async () => {
        const message = { raw: Buffer.from("x"), envelopeFrom: "a@x", envelopeTo: ["b@x"] };
        const failing = {
            name: "t",
            send: vi.fn().mockResolvedValue({ accepted: [], rejected: ["b@x"], error: { message: "Sendmail exited with code 75" } }),
        };

        await expect(sendOrThrow(failing, message)).rejects.toThrow(
            "The mail transport did not accept the message (accepted: 0, rejected: 1). Sendmail exited with code 75",
        );
    });

    describe("cleanDiagnosticText()", () => {
        it("keeps text, normalizes line breaks, drops control characters and trims.", () => {
            expect(cleanDiagnosticText("  554 5.7.1 no\r\nsecond\rthird\u0007\u001b[31m \t ")).toBe("554 5.7.1 no\nsecond\nthird[31m");
        });

        it("caps the length, and gives undefined for anything that is not text or has none.", () => {
            expect(cleanDiagnosticText("x".repeat(3000))).toHaveLength(2000);
            expect(cleanDiagnosticText("abcdef", 3)).toBe("abc");
            expect(cleanDiagnosticText("\u0007 \n")).toBeUndefined();
            expect(cleanDiagnosticText(42)).toBeUndefined();
            expect(cleanDiagnosticText(undefined)).toBeUndefined();
        });
    });

    describe("parseSmtpStatus()", () => {
        it("reads the SMTP reply code and enhanced status Postfix words a refusal with, and calls a 5xx permanent.", () => {
            expect(parseSmtpStatus("554 5.7.1 <b@x.com>: Recipient address rejected: Access denied")).toEqual({
                code: 554,
                enhancedCode: "5.7.1",
                temporary: false,
            });
        });

        it("calls a 4xx temporary, reads a status after an smtp; diagnostic type and on a later line, and works with either code alone.", () => {
            expect(parseSmtpStatus("450 4.2.0 mailbox busy")).toEqual({ code: 450, enhancedCode: "4.2.0", temporary: true });
            expect(parseSmtpStatus("smtp; 552 message too big")).toEqual({ code: 552, temporary: false });
            expect(parseSmtpStatus("connect to mx[10.5.7.1]:25: timed out\n421 try later")).toEqual({ code: 421, temporary: true });
            expect(parseSmtpStatus("4.4.1 connection timed out")).toEqual({ enhancedCode: "4.4.1", temporary: true });
        });

        it("finds nothing in text without a status, and is not fooled by an address or version number.", () => {
            expect(parseSmtpStatus("sendmail: fatal: bad usage")).toEqual({});
            expect(parseSmtpStatus("connect to 10.5.7.1:25 refused")).toEqual({});
            expect(parseSmtpStatus("2.0.0 queued")).toEqual({ enhancedCode: "2.0.0" });
            expect(parseSmtpStatus(undefined)).toEqual({});
        });
    });

    describe("transportFailuresOf()", () => {
        it("uses the transport's own entry for a rejected recipient, matched case-insensitively, reading the status out of its text.", () => {
            const result = {
                accepted: ["a@x.com"],
                rejected: ["B@x.com"],
                failures: [{ address: "b@x.com", response: "554 5.7.1 \u0007Denied", command: "RCPT TO", stderr: "trace" }],
            };

            expect(transportFailuresOf(result)).toEqual([
                {
                    address: "B@x.com",
                    code: 554,
                    enhancedCode: "5.7.1",
                    response: "554 5.7.1 Denied",
                    command: "RCPT TO",
                    stderr: "trace",
                    temporary: false,
                },
            ]);
        });

        it("keeps codes and the temporary flag an entry states itself over what its text says.", () => {
            const result = {
                accepted: [],
                rejected: ["b@x.com"],
                failures: [{ address: "b@x.com", code: 451, enhancedCode: "4.7.1", response: "554 5.7.1 x", temporary: true }],
            };

            expect(transportFailuresOf(result)[0]).toMatchObject({ code: 451, enhancedCode: "4.7.1", temporary: true });
        });

        it("builds an entry from the call's error for a rejected recipient the transport said nothing about.", () => {
            const result = {
                accepted: [],
                rejected: ["b@x.com"],
                error: { message: "Sendmail exited with code 75", stderr: "sendmail: fatal: queue full", command: "sendmail" },
            };

            expect(transportFailuresOf(result)).toEqual([
                {
                    address: "b@x.com",
                    response: "sendmail: fatal: queue full",
                    command: "sendmail",
                    stderr: "sendmail: fatal: queue full",
                },
            ]);
        });

        it("prefers an error's response over its stderr over its message as the reason.", () => {
            const withResponse = transportFailuresOf({ accepted: [], rejected: ["b@x.com"], error: { message: "m", stderr: "s", response: "r" } });
            const withStderr = transportFailuresOf({ accepted: [], rejected: ["b@x.com"], error: { message: "m", stderr: "s" } });
            const withMessage = transportFailuresOf({ accepted: [], rejected: ["b@x.com"], error: { message: "m" } });

            expect(withResponse[0].response).toBe("r");
            expect(withStderr[0].response).toBe("s");
            expect(withMessage[0].response).toBe("m");
        });

        it("names the whole envelope when the transport rejected nobody in particular, and nobody when some were accepted.", () => {
            expect(transportFailuresOf({ accepted: [], rejected: [] }, ["a@x.com", "b@x.com"]).map((f) => f.address)).toEqual([
                "a@x.com",
                "b@x.com",
            ]);
            expect(transportFailuresOf({ accepted: ["a@x.com"], rejected: [] }, ["a@x.com"])).toEqual([]);
            expect(transportFailuresOf(undefined, ["a@x.com"])).toEqual([{ address: "a@x.com" }]);
            expect(transportFailuresOf(undefined)).toEqual([]);
        });

        it("gives an entry with no text of its own no response, rather than borrowing the call's.", () => {
            const result = { accepted: [], rejected: ["b@x.com"], failures: [{ address: "b@x.com" }], error: { message: "boom" } };

            expect(transportFailuresOf(result)).toEqual([{ address: "b@x.com" }]);
        });
    });

    describe("describeRelayFailure() and MailRelayError", () => {
        const details = (over: any = {}) => ({ recipients: ["b@x.com"], accepted: [], rejected: ["b@x.com"], failures: [], ...over });

        it("names the recipients and the mail system's reason, with its status codes.", () => {
            const message = describeRelayFailure(
                details({
                    failures: [
                        { address: "b@x.com", code: 554, enhancedCode: "5.7.1", response: "Recipient address rejected" },
                        { address: "c@x.com" },
                    ],
                }),
            );

            expect(message).toBe(
                "This message could not be sent: the mail system refused it for b@x.com, c@x.com. Reason given: 554 5.7.1 Recipient address rejected",
            );
            // Not repeated when the mail system's own wording starts with them.
            expect(
                describeRelayFailure(details({ failures: [{ address: "b@x.com", code: 554, enhancedCode: "5.7.1", response: "554 5.7.1 Denied" }] })),
            ).toBe("This message could not be sent: the mail system refused it for b@x.com. Reason given: 554 5.7.1 Denied");
        });

        it("says a temporary failure looks temporary, and cuts an over-long reason.", () => {
            const message = describeRelayFailure(
                details({ failures: [{ address: "b@x.com", enhancedCode: "4.2.0", response: "y".repeat(900), temporary: true }] }),
            );

            expect(message).toContain("Reason given: 4.2.0 " + "y".repeat(494));
            expect(message).not.toContain("y".repeat(495));
            expect(message.endsWith(" This looks temporary; trying again later may work.")).toBe(true);
        });

        it("falls back to the transport error's own words, and to its recipients when it names none.", () => {
            expect(describeRelayFailure(details({ error: { message: "Sendmail exited with code 75" } }))).toBe(
                "This message could not be sent: the mail system refused it for its recipients. Reason given: Sendmail exited with code 75",
            );
            expect(describeRelayFailure(details())).toBe("This message could not be sent: the mail system refused it for its recipients.");
        });

        it("is a 502 ApiError carrying its details, which the framework serializes with the code, status and message.", () => {
            const error = new MailRelayError(details({ transport: "postfix-sendmail", failures: [{ address: "b@x.com", response: "nope" }] }));

            expect(error).toBeInstanceOf(ApiError);
            expect(error).toBeInstanceOf(MailRelayError);
            expect(error.status).toBe(502);
            expect(error.details.transport).toBe("postfix-sendmail");
            // What `Server.serializeError()` does: spread the own enumerable properties.
            const serialized: any = { ...error, message: error.message };
            expect(serialized).toMatchObject({ code: error.code, status: 502, details: { transport: "postfix-sendmail" } });
            expect(JSON.parse(JSON.stringify(serialized)).details.failures).toEqual([{ address: "b@x.com", response: "nope" }]);
        });
    });

    describe("relayFailureDetails()", () => {
        it("carries what the transport said - cleaned - with one failure per recipient and the transport's name.", () => {
            const result = {
                accepted: [],
                rejected: ["b@x.com"],
                error: {
                    message: "Sendmail exited with code 75",
                    code: "ESENDMAIL",
                    response: "421 4.3.0 try later\u0007",
                    responseCode: 421,
                    command: "sendmail",
                    stderr: "sendmail: fatal\u001b",
                    exitCode: 75,
                    requestId: "req-1",
                },
            };

            expect(relayFailureDetails(result, ["b@x.com"], "postfix-sendmail")).toEqual({
                transport: "postfix-sendmail",
                recipients: ["b@x.com"],
                accepted: [],
                rejected: ["b@x.com"],
                failures: [
                    {
                        address: "b@x.com",
                        code: 421,
                        enhancedCode: "4.3.0",
                        response: "421 4.3.0 try later",
                        command: "sendmail",
                        stderr: "sendmail: fatal",
                        temporary: true,
                    },
                ],
                error: {
                    message: "Sendmail exited with code 75",
                    code: "ESENDMAIL",
                    response: "421 4.3.0 try later",
                    responseCode: 421,
                    command: "sendmail",
                    stderr: "sendmail: fatal",
                    exitCode: 75,
                    requestId: "req-1",
                },
            });
        });

        it("leaves out what is not there: no error, no transport name, a transport that returned nothing.", () => {
            expect(relayFailureDetails({ accepted: [], rejected: ["b@x.com"] }, ["b@x.com"])).toEqual({
                recipients: ["b@x.com"],
                accepted: [],
                rejected: ["b@x.com"],
                failures: [{ address: "b@x.com" }],
            });
            expect(relayFailureDetails(undefined, ["b@x.com"], "t")).toEqual({
                transport: "t",
                recipients: ["b@x.com"],
                accepted: [],
                rejected: [],
                failures: [{ address: "b@x.com" }],
            });
            expect(relayFailureDetails({ accepted: [], rejected: [], error: { message: "\u0007" } }, []).error).toEqual({
                message: "The mail transport reported an error.",
            });
        });
    });

    describe("isPermanentRelayFailure()", () => {
        const failed = (...temporary: (boolean | undefined)[]) =>
            new MailRelayError({
                recipients: temporary.map((_, i) => `r${i}@x`),
                accepted: [],
                rejected: temporary.map((_, i) => `r${i}@x`),
                failures: temporary.map((flag, i) => ({ address: `r${i}@x`, ...(flag === undefined ? {} : { temporary: flag }) })),
            });

        it("is true when the transport refused the message and every recipient's failure is an explicit permanent one", () => {
            expect(isPermanentRelayFailure(failed(false))).toBe(true);
            expect(isPermanentRelayFailure(failed(false, false))).toBe(true);
        });

        it("is false when any failure is temporary or says nothing either way, or there are no failures to go by", () => {
            expect(isPermanentRelayFailure(failed(true))).toBe(false);
            expect(isPermanentRelayFailure(failed(false, true))).toBe(false);
            expect(isPermanentRelayFailure(failed(false, undefined))).toBe(false);
            expect(isPermanentRelayFailure(failed())).toBe(false);
            expect(isPermanentRelayFailure(new MailRelayError({ recipients: [], accepted: [], rejected: [], failures: [] }))).toBe(false);
        });

        it("is true for a spam/malware verdict (422) and false for any other error", () => {
            expect(isPermanentRelayFailure(new ApiError("invalid_request", 422, "failed scanning"))).toBe(true);
            expect(isPermanentRelayFailure(new ApiError("internal_error", 502, "bad gateway"))).toBe(false);
            expect(isPermanentRelayFailure(new Error("spawn sendmail ENOENT"))).toBe(false);
            expect(isPermanentRelayFailure(undefined)).toBe(false);
        });
    });
});
