///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { assertValidTransportRule } from "../../src/routes/BaseTransportRuleRoute.js";

const valid = (): Record<string, any> => ({
    name: "Rule",
    enabled: true,
    stopProcessingRules: false,
    sequence: 0,
    conditions: {},
    actions: [],
});

describe("assertValidTransportRule() Tests", () => {
    it("Accepts a complete, well-formed rule.", () => {
        expect(() => assertValidTransportRule({ ...valid(), conditions: { hasAttachment: true, fromContains: ["a"], subjectContains: null } }, true)).not.toThrow();
    });

    it("Refuses a missing or too long name.", () => {
        expect(() => assertValidTransportRule({ ...valid(), name: "  " }, true)).toThrow(/name/);
        expect(() => assertValidTransportRule({ name: 5 }, false)).toThrow(/name/);
    });

    it("Refuses a flag that is not a boolean.", () => {
        expect(() => assertValidTransportRule({ ...valid(), enabled: "yes" }, true)).toThrow(/'enabled'/);
        expect(() => assertValidTransportRule({ stopProcessingRules: 1 }, false)).toThrow(/'stopProcessingRules'/);
    });

    it("Refuses conditions that are not an object, a flag that is not a boolean, a bad list and an unknown condition.", () => {
        expect(() => assertValidTransportRule({ ...valid(), conditions: [] }, true)).toThrow(/must be an object/);
        expect(() => assertValidTransportRule({ ...valid(), conditions: { hasAttachment: "x" } }, true)).toThrow(/true or false/);
        expect(() => assertValidTransportRule({ ...valid(), conditions: { fromContains: [""] } }, true)).toThrow(/list/);
        expect(() => assertValidTransportRule({ ...valid(), conditions: { nope: true } }, true)).toThrow(/not a condition/);
    });

    it("Refuses actions that are not a short list of objects.", () => {
        expect(() => assertValidTransportRule({ ...valid(), actions: "x" }, true)).toThrow(/at most/);
        expect(() => assertValidTransportRule({ ...valid(), actions: Array.from({ length: 21 }, () => ({ type: "reject" })) }, true)).toThrow(/at most/);
        expect(() => assertValidTransportRule({ ...valid(), actions: [null] }, true)).toThrow(/must be an object/);
        expect(() => assertValidTransportRule({ ...valid(), actions: [{ type: "bogus" }] }, true)).toThrow(/'type'/);
    });

    it("Refuses an add_header action with a bad or protected header name.", () => {
        expect(() => assertValidTransportRule({ ...valid(), actions: [{ type: "add_header", headerName: "bad name", headerValue: "v" }] }, true)).toThrow(/headerName/);
        expect(() => assertValidTransportRule({ ...valid(), actions: [{ type: "add_header", headerName: "From", headerValue: "v" }] }, true)).toThrow(/can't add/);
    });

    it("Accepts and refuses add_header and add_recipient actions by their fields.", () => {
        const withAction = (action: any) => ({ ...valid(), actions: [action] });
        expect(() => assertValidTransportRule(withAction({ type: "add_header", headerName: "X-Tag", headerValue: "v" }), true)).not.toThrow();
        expect(() => assertValidTransportRule(withAction({ type: "add_header", headerName: "X-RapidMX-Tag", headerValue: "v" }), true)).toThrow(/can't add/);
        expect(() => assertValidTransportRule(withAction({ type: "add_header", headerName: "X-Tag", headerValue: "a" + String.fromCharCode(10) + "b" }), true)).toThrow(/headerValue/);
        expect(() => assertValidTransportRule(withAction({ type: "add_header", headerName: "X-Tag" }), true)).toThrow(/headerValue/);
        expect(() => assertValidTransportRule(withAction({ type: "add_recipient", recipientAddress: "copy@example.com" }), true)).not.toThrow();
        expect(() => assertValidTransportRule(withAction({ type: "add_recipient", recipientAddress: "not an address" }), true)).toThrow(/recipientAddress/);
        expect(() => assertValidTransportRule(withAction({ type: "reject" }), true)).not.toThrow();
        expect(() => assertValidTransportRule(withAction({ type: "quarantine" }), true)).not.toThrow();
    });

    it("Refuses a sequence that is not a whole number.", () => {
        expect(() => assertValidTransportRule({ ...valid(), sequence: 1.5 }, true)).toThrow(/sequence/);
        expect(() => assertValidTransportRule({ sequence: 2_000_000 }, false)).toThrow(/sequence/);
    });
});
