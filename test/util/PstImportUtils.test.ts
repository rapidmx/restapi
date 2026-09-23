///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `pst-extractor` ships a real-world sample PST (the "Enron corpus" test fixture it uses for its own
// tests) directly in its published package - reused here from `node_modules` rather than duplicated into
// this repo's own `test/fixtures/`, since - per `util/MboxUtils.ts`'s own doc comment - no free/open tool
// can WRITE a valid PST to hand-build a small one, and this one (71 real messages, ~12MB of real
// attachments, parses in well under a second) already gives genuine, real-format coverage without adding
// a duplicate multi-megabyte binary to this repo's own history.
import * as fs from "fs";
import * as path from "path";
import { PSTFile, PSTFolder, PSTMessage } from "pst-extractor";
import {
    buildRawMimeFromPstMessage,
    collectMailItems,
    DEFAULT_PST_MAX_TOTAL_BYTES,
    defaultPstExtractionBudget,
    extractPstMessages,
    PstAllocationBudget,
    readAttachmentContent,
} from "../../src/util/PstImportUtils.js";

const FIXTURE_PATH = path.join(process.cwd(), "node_modules/pst-extractor/example/testdata/enron.pst");

/** Drains an `AsyncGenerator` into an array - `extractPstMessages()` now yields one message at a time
 * rather than returning them all as a `Buffer[]` (see its own doc comment for why), but most assertions
 * below just want the full set to check length/contents against, same as before. */
async function collectAsync<T>(gen: AsyncGenerator<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of gen) {
        out.push(item);
    }
    return out;
}

function findFolder(folder: PSTFolder, name: string): PSTFolder | undefined {
    if (folder.displayName === name) {
        return folder;
    }
    if (folder.hasSubfolders) {
        for (const child of folder.getSubFolders()) {
            const found = findFolder(child, name);
            if (found) {
                return found;
            }
        }
    }
    return undefined;
}

describe("PstImportUtils Tests", () => {
    describe("extractPstMessages() (real PST fixture)", () => {
        it("Extracts every real IPM.Note item in the fixture as a raw RFC 5322 buffer.", async () => {
            const messages = await collectAsync(extractPstMessages(FIXTURE_PATH));

            expect(messages.length).toBe(71);
            for (const raw of messages) {
                expect(Buffer.isBuffer(raw)).toBe(true);
                // `Message-ID` is unconditionally present on every message (either preserved from the PST's
                // own `internetMessageId` or auto-minted by `MimeNode` itself as the tree's root node) -
                // unlike `Subject`/`From`, which `MimeNode` silently omits when the underlying value doesn't
                // encode to anything (see `buildRawMimeFromPstMessage()`'s own doc comment) - not every real
                // item in this fixture has a non-empty subject.
                expect(raw.toString("latin1")).toMatch(/^Message-ID:/m);
            }
        });

        it("Reconstructs a real message with an attachment, embedding its filename and content type.", async () => {
            const buffer = fs.readFileSync(FIXTURE_PATH);
            const pstFile = new PSTFile(buffer);
            const personalFolder = findFolder(pstFile.getRootFolder(), "Personal")!;
            let item: PSTMessage | null = personalFolder.getNextChild();
            let tripInfo: PSTMessage | undefined;
            while (item != null) {
                if (item.subject === "TRIP INFO") {
                    tripInfo = item;
                    break;
                }
                item = personalFolder.getNextChild();
            }
            expect(tripInfo).toBeDefined();

            const raw = await buildRawMimeFromPstMessage(tripInfo!);
            const text = raw.toString("latin1");

            expect(text).toMatch(/^Subject: TRIP INFO/m);
            expect(text).toContain("multipart/mixed");
            expect(text).toContain("TAHOE INFORMATOIN.doc");
            expect(text).toContain("tahoe.xls");
        });
    });

    describe("collectMailItems()", () => {
        it("Skips a non-IPM.Note item (e.g. a calendar/contact/task item PST also stores).", () => {
            const noteItem = { messageClass: "IPM.Note" } as unknown as PSTMessage;
            const apptItem = { messageClass: "IPM.Appointment" } as unknown as PSTMessage;
            let cursor = 0;
            const items = [noteItem, apptItem];
            const fakeFolder = {
                hasSubfolders: false,
                contentCount: items.length,
                getNextChild: () => (cursor < items.length ? items[cursor++] : null),
            } as unknown as PSTFolder;

            const out: PSTMessage[] = [];
            collectMailItems(fakeFolder, out);

            expect(out).toEqual([noteItem]);
        });

        it("Recurses into subfolders, collecting mail items from all of them.", () => {
            const childNoteItem = { messageClass: "IPM.Note" } as unknown as PSTMessage;
            let childCursor = 0;
            const childItems = [childNoteItem];
            const childFolder = {
                hasSubfolders: false,
                contentCount: childItems.length,
                getNextChild: () => (childCursor < childItems.length ? childItems[childCursor++] : null),
            } as unknown as PSTFolder;

            const rootFolder = {
                hasSubfolders: true,
                getSubFolders: () => [childFolder],
                contentCount: 0,
                getNextChild: () => null,
            } as unknown as PSTFolder;

            const out: PSTMessage[] = [];
            collectMailItems(rootFolder, out);

            expect(out).toEqual([childNoteItem]);
        });
    });

    describe("readAttachmentContent()", () => {
        it("Returns undefined for an attachment with no readable content stream.", () => {
            const attachment = { fileInputStream: null, filesize: 0 } as any;
            expect(readAttachmentContent(attachment)).toBeUndefined();
        });

        it("Reads the attachment's content when filesize is within the given max size.", () => {
            const attachment = { fileInputStream: { readCompletely: (buf: Buffer) => buf.fill(7) }, filesize: 4 } as any;
            const content = readAttachmentContent(attachment, 1_000);
            expect(content).toEqual(Buffer.alloc(4, 7));
        });

        it("Skips (rather than allocating from) a filesize larger than the given max size - a corrupted or malicious PST claiming an attachment bigger than the file itself.", () => {
            // Never actually invoked - the filesize check must short-circuit before reaching it - so its
            // body only needs to satisfy the real (buf: Buffer) => Buffer signature, not do anything.
            const attachment = { fileInputStream: { readCompletely: (buf: Buffer) => buf }, filesize: 1_000_000 } as any;
            expect(readAttachmentContent(attachment, 100)).toBeUndefined();
        });
    });

    describe("buildRawMimeFromPstMessage()", () => {
        function fakeMessage(overrides: Record<string, unknown>): PSTMessage {
            return {
                bodyHTML: "",
                body: "",
                hasAttachments: false,
                numberOfAttachments: 0,
                subject: "",
                senderEmailAddress: "",
                senderName: "",
                displayTo: "",
                displayCC: "",
                clientSubmitTime: null,
                messageDeliveryTime: null,
                internetMessageId: "",
                ...overrides,
            } as unknown as PSTMessage;
        }

        it("Synthesizes a valid @import.invalid address from the sender name when the PST's own senderEmailAddress isn't address-shaped (no @).", async () => {
            // Real, not hypothetical: this module's own fixture is 2001-era Enron mail whose
            // `senderEmailAddress` is often a bare Exchange directory name like "Lokay" with no "@" at all -
            // `MimeNode` would otherwise silently drop the whole `From` header (verified via a throwaway
            // script - see `buildRawMimeFromPstMessage()`'s own doc comment) since it isn't address-shaped.
            const raw = await buildRawMimeFromPstMessage(fakeMessage({ senderName: "Bob", senderEmailAddress: "Bob", body: "hi" }));
            expect(raw.toString("latin1")).toMatch(/^From: Bob <Bob@import\.invalid>\r?$/m);
        });

        it("Falls back to unknown@import.invalid when neither a sender address nor name is present.", async () => {
            const raw = await buildRawMimeFromPstMessage(fakeMessage({ body: "hi" }));
            expect(raw.toString("latin1")).toContain("From: unknown@import.invalid");
        });

        it("Synthesizes an address from the bare senderEmailAddress when there's no senderName to prefer instead.", async () => {
            const raw = await buildRawMimeFromPstMessage(fakeMessage({ senderEmailAddress: "Lokay", body: "hi" }));
            expect(raw.toString("latin1")).toContain("From: Lokay@import.invalid");
        });

        it("Falls back to unknown@import.invalid when the sender name/address contain nothing safe for an address local-part.", async () => {
            const raw = await buildRawMimeFromPstMessage(fakeMessage({ senderName: "!!!", body: "hi" }));
            expect(raw.toString("latin1")).toContain("<unknown@import.invalid>");
        });

        it("Strips embedded quotes from the display name before handing it to the address encoder.", async () => {
            // Without the strip, `MimeNode`'s own address re-parsing mangles a quote-containing display
            // name into something else entirely (confirmed via a throwaway script) rather than merely
            // failing loudly - stripping first keeps the reconstructed name intact.
            const raw = await buildRawMimeFromPstMessage(
                fakeMessage({ senderEmailAddress: "bob@example.com", senderName: 'Bob "The" Builder', body: "hi" }),
            );
            expect(raw.toString("latin1")).toContain("From: Bob The Builder <bob@example.com>");
        });

        it("Builds a multipart/alternative body when both a plain-text and an HTML part are present.", async () => {
            const raw = await buildRawMimeFromPstMessage(fakeMessage({ body: "plain body", bodyHTML: "<p>html body</p>" }));
            const text = raw.toString("latin1");
            expect(text).toContain("multipart/alternative");
            expect(text).toContain("plain body");
            expect(text).toContain("html body");
        });

        it("Builds a plain text/html body when only an HTML part is present.", async () => {
            const raw = await buildRawMimeFromPstMessage(fakeMessage({ bodyHTML: "<p>only html</p>" }));
            const text = raw.toString("latin1");
            expect(text).toContain("text/html");
            expect(text).toContain("only html");
        });

        it("Preserves a present internetMessageId as this message's Message-ID header.", async () => {
            const raw = await buildRawMimeFromPstMessage(fakeMessage({ body: "hi", internetMessageId: "<abc123@example.com>" }));
            expect(raw.toString("latin1")).toContain("Message-ID: <abc123@example.com>");
        });

        it("Includes To/Cc headers only when displayTo/displayCC are present.", async () => {
            const raw = await buildRawMimeFromPstMessage(fakeMessage({ body: "hi", displayTo: "alice@example.com", displayCC: "carol@example.com" }));
            const text = raw.toString("latin1");
            expect(text).toContain("To: alice@example.com");
            expect(text).toContain("Cc: carol@example.com");
        });

        it("Falls back to messageDeliveryTime when clientSubmitTime is absent.", async () => {
            const raw = await buildRawMimeFromPstMessage(
                fakeMessage({ body: "hi", clientSubmitTime: null, messageDeliveryTime: new Date("2010-01-01T00:00:00Z") }),
            );
            expect(raw.toString("latin1")).toContain("Date: Fri, 01 Jan 2010 00:00:00 GMT");
        });

        it("Falls back to 'attachment' and lets the content type be derived from the extension when an attachment has neither a longFilename, a filename, nor a mimeTag.", async () => {
            const raw = await buildRawMimeFromPstMessage(
                fakeMessage({
                    body: "hi",
                    hasAttachments: true,
                    numberOfAttachments: 1,
                    getAttachment: () => ({
                        fileInputStream: { readCompletely: (buf: Buffer) => buf.fill(1) },
                        filesize: 4,
                        mimeTag: "",
                        longFilename: "",
                        filename: "",
                    }),
                }),
            );
            expect(raw.toString("latin1")).toContain("filename=attachment");
        });

        it("Falls back to an attachment's short filename when it has no longFilename.", async () => {
            const raw = await buildRawMimeFromPstMessage(
                fakeMessage({
                    body: "hi",
                    hasAttachments: true,
                    numberOfAttachments: 1,
                    getAttachment: () => ({
                        fileInputStream: { readCompletely: (buf: Buffer) => buf.fill(1) },
                        filesize: 4,
                        mimeTag: "application/pdf",
                        longFilename: "",
                        filename: "SHORT.PDF",
                    }),
                }),
            );
            expect(raw.toString("latin1")).toContain("filename=SHORT.PDF");
        });

        it("Skips an attachment whose content stream can't be read, without failing the whole message.", async () => {
            const raw = await buildRawMimeFromPstMessage(
                fakeMessage({
                    body: "hi",
                    hasAttachments: true,
                    numberOfAttachments: 1,
                    getAttachment: () => ({ fileInputStream: null, filesize: 0, filename: "x", longFilename: "x", mimeTag: "" }),
                }),
            );
            const text = raw.toString("latin1");
            expect(text).toContain("multipart/mixed");
            expect(text).not.toContain('filename="x"');
        });

        it("Skips an attachment whose claimed filesize exceeds the given maxAttachmentSize bound, without failing the whole message.", async () => {
            const raw = await buildRawMimeFromPstMessage(
                fakeMessage({
                    body: "hi",
                    hasAttachments: true,
                    numberOfAttachments: 1,
                    getAttachment: () => ({
                        // Never actually invoked - the filesize check must short-circuit before reaching
                        // it - so its body only needs to satisfy the real (buf: Buffer) => Buffer signature.
                        fileInputStream: { readCompletely: (buf: Buffer) => buf },
                        filesize: 1_000_000,
                        filename: "huge.bin",
                        longFilename: "huge.bin",
                        mimeTag: "",
                    }),
                }),
                100,
            );
            const text = raw.toString("latin1");
            expect(text).toContain("multipart/mixed");
            expect(text).not.toContain("huge.bin");
        });

        it("Fails once many individually-allowed attachments exhaust the cumulative allocation budget.", async () => {
            const readSpy = vi.fn((buf: Buffer) => buf.fill(1));
            const message = fakeMessage({
                body: "hi",
                hasAttachments: true,
                numberOfAttachments: 50,
                getAttachment: () => ({
                    fileInputStream: { readCompletely: readSpy },
                    filesize: 100,
                    filename: "a.bin",
                    longFilename: "a.bin",
                    mimeTag: "",
                }),
            });
            // Every attachment passes the per-attachment bound (100 <= 1000), but 50 of them don't fit in 1000 total.
            await expect(buildRawMimeFromPstMessage(message, 1_000, new PstAllocationBudget(1_000))).rejects.toThrow(
                "PST import exceeds the maximum total extracted size of 1000 bytes.",
            );
            // Stopped before allocating past the budget - not after reading all 50.
            expect(readSpy.mock.calls.length).toBeLessThan(10);
        });

        it("Accumulates the budget across messages, crediting a message's already-counted attachment bytes against its own output.", async () => {
            const budget = new PstAllocationBudget(1_000_000);
            const message = fakeMessage({
                body: "hi",
                hasAttachments: true,
                numberOfAttachments: 1,
                getAttachment: () => ({ fileInputStream: { readCompletely: (buf: Buffer) => buf.fill(1) }, filesize: 300, filename: "a", longFilename: "a", mimeTag: "" }),
            });
            const first = await buildRawMimeFromPstMessage(message, Infinity, budget);
            expect(budget.usedBytes).toBe(first.length);
            const second = await buildRawMimeFromPstMessage(message, Infinity, budget);
            expect(budget.usedBytes).toBe(first.length + second.length);
        });
    });

    describe("PST cumulative allocation budget", () => {
        it("PstAllocationBudget throws rather than exceeding its limit, and leaves usage unchanged when it does.", () => {
            const budget = new PstAllocationBudget(10);
            budget.consume(6);
            expect(() => budget.consume(5)).toThrow("maximum total extracted size of 10 bytes");
            expect(budget.usedBytes).toBe(6);
            budget.consume(4);
            expect(budget.usedBytes).toBe(10);
        });

        it("readAttachmentContent() charges the budget before allocating.", () => {
            const budget = new PstAllocationBudget(5);
            const attachment = { fileInputStream: { readCompletely: (buf: Buffer) => buf.fill(7) }, filesize: 4 } as any;
            expect(readAttachmentContent(attachment, 1_000, budget)).toEqual(Buffer.alloc(4, 7));
            expect(() => readAttachmentContent(attachment, 1_000, budget)).toThrow("PST import exceeds");
        });

        it("defaultPstExtractionBudget() scales with file size, floored at 64 MiB and capped at 4 GiB.", () => {
            expect(defaultPstExtractionBudget(1_000)).toBe(64 * 1024 * 1024);
            expect(defaultPstExtractionBudget(100 * 1024 * 1024)).toBe(400 * 1024 * 1024);
            expect(defaultPstExtractionBudget(10 * 1024 * 1024 * 1024)).toBe(DEFAULT_PST_MAX_TOTAL_BYTES);
        });

        it("extractPstMessages() fails the real fixture when given a total budget too small for its content, and succeeds with the default.", async () => {
            await expect(collectAsync(extractPstMessages(FIXTURE_PATH, 1_000_000))).rejects.toThrow(
                "PST import exceeds the maximum total extracted size of 1000000 bytes.",
            );
            // The default (4x file size, >= 64 MiB) comfortably fits a genuine PST - the 71-message test above.
            const fileSize = fs.statSync(FIXTURE_PATH).size;
            expect(defaultPstExtractionBudget(fileSize)).toBeGreaterThanOrEqual(fileSize * 4);
        });
    });
});
