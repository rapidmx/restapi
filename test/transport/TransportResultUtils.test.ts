///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { isTransportResultDelivered, sendOrThrow, TransportRejectedError } from "../../src/transport/TransportResultUtils.js";

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
});
