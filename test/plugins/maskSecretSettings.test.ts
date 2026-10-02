///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { isProtectedSettingKey, maskSecretSettings } from "../../src/routes/BasePluginRoute.js";

describe("maskSecretSettings()", () => {
    it("shows a saved secret as { secret: true } and every other setting as it is", () => {
        expect(maskSecretSettings({ "mail:x:api_key": "s3cr3t", "mail:x:token": 0, "mail:x:note": "hi", "mail:x:limit": 5 })).toEqual({
            "mail:x:api_key": { secret: true },
            "mail:x:token": { secret: true },
            "mail:x:note": "hi",
            "mail:x:limit": 5,
        });
    });

    it("leaves a secret with no value as it is, and handles a row with no settings", () => {
        expect(maskSecretSettings({ "mail:x:api_key": null })).toEqual({ "mail:x:api_key": null });
        expect(maskSecretSettings(undefined)).toEqual({});
    });
});

describe("isProtectedSettingKey()", () => {
    it("matches a protected namespace and anything under it, whichever way the separator is spelled", () => {
        for (const key of ["trusted_roles", "auth:secret", "AUTH__SECRET", "mail__escrow__x", "mail:pki:ca", "system:plugins:x", "rateLimit"]) {
            expect(isProtectedSettingKey(key), key).toBe(true);
        }
        for (const key of ["mail:eas:sync_window_size", "authentication", "mail:security_x", "mail:escrowed"]) {
            expect(isProtectedSettingKey(key), key).toBe(false);
        }
    });
});
