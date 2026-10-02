///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// A header value holding U+010D / U+010A must never become a CR / LF once the rebuilt header block is written out
// one byte per character (`Buffer.from(text, "binary")` keeps only each character's low byte).
import { rewriteHeadersForList } from "../../src/util/DistributionListUtils.js";
import { applyThreadHeaders, scanAndRelay, threadHeaders } from "../../src/util/MailSendUtils.js";
import { checkOriginatorHeaders, extractOriginatorHeaders, prependHeaders, prepareRelayCopy } from "../../src/util/MimeHeaderUtils.js";
import { AvVerdict, SpamVerdict } from "../../src/models/types.js";
import { InMemoryBlobStore, RecordingMailTransport } from "../testDoubles.js";

const raw: Buffer = Buffer.from(["From: me@example.com", "To: you@example.com", "Subject: Hi", "", "Body", ""].join("\r\n"));
const exploit = "xčĊFrom:<ceo@other-tenant.com>čĊSubject:sčĊContent-Type:text/plainčĊčĊ";

/** The header block (everything before the first blank line) of `buffer`, split into lines. */
function headerLines(buffer: Buffer): string[] {
    return buffer.toString("binary").split(/\r\n\r\n/)[0].split(/\r\n|\n|\r/);
}

describe("Header injection through non-latin1 header text", () => {
    it("Does not let an inReplyTo or references entry smuggle a second From header into a reply.", () => {
        const result: Buffer = applyThreadHeaders(raw, { inReplyTo: exploit, references: [exploit] });
        expect(extractOriginatorHeaders(result).from).toEqual(["me@example.com"]);
        expect(checkOriginatorHeaders(result, (address) => address === "me@example.com")).toBeUndefined();
        expect(result.toString("binary")).not.toContain("ceo@other-tenant.com");
        expect(result.toString("binary")).toMatch(/\r\n\r\nBody\r\n$/);
    });

    it("Writes no threading header for a Message-ID that is not visible ASCII.", () => {
        expect(threadHeaders(raw, { inReplyTo: "café@example.com" })).toEqual([]);
        expect(threadHeaders(raw, { inReplyTo: "ačb@example.com", references: ["ĀĊ"] })).toEqual([]);
        expect(threadHeaders(raw, { inReplyTo: "ok@example.com" })[0].value).toBe("<ok@example.com>");
    });

    it("Cannot be made to inject a header through prependHeaders() name or value.", () => {
        const result: Buffer = prependHeaders(raw, [
            { name: "X-AčĊFrom", value: exploit },
            { name: "X-B", value: "café čĊFrom: ceo@other-tenant.com" },
        ]);
        expect(extractOriginatorHeaders(result).from).toEqual(["me@example.com"]);
        expect(headerLines(result).every((line) => /^[\x20-\x7E\t]*$/.test(line))).toBe(true);
        expect(result.toString("binary")).not.toContain("ceo@other-tenant.com");
    });

    it("Drops a header whose name has no field-name character in it.", () => {
        const result: Buffer = prependHeaders(raw, [{ name: "čĊ", value: "x" }, { name: "X-Ok", value: "plain" }]);
        expect(headerLines(result)).toEqual(["X-Ok: plain", "From: me@example.com", "To: you@example.com", "Subject: Hi"]);
    });

    it("Cannot be made to inject a header through a distribution list's name or address.", () => {
        const result: Buffer = rewriteHeadersForList(raw, {
            name: `Sales${exploit}`,
            primarySmtpAddress: `salesčĊBcc:x@evil.com@example.com`,
        } as any);
        expect(extractOriginatorHeaders(result).from).toEqual(["me@example.com"]);
        expect(headerLines(result).every((line) => /^[\x20-\x7E\t]*$/.test(line))).toBe(true);
    });

    it("Cannot be made to inject a header through the From rewritten by prepareRelayCopy().", () => {
        const result: Buffer | undefined = prepareRelayCopy(raw, {
            trustedAuthservId: "",
            rewriteFrom: { address: "listčĊBcc:x@evil.com@example.com" },
        });
        expect(extractOriginatorHeaders(result!).from).toHaveLength(1);
        expect(headerLines(result!).some((line) => /^bcc:/i.test(line))).toBe(false);
    });

    it("Drops an incoming Reply-To in its obsolete and bare-CR forms and any incoming List-* header when rewriting for a list.", () => {
        const incoming: Buffer = Buffer.from(
            ["From: me@example.com", "Reply-To : a@evil.com", "Reply-To\t:b@evil.com", "List-Unsubscribe: <mailto:c@evil.com>", "List-Id: evil", "X-Keep: yes", "", "Body", ""].join(
                "\r\n",
            ) + "",
        );
        const bareCr: Buffer = Buffer.from("From: me@example.com\rReply-To: d@evil.com\rSubject: s\r\n\r\nBody\r\n");
        const list: any = { name: "Sales", primarySmtpAddress: "sales@example.com" };
        for (const result of [rewriteHeadersForList(incoming, list), rewriteHeadersForList(bareCr, list)]) {
            const text: string = result.toString("binary");
            expect(text).not.toContain("evil");
            expect(text).toContain("Reply-To: sales@example.com");
            expect(text).toContain("List-Id: Sales <sales.example.com>");
        }
        expect(rewriteHeadersForList(incoming, list).toString("binary")).toContain("X-Keep: yes");
    });

    it("Refuses, inside scanAndRelay(), a message whose final bytes fail the originator check.", async () => {
        const scanPipeline = {
            run: vi.fn().mockResolvedValue({
                spam: { score: 0, verdict: SpamVerdict.CLEAN, symbols: [] },
                av: { verdict: AvVerdict.CLEAN },
                attachments: [],
                references: [],
                encrypted: false,
            }),
        };
        const transport = new RecordingMailTransport();
        const spoofed: Buffer = Buffer.from("From: ceo@other-tenant.com\r\nTo: you@example.com\r\n\r\nBody\r\n");
        await expect(
            scanAndRelay(spoofed, "me@example.com", ["you@example.com"], scanPipeline as any, transport, new InMemoryBlobStore(), undefined, {
                isAllowed: (address) => address === "me@example.com",
                rejectAddressLikeDisplayNames: true,
            }),
        ).rejects.toMatchObject({ status: 403 });
        expect(transport.sent).toHaveLength(0);
    });
});
