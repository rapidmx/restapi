///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for RecipientUtils - the parsed address-header shapes here are exactly what
// `mailparser` hands `ScanPipeline` (see `test/scan/ScanPipeline.test.ts` for the same behaviour driven
// end-to-end from real raw MIME).
import {
    buildDeliveredRecipients,
    MAX_MESSAGE_RECIPIENTS,
    parseHeaderRecipients,
    parseSenderDisplayName,
    storedAddress,
    storedDisplayName,
} from "../../src/util/RecipientUtils.js";
import * as util from "../../src/util/index.js";
import { Recipient, RecipientType } from "../../src/models/types.js";

/** One parsed address header, as `mailparser` reports it. */
function header(...value: any[]): any {
    return { value };
}

describe("RecipientUtils Tests", () => {
    describe("storedAddress()", () => {
        it("Keeps a usable address exactly as parsed, only trimmed.", () => {
            expect(storedAddress("  Bob.Allen@Partner.test ")).toBe("Bob.Allen@Partner.test");
        });

        it("Refuses anything that isn't one usable address: a non-string, an empty value, no @, a control character or over 320 characters.", () => {
            expect(storedAddress(undefined)).toBeUndefined();
            expect(storedAddress(42)).toBeUndefined();
            expect(storedAddress("   ")).toBeUndefined();
            expect(storedAddress("not-an-address")).toBeUndefined();
            expect(storedAddress("bob@partner.test\r\nBcc: evil@x.test")).toBeUndefined();
            expect(storedAddress(`${"a".repeat(320)}@partner.test`)).toBeUndefined();
        });
    });

    describe("storedDisplayName()", () => {
        it("Keeps the name as the sender wrote it, control characters removed and whitespace collapsed.", () => {
            expect(storedDisplayName('Bob\t "The Boss"  Allen')).toBe('Bob "The Boss" Allen');
            expect(storedDisplayName("Bob\r\nAllen")).toBe("Bob Allen");
        });

        it("Keeps an address-like name, which a client's phishing warning needs to see.", () => {
            expect(storedDisplayName("ceo@example.com")).toBe("ceo@example.com");
        });

        it("Caps a very long name and drops one that holds nothing.", () => {
            expect(storedDisplayName("x".repeat(500))).toBe("x".repeat(200));
            expect(storedDisplayName(`${"y".repeat(199)}   ${"z".repeat(200)}`)).toBe("y".repeat(199));
            expect(storedDisplayName("")).toBeUndefined();
            expect(storedDisplayName("   ")).toBeUndefined();
            expect(storedDisplayName(undefined)).toBeUndefined();
            expect(storedDisplayName({ toString: () => "Bob" })).toBeUndefined();
        });
    });

    describe("parseHeaderRecipients()", () => {
        it("Records every To and Cc recipient, keeping display names and typing each one by the header it came from.", () => {
            const recipients: Recipient[] = parseHeaderRecipients({
                to: header({ address: "bob@partner.test", name: "Bob Allen" }, { address: "carol@partner.test", name: "" }),
                cc: header({ address: "dave@partner.test", name: "Dave, D." }),
            });
            expect(recipients).toEqual([
                { address: "bob@partner.test", displayName: "Bob Allen", type: RecipientType.TO },
                { address: "carol@partner.test", type: RecipientType.TO },
                { address: "dave@partner.test", displayName: "Dave, D.", type: RecipientType.CC },
            ]);
        });

        it("Records a Bcc header only when the copy genuinely carries one, and never invents one.", () => {
            expect(parseHeaderRecipients({ to: header({ address: "bob@partner.test" }) })).toEqual([
                { address: "bob@partner.test", type: RecipientType.TO },
            ]);
            expect(parseHeaderRecipients({ bcc: header({ address: "hidden@partner.test", name: "Hidden" }) })).toEqual([
                { address: "hidden@partner.test", displayName: "Hidden", type: RecipientType.BCC },
            ]);
        });

        it("De-duplicates case-insensitively, first header wins, and keeps the address exactly as parsed.", () => {
            expect(
                parseHeaderRecipients({
                    to: header({ address: "Bob@Partner.test", name: "Bob" }),
                    cc: header({ address: "bob@partner.test", name: "Bob again" }, { address: "carol@partner.test" }),
                }),
            ).toEqual([
                { address: "Bob@Partner.test", displayName: "Bob", type: RecipientType.TO },
                { address: "carol@partner.test", type: RecipientType.CC },
            ]);
        });

        it("Expands an address group in place and ignores the group's own name.", () => {
            expect(
                parseHeaderRecipients({
                    to: header({ name: "Team", group: [{ address: "bob@partner.test" }, { address: "carol@partner.test" }] }, { address: "dave@partner.test" }),
                }),
            ).toEqual([
                { address: "bob@partner.test", type: RecipientType.TO },
                { address: "carol@partner.test", type: RecipientType.TO },
                { address: "dave@partner.test", type: RecipientType.TO },
            ]);
        });

        it("Stops following groups nested deeper than five levels rather than recursing without a bound.", () => {
            let entry: any = { address: "deep@partner.test" };
            for (let i = 0; i < 8; i++) {
                entry = { name: `group ${i}`, group: [entry] };
            }
            expect(parseHeaderRecipients({ to: header(entry) })).toEqual([]);
        });

        it("Skips malformed entries - a missing entry, a group with no address in it, and an unparseable address.", () => {
            expect(
                parseHeaderRecipients({
                    to: header(undefined, { name: "Undisclosed recipients", group: [] }, { address: "" }, { address: "no-at-sign" }, { address: "bob@partner.test" }),
                }),
            ).toEqual([{ address: "bob@partner.test", type: RecipientType.TO }]);
            expect(parseHeaderRecipients({})).toEqual([]);
            expect(parseHeaderRecipients({ to: {} })).toEqual([]);
        });

        it("Reads a header that occurs more than once, as mailparser reports it (an array).", () => {
            expect(
                parseHeaderRecipients({
                    to: [header({ address: "bob@partner.test" }), header({ address: "carol@partner.test" })],
                }),
            ).toEqual([
                { address: "bob@partner.test", type: RecipientType.TO },
                { address: "carol@partner.test", type: RecipientType.TO },
            ]);
            // The cap is reached inside the first of the two, so the second is never walked at all.
            expect(parseHeaderRecipients({ to: [header({ address: "bob@partner.test" }), header({ address: "carol@partner.test" })] }, 1)).toEqual([
                { address: "bob@partner.test", type: RecipientType.TO },
            ]);
        });

        it("Caps a huge header at MAX_MESSAGE_RECIPIENTS, without walking the rest of it.", () => {
            const many = Array.from({ length: 50_000 }, (_unused, i) => ({ address: `user${i}@partner.test` }));
            const recipients: Recipient[] = parseHeaderRecipients({ to: header(...many), cc: header({ address: "never@partner.test" }) });
            expect(recipients.length).toBe(MAX_MESSAGE_RECIPIENTS);
            expect(recipients[0].address).toBe("user0@partner.test");
            expect(recipients.some((r) => r.address === "never@partner.test")).toBe(false);
        });

        it("Stops at a caller-supplied cap that is reached inside a later header.", () => {
            expect(
                parseHeaderRecipients(
                    { to: header({ address: "bob@partner.test" }), cc: header({ address: "carol@partner.test" }, { address: "dave@partner.test" }) },
                    2,
                ),
            ).toEqual([
                { address: "bob@partner.test", type: RecipientType.TO },
                { address: "carol@partner.test", type: RecipientType.CC },
            ]);
        });
    });

    describe("buildDeliveredRecipients()", () => {
        const headerRecipients: Recipient[] = [
            { address: "bob@partner.test", displayName: "Bob Allen", type: RecipientType.TO },
            { address: "carol@partner.test", type: RecipientType.CC },
        ];

        it("Keeps every header recipient and adds nothing when the envelope recipient is already one of them.", () => {
            expect(buildDeliveredRecipients(headerRecipients, ["BOB@partner.test"])).toEqual(headerRecipients);
        });

        it("Records an envelope recipient no header names - a bcc'd or alias-only delivery - as a bcc entry.", () => {
            expect(buildDeliveredRecipients(headerRecipients, ["hidden@partner.test"])).toEqual([
                ...headerRecipients,
                { address: "hidden@partner.test", type: RecipientType.BCC },
            ]);
        });

        it("Handles a message with no headers to read and no envelope at all.", () => {
            expect(buildDeliveredRecipients(undefined, undefined)).toEqual([]);
            expect(buildDeliveredRecipients([], ["recipient@partner.test"])).toEqual([
                { address: "recipient@partner.test", type: RecipientType.BCC },
            ]);
        });

        it("Skips a malformed or repeated header recipient and a malformed or repeated envelope recipient.", () => {
            expect(
                buildDeliveredRecipients(
                    [
                        { address: "bob@partner.test", displayName: "Bob", type: RecipientType.TO },
                        { address: "BOB@PARTNER.TEST", type: RecipientType.CC },
                        { address: "nonsense", type: RecipientType.CC },
                        undefined as unknown as Recipient,
                    ],
                    ["nonsense", "hidden@partner.test", "Hidden@Partner.test"],
                ),
            ).toEqual([
                { address: "bob@partner.test", displayName: "Bob", type: RecipientType.TO },
                { address: "hidden@partner.test", type: RecipientType.BCC },
            ]);
        });

        it("Keeps the envelope recipient even when the header recipients already fill the cap.", () => {
            const full: Recipient[] = [
                { address: "a@partner.test", type: RecipientType.TO },
                { address: "b@partner.test", type: RecipientType.TO },
                { address: "c@partner.test", type: RecipientType.TO },
            ];
            expect(buildDeliveredRecipients(full, ["hidden@partner.test"], 2)).toEqual([
                { address: "a@partner.test", type: RecipientType.TO },
                { address: "hidden@partner.test", type: RecipientType.BCC },
            ]);
        });

        it("Caps the envelope recipients themselves too.", () => {
            expect(buildDeliveredRecipients([], ["a@partner.test", "b@partner.test", "c@partner.test"], 2)).toEqual([
                { address: "a@partner.test", type: RecipientType.BCC },
                { address: "b@partner.test", type: RecipientType.BCC },
            ]);
        });
    });

    describe("parseSenderDisplayName()", () => {
        it("Returns the display name alone, never the whole From header.", () => {
            expect(parseSenderDisplayName({ value: [{ address: "bob@partner.test", name: "Bob Allen" }] })).toBe("Bob Allen");
        });

        it("Returns undefined for a sender with no name, and for no From header at all.", () => {
            expect(parseSenderDisplayName({ value: [{ address: "bob@partner.test", name: "" }] })).toBeUndefined();
            expect(parseSenderDisplayName(undefined)).toBeUndefined();
        });
    });

    it("Is exported from the package's util barrel (and so the package root).", () => {
        expect(util.buildDeliveredRecipients).toBe(buildDeliveredRecipients);
        expect(util.parseHeaderRecipients).toBe(parseHeaderRecipients);
        expect(util.parseSenderDisplayName).toBe(parseSenderDisplayName);
        expect(util.MAX_MESSAGE_RECIPIENTS).toBe(MAX_MESSAGE_RECIPIENTS);
    });
});
