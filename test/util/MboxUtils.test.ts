///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { buildMboxEntry, parseMbox } from "../../src/util/MboxUtils.js";

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

    it("Escapes a body line that starts with 'From ' so it can't be mistaken for a separator.", () => {
        const raw = Buffer.from("Subject: Test\r\n\r\nFrom the desk of Bob.", "utf-8");
        const entry = buildMboxEntry(raw, "bob@example.com", new Date("2026-01-01T00:00:00Z"));

        expect(entry.toString("latin1")).toContain("> From the desk of Bob.");
    });

    it("Round-trips a single message through buildMboxEntry() and parseMbox().", () => {
        const raw = Buffer.from("Subject: Hello\r\nFrom: alice@example.com\r\n\r\nBody text.", "utf-8");
        const entry = buildMboxEntry(raw, "alice@example.com", new Date("2026-01-15T10:30:00Z"));

        const [parsed] = parseMbox(entry);

        expect(parsed.toString("utf-8")).toBe(raw.toString("utf-8"));
    });

    it("Round-trips multiple concatenated messages, preserving order.", () => {
        const rawA = Buffer.from("Subject: First\r\n\r\nFirst body.", "utf-8");
        const rawB = Buffer.from("Subject: Second\r\n\r\nSecond body.", "utf-8");
        const mbox = Buffer.concat([
            buildMboxEntry(rawA, "a@example.com", new Date("2026-01-01T00:00:00Z")),
            buildMboxEntry(rawB, "b@example.com", new Date("2026-01-02T00:00:00Z")),
        ]);

        const parsed = parseMbox(mbox);

        expect(parsed.length).toBe(2);
        expect(parsed[0].toString("utf-8")).toBe(rawA.toString("utf-8"));
        expect(parsed[1].toString("utf-8")).toBe(rawB.toString("utf-8"));
    });

    it("Round-trips a message whose body contains an escaped 'From ' line.", () => {
        const raw = Buffer.from("Subject: Test\r\n\r\nFrom the desk of Bob.\r\nRegards.", "utf-8");
        const entry = buildMboxEntry(raw, "bob@example.com", new Date("2026-01-01T00:00:00Z"));

        const [parsed] = parseMbox(entry);

        expect(parsed.toString("utf-8")).toBe(raw.toString("utf-8"));
    });

    it("Returns an empty array for an empty mbox file.", () => {
        expect(parseMbox(Buffer.alloc(0))).toEqual([]);
    });

    it("Preserves non-UTF-8 bytes in the message body (latin1 lossless round-trip).", () => {
        const raw = Buffer.from([0x53, 0x75, 0x62, 0x3a, 0x20, 0xff, 0xfe, 0x0d, 0x0a]);
        const entry = buildMboxEntry(raw, "a@example.com", new Date("2026-01-01T00:00:00Z"));

        const [parsed] = parseMbox(entry);

        expect(Buffer.compare(parsed, raw)).toBe(0);
    });
});
