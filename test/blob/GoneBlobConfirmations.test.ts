///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { GoneBlobConfirmations } from "../../src/blob/GoneBlobConfirmations.js";

describe("GoneBlobConfirmations", () => {
    const HOUR = 3_600_000;

    function confirmations(windowMs: number, capacity?: number) {
        const gone = new GoneBlobConfirmations(windowMs, capacity);
        let now = 1_000_000;
        gone.now = () => now;
        return { gone, advance: (ms: number) => (now += ms) };
    }

    it("confirms at once with no window", () => {
        expect(new GoneBlobConfirmations(0).confirmed("k")).toBe(true);
        expect(new GoneBlobConfirmations(-1).confirmed("k")).toBe(true);
    });

    it("uses the real clock by default", () => {
        const gone = new GoneBlobConfirmations(HOUR);
        expect(gone.confirmed("k")).toBe(false);
        expect(gone.confirmed("k")).toBe(false);
    });

    it("confirms a key only once it has been missing for the window, and starts over once it was read", () => {
        const { gone, advance } = confirmations(HOUR);
        expect(gone.confirmed("k")).toBe(false);
        advance(HOUR - 1);
        expect(gone.confirmed("k")).toBe(false);
        advance(1);
        expect(gone.confirmed("k")).toBe(true);
        // Still gone: stays confirmed.
        advance(HOUR * 5);
        expect(gone.confirmed("k")).toBe(true);
        // Read after all: a later loss waits again.
        gone.forget("k");
        expect(gone.confirmed("k")).toBe(false);
        advance(HOUR);
        expect(gone.confirmed("k")).toBe(true);
    });

    it("when full, drops the keys not seen for a window to make room, and reports a key that still doesn't fit as not gone", () => {
        const { gone, advance } = confirmations(HOUR, 2);
        expect(gone.confirmed("a")).toBe(false);
        expect(gone.confirmed("b")).toBe(false);
        // Full, and both were seen just now: no room, so "c" isn't remembered...
        expect(gone.confirmed("c")).toBe(false);
        advance(HOUR + 1);
        // ...or it would be confirmed now. "a" and "b" weren't seen for a window, so they make room for it.
        expect(gone.confirmed("c")).toBe(false);
        advance(HOUR);
        expect(gone.confirmed("c")).toBe(true);
    });

    it("sweeps for room at most once a minute", () => {
        const { gone, advance } = confirmations(10_000, 1);
        expect(gone.confirmed("a")).toBe(false);
        expect(gone.confirmed("b")).toBe(false);
        // "a" is stale now, but the last sweep was 20s ago.
        advance(20_000);
        expect(gone.confirmed("b")).toBe(false);
        advance(41_000);
        expect(gone.confirmed("b")).toBe(false);
        advance(10_000);
        expect(gone.confirmed("b")).toBe(true);
    });
});
