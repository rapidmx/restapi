///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////

/**
 * Tells a blob that is gone for good from one a store only can't see right now. `BlobStore.exists()` answers `false` whenever nothing
 * is at the key, but a whole store can look empty for a while: a local blob volume that failed to mount leaves an empty mount-point
 * directory (or the configured root is missing), and every key under it is then a genuine "not found" the filesystem can't tell from a
 * lost blob. A job that acts on "gone" - lowering a quota figure, giving up on sealing a body, dropping a contact's photo - asks here
 * first: a key counts as gone only once it has been seen missing for `windowMs`, so an outage shorter than that changes nothing.
 *
 * Kept in memory, per job instance: a restart starts the wait over, which only delays acting on a lost blob, never acts sooner. A
 * caller that reads a key after all calls `forget()`, so a later loss waits again. At `capacity` keys the ones not seen for a window
 * are dropped; a key that still doesn't fit is reported as not gone yet.
 */
export class GoneBlobConfirmations {
    /** The clock, replaceable in tests. */
    public now: () => number = () => Date.now();

    private readonly seen: Map<string, { first: number; last: number }> = new Map();
    private lastPrune: number = 0;

    /**
     * @param windowMs How long a key must have been seen missing before it counts as gone. `0` or less: at once.
     * @param capacity The most keys remembered at once.
     */
    constructor(
        public windowMs: number,
        private readonly capacity: number = 100_000,
    ) {}

    /** Records that `key` was found missing now, and whether it was first found missing at least `windowMs` ago. */
    public confirmed(key: string): boolean {
        if (!(this.windowMs > 0)) {
            return true;
        }
        const now: number = this.now();
        const entry = this.seen.get(key);
        if (entry) {
            entry.last = now;
            return now - entry.first >= this.windowMs;
        }
        if (this.seen.size >= this.capacity && !this.prune(now)) {
            return false;
        }
        this.seen.set(key, { first: now, last: now });
        return false;
    }

    /** Forgets `key`: it was read after all. */
    public forget(key: string): void {
        this.seen.delete(key);
    }

    /** Drops the keys not seen for a window (at most once a minute); whether there is room now. */
    private prune(now: number): boolean {
        if (now - this.lastPrune >= 60_000) {
            this.lastPrune = now;
            for (const [key, entry] of this.seen) {
                if (now - entry.last > this.windowMs) {
                    this.seen.delete(key);
                }
            }
        }
        return this.seen.size < this.capacity;
    }
}
