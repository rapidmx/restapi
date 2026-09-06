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

        expect(result).toEqual({ accepted: [], rejected: ["b@x.com", "c@x.com"] });
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

        await expect(transport.send(makeMessage())).resolves.toEqual({
            accepted: [],
            rejected: expect.any(Array),
        });
    });
});
