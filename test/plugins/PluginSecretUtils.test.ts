///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Plugin secret settings encrypted in the plugin's own row (spec 5.7): the envelope a row holds in place of the value and what it is bound to, how the plugin
// host gets the value back, the check of a kept value on a version change, the plugin-state hash by decrypted value, and what counts as a plaintext secret
// still in a row.
import { createHash } from "crypto";
import { ConfigEnvelope, PluginManifest } from "../../src/models/types.js";
import { maskSecretSettings } from "../../src/routes/BasePluginRoute.js";
import {
    checkKeptPluginSecrets,
    isPlaintextSecretValue,
    plaintextPluginSecrets,
    plaintextSecretKeys,
    PluginSecretUnreadableError,
    sealPluginSecretSettings,
    withoutSecretSettings,
} from "../../src/plugins/PluginSecretUtils.js";
import {
    computePluginStateHash,
    isSecretSetting,
    PLUGIN_API_VERSION,
    PLUGIN_SECRET_RECORD,
    pluginSecretContext,
    pluginSecretField,
    resolvePluginSettings,
    validatePluginSettings,
} from "../../src/plugins/PluginUtils.js";
import { ConfigCipher, ConfigSecretUnavailableError, isConfigEnvelope } from "../../src/secrets/ConfigCipher.js";
import { newTestConfigCipher } from "../testDoubles.js";

const MANIFEST: PluginManifest = {
    apiVersion: PLUGIN_API_VERSION,
    displayName: "Secretive",
    settings: [
        { key: "mail:x:api_key", label: "API key", type: "string" },
        { key: "mail:x:pin", label: "PIN", type: "number", secret: true },
        { key: "mail:x:flag", label: "Flag", type: "boolean", secret: true },
        { key: "mail:x:note", label: "Note", type: "string" },
        { key: "mail:x:required_token", label: "Required token", type: "string", required: true },
    ],
};

let cipher: ConfigCipher;

beforeAll(async () => {
    cipher = await newTestConfigCipher();
});

afterAll(async () => {
    await cipher.dispose();
});

/** A real envelope of `value` for setting `key` of plugin row `uid`. */
function sealed(value: string | number | boolean, key: string = "mail:x:api_key", uid: string = "p1"): ConfigEnvelope {
    return cipher.encrypt(value, pluginSecretContext(uid, key));
}

describe("isSecretSetting()", () => {
    it("is a key naming a secret, or a setting the manifest marks secret or types as a password", () => {
        expect(isSecretSetting("mail:x:api_key")).toBe(true);
        expect(isSecretSetting("mail:x:pin", MANIFEST)).toBe(true);
        expect(isSecretSetting("mail:x:pin")).toBe(false);
        expect(isSecretSetting("mail:x:pass", { settings: [{ key: "mail:x:pass", label: "P", type: "password" as any }] })).toBe(true);
        expect(isSecretSetting("mail:x:note", MANIFEST)).toBe(false);
    });
});

describe("what a plugin secret's envelope is bound to", () => {
    it("is the Plugin record, the row's uid and settings.<key>, as the spec's associated data names it", () => {
        expect(PLUGIN_SECRET_RECORD).toBe("Plugin");
        expect(pluginSecretField("mail:x:api_key")).toBe("settings.mail:x:api_key");
        expect(pluginSecretContext("p1", "mail:x:api_key")).toEqual({ record: "Plugin", uid: "p1", field: "settings.mail:x:api_key" });
    });

    it("makes an envelope that opens only for its own row and setting, so it can't be copied to another plugin or setting", () => {
        const envelope = sealed("s3cr3t");
        expect(cipher.decrypt(envelope, pluginSecretContext("p1", "mail:x:api_key"))).toBe("s3cr3t");
        expect(() => cipher.decrypt(envelope, pluginSecretContext("p2", "mail:x:api_key"))).toThrow(ConfigSecretUnavailableError);
        expect(() => cipher.decrypt(envelope, pluginSecretContext("p1", "mail:x:other_token"))).toThrow(ConfigSecretUnavailableError);
        // Nor does it open as a DNS credential or an Integrations secret.
        expect(() => cipher.decrypt(envelope, { record: "DnsProvider", uid: "p1", field: "credentials.mail:x:api_key" })).toThrow(ConfigSecretUnavailableError);
    });
});

describe("isPlaintextSecretValue()", () => {
    it("is text that isn't empty, a number or a flag, and nothing else", () => {
        for (const value of ["s3cr3t", 0, 4321, false, true]) {
            expect(isPlaintextSecretValue(value), String(value)).toBe(true);
        }
        for (const value of ["", null, undefined, [], { secret: true }, sealed("x")]) {
            expect(isPlaintextSecretValue(value), JSON.stringify(value)).toBe(false);
        }
    });
});

describe("sealPluginSecretSettings()", () => {
    it("encrypts each plaintext secret setting for its row and setting, leaving every other setting as it is", () => {
        const settings = { "mail:x:api_key": "  s3cr3t\n", "mail:x:pin": 4321, "mail:x:flag": false, "mail:x:note": "hi" };
        const result = sealPluginSecretSettings(cipher, "p1", MANIFEST, settings);

        expect(result["mail:x:note"]).toBe("hi");
        for (const [key, value] of [["mail:x:api_key", "  s3cr3t\n"], ["mail:x:pin", 4321], ["mail:x:flag", false]] as const) {
            expect(isConfigEnvelope(result[key]), key).toBe(true);
            // The value comes back as it was saved, a number as a number and a flag as a flag.
            expect(cipher.decrypt(result[key] as ConfigEnvelope, pluginSecretContext("p1", key))).toBe(value);
        }
        expect(JSON.stringify(result)).not.toContain("s3cr3t");
        // The settings it was given are not changed.
        expect(settings["mail:x:api_key"]).toBe("  s3cr3t\n");
    });

    it("leaves an envelope the row already holds, an empty secret and a setting that isn't a secret alone", () => {
        const kept = sealed("old");
        const result = sealPluginSecretSettings(cipher, "p1", MANIFEST, { "mail:x:api_key": kept, "mail:x:required_token": "", "mail:x:note": "hi" });
        expect(result).toEqual({ "mail:x:api_key": kept, "mail:x:required_token": "", "mail:x:note": "hi" });
        expect(result["mail:x:api_key"]).toBe(kept);
    });

    it("uses a fresh nonce each time, so the same value never makes the same envelope", () => {
        const first = sealPluginSecretSettings(cipher, "p1", MANIFEST, { "mail:x:api_key": "same" })["mail:x:api_key"] as ConfigEnvelope;
        const second = sealPluginSecretSettings(cipher, "p1", MANIFEST, { "mail:x:api_key": "same" })["mail:x:api_key"] as ConfigEnvelope;
        expect(first.iv).not.toBe(second.iv);
        expect(first.ct).not.toBe(second.ct);
    });
});

describe("checkKeptPluginSecrets()", () => {
    const V2: PluginManifest = {
        ...MANIFEST,
        settings: [
            { key: "mail:x:api_key", label: "API key", type: "select", options: [{ value: "a", label: "A" }] },
            { key: "mail:x:pin", label: "PIN", type: "number", secret: true, min: 1000 },
            { key: "mail:x:flag", label: "Flag (renamed)", type: "boolean", secret: true, description: "Changed" },
            { key: "mail:x:note", label: "Note", type: "string" },
        ],
    };

    it("keeps unread a secret whose setting takes the same values in the new version", () => {
        // An envelope that could not be decrypted, but its definition differs only in label and description, so nothing reads it.
        const unreadable = sealed(true, "mail:x:flag", "another-row");
        const decrypt = vi.spyOn(cipher, "decrypt");
        expect(() => checkKeptPluginSecrets(cipher, "p1", MANIFEST, V2, { "mail:x:flag": unreadable })).not.toThrow();
        // A setting the new version doesn't declare is left to validatePluginSettings().
        expect(() => checkKeptPluginSecrets(cipher, "p1", MANIFEST, V2, { "mail:x:required_token": unreadable })).not.toThrow();
        expect(decrypt).not.toHaveBeenCalled();
        decrypt.mockRestore();
    });

    it("decrypts the kept value and checks it against a setting the new version types or bounds differently, naming the setting and never the value", () => {
        const key = sealed("s3cr3t", "mail:x:api_key");
        expect(() => checkKeptPluginSecrets(cipher, "p1", MANIFEST, V2, { "mail:x:api_key": key })).toThrow("'API key' must be one of: a.");
        const low = sealed(42, "mail:x:pin");
        expect(() => checkKeptPluginSecrets(cipher, "p1", MANIFEST, V2, { "mail:x:pin": low })).toThrow("'PIN' must be at least 1000.");
        const ok = sealed(4321, "mail:x:pin");
        expect(() => checkKeptPluginSecrets(cipher, "p1", MANIFEST, V2, { "mail:x:pin": ok })).not.toThrow();
        // Text that a new version types as a number is refused, as the same value on the row would be.
        const text = sealed("abcd", "mail:x:pin");
        expect(() => checkKeptPluginSecrets(cipher, "p1", MANIFEST, V2, { "mail:x:pin": text })).toThrow("'PIN' must be a number.");
        // A previous manifest that didn't declare the setting reads it too.
        expect(() => checkKeptPluginSecrets(cipher, "p1", undefined, V2, { "mail:x:pin": text })).toThrow("'PIN' must be a number.");
        expect(() => checkKeptPluginSecrets(cipher, "p1", MANIFEST, V2, { "mail:x:api_key": key })).not.toThrow(/s3cr3t/);
    });

    it("refuses a value it can't decrypt to check, asking for a new one, and never says why or what", () => {
        const another = sealed(4321, "mail:x:pin", "another-row");
        let thrown: any;
        try {
            checkKeptPluginSecrets(cipher, "p1", MANIFEST, V2, { "mail:x:pin": another });
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(PluginSecretUnreadableError);
        expect(thrown.message).toBe("The saved value of 'PIN' can't be read to check it against this version. Save a new value for it.");

        // A key that isn't in the ring, and a value that is no envelope at all.
        const lostKey = { ...sealed(4321, "mail:x:pin"), kid: "0ld0ld01" };
        expect(() => checkKeptPluginSecrets(cipher, "p1", MANIFEST, V2, { "mail:x:pin": lostKey })).toThrow(PluginSecretUnreadableError);
        expect(() => checkKeptPluginSecrets(cipher, "p1", MANIFEST, V2, { "mail:x:pin": "plain" as any })).toThrow(PluginSecretUnreadableError);
    });

    it("refuses a kept value to check on a server that has no cipher", () => {
        expect(() => checkKeptPluginSecrets(undefined, "p1", MANIFEST, V2, { "mail:x:pin": sealed(4321, "mail:x:pin") })).toThrow(PluginSecretUnreadableError);
        // A setting that needs no check needs no cipher.
        expect(() => checkKeptPluginSecrets(undefined, "p1", MANIFEST, V2, { "mail:x:flag": sealed(true, "mail:x:flag") })).not.toThrow();
    });

    it("rethrows what isn't a secret that can't be read, which is a bug", () => {
        const broken: any = {
            decrypt: () => {
                throw new Error("boom");
            },
        };
        expect(() => checkKeptPluginSecrets(broken, "p1", MANIFEST, V2, { "mail:x:pin": sealed(4321, "mail:x:pin") })).toThrow("boom");
    });
});

describe("resolvePluginSettings()", () => {
    it("gives the plugin host every setting as the plugin reads it, envelopes decrypted and plaintext values as they are", () => {
        const row = {
            uid: "p1",
            settings: { "mail:x:api_key": sealed("s3cr3t"), "mail:x:pin": sealed(4321, "mail:x:pin"), "mail:x:flag": sealed(false, "mail:x:flag"), "mail:x:note": "hi", "mail:x:legacy_token": "plain" },
        };
        expect(resolvePluginSettings(row, cipher)).toEqual({
            values: { "mail:x:api_key": "s3cr3t", "mail:x:pin": 4321, "mail:x:flag": false, "mail:x:note": "hi", "mail:x:legacy_token": "plain" },
            unresolved: [],
        });
    });

    it("leaves out, and names, a secret that can't be decrypted, so the deployment's value or the plugin's default applies", () => {
        const row = { uid: "p1", settings: { "mail:x:api_key": sealed("s3cr3t", "mail:x:api_key", "another-row"), "mail:x:pin": { ...sealed(4321, "mail:x:pin"), kid: "0ld0ld01" }, "mail:x:note": "hi" } };
        const resolved = resolvePluginSettings(row, cipher);
        expect(resolved).toEqual({ values: { "mail:x:note": "hi" }, unresolved: ["mail:x:api_key", "mail:x:pin"] });
        expect(JSON.stringify(resolved)).not.toContain("s3cr3t");
    });

    it("leaves out every envelope on a server that has no cipher", () => {
        const row = { uid: "p1", settings: { "mail:x:api_key": sealed("s3cr3t"), "mail:x:note": "hi" } };
        expect(resolvePluginSettings(row, undefined)).toEqual({ values: { "mail:x:note": "hi" }, unresolved: ["mail:x:api_key"] });
        expect(resolvePluginSettings({ uid: "p1", settings: undefined as any }, cipher)).toEqual({ values: {}, unresolved: [] });
    });

    it("rethrows what isn't a secret that can't be read, which is a bug", () => {
        const broken: any = {
            decrypt: () => {
                throw new Error("boom");
            },
        };
        expect(() => resolvePluginSettings({ uid: "p1", settings: { "mail:x:api_key": sealed("x") } }, broken)).toThrow("boom");
    });
});

describe("plaintextSecretKeys() and plaintextPluginSecrets()", () => {
    it("names each secret setting a row still holds the value of, never one held as an envelope or left empty", () => {
        const settings = { "mail:x:api_key": "s3cr3t", "mail:x:pin": 0, "mail:x:flag": false, "mail:x:note": "hi", "mail:x:required_token": sealed("t", "mail:x:required_token") };
        expect(plaintextSecretKeys({ settings, manifest: MANIFEST })).toEqual(["mail:x:api_key", "mail:x:pin", "mail:x:flag"]);
        expect(plaintextSecretKeys({ settings: { "mail:x:api_key": "", "mail:x:pin": null as any }, manifest: MANIFEST })).toEqual([]);
        expect(plaintextSecretKeys({ settings: undefined as any, manifest: MANIFEST })).toEqual([]);
        expect(
            plaintextPluginSecrets([
                { name: "@rapidmx/a", settings, manifest: MANIFEST },
                { name: "@rapidmx/b", settings: { "mail:x:note": "hi" }, manifest: MANIFEST },
            ]),
        ).toEqual([
            { name: "@rapidmx/a", key: "mail:x:api_key" },
            { name: "@rapidmx/a", key: "mail:x:pin" },
            { name: "@rapidmx/a", key: "mail:x:flag" },
        ]);
    });
});

describe("withoutSecretSettings()", () => {
    it("leaves out every secret setting, envelopes and values alike: what an uninstalled plugin's row keeps", () => {
        const settings = { "mail:x:api_key": "s3cr3t", "mail:x:pin": 3, "mail:x:required_token": sealed("t", "mail:x:required_token"), "mail:x:note": "hi", "mail:x:other": sealed("o", "mail:x:other") };
        expect(withoutSecretSettings(settings, MANIFEST)).toEqual({ "mail:x:note": "hi" });
        expect(withoutSecretSettings(undefined, MANIFEST)).toEqual({});
    });
});

describe("validatePluginSettings() with kept envelopes", () => {
    it("keeps an envelope the row already holds, which counts as a value for a required setting", () => {
        const kept = sealed("t", "mail:x:required_token");
        expect(validatePluginSettings(MANIFEST, { "mail:x:note": "hi" }, { "mail:x:required_token": kept })).toEqual({ "mail:x:note": "hi", "mail:x:required_token": kept });
        expect(() => validatePluginSettings(MANIFEST, { "mail:x:note": "hi" })).toThrow(/'Required token' is required/);
    });

    it("refuses a kept envelope for a setting the manifest doesn't declare", () => {
        expect(() => validatePluginSettings(MANIFEST, { "mail:x:required_token": "t" }, { "mail:y:gone": sealed("x", "mail:y:gone") })).toThrow(/'mail:y:gone' is not a setting of this plugin/);
    });

    it("never takes an envelope sent as a value, so no setting can be pointed at another secret: only the row's own are kept", () => {
        const foreign = sealed("dns-token", "mail:x:required_token", "cloudflare-1");
        expect(() => validatePluginSettings(MANIFEST, { "mail:x:required_token": foreign })).toThrow(/'Required token' must be text/);
        expect(() => validatePluginSettings(MANIFEST, { "mail:x:required_token": "t", "mail:x:pin": foreign })).toThrow(/'PIN' must be a number/);
        expect(() => validatePluginSettings(MANIFEST, { "mail:x:required_token": "t", "mail:x:flag": foreign })).toThrow(/'Flag' must be true or false/);
    });
});

describe("computePluginStateHash() by decrypted value (spec 5.7)", () => {
    const row = (settings: Record<string, unknown>, uid: string = "p1") => ({ uid, name: "a", packageVersion: "1.0.0", enabled: true, settings: settings as any });

    it("counts a secret setting by its decrypted value: the same as the plaintext row, whatever the envelope or the key that made it", () => {
        const plaintext: string = computePluginStateHash([row({ "mail:x:api_key": "s3cr3t", "mail:x:pin": 4321 })]);
        const first = row({ "mail:x:api_key": sealed("s3cr3t"), "mail:x:pin": sealed(4321, "mail:x:pin") });
        expect(computePluginStateHash([first], cipher)).toBe(plaintext);
        // Encrypting again (the rotation's re-encryption) changes the envelope and not the hash.
        const again = row({ "mail:x:api_key": sealed("s3cr3t"), "mail:x:pin": sealed(4321, "mail:x:pin") });
        expect(again.settings["mail:x:api_key"]).not.toEqual(first.settings["mail:x:api_key"]);
        expect(computePluginStateHash([again], cipher)).toBe(plaintext);
    });

    it("changes with a new secret value, and with nothing else about the envelope", () => {
        const base: string = computePluginStateHash([row({ "mail:x:api_key": sealed("one") })], cipher);
        expect(computePluginStateHash([row({ "mail:x:api_key": sealed("two") })], cipher)).not.toBe(base);
        expect(computePluginStateHash([row({ "mail:x:api_key": sealed("one") })], cipher)).toBe(base);
        // The type of the value is part of it: the number 1 is not the text "1".
        expect(computePluginStateHash([row({ k: sealed(1, "k") })], cipher)).not.toBe(computePluginStateHash([row({ k: sealed("1", "k") })], cipher));
    });

    it("leaves out a secret that can't be decrypted, as the plugin host does, and every envelope when it has no cipher", () => {
        const noSecrets: string = computePluginStateHash([row({ "mail:x:note": "hi" })]);
        const unreadable = row({ "mail:x:api_key": sealed("s3cr3t", "mail:x:api_key", "another-row"), "mail:x:note": "hi" });
        expect(computePluginStateHash([unreadable], cipher)).toBe(noSecrets);
        const readable = row({ "mail:x:api_key": sealed("s3cr3t"), "mail:x:note": "hi" });
        expect(computePluginStateHash([readable])).toBe(noSecrets);
        expect(computePluginStateHash([readable], cipher)).not.toBe(noSecrets);
    });

    it("leaves out an envelope of a row that has no uid, which no row's envelope is bound to", () => {
        const noSecrets: string = computePluginStateHash([row({ "mail:x:note": "hi" })]);
        const anonymous: any = { name: "a", packageVersion: "1.0.0", enabled: true, settings: { "mail:x:api_key": sealed("s3cr3t"), "mail:x:note": "hi" } };
        expect(computePluginStateHash([anonymous], cipher)).toBe(noSecrets);
    });

    it("hashes a plain value as it always has, so a deployment without secrets keeps its hash", () => {
        const plain = row({ x: 1, y: "two" });
        expect(computePluginStateHash([plain])).toBe(
            // [name, version, integrity, sorted [key, value] pairs]
            createHash("sha256")
                .update(JSON.stringify([["a", "1.0.0", null, [["x", 1], ["y", "two"]]]]))
                .digest("hex"),
        );
        expect(computePluginStateHash([plain], cipher)).toBe(computePluginStateHash([plain]));
    });
});

describe("maskSecretSettings() with envelopes", () => {
    it("shows an envelope as the mask, whatever the setting is called, so ciphertext is never sent to the browser", () => {
        expect(maskSecretSettings({ "mail:x:api_key": sealed("a"), "mail:x:note": sealed("n", "mail:x:note"), "mail:x:plain": "hi" }, MANIFEST)).toEqual({
            "mail:x:api_key": { secret: true },
            "mail:x:note": { secret: true },
            "mail:x:plain": "hi",
        });
    });
});
