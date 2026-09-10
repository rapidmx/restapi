///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    buildTransportRuleContext,
    evaluateTransportRules,
    matchesTransportRuleConditions,
    TransportRuleMatchContext,
} from "../../src/util/TransportRuleUtils.js";
import { TransportRule, TransportRuleActionType, TransportRuleConditions } from "../../src/models/types.js";

function makeContext(overrides?: Partial<TransportRuleMatchContext>): TransportRuleMatchContext {
    return {
        fromAddress: "sender@example.com",
        subject: "Hello",
        bodyPreview: "Hi there",
        recipientAddresses: ["a@example.com"],
        anyRecipientExternal: false,
        hasAttachment: false,
        attachmentFilenames: [],
        ...overrides,
    };
}

function makeRule(overrides?: Partial<TransportRule>): TransportRule {
    return {
        uid: "rule-1",
        dateCreated: new Date(),
        dateModified: new Date(),
        version: 0,
        name: "Test Rule",
        enabled: true,
        sequence: 0,
        stopProcessingRules: false,
        conditions: {},
        actions: [],
        ...overrides,
    };
}

describe("TransportRuleUtils Tests", () => {
    describe("matchesTransportRuleConditions()", () => {
        it("Matches everything when no conditions are populated.", () => {
            expect(matchesTransportRuleConditions({}, makeContext())).toBe(true);
        });

        it("fromContains matches a substring of the From address, case-insensitively.", () => {
            const conditions: TransportRuleConditions = { fromContains: ["SENDER"] };
            expect(matchesTransportRuleConditions(conditions, makeContext())).toBe(true);
            expect(matchesTransportRuleConditions({ fromContains: ["nope"] }, makeContext())).toBe(false);
        });

        it("subjectContains matches a substring of the subject, case-insensitively.", () => {
            expect(matchesTransportRuleConditions({ subjectContains: ["hello"] }, makeContext())).toBe(true);
            expect(matchesTransportRuleConditions({ subjectContains: ["nope"] }, makeContext())).toBe(false);
        });

        it("bodyContains matches a substring of the body preview, case-insensitively.", () => {
            expect(matchesTransportRuleConditions({ bodyContains: ["there"] }, makeContext())).toBe(true);
            expect(matchesTransportRuleConditions({ bodyContains: ["nope"] }, makeContext())).toBe(false);
        });

        it("recipientContains matches a substring of any recipient address.", () => {
            const context = makeContext({ recipientAddresses: ["one@example.com", "two@example.com"] });
            expect(matchesTransportRuleConditions({ recipientContains: ["two@"] }, context)).toBe(true);
            expect(matchesTransportRuleConditions({ recipientContains: ["three@"] }, context)).toBe(false);
        });

        it("anyRecipientExternal must match exactly (true requires true, false requires false).", () => {
            expect(matchesTransportRuleConditions({ anyRecipientExternal: true }, makeContext({ anyRecipientExternal: true }))).toBe(true);
            expect(matchesTransportRuleConditions({ anyRecipientExternal: true }, makeContext({ anyRecipientExternal: false }))).toBe(false);
            expect(matchesTransportRuleConditions({ anyRecipientExternal: false }, makeContext({ anyRecipientExternal: true }))).toBe(false);
        });

        it("hasAttachment must match exactly.", () => {
            expect(matchesTransportRuleConditions({ hasAttachment: true }, makeContext({ hasAttachment: true }))).toBe(true);
            expect(matchesTransportRuleConditions({ hasAttachment: true }, makeContext({ hasAttachment: false }))).toBe(false);
        });

        it("attachmentNameContains matches a substring of any attachment filename.", () => {
            const context = makeContext({ attachmentFilenames: ["invoice.pdf", "photo.png"] });
            expect(matchesTransportRuleConditions({ attachmentNameContains: [".pdf"] }, context)).toBe(true);
            expect(matchesTransportRuleConditions({ attachmentNameContains: [".exe"] }, context)).toBe(false);
        });

        it("An empty (but defined) needles array never matches - fromContains.", () => {
            expect(matchesTransportRuleConditions({ fromContains: [] }, makeContext())).toBe(false);
        });

        it("An empty (but defined) needles array never matches - recipientContains.", () => {
            expect(matchesTransportRuleConditions({ recipientContains: [] }, makeContext())).toBe(false);
        });

        it("Every populated condition must match (AND).", () => {
            const conditions: TransportRuleConditions = { fromContains: ["sender"], subjectContains: ["nope"] };
            expect(matchesTransportRuleConditions(conditions, makeContext())).toBe(false);
        });
    });

    describe("evaluateTransportRules()", () => {
        it("Skips a disabled rule even if its conditions match.", () => {
            const rules = [makeRule({ enabled: false, actions: [{ type: TransportRuleActionType.REJECT }] })];
            expect(evaluateTransportRules(rules, makeContext()).reject).toBe(false);
        });

        it("Evaluates rules in ascending sequence order and folds every matching rule's actions.", () => {
            const rules = [
                makeRule({ sequence: 2, actions: [{ type: TransportRuleActionType.ADD_RECIPIENT, recipientAddress: "second@example.com" }] }),
                makeRule({ sequence: 1, actions: [{ type: TransportRuleActionType.ADD_RECIPIENT, recipientAddress: "first@example.com" }] }),
            ];
            const result = evaluateTransportRules(rules, makeContext());
            expect(result.addRecipients).toEqual(["first@example.com", "second@example.com"]);
        });

        it("Stops evaluating further rules once a matching rule has stopProcessingRules: true.", () => {
            const rules = [
                makeRule({
                    sequence: 1,
                    stopProcessingRules: true,
                    actions: [{ type: TransportRuleActionType.ADD_HEADER, headerName: "X-First", headerValue: "1" }],
                }),
                makeRule({
                    sequence: 2,
                    actions: [{ type: TransportRuleActionType.ADD_HEADER, headerName: "X-Second", headerValue: "2" }],
                }),
            ];
            const result = evaluateTransportRules(rules, makeContext());
            expect(result.addHeaders).toEqual([{ name: "X-First", value: "1" }]);
        });

        it("A non-matching rule's stopProcessingRules has no effect.", () => {
            const rules = [
                makeRule({
                    sequence: 1,
                    stopProcessingRules: true,
                    conditions: { subjectContains: ["nope"] },
                    actions: [{ type: TransportRuleActionType.ADD_HEADER, headerName: "X-First", headerValue: "1" }],
                }),
                makeRule({
                    sequence: 2,
                    actions: [{ type: TransportRuleActionType.ADD_HEADER, headerName: "X-Second", headerValue: "2" }],
                }),
            ];
            const result = evaluateTransportRules(rules, makeContext());
            expect(result.addHeaders).toEqual([{ name: "X-Second", value: "2" }]);
        });

        it("Sets reject when a matching rule's action is REJECT.", () => {
            const rules = [makeRule({ actions: [{ type: TransportRuleActionType.REJECT }] })];
            expect(evaluateTransportRules(rules, makeContext()).reject).toBe(true);
        });

        it("Sets quarantine when a matching rule's action is QUARANTINE.", () => {
            const rules = [makeRule({ actions: [{ type: TransportRuleActionType.QUARANTINE }] })];
            expect(evaluateTransportRules(rules, makeContext()).quarantine).toBe(true);
        });

        it("Ignores an ADD_HEADER action missing headerName/headerValue.", () => {
            const rules = [makeRule({ actions: [{ type: TransportRuleActionType.ADD_HEADER }] })];
            expect(evaluateTransportRules(rules, makeContext()).addHeaders).toEqual([]);
        });

        it("Ignores an ADD_RECIPIENT action missing recipientAddress.", () => {
            const rules = [makeRule({ actions: [{ type: TransportRuleActionType.ADD_RECIPIENT }] })];
            expect(evaluateTransportRules(rules, makeContext()).addRecipients).toEqual([]);
        });

        it("Returns an all-false/empty result when no rules are given.", () => {
            const result = evaluateTransportRules([], makeContext());
            expect(result).toEqual({ reject: false, quarantine: false, addHeaders: [], addRecipients: [] });
        });
    });

    describe("buildTransportRuleContext()", () => {
        it("Extracts subject, body preview, and attachment filenames from a plain-text message.", async () => {
            const raw = Buffer.from(
                "From: sender@example.com\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\nHello world\r\n",
            );
            const context = await buildTransportRuleContext(raw, "sender@example.com", ["a@example.com"], []);

            expect(context.fromAddress).toBe("sender@example.com");
            expect(context.subject).toBe("Hi");
            expect(context.bodyPreview).toContain("Hello world");
            expect(context.recipientAddresses).toEqual(["a@example.com"]);
            expect(context.hasAttachment).toBe(false);
            expect(context.attachmentFilenames).toEqual([]);
        });

        it("Extracts attachment filenames and sets hasAttachment for a multipart message with an attachment.", async () => {
            const raw = Buffer.from(
                [
                    "From: sender@example.com",
                    "Subject: Invoice",
                    'Content-Type: multipart/mixed; boundary="BOUNDARY"',
                    "",
                    "--BOUNDARY",
                    "Content-Type: text/plain",
                    "",
                    "Please see attached.",
                    "--BOUNDARY",
                    'Content-Type: application/pdf; name="invoice.pdf"',
                    'Content-Disposition: attachment; filename="invoice.pdf"',
                    "Content-Transfer-Encoding: base64",
                    "",
                    "JVBERi0xLjQK",
                    "--BOUNDARY--",
                    "",
                ].join("\r\n"),
            );
            const context = await buildTransportRuleContext(raw, "sender@example.com", ["a@example.com"], []);

            expect(context.hasAttachment).toBe(true);
            expect(context.attachmentFilenames).toEqual(["invoice.pdf"]);
        });

        it("Falls back to converting the HTML part to plain text when there is no text/plain part.", async () => {
            const raw = Buffer.from(
                "From: sender@example.com\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>world</b></p>\r\n",
            );
            const context = await buildTransportRuleContext(raw, "sender@example.com", ["a@example.com"], []);

            expect(context.bodyPreview).toContain("Hello");
            expect(context.bodyPreview).toContain("world");
        });

        it("anyRecipientExternal is false when mail:domains is unconfigured (empty).", async () => {
            const raw = Buffer.from("From: sender@example.com\r\n\r\nBody\r\n");
            const context = await buildTransportRuleContext(raw, "sender@example.com", ["a@outside.com"], []);
            expect(context.anyRecipientExternal).toBe(false);
        });

        it("anyRecipientExternal is true when a recipient's domain isn't in the configured list.", async () => {
            const raw = Buffer.from("From: sender@example.com\r\n\r\nBody\r\n");
            const context = await buildTransportRuleContext(
                raw,
                "sender@example.com",
                ["a@example.com", "b@outside.com"],
                ["example.com"],
            );
            expect(context.anyRecipientExternal).toBe(true);
        });

        it("anyRecipientExternal is false when every recipient's domain is in the configured list.", async () => {
            const raw = Buffer.from("From: sender@example.com\r\n\r\nBody\r\n");
            const context = await buildTransportRuleContext(raw, "sender@example.com", ["a@example.com"], ["example.com"]);
            expect(context.anyRecipientExternal).toBe(false);
        });

        it("Leaves bodyPreview empty, hasAttachment false, and attachmentFilenames empty for an S/MIME-encrypted message - the entire encrypted body is otherwise indistinguishable from a real attachment to mailparser.", async () => {
            const raw = Buffer.from(
                [
                    "From: sender@example.com",
                    "Subject: Encrypted",
                    'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
                    "Content-Transfer-Encoding: base64",
                    'Content-Disposition: attachment; filename="smime.p7m"',
                    "",
                    Buffer.from("fake CMS EnvelopedData DER bytes").toString("base64"),
                    "",
                ].join("\r\n"),
            );
            const context = await buildTransportRuleContext(raw, "sender@example.com", ["a@example.com"], []);

            expect(context.bodyPreview).toBe("");
            expect(context.hasAttachment).toBe(false);
            expect(context.attachmentFilenames).toEqual([]);
        });

        it("bodyContains never matches an encrypted message's (empty) body preview.", () => {
            const context = makeContext({ bodyPreview: "" });
            expect(matchesTransportRuleConditions({ bodyContains: ["anything"] }, context)).toBe(false);
        });
    });
});
