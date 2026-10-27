///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { notifyDnsPublisher, resolveDnsPublisher, type DnsPublisher } from "../../src/dns/DnsPublisher.js";
import { NullDnsPublisher } from "../../src/dns/NullDnsPublisher.js";

describe("DnsPublisher", () => {
    describe("NullDnsPublisher", () => {
        it("accepts changes, stays at version 0, and answers a long poll only when it times out or is abandoned", async () => {
            const publisher = new NullDnsPublisher();
            await publisher.changed({ scope: "all" });
            expect(await publisher.version()).toBe(0);

            const started: number = Date.now();
            expect(await publisher.waitForChange(0, 30)).toBe(0);
            expect(Date.now() - started).toBeGreaterThanOrEqual(25);

            const abort = new AbortController();
            const waiting: Promise<number> = publisher.waitForChange(0, 60_000, abort.signal);
            abort.abort();
            expect(await waiting).toBe(0);
            expect(await publisher.waitForChange(0, 60_000, AbortSignal.abort())).toBe(0);
        });
    });

    describe("notifyDnsPublisher()", () => {
        it("passes the change on, and logs instead of failing when the publisher does", async () => {
            const changed = vi.fn().mockResolvedValue(undefined);
            await notifyDnsPublisher({ changed } as any, { scope: "domain", domainUid: "example.com" });
            expect(changed).toHaveBeenCalledWith({ scope: "domain", domainUid: "example.com" });

            const logger = { warn: vi.fn() };
            await expect(notifyDnsPublisher({ changed: vi.fn().mockRejectedValue(new Error("redis down")) } as any, { scope: "all" }, logger)).resolves.toBeUndefined();
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("redis down"));
            await expect(notifyDnsPublisher(undefined, { scope: "all" })).resolves.toBeUndefined();
        });
    });

    describe("resolveDnsPublisher()", () => {
        it("uses the publisher the server registered", async () => {
            const registered = { changed: vi.fn() } as unknown as DnsPublisher;
            const objectFactory = { newInstance: vi.fn().mockResolvedValue(registered) };
            expect(await resolveDnsPublisher(objectFactory)).toBe(registered);
            expect(objectFactory.newInstance).toHaveBeenCalledWith("DnsPublisher", { name: "default" });
        });

        it("falls back to NullDnsPublisher, with a warning, on a server that registers none", async () => {
            const logger = { warn: vi.fn() };
            const objectFactory = {
                newInstance: vi.fn(() => {
                    throw new Error("No class found with name: DnsPublisher");
                }),
            };
            expect(await resolveDnsPublisher(objectFactory, logger)).toBeInstanceOf(NullDnsPublisher);
            expect(logger.warn).toHaveBeenCalled();
            expect(await resolveDnsPublisher(undefined)).toBeInstanceOf(NullDnsPublisher);
        });
    });
});
