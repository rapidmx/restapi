///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `MailPushRoute` is a thin, no-override subclass of `@rapidrest/service-core`'s `BasePushRoute` - all actual
// WebSocket connect/subscribe/unsubscribe/send protocol behavior is `BasePushRoute`'s own, already covered by
// that package's own extensive test suite (test/routes/PushRoute.test.ts). Re-testing that whole protocol here
// would just duplicate already-proven behavior for a class with no logic of its own - this file only confirms
// the wiring, matching the "thin subclass" test convention used elsewhere in this codebase (e.g.
// ScanQueueJobMongo.test.ts's class-wiring check).
import { BasePushRoute } from "@rapidrest/service-core";
import { MailPushRoute } from "../../src/push/MailPushRoute.js";

describe("MailPushRoute Tests", () => {
    it("Extends BasePushRoute with no overrides.", () => {
        const route = new MailPushRoute();
        expect(route).toBeInstanceOf(BasePushRoute);
        // Own-property check (not inherited) confirms no instance-level override was accidentally introduced.
        expect(Object.getOwnPropertyNames(MailPushRoute.prototype)).toEqual(["constructor"]);
    });
});
