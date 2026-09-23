///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `MailPushRoute` is `@rapidrest/service-core`'s `BasePushRoute` with one change: `connect()` and `send()` hand the base
// class the caller WITHOUT their trusted roles, so a channel is only ever granted by ownership or an explicit ACL record
// (`ACLUtils.hasPermission()` treats a trusted role as a superuser). All the WebSocket protocol behaviour is
// `BasePushRoute`'s own, already covered by that package's test suite; what is tested here is the wiring (this file) and,
// against a real ACL store with a fake Redis, who gets which channel (`MailPushAccess.test.ts`).
import { ApiError } from "@rapidrest/core";
import { BasePushRoute } from "@rapidrest/service-core";
import { MailPushRoute } from "../../src/push/MailPushRoute.js";

describe("MailPushRoute Tests", () => {
    it("Extends BasePushRoute, overriding only connect() and send() to strip the caller's trusted roles.", () => {
        const route = new MailPushRoute();
        expect(route).toBeInstanceOf(BasePushRoute);
        expect(Object.getOwnPropertyNames(MailPushRoute.prototype).sort()).toEqual(["connect", "constructor", "send", "trustedRoles"]);
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
