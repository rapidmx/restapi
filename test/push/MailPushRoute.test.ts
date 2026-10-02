///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `MailPushRoute` is `@rapidrest/service-core`'s `BasePushRoute` with one change: `connect()` and `send()` hand the base
// class the caller WITHOUT their trusted roles, so a channel is only ever granted by ownership or an explicit ACL record
// (`ACLUtils.hasPermission()` treats a trusted role as a superuser). All the WebSocket protocol behaviour is
// `BasePushRoute`'s own, already covered by that package's test suite; what is tested here is the wiring (this file) and,
// against a real ACL store with a fake Redis, who gets which channel (`MailPushAccess.test.ts`).
import { EventEmitter } from "events";
import { ApiError } from "@rapidrest/core";
import { BasePushRoute } from "@rapidrest/service-core";
import { MailPushRoute } from "../../src/push/MailPushRoute.js";

describe("MailPushRoute Tests", () => {
    it("Extends BasePushRoute, overriding only connect() and send() to strip the caller's trusted roles.", () => {
        const route = new MailPushRoute();
        expect(route).toBeInstanceOf(BasePushRoute);
        // The two entry points, plus the origin check and the access recheck connect() adds to them.
        expect(Object.getOwnPropertyNames(MailPushRoute.prototype).sort()).toEqual([
            "connect",
            "constructor",
            "corsOrigins",
            "isOriginAllowed",
            "recheckAccess",
            "recheckMs",
            "send",
            "trustedRoles",
            "watchAccess",
        ]);
    });

    describe("origin", () => {
        it.each([
            [undefined, "https://evil.example", true],
            ["*", "https://evil.example", true],
            [["https://mail.example"], undefined, true],
            [["https://mail.example"], "https://mail.example", true],
            [["https://mail.example"], "https://evil.example", false],
            ["https://mail.example", "https://mail.example", true],
            ["https://mail.example", "https://evil.example", false],
        ])("With cors:origins %j, a connection from %j is allowed: %j.", (origins, origin, allowed) => {
            const route: any = new MailPushRoute();
            route.corsOrigins = origins;
            expect(route.isOriginAllowed(origin)).toBe(allowed);
        });

        it("Closes a connection from an origin that is not allowed without ever reaching the base class.", async () => {
            const route: any = new MailPushRoute();
            route.corsOrigins = ["https://mail.example"];
            const connect = vi.spyOn(BasePushRoute.prototype, "connect").mockResolvedValue(undefined);
            const sock = { close: vi.fn(), on: vi.fn() };
            await route.connect(sock, { uid: "u1", roles: [], elevated: -1, scopes: [] }, { headers: { origin: "https://evil.example" } });
            expect(sock.close).toHaveBeenCalledWith(1008, expect.any(String));
            expect(connect).not.toHaveBeenCalled();
            await route.connect(sock, { uid: "u1", roles: [], elevated: -1, scopes: [] }, { headers: { origin: "https://mail.example" } });
            expect(connect).toHaveBeenCalledTimes(1);
            // Without a user there is nothing to watch.
            sock.on.mockClear();
            await route.connect(sock, undefined);
            expect(sock.on).not.toHaveBeenCalled();
            connect.mockRestore();
        });
    });

    describe("access recheck", () => {
        const user = { uid: "u1", roles: [], elevated: -1, scopes: [] };
        const sockOf = () => Object.assign(new EventEmitter(), { readyState: 1, close: vi.fn() });

        it("Is off when recheck_ms is 0, and for a socket that cannot be listened to.", () => {
            const route: any = new MailPushRoute();
            route.recheckMs = 0;
            const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
            route.watchAccess(sockOf(), user);
            route.recheckMs = 50;
            route.watchAccess({}, user);
            expect(setIntervalSpy).not.toHaveBeenCalled();
            setIntervalSpy.mockRestore();
        });

        it("Closes a socket whose user lost a channel, whose token expired, and stops watching a closed one.", async () => {
            const route: any = new MailPushRoute();
            const hasPermission = vi.fn().mockImplementation(async (_user: any, channel: string) => channel !== "revoked");
            route.aclUtils = { hasPermission };
            route.activeSubs = new Map([["u1", ["u1", "kept", "revoked"]]]);

            const still = sockOf();
            await expect(route.recheckAccess(still, user)).resolves.toBe(false);
            expect(still.close).toHaveBeenCalledWith(1008, expect.stringContaining("removed"));
            expect(hasPermission).not.toHaveBeenCalledWith(user, "u1", expect.anything());

            route.activeSubs = new Map([["u1", ["u1", "kept"]]]);
            const fine = sockOf();
            await expect(route.recheckAccess(fine, user)).resolves.toBe(true);
            expect(fine.close).not.toHaveBeenCalled();
            // A failing check is not a loss: it is asked again next round. No subscriptions at all is fine too.
            hasPermission.mockRejectedValueOnce(new Error("db down"));
            await expect(route.recheckAccess(fine, user)).resolves.toBe(true);
            route.activeSubs = new Map();
            await expect(route.recheckAccess(fine, user)).resolves.toBe(true);
            route.aclUtils = undefined;
            route.activeSubs = new Map([["u1", ["kept"]]]);
            await expect(route.recheckAccess(fine, user)).resolves.toBe(false);

            const expired = sockOf();
            await expect(route.recheckAccess(expired, { ...user, exp: Math.floor(Date.now() / 1000) - 5 })).resolves.toBe(false);
            expect(expired.close).toHaveBeenCalledWith(1008, expect.stringContaining("expired"));

            const closed = Object.assign(sockOf(), { readyState: 3 });
            await expect(route.recheckAccess(closed, user)).resolves.toBe(false);
            expect(closed.close).not.toHaveBeenCalled();
        });

        it("Rechecks on a timer for as long as the socket is open, and stops once it has been closed here or by the client.", async () => {
            vi.useFakeTimers();
            try {
                const route: any = new MailPushRoute();
                route.recheckMs = 100;
                route.aclUtils = { hasPermission: vi.fn().mockResolvedValue(false) };
                route.activeSubs = new Map([["u1", ["u1", "gone"]]]);
                const sock = sockOf();
                route.watchAccess(sock, user);
                await vi.advanceTimersByTimeAsync(250);
                expect(sock.close).toHaveBeenCalledTimes(1);

                const other = sockOf();
                route.watchAccess(other, user);
                other.emit("close");
                await vi.advanceTimersByTimeAsync(250);
                expect(other.close).not.toHaveBeenCalled();
            } finally {
                vi.useRealTimers();
            }
        });
    });

    it("Hands the base class the caller without their trusted roles, for a connection and for a publish.", async () => {
        const route = new MailPushRoute();
        const connect = vi.spyOn(BasePushRoute.prototype, "connect").mockResolvedValue(undefined);
        const send = vi.spyOn(BasePushRoute.prototype, "send").mockResolvedValue(undefined);
        const admin = { uid: "u1", roles: ["admin", "support"], elevated: 5, scopes: [] };

        await route.connect({} as any, admin);
        await route.send("channel", { x: 1 }, admin);

        expect(connect).toHaveBeenCalledWith({}, { uid: "u1", roles: ["support"], elevated: -1, scopes: [] });
        expect(send).toHaveBeenCalledWith("channel", { x: 1 }, { uid: "u1", roles: ["support"], elevated: -1, scopes: [] });
        connect.mockRestore();
        send.mockRestore();
    });

    describe("send() rejects a message whose own 'from' field claims a different identity than the authenticated caller", () => {
        it("Passes a message with no 'from' field through unchanged - this check must never break a legitimate use that doesn't rely on it.", async () => {
            const route = new MailPushRoute();
            const send = vi.spyOn(BasePushRoute.prototype, "send").mockResolvedValue(undefined);
            const user = { uid: "u1", roles: [], elevated: -1, scopes: [] };

            await route.send("channel", { type: "video-meeting-signal", kind: "bye" }, user);

            expect(send).toHaveBeenCalledWith("channel", { type: "video-meeting-signal", kind: "bye" }, user);
            send.mockRestore();
        });

        it("Passes a message whose 'from' field matches the caller's own uid through unchanged.", async () => {
            const route = new MailPushRoute();
            const send = vi.spyOn(BasePushRoute.prototype, "send").mockResolvedValue(undefined);
            const user = { uid: "u1", roles: [], elevated: -1, scopes: [] };

            await route.send("channel", { type: "video-meeting-signal", kind: "bye", from: "u1" }, user);

            expect(send).toHaveBeenCalledWith("channel", { type: "video-meeting-signal", kind: "bye", from: "u1" }, user);
            send.mockRestore();
        });

        it("Rejects (400) a message whose 'from' field claims a DIFFERENT uid than the authenticated caller, never forwarding it to the base class at all - the WebRTC-signaling forgery this exists to close.", async () => {
            const route = new MailPushRoute();
            const send = vi.spyOn(BasePushRoute.prototype, "send").mockResolvedValue(undefined);
            const attacker = { uid: "attacker-uid", roles: [], elevated: -1, scopes: [] };

            await expect(
                route.send("meeting-channel", { type: "video-meeting-signal", kind: "bye", from: "victim-uid" }, attacker),
            ).rejects.toThrow(ApiError);
            await expect(
                route.send("meeting-channel", { type: "video-meeting-signal", kind: "bye", from: "victim-uid" }, attacker),
            ).rejects.toMatchObject({ status: 400 });
            expect(send).not.toHaveBeenCalled();
            send.mockRestore();
        });

        it("Rejects a forged 'from' even for an unauthenticated/no-user caller, rather than only checking once a real uid is known.", async () => {
            const route = new MailPushRoute();
            const send = vi.spyOn(BasePushRoute.prototype, "send").mockResolvedValue(undefined);

            await expect(route.send("channel", { from: "victim-uid" }, undefined)).rejects.toThrow(ApiError);
            expect(send).not.toHaveBeenCalled();
            send.mockRestore();
        });
    });
});
