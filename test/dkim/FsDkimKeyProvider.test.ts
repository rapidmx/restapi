///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Pure unit tests for FsDkimKeyProvider - real filesystem I/O against an isolated temp directory (no
// mocking needed since this adapter *is* the filesystem boundary), mirroring
// test/blob/LocalFsBlobStore.test.ts's own convention for the same reason.
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { FsDkimKeyProvider } from "../../src/dkim/FsDkimKeyProvider.js";
import { DkimKeyPair } from "../../src/dkim/DkimKeyProvider.js";

describe("FsDkimKeyProvider Tests", () => {
    let tmpDir: string;
    let provider: FsDkimKeyProvider;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "fsdkimkeyprovider-test-"));
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        provider = new FsDkimKeyProvider();
        (provider as any).keyDir = tmpDir;
        (provider as any).selector = "mail";
    });

    it("Generates a new key pair and writes it to <key_dir>/<domain>.<selector>.key.", async () => {
        const result: DkimKeyPair = await provider.ensureKeyPair("example.com");

        expect(result.selector).toBe("mail");
        expect(result.publicKey.length).toBeGreaterThan(0);

        const filePath: string = path.join(tmpDir, "example.com.mail.key");
        const pem: string = await fs.readFile(filePath, "utf-8");
        expect(pem).toContain("BEGIN PRIVATE KEY");

        // The returned publicKey must actually be derivable from the persisted private key - i.e. this is
        // the real key pair, not an unrelated placeholder.
        const derivedPublicKey: string = crypto
            .createPublicKey(pem)
            .export({ type: "spki", format: "der" })
            .toString("base64");
        expect(result.publicKey).toBe(derivedPublicKey);
    });

    it("Is idempotent - a second call returns the same key pair without regenerating it.", async () => {
        const first: DkimKeyPair = await provider.ensureKeyPair("idempotent.example.com");
        const filePath: string = path.join(tmpDir, "idempotent.example.com.mail.key");
        const pemAfterFirst: string = await fs.readFile(filePath, "utf-8");

        const second: DkimKeyPair = await provider.ensureKeyPair("idempotent.example.com");
        const pemAfterSecond: string = await fs.readFile(filePath, "utf-8");

        expect(second.publicKey).toBe(first.publicKey);
        expect(pemAfterSecond).toBe(pemAfterFirst);
    });

    it("Concurrent first calls for the same domain all return the single key that was persisted (losers re-read the winner's).", async () => {
        const providers = Array.from({ length: 5 }, () => {
            const p = new FsDkimKeyProvider();
            (p as any).keyDir = tmpDir;
            (p as any).selector = "mail";
            return p;
        });
        const info = vi.fn();
        providers.forEach((p) => ((p as any).logger = { info }));

        const results: DkimKeyPair[] = await Promise.all(providers.map((p) => p.ensureKeyPair("concurrent.example.com")));

        const pem: string = await fs.readFile(path.join(tmpDir, "concurrent.example.com.mail.key"), "utf-8");
        const persisted: string = crypto.createPublicKey(pem).export({ type: "spki", format: "der" }).toString("base64");
        expect(results.map((r) => r.publicKey)).toEqual(Array(5).fill(persisted));
        // Exactly one caller generated-and-persisted; everyone else lost the exclusive create.
        expect(info).toHaveBeenCalledTimes(1);
        expect((await fs.readdir(tmpDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("Rethrows a filesystem error other than ENOENT while reading an existing key.", async () => {
        const filePath: string = path.join(tmpDir, "dir-not-file.mail.key");
        await fs.mkdir(filePath, { recursive: true });

        await expect(provider.ensureKeyPair("dir-not-file")).rejects.toThrow();

        await fs.rm(filePath, { recursive: true, force: true });
    });

    it("Sanitizes a domain name containing path separators to a single path-safe segment.", async () => {
        await provider.ensureKeyPair("a/b\\c");

        const filePath: string = path.join(tmpDir, "a_b_c.mail.key");
        await expect(fs.access(filePath)).resolves.toBeUndefined();
    });

    it("Creates key_dir if it doesn't exist yet.", async () => {
        const nestedDir: string = path.join(tmpDir, "nested", "dkim");
        provider = new FsDkimKeyProvider();
        (provider as any).keyDir = nestedDir;

        await provider.ensureKeyPair("nested.example.com");

        await expect(fs.access(path.join(nestedDir, "nested.example.com.mail.key"))).resolves.toBeUndefined();
    });
    describe("rotation", () => {
        const publicKeyOf = (pem: string): string => crypto.createPublicKey(pem).export({ type: "spki", format: "der" }).toString("base64");

        it("Supports rotation.", () => {
            expect(provider.supportsRotation).toBe(true);
        });

        it("generateKeyPair() creates a key for a new selector without changing the one ensureKeyPair() signs with.", async () => {
            const active: DkimKeyPair = await provider.ensureKeyPair("rotate.example.com");
            const next: DkimKeyPair = await provider.generateKeyPair("rotate.example.com", "rmx20261027");

            expect(next.selector).toBe("rmx20261027");
            expect(next.publicKey).not.toBe(active.publicKey);
            const pem: string = await fs.readFile(path.join(tmpDir, "rotate.example.com.rmx20261027.key"), "utf-8");
            expect(publicKeyOf(pem)).toBe(next.publicKey);
            expect(await provider.ensureKeyPair("rotate.example.com")).toEqual(active);
            // Idempotent: the same selector again returns the same key.
            expect(await provider.generateKeyPair("rotate.example.com", "rmx20261027")).toEqual(next);
        });

        const modulusLength = (pair: DkimKeyPair): number | undefined =>
            crypto.createPublicKey({ key: Buffer.from(pair.publicKey, "base64"), format: "der", type: "spki" }).asymmetricKeyDetails?.modulusLength;

        it("Generates a key of the configured size (mail:dkim:rotation:key_bits), also given as text.", async () => {
            (provider as any).keyBits = 3072;
            expect(modulusLength(await provider.generateKeyPair("bits.example.com", "rmx20261027"))).toBe(3072);
            (provider as any).keyBits = "3072";
            expect(modulusLength(await provider.ensureKeyPair("bits-text.example.com"))).toBe(3072);
        });

        it("Uses 2048 bits, with a warning, for a key size that is too weak, too large for a TXT record or not a number.", async () => {
            const warn = vi.fn();
            (provider as any).logger = { warn, info: vi.fn() };
            for (const [i, keyBits] of [1024, 8192, "big", 2048.5].entries()) {
                (provider as any).keyBits = keyBits;
                expect(modulusLength(await provider.generateKeyPair("weak.example.com", `rmx2026102${i}`))).toBe(2048);
            }
            expect(warn).toHaveBeenCalledTimes(4);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("mail:dkim:rotation:key_bits"));
        });

        it("Generates keys off the event loop, so the server keeps answering while a large key is made.", async () => {
            (provider as any).keyBits = 4096;
            let last: number = Date.now();
            let longestGap: number = 0;
            const timer = setInterval(() => {
                const now: number = Date.now();
                longestGap = Math.max(longestGap, now - last);
                last = now;
            }, 2);
            const started: number = Date.now();
            try {
                await provider.generateKeyPair("async.example.com", "rmx20261027");
            } finally {
                clearInterval(timer);
            }
            // A synchronous generation blocks the timer for the whole of it.
            expect(longestGap).toBeLessThan((Date.now() - started) / 2);
        });

        it("Refuses a selector that isn't one lowercase DNS label.", async () => {
            for (const selector of ["", "Upper", "a.b", "../x", "-x", "x".repeat(64), 5 as any]) {
                await expect(provider.generateKeyPair("bad.example.com", selector)).rejects.toThrow("one DNS label");
                await expect(provider.findKeyPair("bad.example.com", selector)).rejects.toThrow("one DNS label");
                await expect(provider.activate("bad.example.com", selector)).rejects.toThrow("one DNS label");
                await expect(provider.deleteKeyPair("bad.example.com", selector)).rejects.toThrow("one DNS label");
            }
        });

        it("findKeyPair() reads a selector's key without creating one.", async () => {
            expect(await provider.findKeyPair("find.example.com", "mail")).toBeUndefined();
            await expect(fs.access(path.join(tmpDir, "find.example.com.mail.key"))).rejects.toThrow();

            const created: DkimKeyPair = await provider.ensureKeyPair("find.example.com");
            expect(await provider.findKeyPair("find.example.com", "mail")).toEqual(created);
        });

        it("activate() writes <domain>.selector atomically, after which ensureKeyPair() returns that selector's key.", async () => {
            await provider.ensureKeyPair("activate.example.com");
            const next: DkimKeyPair = await provider.generateKeyPair("activate.example.com", "rmx20261027");

            await provider.activate("activate.example.com", "rmx20261027");

            expect(await fs.readFile(path.join(tmpDir, "activate.example.com.selector"), "utf-8")).toBe("rmx20261027\n");
            expect(await provider.ensureKeyPair("activate.example.com")).toEqual(next);
            expect((await fs.readdir(tmpDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
            // Idempotent.
            await provider.activate("activate.example.com", "rmx20261027");
            expect(await fs.readFile(path.join(tmpDir, "activate.example.com.selector"), "utf-8")).toBe("rmx20261027\n");
        });

        it("activate() refuses a selector that has no key, leaving the signing selector alone.", async () => {
            await expect(provider.activate("nokey.example.com", "rmx20261027")).rejects.toThrow("no DKIM key");
            await expect(fs.access(path.join(tmpDir, "nokey.example.com.selector"))).rejects.toThrow();
        });

        it("Ignores a <domain>.selector that isn't a valid selector, signing with the global one.", async () => {
            await fs.writeFile(path.join(tmpDir, "garbled.example.com.selector"), "../../etc/passwd\n");
            expect((await provider.ensureKeyPair("garbled.example.com")).selector).toBe("mail");
            await fs.writeFile(path.join(tmpDir, "empty.example.com.selector"), "\n");
            expect((await provider.ensureKeyPair("empty.example.com")).selector).toBe("mail");
        });

        it("signingSelector() reads what the MTA wrote to <domain>.signing, and nothing when it wrote nothing valid.", async () => {
            expect(await provider.signingSelector("ack.example.com")).toBeUndefined();
            await fs.writeFile(path.join(tmpDir, "ack.example.com.signing"), "rmx20261027\n");
            expect(await provider.signingSelector("ack.example.com")).toBe("rmx20261027");
            await fs.writeFile(path.join(tmpDir, "ack.example.com.signing"), "not a selector");
            expect(await provider.signingSelector("ack.example.com")).toBeUndefined();
            await fs.writeFile(path.join(tmpDir, "ack.example.com.signing"), "");
            expect(await provider.signingSelector("ack.example.com")).toBeUndefined();
        });

        it("deleteKeyPair() deletes a retired selector's key, resolves when it is already gone, and refuses the selector signing uses.", async () => {
            await provider.ensureKeyPair("retire.example.com");
            await provider.generateKeyPair("retire.example.com", "rmx20261027");
            await provider.activate("retire.example.com", "rmx20261027");

            await expect(provider.deleteKeyPair("retire.example.com", "rmx20261027")).rejects.toThrow("signed with");
            await provider.deleteKeyPair("retire.example.com", "mail");
            await expect(fs.access(path.join(tmpDir, "retire.example.com.mail.key"))).rejects.toThrow();
            await expect(provider.deleteKeyPair("retire.example.com", "mail")).resolves.toBeUndefined();
            expect(await provider.findKeyPair("retire.example.com", "rmx20261027")).toBeDefined();
        });

        it("deleteKeyPair() refuses the global selector while no rotation has activated another.", async () => {
            await provider.ensureKeyPair("global.example.com");
            await expect(provider.deleteKeyPair("global.example.com", "mail")).rejects.toThrow("signed with");
        });
    });
});
