///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { InlineDeliveryCache } from "../../src/util/InlineDeliveryCache.js";

describe("InlineDeliveryCache", () => {
    it("makes a value once per message and key, telling messages apart by identity", async () => {
        const cache = new InlineDeliveryCache();
        const raw = Buffer.from("message");
        const same = Buffer.from("message");
        const make = vi.fn(async () => "scanned");

        expect(await cache.once(raw, "scan", make)).toBe("scanned");
        expect(await cache.once(raw, "scan", make)).toBe("scanned");
        expect(make).toHaveBeenCalledTimes(1);

        await cache.once(raw, "extraction", make);
        await cache.once(same, "scan", make);
        expect(make).toHaveBeenCalledTimes(3);
    });
});
