///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// The configuration keyring document (spec 5.3): parsing, generating, reading from a file or inline, the production guard and the development keyring.
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
    assertProductionConfigKeyring,
    ensureDevelopmentConfigKeyring,
    generateConfigKey,
    generateConfigKeyring,
    newestConfigKey,
    parseConfigKeyring,
    readConfigKeyring,
    serializeConfigKeyring,
    type ConfigKeyring,
} from "../../src/secrets/ConfigKeyring.js";

const KEY_A: string = Buffer.alloc(32, 1).toString("base64");
const KEY_B: string = Buffer.alloc(32, 2).toString("base64");

function ring(...keys: [string, string, string][]): ConfigKeyring {
    return { keys: keys.map(([kid, key, createdAt]) => ({ kid, key, createdAt })) };
}

/** The message `call` throws, which it must. */
function messageOf(call: () => unknown): string {
    try {
        call();
    } catch (err: any) {
        return err.message;
    }
    throw new Error("expected the call to throw");
}

describe("generateConfigKey()", () => {
    it("makes a 32-byte key with an 8-hex kid and the creation time", () => {
        const at = new Date("2026-10-28T10:00:00.000Z");
        const entry = generateConfigKey(at);
        expect(entry.kid).toMatch(/^[0-9a-f]{8}$/);
        expect(Buffer.from(entry.key, "base64")).toHaveLength(32);
        expect(entry.createdAt).toBe("2026-10-28T10:00:00.000Z");
    });

    it("never repeats a key or a kid", () => {
        const a = generateConfigKey();
        const b = generateConfigKey();
        expect(a.key).not.toBe(b.key);
        expect(a.kid).not.toBe(b.kid);
    });

    it("dates the key now when not told when", () => {
        const before = Date.now();
        const stamp = Date.parse(generateConfigKey().createdAt);
        expect(stamp).toBeGreaterThanOrEqual(before);
        expect(stamp).toBeLessThanOrEqual(Date.now());
    });
});

describe("generateConfigKeyring()", () => {
    it("holds one new key", () => {
        const generated = generateConfigKeyring();
        expect(generated.keys).toHaveLength(1);
        expect(parseConfigKeyring(serializeConfigKeyring(generated))).toEqual(generated);
    });
});

describe("parseConfigKeyring()", () => {
    const good = ring(["a1b2c3d4", KEY_A, "2026-10-01T00:00:00.000Z"], ["e5f6a7b8", KEY_B, "2026-10-28T00:00:00.000Z"]);

    it("reads the JSON text, or the document itself (nconf parses JSON values from the environment)", () => {
        expect(parseConfigKeyring(JSON.stringify(good))).toEqual(good);
        expect(parseConfigKeyring(good)).toEqual(good);
    });

    it("returns a copy that holds only the three fields of each entry", () => {
        const parsed = parseConfigKeyring({ keys: [{ ...good.keys[0], extra: "x" }], other: 1 });
        expect(parsed).toEqual({ keys: [good.keys[0]] });
    });

    it.each([
        ["nothing", undefined],
        ["null", null],
        ["a number", 5],
        ["an array", []],
        ["text that is not JSON", "not json"],
        ["JSON that is not an object", "[1]"],
        ["no keys", {}],
        ["keys that is not a list", { keys: "x" }],
        ["an empty list", { keys: [] }],
        ["an entry that is not an object", { keys: ["x"] }],
        ["an entry that is null", { keys: [null] }],
        ["a missing kid", { keys: [{ key: KEY_A, createdAt: "2026-10-01T00:00:00Z" }] }],
        ["a kid that is not text", { keys: [{ kid: 5, key: KEY_A, createdAt: "2026-10-01T00:00:00Z" }] }],
        ["an empty kid", { keys: [{ kid: "", key: KEY_A, createdAt: "2026-10-01T00:00:00Z" }] }],
        ["a kid with a character outside letters, digits, - and _", { keys: [{ kid: "a b", key: KEY_A, createdAt: "2026-10-01T00:00:00Z" }] }],
        ["a kid over 64 characters", { keys: [{ kid: "a".repeat(65), key: KEY_A, createdAt: "2026-10-01T00:00:00Z" }] }],
        ["a missing key", { keys: [{ kid: "a1", createdAt: "2026-10-01T00:00:00Z" }] }],
        ["a key that is not text", { keys: [{ kid: "a1", key: 5, createdAt: "2026-10-01T00:00:00Z" }] }],
        ["a key that is not base64", { keys: [{ kid: "a1", key: "!!!!", createdAt: "2026-10-01T00:00:00Z" }] }],
        ["a key of 16 bytes", { keys: [{ kid: "a1", key: Buffer.alloc(16, 1).toString("base64"), createdAt: "2026-10-01T00:00:00Z" }] }],
        ["a key of 33 bytes", { keys: [{ kid: "a1", key: Buffer.alloc(33, 1).toString("base64"), createdAt: "2026-10-01T00:00:00Z" }] }],
        ["a missing createdAt", { keys: [{ kid: "a1", key: KEY_A }] }],
        ["a createdAt that is not a date", { keys: [{ kid: "a1", key: KEY_A, createdAt: "yesterday" }] }],
        ["a createdAt that is not text", { keys: [{ kid: "a1", key: KEY_A, createdAt: 5 }] }],
        ["a repeated kid", ring(["a1", KEY_A, "2026-10-01T00:00:00Z"], ["a1", KEY_B, "2026-10-02T00:00:00Z"])],
    ])("refuses %s", (_name, input) => {
        expect(() => parseConfigKeyring(input)).toThrow(/keyring/i);
    });

    it("never puts key material, or any part of the text it was given, in an error", () => {
        const secretKey = crypto.randomBytes(32).toString("base64");
        const inputs: unknown[] = [
            `{"keys": [{"kid": "a1", "key": "${secretKey}", "createdAt": "nope"}]}`,
            `{"keys": [{"kid": "a1", "key": "${secretKey}", "createdAt": "2026-10-01T00:00:00Z"}`, // truncated JSON: V8's message quotes the text
            `{"keys": [{"kid": "a b", "key": "${secretKey}", "createdAt": "2026-10-01T00:00:00Z"}]}`,
            `{"keys": [{"kid": "a1", "key": "${secretKey}AA", "createdAt": "2026-10-01T00:00:00Z"}]}`,
            { keys: [{ kid: "a1", key: secretKey, createdAt: 7 }] },
        ];
        for (const input of inputs) {
            const message = messageOf(() => parseConfigKeyring(input));
            expect(message).not.toContain(secretKey);
            expect(message).not.toContain(secretKey.slice(0, 12));
        }
    });
});

describe("serializeConfigKeyring()", () => {
    it("writes JSON that parses back to the same keyring", () => {
        const original = ring(["a1b2c3d4", KEY_A, "2026-10-01T00:00:00.000Z"]);
        expect(JSON.parse(serializeConfigKeyring(original))).toEqual(original);
        expect(serializeConfigKeyring(original).endsWith("\n")).toBe(true);
    });
});

describe("newestConfigKey()", () => {
    it("is the entry with the latest createdAt, wherever it is in the list", () => {
        const entries = ring(["old", KEY_A, "2026-10-01T00:00:00Z"], ["new", KEY_B, "2026-10-28T00:00:00Z"], ["mid", KEY_A, "2026-10-10T00:00:00Z"]);
        expect(newestConfigKey(entries)?.kid).toBe("new");
    });

    it("takes the later of two entries made at the same moment", () => {
        expect(newestConfigKey(ring(["first", KEY_A, "2026-10-01T00:00:00Z"], ["second", KEY_B, "2026-10-01T00:00:00Z"]))?.kid).toBe("second");
    });

    it("is undefined for an empty list", () => {
        expect(newestConfigKey({ keys: [] })).toBeUndefined();
    });
});

describe("readConfigKeyring()", () => {
    let dir: string;
    const good = ring(["a1b2c3d4", KEY_A, "2026-10-01T00:00:00.000Z"]);

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyring-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("is undefined when neither a file nor an inline keyring is set", () => {
        expect(readConfigKeyring({})).toBeUndefined();
        expect(readConfigKeyring({ keyringFile: "", keyring: "" })).toBeUndefined();
        expect(readConfigKeyring({ keyringFile: "  ", keyring: undefined })).toBeUndefined();
    });

    it("reads the file", () => {
        const file = path.join(dir, "keyring.json");
        fs.writeFileSync(file, serializeConfigKeyring(good));
        expect(readConfigKeyring({ keyringFile: file })).toEqual(good);
    });

    it("reads the inline keyring, as text or as the parsed document", () => {
        expect(readConfigKeyring({ keyring: JSON.stringify(good) })).toEqual(good);
        expect(readConfigKeyring({ keyring: good })).toEqual(good);
    });

    it("prefers the file when both are set", () => {
        const file = path.join(dir, "keyring.json");
        const other = ring(["ffffffff", KEY_B, "2026-10-02T00:00:00Z"]);
        fs.writeFileSync(file, serializeConfigKeyring(other));
        expect(readConfigKeyring({ keyringFile: file, keyring: good })).toEqual(other);
    });

    it("refuses a file that doesn't exist, naming the setting and not the file's content", () => {
        const message = messageOf(() => readConfigKeyring({ keyringFile: path.join(dir, "missing.json") }));
        expect(message).toContain("config_encryption:keyring_file");
        expect(message).toContain("can't be read");
    });

    it("refuses a file that isn't a keyring, without repeating what is in it", () => {
        const file = path.join(dir, "keyring.json");
        const secretKey = crypto.randomBytes(32).toString("base64");
        fs.writeFileSync(file, `{"keys": [{"kid": "a1", "key": "${secretKey}"`);
        const message = messageOf(() => readConfigKeyring({ keyringFile: file }));
        expect(message).toContain("config_encryption:keyring_file");
        expect(message).not.toContain(secretKey);
    });

    it("refuses an inline keyring that isn't one, naming the setting", () => {
        const message = messageOf(() => readConfigKeyring({ keyring: "nope" }));
        expect(message).toContain("config_encryption:keyring");
        expect(message).not.toContain("nope");
    });
});

describe("assertProductionConfigKeyring()", () => {
    let dir: string;
    const good = ring(["a1b2c3d4", KEY_A, "2026-10-01T00:00:00.000Z"]);

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyring-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("accepts a usable keyring in production", () => {
        expect(() => assertProductionConfigKeyring({ keyring: good }, true)).not.toThrow();
        const file = path.join(dir, "keyring.json");
        fs.writeFileSync(file, serializeConfigKeyring(good));
        expect(() => assertProductionConfigKeyring({ keyringFile: file }, true)).not.toThrow();
    });

    it("refuses to start in production without a keyring, saying what to set", () => {
        const message = messageOf(() => assertProductionConfigKeyring({}, true));
        expect(message).toContain("config_encryption:keyring_file");
        expect(message).toContain("production");
    });

    it("refuses to start in production with a keyring that is missing or malformed", () => {
        expect(() => assertProductionConfigKeyring({ keyringFile: path.join(dir, "missing.json") }, true)).toThrow(/can't be read/);
        expect(() => assertProductionConfigKeyring({ keyring: "{}" }, true)).toThrow(/keyring/);
    });

    it("asks for nothing outside production", () => {
        expect(() => assertProductionConfigKeyring({}, false)).not.toThrow();
        expect(() => assertProductionConfigKeyring({ keyring: "{}" }, false)).not.toThrow();
    });

    it("decides from NODE_ENV when not told", () => {
        const before = process.env.NODE_ENV;
        try {
            process.env.NODE_ENV = "production";
            expect(() => assertProductionConfigKeyring({})).toThrow(/production/);
            process.env.NODE_ENV = "development";
            expect(() => assertProductionConfigKeyring({})).not.toThrow();
        } finally {
            process.env.NODE_ENV = before;
        }
    });
});

describe("ensureDevelopmentConfigKeyring()", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "keyring-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("generates a keyring into the file on first use, readable by its owner only", async () => {
        const file = path.join(dir, "nested", "dev-keyring.json");
        const created = await ensureDevelopmentConfigKeyring(file);
        expect(created.keys).toHaveLength(1);
        expect(readConfigKeyring({ keyringFile: file })).toEqual(created);
        if (process.platform !== "win32") {
            expect(fs.statSync(file).mode & 0o077).toBe(0);
        }
    });

    it("keeps the keyring it made, so every later start uses the same key", async () => {
        const file = path.join(dir, "dev-keyring.json");
        const first = await ensureDevelopmentConfigKeyring(file);
        expect(await ensureDevelopmentConfigKeyring(file)).toEqual(first);
    });

    it("never overwrites a file that isn't a keyring", async () => {
        const file = path.join(dir, "dev-keyring.json");
        fs.writeFileSync(file, "precious");
        await expect(ensureDevelopmentConfigKeyring(file)).rejects.toThrow(/keyring/);
        expect(fs.readFileSync(file, "utf-8")).toBe("precious");
    });

    it("uses the one a racing start created first", async () => {
        const file = path.join(dir, "dev-keyring.json");
        const [a, b] = await Promise.all([ensureDevelopmentConfigKeyring(file), ensureDevelopmentConfigKeyring(file)]);
        expect(a).toEqual(b);
    });
});
