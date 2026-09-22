///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `MailPushRoute` is `@rapidrest/service-core`'s `BasePushRoute` with one change: `connect()` and `send()` hand the base
// class the caller WITHOUT their trusted roles, so a channel is only ever granted by ownership or an explicit ACL record
// (`ACLUtils.hasPermission()` treats a trusted role as a superuser). All the WebSocket protocol behaviour is
// `BasePushRoute`'s own, already covered by that package's test suite; what is tested here is the wiring (this file) and,
// against a real ACL store with a fake Redis, who gets which channel (`MailPushAccess.test.ts`).
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
});
