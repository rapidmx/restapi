///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real filesystem faults for tests of the local blob store: a directory that is there but this process can't reach what is in
// it, as a restore or a uid change leaves one. Windows denies the current user through its ACL (EPERM); POSIX takes its mode away
// (EACCES) - except from root, which every mode lets through, so for root the directory is moved aside and a symbolic link to itself
// left in its place (ELOOP).
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";

/** The error codes a path under a directory `breakDirectory()` broke fails with. */
export const BROKEN_DIRECTORY_CODES: RegExp = /^(EACCES|EPERM|ELOOP)$/;

const asRoot = (): boolean => process.platform !== "win32" && process.getuid?.() === 0;

/** Leaves `dir` in place but unreachable to this process until `restoreDirectory()`. */
export async function breakDirectory(dir: string): Promise<void> {
    if (process.platform === "win32") {
        execFileSync("icacls", [dir, "/deny", `${os.userInfo().username}:(OI)(CI)(F)`], { stdio: "ignore" });
    } else if (asRoot()) {
        await fs.rename(dir, `${dir}.aside`);
        await fs.symlink(dir, dir);
    } else {
        await fs.chmod(dir, 0o000);
    }
}

/** Undoes `breakDirectory()`. */
export async function restoreDirectory(dir: string): Promise<void> {
    if (process.platform === "win32") {
        execFileSync("icacls", [dir, "/remove:d", os.userInfo().username], { stdio: "ignore" });
    } else if (asRoot()) {
        await fs.unlink(dir);
        await fs.rename(`${dir}.aside`, dir);
    } else {
        await fs.chmod(dir, 0o700);
    }
}
