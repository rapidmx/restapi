///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
// SQL counterpart of test/routes/mongo/MailboxAutoProvision.test.ts — see that file's header comment
// for why this lives in its own file (needs `mail:auto_provision:enabled` turned on and verified
// `Domain` rows seeded, isolated from MailboxRoute.test.ts's own unrestricted-domain assumptions via
// per-file module isolation).
import config from "../../config.sql.js";

config.set("mail:auto_provision:enabled", true);
config.set("mail:auth_server_url", "http://auth.test");

import { request } from "@rapidrest/service-core/test";
import { Server, ObjectFactory, ConnectionManager, isSqlDataSource } from "@rapidrest/service-core";
import { JWTUtils, Logger } from "@rapidrest/core";
import * as uuid from "uuid";
import { Repository } from "typeorm";
import { DomainSQL } from "../../../src/models/sql/DomainSQL.js";
import { MailboxSQL } from "../../../src/models/sql/MailboxSQL.js";
import { registerTestDoubles } from "../../testDoubles.js";

describe("Route:MailboxSQL auto-provision/domain Tests", () => {
    const logger = Logger();
    const objectFactory: ObjectFactory = new ObjectFactory(config, logger);
    const server: Server = new Server({ config, basePath: "./test/server-sql", logger, objectFactory });
    const baseUrl = "/sql/mailboxes";
    let repo: Repository<MailboxSQL>;
    let domainRepo: Repository<DomainSQL>;

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
        registerTestDoubles(objectFactory);
        await server.start();

        const connMgr: ConnectionManager | undefined = objectFactory.getInstance(ConnectionManager);
        const conn: any = connMgr?.connections.get("sql");
        if (isSqlDataSource(conn)) {
            repo = conn.getRepository(MailboxSQL);
            domainRepo = conn.getRepository(DomainSQL);
        } else {
            throw new Error("Could not find sql connection");
        }

        // `save()` upserts on the primary key (`uid`), so re-running against the shared on-disk SQLite
        // file used by every SQL test just refreshes these rows rather than conflicting with a prior
        // run's (see restapi's own testing-conventions note).
        for (const name of ["example.com", "example.org"]) {
            await domainRepo.save(
                new DomainSQL({ name, enabled: true, verified: true, verificationToken: uuid.v4(), uid: name } as any),
            );
        }
    });

    afterAll(async () => {
        // These seeded `Domain` rows live in the shared on-disk SQLite file every SQL test file uses -
        // clean them up so they can't leak into an unrelated later test file's own unrestricted-domain
        // assumptions within the same `vitest run` process (see DistributionListDomains.test.ts's
        // identical rationale).
        await domainRepo.delete({ uid: "example.com" });
        await domainRepo.delete({ uid: "example.org" });
        await server.stop();
        await objectFactory.destroy();
    });

    beforeEach(async () => {
        await repo.clear();
        mockFetch = vi.fn();
        vi.stubGlobal("fetch", mockFetch);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("Returns the caller's existing mailbox (status 'existing') without contacting auth-server, when they already have one.", async () => {
        const obj = new MailboxSQL({
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
            request(server.getApplication()).get(`/sql/folders?mailboxUid=${result.body.mailbox.uid}`),
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
