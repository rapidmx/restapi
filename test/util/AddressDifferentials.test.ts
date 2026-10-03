///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Every place that reads an address's domain must read the same one, and an address a reader would see differently from
// how a parser reads it must not be accepted as a plain address.
import { addressDomainOf } from "../../src/util/AddressUtils.js";
import { createFederatedPeerCheck, DomainUtils } from "../../src/util/DomainUtils.js";
import { isPlainAddress, safeDisplayName } from "../../src/util/MimeHeaderUtils.js";

/** The character with the given code point (written out as a number so no invisible character sits in this file). */
const ch = (code: number): string => String.fromCodePoint(code);

describe("Address parsing differentials", () => {
    it("Reads the domain after the one @, and none from an address with several.", () => {
        expect(addressDomainOf("Alice@Example.COM")).toBe("example.com");
        expect(addressDomainOf("a@internal.com@evil.com")).toBeUndefined();
        expect(addressDomainOf("no-at-sign")).toBeUndefined();
        expect(addressDomainOf("empty@")).toBeUndefined();
    });

    it("Does not class an address with a second @ as one of this server's own.", async () => {
        const domainUtils = new DomainUtils({} as any);
        expect(await domainUtils.isInternalAddress("a@internal.com", ["internal.com"])).toBe(true);
        expect(await domainUtils.isInternalAddress("a@internal.com@evil.com", ["internal.com"])).toBe(false);
        expect(await domainUtils.isInternalAddress("a@evil.com@internal.com", ["internal.com"])).toBe(false);
    });

    it("Does not look up a second domain's federation policy for an address with a second @.", async () => {
        const dns: any = { resolveTxt: vi.fn().mockResolvedValue([]) };
        expect(await createFederatedPeerCheck(dns)("a@internal.com@fed-peer.example.com")).toBe(false);
        expect(dns.resolveTxt).not.toHaveBeenCalled();
    });

    it("Refuses a plain address with a look-alike @, a bidi override, a zero-width or other format character.", () => {
        expect(isPlainAddress("alice@example.com")).toBe(true);
        for (const address of [
            `ceo${ch(0xff20)}victim.com@own.com`, // fullwidth @
            `ceo${ch(0xfe6b)}victim.com@own.com`, // small @
            `ceo${ch(0x202e)}victim.com@own.com`, // right-to-left override
            `ceo${ch(0x200b)}victim.com@own.com`, // zero-width space
            `ceo@own${ch(0x2066)}.com`, // left-to-right isolate
            `ceo${ch(0x85)}@own.com`, // C1 control (next line)
        ]) {
            expect(isPlainAddress(address)).toBe(false);
        }
    });

    it("Omits a display name holding a bidi control character, but keeps an emoji sequence's joiner.", () => {
        expect(safeDisplayName("Alice")).toBe("Alice");
        expect(safeDisplayName(`Alice ${ch(0x202e)}gnp.exe`)).toBeUndefined();
        expect(safeDisplayName(`Alice ${ch(0x2067)}`)).toBeUndefined();
        const family = `Family ${ch(0x1f468)}${ch(0x200d)}${ch(0x1f469)}`;
        expect(safeDisplayName(family)).toBe(family);
    });
});
