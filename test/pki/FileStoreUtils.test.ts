///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real filesystem, no mocking - mirroring the rest of test/pki's convention.
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
    createFileExclusive,
    fsyncDirectory,
    lockKeyForPath,
    readFileIfExists,
    STALE_TEMP_FILE_AGE_MS,
    sweepStaleTempFiles,
    updateJsonFile,
    withLock,
    writeFileAtomic,
} from "../../src/pki/FileStoreUtils.js";

describe("FileStoreUtils Tests", () => {
    let tmpDir: string;

    beforeAll(async () => {
        tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "filestoreutils-test-"));
    });

    afterAll(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    function freshDir(): string {
        return path.join(tmpDir, `case-${Math.random()}`);
    }

    describe("withLock()", () => {
        it("Runs callers with the same key one at a time, in order.", async () => {
            const events: string[] = [];
            const task = (name: string, delayMs: number) =>
                withLock("same-key", async () => {
                    events.push(`start:${name}`);
                    await new Promise((resolve) => setTimeout(resolve, delayMs));
                    events.push(`end:${name}`);
                    return name;
                });

            const results = await Promise.all([task("a", 20), task("b", 1), task("c", 5)]);

            expect(results).toEqual(["a", "b", "c"]);
            expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
        });

        it("A failure propagates to its own caller but doesn't block the next one.", async () => {
            const failing = withLock("failing-key", async () => {
                throw new Error("boom");
            });
            const next = withLock("failing-key", async () => "ok");

            await expect(failing).rejects.toThrow("boom");
            await expect(next).resolves.toBe("ok");
        });

        it("lockKeyForPath() maps two spellings of the same path to the same key.", () => {
            expect(lockKeyForPath(path.join(tmpDir, "a", "..", "b.json"))).toBe(lockKeyForPath(path.join(tmpDir, "b.json")));
        });
    });

    describe("updateJsonFile()", () => {
        it("Never loses an update across many concurrent read-modify-write calls.", async () => {
            const filePath: string = path.join(freshDir(), "store.json");

            await Promise.all(
                Array.from({ length: 25 }, (_, i) =>
                    updateJsonFile<Record<string, number>, void>(filePath, 0o600, async (store) => {
                        // Yield mid-mutation, which is exactly where an unlocked implementation would interleave.
                        await new Promise((resolve) => setImmediate(resolve));
                        store[`k${i}`] = i;
                    }),
                ),
            );

            const store = JSON.parse(await fs.readFile(filePath, "utf-8"));
            expect(Object.keys(store)).toHaveLength(25);
            // No temp files left behind next to the store.
            expect(await fs.readdir(path.dirname(filePath))).toEqual(["store.json"]);
        });

        it("Leaves the file untouched when the mutation throws, and returns the mutation's result otherwise.", async () => {
            const filePath: string = path.join(freshDir(), "store.json");
            await expect(updateJsonFile<Record<string, string>, string>(filePath, 0o600, (s) => ((s.a = "1"), "result"))).resolves.toBe("result");

            await expect(
                updateJsonFile<Record<string, string>, void>(filePath, 0o600, (s) => {
                    s.a = "2";
                    throw new Error("nope");
                }),
            ).rejects.toThrow("nope");

            expect(JSON.parse(await fs.readFile(filePath, "utf-8"))).toEqual({ a: "1" });
        });
    });

    describe("writeFileAtomic()", () => {
        it("Creates the file (and parent directory), then replaces it on a later write.", async () => {
            const filePath: string = path.join(freshDir(), "nested", "file.txt");

            await writeFileAtomic(filePath, "first", 0o600);
            await writeFileAtomic(filePath, "second", 0o600);

            expect(await fs.readFile(filePath, "utf-8")).toBe("second");
            expect(await fs.readdir(path.dirname(filePath))).toEqual(["file.txt"]);
        });

        it("Rethrows a rename failure and cleans up its temp file.", async () => {
            const dir: string = freshDir();
            const filePath: string = path.join(dir, "occupied");
            // A non-empty directory at the target path makes the final rename() fail.
            await fs.mkdir(path.join(filePath, "child"), { recursive: true });

            await expect(writeFileAtomic(filePath, "data", 0o600)).rejects.toThrow();

            expect(await fs.readdir(dir)).toEqual(["occupied"]);
        });
    });

    describe("createFileExclusive()", () => {
        it("Creates a missing file and reports true.", async () => {
            const filePath: string = path.join(freshDir(), "key.pem");

            await expect(createFileExclusive(filePath, "key", 0o600)).resolves.toBe(true);

            expect(await fs.readFile(filePath, "utf-8")).toBe("key");
            expect(await fs.readdir(path.dirname(filePath))).toEqual(["key.pem"]);
        });

        it("Never overwrites an existing file, reports false, and leaves no temp file behind.", async () => {
            const filePath: string = path.join(freshDir(), "key.pem");
            await createFileExclusive(filePath, "winner", 0o600);

            await expect(createFileExclusive(filePath, "loser", 0o600)).resolves.toBe(false);

            expect(await fs.readFile(filePath, "utf-8")).toBe("winner");
            expect(await fs.readdir(path.dirname(filePath))).toEqual(["key.pem"]);
        });

        it("Exactly one of many concurrent creators wins.", async () => {
            const filePath: string = path.join(freshDir(), "key.pem");

            const results: boolean[] = await Promise.all(Array.from({ length: 10 }, (_, i) => createFileExclusive(filePath, `v${i}`, 0o600)));

            expect(results.filter(Boolean)).toHaveLength(1);
            expect(await fs.readFile(filePath, "utf-8")).toBe(`v${results.indexOf(true)}`);
        });
    });

    describe("stale temp files / directory fsync", () => {
        const TEMP_SUFFIX = ".1234.0b8a6c1e-2f3d-4e5f-8a9b-0c1d2e3f4a5b.tmp";

        it("sweepStaleTempFiles() removes only old files matching the temp-name pattern.", async () => {
            const dir: string = freshDir();
            await fs.mkdir(path.join(dir, `subdir${TEMP_SUFFIX}`), { recursive: true });
            const old = new Date(Date.now() - STALE_TEMP_FILE_AGE_MS - 60_000);
            for (const name of [`store.json${TEMP_SUFFIX}`, "store.json", "notes.tmp"]) {
                await fs.writeFile(path.join(dir, name), "x");
                await fs.utimes(path.join(dir, name), old, old);
            }
            await fs.writeFile(path.join(dir, `fresh.json${TEMP_SUFFIX}`), "x");

            await expect(sweepStaleTempFiles(dir)).resolves.toBe(1);

            expect((await fs.readdir(dir)).sort()).toEqual([`fresh.json${TEMP_SUFFIX}`, "notes.tmp", "store.json", `subdir${TEMP_SUFFIX}`].sort());
        });

        it("sweepStaleTempFiles() returns 0 for a missing directory.", async () => {
            await expect(sweepStaleTempFiles(path.join(freshDir(), "missing"))).resolves.toBe(0);
        });

        it("The first write into a directory sweeps abandoned temp files there.", async () => {
            const dir: string = freshDir();
            await fs.mkdir(dir, { recursive: true });
            const abandoned: string = path.join(dir, `ca.json${TEMP_SUFFIX}`);
            await fs.writeFile(abandoned, "torn");
            const old = new Date(Date.now() - STALE_TEMP_FILE_AGE_MS - 60_000);
            await fs.utimes(abandoned, old, old);

            await writeFileAtomic(path.join(dir, "ca.json"), "{}", 0o600);

            expect(await fs.readdir(dir)).toEqual(["ca.json"]);
        });

        it("fsyncDirectory() never throws (existing, missing, or platform-unsupported).", async () => {
            const dir: string = freshDir();
            await fs.mkdir(dir, { recursive: true });
            await expect(fsyncDirectory(dir)).resolves.toBeUndefined();
            await expect(fsyncDirectory(path.join(dir, "missing"))).resolves.toBeUndefined();
        });
    });

    describe("readFileIfExists()", () => {
        it("Returns undefined for a missing file and the contents for an existing one.", async () => {
            const filePath: string = path.join(freshDir(), "f.txt");
            await expect(readFileIfExists(filePath)).resolves.toBeUndefined();

            await writeFileAtomic(filePath, "hello", 0o600);
            await expect(readFileIfExists(filePath)).resolves.toBe("hello");
        });

        it("Rethrows a filesystem error other than ENOENT.", async () => {
            const dirPath: string = freshDir();
            await fs.mkdir(dirPath, { recursive: true });

            await expect(readFileIfExists(dirPath)).rejects.toThrow();
        });
    });
});
