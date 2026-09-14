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
});
