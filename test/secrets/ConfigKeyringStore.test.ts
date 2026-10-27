///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// `FileConfigKeyringStore` (spec 5.5, 5.3): the keyring read with a version and written back only if that version is still the file's, which is how a
// rotation's step never overwrites a ring another writer changed. The server's Kubernetes and OpenBao stores implement the same interface.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generateConfigKey, parseConfigKeyring, serializeConfigKeyring, type ConfigKeyring } from "../../src/secrets/ConfigKeyring.js";
import {
    ConfigKeyringConflictError,
    ConfigKeyringInvalidError,
    FileConfigKeyringStore,
    resolveConfigKeyringStore,
} from "../../src/secrets/ConfigKeyringStore.js";

// The rename that puts a new ring in place is the one call a test can't make fail with a real fault on every platform.
vi.mock("fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("fs")>();
    return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

let dir: string;
let file: string;

function ringOf(count: number): ConfigKeyring {
    return { keys: Array.from({ length: count }, () => generateConfigKey()) };
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-keyring-store-"));
    file = path.join(dir, "keyring.json");
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("FileConfigKeyringStore", () => {
    it("reads the keyring with a version", async () => {
        const ring = ringOf(2);
        fs.writeFileSync(file, serializeConfigKeyring(ring));
        const snapshot = await new FileConfigKeyringStore(file).read();
        expect(snapshot.keyring).toEqual(ring);
        expect(typeof snapshot.version).toBe("string");
        expect(snapshot.version.length).toBeGreaterThan(0);
        expect(await new FileConfigKeyringStore(file).read()).toEqual(snapshot);
    });

    it("gives a different version once the file's content changes", async () => {
        fs.writeFileSync(file, serializeConfigKeyring(ringOf(1)));
        const store = new FileConfigKeyringStore(file);
        const before = await store.read();
        fs.writeFileSync(file, serializeConfigKeyring(ringOf(1)));
        expect((await store.read()).version).not.toBe(before.version);
    });

    it("writes the new ring when the version is still the file's, and gives the next read a new version", async () => {
        const original = ringOf(1);
        fs.writeFileSync(file, serializeConfigKeyring(original));
        const store = new FileConfigKeyringStore(file);
        const snapshot = await store.read();
        const next: ConfigKeyring = { keys: [...original.keys, generateConfigKey()] };

        await store.write(next, snapshot.version);

        const after = await store.read();
        expect(after.keyring).toEqual(next);
        expect(after.version).not.toBe(snapshot.version);
        expect(parseConfigKeyring(fs.readFileSync(file, "utf-8"))).toEqual(next);
    });

    it("leaves no temporary file behind and keeps the file readable by its owner only", async () => {
        fs.writeFileSync(file, serializeConfigKeyring(ringOf(1)), { mode: 0o600 });
        const store = new FileConfigKeyringStore(file);
        const snapshot = await store.read();
        await store.write(ringOf(2), snapshot.version);
        expect(fs.readdirSync(dir)).toEqual(["keyring.json"]);
        if (process.platform !== "win32") {
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
    });

    it("refuses a write against a version another writer has replaced, leaving that writer's ring", async () => {
        fs.writeFileSync(file, serializeConfigKeyring(ringOf(1)));
        const store = new FileConfigKeyringStore(file);
        const stale = await store.read();
        const theirs = ringOf(2);
        fs.writeFileSync(file, serializeConfigKeyring(theirs));

        await expect(store.write(ringOf(3), stale.version)).rejects.toBeInstanceOf(ConfigKeyringConflictError);
        expect(parseConfigKeyring(fs.readFileSync(file, "utf-8"))).toEqual(theirs);
        expect(fs.readdirSync(dir)).toEqual(["keyring.json"]);
    });

    it("refuses to write a ring that isn't a usable keyring", async () => {
        fs.writeFileSync(file, serializeConfigKeyring(ringOf(1)));
        const store = new FileConfigKeyringStore(file);
        const snapshot = await store.read();
        await expect(store.write({ keys: [] }, snapshot.version)).rejects.toBeInstanceOf(ConfigKeyringInvalidError);
        expect((await store.read()).version).toBe(snapshot.version);
    });

    it("calls a malformed file invalid, never repeating what it holds", async () => {
        fs.writeFileSync(file, '{"keys": [{"kid": "secret-looking", "key": "hunter2"}]}');
        const store = new FileConfigKeyringStore(file);
        const error: Error = await store.read().then(
            () => new Error("expected a refusal"),
            (err) => err,
        );
        expect(error).toBeInstanceOf(ConfigKeyringInvalidError);
        expect(error.message).not.toContain("hunter2");
    });

    it("reports a file it can't read as an ordinary error, not an invalid keyring", async () => {
        const error: Error = await new FileConfigKeyringStore(path.join(dir, "missing.json")).read().then(
            () => new Error("expected a refusal"),
            (err) => err,
        );
        expect(error).not.toBeInstanceOf(ConfigKeyringInvalidError);
        expect(error.message).toContain("ENOENT");
        await expect(new FileConfigKeyringStore(path.join(dir, "missing.json")).write(ringOf(1), "any")).rejects.toThrow("ENOENT");
    });

    it("has nothing to read without a file configured", async () => {
        await expect(new FileConfigKeyringStore().read()).rejects.toThrow("config_encryption:keyring_file");
        await expect(new FileConfigKeyringStore("  ").write(ringOf(1), "v")).rejects.toThrow("config_encryption:keyring_file");
    });

    it("takes its file from config_encryption:keyring_file when none is given", async () => {
        fs.writeFileSync(file, serializeConfigKeyring(ringOf(1)));
        const store: any = new FileConfigKeyringStore();
        store.configuredFile = file;
        expect((await store.read()).keyring.keys).toHaveLength(1);
    });
});

describe("FileConfigKeyringStore when the ring can't be put in place", () => {
    it("removes its temporary file and says what failed, leaving the ring as it was", async () => {
        fs.writeFileSync(file, serializeConfigKeyring(ringOf(1)));
        const store = new FileConfigKeyringStore(file);
        const snapshot = await store.read();
        vi.mocked(fs.renameSync).mockImplementationOnce(() => {
            throw Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
        });
        await expect(store.write(ringOf(2), snapshot.version)).rejects.toThrow("EXDEV");
        expect(fs.readdirSync(dir)).toEqual(["keyring.json"]);
        expect((await store.read()).version).toBe(snapshot.version);
        await store.write(ringOf(2), snapshot.version);
        expect((await store.read()).keyring.keys).toHaveLength(2);
    });

    it("names an error without a code as unknown", async () => {
        fs.writeFileSync(file, serializeConfigKeyring(ringOf(1)));
        const store = new FileConfigKeyringStore(file);
        const snapshot = await store.read();
        vi.mocked(fs.renameSync).mockImplementationOnce(() => {
            throw new Error("no code");
        });
        await expect(store.write(ringOf(2), snapshot.version)).rejects.toThrow("unknown error");
    });
});

describe("resolveConfigKeyringStore()", () => {
    const logger = () => ({ warn: vi.fn() });

    it("has no store for the none backend", async () => {
        expect(await resolveConfigKeyringStore({ newInstance: vi.fn() }, "none")).toBeUndefined();
    });

    it("builds the file store through the object factory, or directly without one", async () => {
        const built = new FileConfigKeyringStore("x");
        const factory: any = { newInstance: vi.fn(async () => built) };
        expect(await resolveConfigKeyringStore(factory, "file")).toBe(built);
        expect(factory.newInstance).toHaveBeenCalledWith(FileConfigKeyringStore, { name: "default" });
        expect(await resolveConfigKeyringStore(undefined, "file")).toBeInstanceOf(FileConfigKeyringStore);
    });

    it.each(["kubernetes", "openbao"])("uses what the server registered for the %s backend", async (backend) => {
        const registered = { read: vi.fn(), write: vi.fn() };
        const factory: any = { newInstance: vi.fn(async () => registered) };
        expect(await resolveConfigKeyringStore(factory, backend)).toBe(registered);
        expect(factory.newInstance).toHaveBeenCalledWith("ConfigKeyringStore", { name: "default" });
    });

    it.each(["kubernetes", "openbao"])("has no store, saying so, when nothing is registered for the %s backend", async (backend) => {
        const log = logger();
        const failing: any = {
            newInstance: vi.fn(async () => {
                throw new Error("no such type");
            }),
        };
        expect(await resolveConfigKeyringStore(failing, backend, log)).toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("no such type"));
        const empty: any = { newInstance: vi.fn(async () => undefined) };
        expect(await resolveConfigKeyringStore(empty, backend, log)).toBeUndefined();
        expect(await resolveConfigKeyringStore(undefined, backend)).toBeUndefined();
        expect(log.warn).toHaveBeenCalledTimes(2);
    });

    it("has no store, saying so, for a backend it doesn't know", async () => {
        const log = logger();
        expect(await resolveConfigKeyringStore(undefined, "vault", log)).toBeUndefined();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("'vault'"));
        expect(await resolveConfigKeyringStore(undefined, "vault")).toBeUndefined();
    });
});
