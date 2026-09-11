///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for SesMailTransport - `@aws-sdk/client-sesv2` is mocked so no real AWS call occurs.
// `mockImplementation` here must be a real `function`, not an arrow function - both are invoked with
// `new` by the code under test, and arrow functions can never be constructors.
const mockSend = vi.fn();
vi.mock("@aws-sdk/client-sesv2", () => ({
    SESv2Client: vi.fn().mockImplementation(function () {
        return { send: mockSend };
    }),
    SendEmailCommand: vi.fn().mockImplementation(function (input: any) {
        return { input };
    }),
}));

import { SESv2Client } from "@aws-sdk/client-sesv2";
import type { OutboundMessage } from "@rapidmx/restapi";
import { SesMailTransport } from "../../src/transport/SesMailTransport.js";

const mockClientCtor = SESv2Client as unknown as ReturnType<typeof vi.fn>;

function makeMessage(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
    return {
        raw: Buffer.from("From: a@x.com\r\nTo: b@x.com\r\nSubject: hi\r\n\r\nBody"),
        envelopeFrom: "a@x.com",
        envelopeTo: ["b@x.com"],
        ...overrides,
    };
}

describe("SesMailTransport Tests", () => {
    let transport: SesMailTransport;

    beforeEach(() => {
        transport = new SesMailTransport();
        mockSend.mockReset();
        mockClientCtor.mockClear();
    });

    it("Lazily constructs one SESv2Client, reused across calls, using the configured region.", async () => {
        (transport as any).region = "us-west-2";
        mockSend.mockResolvedValue({ MessageId: "<abc@x.com>" });

        await transport.send(makeMessage());
        await transport.send(makeMessage());

        expect(mockClientCtor).toHaveBeenCalledTimes(1);
        expect(mockClientCtor).toHaveBeenCalledWith({ region: "us-west-2" });
    });

    it("Constructs the client with no region override when none is configured.", async () => {
        mockSend.mockResolvedValue({ MessageId: "<abc@x.com>" });
        await transport.send(makeMessage());
        expect(mockClientCtor).toHaveBeenCalledWith({});
    });

    it("Passes envelopeFrom/envelopeTo as explicit overrides and the raw source as Content.Raw.Data.", async () => {
        mockSend.mockResolvedValue({ MessageId: "<abc@x.com>" });
        const message = makeMessage({ envelopeTo: ["b@x.com", "c@x.com"] });

        await transport.send(message);

        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({
                input: expect.objectContaining({
                    FromEmailAddress: "a@x.com",
                    Destination: { ToAddresses: ["b@x.com", "c@x.com"] },
                    Content: { Raw: { Data: message.raw } },
                }),
            }),
        );
    });

    it("Omits ConfigurationSetName when none is configured.", async () => {
        mockSend.mockResolvedValue({ MessageId: "<abc@x.com>" });
        await transport.send(makeMessage());
        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({ ConfigurationSetName: undefined }) }),
        );
    });

    it("Passes the configured ConfigurationSetName when set.", async () => {
        (transport as any).configurationSet = "outbound-tracking";
        mockSend.mockResolvedValue({ MessageId: "<abc@x.com>" });
        await transport.send(makeMessage());
        expect(mockSend).toHaveBeenCalledWith(
            expect.objectContaining({ input: expect.objectContaining({ ConfigurationSetName: "outbound-tracking" }) }),
        );
    });

    it("Returns all recipients as accepted and the returned MessageId on success.", async () => {
        mockSend.mockResolvedValue({ MessageId: "<abc@x.com>" });
        const message = makeMessage({ envelopeTo: ["b@x.com", "c@x.com"] });

        const result = await transport.send(message);

        expect(result).toEqual({ accepted: ["b@x.com", "c@x.com"], rejected: [], messageId: "<abc@x.com>" });
    });

    it("Returns an all-rejected result with no messageId when SES throws.", async () => {
        mockSend.mockRejectedValue(new Error("Email address is not verified"));
        const message = makeMessage({ envelopeTo: ["b@x.com", "c@x.com"] });

        const result = await transport.send(message);

        expect(result).toEqual({ accepted: [], rejected: ["b@x.com", "c@x.com"] });
    });

    it("Logs the error via the injected logger when SES throws.", async () => {
        const error = vi.fn();
        (transport as any).logger = { error };
        mockSend.mockRejectedValue(new Error("Email address is not verified"));

        await transport.send(makeMessage());

        expect(error).toHaveBeenCalledWith(expect.stringContaining("Email address is not verified"));
    });

    it("Does not throw when no logger is set and SES throws.", async () => {
        mockSend.mockRejectedValue(new Error("relay refused"));
        await expect(transport.send(makeMessage())).resolves.toEqual({
            accepted: [],
            rejected: expect.any(Array),
        });
    });

    it("Reports a name identifying this transport.", () => {
        expect(transport.name).toBe("ses");
    });
});
