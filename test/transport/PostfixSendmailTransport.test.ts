///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for PostfixSendmailTransport - `nodemailer` is mocked so no real sendmail invocation
// occurs.
vi.mock("nodemailer", () => ({
    createTransport: vi.fn(),
}));

import * as nodemailer from "nodemailer";
import { PostfixSendmailTransport } from "../../src/transport/PostfixSendmailTransport.js";
import type { OutboundMessage } from "../../src/transport/MailTransport.js";

const mockCreateTransport = nodemailer.createTransport as any;

function makeMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
    return {
        raw: Buffer.from("From: a@x.com\r\nTo: b@x.com\r\nSubject: hi\r\n\r\nBody"),
        envelopeFrom: "a@x.com",
        envelopeTo: ["b@x.com"],
        ...overrides,
    };
}

describe("PostfixSendmailTransport Tests", () => {
    let transport: PostfixSendmailTransport;
    let sendMail: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        transport = new PostfixSendmailTransport();
        sendMail = vi.fn();
        mockCreateTransport.mockReturnValue({ sendMail });
    });

    it("Configures the transport with the configured sendmail path.", async () => {
        (transport as any).sendmailPath = "/opt/sendmail/bin/sendmail";
        sendMail.mockResolvedValue({ accepted: ["b@x.com"], rejected: [], messageId: "<abc@x.com>" });

        await transport.send(makeMessage());

        expect(mockCreateTransport).toHaveBeenCalledWith({
            sendmail: true,
            path: "/opt/sendmail/bin/sendmail",
            newline: "unix",
        });
    });

    it("Passes the envelope and raw source to sendMail.", async () => {
        sendMail.mockResolvedValue({ accepted: ["b@x.com"], rejected: [], messageId: "<abc@x.com>" });
        const message = makeMessage();

        await transport.send(message);

        expect(sendMail).toHaveBeenCalledWith({
            envelope: { from: message.envelopeFrom, to: message.envelopeTo },
            raw: message.raw,
        });
    });

    it("Maps accepted/rejected/messageId from nodemailer's info object on success.", async () => {
        sendMail.mockResolvedValue({ accepted: ["b@x.com", "c@x.com"], rejected: ["d@x.com"], messageId: "<xyz@x.com>" });

        const result = await transport.send(makeMessage({ envelopeTo: ["b@x.com", "c@x.com", "d@x.com"] }));

        expect(result).toEqual({
            accepted: ["b@x.com", "c@x.com"],
            rejected: ["d@x.com"],
            messageId: "<xyz@x.com>",
        });
    });

    it("Falls back to envelopeTo when info.accepted is not provided.", async () => {
        sendMail.mockResolvedValue({ rejected: [], messageId: "<xyz@x.com>" });
        const message = makeMessage({ envelopeTo: ["b@x.com", "c@x.com"] });

        const result = await transport.send(message);

        expect(result.accepted).toEqual(["b@x.com", "c@x.com"]);
    });

    it("Defaults rejected to an empty array when info.rejected is not provided.", async () => {
        sendMail.mockResolvedValue({ accepted: ["b@x.com"], messageId: "<xyz@x.com>" });

        const result = await transport.send(makeMessage());

        expect(result.rejected).toEqual([]);
    });

    it("Coerces non-string accepted/rejected entries (e.g. address objects) to strings.", async () => {
        sendMail.mockResolvedValue({
            accepted: [{ toString: () => "b@x.com" }],
            rejected: [{ toString: () => "d@x.com" }],
        });

        const result = await transport.send(makeMessage());

        expect(result.accepted).toEqual(["b@x.com"]);
        expect(result.rejected).toEqual(["d@x.com"]);
    });

    it("Returns an all-rejected result with no messageId when sendMail rejects.", async () => {
        sendMail.mockRejectedValue(new Error("relay refused"));
        const message = makeMessage({ envelopeTo: ["b@x.com", "c@x.com"] });

        const result = await transport.send(message);

        expect(result).toMatchObject({ accepted: [], rejected: ["b@x.com", "c@x.com"] });
        expect(result.messageId).toBeUndefined();
    });

    it("Says why: the error and every recipient's failure carry nodemailer's message and code, and the sendmail path.", async () => {
        (transport as any).sendmailPath = "/usr/sbin/sendmail";
        sendMail.mockRejectedValue(Object.assign(new Error("Sendmail exited with code 75"), { code: "ESENDMAIL" }));

        const result = await transport.send(makeMessage({ envelopeTo: ["b@x.com", "c@x.com"] }));

        expect(result.error).toEqual({ message: "Sendmail exited with code 75", code: "ESENDMAIL", command: "/usr/sbin/sendmail" });
        expect(result.failures).toEqual([
            { address: "b@x.com", response: "Sendmail exited with code 75", command: "/usr/sbin/sendmail" },
            { address: "c@x.com", response: "Sendmail exited with code 75", command: "/usr/sbin/sendmail" },
        ]);
    });

    it("Keeps what an SMTP-speaking error reports: its command, response and reply code, and the status they carry.", async () => {
        sendMail.mockRejectedValue(
            Object.assign(new Error("Recipient refused"), {
                code: "EENVELOPE",
                command: "RCPT TO",
                response: "554 5.7.1 <b@x.com>: Recipient address rejected: Access denied\u0007",
                responseCode: 554,
            }),
        );

        const result = await transport.send(makeMessage());

        expect(result.error).toEqual({
            message: "Recipient refused",
            code: "EENVELOPE",
            command: "RCPT TO",
            response: "554 5.7.1 <b@x.com>: Recipient address rejected: Access denied",
            responseCode: 554,
        });
        expect(result.failures).toEqual([
            {
                address: "b@x.com",
                code: 554,
                enhancedCode: "5.7.1",
                response: "554 5.7.1 <b@x.com>: Recipient address rejected: Access denied",
                command: "RCPT TO",
                temporary: false,
            },
        ]);
    });

    describe("what sendmail prints and its exit status", () => {
        /** A stand-in for the sendmail child process nodemailer spawns: an event emitter with an error stream. */
        const fakeChild = () => {
            const listeners: Record<string, Array<(...args: any[]) => void>> = {};
            const on = (event: string, listener: (...args: any[]) => void) => {
                (listeners[event] ??= []).push(listener);
            };
            const child: any = {
                stderr: { on },
                once: on,
                emit: (event: string, ...args: any[]) => (listeners[event] ?? []).forEach((listener) => listener(...args)),
            };
            return child;
        };

        /** A nodemailer transport whose spawn hook hands out child and whose sendMail runs script against it. */
        const withSendmail = (child: any, script: () => void) => {
            const inner: any = { _spawn: vi.fn().mockReturnValue(child) };
            mockCreateTransport.mockReturnValue({
                transporter: inner,
                sendMail: vi.fn().mockImplementation(async () => {
                    inner._spawn("/usr/sbin/sendmail", ["-i"]);
                    script();
                    throw Object.assign(new Error("Sendmail exited with code 75"), { code: "ESENDMAIL" });
                }),
            });
            return inner;
        };

        it("Captures stderr and the exit status off the child process, and marks a temporary exit code temporary.", async () => {
            const child = fakeChild();
            withSendmail(child, () => {
                child.emit("data", "postdrop: warning: unable to look up public/pickup: No such file or directory\n");
                child.emit("exit", 75);
            });

            const result = await transport.send(makeMessage());

            expect(result.error).toMatchObject({
                message: "Sendmail exited with code 75",
                code: "ESENDMAIL",
                exitCode: 75,
                stderr: "postdrop: warning: unable to look up public/pickup: No such file or directory",
            });
            expect(result.failures).toEqual([
                {
                    address: "b@x.com",
                    response: "postdrop: warning: unable to look up public/pickup: No such file or directory",
                    command: "/usr/sbin/sendmail",
                    stderr: "postdrop: warning: unable to look up public/pickup: No such file or directory",
                    temporary: true,
                },
            ]);
        });

        it("Marks a permanent exit code permanent, keeps only the tail of a long error stream, and ignores a signal exit.", async () => {
            const child = fakeChild();
            withSendmail(child, () => {
                child.emit("data", Buffer.from("x".repeat(6000) + "sendmail: fatal: bad usage"));
                child.emit("exit", null);
                child.emit("exit", 64);
            });

            const result = await transport.send(makeMessage());

            expect(result.error!.exitCode).toBe(64);
            expect(result.error!.stderr!.length).toBeLessThanOrEqual(2000);
            expect(result.error!.stderr).toMatch(/sendmail: fatal: bad usage$/);
            expect(result.failures![0].temporary).toBe(false);
        });

        it("Returns what it can when nodemailer offers no spawn hook, or the process has no streams.", async () => {
            mockCreateTransport.mockReturnValue({ transporter: {}, sendMail: vi.fn().mockRejectedValue(new Error("nope")) });
            expect((await transport.send(makeMessage())).error).toMatchObject({ message: "nope" });

            const inner: any = { _spawn: vi.fn().mockReturnValue(undefined) };
            mockCreateTransport.mockReturnValue({
                transporter: inner,
                sendMail: vi.fn().mockImplementation(async () => {
                    inner._spawn("sendmail", []);
                    throw new Error("nope");
                }),
            });
            const result = await transport.send(makeMessage());
            expect(result.error).toMatchObject({ message: "nope" });
            expect(result.error!.exitCode).toBeUndefined();
        });
    });

    it("Logs the error via the injected logger when sendMail rejects.", async () => {
        const error = vi.fn();
        (transport as any).logger = { error };
        sendMail.mockRejectedValue(new Error("relay refused"));

        await transport.send(makeMessage());

        expect(error).toHaveBeenCalledWith(expect.stringContaining("relay refused"));
    });

    it("Does not throw when no logger is set and sendMail rejects.", async () => {
        sendMail.mockRejectedValue(new Error("relay refused"));

        await expect(transport.send(makeMessage())).resolves.toMatchObject({
            accepted: [],
            rejected: expect.any(Array),
        });
    });
});
