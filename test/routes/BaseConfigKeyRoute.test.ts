///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Isolated unit tests for what HTTP can't reach on `BaseConfigKeyRoute`: its `@Init` hook, a server that can't write the keyring (503), the lost races
// around saving the state and the notice that can't be sent. The routes themselves are tested over HTTP on both backends in test/routes/configKeysSuite.ts.
import { ApiError } from "@rapidrest/core";
import { ApiErrors } from "@rapidrest/service-core";
import { BaseConfigKeyRoute } from "../../src/routes/BaseConfigKeyRoute.js";
import { LocalConfigKeyChannel } from "../../src/secrets/ConfigKeyChannel.js";
import { CONFIG_KEY_STATE_UID } from "../../src/secrets/ConfigKeyring.js";

class StateModel {
    constructor(fields: any) {
        Object.assign(this, fields);
    }
}

class TestConfigKeyRoute extends (BaseConfigKeyRoute as any) {
    protected configKeyStateClass: any = StateModel;
    protected auditLogClass: any = class AuditModel {};
}

const admin: any = { uid: "admin-1", roles: ["admin"], elevated: Date.now() };
const lostRace = () => new ApiError(ApiErrors.INVALID_OBJECT_VERSION, 409, "stale");

/** A state repository in memory with `RepoUtils`' optimistic lock; `failures` are thrown by the next updates or creates, in order. */
function memoryRepo(initial?: any): any {
    const repo: any = {
        row: initial ? structuredClone(initial) : undefined,
        updateFailures: [] as any[],
        createFailures: [] as any[],
        findOne: vi.fn(async () => (repo.row ? structuredClone(repo.row) : undefined)),
        create: vi.fn(async (obj: any) => {
            if (repo.createFailures.length > 0) {
                throw repo.createFailures.shift();
            }
            repo.row = { ...structuredClone({ ...obj }), version: 0 };
            return structuredClone(repo.row);
        }),
        update: vi.fn(async (obj: any) => {
            if (repo.updateFailures.length > 0) {
                throw repo.updateFailures.shift();
            }
            repo.row = { ...repo.row, ...structuredClone(obj), version: repo.row.version + 1 };
            return structuredClone(repo.row);
        }),
    };
    return repo;
}

function routeWith(repo: any = memoryRepo(), overrides: Record<string, unknown> = {}): any {
    const route: any = new TestConfigKeyRoute();
    route.stateRepo = repo;
    route.auditLogUtils = { record: vi.fn() };
    route.keyringStore = { read: vi.fn(), write: vi.fn() };
    route.channel = new LocalConfigKeyChannel();
    route.cipher = { currentKid: () => "k1", keyInfo: () => [{ kid: "k1", createdAt: "2026-01-01T00:00:00.000Z", active: true }] };
    Object.defineProperty(route, "logger", { value: { warn: vi.fn(), error: vi.fn() }, configurable: true });
    Object.assign(route, overrides);
    return route;
}

function fakeResponse(): any {
    const res: any = { status: vi.fn(() => res), json: vi.fn(() => res) };
    return res;
}

const running = (extra: Record<string, unknown> = {}) => ({
    uid: CONFIG_KEY_STATE_UID,
    version: 4,
    rotation: { previousKids: [], compromised: false, requestedBy: "admin-0", requestedAt: new Date(), phase: "adding", ...extra },
});

describe("BaseConfigKeyRoute initialize()", () => {
    function withFactory(route: any): any {
        const factory: any = { newInstance: vi.fn(async (type: any, opts: any) => ({ type, opts })) };
        Object.defineProperty(route, "_objectFactory", { value: factory, writable: true, configurable: true });
        return factory;
    }

    it("throws when the objectFactory is not set", async () => {
        await expect((new TestConfigKeyRoute() as any).initialize()).rejects.toThrow("objectFactory is not set.");
    });

    it("builds its repositories and takes its keyring store and channel from the object factory", async () => {
        const route: any = new TestConfigKeyRoute();
        const channel = new LocalConfigKeyChannel();
        const store = { read: vi.fn(), write: vi.fn() };
        const factory = withFactory(route);
        factory.newInstance = vi.fn(async (type: any, opts: any) => (type === "ConfigKeyChannel" ? channel : type === "ConfigKeyringStore" ? store : { type, opts }));
        route.keyringBackend = "kubernetes";
        route.logger = { warn: vi.fn() };

        await route.initialize();

        expect(route.stateRepo.opts.name).toBe("StateModel");
        expect(route.auditLogRepo.opts.name).toBe("AuditModel");
        expect(route.auditLogUtils.opts.name).toBe("AuditModel");
        expect(route.keyringStore).toBe(store);
        expect(route.channel).toBe(channel);
    });

    it("has no keyring store for the none backend, and builds nothing it has no model for", async () => {
        const route: any = new TestConfigKeyRoute();
        withFactory(route);
        route.configKeyStateClass = undefined;
        route.auditLogClass = undefined;
        route.keyringBackend = "none";
        route.channel = new LocalConfigKeyChannel();
        await route.initialize();
        expect(route.keyringStore).toBeUndefined();
        expect(route.stateRepo).toBeUndefined();
        expect(route.auditLogRepo).toBeUndefined();
        expect(route.auditLogUtils).toBeUndefined();
    });
});

describe("BaseConfigKeyRoute view", () => {
    it("says rotation is unavailable without a keyring store, and shows no keys without a cipher", async () => {
        const route = routeWith(memoryRepo(), { keyringStore: undefined, cipher: undefined });
        expect(await route.get()).toEqual({
            available: false,
            activeKid: null,
            keys: [],
            countedAt: null,
            rotation: null,
            reencryption: null,
            pluginSecrets: null,
        });
    });

    it("counts a key no envelope uses as zero once the envelopes have been counted", async () => {
        const route = routeWith(memoryRepo({ uid: CONFIG_KEY_STATE_UID, version: 1, kidUsage: {} }));
        expect((await route.get()).keys[0].envelopes).toBe(0);
    });

    it("warns after 15 minutes when the warning time isn't a positive number", async () => {
        const state = running({ phase: "activating", kid: "k2", waitingFor: ["pod-b:2"], activationStartedAt: new Date(Date.now() - 16 * 60_000) });
        const route = routeWith(memoryRepo(state), { warnMinutes: "never" });
        expect((await route.get()).rotation.warning).toContain("15 minutes");
    });
});

describe("BaseConfigKeyRoute rotate()", () => {
    it("answers 503 when the keyring can't be written, without recording anything", async () => {
        const repo = memoryRepo();
        const route = routeWith(repo, { keyringStore: undefined });
        const error: ApiError = await route.rotate({}, {}, fakeResponse(), admin).then(
            () => new ApiError(ApiErrors.INVALID_REQUEST, 0, "expected a refusal"),
            (err: ApiError) => err,
        );
        expect(error.status).toBe(503);
        expect(error.message).toContain("keyring_store:backend");
        expect(repo.create).not.toHaveBeenCalled();
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("answers 503 in production without a Redis channel, rotation being unavailable, without recording anything", async () => {
        const repo = memoryRepo();
        const route = routeWith(repo, { channel: undefined });
        expect((await route.get()).available).toBe(false);
        await expect(route.rotate({}, {}, fakeResponse(), admin)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Redis") });
        expect(repo.create).not.toHaveBeenCalled();
    });

    it("answers 503, saying why, when the store can't give the keyring, instead of recording a rotation that could never add its key", async () => {
        const repo = memoryRepo();
        const route = routeWith(repo);
        route.keyringStore.read.mockRejectedValue(new Error("config_encryption:keyring_file isn't set, so the keyring can't be read or changed."));
        await expect(route.rotate({}, {}, fakeResponse(), admin)).rejects.toMatchObject({ status: 503, message: expect.stringContaining("keyring_file isn't set") });
        expect(repo.create).not.toHaveBeenCalled();
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("answers 503 for a keyring that can't be parsed, too, but still marks a running rotation compromised, which needs no read", async () => {
        const repo = memoryRepo(running({ phase: "activating", kid: "k2" }));
        const route = routeWith(repo);
        route.keyringStore.read.mockRejectedValue(new Error("not a keyring"));
        const res = fakeResponse();
        await route.rotate({ compromised: true }, {}, res, admin);
        expect(repo.row.rotation.compromised).toBe(true);
        expect(route.keyringStore.read).not.toHaveBeenCalled();

        const idle = memoryRepo(running({ phase: "done" }));
        const other = routeWith(idle);
        other.keyringStore.read.mockRejectedValue(new Error("not a keyring"));
        await expect(other.rotate({}, {}, fakeResponse(), admin)).rejects.toMatchObject({ status: 503 });
    });

    it("checks the caller before anything else, and a body before the store", async () => {
        const route = routeWith(memoryRepo(), { keyringStore: undefined });
        await expect(route.rotate({}, {}, fakeResponse(), { ...admin, elevated: undefined })).rejects.toMatchObject({ status: 403 });
        await expect(route.rotate({ compromised: "yes" }, {}, fakeResponse(), admin)).rejects.toMatchObject({ status: 400 });
    });

    it("applies a start that lost a race to the row that won, which is then a 409 with that rotation's progress", async () => {
        const repo = memoryRepo(running({ phase: "done" }));
        repo.updateFailures = [lostRace()];
        const route = routeWith(repo);
        // The row the other writer saved is already running when this request looks again.
        repo.update = vi.fn(async () => {
            repo.row = { ...repo.row, rotation: { ...repo.row.rotation, phase: "adding", requestedBy: "someone-else" }, version: repo.row.version + 1 };
            throw lostRace();
        });
        const res = fakeResponse();
        await route.rotate({}, {}, res, admin);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json.mock.calls[0][0].rotation.requestedBy).toBe("someone-else");
        expect(route.auditLogUtils.record).not.toHaveBeenCalled();
    });

    it("gives up with a 409 after three lost races", async () => {
        const repo = memoryRepo(running({ phase: "done" }));
        repo.updateFailures = [lostRace(), lostRace(), lostRace()];
        const route = routeWith(repo);
        const res = fakeResponse();
        await route.rotate({}, {}, res, admin);
        expect(repo.update).toHaveBeenCalledTimes(3);
        expect(res.status).toHaveBeenCalledWith(409);
    });

    it("retries a start that lost a race and then wins", async () => {
        const repo = memoryRepo(running({ phase: "failed" }));
        repo.updateFailures = [lostRace()];
        const route = routeWith(repo);
        const res = fakeResponse();
        await route.rotate({}, {}, res, admin);
        expect(res.status).toHaveBeenCalledWith(202);
        expect(repo.row.rotation.phase).toBe("adding");
    });

    it("looks again when two requests create the row at the same moment, and the later one is told the first's rotation is running", async () => {
        const repo = memoryRepo();
        repo.createFailures = [Object.assign(new Error("E11000 duplicate key error"), { code: 11000 })];
        repo.findOne = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValue(running());
        const route = routeWith(repo);
        const res = fakeResponse();
        await route.rotate({}, {}, res, admin);
        expect(res.status).toHaveBeenCalledWith(409);
    });

    it("lets any other failure to save the request out", async () => {
        const repo = memoryRepo();
        repo.createFailures = [new Error("disk full")];
        const route = routeWith(repo);
        await expect(route.rotate({}, {}, fakeResponse(), admin)).rejects.toThrow("disk full");
        const other = memoryRepo(running({ phase: "done" }));
        other.updateFailures = [new Error("disk full")];
        await expect(routeWith(other).rotate({}, {}, fakeResponse(), admin)).rejects.toThrow("disk full");
    });

    it("looks again when marking a running rotation compromised loses a race, and lets any other failure out", async () => {
        const repo = memoryRepo(running());
        repo.updateFailures = [lostRace()];
        const res = fakeResponse();
        const result = await routeWith(repo).rotate({ compromised: true }, {}, res, admin);
        expect(result.rotation.compromised).toBe(true);
        expect(repo.update).toHaveBeenCalledTimes(2);

        const failing = memoryRepo(running());
        failing.updateFailures = [new Error("disk full")];
        await expect(routeWith(failing).rotate({ compromised: true }, {}, fakeResponse(), admin)).rejects.toThrow("disk full");
    });

    it("still answers when the notice can't be sent, saying so", async () => {
        const route = routeWith(memoryRepo());
        vi.spyOn(route.channel, "notifyChanged").mockRejectedValue(new Error("redis down"));
        const res = fakeResponse();
        await route.rotate({}, {}, res, admin);
        expect(res.status).toHaveBeenCalledWith(202);
        expect(route.logger.warn).toHaveBeenCalledWith(expect.stringContaining("redis down"));
    });
});

describe("BaseConfigKeyRoute activate()", () => {
    const activating = (extra: Record<string, unknown> = {}) => running({ phase: "activating", kid: "k2", activationStartedAt: new Date(), ...extra });

    it("checks the caller, then the body", async () => {
        const route = routeWith(memoryRepo(activating()));
        await expect(route.activate({ kid: "k2" }, {}, fakeResponse(), { ...admin, roles: [] })).rejects.toMatchObject({ status: 403 });
        await expect(route.activate(undefined, {}, fakeResponse(), admin)).rejects.toMatchObject({ status: 400 });
    });

    it("looks again when activating loses a race: the key the other writer activated is then a 409", async () => {
        const repo = memoryRepo(activating());
        repo.update = vi.fn(async () => {
            repo.row = { ...repo.row, activeKid: "k2", rotation: { ...repo.row.rotation, phase: "reencrypting" }, version: repo.row.version + 1 };
            throw lostRace();
        });
        const res = fakeResponse();
        await routeWith(repo).activate({ kid: "k2" }, {}, res, admin);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json.mock.calls[0][0].rotation.phase).toBe("reencrypting");
    });

    it("gives up with a 409 after three lost races", async () => {
        const repo = memoryRepo(activating());
        repo.updateFailures = [lostRace(), lostRace(), lostRace()];
        const res = fakeResponse();
        await routeWith(repo).activate({ kid: "k2" }, {}, res, admin);
        expect(repo.update).toHaveBeenCalledTimes(3);
        expect(res.status).toHaveBeenCalledWith(409);
    });

    it("retries a lost race and then wins, and lets any other failure out", async () => {
        const repo = memoryRepo(activating());
        repo.updateFailures = [lostRace()];
        const route = routeWith(repo);
        const result = await route.activate({ kid: "k2" }, {}, fakeResponse(), admin);
        expect(result.rotation.phase).toBe("reencrypting");
        expect(route.auditLogUtils.record).toHaveBeenCalledTimes(1);

        const failing = memoryRepo(activating());
        failing.updateFailures = [new Error("disk full")];
        await expect(routeWith(failing).activate({ kid: "k2" }, {}, fakeResponse(), admin)).rejects.toThrow("disk full");
    });
});
