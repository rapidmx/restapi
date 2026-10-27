///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz. All rights reserved.
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Plugin secret settings kept in the secret store (spec 5.4): the reference a row holds in place of the value, where it is stored, how the plugin host
// gets the value back, and what counts as a plaintext secret still in a row.
import { createHash } from "crypto";
import { PluginManifest, PluginSecretSettingRef, SecretRef } from "../../src/models/types.js";
import { maskSecretSettings } from "../../src/routes/BasePluginRoute.js";
import {
    checkKeptPluginSecrets,
    MAX_PLUGIN_SECRET_PATH_LENGTH,
    plaintextPluginSecrets,
    plaintextSecretKeys,
    pluginSecretPath,
    pluginSecretRefs,
    PluginSecretUnreadableError,
    releasedPluginSecretRefs,
    resolvePluginSecretSettings,
    storePluginSecretSettings,
    withoutSecretSettings,
    writePluginSecretSetting,
} from "../../src/plugins/PluginSecretUtils.js";
import {
    computePluginStateHash,
    isPluginSecretRef,
    isSecretSetting,
    isValidPackageName,
    PLUGIN_API_VERSION,
    validatePluginSettings,
} from "../../src/plugins/PluginUtils.js";
import { InMemorySecretStore } from "../testDoubles.js";

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

function ref(path: string, generation: number = 1, backend: "openbao" | "kubernetes" = "openbao"): PluginSecretSettingRef {
    return { $secretRef: { backend, path, keys: ["value"], generation } };
}

describe("isPluginSecretRef()", () => {
    it("is exactly { $secretRef: SecretRef }", () => {
        expect(isPluginSecretRef(ref("plugins/a/b-1"))).toBe(true);
        expect(isPluginSecretRef({ $secretRef: { backend: "kubernetes", path: "p", keys: [], generation: 0 } })).toBe(true);
    });

    it("is nothing else: a value, the mask, a reference with another key next to it or an incomplete one", () => {
        for (const value of [
            "x",
            3,
            true,
            null,
            undefined,
            [],
            { secret: true },
            { $secretRef: null },
            { $secretRef: "plugins/a" },
            { ...ref("p"), other: 1 },
            { $secretRef: { backend: "openbao", path: "p", keys: ["value"] } },
            { $secretRef: { backend: "openbao", path: "p", generation: 1 } },
            { $secretRef: { backend: "openbao", keys: [], generation: 1 } },
            { $secretRef: { path: "p", keys: [], generation: 1 } },
            { $secretRef: { backend: "openbao", path: "p", keys: [1], generation: 1 } },
            { $secretRef: { backend: "openbao", path: "", keys: [], generation: 1 } },
            { $secretRef: { backend: "elsewhere", path: "p", keys: [], generation: 1 } },
        ]) {
            expect(isPluginSecretRef(value), JSON.stringify(value)).toBe(false);
        }
    });
});

describe("isSecretSetting()", () => {
    it("is a key naming a secret, or a setting the manifest marks secret or types as a password", () => {
        expect(isSecretSetting("mail:x:api_key")).toBe(true);
        expect(isSecretSetting("mail:x:pin", MANIFEST)).toBe(true);
        expect(isSecretSetting("mail:x:pin")).toBe(false);
        expect(isSecretSetting("mail:x:pass", { settings: [{ key: "mail:x:pass", label: "P", type: "password" as any }] })).toBe(true);
        expect(isSecretSetting("mail:x:note", MANIFEST)).toBe(false);
    });
});

describe("pluginSecretPath()", () => {
    const MAX_PACKAGE_NAME_LENGTH = 214;

    it("is plugins/<package>/<key>-<16 random hex digits>, a new path for every write", () => {
        const path: string = pluginSecretPath("@rapidmx/meet-plugin", "mail:videoconf:turn:secret");
        expect(path).toMatch(/^plugins\/rapidmx\/meet-plugin\/mail_videoconf_turn_secret-[0-9a-f]{16}$/);
        expect(pluginSecretPath("@rapidmx/meet-plugin", "mail:videoconf:turn:secret")).not.toBe(path);
    });

    it("is made only of characters every backend takes, whatever the package name and key hold", () => {
        expect(pluginSecretPath("crm~plugin", "Mail:X:API Key/../$x")).toMatch(/^plugins\/crm_plugin\/Mail_X_API_Key_\.\.__x-[0-9a-f]{16}$/);
        expect(pluginSecretPath("plain", "a.b-c_d")).toMatch(/^plugins\/plain\/a\.b-c_d-[0-9a-f]{16}$/);
    });

    it("is never longer than a Kubernetes Secret's key takes, cutting a long package name or key short with a hash of the whole name", () => {
        const scope: string = "@" + "s".repeat(100);
        const longPackage: string = `${scope}/${"p".repeat(MAX_PACKAGE_NAME_LENGTH - scope.length - 1)}`;
        // The longest name a package can have.
        expect(longPackage).toHaveLength(MAX_PACKAGE_NAME_LENGTH);
        expect(isValidPackageName(longPackage)).toBe(true);
        const longKey: string = `mail:pluginname:${"k".repeat(200)}`;
        for (const [pkg, key] of [
            [longPackage, "mail:pluginname:oauth_client_secret"],
            [longPackage, longKey],
            ["@rapidmx/crm-plugin", longKey],
        ]) {
            const path: string = pluginSecretPath(pkg, key);
            expect(path.length, path).toBeLessThanOrEqual(MAX_PLUGIN_SECRET_PATH_LENGTH);
            expect(path).toMatch(/^plugins\/[A-Za-z0-9._\/-]+\/[A-Za-z0-9._-]+-[0-9a-f]{16}$/);
        }
        // The cut keeps the start of each name, then a hash of the whole of it: two long names that start alike stay apart.
        const cut: string = pluginSecretPath(longPackage, "mail:pluginname:oauth_client_secret");
        expect(cut).toMatch(/^plugins\/s{100}\/p+_[0-9a-f]{8}\/mail_pluginname_oauth_client_secret-[0-9a-f]{16}$/);
        expect(cut.split("/").slice(0, 3)).not.toEqual(pluginSecretPath(`${longPackage.slice(0, -1)}q`, "mail:pluginname:oauth_client_secret").split("/").slice(0, 3));
        expect(pluginSecretPath("@rapidmx/crm-plugin", longKey)).toMatch(/^plugins\/rapidmx\/crm-plugin\/mail_pluginname_k{71}_[0-9a-f]{8}-[0-9a-f]{16}$/);
    });
});

describe("storePluginSecretSettings()", () => {
    it("writes each secret setting's plaintext value to the store, keeps the rest, and names every reference it wrote", async () => {
        const store = new InMemorySecretStore();
        const written: SecretRef[] = [];
        const stored = await storePluginSecretSettings(store, "@rapidmx/x", MANIFEST, { "mail:x:api_key": "s3cr3t", "mail:x:pin": 7, "mail:x:note": "hi", "mail:x:flag": "" }, written);
        expect(stored["mail:x:note"]).toBe("hi");
        expect(stored["mail:x:flag"]).toBe("");
        expect(isPluginSecretRef(stored["mail:x:api_key"]) && isPluginSecretRef(stored["mail:x:pin"])).toBe(true);
        expect(written).toEqual([(stored["mail:x:api_key"] as PluginSecretSettingRef).$secretRef, (stored["mail:x:pin"] as PluginSecretSettingRef).$secretRef]);
        expect(store.secrets.size).toBe(2);
        // A reference already in place is kept as it is.
        const again = await storePluginSecretSettings(store, "@rapidmx/x", MANIFEST, stored);
        expect(again).toEqual(stored);
        expect(store.secrets.size).toBe(2);
    });

    it("stores nothing without a store, and names what it wrote before a write failed", async () => {
        const none = new InMemorySecretStore();
        none.backend = "none";
        expect(await storePluginSecretSettings(none, "@rapidmx/x", MANIFEST, { "mail:x:api_key": "s3cr3t" })).toEqual({ "mail:x:api_key": "s3cr3t" });
        expect(none.secrets.size).toBe(0);

        const store = new InMemorySecretStore();
        const written: SecretRef[] = [];
        store.duringChange = async () => {
            store.duringChange = async () => {
                throw new Error("store unavailable");
            };
        };
        await expect(storePluginSecretSettings(store, "@rapidmx/x", MANIFEST, { "mail:x:api_key": "s3cr3t", "mail:x:pin": 7 }, written)).rejects.toThrow("store unavailable");
        expect(written).toHaveLength(1);
        expect(store.secrets.has(written[0].path)).toBe(true);
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
    let store: InMemorySecretStore;

    beforeEach(() => {
        store = new InMemorySecretStore();
    });

    it("keeps unread a secret whose setting takes the same values in the new version", async () => {
        const flag = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:flag", true);
        store.secrets.clear();
        // Unreadable now, but its definition differs only in label and description, so it isn't read.
        await expect(checkKeptPluginSecrets(store, MANIFEST, V2, { "mail:x:flag": flag })).resolves.toBeUndefined();
        // A setting the new version doesn't declare is left to validatePluginSettings().
        await expect(checkKeptPluginSecrets(store, MANIFEST, V2, { "mail:x:required_token": flag })).resolves.toBeUndefined();
    });

    it("checks the stored value against a setting the new version types or bounds differently, naming the setting and never the value", async () => {
        const key = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:api_key", "s3cr3t");
        await expect(checkKeptPluginSecrets(store, MANIFEST, V2, { "mail:x:api_key": key })).rejects.toThrow("'API key' must be one of: a.");
        const low = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:pin", 42);
        await expect(checkKeptPluginSecrets(store, MANIFEST, V2, { "mail:x:pin": low })).rejects.toThrow("'PIN' must be at least 1000.");
        const ok = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:pin", 4321);
        await expect(checkKeptPluginSecrets(store, MANIFEST, V2, { "mail:x:pin": ok })).resolves.toBeUndefined();
        // Text that a new version types as a number is refused, as the same value on the row would be.
        const text = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:pin", "abcd");
        await expect(checkKeptPluginSecrets(store, MANIFEST, V2, { "mail:x:pin": text })).rejects.toThrow("'PIN' must be a number.");
        // A previous manifest that didn't declare the setting reads it too.
        await expect(checkKeptPluginSecrets(store, undefined, V2, { "mail:x:pin": text })).rejects.toThrow("'PIN' must be a number.");
    });

    it("refuses a secret it can't read back to check: gone, in a backend the deployment doesn't use, or the store unavailable", async () => {
        const gone = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:pin", 4321);
        store.secrets.delete(gone.$secretRef.path);
        await expect(checkKeptPluginSecrets(store, MANIFEST, V2, { "mail:x:pin": gone })).rejects.toThrow(PluginSecretUnreadableError);

        const foreign = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:pin", 4321);
        const read = vi.spyOn(store, "read");
        await expect(checkKeptPluginSecrets(store, MANIFEST, V2, { "mail:x:pin": { $secretRef: { ...foreign.$secretRef, backend: "kubernetes" } } })).rejects.toThrow(
            /couldn't be read from the secret store/,
        );
        expect(read).not.toHaveBeenCalled();

        store.refuse = true;
        await expect(checkKeptPluginSecrets(store, MANIFEST, V2, { "mail:x:pin": foreign })).rejects.toThrow(/'PIN' couldn't be read/);
    });
});

describe("writePluginSecretSetting() and resolvePluginSecretSettings()", () => {
    let store: InMemorySecretStore;

    beforeEach(() => {
        store = new InMemorySecretStore();
    });

    it("stores text as it is, and a number or a flag as text with its type, under a new path each time", async () => {
        const text = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:api_key", "s3cr3t");
        const pin = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:pin", 1234);
        const flag = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:flag", false);
        expect(isPluginSecretRef(text) && isPluginSecretRef(pin) && isPluginSecretRef(flag)).toBe(true);
        expect(text.$secretRef.path).toMatch(/^plugins\/rapidmx\/x\/mail_x_api_key-[0-9a-f]{16}$/);
        expect(store.secrets.get(text.$secretRef.path)).toEqual({ value: "s3cr3t" });
        expect(store.secrets.get(pin.$secretRef.path)).toEqual({ value: "1234", type: "number" });
        expect(store.secrets.get(flag.$secretRef.path)).toEqual({ value: "false", type: "boolean" });
        expect(JSON.stringify([text, pin, flag])).not.toContain("s3cr3t");
        expect((await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:api_key", "s3cr3t")).$secretRef.path).not.toBe(text.$secretRef.path);
    });

    it("gives the plugin host every setting as the plugin reads it, references resolved to their values", async () => {
        const settings = {
            "mail:x:api_key": await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:api_key", "s3cr3t"),
            "mail:x:pin": await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:pin", 1234),
            "mail:x:flag": await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:flag", true),
            "mail:x:note": "hi",
            "mail:x:limit": 5,
        };
        expect(await resolvePluginSecretSettings(settings, store)).toEqual({
            values: { "mail:x:api_key": "s3cr3t", "mail:x:pin": 1234, "mail:x:flag": true, "mail:x:note": "hi", "mail:x:limit": 5 },
            unresolved: [],
        });
        expect(await resolvePluginSecretSettings(undefined, store)).toEqual({ values: {}, unresolved: [] });
    });

    it("leaves out, and names, a secret the store can't give, so the deployment's value or the plugin's default applies", async () => {
        const gone = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:api_key", "s3cr3t");
        store.secrets.delete(gone.$secretRef.path);
        const badNumber = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:pin", 1);
        store.secrets.set(badNumber.$secretRef.path, { value: "not a number", type: "number" });
        const unknownType = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:flag", true);
        store.secrets.set(unknownType.$secretRef.path, { value: "x", type: "object" });
        const settings = { "mail:x:api_key": gone, "mail:x:pin": badNumber, "mail:x:flag": unknownType, "mail:x:note": "hi" };

        expect(await resolvePluginSecretSettings(settings, store)).toEqual({ values: { "mail:x:note": "hi" }, unresolved: ["mail:x:api_key", "mail:x:pin", "mail:x:flag"] });

        // A store that can't be read at all (no store: NullSecretStore's 503) resolves nothing, and says so without throwing.
        store.refuse = true;
        const ok = await writePluginSecretSetting(new InMemorySecretStore(), "@rapidmx/x", "mail:x:api_key", "fine");
        expect(await resolvePluginSecretSettings({ "mail:x:api_key": ok }, store)).toEqual({ values: {}, unresolved: ["mail:x:api_key"] });
    });

    it("reads a boolean back only from true or false", async () => {
        const off = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:flag", false);
        expect(await resolvePluginSecretSettings({ "mail:x:flag": off }, store)).toEqual({ values: { "mail:x:flag": false }, unresolved: [] });
        const flag = await writePluginSecretSetting(store, "@rapidmx/x", "mail:x:flag", true);
        store.secrets.set(flag.$secretRef.path, { value: "yes", type: "boolean" });
        expect((await resolvePluginSecretSettings({ "mail:x:flag": flag }, store)).unresolved).toEqual(["mail:x:flag"]);
    });
});

describe("plaintextSecretKeys() and plaintextPluginSecrets()", () => {
    it("names each secret setting a row still holds the value of, never one held as a reference or left empty", () => {
        const settings = { "mail:x:api_key": "s3cr3t", "mail:x:pin": 0, "mail:x:flag": false, "mail:x:note": "hi", "mail:x:required_token": ref("p") };
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

describe("pluginSecretRefs(), releasedPluginSecretRefs() and withoutSecretSettings()", () => {
    it("lists the references a row holds", () => {
        const a = ref("plugins/x/a-1");
        expect(pluginSecretRefs({ "mail:x:api_key": a, "mail:x:note": "hi" })).toEqual([a.$secretRef]);
        expect(pluginSecretRefs(undefined)).toEqual([]);
    });

    it("names the secrets a change stopped referring to: replaced, cleared or dropped, never one still named", () => {
        const kept = ref("plugins/x/kept-1");
        const replaced = ref("plugins/x/replaced-1");
        const cleared = ref("plugins/x/cleared-1");
        const before = { a: kept, b: replaced, c: cleared, d: "plain" };
        const after = { a: kept, b: ref("plugins/x/replaced-2"), d: "plain" };
        expect(releasedPluginSecretRefs(before, after)).toEqual([replaced.$secretRef, cleared.$secretRef]);
        expect(releasedPluginSecretRefs(undefined, after)).toEqual([]);
        expect(releasedPluginSecretRefs(before, undefined)).toEqual([kept.$secretRef, replaced.$secretRef, cleared.$secretRef]);
        // The same secret moved to another key is still named.
        expect(releasedPluginSecretRefs({ a: kept }, { b: kept })).toEqual([]);
    });

    it("leaves out every secret setting, references and values alike: what an uninstalled plugin's row keeps", () => {
        expect(withoutSecretSettings({ "mail:x:api_key": "s3cr3t", "mail:x:pin": 3, "mail:x:required_token": ref("p"), "mail:x:note": "hi", "mail:x:other": ref("q") }, MANIFEST)).toEqual({
            "mail:x:note": "hi",
        });
        expect(withoutSecretSettings(undefined, MANIFEST)).toEqual({});
    });
});

describe("validatePluginSettings() with kept references", () => {
    it("keeps a reference the row already holds, which counts as a value for a required setting", () => {
        const kept = ref("plugins/x/token-1");
        expect(validatePluginSettings(MANIFEST, { "mail:x:note": "hi" }, { "mail:x:required_token": kept })).toEqual({ "mail:x:note": "hi", "mail:x:required_token": kept });
        expect(() => validatePluginSettings(MANIFEST, { "mail:x:note": "hi" })).toThrow(/'Required token' is required/);
    });

    it("refuses a kept reference for a setting the manifest doesn't declare", () => {
        expect(() => validatePluginSettings(MANIFEST, { "mail:x:required_token": "t" }, { "mail:y:gone": ref("p") })).toThrow(/'mail:y:gone' is not a setting of this plugin/);
    });

    it("never takes a reference sent as a value: only the row's own references are kept", () => {
        expect(() => validatePluginSettings(MANIFEST, { "mail:x:required_token": ref("dns/provider") })).toThrow(/'Required token' must be text/);
        expect(() => validatePluginSettings(MANIFEST, { "mail:x:required_token": "t", "mail:x:pin": ref("dns/provider") })).toThrow(/'PIN' must be a number/);
    });
});

describe("computePluginStateHash() with secret references", () => {
    const row = (settings: Record<string, unknown>) => ({ name: "a", packageVersion: "1.0.0", enabled: true, settings: settings as any });

    it("changes with the reference's path and generation, never reading a value, and doesn't depend on the order its fields were stored in", () => {
        const base: string = computePluginStateHash([row({ k: ref("plugins/a/k-1", 1) })]);
        const reordered: SecretRef = { generation: 1, keys: ["value"], path: "plugins/a/k-1", backend: "openbao" };
        expect(computePluginStateHash([row({ k: { $secretRef: reordered } })])).toBe(base);
        expect(computePluginStateHash([row({ k: { $secretRef: { ...reordered, keys: ["value", "type"] } } })])).toBe(base);
        expect(computePluginStateHash([row({ k: ref("plugins/a/k-1", 2) })])).not.toBe(base);
        expect(computePluginStateHash([row({ k: ref("plugins/a/k-2", 1) })])).not.toBe(base);
        expect(computePluginStateHash([row({ k: ref("plugins/a/k-1", 1, "kubernetes") })])).not.toBe(base);
    });

    it("hashes a plain value as it always has, so a deployment without secrets in the store keeps its hash", () => {
        const plain = row({ x: 1, y: "two" });
        const expected = computePluginStateHash([{ ...plain, settings: { y: "two", x: 1 } }]);
        expect(computePluginStateHash([plain])).toBe(expected);
        expect(computePluginStateHash([plain])).toBe(
            // The hash of before secret references existed: [name, version, integrity, sorted [key, value] pairs].
            createHash("sha256")
                .update(JSON.stringify([["a", "1.0.0", null, [["x", 1], ["y", "two"]]]]))
                .digest("hex"),
        );
    });
});

describe("maskSecretSettings() with secret references", () => {
    it("shows a reference as the mask, whatever the setting is called, so a store path is never sent to the browser", () => {
        expect(maskSecretSettings({ "mail:x:api_key": ref("plugins/x/a-1"), "mail:x:note": ref("plugins/x/n-1"), "mail:x:plain": "hi" }, MANIFEST)).toEqual({
            "mail:x:api_key": { secret: true },
            "mail:x:note": { secret: true },
            "mail:x:plain": "hi",
        });
    });
});
