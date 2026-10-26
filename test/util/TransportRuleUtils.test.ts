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
        it("Lowercases the message's text once for every rule, still matching every field case-insensitively.", () => {
            const bodyText = `${"x".repeat(1000)} The SECRET Word`;
            const context = makeContext({
                fromAddress: "Sender@Example.com",
                headerFromAddresses: ["Boss@Example.com"],
                subject: "Quarterly REPORT",
                bodyText,
                headerRecipientAddresses: ["Team@Example.com"],
                hasAttachment: true,
                attachmentFilenames: ["Budget.XLSX"],
            });
            const rules = [
                makeRule({ sequence: 0, conditions: { bodyContains: ["secret word"] }, actions: [{ type: TransportRuleActionType.ADD_RECIPIENT, recipientAddress: "a@example.com" }] }),
                makeRule({ sequence: 1, conditions: { bodyContains: ["nope", "the secret"] }, actions: [{ type: TransportRuleActionType.ADD_RECIPIENT, recipientAddress: "b@example.com" }] }),
                makeRule({
                    sequence: 2,
                    conditions: { fromContains: ["BOSS@"], subjectContains: ["report"], recipientContains: ["team@"], attachmentNameContains: ["budget.xlsx"], bodyContains: ["WORD"] },
                    actions: [{ type: TransportRuleActionType.ADD_RECIPIENT, recipientAddress: "c@example.com" }],
                }),
                makeRule({ sequence: 3, conditions: { bodyContains: ["absent"] }, actions: [{ type: TransportRuleActionType.REJECT }] }),
            ];
            const lower = vi.spyOn(String.prototype, "toLowerCase");
            let result;
            let bodyCopies: number;
            try {
                result = evaluateTransportRules(rules, context);
            } finally {
                bodyCopies = lower.mock.contexts.filter((self: any) => String(self) === bodyText).length;
                lower.mockRestore();
            }
            expect(result.addRecipients).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
            expect(result.reject).toBe(false);
            expect(bodyCopies).toBe(1);
        });

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

        it("Skips a stored rule it can't evaluate, reporting it, and still applies the others.", () => {
            const unreadable = vi.fn();
            const rules = [
                makeRule({ uid: "bad-conditions", conditions: { fromContains: "x" } as any, actions: [{ type: TransportRuleActionType.REJECT }] }),
                makeRule({ uid: "bad-actions", sequence: 1, actions: null as any }),
                makeRule({ uid: "good", sequence: 2, actions: [{ type: TransportRuleActionType.QUARANTINE }] }),
            ];
            const result = evaluateTransportRules(rules, makeContext(), unreadable);
            expect(result).toMatchObject({ reject: false, quarantine: true });
            expect(unreadable.mock.calls.map(([rule]) => rule.uid)).toEqual(["bad-conditions", "bad-actions"]);
            expect(evaluateTransportRules(rules, makeContext()).quarantine).toBe(true);
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

        it("Matches the header From, the To and Cc headers and a body far beyond the preview, not only the envelope and the first 500 characters.", async () => {
            const padding = "x".repeat(5000);
            const raw = Buffer.from(
                `From: Boss <ceo@corp.example>\r\nTo: one@corp.example\r\nTo: two@corp.example\r\nCc: cc@partner.example\r\nSubject: Hi\r\nContent-Type: text/plain\r\n\r\n${padding} secret-project\r\n`,
            );
            const context = await buildTransportRuleContext(raw, "bounce@elsewhere.example", ["bcc@hidden.example"], []);
            expect(context.bodyPreview).toHaveLength(500);
            expect(context.headerFromAddresses).toEqual(["ceo@corp.example"]);
            expect(context.headerRecipientAddresses).toEqual(["one@corp.example", "two@corp.example", "cc@partner.example"]);

            expect(matchesTransportRuleConditions({ bodyContains: ["secret-project"] }, context)).toBe(true);
            expect(matchesTransportRuleConditions({ fromContains: ["@corp.example"] }, context)).toBe(true);
            expect(matchesTransportRuleConditions({ fromContains: ["@elsewhere.example"] }, context)).toBe(true);
            expect(matchesTransportRuleConditions({ fromContains: ["@nowhere.example"] }, context)).toBe(false);
            expect(matchesTransportRuleConditions({ recipientContains: ["cc@partner"] }, context)).toBe(true);
            expect(matchesTransportRuleConditions({ recipientContains: ["bcc@hidden"] }, context)).toBe(true);
            expect(matchesTransportRuleConditions({ recipientContains: ["nobody@"] }, context)).toBe(false);
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

        it("Reads a body nested far deeper than a parser recurses, rather than failing on it.", async () => {
            const html = "<div>".repeat(3000) + "deep text" + "</div>".repeat(3000);
            const raw = Buffer.from(["From: sender@example.com", "Subject: Deep", "Content-Type: text/html", "", html, ""].join("\r\n"));
            const context = await buildTransportRuleContext(raw, "sender@example.com", ["a@example.com"], []);

            expect(context.subject).toBe("Deep");
            expect(context.bodyText).toBe("deep text");
        });

        it("Reads text past any nesting depth or sibling count, so a bodyContains rule can't be evaded by padding the HTML.", async () => {
            const rule: any = { enabled: true, sequence: 1, conditions: { bodyContains: ["wire transfer"] }, actions: [{ type: TransportRuleActionType.QUARANTINE }] };
            const bodies: string[] = [
                "<div>".repeat(150) + "Please send the wire transfer" + "</div>".repeat(150),
                "<span></span>".repeat(10_001) + "<p>CONFIDENTIAL wire transfer</p>",
                "<p>hi</p>" + "<div>".repeat(150) + "wire transfer" + "</div>".repeat(150),
                // Inline elements join the text around them, as the reader sees it; script and style are no text of the message.
                "<p>wi<span></span>re tr<x-foo>ans</x-foo>fer</p><style>p { color: red }</style><script>var x = 1;</script>",
            ];
            for (const html of bodies) {
                const raw = Buffer.from(["From: sender@example.com", "Content-Type: text/html", "", html, ""].join("\r\n"));
                const context = await buildTransportRuleContext(raw, "sender@example.com", ["a@example.com"], []);
                expect(evaluateTransportRules([rule], context).quarantine, html.slice(0, 40)).toBe(true);
            }
            const styled = await buildTransportRuleContext(
                Buffer.from("From: s@example.com\r\nContent-Type: text/html\r\n\r\n<style>p{}</style><p>A&amp;B</p><br>C\r\n"),
                "s@example.com",
                ["a@example.com"],
                [],
            );
            expect(styled.bodyText).toBe("A&B C");
        });

        it("Reads the text a browser shows but htmlparser2 reads as a comment or raw text, so a bodyContains rule can't be evaded through it.", async () => {
            const rule: any = { enabled: true, sequence: 1, conditions: { bodyContains: ["wire transfer"] }, actions: [{ type: TransportRuleActionType.QUARANTINE }] };
            const context = async (html: string) =>
                buildTransportRuleContext(Buffer.from(["From: sender@example.com", "Content-Type: text/html", "", html, ""].join("\r\n")), "sender@example.com", ["a@example.com"], []);
            for (const html of [
                "<svg><style><p>wire transfer</p></style></svg>",
                "<p>Hi</p><!-- x --!> Please send the wire transfer today",
                "<![CDATA[ > wire transfer ]]>",
                "<math><style><div>wire transfer</div></style></math>",
                "<svg><script>wire transfer</script></svg>",
                // What a browser renders of it is read as HTML too: entities decoded, inline markup joining the text around it.
                "<svg><style><p>wire&#32;tr<b></b>ansfer</p></style></svg>",
                "<p>Hi</p><!-- x --!><p>wire&nbsp;transfer</p>-->",
            ]) {
                expect(evaluateTransportRules([rule], await context(html)).quarantine, html).toBe(true);
            }
            // Kept after the text proper, so neither splits a phrase the reader sees whole.
            for (const html of ["<p>wire <!-- note --> transfer</p>", "<p>wire <svg><style>x</style></svg>transfer</p>"]) {
                expect(evaluateTransportRules([rule], await context(html)).quarantine, html).toBe(true);
            }
            // A top-level style or script is still no text of the message, and one inside foreign content stays its own once it closes.
            expect((await context("<style>wire transfer</style><p>Hello</p>")).bodyText).toBe("Hello");
            expect((await context("<svg><style>a</style></svg><style>b</style><p>Hello</p>")).bodyText).toBe("Hello a a");
            // Read as HTML one level deep only: nesting can't recurse without bound.
            const deep = await context("<svg><style>".repeat(20_000) + "deep" + "<!--".repeat(20_000));
            expect(deep.bodyText).toContain("deep");
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

    it("Never matches a text condition whose list of needles is empty.", () => {
        expect(matchesTransportRuleConditions({ subjectContains: [] }, makeContext())).toBe(false);
    });
});
