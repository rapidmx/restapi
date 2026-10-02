///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { buildMboxEntry, parseMbox } from "../../src/util/MboxUtils.js";

/** Writes `content` to a fresh temp file and drains `parseMbox()` (now an `AsyncGenerator` reading directly
 * off a file path, rather than a plain function over an in-memory `Buffer` - see its own doc comment for
 * why) into an array, so the assertions below can stay exactly as index/length-based as they were before
 * that change. Always cleans up the temp file, success or failure. */
async function parseMboxBuffer(content: Buffer): Promise<Buffer[]> {
    const tempPath = path.join(os.tmpdir(), `mbox-test-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(tempPath, content);
    try {
        const out: Buffer[] = [];
        for await (const message of parseMbox(tempPath)) {
            out.push(message);
        }
        return out;
    } finally {
        await fs.rm(tempPath, { force: true });
    }
}

describe("buildMboxEntry() / parseMbox() Tests", () => {
    it("Builds a single mbox entry with the expected From separator and trailing blank line.", () => {
        const raw = Buffer.from("Subject: Hello\r\n\r\nBody text.", "utf-8");
        const entry = buildMboxEntry(raw, "alice@example.com", new Date("2026-01-15T10:30:00Z"));

        const text = entry.toString("latin1");
        expect(text).toMatch(/^From alice@example\.com Thu Jan 15 10:30:00 2026\n/);
        expect(text).toContain("Subject: Hello\r\n\r\nBody text.");
        expect(text.endsWith("\n")).toBe(true);
    });

    it("Falls back to MAILER-DAEMON when no from address is given.", () => {
        const entry = buildMboxEntry(Buffer.from("x"), "", new Date("2026-01-15T10:30:00Z"));
        expect(entry.toString("latin1")).toMatch(/^From MAILER-DAEMON /);
    });

    it("Strips an embedded CR/LF from fromAddress before building the separator line, rather than letting it inject a fake From separator that would corrupt parseMbox()'s re-parsing.", () => {
        const raw = Buffer.from("Subject: Hello\r\n\r\nBody text.", "utf-8");
        const entry = buildMboxEntry(raw, "attacker@example.com\nFrom injected@evil.com Mon Jan 01 00:00:00 2026", new Date("2026-01-15T10:30:00Z"));

        const text = entry.toString("latin1");
        expect(text).toMatch(/^From attacker@example\.comFrom injected@evil\.com Mon Jan 01 00:00:00 2026 Thu Jan 15 10:30:00 2026\n/);
        // Only ONE real separator line exists in the whole entry - the injected fragment landed inline on
        // that same first line rather than starting a second, spoofed message boundary.
        expect(text.match(/^From /gm)!.length).toBe(1);
    });

    it("Escapes a body line that starts with 'From ' so it can't be mistaken for a separator.", () => {
        const raw = Buffer.from("Subject: Test\r\n\r\nFrom the desk of Bob.", "utf-8");
        const entry = buildMboxEntry(raw, "bob@example.com", new Date("2026-01-01T00:00:00Z"));

        expect(entry.toString("latin1")).toContain("> From the desk of Bob.");
    });

    it("Round-trips a single message through buildMboxEntry() and parseMbox().", async () => {
        const raw = Buffer.from("Subject: Hello\r\nFrom: alice@example.com\r\n\r\nBody text.", "utf-8");
        const entry = buildMboxEntry(raw, "alice@example.com", new Date("2026-01-15T10:30:00Z"));

        const [parsed] = await parseMboxBuffer(entry);

        expect(parsed.toString("utf-8")).toBe(raw.toString("utf-8"));
    });

    it("Round-trips multiple concatenated messages, preserving order.", async () => {
        const rawA = Buffer.from("Subject: First\r\n\r\nFirst body.", "utf-8");
        const rawB = Buffer.from("Subject: Second\r\n\r\nSecond body.", "utf-8");
        const mbox = Buffer.concat([
            buildMboxEntry(rawA, "a@example.com", new Date("2026-01-01T00:00:00Z")),
            buildMboxEntry(rawB, "b@example.com", new Date("2026-01-02T00:00:00Z")),
        ]);

        const parsed = await parseMboxBuffer(mbox);

        expect(parsed.length).toBe(2);
        expect(parsed[0].toString("utf-8")).toBe(rawA.toString("utf-8"));
        expect(parsed[1].toString("utf-8")).toBe(rawB.toString("utf-8"));
    });

    it("Does not truncate a non-final message's own trailing byte when its raw content ends in a newline (the realistic case - every real RFC 5322 message's last body line ends \\r\\n).", async () => {
        const rawA = Buffer.from("Subject: First\r\n\r\nFirst body.\r\n", "utf-8");
        const rawB = Buffer.from("Subject: Second\r\n\r\nSecond body.\r\n", "utf-8");
        const rawC = Buffer.from("Subject: Third\r\n\r\nThird body.\r\n", "utf-8");
        const mbox = Buffer.concat([
            buildMboxEntry(rawA, "a@example.com", new Date("2026-01-01T00:00:00Z")),
            buildMboxEntry(rawB, "b@example.com", new Date("2026-01-02T00:00:00Z")),
            buildMboxEntry(rawC, "c@example.com", new Date("2026-01-03T00:00:00Z")),
        ]);

        const parsed = await parseMboxBuffer(mbox);

        expect(parsed.length).toBe(3);
        // Every message, first through last, must come back byte-identical - not just the final one.
        expect(parsed[0].toString("utf-8")).toBe(rawA.toString("utf-8"));
        expect(parsed[1].toString("utf-8")).toBe(rawB.toString("utf-8"));
        expect(parsed[2].toString("utf-8")).toBe(rawC.toString("utf-8"));
    });

    it("Round-trips a message whose body contains an escaped 'From ' line.", async () => {
        const raw = Buffer.from("Subject: Test\r\n\r\nFrom the desk of Bob.\r\nRegards.", "utf-8");
        const entry = buildMboxEntry(raw, "bob@example.com", new Date("2026-01-01T00:00:00Z"));

        const [parsed] = await parseMboxBuffer(entry);

        expect(parsed.toString("utf-8")).toBe(raw.toString("utf-8"));
    });

    it("Returns an empty array for an empty mbox file.", async () => {
        expect(await parseMboxBuffer(Buffer.alloc(0))).toEqual([]);
    });

    it("Returns an empty array for a malformed file with no From separator at all.", async () => {
        expect(await parseMboxBuffer(Buffer.from("not a real mbox file, no separator here\r\n", "latin1"))).toEqual([]);
    });

    it("Preserves non-UTF-8 bytes in the message body (latin1 lossless round-trip).", async () => {
        const raw = Buffer.from([0x53, 0x75, 0x62, 0x3a, 0x20, 0xff, 0xfe, 0x0d, 0x0a]);
        const entry = buildMboxEntry(raw, "a@example.com", new Date("2026-01-01T00:00:00Z"));

        const [parsed] = await parseMboxBuffer(entry);

        expect(Buffer.compare(parsed, raw)).toBe(0);
    });

    it("Correctly parses messages whose combined size spans many internal read-stream chunks (the streaming rewrite's whole point - see parseMbox()'s own doc comment), not just a single small buffer.", async () => {
        // `fs.createReadStream()`'s default internal chunk size is 64 KiB - each body here is well past that,
        // and there are enough of them that the accumulated/compacted `text` buffer inside `parseMbox()` gets
        // exercised across many separator-search iterations, not just the fast "one chunk, one message" path
        // every other test above happens to take.
        const bigBody = "X".repeat(200_000);
        const rawA = Buffer.from(`Subject: Big A\r\n\r\n${bigBody}-A\r\n`, "utf-8");
        const rawB = Buffer.from(`Subject: Big B\r\n\r\n${bigBody}-B\r\n`, "utf-8");
        const rawC = Buffer.from(`Subject: Big C\r\n\r\n${bigBody}-C\r\n`, "utf-8");
        const mbox = Buffer.concat([
            buildMboxEntry(rawA, "a@example.com", new Date("2026-01-01T00:00:00Z")),
            buildMboxEntry(rawB, "b@example.com", new Date("2026-01-02T00:00:00Z")),
            buildMboxEntry(rawC, "c@example.com", new Date("2026-01-03T00:00:00Z")),
        ]);

        const parsed = await parseMboxBuffer(mbox);

        expect(parsed.length).toBe(3);
        expect(parsed[0].toString("utf-8")).toBe(rawA.toString("utf-8"));
        expect(parsed[1].toString("utf-8")).toBe(rawB.toString("utf-8"));
        expect(parsed[2].toString("utf-8")).toBe(rawC.toString("utf-8"));
    });

    it("Finds every separator whichever read-stream chunk boundary it straddles.", async () => {
        // Bodies of varying length (so separators fall at every offset relative to the 64 KiB chunks), many short lines each.
        const raws: Buffer[] = [];
        for (let i = 0; i < 60; i++) {
            raws.push(Buffer.from(`Subject: M${i}\r\n\r\n${"line of text\r\n".repeat(400 + i * 37)}From the end\r\n`, "utf-8"));
        }
        const mbox = Buffer.concat(raws.map((raw, i) => buildMboxEntry(raw, `m${i}@example.com`, new Date("2026-01-01T00:00:00Z"))));

        const parsed = await parseMboxBuffer(mbox);

        expect(parsed.length).toBe(raws.length);
        parsed.forEach((message, i) => expect(Buffer.compare(message, raws[i])).toBe(0));
    });

    it("Parses one very large message in time linear in its size (no rescan of everything read so far per chunk).", async () => {
        const raw = Buffer.from(`Subject: Huge\r\n\r\n${"0123456789abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz\r\n".repeat(900_000)}`, "utf-8");
        const started: number = performance.now();
        const parsed = await parseMboxBuffer(buildMboxEntry(raw, "big@example.com", new Date("2026-01-01T00:00:00Z")));
        expect(performance.now() - started).toBeLessThan(2500);
        expect(parsed.length).toBe(1);
        expect(parsed[0].length).toBe(raw.length);
    }, 30_000);

    it("Parses one endless line in linear time, and refuses a message over the cap.", async () => {
        // Neither a newline-free `From ` line nor a newline-free blob may make each chunk rescan everything read before it.
        for (const lead of ["From ", "x"]) {
            const started: number = performance.now();
            const body = `${lead}${"a".repeat(40 * 1024 * 1024)}`;
            const parsed = await parseMboxBuffer(Buffer.from(`From a@b Thu Jan  1 00:00:00 2026\nSubject: s\n\n${body}\n`, "latin1"));
            expect(performance.now() - started).toBeLessThan(5000);
            expect(parsed).toHaveLength(1);
            expect(parsed[0].length).toBe(`Subject: s\n\n${body}`.length);
        }
        const tempPath = path.join(os.tmpdir(), `mbox-test-${crypto.randomUUID()}.tmp`);
        await fs.writeFile(tempPath, `From a@b Thu Jan  1 00:00:00 2026\nSubject: s\n\n${"b".repeat(5000)}\n`);
        try {
            const drain = async (cap: number): Promise<number> => {
                let count = 0;
                for await (const _message of parseMbox(tempPath, cap)) {
                    count++;
                }
                return count;
            };
            await expect(drain(1000)).rejects.toThrow(/larger than 1000 bytes/);
            expect(await drain(10_000)).toBe(1);
        } finally {
            await fs.rm(tempPath, { force: true });
        }
    }, 60_000);

    it("Finds a separator whose start is split across read chunks, and takes a long or truncated From line as text.", async () => {
        const first = "From a@b Thu Jan  1 00:00:00 2026\n";
        // The second separator begins `split` characters before the 64 KB read boundary, so its `From ` is cut at every offset.
        for (let split = 1; split <= 6; split++) {
            const pad = "x".repeat(65_536 - split - first.length - 1);
            const mbox = Buffer.from(`${first}${pad}\nFrom c@d Thu Jan  1 00:00:00 2026\nbody\n`, "latin1");
            const parsed = await parseMboxBuffer(mbox);
            expect(parsed.map((m) => m.toString("latin1")), `split ${split}`).toEqual([pad, "body"]);
        }
        // A line that starts like a separator but is longer than any is text, and so is one cut short by the end of the file.
        const longFrom = `From ${"z".repeat(5000)}`;
        const parsed = await parseMboxBuffer(Buffer.from(`${first}Subject: s\n\n${longFrom}\nFro\nFrom x`, "latin1"));
        expect(parsed).toHaveLength(1);
        expect(parsed[0].toString("latin1")).toBe(`Subject: s\n\n${longFrom}\nFro\nFrom x`);
    });

    it("Takes a From line directly after a separator as text, as before, and drops what precedes the first separator.", async () => {
        const mbox = Buffer.from("junk line\nmore junk\nFrom a@b Thu Jan  1 00:00:00 2026\nFrom c@d Thu Jan  1 00:00:00 2026\nbody\n", "latin1");
        const parsed = await parseMboxBuffer(mbox);
        expect(parsed).toHaveLength(1);
        expect(parsed[0].toString("latin1")).toBe("From c@d Thu Jan  1 00:00:00 2026\nbody");
    });
});
