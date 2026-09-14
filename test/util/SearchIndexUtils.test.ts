///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { describe, expect, it } from "vitest";
import { removeFromSearchIndex } from "../../src/util/SearchIndexUtils.js";

describe("removeFromSearchIndex", () => {
    it("is a no-op without a provider", async () => {
        expect(await removeFromSearchIndex(undefined, "message", ["a"])).toBe(0);
    });

    it("removes every uid, skipping empty ones", async () => {
        const removed: string[] = [];
        const provider: any = { remove: async (type: string, uid: string) => void removed.push(`${type}:${uid}`) };
        expect(await removeFromSearchIndex(provider, "contact", ["a", "", undefined, "b"])).toBe(0);
        expect(removed).toEqual(["contact:a", "contact:b"]);
        await removeFromSearchIndex(provider, "task", "c");
        expect(removed).toEqual(["contact:a", "contact:b", "task:c"]);
    });

    it("keeps going and counts failures without throwing", async () => {
        const removed: string[] = [];
        const warnings: string[] = [];
        const provider: any = {
            remove: async (_type: string, uid: string) => {
                if (uid === "bad") {
                    throw new Error("boom");
                }
                removed.push(uid);
            },
        };
        expect(await removeFromSearchIndex(provider, "message", ["bad", "ok"], { warn: (msg: string) => warnings.push(msg) })).toBe(1);
        expect(removed).toEqual(["ok"]);
        expect(warnings[0]).toContain("message:bad");
    });
});
