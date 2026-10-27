///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `ConfigCipher` (spec 5.2, 5.3, 5.4): AES-256-GCM envelopes bound to their record and field, and the keyring behind them - which key encrypts, and how a
// rotation reaches a running process.
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ApiError } from "@rapidrest/core";
import {
    CONFIG_ENVELOPE_FORMAT,
    CONFIG_RELOAD_INTERVAL_MS,
    ConfigCipher,
    ConfigSecretUnavailableError,
    configAssociatedData,
    isConfigEnvelope,
    type ConfigCipherContext,
} from "../../src/secrets/ConfigCipher.js";
import { serializeConfigKeyring, type ConfigKeyring } from "../../src/secrets/ConfigKeyring.js";
import type { ConfigEnvelope } from "../../src/models/types.js";

const KEY_OLD: string = Buffer.alloc(32, 1).toString("base64");
const KEY_MID: string = Buffer.alloc(32, 2).toString("base64");
const KEY_NEW: string = Buffer.alloc(32, 3).toString("base64");

const OLD = { kid: "0ld0ld01", key: KEY_OLD, createdAt: "2026-09-01T00:00:00.000Z" };
const MID = { kid: "m1dm1d02", key: KEY_MID, createdAt: "2026-10-01T00:00:00.000Z" };
const NEW = { kid: "n3wn3w03", key: KEY_NEW, createdAt: "2026-10-28T00:00:00.000Z" };

const CONTEXT: ConfigCipherContext = { record: "DnsProvider", uid: "cloudflare-1", field: "credentials.apiToken" };

function ringOf(...entries: ConfigKeyring["keys"]): ConfigKeyring {
    return { keys: entries };
}

interface Harness {
    cipher: ConfigCipher;
    logger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
    /** The active kid the (fake) ConfigKeyState row holds; set it to change what a reload reads. */
    state: { activeKid?: string | null; failWith?: Error };
}

const live: ConfigCipher[] = [];

/** A cipher as the object factory builds one: its config fields set, then `init()`. */
async function newCipher(source: { keyringFile?: string; keyring?: unknown }, withState: boolean = true): Promise<Harness> {
    const cipher: any = new ConfigCipher();
    cipher.keyringFile = source.keyringFile ?? "";
    cipher.keyring = source.keyring ?? "";
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
    cipher.logger = logger;
    const state: Harness["state"] = {};
    if (withState) {
        cipher.stateRepo = {
            findOne: vi.fn(async () => {
                if (state.failWith) {
                    throw state.failWith;
                }
                return state.activeKid === undefined ? undefined : { activeKid: state.activeKid };
            }),
        };
    }
    await cipher.init();
    live.push(cipher);
    return { cipher, logger, state };
}

/** Another envelope of `cipher`'s, changed by `change`. */
function altered(envelope: ConfigEnvelope, change: Partial<Record<keyof ConfigEnvelope, unknown>>): ConfigEnvelope {
    return { ...envelope, ...change } as ConfigEnvelope;
}

/** An envelope sealed by a cipher holding only `entries`, as another copy of the server with another ring would write one. */
async function sealedBy(entries: ConfigKeyring["keys"], value: string): Promise<ConfigEnvelope> {
    return (await newCipher({ keyring: ringOf(...entries) }, false)).cipher.encrypt(value, CONTEXT);
}

function unavailableFrom(call: () => unknown): ConfigSecretUnavailableError {
    try {
        call();
    } catch (err: any) {
        expect(err).toBeInstanceOf(ConfigSecretUnavailableError);
        return err;
    }
    throw new Error("expected the call to throw");
}

afterEach(async () => {
    for (const cipher of live.splice(0)) {
        await cipher.dispose();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("configAssociatedData()", () => {
    const part = (text: string): Buffer => {
        const bytes = Buffer.from(text, "utf-8");
        const length = Buffer.alloc(4);
        length.writeUInt32BE(bytes.length);
        return Buffer.concat([length, bytes]);
    };

    it("is the format tag, the record type, the uid and the field, each prefixed with its length", () => {
        expect(CONFIG_ENVELOPE_FORMAT).toBe("rapidmx-config/1");
        expect(configAssociatedData(CONTEXT).equals(Buffer.concat([part("rapidmx-config/1"), part("DnsProvider"), part("cloudflare-1"), part("credentials.apiToken")]))).toBe(
            true,
        );
    });

    it("measures a part in UTF-8 bytes", () => {
        const data = configAssociatedData({ record: "Plugin", uid: "é", field: "settings.k" });
        expect(data.equals(Buffer.concat([part("rapidmx-config/1"), part("Plugin"), part("é"), part("settings.k")]))).toBe(true);
        expect(part("é").readUInt32BE(0)).toBe(2);
    });

    it("changes with every part", () => {
        const base = configAssociatedData(CONTEXT);
        for (const other of [{ ...CONTEXT, record: "Plugin" }, { ...CONTEXT, uid: "cloudflare-2" }, { ...CONTEXT, field: "credentials.other" }]) {
            expect(configAssociatedData(other).equals(base)).toBe(false);
        }
    });

    it("never encodes two contexts alike, whatever is moved between neighbouring parts", () => {
        const a = configAssociatedData({ record: "ab", uid: "c", field: "d" });
        const b = configAssociatedData({ record: "a", uid: "bc", field: "d" });
        const c = configAssociatedData({ record: "a", uid: "b", field: "cd" });
        const d = configAssociatedData({ record: "abc", uid: "", field: "d" });
        const all = [a, b, c, d].map((data) => data.toString("hex"));
        expect(new Set(all).size).toBe(4);
    });
});

describe("isConfigEnvelope()", () => {
    const good: ConfigEnvelope = { $enc: 1, kid: "a1", iv: "aXY=", ct: "Y3Q=", tag: "dGFn" };

    it("matches exactly the five keys", () => {
        expect(isConfigEnvelope(good)).toBe(true);
    });

    it.each([
        ["nothing", undefined],
        ["null", null],
        ["text", "text"],
        ["a number", 5],
        ["an array", [good]],
        ["the mask", { secret: true }],
        ["an extra key", { ...good, extra: 1 }],
        ["a missing key", { $enc: 1, kid: "a1", iv: "aXY=", ct: "Y3Q=" }],
        ["another version", { ...good, $enc: 2 }],
        ["a version as text", { ...good, $enc: "1" }],
        ["a kid that is not text", { ...good, kid: 1 }],
        ["an iv that is not text", { ...good, iv: 1 }],
        ["a ct that is not text", { ...good, ct: null }],
        ["a tag that is not text", { ...good, tag: {} }],
    ])("refuses %s", (_name, value) => {
        expect(isConfigEnvelope(value)).toBe(false);
    });
});

describe("ConfigCipher encryption", () => {
    it("encrypts a value into an envelope of exactly the five keys, under the keyring's key", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        const envelope = cipher.encrypt("super-secret-token", CONTEXT);
        expect(Object.keys(envelope).sort()).toEqual(["$enc", "ct", "iv", "kid", "tag"]);
        expect(envelope.$enc).toBe(1);
        expect(envelope.kid).toBe(OLD.kid);
        expect(Buffer.from(envelope.iv, "base64")).toHaveLength(12);
        expect(Buffer.from(envelope.tag, "base64")).toHaveLength(16);
        expect(JSON.stringify(envelope)).not.toContain("super-secret-token");
        expect(Buffer.from(envelope.ct, "base64").toString("utf-8")).not.toContain("super-secret-token");
        expect(cipher.isEnvelope(envelope)).toBe(true);
    });

    it("is AES-256-GCM over the UTF-8 JSON of the value, bound to the context", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        const envelope = cipher.encrypt("token", CONTEXT);
        const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(KEY_OLD, "base64"), Buffer.from(envelope.iv, "base64"), { authTagLength: 16 });
        decipher.setAAD(configAssociatedData(CONTEXT));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ct, "base64")), decipher.final()]).toString("utf-8");
        expect(plain).toBe('"token"');
    });

    it("uses a new nonce for every value, so equal values encrypt differently", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        const a = cipher.encrypt("same", CONTEXT);
        const b = cipher.encrypt("same", CONTEXT);
        expect(a.iv).not.toBe(b.iv);
        expect(a.ct).not.toBe(b.ct);
    });

    it("hands a text, a number and a flag back as themselves", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        for (const value of ["text", "", "ünïcödé \u0000 with \n lines", 0, 42, -1.5, true, false]) {
            expect(cipher.decrypt(cipher.encrypt(value, CONTEXT), CONTEXT)).toBe(value);
        }
    });

    it("refuses a value that isn't a text, number or flag", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        for (const value of [undefined, null, {}, [], () => 1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => cipher.encrypt(value as any, CONTEXT)).toThrow(TypeError);
        }
    });

    it("answers 503 when it has no key to encrypt with, saying nothing of the value", async () => {
        const { cipher } = await newCipher({});
        let thrown: any;
        try {
            cipher.encrypt("token-value", CONTEXT);
        } catch (err) {
            thrown = err;
        }
        expect(thrown).toBeInstanceOf(ApiError);
        expect(thrown.status).toBe(503);
        expect(thrown.message).not.toContain("token-value");
    });
});

describe("ConfigCipher decryption", () => {
    it("decrypts with whichever key the envelope's kid names", async () => {
        const first = await newCipher({ keyring: ringOf(OLD) });
        const sealedWithOld = first.cipher.encrypt("old-secret", CONTEXT);
        const both = await newCipher({ keyring: ringOf(OLD, NEW) });
        const sealedWithNew = (await newCipher({ keyring: ringOf(NEW) }, false)).cipher.encrypt("new-secret", CONTEXT);
        expect(sealedWithOld.kid).toBe(OLD.kid);
        expect(sealedWithNew.kid).toBe(NEW.kid);
        expect(both.cipher.decrypt(sealedWithOld, CONTEXT)).toBe("old-secret");
        expect(both.cipher.decrypt(sealedWithNew, CONTEXT)).toBe("new-secret");
    });

    it.each([
        ["another record type", { ...CONTEXT, record: "Plugin" }],
        ["another row", { ...CONTEXT, uid: "cloudflare-2" }],
        ["another field", { ...CONTEXT, field: "credentials.zoneId" }],
    ])("fails for %s, so a moved envelope reveals nothing", async (_name, other) => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        const envelope = cipher.encrypt("moved-secret", CONTEXT);
        const error = unavailableFrom(() => cipher.decrypt(envelope, other));
        expect(error.reason).toBe("failed");
    });

    it.each([
        ["ciphertext", (e: ConfigEnvelope) => altered(e, { ct: flipFirstByte(e.ct) })],
        ["tag", (e: ConfigEnvelope) => altered(e, { tag: flipFirstByte(e.tag) })],
        ["nonce", (e: ConfigEnvelope) => altered(e, { iv: flipFirstByte(e.iv) })],
    ])("fails when a byte of the %s changed", async (_name, tamper) => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        const envelope = cipher.encrypt("tampered-secret", CONTEXT);
        expect(unavailableFrom(() => cipher.decrypt(tamper(envelope), CONTEXT)).reason).toBe("failed");
    });

    it("fails when the envelope names another key of the ring", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD, NEW) });
        const envelope = cipher.encrypt("secret", CONTEXT);
        const other = envelope.kid === OLD.kid ? NEW.kid : OLD.kid;
        expect(unavailableFrom(() => cipher.decrypt(altered(envelope, { kid: other }), CONTEXT)).reason).toBe("failed");
    });

    it("fails for a kid the keyring doesn't hold, naming the kid", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        const envelope = altered(cipher.encrypt("secret", CONTEXT), { kid: "f00dbabe" });
        const error = unavailableFrom(() => cipher.decrypt(envelope, CONTEXT));
        expect(error.reason).toBe("unknown_key");
        expect(error.message).toContain("f00dbabe");
    });

    it.each([
        ["not an envelope", "just text"],
        ["another version", { $enc: 2, kid: OLD.kid, iv: "aXY=", ct: "Y3Q=", tag: "dGFn" }],
        ["a nonce of the wrong length", { $enc: 1, kid: OLD.kid, iv: Buffer.alloc(8).toString("base64"), ct: "Y3Q=", tag: Buffer.alloc(16).toString("base64") }],
        ["a tag of the wrong length", { $enc: 1, kid: OLD.kid, iv: Buffer.alloc(12).toString("base64"), ct: "Y3Q=", tag: Buffer.alloc(8).toString("base64") }],
        ["a nonce that isn't base64", { $enc: 1, kid: OLD.kid, iv: "!!!!", ct: "Y3Q=", tag: Buffer.alloc(16).toString("base64") }],
        ["a tag that isn't base64", { $enc: 1, kid: OLD.kid, iv: Buffer.alloc(12).toString("base64"), ct: "Y3Q=", tag: "????" }],
        ["a ciphertext that isn't base64", { $enc: 1, kid: OLD.kid, iv: Buffer.alloc(12).toString("base64"), ct: "%%%%", tag: Buffer.alloc(16).toString("base64") }],
    ])("fails for %s", async (_name, value) => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        expect(unavailableFrom(() => cipher.decrypt(value, CONTEXT)).reason).toBe("invalid");
    });

    it("fails for a value that decrypts to something other than a text, number or flag", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        for (const json of ['{"a":1}', "null", "[1]", "not json"]) {
            const iv = crypto.randomBytes(12);
            const sealer = crypto.createCipheriv("aes-256-gcm", Buffer.from(KEY_OLD, "base64"), iv, { authTagLength: 16 });
            sealer.setAAD(configAssociatedData(CONTEXT));
            const ct = Buffer.concat([sealer.update(json, "utf-8"), sealer.final()]);
            const envelope: ConfigEnvelope = { $enc: 1, kid: OLD.kid, iv: iv.toString("base64"), ct: ct.toString("base64"), tag: sealer.getAuthTag().toString("base64") };
            expect(unavailableFrom(() => cipher.decrypt(envelope, CONTEXT)).reason).toBe("invalid");
        }
    });

    it("hands a text back from decryptString()", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        expect(cipher.decryptString(cipher.encrypt("token", CONTEXT), CONTEXT)).toBe("token");
        expect(cipher.decryptString(cipher.encrypt("", CONTEXT), CONTEXT)).toBe("");
    });

    it("fails decryptString() for a number or a flag instead of returning one as a text", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        for (const value of [5, 0, true, false]) {
            const error = unavailableFrom(() => cipher.decryptString(cipher.encrypt(value, CONTEXT), CONTEXT));
            expect(error.reason).toBe("invalid");
            expect(error.field).toBe("credentials.apiToken");
        }
    });

    it("fails decryptString() the way decrypt() does for another field", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        const envelope = cipher.encrypt("token", CONTEXT);
        expect(unavailableFrom(() => cipher.decryptString(envelope, { ...CONTEXT, field: "credentials.other" })).reason).toBe("failed");
    });

    it("names the record and field in the error, never the value, the key or the envelope", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        const envelope = cipher.encrypt("plain-secret-value", CONTEXT);
        const error = unavailableFrom(() => cipher.decrypt(altered(envelope, { ct: flipFirstByte(envelope.ct) }), { ...CONTEXT, field: "credentials.other" }));
        expect(error.record).toBe("DnsProvider");
        expect(error.uid).toBe("cloudflare-1");
        expect(error.field).toBe("credentials.other");
        expect(error.message).toContain("DnsProvider");
        expect(error.message).toContain("credentials.other");
        for (const secret of ["plain-secret-value", KEY_OLD, envelope.ct, envelope.iv, envelope.tag]) {
            expect(error.message).not.toContain(secret);
        }
        expect(error.name).toBe("ConfigSecretUnavailableError");
    });

    it("fails with no keyring loaded at all", async () => {
        const { cipher } = await newCipher({});
        const envelope: ConfigEnvelope = { $enc: 1, kid: OLD.kid, iv: Buffer.alloc(12).toString("base64"), ct: "Y3Q=", tag: Buffer.alloc(16).toString("base64") };
        expect(unavailableFrom(() => cipher.decrypt(envelope, CONTEXT)).reason).toBe("unknown_key");
    });
});

function flipFirstByte(base64: string): string {
    const bytes = Buffer.from(base64, "base64");
    bytes[0] ^= 0xff;
    return bytes.toString("base64");
}

describe("ConfigCipher active key", () => {
    it("encrypts with the only key of a deployment that never rotated", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        expect(cipher.currentKid()).toBe(OLD.kid);
    });

    it("encrypts with the oldest key until a rotation has activated another, so a key just added to the ring never encrypts early", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(NEW, OLD, MID) });
        expect(cipher.currentKid()).toBe(OLD.kid);
        expect(cipher.encrypt("x", CONTEXT).kid).toBe(OLD.kid);
    });

    it("treats a null or unset activeKid as none", async () => {
        const { cipher, state } = await newCipher({ keyring: ringOf(OLD, MID) });
        state.activeKid = null;
        await cipher.reload();
        expect(cipher.currentKid()).toBe(OLD.kid);
    });

    it("has no current key without a keyring", async () => {
        const { cipher } = await newCipher({});
        expect(cipher.currentKid()).toBeUndefined();
    });

    it("reads the active kid when it starts", async () => {
        const harness = await newCipher({ keyring: ringOf(OLD, NEW) }, false);
        expect(harness.cipher.currentKid()).toBe(OLD.kid);
        const cipher: any = new ConfigCipher();
        cipher.keyring = ringOf(OLD, NEW);
        cipher.stateRepo = { findOne: async () => ({ activeKid: NEW.kid }) };
        await cipher.init();
        live.push(cipher);
        expect(cipher.currentKid()).toBe(NEW.kid);
    });
});

describe("ConfigCipher reloading", () => {
    let dir: string;
    let file: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "cipher-"));
        file = path.join(dir, "keyring.json");
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const write = (ring: ConfigKeyring): void => {
        fs.writeFileSync(file, serializeConfigKeyring(ring));
    };

    it("loads the keyring file when it starts", async () => {
        write(ringOf(OLD));
        const { cipher } = await newCipher({ keyringFile: file });
        expect(cipher.currentKid()).toBe(OLD.kid);
    });

    it("re-reads the file every minute", async () => {
        write(ringOf(OLD));
        vi.useFakeTimers();
        const { cipher, state } = await newCipher({ keyringFile: file });
        write(ringOf(OLD, NEW));
        state.activeKid = NEW.kid;
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS - 1);
        expect(cipher.currentKid()).toBe(OLD.kid);
        await vi.advanceTimersByTimeAsync(1);
        expect(cipher.currentKid()).toBe(NEW.kid);
        expect(CONFIG_RELOAD_INTERVAL_MS).toBe(60_000);
    });

    it("re-reads the active kid on the same schedule", async () => {
        write(ringOf(OLD, NEW));
        vi.useFakeTimers();
        const { cipher, state } = await newCipher({ keyringFile: file });
        expect(cipher.currentKid()).toBe(OLD.kid);
        state.activeKid = NEW.kid;
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS);
        expect(cipher.currentKid()).toBe(NEW.kid);
    });

    it("re-reads at once when told a rotation happened", async () => {
        write(ringOf(OLD));
        const { cipher, state } = await newCipher({ keyringFile: file });
        write(ringOf(OLD, NEW));
        state.activeKid = NEW.kid;
        await cipher.reload();
        expect(cipher.currentKid()).toBe(NEW.kid);
    });

    it("keeps encrypting with the original key when a process reloads a ring a first rotation has added to, before the key is activated", async () => {
        write(ringOf(OLD));
        const { cipher } = await newCipher({ keyringFile: file });
        write(ringOf(OLD, NEW));
        await cipher.reload();
        expect(cipher.decrypt(await sealedBy([NEW], "y"), CONTEXT)).toBe("y");
        expect(cipher.encrypt("x", CONTEXT).kid).toBe(OLD.kid);
        // A copy that hasn't reloaded yet (it still holds only the original key) can read it.
        expect((await newCipher({ keyring: ringOf(OLD) }, false)).cipher.decrypt(cipher.encrypt("x", CONTEXT), CONTEXT)).toBe("x");
    });

    it("encrypts with ConfigKeyState.activeKid when it is in the ring, even when a newer key is waiting to be activated", async () => {
        const { cipher, state } = await newCipher({ keyring: ringOf(OLD, NEW) });
        state.activeKid = OLD.kid;
        await cipher.reload();
        expect(cipher.currentKid()).toBe(OLD.kid);
        expect(cipher.encrypt("x", CONTEXT).kid).toBe(OLD.kid);
        state.activeKid = NEW.kid;
        await cipher.reload();
        expect(cipher.currentKid()).toBe(NEW.kid);
    });

    it("falls back to the newest key when activeKid isn't in the ring (a copy that hasn't loaded the key yet)", async () => {
        const { cipher, state } = await newCipher({ keyring: ringOf(OLD, MID) });
        state.activeKid = NEW.kid;
        await cipher.reload();
        expect(cipher.currentKid()).toBe(MID.kid);
    });

    it("drops a key the new ring no longer holds", async () => {
        write(ringOf(OLD, NEW));
        const { cipher } = await newCipher({ keyringFile: file });
        const sealedWithOld = await sealedBy([OLD], "x");
        expect(cipher.decrypt(sealedWithOld, CONTEXT)).toBe("x");
        write(ringOf(NEW));
        await cipher.reload();
        expect(unavailableFrom(() => cipher.decrypt(sealedWithOld, CONTEXT)).reason).toBe("unknown_key");
    });

    it("reads the file again for an envelope naming a kid it doesn't have, then decrypts it", async () => {
        write(ringOf(OLD));
        const { cipher } = await newCipher({ keyringFile: file });
        const sealedWithNew = await sealedBy([NEW], "from-another-copy");
        expect(sealedWithNew.kid).toBe(NEW.kid);
        write(ringOf(OLD, NEW));
        expect(cipher.decrypt(sealedWithNew, CONTEXT)).toBe("from-another-copy");
    });

    it("does that at most once a minute, whoever asks", async () => {
        write(ringOf(OLD));
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
        const { cipher } = await newCipher({ keyringFile: file });
        const sealedWithMid = await sealedBy([MID], "secret");
        const sealedWithNew = await sealedBy([NEW], "secret");

        // The first unknown kid reads the file, which doesn't hold it yet.
        expect(unavailableFrom(() => cipher.decrypt(sealedWithMid, CONTEXT)).reason).toBe("unknown_key");
        // The key arrives a moment later; another unknown kid within the minute doesn't read the file.
        write(ringOf(OLD, MID, NEW));
        vi.setSystemTime(new Date("2026-10-28T12:00:59Z"));
        expect(unavailableFrom(() => cipher.decrypt(sealedWithNew, CONTEXT)).reason).toBe("unknown_key");
        // A minute after the first read it does.
        vi.setSystemTime(new Date("2026-10-28T12:01:00Z"));
        expect(cipher.decrypt(sealedWithNew, CONTEXT)).toBe("secret");
        expect(cipher.decrypt(sealedWithMid, CONTEXT)).toBe("secret");
    });

    it("doesn't read the file for a kid it has", async () => {
        write(ringOf(OLD));
        const { cipher } = await newCipher({ keyringFile: file });
        const envelope = cipher.encrypt("x", CONTEXT);
        fs.rmSync(file);
        expect(cipher.decrypt(envelope, CONTEXT)).toBe("x");
    });

    it("has nothing to re-read for an inline keyring, which cannot change", async () => {
        const { cipher } = await newCipher({ keyring: ringOf(OLD) });
        const envelope = altered(cipher.encrypt("x", CONTEXT), { kid: NEW.kid });
        expect(unavailableFrom(() => cipher.decrypt(envelope, CONTEXT)).reason).toBe("unknown_key");
        await cipher.reload();
        expect(cipher.currentKid()).toBe(OLD.kid);
    });

    it("keeps the keyring it has when the file turns unusable, and says so once", async () => {
        write(ringOf(OLD));
        vi.useFakeTimers();
        const { cipher, logger, state } = await newCipher({ keyringFile: file });
        const envelope = cipher.encrypt("still-readable", CONTEXT);
        fs.writeFileSync(file, '{"keys": [{"kid": "x", "key": "partial-key-material"');
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS * 3);
        expect(cipher.decrypt(envelope, CONTEXT)).toBe("still-readable");
        expect(cipher.currentKid()).toBe(OLD.kid);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("partial-key-material");
        expect(JSON.stringify(logger.warn.mock.calls)).toContain("config_encryption:keyring_file");
        // Fixed, then broken again: it says so again.
        write(ringOf(OLD, NEW));
        state.activeKid = NEW.kid;
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS);
        expect(cipher.currentKid()).toBe(NEW.kid);
        fs.rmSync(file);
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS);
        expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("logs that it has no usable keyring when it starts with none, and can encrypt nothing", async () => {
        file = path.join(dir, "missing.json");
        const { cipher, logger } = await newCipher({ keyringFile: file });
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(cipher.currentKid()).toBeUndefined();
        expect(() => cipher.encrypt("x", CONTEXT)).toThrow(ApiError);
        // A keyring that shows up later is picked up.
        write(ringOf(OLD));
        await cipher.reload();
        expect(cipher.currentKid()).toBe(OLD.kid);
    });

    it("says nothing when it is given no keyring at all, which is the server's guard to refuse in production", async () => {
        const { logger } = await newCipher({});
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it("keeps the last active kid when the key state can't be read, and says so once", async () => {
        write(ringOf(OLD, NEW));
        const { cipher, logger, state } = await newCipher({ keyringFile: file });
        state.activeKid = OLD.kid;
        await cipher.reload();
        expect(cipher.currentKid()).toBe(OLD.kid);
        state.failWith = new Error("datastore unavailable");
        await cipher.reload();
        await cipher.reload();
        expect(cipher.currentKid()).toBe(OLD.kid);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(logger.warn.mock.calls)).toContain("datastore unavailable");
        state.failWith = undefined;
        await cipher.reload();
        state.failWith = new Error("datastore unavailable");
        await cipher.reload();
        expect(logger.warn).toHaveBeenCalledTimes(2);
    });

    it("doesn't start another periodic reload while the previous one waits on the datastore", async () => {
        write(ringOf(OLD));
        vi.useFakeTimers();
        const { cipher } = await newCipher({ keyringFile: file });
        const findOne: any = (cipher as any).stateRepo.findOne;
        let release: (value: unknown) => void = () => undefined;
        findOne.mockReset();
        findOne.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        findOne.mockResolvedValue(undefined);
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS);
        expect(findOne).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS * 3);
        expect(findOne).toHaveBeenCalledTimes(1);
        release(undefined);
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS);
        expect(findOne).toHaveBeenCalledTimes(2);
    });

    it("runs the periodic reload again after one fails", async () => {
        write(ringOf(OLD));
        vi.useFakeTimers();
        const { cipher, state } = await newCipher({ keyringFile: file });
        state.failWith = new Error("down");
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS);
        state.failWith = undefined;
        write(ringOf(OLD, NEW));
        state.activeKid = NEW.kid;
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS);
        expect(cipher.currentKid()).toBe(NEW.kid);
    });

    it("discards an older read of the active kid that finishes after a newer one", async () => {
        write(ringOf(OLD, NEW));
        const { cipher } = await newCipher({ keyringFile: file });
        const findOne: any = (cipher as any).stateRepo.findOne;
        let releaseOlder: (value: unknown) => void = () => undefined;
        findOne.mockReset();
        // The older read waits (it was made before the activation); the newer one is answered at once (after it).
        findOne.mockImplementationOnce(() => new Promise((resolve) => (releaseOlder = resolve)));
        findOne.mockResolvedValueOnce({ activeKid: NEW.kid });
        const older = cipher.reload();
        await cipher.reload();
        expect(cipher.currentKid()).toBe(NEW.kid);
        releaseOlder({ activeKid: OLD.kid });
        await older;
        expect(cipher.currentKid()).toBe(NEW.kid);
    });

    it("never throws from a reload", async () => {
        write(ringOf(OLD));
        const { cipher, state } = await newCipher({ keyringFile: file });
        fs.rmSync(file);
        state.failWith = new Error("down");
        await expect(cipher.reload()).resolves.toBeUndefined();
    });

    it("stops reloading once disposed", async () => {
        write(ringOf(OLD));
        vi.useFakeTimers();
        const { cipher } = await newCipher({ keyringFile: file });
        await cipher.dispose();
        write(ringOf(OLD, NEW));
        await vi.advanceTimersByTimeAsync(CONFIG_RELOAD_INTERVAL_MS * 2);
        expect(cipher.currentKid()).toBe(OLD.kid);
        // Disposing twice is harmless.
        await expect(cipher.dispose()).resolves.toBeUndefined();
    });

    it("doesn't keep the process alive for its timer", async () => {
        write(ringOf(OLD));
        const { cipher } = await newCipher({ keyringFile: file });
        const timer: any = (cipher as any).timer;
        expect(timer.hasRef()).toBe(false);
    });

    it("reads no key state when it has no repository for one", async () => {
        write(ringOf(OLD, NEW));
        const { cipher } = await newCipher({ keyringFile: file }, false);
        await cipher.reload();
        expect(cipher.currentKid()).toBe(OLD.kid);
    });

    it("never logs key material", async () => {
        write(ringOf(OLD));
        const { cipher, logger } = await newCipher({ keyringFile: file });
        fs.writeFileSync(file, serializeConfigKeyring(ringOf({ ...OLD, key: "AAAA" })));
        await cipher.reload();
        const logged = JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, logger.info.mock.calls, logger.debug.mock.calls]);
        expect(logged).not.toContain(KEY_OLD);
        expect(logged).not.toContain("AAAA");
    });
});
