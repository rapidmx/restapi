///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `ConfigCipher` reading the active key from the `ConfigKeyState` row (spec 4.9, 5.3), identical on both backends.
import { CONFIG_KEY_STATE_UID, type ConfigKeyring } from "../../src/secrets/ConfigKeyring.js";

export interface ConfigCipherSuiteContext {
    /** A new cipher, as the server builds one at startup, holding `ring` as its inline keyring. */
    newCipher: (ring: ConfigKeyring) => Promise<any>;
    /** Saves the key state row with these fields, replacing what was there. */
    saveState: (fields: Record<string, unknown>) => Promise<void>;
    clearState: () => Promise<void>;
}

const OLD = { kid: "0ld0ld01", key: Buffer.alloc(32, 1).toString("base64"), createdAt: "2026-09-01T00:00:00.000Z" };
const NEW = { kid: "n3wn3w03", key: Buffer.alloc(32, 3).toString("base64"), createdAt: "2026-10-28T00:00:00.000Z" };
const CONTEXT = { record: "DnsProvider", uid: "cf-1", field: "credentials.apiToken" };

export function configCipherSuite(ctx: ConfigCipherSuiteContext): void {
    describe("ConfigCipher with the key state row", () => {
        beforeEach(async () => {
            await ctx.clearState();
        });

        it("uses the singleton's uid", () => {
            expect(CONFIG_KEY_STATE_UID).toBe("config-keys");
        });

        it("encrypts with the oldest key while there is no row", async () => {
            const cipher = await ctx.newCipher({ keys: [OLD, NEW] });
            expect(cipher.currentKid()).toBe(OLD.kid);
        });

        it("encrypts with the row's activeKid when it is in the ring", async () => {
            await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: OLD.kid });
            const cipher = await ctx.newCipher({ keys: [OLD, NEW] });
            expect(cipher.currentKid()).toBe(OLD.kid);
            expect(cipher.encrypt("secret", CONTEXT).kid).toBe(OLD.kid);
        });

        it("follows the row when a key is activated, on its next reload", async () => {
            await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: OLD.kid });
            const cipher = await ctx.newCipher({ keys: [OLD, NEW] });
            await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: NEW.kid });
            expect(cipher.currentKid()).toBe(OLD.kid);
            await cipher.reload();
            expect(cipher.currentKid()).toBe(NEW.kid);
        });

        it("falls back to the newest key for an activeKid it hasn't loaded", async () => {
            await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, activeKid: "f00dbabe" });
            const cipher = await ctx.newCipher({ keys: [OLD, NEW] });
            expect(cipher.currentKid()).toBe(NEW.kid);
        });

        it("ignores a row with no activeKid", async () => {
            await ctx.saveState({ uid: CONFIG_KEY_STATE_UID, rotation: null });
            const cipher = await ctx.newCipher({ keys: [OLD, NEW] });
            expect(cipher.currentKid()).toBe(OLD.kid);
        });
    });
}
