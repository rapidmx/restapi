///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import * as nodeCrypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Small shared helpers for the PKI adapters' "own a small piece of local state on disk" stores
 * (`LocalX509CertificateAuthority`'s CA key/cert, `Rfc8823AcmeSigningCertificateEnrollment`'s account +
 * enrollment store, `ManualSigningCertificateEnrollment`'s enrollment store, `OpenBaoPkiCertificateAuthority`'s
 * serial map). Internal to `src/pki` - deliberately not exported from the package barrel.
 *
 * **Scope of the guarantees**: `withLock()` serializes callers *within one Node.js process* only. Every write
 * is crash-atomic (a reader, in this process or any other, only ever observes the old or the new complete
 * file, never a torn one), and `createFileExclusive()` is atomic across processes too. `updateJsonFile()` (the
 * read-modify-write every JSON store here goes through) also takes a lock file next to the store (`<file>.lock`, created
 * exclusively, so atomic across processes - replicas sharing a volume), which a crashed holder's leaves behind for at most
 * `STALE_LOCK_AGE_MS`. That makes the update safe across replicas on any filesystem where exclusive create is atomic (local
 * disks, NFSv3 and later), though a store that must survive heavy contention belongs in a database.
 */

/** Tail of the in-process lock chain per key - see `withLock()`. */
const lockTails: Map<string, Promise<void>> = new Map();

/**
 * Runs `fn` exclusively with respect to every other `withLock()` call using the same `key` in this process
 * (FIFO). A failure in `fn` propagates to this call's own caller but never poisons the lock for the next one.
 * Keys that name a file path should be passed through `lockKeyForPath()` so two spellings of the same path
 * share one lock.
 */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous: Promise<void> = lockTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current: Promise<void> = new Promise<void>((resolve) => (release = resolve));
    const tail: Promise<void> = previous.then(() => current);
    lockTails.set(key, tail);
    await previous;
    try {
        return await fn();
    } finally {
        release();
        // Drop the map entry once nobody is queued behind this call, so the map doesn't grow unbounded.
        if (lockTails.get(key) === tail) {
            lockTails.delete(key);
        }
    }
}

/** A lock file older than this is taken to be a crashed holder's and is removed - far longer than any store update takes. */
export const STALE_LOCK_AGE_MS = 20_000;
/** How long `withFileLock()` waits for another process's lock before giving up. */
const FILE_LOCK_WAIT_MS = 25_000;
const FILE_LOCK_RETRY_MS = 25;

/**
 * Runs `fn` while holding `<filePath>.lock`, an exclusively created file (so atomic across processes, unlike `withLock()`, which only
 * serializes within one). Another process's lock is waited for (retrying every 25 ms, up to 25 s) and removed once it is older than
 * `STALE_LOCK_AGE_MS`. Throws if the lock can't be had in time. Callers hold the in-process `withLock()` first, so at most one caller per
 * process is ever waiting here.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>, dirMode: number = 0o700): Promise<T> {
    const lockPath: string = `${filePath}.lock`;
    const deadline: number = Date.now() + FILE_LOCK_WAIT_MS;
    for (;;) {
        if (await createFileExclusive(lockPath, `${process.pid}`, 0o600, dirMode)) {
            break;
        }
        try {
            if (Date.now() - (await fs.stat(lockPath)).mtimeMs > STALE_LOCK_AGE_MS) {
                await fs.rm(lockPath, { force: true });
                continue;
            }
        } catch {
            /* v8 ignore start -- only reachable when the holder releases the lock in the instant between the two calls. */
            // Released between the two calls: try to take it again.
            continue;
            /* v8 ignore stop */
        }
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for the lock on ${path.basename(filePath)}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_RETRY_MS));
    }
    try {
        return await fn();
    } finally {
        await fs.rm(lockPath, { force: true });
    }
}

/** The canonical `withLock()` key for a file path. */
export function lockKeyForPath(filePath: string): string {
    return path.resolve(filePath);
}

/** Temp files older than this are considered abandoned (a crash between write and rename/link) - see
 * `sweepStaleTempFiles()`. Far longer than any legitimate write takes, so another live process's in-flight temp
 * file is never removed. */
export const STALE_TEMP_FILE_AGE_MS = 60 * 60 * 1000;

/** Matches the temp names `writeTempFile()` generates: `<name>.<pid>.<uuid>.tmp`. */
const TEMP_FILE_PATTERN = /\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i;

/** Directories already swept by this process - see `sweepStaleTempFilesOnce()`. */
const sweptDirectories: Set<string> = new Set();

/**
 * Best-effort removal of abandoned `writeTempFile()` temp files in `dir` whose mtime is older than `maxAgeMs`.
 * Never throws; returns how many were removed.
 */
export async function sweepStaleTempFiles(dir: string, maxAgeMs: number = STALE_TEMP_FILE_AGE_MS): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
        names = await fs.readdir(dir);
    } catch {
        return 0;
    }
    const cutoff: number = Date.now() - maxAgeMs;
    for (const name of names) {
        if (!TEMP_FILE_PATTERN.test(name)) {
            continue;
        }
        const tempPath: string = path.join(dir, name);
        try {
            const stat = await fs.stat(tempPath);
            if (stat.isFile() && stat.mtimeMs < cutoff) {
                await fs.rm(tempPath, { force: true });
                removed++;
            }
        } catch {
            // Raced with another sweeper/writer, or unreadable - leave it.
        }
    }
    return removed;
}

/** Sweeps `dir` for stale temp files on this process's first write into it. */
async function sweepStaleTempFilesOnce(dir: string): Promise<void> {
    const key: string = path.resolve(dir);
    if (sweptDirectories.has(key)) {
        return;
    }
    sweptDirectories.add(key);
    await sweepStaleTempFiles(key);
}

/**
 * Best-effort `fsync()` of a directory, so a just-completed `rename()`/`link()` inside it survives a power loss.
 * Never throws: platforms that can't fsync a directory (Windows reports `EPERM`/`EISDIR`, some filesystems
 * `EINVAL`) simply keep the weaker guarantee.
 */
export async function fsyncDirectory(dir: string): Promise<void> {
    try {
        const handle: fs.FileHandle = await fs.open(dir, "r");
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch {
        // Best-effort only - see above.
    }
}

/** Writes `data` to a fresh, uniquely-named temp file next to `filePath` and fsyncs it. */
async function writeTempFile(filePath: string, data: string | Buffer, mode: number): Promise<string> {
    await sweepStaleTempFilesOnce(path.dirname(filePath));
    const tempPath: string = `${filePath}.${process.pid}.${nodeCrypto.randomUUID()}.tmp`;
    const handle = await fs.open(tempPath, "wx", mode);
    try {
        await handle.writeFile(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
    return tempPath;
}

/**
 * Atomically replaces (or creates) `filePath` with `data`: write a temp file in the same directory, then
 * `rename()` it over the target, then (best-effort) fsync the directory so the rename itself is durable. Creates the parent directory (`dirMode` only applies on first creation).
 */
export async function writeFileAtomic(filePath: string, data: string | Buffer, mode: number, dirMode: number = 0o700): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: dirMode });
    const tempPath: string = await writeTempFile(filePath, data, mode);
    try {
        await fs.rename(tempPath, filePath);
    } catch (err) {
        await fs.rm(tempPath, { force: true });
        throw err;
    }
    await fsyncDirectory(path.dirname(filePath));
}

/**
 * Atomically creates `filePath` with `data` only if it doesn't already exist - never overwrites, and never
 * leaves a partially-written `filePath` behind on a crash. Implemented as temp file + `link()` (which fails
 * with `EEXIST` atomically, across processes) + unlink of the temp name.
 *
 * @returns `true` if this call created the file, `false` if it already existed.
 */
export async function createFileExclusive(filePath: string, data: string | Buffer, mode: number, dirMode: number = 0o700): Promise<boolean> {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: dirMode });
    const tempPath: string = await writeTempFile(filePath, data, mode);
    try {
        await fs.link(tempPath, filePath);
        await fsyncDirectory(path.dirname(filePath));
        return true;
    } catch (err: any) {
        if (err.code === "EEXIST") {
            return false;
        }
        /* v8 ignore start -- only reachable on a filesystem without hard-link support, not reproducible
           against the test suite's own real temp directory. */
        if (err.code === "EPERM" || err.code === "ENOTSUP" || err.code === "EOPNOTSUPP" || err.code === "ENOSYS") {
            // No hard links on this filesystem - fall back to an exclusive create. Still never overwrites an
            // existing file; only loses crash-atomicity of the very first write on such filesystems.
            try {
                await fs.writeFile(filePath, data, { mode, flag: "wx" });
                return true;
            } catch (fallbackErr: any) {
                if (fallbackErr.code === "EEXIST") {
                    return false;
                }
                throw fallbackErr;
            }
        }
        throw err;
        /* v8 ignore stop */
    } finally {
        await fs.rm(tempPath, { force: true });
    }
}

/** Reads `filePath` as UTF-8, returning `undefined` (rather than throwing) only when it doesn't exist. */
export async function readFileIfExists(filePath: string): Promise<string | undefined> {
    try {
        return await fs.readFile(filePath, "utf-8");
    } catch (err: any) {
        if (err.code === "ENOENT") {
            return undefined;
        }
        throw err;
    }
}

/**
 * Locked read-modify-write of a JSON object file: under `withLock()` for the file's path, re-reads the current
 * contents (`{}` if absent), passes them to `mutate`, and - if `mutate` resolves without throwing - atomically
 * writes the (possibly modified) object back. Returns whatever `mutate` returns. A throw from `mutate` leaves
 * the file untouched.
 */
export async function updateJsonFile<S extends object, T>(
    filePath: string,
    mode: number,
    mutate: (store: S) => Promise<T> | T,
    dirMode: number = 0o700,
): Promise<T> {
    return withLock(lockKeyForPath(filePath), () =>
        withFileLock(
            filePath,
            async () => {
                const raw: string | undefined = await readFileIfExists(filePath);
                const store: S = raw === undefined ? ({} as S) : JSON.parse(raw);
                const result: T = await mutate(store);
                await writeFileAtomic(filePath, JSON.stringify(store), mode, dirMode);
                return result;
            },
            dirMode,
        ),
    );
}
