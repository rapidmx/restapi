///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// Real HTTP+DB integration tests for BaseMailboxRoute's autoProvision()/listDomains() and create()'s
// domain-allowlist enforcement — matching this library's real-server-integration-test convention (see
// MailboxRoute.test.ts's own header comment). Kept in its own file rather than appended to that one:
// this needs `mail:auto_provision:enabled`/`mail:domains` turned ON, and vitest isolates each test
// file's module graph (confirmed via this project's `pool: "forks"` default `isolate: true`), so
// mutating the shared `config` singleton here can't leak into MailboxRoute.test.ts's own assertions,
// which rely on the unrestricted-domain default.
import config from "../../config.js";

config.set("mail:auto_provision:enabled", true);
config.set("mail:domains", ["example.com", "example.org"]);
config.set("mail:auth_server_url", "http://auth.test");
// Short enough to make the timeout test below fast (real time, no fake timers), long enough that
// every other test's synchronously-resolving mocked `fetch` never comes close to tripping it.
config.set("mail:auto_provision:timeout_ms", 50);

import { request } from "@rapidrest/service-core/test";
import { MongoConnection, MongoRepository, Server, ObjectFactory, ConnectionManager } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { MailboxMongo } from "../../../src/models/mongo/MailboxMongo.js";
import { MongoMemoryServer } from "mongodb-memory-server";
import { registerTestDoubles } from "../../testDoubles.js";

const mongod: MongoMemoryServer = new MongoMemoryServer({
    instance: {
        port: 9999,
        dbName: "rrst-test",
    },
});

describe("Route:MailboxMongo auto-provision/domain Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-mongo", logger, objectFactory });
    const baseUrl = "/mongo/mailboxes";
    let repo: MongoRepository<MailboxMongo>;

    const user: any = { uid: uuid.v4(), roles: [], elevated: Date.now() };
    const userToken = JWTUtils.createTokenSync(config.get("auth"), user);
    const admin: any = { uid: uuid.v4(), roles: ["admin"], elevated: Date.now() };
    const adminToken = JWTUtils.createTokenSync(config.get("auth"), admin);

    let mockFetch: ReturnType<typeof vi.fn>;

    // The framework's own auth reads the `Authorization` header (see MailboxRoute.test.ts's identical
    // `.set("Authorization", ...)` usage); `fetchNameAliases()` additionally forwards the raw `jwt`
    // cookie a real browser session would send, so tests exercising it need both set to the same
    // token. `supertest`'s `.set()` only accepts (field, value) pairs here, not an object literal (that
    // form silently sends no headers at all against this version) — chain two calls instead.
    function withAuth<T extends { set: (field: string, val: string) => T }>(req: T, token: string): T {
        return req.set("Authorization", "jwt " + token).set("Cookie", `jwt=${token}`);
    }

    function aliasResponse(values: string[], ok = true, status = 200) {
        return { ok, status, json: vi.fn().mockResolvedValue(values.map((value) => ({ value }))) };
    }

    beforeAll(async () => {
        await mongod.start();
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("mongo");
        if (conn instanceof MongoConnection) {
            repo = conn.getMongoRepository("MailboxMongo");
        } else {
            throw new Error("Could not find mongo connection");
        }
    });

    afterAll(async () => {
        await server.stop();
        await mongod.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        try {
            await repo.clear();
        } catch (err: any) {
            if (err.message !== "ns not found") {
                throw err;
            }
        }
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("Returns the caller's existing mailbox (status 'existing') without contacting auth-server, when they already have one.", async () => {
        const obj = new MailboxMongo({
            ownerUserUid: user.uid,
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "Already Provisioned",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });
        await repo.save(obj);

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(200);
        expect(result.body.status).toBe("existing");
        expect(result.body.mailbox.uid).toBe(obj.uid);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("Returns 404 when auth-server reports no registered name aliases for the caller.", async () => {
        mockFetch.mockResolvedValue(aliasResponse([]));

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(404);
    });

    it("Returns 502 when the caller has no jwt cookie to forward to auth-server (Authorization header alone isn't enough here).", async () => {
        const result = await request(server.getApplication())
            .post(`${baseUrl}/auto-provision`)
            .set("Authorization", "jwt " + userToken);

        expect(result.status).toBe(502);
        expect(mockFetch).not.toHaveBeenCalled();
    });

    it("Treats a non-array auth-server response the same as zero aliases (404), rather than throwing.", async () => {
        mockFetch.mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ not: "an array" }) });

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(404);
    });

    it("Falls back to an alias entry's 'name' field when 'value' isn't present.", async () => {
        mockFetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue([{ name: "jsteinmetz" }]),
        });

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(200);
        expect(result.body.options).toEqual(
            expect.arrayContaining([{ alias: "jsteinmetz", domain: "example.com", primarySmtpAddress: "jsteinmetz@example.com" }]),
        );
    });

    it("With no alias/domain chosen, returns needs_selection with the full alias x domain cross product.", async () => {
        mockFetch.mockResolvedValue(aliasResponse(["jsteinmetz", "jp"]));

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(200);
        expect(result.body.status).toBe("needs_selection");
        expect(result.body.options).toEqual(
            expect.arrayContaining([
                { alias: "jsteinmetz", domain: "example.com", primarySmtpAddress: "jsteinmetz@example.com" },
                { alias: "jsteinmetz", domain: "example.org", primarySmtpAddress: "jsteinmetz@example.org" },
                { alias: "jp", domain: "example.com", primarySmtpAddress: "jp@example.com" },
                { alias: "jp", domain: "example.org", primarySmtpAddress: "jp@example.org" },
            ]),
        );
        expect(result.body.options).toHaveLength(4);
    });

    it("Rejects a chosen alias that isn't one of the caller's real auth-server aliases.", async () => {
        mockFetch.mockResolvedValue(aliasResponse(["jsteinmetz"]));

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken).send({
            alias: "not-mine",
            domain: "example.com",
        });

        expect(result.status).toBe(400);
    });

    it("Rejects a chosen domain that isn't in the configured domain list.", async () => {
        mockFetch.mockResolvedValue(aliasResponse(["jsteinmetz"]));

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken).send({
            alias: "jsteinmetz",
            domain: "not-configured.com",
        });

        expect(result.status).toBe(400);
    });

    it("Creates the mailbox (with its well-known folders) for a valid chosen alias/domain, and returns status 'created'.", async () => {
        mockFetch.mockResolvedValue(aliasResponse(["jsteinmetz"]));

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken).send({
            alias: "jsteinmetz",
            domain: "example.org",
        });

        expect(result.status).toBe(200);
        expect(result.body.status).toBe("created");
        expect(result.body.mailbox.primarySmtpAddress).toBe("jsteinmetz@example.org");
        expect(result.body.mailbox.ownerUserUid).toBe(user.uid);

        const folders = await withAuth(
            request(server.getApplication()).get(`/mongo/folders?mailboxUid=${result.body.mailbox.uid}`),
            userToken,
        );
        expect(folders.body.map((f: any) => f.type).sort()).toEqual(["calendar", "contacts", "drafts", "inbox", "tasks"]);
    });

    it("Returns 502 when auth-server responds with a non-OK status.", async () => {
        mockFetch.mockResolvedValue(aliasResponse([], false, 500));

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(502);
    });

    it("Returns 502 when the call to auth-server itself fails (network error).", async () => {
        mockFetch.mockRejectedValue(new Error("network down"));

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(502);
    });

    it("Returns 502 when auth-server doesn't respond within mail:auto_provision:timeout_ms (aborts the request).", async () => {
        // A real fetch rejects when its AbortSignal fires — mimic that instead of just never resolving,
        // so this exercises the same rejection path as a genuine network abort would.
        mockFetch.mockImplementation(
            (_url: string, init: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    init.signal.addEventListener("abort", () => reject(new Error("The operation was aborted")));
                }),
        );

        const result = await withAuth(request(server.getApplication()).post(`${baseUrl}/auto-provision`), userToken);

        expect(result.status).toBe(502);
    });

    it("listDomains() returns this server's configured domain list.", async () => {
        const result = await withAuth(request(server.getApplication()).get(`${baseUrl}/domains`), userToken);

        expect(result.status).toBe(200);
        expect(result.body).toEqual(["example.com", "example.org"]);
    });

    it("create() rejects a manually-specified mailbox address whose domain isn't in the configured list, for a non-trusted caller.", async () => {
        const result = await withAuth(request(server.getApplication()).post(baseUrl), userToken).send({
            primarySmtpAddress: `${uuid.v4()}@not-configured.com`,
            aliasAddresses: [],
            displayName: "Off-domain",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        expect(result.status).toBe(400);
    });

    it("create() rejects an off-domain address even for a trusted (admin) caller — the domain list applies to everyone.", async () => {
        const result = await withAuth(request(server.getApplication()).post(baseUrl), adminToken).send({
            primarySmtpAddress: `${uuid.v4()}@not-configured.com`,
            aliasAddresses: [],
            displayName: "Admin Off-domain",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        expect(result.status).toBe(400);
    });

    it("create() allows a manually-specified address on one of the configured domains.", async () => {
        const result = await withAuth(request(server.getApplication()).post(baseUrl), userToken).send({
            primarySmtpAddress: `${uuid.v4()}@example.com`,
            aliasAddresses: [],
            displayName: "On-domain",
            timezone: "UTC",
            quotaBytes: 1_000_000_000,
            usedBytes: 0,
        });

        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
    });
});
