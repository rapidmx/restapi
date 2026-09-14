///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import {
    countHeaderOccurrences,
    extractDkimSignatures,
    isHeaderOversignedByAlignedDkim,
    oversignsHeader,
    parseDkimSignature,
    verifiedDkimSignatures,
} from "../../src/util/DkimOversignUtils.js";

const TRUSTED = "mx.example.com";

function message(headers: string[]): Buffer {
    return Buffer.from([...headers, "", "Body text with RapidMX-Key: not a header", ""].join("\r\n"));
}

function signature(domain: string, h: string, b: string = "c2lnbmF0dXJl"): string {
    return `DKIM-Signature: v=1; a=rsa-sha256; d=${domain}; s=sel; h=${h}; bh=Ym9keQ==; b=${b}`;
}

describe("parseDkimSignature() Tests", () => {
    it("Parses d=, h= and b=, lowercasing names and stripping folding whitespace.", () => {
        const parsed = parseDkimSignature("v=1; a=rsa-sha256; d=Example.COM.; s=sel;\r\n\th=From : To:\r\n RapidMX-Key:rapidmx-key; bh=Ym9k; b=abc\r\n def;");
        expect(parsed).toBeDefined();
        expect(parsed!.domain).toBe("example.com");
        expect(parsed!.signedHeaders).toEqual(["from", "to", "rapidmx-key", "rapidmx-key"]);
        expect(parsed!.signature).toBe("abcdef");
        expect(parsed!.tags.s).toBe("sel");
    });

    it("Rejects a tag-list with a duplicate tag (RFC 6376 §3.2).", () => {
        expect(parseDkimSignature("v=1; d=example.com; h=from; b=abc; h=from:rapidmx-key:rapidmx-key")).toBeUndefined();
    });

    it("Rejects a tag without '=', an unsupported v=, and a missing d=/h=/b=.", () => {
        expect(parseDkimSignature("v=1; d=example.com; h=from; b=abc; garbage")).toBeUndefined();
        expect(parseDkimSignature("v=2; d=example.com; h=from; b=abc")).toBeUndefined();
        expect(parseDkimSignature("v=1; h=from; b=abc")).toBeUndefined();
        expect(parseDkimSignature("v=1; d=example.com; b=abc")).toBeUndefined();
        expect(parseDkimSignature("v=1; d=example.com; h=from; b=")).toBeUndefined();
    });

    it("Accepts a signature with no v= tag and a trailing semicolon.", () => {
        expect(parseDkimSignature("d=example.com; h=from; b=abc;")?.domain).toBe("example.com");
    });
});

describe("countHeaderOccurrences()/extractDkimSignatures() Tests", () => {
    it("Counts top-level header instances case-insensitively (tolerating space before the colon), never body text.", () => {
        const raw = message(["From: a@example.com", "rapidmx-key: one", "RapidMX-Key : two", "Subject: x"]);
        expect(countHeaderOccurrences(raw, "RapidMX-Key")).toBe(2);
        expect(countHeaderOccurrences(raw, "X-RapidMX-Recall-Of")).toBe(0);
    });

    it("Extracts every parseable DKIM-Signature, including folded ones, skipping malformed ones.", () => {
        const raw = message([
            "From: a@example.com",
            "DKIM-Signature: v=1; d=example.com; s=sel;\r\n h=from:subject; b=abc",
            "DKIM-Signature: this is not a tag list",
            signature("other.example", "from"),
        ]);
        expect(extractDkimSignatures(raw).map((sig) => sig.domain)).toEqual(["example.com", "other.example"]);
    });

    it("Ignores header-block lines with no field name (no colon, or a leading colon).", () => {
        const raw = message(["From: a@example.com", "RapidMX-Key garbage without colon", ": RapidMX-Key", "RapidMX-Key: real"]);
        expect(countHeaderOccurrences(raw, "RapidMX-Key")).toBe(1);
        expect(countHeaderOccurrences(raw, "")).toBe(0);
    });

    it("Handles a message with no header/body separator.", () => {
        expect(countHeaderOccurrences(Buffer.from("RapidMX-Key: x"), "RapidMX-Key")).toBe(1);
    });
});

describe("oversignsHeader() Tests", () => {
    it("Requires h= to list the header strictly more times than it occurs.", () => {
        const sig = parseDkimSignature("d=example.com; h=from:rapidmx-key:RapidMX-Key; b=abc")!;
        expect(oversignsHeader(sig, "RapidMX-Key", 0)).toBe(true);
        expect(oversignsHeader(sig, "RapidMX-Key", 1)).toBe(true);
        expect(oversignsHeader(sig, "RapidMX-Key", 2)).toBe(false);
        expect(oversignsHeader(sig, "X-RapidMX-Recall-Of", 0)).toBe(false);
    });
});

describe("verifiedDkimSignatures() Tests", () => {
    const sigA = parseDkimSignature("d=example.com; h=from; b=AAAAAAAAsigA")!;
    const sigB = parseDkimSignature("d=example.com; h=from:rapidmx-key:rapidmx-key; b=BBBBBBBBsigB")!;

    it("Ties a pass entry to exactly one signature by its header.b prefix.", () => {
        expect(verifiedDkimSignatures([sigA, sigB], `${TRUSTED}; dkim=pass header.d=example.com header.b=BBBBBBBB`, TRUSTED)).toEqual([sigB]);
    });

    it("Matches nothing when a header.b prefix is ambiguous between signatures.", () => {
        const twin = parseDkimSignature("d=example.com; h=from:rapidmx-key:rapidmx-key; b=BBBBBBBBother")!;
        expect(verifiedDkimSignatures([sigB, twin], `${TRUSTED}; dkim=pass header.d=example.com header.b=BBBBBBBB`, TRUSTED)).toEqual([]);
    });

    it("Without header.b, only counts a domain's signatures when every one of them passed.", () => {
        // One pass for two example.com signatures - the other one may be a forged, failing signature.
        expect(verifiedDkimSignatures([sigA, sigB], `${TRUSTED}; dkim=pass header.d=example.com; dkim=fail header.d=example.com`, TRUSTED)).toEqual([]);
        expect(verifiedDkimSignatures([sigA, sigB], `${TRUSTED}; dkim=pass header.d=example.com; dkim=pass header.d=example.com`, TRUSTED)).toEqual([sigA, sigB]);
        expect(verifiedDkimSignatures([sigB], `${TRUSTED}; dkim=pass header.d=EXAMPLE.com`, TRUSTED)).toEqual([sigB]);
    });

    it("Ignores entries from an untrusted authserv-id, non-pass results, and an unconfigured trusted id.", () => {
        expect(verifiedDkimSignatures([sigB], "evil.example; dkim=pass header.d=example.com", TRUSTED)).toEqual([]);
        expect(verifiedDkimSignatures([sigB], `${TRUSTED}; dkim=neutral header.d=example.com`, TRUSTED)).toEqual([]);
        expect(verifiedDkimSignatures([sigB], `${TRUSTED}; dkim=pass header.d=example.com`, "")).toEqual([]);
        expect(verifiedDkimSignatures([sigB], undefined, TRUSTED)).toEqual([]);
    });
});

describe("isHeaderOversignedByAlignedDkim() Tests", () => {
    const ar = (domain: string = "example.com"): string => `${TRUSTED}; dkim=pass header.d=${domain}`;

    it("Accepts a header oversigned by a verified signature aligned with From.", () => {
        const raw = message(["From: a@example.com", "RapidMX-Key: x", signature("example.com", "from:rapidmx-key:rapidmx-key")]);
        expect(isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "example.com", ar(), TRUSTED)).toBe(true);
        expect(isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "EXAMPLE.com", [ar()], TRUSTED)).toBe(true);
    });

    it("Rejects when there is no DKIM-Signature at all.", () => {
        const raw = message(["From: a@example.com", "RapidMX-Key: x"]);
        expect(isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "example.com", ar(), TRUSTED)).toBe(false);
    });

    it("Rejects a signature that lists the header only as many times as it occurs (a replayer can append one more).", () => {
        const raw = message(["From: a@example.com", "RapidMX-Key: x", signature("example.com", "from:rapidmx-key")]);
        expect(isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "example.com", ar(), TRUSTED)).toBe(false);
    });

    it("Rejects an appended second instance against a signature that oversigned only one.", () => {
        const raw = message(["From: a@example.com", "RapidMX-Key: x", "RapidMX-Key: appended", signature("example.com", "from:rapidmx-key:rapidmx-key")]);
        expect(isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "example.com", ar(), TRUSTED)).toBe(false);
    });

    it("Rejects an oversigning signature whose d= isn't strictly aligned with From (including a parent/sub-domain).", () => {
        const other = message(["From: a@example.com", "RapidMX-Key: x", signature("other.example", "from:rapidmx-key:rapidmx-key")]);
        expect(isHeaderOversignedByAlignedDkim(other, "RapidMX-Key", "example.com", ar("other.example"), TRUSTED)).toBe(false);
        const parent = message(["From: a@mail.example.com", "RapidMX-Key: x", signature("example.com", "from:rapidmx-key:rapidmx-key")]);
        expect(isHeaderOversignedByAlignedDkim(parent, "RapidMX-Key", "mail.example.com", ar(), TRUSTED)).toBe(false);
    });

    it("Rejects an oversigning signature the trusted hop didn't verify.", () => {
        const raw = message(["From: a@example.com", "RapidMX-Key: x", signature("example.com", "from:rapidmx-key:rapidmx-key")]);
        expect(isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "example.com", `${TRUSTED}; dkim=fail header.d=example.com`, TRUSTED)).toBe(false);
        expect(isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "example.com", "attacker.example; dkim=pass header.d=example.com", TRUSTED)).toBe(false);
    });

    it("Rejects a forged extra oversigning signature next to a genuine non-oversigning one for the same domain.", () => {
        const raw = message([
            "From: a@example.com",
            "RapidMX-Key: appended",
            signature("example.com", "from:subject", "R2VudWluZQ"),
            signature("example.com", "from:rapidmx-key:rapidmx-key", "Rm9yZ2VkIQ"),
        ]);
        // Genuine one passes, forged one fails - with or without header.b the forged signature must not count.
        expect(isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "example.com", `${TRUSTED}; dkim=pass header.d=example.com; dkim=fail header.d=example.com`, TRUSTED)).toBe(false);
        expect(
            isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "example.com", `${TRUSTED}; dkim=pass header.d=example.com header.b=R2VudWlu; dkim=fail header.d=example.com header.b=Rm9yZ2Vk`, TRUSTED),
        ).toBe(false);
    });

    it("Fails closed for an empty From domain or an unconfigured trusted authserv-id.", () => {
        const raw = message(["From: a@example.com", "RapidMX-Key: x", signature("example.com", "from:rapidmx-key:rapidmx-key")]);
        expect(isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "", ar(), TRUSTED)).toBe(false);
        expect(isHeaderOversignedByAlignedDkim(raw, "RapidMX-Key", "example.com", ar(), "")).toBe(false);
    });
});
