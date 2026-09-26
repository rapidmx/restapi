///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for the purge and truncate hooks of BaseScopedChildRoute (`beforePurge()`, `afterPurge()`, `afterTruncate()`,
// `onTruncateRefused()`) and their default no-op implementations, which a route that overrides none of them (Contact, Task, ...) uses. The
// real behaviour of the overriding route (`BaseMessageRoute`) is `test/routes/messagePurgeSuite.ts`.
import config from "../config.js";
import { ObjectFactory } from "@rapidrest/service-core";
import { Logger } from "@rapidrest/core";
import { BaseScopedChildRoute } from "../../src/routes/BaseScopedChildRoute.js";

class HookRoute extends BaseScopedChildRoute<any> {
    protected readonly scopeProperty = "folderUid";
    public held: boolean = false;
    public calls: string[] = [];

    protected async checkLegalHold(existing: any, user?: any): Promise<void> {
        this.calls.push(`hold:${existing.uid}:${user?.uid}`);
        if (this.held) {
            throw new Error("held");
        }
    }

    protected async beforePurge(records: any[]): Promise<unknown> {
        this.calls.push(`before:${records.map((r) => r.uid).join(",")}`);
        return { prepared: records.length };
    }

    protected async afterPurge(records: any[], prepared: unknown): Promise<void> {
        this.calls.push(`after:${records.length}:${JSON.stringify(prepared)}`);
    }

    protected async afterTruncate(scopeUid: string, count: number): Promise<void> {
        this.calls.push(`truncated:${scopeUid}:${count}`);
    }

    protected async onTruncateRefused(scopeUid: string, count: number, error: unknown): Promise<void> {
        this.calls.push(`refused:${scopeUid}:${count}:${(error as Error).message}`);
    }
}

/** A route that keeps every default hook. */
class PlainRoute extends BaseScopedChildRoute<any> {
    protected readonly scopeProperty = "folderUid";
    public held: boolean = false;

    protected async checkLegalHold(): Promise<void> {
        if (this.held) {
            throw new Error("held");
        }
    }
}

describe("BaseScopedChildRoute purge and truncate hooks Tests", () => {
    const objectFactory: ObjectFactory = new ObjectFactory(config, Logger());
    const user: any = { uid: "user-1" };

    const wire = (route: any, matched: any[]): { truncate: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> } => {
        const truncate = vi.fn().mockResolvedValue(undefined);
        const del = vi.fn().mockResolvedValue(undefined);
        route.repoUtils = {
            find: vi.fn().mockResolvedValueOnce(matched).mockResolvedValue([]),
            findOne: vi.fn().mockResolvedValue(matched[0]),
            truncate,
            delete: del,
        };
        route.aclUtils = { hasPermission: vi.fn().mockResolvedValue(true) };
        return { truncate, delete: del };
    };

    it("Runs the hooks around a permanent delete, in order, with the caller and what beforePurge() returned - and not around a soft delete.", async () => {
        const route = objectFactory.newInstance<HookRoute>(HookRoute, { initialize: false });
        wire(route, [{ uid: "msg-1", folderUid: "folder-1" }]);

        await route.delete("msg-1", undefined, "true", {} as any, user);
        await route.delete("msg-1", undefined, undefined, {} as any, user);

        expect(route.calls).toEqual(["hold:msg-1:user-1", "before:msg-1", "after:1:{\"prepared\":1}"]);
    });

    it("Runs them around each truncate batch, then reports the total once.", async () => {
        const route = objectFactory.newInstance<HookRoute>(HookRoute, { initialize: false });
        const matched = Array.from({ length: 501 }, (_, i) => ({ uid: `m${i}`, folderUid: "folder-1" }));
        const { truncate } = wire(route, matched);

        await route.truncate({}, { folderUid: "folder-1" }, user, {} as any);

        expect(truncate).toHaveBeenCalledTimes(2);
        expect(route.calls.filter((call) => !call.startsWith("hold:"))).toEqual([
            `before:${matched.slice(0, 500).map((m) => m.uid).join(",")}`,
            'after:500:{"prepared":500}',
            "before:m500",
            'after:1:{"prepared":1}',
            "truncated:folder-1:501",
        ]);
    });

    it("Reports a refused truncate to onTruncateRefused() and deletes nothing.", async () => {
        const route = objectFactory.newInstance<HookRoute>(HookRoute, { initialize: false });
        route.held = true;
        const { truncate } = wire(route, [{ uid: "m1", folderUid: "folder-1" }]);

        await expect(route.truncate({}, { folderUid: "folder-1" }, user, {} as any)).rejects.toThrow("held");

        expect(truncate).not.toHaveBeenCalled();
        expect(route.calls).toContain("refused:folder-1:1:held");
        expect(route.calls.some((call) => call.startsWith("before:") || call.startsWith("truncated:"))).toBe(false);
    });

    it("Does nothing extra for a route that keeps every default hook.", async () => {
        const route = objectFactory.newInstance<PlainRoute>(PlainRoute, { initialize: false });
        const { truncate, delete: del } = wire(route, [{ uid: "m1", folderUid: "folder-1" }]);

        await route.delete("m1", undefined, "true", {} as any, user);
        await route.truncate({}, { folderUid: "folder-1" }, user);
        route.held = true;
        wire(route, [{ uid: "m1", folderUid: "folder-1" }]);
        await expect(route.truncate({}, { folderUid: "folder-1" }, user)).rejects.toThrow("held");

        expect(del).toHaveBeenCalledTimes(1);
        expect(truncate).toHaveBeenCalledTimes(1);
    });
});
