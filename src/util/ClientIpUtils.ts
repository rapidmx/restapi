///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import net from "node:net";

/** The `trusted_proxies` config shape: an array of addresses/CIDR ranges, or a single comma-separated string. */
export type TrustedProxies = string | string[] | undefined | null;

/** Strips surrounding whitespace, brackets, an IPv6 zone, and the IPv4-mapped IPv6 prefix (`::ffff:10.0.0.1` -> `10.0.0.1`). */
export function normalizeIp(address: string): string {
    let text: string = String(address ?? "").trim();
    // `[::1]` / `[::1]:443` (bracketed IPv6, optionally with a port) and `1.2.3.4:5678` (IPv4 with a port).
    const bracketed: RegExpMatchArray | null = text.match(/^\[([^\]]+)\](?::\d+)?$/);
    if (bracketed) {
        text = bracketed[1];
    } else {
        const v4Port: RegExpMatchArray | null = text.match(/^(\d+\.\d+\.\d+\.\d+):\d+$/);
        if (v4Port) {
            text = v4Port[1];
        }
    }
    return text.replace(/%.*$/, "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

const blockListCache = new Map<string, net.BlockList>();

function toEntries(cidrs: TrustedProxies): string[] {
    if (!cidrs) {
        return [];
    }
    return (Array.isArray(cidrs) ? cidrs : String(cidrs).split(","))
        .map((entry) => String(entry ?? "").trim())
        .filter((entry) => entry.length > 0);
}

function buildBlockList(entries: string[]): net.BlockList {
    const key: string = entries.join(",");
    let list: net.BlockList | undefined = blockListCache.get(key);
    if (list) {
        return list;
    }
    list = new net.BlockList();
    for (const entry of entries) {
        const slash: number = entry.indexOf("/");
        const address: string = normalizeIp(slash >= 0 ? entry.slice(0, slash) : entry);
        const prefixText: string | undefined = slash >= 0 ? entry.slice(slash + 1) : undefined;
        const family: number = net.isIP(address);
        if (!family) {
            continue;
        }
        const type: "ipv4" | "ipv6" = family === 4 ? "ipv4" : "ipv6";
        try {
            if (prefixText === undefined) {
                list.addAddress(address, type);
            } else {
                if (!/^\d+$/.test(prefixText)) {
                    continue;
                }
                list.addSubnet(address, Number(prefixText), type);
            }
        } catch {
            // Invalid prefix length: the entry trusts nothing.
        }
    }
    // Bounded: config values are few and stable, but never let arbitrary inputs grow this without limit.
    if (blockListCache.size > 64) {
        blockListCache.clear();
    }
    blockListCache.set(key, list);
    return list;
}

/**
 * `true` when `ip` is one of `cidrs` - exact addresses or CIDR ranges, IPv4 (`10.0.0.0/8`) or IPv6 (`fc00::/7`).
 * IPv4-mapped IPv6 addresses match their IPv4 form. Malformed entries are ignored; a malformed `ip` never matches.
 */
export function isIpInCidrs(ip: string | undefined | null, cidrs: TrustedProxies): boolean {
    if (!ip) {
        return false;
    }
    const entries: string[] = toEntries(cidrs);
    if (entries.length === 0) {
        return false;
    }
    const address: string = normalizeIp(ip);
    const family: number = net.isIP(address);
    if (!family) {
        return false;
    }
    // `address` has passed `net.isIP()` and the type matches its family, so `BlockList.check()` can't throw here.
    return buildBlockList(entries).check(address, family === 4 ? "ipv4" : "ipv6");
}

function headerValue(req: any, name: string): string | undefined {
    const value: unknown = req?.headers?.[name];
    return Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : undefined;
}

/**
 * The client address of `req`, honoring `trustedProxies` (the `trusted_proxies` config key: exact addresses or CIDR
 * ranges, as an array or a comma-separated string).
 *
 * If the socket peer is not a trusted proxy, forwarding headers are ignored entirely and the peer address is returned -
 * so a direct client can't pick its own address. Otherwise `X-Forwarded-For` is walked right to left (each proxy
 * appends the address it saw), returning the nearest hop that is not itself a trusted proxy; if every hop is trusted,
 * the left-most one. Malformed entries are skipped. Without a usable `X-Forwarded-For`, a valid `X-Real-IP` is used,
 * falling back to the peer address.
 */
export function resolveClientIp(req: any, trustedProxies: TrustedProxies): string | undefined {
    const rawRemote: string | undefined = req?.socket?.remoteAddress ?? req?.connection?.remoteAddress;
    const remote: string | undefined = rawRemote ? normalizeIp(rawRemote) : undefined;
    if (!remote || !isIpInCidrs(remote, trustedProxies)) {
        return remote;
    }
    const forwarded: string[] = (headerValue(req, "x-forwarded-for") ?? "")
        .split(",")
        .map(normalizeIp)
        .filter((address) => net.isIP(address) !== 0);
    for (let i = forwarded.length - 1; i >= 0; i--) {
        if (i === 0 || !isIpInCidrs(forwarded[i], trustedProxies)) {
            return forwarded[i];
        }
    }
    const realIpHeader: string | undefined = headerValue(req, "x-real-ip");
    const realIp: string | undefined = realIpHeader ? normalizeIp(realIpHeader.split(",")[0]) : undefined;
    return realIp && net.isIP(realIp) ? realIp : remote;
}

/** The eight 16-bit groups of a valid IPv6 address (`::` expanded, an embedded dotted IPv4 tail converted), or
 * `undefined` if `address` isn't one. */
function ipv6Groups(address: string): number[] | undefined {
    if (net.isIP(address) !== 6) {
        return undefined;
    }
    let text: string = address.toLowerCase();
    const v4Tail: RegExpMatchArray | null = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
    if (v4Tail) {
        const octets: number[] = v4Tail[2].split(".").map(Number);
        text = `${v4Tail[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
    const headGroups: string[] = head ? head.split(":") : [];
    const tailGroups: string[] = tail ? tail.split(":") : [];
    const missing: number = 8 - headGroups.length - tailGroups.length;
    const groups: string[] = tail === undefined ? headGroups : [...headGroups, ...new Array(missing).fill("0"), ...tailGroups];
    return groups.map((group) => parseInt(group, 16));
}

/**
 * The key a per-client rate limit should count `ip` under: the IPv4 address itself, or - for IPv6 - its `/64` network
 * (`2001:db8:1:2::/64`). A single IPv6 subscriber is routinely handed a whole `/64` (or more), so counting each full
 * address separately lets one client rotate through billions of "different" addresses and never hit a limit.
 * IPv4-mapped IPv6 addresses count as their IPv4 form. Anything that isn't an IP address is returned normalized as-is.
 */
export function rateLimitKeyForIp(ip: string): string {
    const address: string = normalizeIp(ip);
    const groups: number[] | undefined = ipv6Groups(address);
    if (!groups) {
        return address;
    }
    return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}
