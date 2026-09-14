///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { isIpInCidrs, normalizeIp, rateLimitKeyForIp, resolveClientIp } from "../../src/util/ClientIpUtils.js";

function req(remoteAddress: string | undefined, headers: Record<string, any> = {}): any {
    return { headers, socket: { remoteAddress } };
}

describe("ClientIpUtils Tests", () => {
    describe("normalizeIp()", () => {
        it("Strips IPv4-mapped prefix, zone, brackets and ports.", () => {
            expect(normalizeIp("::ffff:10.1.2.3")).toBe("10.1.2.3");
            expect(normalizeIp("::FFFF:10.1.2.3")).toBe("10.1.2.3");
            expect(normalizeIp(" fe80::1%eth0 ")).toBe("fe80::1");
            expect(normalizeIp("[2001:db8::1]:443")).toBe("2001:db8::1");
            expect(normalizeIp("1.2.3.4:5678")).toBe("1.2.3.4");
        });
    });

    describe("isIpInCidrs()", () => {
        it("Matches exact IPv4 and IPv4 CIDR ranges.", () => {
            expect(isIpInCidrs("10.0.0.1", ["10.0.0.1"])).toBe(true);
            expect(isIpInCidrs("10.200.3.4", ["10.0.0.0/8"])).toBe(true);
            expect(isIpInCidrs("11.0.0.1", ["10.0.0.0/8"])).toBe(false);
            expect(isIpInCidrs("192.168.1.255", "192.168.1.0/24")).toBe(true);
        });

        it("Matches IPv6 exact and CIDR ranges.", () => {
            expect(isIpInCidrs("fd12::1", ["fc00::/7"])).toBe(true);
            expect(isIpInCidrs("2001:db8::1", ["fc00::/7"])).toBe(false);
            expect(isIpInCidrs("::1", ["::1"])).toBe(true);
        });

        it("Matches IPv4-mapped IPv6 against IPv4 entries, and mapped entries against IPv4 addresses.", () => {
            expect(isIpInCidrs("::ffff:10.0.0.5", ["10.0.0.0/24"])).toBe(true);
            expect(isIpInCidrs("10.0.0.5", ["::ffff:10.0.0.5"])).toBe(true);
        });

        it("Accepts a comma-separated string and ignores malformed entries.", () => {
            expect(isIpInCidrs("172.16.5.5", "garbage, 10.0.0.0/abc, 172.16.0.0/12")).toBe(true);
            expect(isIpInCidrs("10.0.0.1", ["10.0.0.0/99", "not-an-ip", ""])).toBe(false);
        });

        it("Returns false for malformed ips and empty lists.", () => {
            expect(isIpInCidrs("not-an-ip", ["0.0.0.0/0"])).toBe(false);
            expect(isIpInCidrs(undefined, ["0.0.0.0/0"])).toBe(false);
            expect(isIpInCidrs("10.0.0.1", undefined)).toBe(false);
            expect(isIpInCidrs("10.0.0.1", [])).toBe(false);
        });

        it("Keeps matching correctly after the bounded block-list cache is flushed by many distinct lists.", () => {
            for (let i = 0; i < 70; i++) {
                const cidrs: string[] = [`10.${i}.0.0/16`];
                expect(isIpInCidrs(`10.${i}.1.1`, cidrs)).toBe(true);
                expect(isIpInCidrs(`10.${i + 1}.1.1`, cidrs)).toBe(false);
            }
            // A list cached before the flush is rebuilt, not lost.
            expect(isIpInCidrs("10.0.9.9", ["10.0.0.0/16"])).toBe(true);
            expect(isIpInCidrs("10.1.9.9", ["10.0.0.0/16"])).toBe(false);
        });
    });

    describe("resolveClientIp()", () => {
        it("Ignores X-Forwarded-For when the socket peer is not trusted.", () => {
            expect(resolveClientIp(req("203.0.113.9", { "x-forwarded-for": "1.1.1.1" }), ["10.0.0.0/8"])).toBe("203.0.113.9");
            expect(resolveClientIp(req("203.0.113.9", { "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }), undefined)).toBe(
                "203.0.113.9",
            );
        });

        it("Normalizes an IPv4-mapped socket peer.", () => {
            expect(resolveClientIp(req("::ffff:203.0.113.9"), [])).toBe("203.0.113.9");
        });

        it("Returns the nearest untrusted hop, walking right to left (spoofed left entries are ignored).", () => {
            const r = req("10.0.0.2", { "x-forwarded-for": "6.6.6.6, 198.51.100.7, 10.0.0.9" });
            expect(resolveClientIp(r, ["10.0.0.0/8"])).toBe("198.51.100.7");
        });

        it("Trusts CIDR-matched peers (IPv6 and IPv4-mapped).", () => {
            expect(resolveClientIp(req("fd00::5", { "x-forwarded-for": "198.51.100.7" }), ["fc00::/7"])).toBe("198.51.100.7");
            expect(resolveClientIp(req("::ffff:10.1.1.1", { "x-forwarded-for": "198.51.100.7" }), "10.0.0.0/8")).toBe("198.51.100.7");
        });

        it("Returns the left-most hop when every hop is trusted.", () => {
            expect(resolveClientIp(req("10.0.0.2", { "x-forwarded-for": "10.0.0.8, 10.0.0.9" }), ["10.0.0.0/8"])).toBe("10.0.0.8");
        });

        it("Skips malformed X-Forwarded-For entries and handles array headers.", () => {
            expect(resolveClientIp(req("10.0.0.2", { "x-forwarded-for": "198.51.100.7, garbage, " }), ["10.0.0.0/8"])).toBe(
                "198.51.100.7",
            );
            expect(resolveClientIp(req("10.0.0.2", { "x-forwarded-for": ["198.51.100.7", "10.0.0.3"] }), ["10.0.0.0/8"])).toBe(
                "198.51.100.7",
            );
            expect(resolveClientIp(req("10.0.0.2", { "x-forwarded-for": "::ffff:198.51.100.8" }), ["10.0.0.0/8"])).toBe("198.51.100.8");
        });

        it("Falls back to X-Real-IP, then the peer, when X-Forwarded-For is absent or unusable.", () => {
            expect(resolveClientIp(req("10.0.0.2", { "x-real-ip": "198.51.100.7" }), ["10.0.0.0/8"])).toBe("198.51.100.7");
            expect(resolveClientIp(req("10.0.0.2", { "x-forwarded-for": "junk", "x-real-ip": "junk" }), ["10.0.0.0/8"])).toBe("10.0.0.2");
        });

        it("Returns undefined without a socket address.", () => {
            expect(resolveClientIp(req(undefined, { "x-forwarded-for": "1.1.1.1" }), ["0.0.0.0/0"])).toBeUndefined();
            expect(resolveClientIp({}, undefined)).toBeUndefined();
        });
    });
    describe("rateLimitKeyForIp()", () => {
        it("Keys IPv4 by the full address and IPv6 by its /64.", () => {
            expect(rateLimitKeyForIp("198.51.100.7")).toBe("198.51.100.7");
            expect(rateLimitKeyForIp("::ffff:198.51.100.7")).toBe("198.51.100.7");
            expect(rateLimitKeyForIp("2001:DB8:1:2:ffff:abcd:1234:5678")).toBe("2001:db8:1:2::/64");
            expect(rateLimitKeyForIp("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
            expect(rateLimitKeyForIp("[2001:db8::5]:443")).toBe("2001:db8:0:0::/64");
            expect(rateLimitKeyForIp("::1")).toBe("0:0:0:0::/64");
            expect(rateLimitKeyForIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
            expect(rateLimitKeyForIp("64:ff9b:1:2::198.51.100.7")).toBe("64:ff9b:1:2::/64");
            expect(rateLimitKeyForIp("1:2:3:4:5:6:7:8")).toBe("1:2:3:4::/64");
            expect(rateLimitKeyForIp("1::")).toBe("1:0:0:0::/64");
            expect(rateLimitKeyForIp("not-an-ip")).toBe("not-an-ip");
        });
    });
});
