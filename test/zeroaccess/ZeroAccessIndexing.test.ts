///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { RecipientType } from "../../src/models/types.js";
import { buildIndexDocument, type IndexDocumentInput } from "../../src/zeroaccess/ZeroAccessIndexing.js";

const input = (fields: Partial<IndexDocumentInput> = {}): IndexDocumentInput => ({
    messageUid: "m1",
    subject: "Quarterly numbers",
    bodyText: "The numbers are up.",
    fromAddress: "bob@example.org",
    fromDisplayName: "Bob",
    recipients: [
        { address: "alice@example.com", displayName: "Alice", type: RecipientType.TO },
        { address: "carol@example.com", type: RecipientType.CC },
        { address: "dave@example.com", type: RecipientType.BCC },
    ],
    attachments: [],
    dateForSort: new Date(1000),
    ...fields,
});

const LIMITS = { budgetMs: 1000, maxAttachmentBytes: 1024 };

describe("buildIndexDocument()", () => {
    it("indexes the subject, body, sender and recipients", async () => {
        const document = await buildIndexDocument(input(), vi.fn(), LIMITS);

        expect(document).toEqual({
            v: 1,
            messageUid: "m1",
            subject: "Quarterly numbers",
            body: "The numbers are up.",
            attachmentText: [],
            attachmentNames: [],
            deferredAttachments: [],
            from: "bob@example.org",
            to: ["alice@example.com"],
            cc: ["carol@example.com"],
            participants: ["bob@example.org", "Bob", "alice@example.com", "Alice", "carol@example.com", "dave@example.com"],
            dateForSort: 1000,
        });
    });

    it("leaves out an empty sender and a missing display name", async () => {
        const document = await buildIndexDocument(input({ fromAddress: "", fromDisplayName: undefined, recipients: [] }), vi.fn(), LIMITS);

        expect(document.participants).toEqual([]);
        expect(document.from).toBe("");
    });

    it("extracts attachment text with the bare, lower-cased MIME type, and indexes names only for one with no extractor", async () => {
        const extract = vi.fn(async (mime: string) => (mime === "application/pdf" ? "pdf text" : undefined));
        const document = await buildIndexDocument(
            input({
                attachments: [
                    { filename: "report.pdf", contentType: "Application/PDF; name=report.pdf", content: Buffer.from("pdf") },
                    { filename: "photo.jpg", contentType: "image/jpeg", content: Buffer.from("jpg") },
                    { contentType: "application/pdf", content: Buffer.from("unnamed") },
                ],
            }),
            extract,
            LIMITS,
        );

        expect(extract).toHaveBeenCalledWith("application/pdf", Buffer.from("pdf"));
        expect(document.attachmentText).toEqual(["pdf text", "pdf text"]);
        expect(document.attachmentNames).toEqual(["report.pdf", "photo.jpg"]);
        expect(document.deferredAttachments).toEqual([]);
    });

    it("defers an attachment over the size cap without extracting it", async () => {
        const extract = vi.fn();
        const document = await buildIndexDocument(
            input({ attachments: [{ filename: "huge.pdf", contentType: "application/pdf", content: Buffer.alloc(2048) }] }),
            extract,
            LIMITS,
        );

        expect(extract).not.toHaveBeenCalled();
        expect(document.deferredAttachments).toEqual(["huge.pdf"]);
    });

    it("defers an extraction that outlasts the budget, and every attachment after the budget is spent", async () => {
        vi.useFakeTimers();
        try {
            const extract = vi.fn(() => new Promise<string>(() => undefined));
            const building = buildIndexDocument(
                input({
                    attachments: [
                        { filename: "slow.pdf", contentType: "application/pdf", content: Buffer.from("a") },
                        { filename: "next.pdf", contentType: "application/pdf", content: Buffer.from("b") },
                        { contentType: "application/pdf", content: Buffer.from("c") },
                    ],
                }),
                extract,
                LIMITS,
            );
            await vi.advanceTimersByTimeAsync(1001);
            const document = await building;

            expect(extract).toHaveBeenCalledTimes(1);
            expect(document.deferredAttachments).toEqual(["slow.pdf", "next.pdf"]);
            expect(document.attachmentText).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});
